import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Peer, { MediaConnection } from 'peerjs'
import { UseLocalMediaReturn, LocalMediaMode } from './useLocalMedia'
import type { CallMsg } from '../net/protocol'

export type CallMode = 'audio' | 'video'

// Per-peer roster entry. `mode` is the current publishing mode, updated
// live as peers turn their cameras on/off — not frozen at join time.
export interface RemotePeer {
  peerId: string
  name: string
  mode: CallMode
  stream: MediaStream | null
  micMuted: boolean
  cameraOff: boolean
  // True while the peer is publishing a screen share. The video track on
  // `stream` carries screen frames instead of camera frames — the UI
  // inspects this flag to swap in a ScreenTile with contain-fit + no mirror.
  screenSharing: boolean
}

// Structured failure surface so the UI can react without parsing strings.
export interface CallError {
  code:
    | 'not-connected'
    | 'permission-denied'
    | 'device-not-found'
    | 'device-in-use'
    | 'overconstrained'
    | 'rejected'
    | 'peer-unavailable'
    | 'peer-error'
    | 'media-conn-failed'
    | 'media-failed'
    | 'duplicate-tab'
    | 'unknown'
  message: string
  recoverable: boolean
  // Optional peer id when the error is scoped to a specific remote.
  peerId?: string
}

// Stable id for THIS browsing context — used by the duplicate-tab guard
// to distinguish between BroadcastChannel messages we sent ourselves vs.
// ones from a sibling tab. Generated once per module load (so within a
// hot-reload cycle it can change; that's fine).
const TAB_ID = Math.random().toString(36).slice(2) + Date.now().toString(36)

// Why a call ended — surfaced after `leave()` so the UI can post-mortem
// honestly instead of silently snapping back to the pre-join screen.
export type CallEndReason =
  | 'user-left'
  | 'host-ended'
  | 'connection-lost'
  | 'rejected'
  | 'error'

export interface UseCallOptions {
  peer: InstanceType<typeof Peer> | null
  myPeerId: string | null
  myName: string
  isHost: boolean
  hostPeerId: string | null
  participants: Array<{ peerId: string; name: string }>
  sendToHost?: (msg: Record<string, unknown>) => void
  sendToPeer?: (peerId: string, msg: Record<string, unknown>) => void
  broadcast?: (msg: Record<string, unknown>, exceptPeerId?: string) => void
  setMessageHandler: (h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null) => void
  localMedia: UseLocalMediaReturn
}

const SOFT_VIDEO_CAP = 4

// Single table of known media-error variants. Both the raw DOMException
// `name` from getUserMedia and the normalized `code` produced by
// useLocalMedia map to the same CallError shape through this table, so
// we stop maintaining two nearly-identical switches.
//
// The `recoverable` flag controls whether the UI shows a retry button:
// transient/permission errors are recoverable; hardware-missing isn't.
const MEDIA_ERROR_TABLE: Record<string, { code: CallError['code']; message?: string; recoverable: boolean }> = {
  // Raw DOMException names from getUserMedia
  NotAllowedError:       { code: 'permission-denied', message: 'Microphone access was blocked. Allow it in your browser settings and try again.', recoverable: true },
  SecurityError:         { code: 'permission-denied', message: 'Microphone access was blocked. Allow it in your browser settings and try again.', recoverable: true },
  NotFoundError:         { code: 'device-not-found',  message: 'No microphone was found on this device.', recoverable: false },
  DevicesNotFoundError:  { code: 'device-not-found',  message: 'No microphone was found on this device.', recoverable: false },
  NotReadableError:      { code: 'device-in-use',     message: 'Your microphone is in use by another app. Close it and try again.', recoverable: true },
  TrackStartError:       { code: 'device-in-use',     message: 'Your microphone is in use by another app. Close it and try again.', recoverable: true },
  TimeoutError:          { code: 'media-failed',      recoverable: true }, // use caller's message
  // Normalized codes emitted by useLocalMedia
  'permission-denied':   { code: 'permission-denied', recoverable: true },
  'device-not-found':    { code: 'device-not-found',  recoverable: false },
  'in-use':              { code: 'device-in-use',     recoverable: true },
  overconstrained:       { code: 'overconstrained',   recoverable: true },
  timeout:               { code: 'media-failed',      recoverable: true },
  unsupported:           { code: 'media-failed',      recoverable: false },
}

// Single classifier keyed by the normalized MEDIA_ERROR_TABLE. Handles
// both raw DOMExceptions from getUserMedia (prefer the table's phrasing
// because the raw .message is often developer-facing cruft like
// "NotAllowedError: Permission denied") and pre-classified errors from
// useLocalMedia (prefer the caller's message so device-specific detail
// — "Pick an available camera" etc. — reaches the UI verbatim).
function classifyMediaError(
  key: string,
  fallbackMessage: string,
  preferTableMessage = false,
): CallError {
  const entry = MEDIA_ERROR_TABLE[key]
  if (entry) {
    const message = preferTableMessage ? (entry.message ?? fallbackMessage) : fallbackMessage
    return { code: entry.code, message, recoverable: entry.recoverable }
  }
  return { code: 'media-failed', message: fallbackMessage, recoverable: true }
}

function streamHasLiveVideo(stream: MediaStream | null): boolean {
  if (!stream) return false
  const tracks = stream.getVideoTracks()
  return tracks.length > 0 && tracks.some(t => t.readyState !== 'ended')
}

// Minimum shape of a roster-snapshot entry sent by the host. We parse
// with runtime checks rather than trusting a blind cast — a malformed
// payload (wrong types, nested junk) could otherwise crash the signaling
// handler and take the whole call lane down.
interface RosterEntry {
  peerId: string
  name: string
  mode: CallMode
  screenSharing: boolean
}

function asPeerId(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function parseRosterSnapshot(input: unknown): RosterEntry[] {
  if (!Array.isArray(input)) return []
  const out: RosterEntry[] = []
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as { peerId?: unknown; name?: unknown; mode?: unknown; screenSharing?: unknown }
    if (typeof entry.peerId !== 'string' || entry.peerId.length === 0) continue
    const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : 'Anon'
    const mode: CallMode = entry.mode === 'video' ? 'video' : 'audio'
    const screenSharing = entry.screenSharing === true
    out.push({ peerId: entry.peerId, name, mode, screenSharing })
  }
  return out
}

// Per-peer retry state for an outbound MediaConnection that errored.
// We make one silent retry after RETRY_DELAY_MS; a second failure (or any
// failure while the peer is no longer in the roster) escalates to a user-
// visible error banner.
interface MediaConnRetry {
  attempts: number
  timer: ReturnType<typeof setTimeout> | null
}

const MEDIA_CONN_RETRY_DELAY_MS = 2_000
const MEDIA_CONN_MAX_ATTEMPTS = 2 // initial + 1 retry
// Grace window before pruning a peer from the host roster after their
// DataConnection drops. Absorbs brief flaps without evicting a peer
// that is about to reconnect.
const GHOST_PRUNE_GRACE_MS = 3_000
// Minimum gap between accepted call-track-state messages from the same
// peer. Higher-frequency updates are silently dropped to prevent a
// hostile (or buggy) peer from flooding the host with re-renders.
const TRACK_STATE_MIN_INTERVAL_MS = 100

export function useCall(options: UseCallOptions) {
  const {
    peer, myPeerId, myName, isHost, hostPeerId,
    participants,
    sendToHost, sendToPeer, broadcast, setMessageHandler,
    localMedia,
  } = options
  // Stable method handles so effect/callback dep lists don't depend on
  // `localMedia` identity (useLocalMedia returns a fresh object literal
  // each render, so whole-object deps would thrash downstream effects).
  const {
    stop: localMediaStop,
    start: localMediaStart,
    toggleMic: localMediaToggleMic,
    toggleCamera: localMediaToggleCamera,
  } = localMedia

  const [joined, setJoined] = useState<boolean>(false)
  const [joining, setJoining] = useState<boolean>(false)
  const [mode, setMode] = useState<LocalMediaMode>('none')
  const [callError, setCallError] = useState<CallError | null>(null)
  const [endReason, setEndReason] = useState<CallEndReason | null>(null)
  const [roster, setRoster] = useState<Map<string, RemotePeer>>(new Map())
  // True while the local user is actively publishing a screen share. We
  // swap the track via `sender.replaceTrack` rather than opening a second
  // MediaConnection — keeps the existing call topology and the remote
  // `stream` identity stable; only the video frames change.
  const [screenSharing, setScreenSharing] = useState<boolean>(false)
  const [screenShareStarting, setScreenShareStarting] = useState<boolean>(false)
  const [screenShareError, setScreenShareError] = useState<CallError | null>(null)

  const mediaConnsRef = useRef<Map<string, MediaConnection>>(new Map())
  const joinedRef = useRef<boolean>(false)
  const modeRef = useRef<LocalMediaMode>('none')
  const rosterRef = useRef<Map<string, RemotePeer>>(new Map())
  const myNameRef = useRef<string>(myName)
  const localStreamRef = useRef<MediaStream | null>(localMedia.stream)
  // Mirrors localMedia.micMuted so effects can read the current value
  // without subscribing to it in their deps (which would re-run them on
  // every mute toggle even when they only care about mode).
  const micMutedRef = useRef<boolean>(localMedia.micMuted)
  const hostPeerIdRef = useRef<string | null>(hostPeerId)
  // Per-join token. Any async work that captures this value can compare it
  // to the current ref to detect a stale join attempt.
  const joinAttemptRef = useRef<symbol>(Symbol('initial'))
  // BroadcastChannel used to detect "this user is already in the same call
  // in another tab", which would create an audio feedback loop. We only
  // claim a channel when joining as a non-host (the host's peerId is
  // stable per-tab, so two host tabs can't be in the same room anyway).
  const tabChannelRef = useRef<BroadcastChannel | null>(null)
  // Per-peer retry state for outbound MediaConnection errors. Keyed by
  // peerId so retries are independent. We clear the entry on success
  // and on roster removal; any pending timer is cancelled if the hook
  // unmounts or the user leaves the call.
  const mediaConnRetryRef = useRef<Map<string, MediaConnRetry>>(new Map())
  // Host-side: pending "peer is gone" prunes that are waiting out the
  // grace window. If the peer reappears in `participants` within the
  // window we cancel the timer; otherwise it fires and removes them.
  const pruneTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  // Per-peer last-accepted timestamp for call-track-state messages. Used
  // as a simple rate-limit to drop high-frequency spam before it triggers
  // setRoster re-renders.
  const lastTrackStateAtRef = useRef<Map<string, number>>(new Map())
  // Local screen-share state mirrors, readable from effects without
  // depending on React state identity.
  const screenStreamRef = useRef<MediaStream | null>(null)
  const screenSharingRef = useRef<boolean>(false)
  // Mixed (mic + screen-audio) track published while sharing when the user
  // granted tab/system audio. Null when no screen audio was captured — in
  // that case the raw mic track is published as usual.
  const mixedAudioTrackRef = useRef<MediaStreamTrack | null>(null)
  // AudioContext owning the mixer graph. Torn down on stop to release the
  // audio hardware.
  const screenAudioCtxRef = useRef<AudioContext | null>(null)

  // Returns the stream we should publish to a NEW peer connection right now.
  // When screen-sharing is active we hand out a fresh MediaStream carrying
  // (a) the mixed audio track if we captured tab audio, otherwise the raw
  // mic track, and (b) the screen video track. Late joiners and retry
  // callers get the current share instead of a stale camera feed. When not
  // sharing, returns the normal local stream.
  const getPublishStream = useCallback((): MediaStream | null => {
    const local = localStreamRef.current
    if (!screenSharingRef.current || !screenStreamRef.current) return local
    const screenVideo = screenStreamRef.current.getVideoTracks()[0]
    if (!screenVideo) return local
    const out = new MediaStream()
    const mixed = mixedAudioTrackRef.current
    if (mixed && mixed.readyState !== 'ended') {
      out.addTrack(mixed)
    } else {
      local?.getAudioTracks().forEach(t => out.addTrack(t))
    }
    out.addTrack(screenVideo)
    return out
  }, [])

  useEffect(() => { joinedRef.current = joined }, [joined])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { rosterRef.current = roster }, [roster])
  useEffect(() => { myNameRef.current = myName }, [myName])
  useEffect(() => { localStreamRef.current = localMedia.stream }, [localMedia.stream])
  useEffect(() => { micMutedRef.current = localMedia.micMuted }, [localMedia.micMuted])
  useEffect(() => { hostPeerIdRef.current = hostPeerId }, [hostPeerId])

  const upsertRoster = useCallback((peerId: string, patch: Partial<RemotePeer>): void => {
    setRoster(prev => {
      const next = new Map(prev)
      const existing = next.get(peerId)
      const base: RemotePeer = existing ?? {
        peerId,
        name: patch.name || 'Anon',
        mode: patch.mode || 'audio',
        stream: null,
        micMuted: false,
        cameraOff: true,
        screenSharing: false,
      }
      next.set(peerId, { ...base, ...patch })
      return next
    })
  }, [])

  const removeFromRoster = useCallback((peerId: string): void => {
    setRoster(prev => {
      if (!prev.has(peerId)) return prev
      const next = new Map(prev)
      next.delete(peerId)
      return next
    })
    lastTrackStateAtRef.current.delete(peerId)
  }, [])

  const clearRetryState = useCallback((peerId: string): void => {
    const existing = mediaConnRetryRef.current.get(peerId)
    if (existing?.timer) { clearTimeout(existing.timer) }
    mediaConnRetryRef.current.delete(peerId)
  }, [])

  const closeMediaConn = useCallback((peerId: string): void => {
    const mc = mediaConnsRef.current.get(peerId)
    if (mc) {
      try { mc.close() } catch {}
      mediaConnsRef.current.delete(peerId)
    }
    clearRetryState(peerId)
  }, [clearRetryState])

  const remotePeers = useMemo(() => Array.from(roster.values()), [roster])

  const videoTileCount = useMemo(() => {
    let count = 0
    roster.forEach(p => { if (p.mode === 'video') count++ })
    if (mode === 'video') count++
    return count
  }, [roster, mode])

  const overSoftVideoCap = videoTileCount > SOFT_VIDEO_CAP

  // Ref to the latest `callPeerWithStream` so the retry timer scheduled
  // inside `mc.on('error')` can re-invoke it without capturing a stale
  // closure identity. The function depends on `peer`/`myPeerId` which are
  // effectively stable per session, but going through a ref makes the
  // recursion safe under any re-creation.
  type CallPeerFn = (peerId: string, stream: MediaStream, myMode: CallMode) => void
  const callPeerWithStreamRef = useRef<CallPeerFn | null>(null)
  // Ref to the tuneScreenSenders helper defined later in the file, so we
  // can invoke it from mc stream handlers without forward-declaration
  // gymnastics.
  const tuneScreenSendersRef = useRef<((pc: RTCPeerConnection) => void) | null>(null)

  const callPeerWithStream = useCallback<CallPeerFn>((peerId, stream, myMode) => {
    if (!peer || peerId === myPeerId) return
    if (mediaConnsRef.current.has(peerId)) return
    try {
      const mc = peer.call(peerId, stream, { metadata: { kind: 'manifest-call', mode: myMode, name: myNameRef.current } })
      mediaConnsRef.current.set(peerId, mc)
      mc.on('stream', (remoteStream: MediaStream) => {
        clearRetryState(peerId)
        upsertRoster(peerId, {
          stream: remoteStream,
          mode: streamHasLiveVideo(remoteStream) ? 'video' : 'audio',
        })
        // If we're screen-sharing, apply encoder tuning to the freshly-
        // established video sender so late joiners benefit too.
        if (screenSharingRef.current) {
          const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
          if (pc) tuneScreenSendersRef.current?.(pc)
        }
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })
      })
      mc.on('error', (err: unknown) => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })

        // One-shot retry: transient media errors (ICE glitch, TURN reroute)
        // often recover within a few seconds. A second failure escalates.
        const prev = mediaConnRetryRef.current.get(peerId)
        const attempts = (prev?.attempts ?? 0) + 1
        if (prev?.timer) { clearTimeout(prev.timer); prev.timer = null }

        if (attempts < MEDIA_CONN_MAX_ATTEMPTS) {
          console.warn('media connection error (will retry)', peerId, err)
          const timer = setTimeout(() => {
            const slot = mediaConnRetryRef.current.get(peerId)
            if (slot) slot.timer = null
            // Re-verify the retry is still valid when the timer fires.
            if (!joinedRef.current) return
            if (!rosterRef.current.has(peerId)) return
            if (mediaConnsRef.current.has(peerId)) return
            // Screen-aware retry: if we're sharing, the retry must carry
            // the screen video track too, not a stale camera-only stream.
            const currentStream = getPublishStream() ?? localStreamRef.current
            if (!currentStream) return
            const baseMode = modeRef.current
            if (baseMode === 'none') return
            // When screen-sharing, publish as 'video' regardless of local
            // camera mode — the stream carries a screen video track.
            const currentMode: CallMode = screenSharingRef.current ? 'video' : (baseMode as CallMode)
            const fn = callPeerWithStreamRef.current
            fn?.(peerId, currentStream, currentMode)
          }, MEDIA_CONN_RETRY_DELAY_MS)
          mediaConnRetryRef.current.set(peerId, { attempts, timer })
          return
        }

        // Exhausted: escalate to banner and reset retry state so a future
        // manual action can try again from zero.
        clearRetryState(peerId)
        const peerName = rosterRef.current.get(peerId)?.name || 'A peer'
        console.warn('media connection error (giving up)', peerId, err)
        setCallError(existing => existing ?? {
          code: 'media-conn-failed',
          message: `Lost media connection to ${peerName}.`,
          recoverable: true,
          peerId,
        })
      })
    } catch (e) {
      console.warn('peer.call failed for', peerId, e)
      const peerName = rosterRef.current.get(peerId)?.name || 'a peer'
      setCallError({
        code: 'media-conn-failed',
        message: `Could not call ${peerName}: ${(e as Error).message || 'media setup failed'}.`,
        recoverable: true,
        peerId,
      })
    }
  }, [peer, myPeerId, upsertRoster, clearRetryState])

  useEffect(() => { callPeerWithStreamRef.current = callPeerWithStream }, [callPeerWithStream])

  // ── Incoming: answer media calls ───────────────────────────────────────
  // peerjs does not implement EventEmitter.off() reliably across versions, so
  // we keep a handler ref and use removeAllListeners('call') in cleanup.
  // Trust gate: only accept incoming calls from peers we already know about
  // (host always trusted by non-host; both sides require an existing roster
  // entry otherwise). Without this gate any peer with your peer id can ring
  // you and force-attach an RTCPeerConnection.
  useEffect(() => {
    if (!peer) return
    const handler = (mc: MediaConnection): void => {
      const meta = (mc.metadata || {}) as { kind?: string; mode?: CallMode; name?: string }
      if (meta.kind !== 'manifest-call') {
        try { mc.close() } catch {}
        return
      }
      if (!joinedRef.current || !localStreamRef.current) {
        try { mc.close() } catch {}
        return
      }
      // Trust gate: must be the host or an already-known roster peer.
      const isFromHost = !!hostPeerIdRef.current && mc.peer === hostPeerIdRef.current
      const isKnown = rosterRef.current.has(mc.peer)
      if (!isFromHost && !isKnown) {
        console.warn('Rejecting unsolicited call from unknown peer', mc.peer)
        try { mc.close() } catch {}
        return
      }
      // Close any existing connection to this peer before accepting a new
      // one — handles simultaneous dial / camera-toggle reconnect races
      // without leaking RTCPeerConnections.
      const existing = mediaConnsRef.current.get(mc.peer)
      if (existing && existing !== mc) {
        try { existing.close() } catch {}
        mediaConnsRef.current.delete(mc.peer)
      }
      // If screen-sharing, answer with a stream carrying screen video +
      // local audio so the caller sees our share immediately.
      const answerStream = getPublishStream() ?? localStreamRef.current
      try { mc.answer(answerStream) } catch { return }
      mediaConnsRef.current.set(mc.peer, mc)

      // Existing roster name (from the host's snapshot or call-peer-joined
      // broadcast) ALWAYS wins over the metadata name a peer claims for
      // themselves — otherwise a peer can impersonate any display name on
      // the metadata channel. Only fall back to metadata when we have no
      // prior name at all (defensive; should be rare since call-roster
      // pre-populates everything).
      const incomingMode: CallMode = meta.mode || 'audio'
      const existingName = rosterRef.current.get(mc.peer)?.name
      upsertRoster(mc.peer, {
        name: existingName || meta.name || 'Anon',
        mode: incomingMode,
      })

      mc.on('stream', (remoteStream: MediaStream) => {
        upsertRoster(mc.peer, {
          stream: remoteStream,
          mode: streamHasLiveVideo(remoteStream) ? 'video' : 'audio',
        })
        if (screenSharingRef.current) {
          const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
          if (pc) tuneScreenSendersRef.current?.(pc)
        }
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(mc.peer)
        upsertRoster(mc.peer, { stream: null })
      })
      mc.on('error', (err: unknown) => {
        console.warn('incoming mc error for', mc.peer, err)
        mediaConnsRef.current.delete(mc.peer)
        // Match the outbound handler — clear the stream so the tile shows
        // the peer as not-streaming instead of a stale "connected" state.
        upsertRoster(mc.peer, { stream: null })
      })
    }
    peer.on('call', handler)

    // Subscribe to peer-level errors so we can react when peerjs gives us
    // signal we'd otherwise miss: peer-unavailable when calling a peer that
    // disappeared, network errors, server disconnects, etc. These map to
    // user-actionable banners instead of console.warn.
    //
    // We must NOT call removeAllListeners('error') on cleanup — useReceiver
    // / useSender install their own peer error handlers on the same Peer
    // instance and we'd kill them. Use a stored ref + removeListener.
    const errHandler = (err: unknown): void => {
      const e = err as { type?: string; message?: string }
      const type = e?.type || ''
      const msg = e?.message || ''
      // Most peer errors are transient and not specific to the call lane.
      // Only set callError for ones that meaningfully affect the call.
      if (type === 'peer-unavailable') {
        // Extract peer id from the message if possible (peerjs format:
        // "Could not connect to peer <id>"). Best-effort only.
        const match = /peer\s+([\w-]+)/i.exec(msg)
        const pid = match?.[1]
        const name = pid ? (rosterRef.current.get(pid)?.name || 'a peer') : 'a peer'
        setCallError({
          code: 'peer-unavailable',
          message: `Could not reach ${name}. They may have left.`,
          recoverable: true,
          peerId: pid,
        })
        if (pid) {
          // Clean up any stale roster entry — the peer is gone for sure.
          closeMediaConn(pid)
          removeFromRoster(pid)
        }
        return
      }
      if (type === 'disconnected' || type === 'network') {
        // The transport itself is wobbly; the connection-status prop will
        // already trigger the reconnect banner via CallPanel. Don't double
        // up by setting callError here.
        return
      }
      if (type === 'browser-incompatible' || type === 'webrtc') {
        setCallError({
          code: 'peer-error',
          message: 'Your browser had a WebRTC error during the call.',
          recoverable: false,
        })
        return
      }
      // Catch-all for unexpected peer errors so they don't go silent.
      if (type) {
        console.warn('peer error', type, msg)
        setCallError(prev => prev ?? {
          code: 'peer-error',
          message: msg || `Peer connection error (${type}).`,
          recoverable: true,
        })
      }
    }
    peer.on('error', errHandler)

    return () => {
      // 'call' is owned by us — no other consumer subscribes to it.
      try { peer.removeAllListeners('call') } catch {}
      // 'error' is shared with useReceiver/useSender — only remove our own
      // handler. eventemitter3 exposes both `off` (modern alias) and
      // `removeListener`; prefer `off` and fall back to `removeListener`
      // so we don't break if the underlying emitter ever drops one alias.
      type OffFn = (event: string, handler: (...args: unknown[]) => void) => void
      const emitter = peer as unknown as { off?: OffFn; removeListener?: OffFn }
      const off = emitter.off ?? emitter.removeListener
      if (off) { try { off.call(peer, 'error', errHandler) } catch {} }
    }
  }, [peer, upsertRoster, closeMediaConn, removeFromRoster])

  // ── Track hot-swap on device changes ───────────────────────────────────
  // When useLocalMedia restarts the stream because of a device swap (NOT a
  // mode change — the mode-change effect below handles that by full reconnect),
  // replace the outgoing tracks on every active media connection so receivers
  // immediately hear/see the new source.
  useEffect(() => {
    const stream = localMedia.stream
    if (!stream || !joinedRef.current) return
    const audioTrack = stream.getAudioTracks()[0] || null
    // While actively screen-sharing, a mode-change reconnect may have
    // republished the camera track — but `screenStreamRef` still holds the
    // share we care about, so prefer the screen track for the video sender.
    const screenVideoTrack = screenSharingRef.current
      ? (screenStreamRef.current?.getVideoTracks()[0] ?? null)
      : null
    const videoTrack = screenVideoTrack ?? (stream.getVideoTracks()[0] || null)
    mediaConnsRef.current.forEach(mc => {
      const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (!pc) return
      pc.getSenders().forEach(sender => {
        if (sender.track?.kind === 'audio' && audioTrack) {
          sender.replaceTrack(audioTrack).catch(() => {})
        } else if (sender.track?.kind === 'video' && videoTrack) {
          sender.replaceTrack(videoTrack).catch(() => {})
        }
      })
    })
  }, [localMedia.stream])

  // ── Local mode change → reconnect media ────────────────────────────────
  // When the user toggles their camera on or off, the local stream gains or
  // loses a video track. RTCPeerConnection sender lists are negotiated
  // up-front and peerjs has no public renegotiation API, so the honest fix
  // is to close the existing media connections and re-call everyone with
  // the new stream. The brief audio drop is the cost — alternative
  // approaches that fudge the black-frame state cause more confusion than
  // they save.
  //
  // The deps list is narrowed to `localMedia.mode` only; stream identity
  // and mic-mute state are read through refs. Stream-identity-only changes
  // (device swap) are handled by the track hot-swap effect below, and
  // mic-only changes are noise for this effect.
  useEffect(() => {
    if (!joinedRef.current) return
    const newMode: LocalMediaMode = localMedia.mode
    if (newMode === 'none') return
    if (modeRef.current === newMode) return

    modeRef.current = newMode
    setMode(newMode)

    const stream = localStreamRef.current
    if (!stream) return

    // Snapshot existing peer ids before tearing down (which mutates the map).
    const peerIds: string[] = Array.from(mediaConnsRef.current.keys())
    peerIds.forEach(pid => {
      const mc = mediaConnsRef.current.get(pid)
      if (mc) { try { mc.close() } catch {} }
      mediaConnsRef.current.delete(pid)
      // A reconnect invalidates any retry state for this peer — start fresh.
      clearRetryState(pid)
    })
    // Re-call every roster member with the new stream.
    rosterRef.current.forEach((_, pid) => {
      callPeerWithStream(pid, stream, newMode as CallMode)
    })
    // Tell everyone our new track-state so their tile renders the right kind.
    const payload = {
      type: 'call-track-state',
      micMuted: micMutedRef.current,
      cameraOff: newMode !== 'video',
      mode: newMode,
      from: myPeerId!,
    } satisfies CallMsg
    if (isHost) broadcast?.(payload)
    else sendToHost?.(payload)
  }, [localMedia.mode, isHost, broadcast, sendToHost, myPeerId, callPeerWithStream, clearRetryState])

  // ── Signaling message handler ──────────────────────────────────────────

  useEffect(() => {
    const handler = (fromPeerId: string, msg: Record<string, unknown>): void => {
      // The setMessageHandler bus signature stays `Record<string, unknown>`
      // because it's shared with the other hooks. Inside useCall we know
      // every message is CallMsg shape — alias and narrow via `type` so
      // typos in the dispatch strings fail at compile time.
      const call = msg as CallMsg
      const type = call.type

      // S4 — If the sender stamped a `from` field, it must match the
      // transport-layer peer id. A mismatch indicates a relay bug or a
      // spoof attempt; drop it either way. Messages without `from` are
      // passed through (not all senders populate it).
      const claimedFrom = msg.from
      if (typeof claimedFrom === 'string' && claimedFrom !== fromPeerId) {
        console.warn('Dropping call message with mismatched from field', { transport: fromPeerId, claimed: claimedFrom, type })
        return
      }

      // S5 — Rate-limit call-track-state per ORIGINATING peer. Humans
      // toggle mute at human speed; anything faster is noise or abuse.
      // Key on `msg.peerId` when the host is relaying on behalf of
      // another guest — otherwise N peers toggling within the window
      // collapse into one bucket on the host id and N-1 legit updates
      // get silently dropped.
      if (type === 'call-track-state') {
        const isFromHostRelay = fromPeerId === hostPeerIdRef.current
        const embeddedId = asPeerId((msg as { peerId?: unknown }).peerId)
        const originatorId = isFromHostRelay && embeddedId ? embeddedId : fromPeerId
        const now = performance.now()
        const last = lastTrackStateAtRef.current.get(originatorId) ?? 0
        if (now - last < TRACK_STATE_MIN_INTERVAL_MS) {
          return
        }
        lastTrackStateAtRef.current.set(originatorId, now)
      }

      // ── Host-side ─────────────────────────────────────────────────────

      if (type === 'call-join' && isHost) {
        const incomingMode = (msg.mode as CallMode) || 'audio'
        const incomingName = (msg.name as string) || 'Anon'
        upsertRoster(fromPeerId, { name: incomingName, mode: incomingMode, micMuted: false, cameraOff: incomingMode !== 'video', screenSharing: false })
        // Send the joiner a roster snapshot (excluding themselves) so they
        // learn existing call state, including who is screen-sharing right
        // now — otherwise a late joiner would render the sharer's tile as
        // plain audio until the next track-state broadcast.
        const snapshot: Array<{ peerId: string; name: string; mode: CallMode; screenSharing: boolean }> = []
        rosterRef.current.forEach((p, pid) => {
          if (pid !== fromPeerId) snapshot.push({ peerId: pid, name: p.name, mode: p.mode, screenSharing: p.screenSharing })
        })
        if (joinedRef.current && myPeerId && modeRef.current !== 'none') {
          // Host's own publish mode is forced to 'video' while sharing so
          // the joiner's UI expects a video sender and mounts VideoTile.
          const selfMode: CallMode = screenSharingRef.current ? 'video' : (modeRef.current as CallMode)
          snapshot.push({ peerId: myPeerId, name: myNameRef.current, mode: selfMode, screenSharing: screenSharingRef.current })
        }
        sendToPeer?.(fromPeerId, { type: 'call-roster', peers: snapshot, from: myPeerId! } satisfies CallMsg)
        broadcast?.({ type: 'call-peer-joined', peerId: fromPeerId, name: incomingName, mode: incomingMode, screenSharing: false, from: myPeerId! } satisfies CallMsg, fromPeerId)
        return
      }

      if (type === 'call-leave' && isHost) {
        removeFromRoster(fromPeerId)
        closeMediaConn(fromPeerId)
        broadcast?.({ type: 'call-peer-left', peerId: fromPeerId, from: myPeerId! } satisfies CallMsg, fromPeerId)
        return
      }

      if (type === 'call-track-state' && isHost) {
        // A peer reports their own state. Pin peerId to fromPeerId so a
        // malicious client can't muck with someone else's roster entry.
        const micMuted = !!msg.micMuted
        const cameraOff = !!msg.cameraOff
        const reportedMode = (msg.mode as CallMode | undefined)
        const nextMode: CallMode = reportedMode || (cameraOff ? 'audio' : 'video')
        upsertRoster(fromPeerId, { micMuted, cameraOff, mode: nextMode })
        broadcast?.({ type: 'call-track-state', peerId: fromPeerId, micMuted, cameraOff, mode: nextMode, from: myPeerId! } satisfies CallMsg, fromPeerId)
        return
      }

      if (type === 'call-screen-state' && isHost) {
        // A peer reports their own screen-share on/off. Same pinning rule
        // as track-state: derive peerId from the authenticated transport id.
        const active = !!msg.active
        upsertRoster(fromPeerId, { screenSharing: active })
        broadcast?.({ type: 'call-screen-state', peerId: fromPeerId, active, from: myPeerId! } satisfies CallMsg, fromPeerId)
        return
      }

      // ── Non-host: only trust messages claimed to be from the host ─────

      if (type === 'call-roster') {
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-roster from non-host', fromPeerId)
          return
        }
        const peers = parseRosterSnapshot(msg.peers)
        // Seed roster with screenSharing flag so a tile rendered BEFORE the
        // MediaConnection resolves already knows to expect a screen share.
        peers.forEach(p => { upsertRoster(p.peerId, { name: p.name, mode: p.mode, cameraOff: p.mode !== 'video', screenSharing: p.screenSharing }) })
        const stream = getPublishStream() ?? localStreamRef.current
        if (stream && modeRef.current !== 'none') {
          const publishMode: CallMode = screenSharingRef.current ? 'video' : (modeRef.current as CallMode)
          peers.forEach(p => callPeerWithStream(p.peerId, stream, publishMode))
        }
        return
      }

      if (type === 'call-peer-joined') {
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-peer-joined from non-host', fromPeerId)
          return
        }
        const peerId = asPeerId(msg.peerId)
        if (!peerId) return
        const name = (typeof msg.name === 'string' && msg.name) || 'Anon'
        const joinedMode: CallMode = msg.mode === 'video' ? 'video' : 'audio'
        const joinedScreen = msg.screenSharing === true
        if (peerId !== myPeerId) {
          upsertRoster(peerId, { name, mode: joinedMode, cameraOff: joinedMode !== 'video', screenSharing: joinedScreen })
        }
        return
      }

      if (type === 'call-peer-left') {
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-peer-left from non-host', fromPeerId)
          return
        }
        const peerId = asPeerId(msg.peerId)
        if (!peerId) return
        closeMediaConn(peerId)
        removeFromRoster(peerId)
        return
      }

      if (type === 'call-track-state') {
        // Non-host receives a relayed update from the host. The host already
        // pinned peerId to the original sender, so we trust the embedded
        // peerId only when the relayer is the host. If we got it from
        // anyone else, fall back to fromPeerId (a peer reporting itself).
        const isFromHost = fromPeerId === hostPeerIdRef.current
        const embeddedId = asPeerId(msg.peerId)
        const peerId = isFromHost && embeddedId ? embeddedId : fromPeerId
        const reportedMode: CallMode | undefined = msg.mode === 'video' ? 'video' : msg.mode === 'audio' ? 'audio' : undefined
        const cameraOff = !!msg.cameraOff
        const nextMode: CallMode = reportedMode || (cameraOff ? 'audio' : 'video')
        upsertRoster(peerId, { micMuted: !!msg.micMuted, cameraOff, mode: nextMode })
        return
      }

      if (type === 'call-screen-state') {
        // Same trust rule as call-track-state: only accept embedded peerId
        // when the host is relaying; otherwise pin to the transport sender.
        const isFromHost = fromPeerId === hostPeerIdRef.current
        const embeddedId = asPeerId(msg.peerId)
        const peerId = isFromHost && embeddedId ? embeddedId : fromPeerId
        upsertRoster(peerId, { screenSharing: !!msg.active })
        return
      }

      if (type === 'call-rejected') {
        // Only the host is allowed to reject us. Otherwise any peer could
        // forge a rejection and trick us into stopping our local media.
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-rejected from non-host', fromPeerId)
          return
        }
        setCallError({ code: 'rejected', message: 'Call join rejected.', recoverable: true })
        setEndReason('rejected')
        setJoining(false)
        if (modeRef.current !== 'none') {
          try { localMediaStop() } catch {}
          setMode('none')
        }
        return
      }
    }
    setMessageHandler(handler)
    return () => { setMessageHandler(null) }
  }, [isHost, myPeerId, sendToPeer, broadcast, setMessageHandler, upsertRoster, removeFromRoster, closeMediaConn, callPeerWithStream, localMediaStop])

  // ── Actions ────────────────────────────────────────────────────────────

  // Single join entrypoint. Always starts in audio-only mode with mic
  // enabled and camera off — matching how people actually walk into a call.
  // Camera comes on later via the toggle.
  const join = useCallback(async (): Promise<void> => {
    if (joinedRef.current || joining) return
    if (!peer || !myPeerId) {
      setCallError({ code: 'not-connected', message: 'Not connected yet — try again in a moment.', recoverable: true })
      return
    }
    const attempt = Symbol('join-attempt')
    joinAttemptRef.current = attempt

    setJoining(true)
    setCallError(null)
    setEndReason(null)

    // Duplicate-tab guard: ask any sibling tabs whether they're already in
    // this room. If anyone responds within 300 ms, refuse the join. The
    // "room" is the host's peerId for non-hosts, which is shared across
    // tabs of the same browser. Hosts have a unique peerId per tab, so
    // they can't accidentally double-join the same room.
    // 150 ms was too tight — a sibling tab on a busy main thread or
    // under load could reply at 160-200 ms and slip through, letting
    // the user join twice. 300 ms still reads as instantaneous to the
    // user and covers realistic BroadcastChannel latencies.
    if (!isHost && hostPeerId && typeof BroadcastChannel !== 'undefined') {
      let conflict = false
      let probe: BroadcastChannel | null = null
      try {
        probe = new BroadcastChannel('manifest-call-' + hostPeerId)
        const probeHandler = (e: MessageEvent): void => {
          const data = e.data as { type?: string; tabId?: string }
          if (data?.type === 'i-am-here' && data.tabId !== TAB_ID) {
            conflict = true
          }
        }
        probe.addEventListener('message', probeHandler)
        probe.postMessage({ type: 'who', tabId: TAB_ID })
        await new Promise<void>(resolve => setTimeout(resolve, 300))
        probe.removeEventListener('message', probeHandler)
      } catch {
        // BroadcastChannel unavailable / blocked — skip the guard.
      }
      if (conflict) {
        try { probe?.close() } catch {}
        setCallError({
          code: 'duplicate-tab',
          message: "You're already in this call in another tab. Close the other tab to join here.",
          recoverable: false,
        })
        setJoining(false)
        return
      }
      // No conflict — keep the channel open and listen for future probes
      // so a sibling tab that opens later sees us.
      if (probe) {
        probe.addEventListener('message', (e: MessageEvent) => {
          const data = e.data as { type?: string; tabId?: string }
          if (data?.type === 'who' && data.tabId !== TAB_ID) {
            try { probe?.postMessage({ type: 'i-am-here', tabId: TAB_ID }) } catch {}
          }
        })
        tabChannelRef.current = probe
      }
    }

    try {
      const stream = await localMediaStart('audio')
      // If a newer attempt or a leave/unmount has happened during the
      // permission prompt, abort cleanly.
      if (joinAttemptRef.current !== attempt) {
        try { stream.getTracks().forEach(t => t.stop()) } catch {}
        return
      }
      setMode('audio')
      modeRef.current = 'audio'
      localStreamRef.current = stream

      if (isHost) {
        const existingPeerIds: string[] = Array.from(rosterRef.current.keys())
        existingPeerIds.forEach(pid => callPeerWithStream(pid, stream, 'audio'))
        broadcast?.({ type: 'call-peer-joined', peerId: myPeerId!, name: myNameRef.current, mode: 'audio', screenSharing: false, from: myPeerId! } satisfies CallMsg)
      } else {
        sendToHost?.({ type: 'call-join', mode: 'audio', name: myNameRef.current, from: myPeerId! } satisfies CallMsg)
      }

      setJoined(true)
      joinedRef.current = true
    } catch (e) {
      // Release the duplicate-tab claim that we optimistically took before
      // the media prompt. Without this, a failed join leaves the tab
      // channel dangling and every retry sees itself as a sibling conflict.
      if (tabChannelRef.current) {
        try { tabChannelRef.current.close() } catch {}
        tabChannelRef.current = null
      }
      // AbortError comes from useLocalMedia when the attempt was
      // superseded (e.g., the user hit Leave during the permission prompt,
      // or the component unmounted). Don't surface it as an error banner.
      if ((e as Error).name === 'AbortError') return
      const err = classifyMediaError(
        (e as { name?: string })?.name || '',
        (e as { message?: string })?.message || 'Failed to start media',
        true,
      )
      setCallError(err)
      setEndReason(null) // join failure isn't a "call ended"
    } finally {
      if (joinAttemptRef.current === attempt) setJoining(false)
    }
  }, [peer, myPeerId, joining, localMediaStart, isHost, hostPeerId, broadcast, sendToHost, callPeerWithStream])

  // ── Screen share ───────────────────────────────────────────────────────
  // Screen share does NOT depend on the local camera being on. Two paths:
  //   1. Local mode === 'video' → a video sender already exists on every
  //      RTCPeerConnection, so we just `sender.replaceTrack(screenTrack)`.
  //      No renegotiation; the remote sees frames swap instantly.
  //   2. Local mode === 'audio' → no video sender exists. We close every
  //      MediaConnection and re-call each peer with a combined stream
  //      (existing audio track + screen video track). peerjs renegotiates
  //      on the new call, matching how mode toggles already work.
  //
  // A separate `call-screen-state` signaling message flips a roster flag so
  // the UI can render the remote tile as a screen-share (contain fit, no
  // mirror, labeled). We never call getUserMedia for camera access —
  // cameraless devices (desktops without webcams) can share their screen.
  const broadcastScreenState = useCallback((active: boolean): void => {
    if (!joinedRef.current || !myPeerId) return
    const payload: CallMsg = { type: 'call-screen-state', active, from: myPeerId }
    if (isHost) broadcast?.({ ...payload, peerId: myPeerId })
    else sendToHost?.(payload)
  }, [isHost, broadcast, sendToHost, myPeerId])

  const swapVideoTrack = useCallback((track: MediaStreamTrack | null): void => {
    mediaConnsRef.current.forEach(mc => {
      const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (!pc) return
      pc.getSenders().forEach(sender => {
        if (sender.track?.kind === 'video') {
          sender.replaceTrack(track).catch(() => {})
        }
      })
    })
  }, [])

  const swapAudioTrack = useCallback((track: MediaStreamTrack | null): void => {
    mediaConnsRef.current.forEach(mc => {
      const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (!pc) return
      pc.getSenders().forEach(sender => {
        if (sender.track?.kind === 'audio') {
          sender.replaceTrack(track).catch(() => {})
        }
      })
    })
  }, [])

  // Apply screen-share encoder tuning to every video sender on a PC:
  //  - contentHint='motion' tells the encoder this is high-motion content,
  //    prioritising frame rate over spatial detail (better for scrolling,
  //    video playback inside the shared tab, etc).
  //  - maxBitrate caps the outgoing bitrate so a fat LAN doesn't starve
  //    the opposite direction. 2 Mbps is a balanced floor for 1080p30
  //    screen content; go higher if quality is unacceptable, lower if lag
  //    persists on poor uplinks.
  //  - maxFramerate mirrors the getDisplayMedia constraint so the SFU/PC
  //    doesn't waste bandwidth on overshoot frames.
  const tuneScreenSenders = useCallback((pc: RTCPeerConnection): void => {
    pc.getSenders().forEach(sender => {
      if (sender.track?.kind !== 'video') return
      try { sender.track.contentHint = 'motion' } catch {}
      try {
        const params = sender.getParameters()
        const enc = params.encodings?.[0] ?? {}
        enc.maxBitrate = 2_000_000
        enc.maxFramerate = 30
        params.encodings = [enc]
        void sender.setParameters(params)
      } catch {}
    })
  }, [])

  const tuneAllScreenSenders = useCallback((): void => {
    mediaConnsRef.current.forEach(mc => {
      const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (pc) tuneScreenSenders(pc)
    })
  }, [tuneScreenSenders])

  // Keep the forward-reference ref current so callPeerWithStream / incoming
  // answer handler can tune newly-established PCs without a circular dep.
  useEffect(() => { tuneScreenSendersRef.current = tuneScreenSenders }, [tuneScreenSenders])

  // Close every MediaConnection and re-call each roster peer with the given
  // stream. Used to (re)publish video senders when switching between
  // audio-only and audio+screen publication modes.
  const recallAllPeersWith = useCallback((stream: MediaStream, asMode: CallMode): void => {
    const peerIds = Array.from(mediaConnsRef.current.keys())
    peerIds.forEach(pid => {
      const mc = mediaConnsRef.current.get(pid)
      if (mc) { try { mc.close() } catch {} }
      mediaConnsRef.current.delete(pid)
      clearRetryState(pid)
    })
    rosterRef.current.forEach((_, pid) => {
      callPeerWithStream(pid, stream, asMode)
    })
  }, [callPeerWithStream, clearRetryState])

  const stopScreenShare = useCallback((): void => {
    const s = screenStreamRef.current
    screenStreamRef.current = null
    screenSharingRef.current = false
    if (s) {
      s.getTracks().forEach(t => { try { t.stop() } catch {} })
    }
    // Tear down the mic + screen-audio mixer, if we built one. Restore the
    // raw mic track on every audio sender so peers keep hearing the user.
    if (screenAudioCtxRef.current) {
      try { void screenAudioCtxRef.current.close() } catch {}
      screenAudioCtxRef.current = null
    }
    mixedAudioTrackRef.current = null
    const localStream = localStreamRef.current
    const micTrack = localStream?.getAudioTracks()[0] || null
    swapAudioTrack(micTrack)
    // Restore based on what the user was publishing before the share:
    //   - If they still have a camera track (mode 'video'), swap it back
    //     into the existing video senders — no reconnect needed.
    //   - Otherwise the PCs carry a stale screen video sender from our
    //     combined-stream re-call; tear them down and re-call with plain
    //     audio so senders match mode.
    const camTrack = localStream?.getVideoTracks()[0] || null
    if (camTrack) {
      swapVideoTrack(camTrack)
    } else if (localStream && modeRef.current === 'audio') {
      recallAllPeersWith(localStream, 'audio')
      // Tell everyone our mode is back to audio so their tile strips video.
      const trackPayload: CallMsg = {
        type: 'call-track-state',
        micMuted: micMutedRef.current,
        cameraOff: true,
        mode: 'audio',
        from: myPeerId!,
      }
      if (isHost) broadcast?.(trackPayload)
      else sendToHost?.(trackPayload)
    }
    setScreenSharing(false)
    broadcastScreenState(false)
  }, [swapVideoTrack, swapAudioTrack, broadcastScreenState, recallAllPeersWith, isHost, broadcast, sendToHost, myPeerId])

  const startScreenShare = useCallback(async (): Promise<void> => {
    if (screenSharingRef.current || screenShareStarting) return
    if (!joinedRef.current) {
      setScreenShareError({ code: 'not-connected', message: 'Join the call before sharing your screen.', recoverable: false })
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      setScreenShareError({ code: 'media-failed', message: 'This browser does not support screen sharing.', recoverable: false })
      return
    }
    setScreenShareStarting(true)
    setScreenShareError(null)
    try {
      // Request tab/system audio alongside the video track. Chromium
      // honours `audio: true` when the user picks a tab or whole screen;
      // Firefox silently returns video only. Either way the video track
      // is guaranteed and we gracefully handle the missing-audio case.
      const share = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      if (!joinedRef.current) {
        share.getTracks().forEach(t => { try { t.stop() } catch {} })
        return
      }
      const videoTrack = share.getVideoTracks()[0]
      if (!videoTrack) {
        share.getTracks().forEach(t => { try { t.stop() } catch {} })
        throw new Error('No video track in screen share stream')
      }
      // Encoder hint before the track is attached so the first frames
      // already use motion-biased rate control.
      try { videoTrack.contentHint = 'motion' } catch {}

      screenStreamRef.current = share
      screenSharingRef.current = true

      // Build a mic+screen-audio mixer when the user granted tab audio.
      // WebAudio graph: (mic) → gain → dest  and  (screen) → gain → dest.
      // The destination's single track is what every peer connection
      // publishes, so each listener hears mic + tab audio mixed.
      const screenAudioTrack = share.getAudioTracks()[0] || null
      const micTrack = localStreamRef.current?.getAudioTracks()[0] || null
      if (screenAudioTrack) {
        try {
          const ctx = new AudioContext()
          const dest = ctx.createMediaStreamDestination()
          if (micTrack && micTrack.readyState !== 'ended') {
            ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest)
          }
          ctx.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(dest)
          const mixed = dest.stream.getAudioTracks()[0] || null
          if (mixed) {
            screenAudioCtxRef.current = ctx
            mixedAudioTrackRef.current = mixed
            // If the user revokes tab audio (closes tab being shared), the
            // audio track ends. Swap back to raw mic so peers still hear us.
            screenAudioTrack.addEventListener('ended', () => {
              if (mixedAudioTrackRef.current !== mixed) return
              mixedAudioTrackRef.current = null
              if (screenAudioCtxRef.current === ctx) {
                try { void ctx.close() } catch {}
                screenAudioCtxRef.current = null
              }
              const fallback = localStreamRef.current?.getAudioTracks()[0] || null
              swapAudioTrack(fallback)
            })
          } else {
            try { void ctx.close() } catch {}
          }
        } catch {
          // WebAudio unavailable / construction failed — fall through with
          // the raw mic track still in use, so sharing works without tab audio.
        }
      }

      // Auto-stop when the user hits the browser's native "Stop sharing"
      // chrome. The video track fires `ended` without any JS action.
      videoTrack.addEventListener('ended', () => {
        if (screenStreamRef.current === share) stopScreenShare()
      })

      if (modeRef.current === 'video') {
        // Fast path: swap into existing video senders. No renegotiation.
        swapVideoTrack(videoTrack)
      } else {
        // No video sender exists. Build a combined stream and renegotiate
        // each MediaConnection. Remote sees this as a mode change to video
        // — the call-screen-state flag we broadcast below flips the UI to
        // screen-tile rendering.
        const combined = new MediaStream()
        const outgoingAudio = mixedAudioTrackRef.current ?? micTrack
        if (outgoingAudio) combined.addTrack(outgoingAudio)
        combined.addTrack(videoTrack)
        recallAllPeersWith(combined, 'video')
      }

      // After the video sender is wired up (immediately for replaceTrack,
      // or on the next animation frame for the renegotiation path), push
      // encoder params so the first seconds of share don't burn 10+ Mbps.
      // Peerjs attaches `peerConnection` synchronously in the replaceTrack
      // path; for recall we wait a tick to let the new mcs register.
      if (modeRef.current === 'video') tuneAllScreenSenders()
      else requestAnimationFrame(() => tuneAllScreenSenders())

      // Publish the mixed audio track to existing senders when we built
      // one. The recall path already used it via the combined stream, so
      // this only matters for the replaceTrack / video-mode branch.
      if (mixedAudioTrackRef.current && modeRef.current === 'video') {
        swapAudioTrack(mixedAudioTrackRef.current)
      }

      setScreenSharing(true)
      broadcastScreenState(true)
      // Tell the room we're publishing video now (even if local camera is
      // off). Without this, remote tiles stay as AudioTile and ignore the
      // screen video track.
      const trackPayload: CallMsg = {
        type: 'call-track-state',
        micMuted: micMutedRef.current,
        cameraOff: false,
        mode: 'video',
        from: myPeerId!,
      }
      if (isHost) broadcast?.(trackPayload)
      else sendToHost?.(trackPayload)
    } catch (e) {
      const name = (e as { name?: string })?.name || ''
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setScreenShareError({ code: 'permission-denied', message: 'Screen sharing was blocked.', recoverable: true })
      } else {
        setScreenShareError({ code: 'media-failed', message: (e as Error).message || 'Could not start screen sharing.', recoverable: true })
      }
    } finally {
      setScreenShareStarting(false)
    }
  }, [screenShareStarting, swapVideoTrack, swapAudioTrack, broadcastScreenState, stopScreenShare, recallAllPeersWith, tuneAllScreenSenders, isHost, broadcast, sendToHost, myPeerId])

  const dismissScreenShareError = useCallback((): void => setScreenShareError(null), [])

  const leave = useCallback((reason: CallEndReason = 'user-left'): void => {
    // Invalidate any in-flight join attempt.
    joinAttemptRef.current = Symbol('leave')
    // Stop any active screen share so tracks are released and remote tiles
    // flip back to camera view on rejoin. Tear down the audio mixer too so
    // the AudioContext releases the audio hardware.
    if (screenSharingRef.current) {
      const s = screenStreamRef.current
      screenStreamRef.current = null
      screenSharingRef.current = false
      if (s) s.getTracks().forEach(t => { try { t.stop() } catch {} })
      if (screenAudioCtxRef.current) {
        try { void screenAudioCtxRef.current.close() } catch {}
        screenAudioCtxRef.current = null
      }
      mixedAudioTrackRef.current = null
      setScreenSharing(false)
    }
    mediaConnsRef.current.forEach(mc => { try { mc.close() } catch {} })
    mediaConnsRef.current.clear()
    // Drop any pending retry / ghost-prune work so a rejoin starts clean.
    mediaConnRetryRef.current.forEach(slot => {
      if (slot.timer) { try { clearTimeout(slot.timer) } catch {} }
    })
    mediaConnRetryRef.current.clear()
    pruneTimersRef.current.forEach(timer => { try { clearTimeout(timer) } catch {} })
    pruneTimersRef.current.clear()
    if (joinedRef.current) {
      if (isHost) {
        broadcast?.({ type: 'call-peer-left', peerId: myPeerId!, from: myPeerId! } satisfies CallMsg)
      } else {
        sendToHost?.({ type: 'call-leave', from: myPeerId! } satisfies CallMsg)
      }
    }
    // Flip joinedRef BEFORE calling localMedia.stop() so the mode-watcher
    // effect (which guards on joinedRef.current to tell user-initiated
    // leaves apart from involuntary device loss) sees the correct value
    // when it re-runs after localMedia's state update.
    setJoined(false)
    joinedRef.current = false
    // Release the duplicate-tab claim so a sibling tab can take over.
    if (tabChannelRef.current) {
      try { tabChannelRef.current.close() } catch {}
      tabChannelRef.current = null
    }
    localMediaStop()
    setMode('none')
    modeRef.current = 'none'
    setRoster(new Map())
    setEndReason(reason)
  }, [isHost, broadcast, sendToHost, myPeerId, localMediaStop])

  const dismissEndReason = useCallback((): void => {
    setEndReason(null)
  }, [])

  // Dismissing clears the call-layer copy; localMedia.error resets on the
  // next start() attempt, so no explicit wiring is needed for it.
  const dismissError = useCallback((): void => {
    setCallError(null)
  }, [])

  // Public error surface: call-layer wins over media-layer (call-layer is
  // usually scoped to a specific peer and more time-sensitive).
  const error: CallError | null = callError
    ?? (localMedia.error ? classifyMediaError(localMedia.error.code, localMedia.error.message) : null)

  // ── Track-state broadcast on local mic toggle ──────────────────────────

  const toggleMic = useCallback((): void => {
    localMediaToggleMic()
  }, [localMediaToggleMic])

  const toggleCamera = useCallback((): void => {
    void localMediaToggleCamera()
  }, [localMediaToggleCamera])

  // Involuntary media loss: if useLocalMedia transitions to 'none' while
  // we're joined, the device died on us (mic unplugged, permission revoked,
  // both tracks ended). Treat as an involuntary leave. useLocalMedia has
  // already set an error banner that the merged `error` field will surface.
  //
  // Note: during a normal user-initiated leave(), joinedRef.current is
  // flipped to false *before* localMedia.stop() runs, so the guard below
  // bails and we don't double-fire with the wrong reason.
  useEffect(() => {
    if (!joinedRef.current) return
    if (localMedia.mode !== 'none') return
    leave('error')
  }, [localMedia.mode, leave])

  // ── Host: prune ghost peers when their DataConnection dies ─────────────
  // The host's useSender owns DataConnection lifecycle and exposes the
  // current live set via `participants`. When a peer's data channel drops
  // but their RTCPeerConnection is still stuck on TURN, we'd otherwise
  // render them as a "ghost" tile forever. We prune them with a grace
  // window so brief network flaps don't evict a reconnecting peer.
  //
  // Only the host runs this — non-hosts get their signaling lifecycle
  // driven by the `peer` identity change in useReceiver, which triggers
  // the cleanup effect below.
  useEffect(() => {
    if (!isHost) return
    if (!joinedRef.current) return

    const aliveIds = new Set(participants.map(p => p.peerId))
    const timers = pruneTimersRef.current

    rosterRef.current.forEach((_, pid) => {
      if (pid === myPeerId) return
      if (aliveIds.has(pid)) {
        // Peer is alive (or came back within the grace window). Cancel
        // any pending prune.
        const pending = timers.get(pid)
        if (pending) {
          clearTimeout(pending)
          timers.delete(pid)
        }
        return
      }
      // Peer is gone from the data layer. Schedule the prune, but only
      // if we haven't already scheduled one for this peer.
      if (timers.has(pid)) return
      const timer = setTimeout(() => {
        timers.delete(pid)
        if (!joinedRef.current) return
        if (!rosterRef.current.has(pid)) return
        // One last guard: if by the time the timer fires the peer is back
        // (participants updated between schedule and fire), skip.
        // Reading participants here is stale, so we just trust the timer —
        // if they came back, the effect above would have cleared the timer.
        closeMediaConn(pid)
        removeFromRoster(pid)
        // Tell remaining peers so their rosters also prune.
        broadcast?.({ type: 'call-peer-left', peerId: pid, from: myPeerId! } satisfies CallMsg)
      }, GHOST_PRUNE_GRACE_MS)
      timers.set(pid, timer)
    })
  }, [isHost, participants, myPeerId, closeMediaConn, removeFromRoster, broadcast])

  // Mic-only track state broadcast. Mode changes emit their own payload
  // from the mode-reconnect effect above, so this handles mute toggles.
  const prevMicMutedRef = useRef<boolean>(false)
  useEffect(() => {
    if (!joinedRef.current) return
    if (localMedia.micMuted === prevMicMutedRef.current) return
    prevMicMutedRef.current = localMedia.micMuted
    const payload = {
      type: 'call-track-state',
      micMuted: localMedia.micMuted,
      cameraOff: localMedia.mode !== 'video',
      mode: (localMedia.mode === 'video' ? 'video' : 'audio') as CallMode,
      from: myPeerId!,
    } satisfies CallMsg
    if (isHost) broadcast?.(payload)
    else sendToHost?.(payload)
  }, [localMedia.micMuted, localMedia.mode, isHost, broadcast, sendToHost, myPeerId])

  // ── Cleanup on unmount or peer change ──────────────────────────────────
  // Receiver reconnects swap the Peer instance. When that happens the
  // existing media connections are on a dead peer — close them, wipe the
  // roster, and surface a connection-lost reason if we were mid-call.
  useEffect(() => {
    return () => {
      mediaConnsRef.current.forEach(mc => { try { mc.close() } catch {} })
      mediaConnsRef.current.clear()
      mediaConnRetryRef.current.forEach(slot => {
        if (slot.timer) { try { clearTimeout(slot.timer) } catch {} }
      })
      mediaConnRetryRef.current.clear()
      pruneTimersRef.current.forEach(timer => { try { clearTimeout(timer) } catch {} })
      pruneTimersRef.current.clear()
      lastTrackStateAtRef.current.clear()
      if (tabChannelRef.current) {
        try { tabChannelRef.current.close() } catch {}
        tabChannelRef.current = null
      }
      if (joinedRef.current) {
        try { localMediaStop() } catch {}
        setMode('none')
        modeRef.current = 'none'
        setJoined(false)
        joinedRef.current = false
        setRoster(new Map())
        setEndReason('connection-lost')
      }
    }
  }, [peer, localMediaStop])

  return {
    joined,
    joining,
    mode,
    error,
    endReason,
    dismissEndReason,
    dismissError,
    remotePeers,
    videoTileCount,
    overSoftVideoCap,
    softVideoCap: SOFT_VIDEO_CAP,
    join,
    leave,
    toggleMic,
    toggleCamera,
    micMuted: localMedia.micMuted,
    cameraOff: localMedia.mode !== 'video',
    cameraStarting: localMedia.starting && localMedia.mode !== 'video',
    // Device plumbing for the controls bar
    micDevices: localMedia.micDevices,
    cameraDevices: localMedia.cameraDevices,
    selectedMicId: localMedia.selectedMicId,
    selectedCameraId: localMedia.selectedCameraId,
    selectMic: localMedia.selectMic,
    selectCamera: localMedia.selectCamera,
    cameraFacing: localMedia.cameraFacing,
    flipCamera: localMedia.flipCamera,
    localStream: localMedia.stream,
    // Screen share: active flag + control methods. `screenShareError` is
    // kept separate from `error` so the screen-share banner can be
    // dismissed without clearing an unrelated call error.
    screenSharing,
    screenShareStarting,
    screenShareError,
    startScreenShare,
    stopScreenShare,
    dismissScreenShareError,
    screenStream: screenSharing ? screenStreamRef.current : null,
  }
}

export type UseCallReturn = ReturnType<typeof useCall>
