import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Peer, { MediaConnection } from 'peerjs'
import { UseLocalMediaReturn, LocalMediaMode } from './useLocalMedia'
import type { CallMsg } from '../net/protocol'
import {
  tryClaim, refreshClaim, releaseClaim, getStableTabId,
  CLAIM_HEARTBEAT_MS,
} from '../utils/callTabClaim'

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

// Stable id for THIS browsing context — used by the duplicate-tab claim
// in `utils/callTabClaim.ts`. sessionStorage-backed so a page refresh /
// hot-reload reuses the same id and recognizes its own active claim
// (otherwise refresh-during-call would refuse to rejoin until the prior
// claim expired). Falls back to a fresh UUID when sessionStorage is blocked.
const TAB_ID = getStableTabId()

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
  // Require `enabled` too so the 2x2 dummy track we attach to every offer
  // for SDP-negotiation purposes doesn't get misread as a real video
  // publication. Dummy tracks ship with enabled=false; real camera /
  // screen tracks default to enabled=true.
  return tracks.length > 0 && tracks.some(t => t.readyState !== 'ended' && t.enabled)
}

// Prefer VP9 for every video transceiver on the given PC. VP9 compresses
// text and UI chrome ~30% better than VP8 at equivalent bitrate, which is
// the bulk of what users share. Falls back silently on browsers that don't
// expose getCapabilities (Safari) or don't offer VP9 encode (Safari again).
//
// Called synchronously after peer.call / mc.answer — peerjs creates the PC,
// adds tracks, then queues createOffer/Answer on the microtask queue, so
// mutating transceiver codec preferences now lands before the SDP is
// generated.
function preferVp9OnPc(pc: RTCPeerConnection | null | undefined): void {
  if (!pc) return
  if (typeof RTCRtpReceiver === 'undefined') return
  if (typeof RTCRtpReceiver.getCapabilities !== 'function') return
  const recvCaps = RTCRtpReceiver.getCapabilities('video')
  if (!recvCaps || !recvCaps.codecs) return
  // H9 — gate on BOTH encode and decode capability. On iOS Safari < 16.4
  // the receiver may advertise VP9 decode only if the builtin decoder
  // variant matches; preferring VP9 when we cannot also encode it leaves
  // the remote peer with a codec we negotiated but can't drive.
  let senderHasVp9 = true
  if (typeof RTCRtpSender !== 'undefined' && typeof RTCRtpSender.getCapabilities === 'function') {
    const sendCaps = RTCRtpSender.getCapabilities('video')
    senderHasVp9 = !!sendCaps?.codecs?.some(c => c.mimeType.toLowerCase() === 'video/vp9')
  }
  if (!senderHasVp9) return
  const preferred: RTCRtpCodec[] = []
  const fallback: RTCRtpCodec[] = []
  for (const c of recvCaps.codecs) {
    const mime = c.mimeType.toLowerCase()
    if (mime === 'video/vp9') preferred.push(c)
    else fallback.push(c)
  }
  if (preferred.length === 0) return
  const ordered = [...preferred, ...fallback]
  pc.getTransceivers().forEach(tx => {
    const kind = tx.sender?.track?.kind ?? tx.receiver?.track?.kind
    if (kind !== 'video') return
    try { tx.setCodecPreferences(ordered) } catch {}
  })
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
  // H10: true while we're publishing tab/system audio alongside the screen
  // video. Surfaces a UI hint about the content-echo limitation — when the
  // shared tab itself plays a remote voice (e.g., another video call running
  // inside it), that voice is captured by getDisplayMedia and re-broadcast
  // to every peer in this call. AEC can't fix it: AEC needs a reference
  // signal for *acoustic* echo from speakers → mic, but here both inputs
  // arrive as separate clean digital streams that the mixer concatenates.
  const [screenAudioShared, setScreenAudioShared] = useState<boolean>(false)

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
  // Heartbeat timer for the cross-tab call claim (see `utils/callTabClaim.ts`).
  // While joined, refreshes the localStorage record every CLAIM_HEARTBEAT_MS
  // so sibling tabs see an active claim and don't reclaim past CLAIM_STALE_MS.
  const claimHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Host id we currently hold a claim against — captured at join time so
  // leave/unmount can release the right key even if `hostPeerId` later changes.
  const claimedHostRef = useRef<string | null>(null)
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

  // A tiny always-on video track. peerjs uses pc.addStream(...) which
  // only negotiates m-lines for tracks present in the OFFER. If a joiner
  // offers audio-only and the remote is screen-sharing, the remote's
  // video track has no matching m-line and gets silently dropped — the
  // viewer hears audio but sees black. Including this dummy track in
  // every outbound offer guarantees a video m-line, which the remote
  // can then answer with their real screen (or camera) track.
  const dummyVideoTrackRef = useRef<MediaStreamTrack | null>(null)
  const getDummyVideoTrack = useCallback((): MediaStreamTrack | null => {
    const existing = dummyVideoTrackRef.current
    if (existing && existing.readyState !== 'ended') return existing
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 2
      canvas.height = 2
      const ctx = canvas.getContext('2d')
      if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 2, 2) }
      // 1fps + tiny resolution ≈ nothing on the wire; this exists for the
      // SDP m-line, not for a viewer to watch.
      type CanvasWithCapture = HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream }
      const capture = (canvas as CanvasWithCapture).captureStream
      if (typeof capture !== 'function') return null
      const s = capture.call(canvas, 1)
      const t = s.getVideoTracks()[0] || null
      if (t) {
        // Disabled so streamHasLiveVideo() correctly reports "no real
        // video" — this track exists purely to force an SDP m-line.
        t.enabled = false
        try { t.contentHint = 'detail' } catch {}
        dummyVideoTrackRef.current = t
      }
      return t
    } catch {
      return null
    }
  }, [])

  // Returns the stream we should publish to a NEW peer connection right now.
  // When screen-sharing is active we hand out a fresh MediaStream carrying
  // (a) the mixed audio track if we captured tab audio, otherwise the raw
  // mic track, and (b) the screen video track. When NOT sharing we still
  // include a dummy video track so the offer negotiates a video m-line —
  // that lets us receive a screen share from a peer who starts sharing
  // AFTER the PC is established, without renegotiation. Without this,
  // late joiners to a room where someone is already sharing would hear
  // audio but see black.
  const getPublishStream = useCallback((): MediaStream | null => {
    const local = localStreamRef.current
    if (screenSharingRef.current && screenStreamRef.current) {
      const screenVideo = screenStreamRef.current.getVideoTracks()[0]
      if (screenVideo) {
        const out = new MediaStream()
        const mixed = mixedAudioTrackRef.current
        if (mixed && mixed.readyState !== 'ended') {
          out.addTrack(mixed)
        } else {
          local?.getAudioTracks().forEach(t => out.addTrack(t))
        }
        out.addTrack(screenVideo)
        return out
      }
    }
    if (!local) return null
    // Not sharing: if the local stream already has a video track (camera
    // on), just pass it through. Otherwise attach the dummy so the offer
    // still includes a video m-line.
    if (local.getVideoTracks().length > 0) return local
    const dummy = getDummyVideoTrack()
    if (!dummy) return local
    const out = new MediaStream()
    local.getAudioTracks().forEach(t => out.addTrack(t))
    out.addTrack(dummy)
    return out
  }, [getDummyVideoTrack])

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
  // Same forward-reference for forceKeyframe — called on every new mc
  // stream event during a share so late joiners get frames instantly
  // instead of waiting for the next regular keyframe.
  const forceKeyframeRef = useRef<((pc: RTCPeerConnection) => void) | null>(null)

  const callPeerWithStream = useCallback<CallPeerFn>((peerId, stream, myMode) => {
    if (!peer || peerId === myPeerId) return
    if (mediaConnsRef.current.has(peerId)) return
    try {
      const mc = peer.call(peerId, stream, { metadata: { kind: 'manifest-call', mode: myMode, name: myNameRef.current } })
      mediaConnsRef.current.set(peerId, mc)
      // Prefer VP9 before the offer is serialised. peerjs queues its
      // createOffer on the microtask queue, so this sync call lands first.
      preferVp9OnPc((mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection)
      mc.on('stream', (remoteStream: MediaStream) => {
        clearRetryState(peerId)
        upsertRoster(peerId, {
          stream: remoteStream,
          mode: streamHasLiveVideo(remoteStream) ? 'video' : 'audio',
        })
        const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
        if (pc) {
          if (screenSharingRef.current) {
            tuneScreenSendersRef.current?.(pc)
            forceKeyframeRef.current?.(pc)
          } else {
            // M-v — cap camera sender bitrate on every fresh PC so mesh
            // video doesn't starve the uplink at >4 participants.
            tuneCameraSendersRef.current?.(pc)
          }
        }
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })
        // H13 — peerjs does not always close the underlying PC when the
        // remote closes first (glare). Close it explicitly so camera /
        // ICE candidates release promptly instead of lingering.
        try {
          const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
          pc?.close()
        } catch { /* noop */ }
      })
      mc.on('error', (err: unknown) => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })
        try {
          const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
          pc?.close()
        } catch { /* noop */ }

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
      // M-s — glare resolution: when both sides dialled simultaneously we
      // have an outbound mc in `mediaConnsRef` AND we're handling an
      // inbound one. Use lexicographic peerId comparison so both sides
      // converge on the same surviving connection (outbound from the peer
      // with the larger id, inbound for the smaller).
      const existing = mediaConnsRef.current.get(mc.peer)
      if (existing && existing !== mc) {
        const myId = myPeerId || ''
        const keepIncoming = myId < mc.peer
        if (keepIncoming) {
          try { existing.close() } catch {}
          mediaConnsRef.current.delete(mc.peer)
        } else {
          try { mc.close() } catch {}
          return
        }
      }
      // If screen-sharing, answer with a stream carrying screen video +
      // local audio so the caller sees our share immediately.
      const answerStream = getPublishStream() ?? localStreamRef.current
      try { mc.answer(answerStream) } catch { return }
      mediaConnsRef.current.set(mc.peer, mc)
      // Prefer VP9 before peerjs's createAnswer runs on the microtask queue.
      preferVp9OnPc((mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection)

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
        const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
        if (pc) {
          if (screenSharingRef.current) {
            tuneScreenSendersRef.current?.(pc)
            forceKeyframeRef.current?.(pc)
          } else {
            tuneCameraSendersRef.current?.(pc)
          }
        }
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(mc.peer)
        upsertRoster(mc.peer, { stream: null })
        try {
          const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
          pc?.close()
        } catch { /* noop */ }
      })
      mc.on('error', (err: unknown) => {
        console.warn('incoming mc error for', mc.peer, err)
        mediaConnsRef.current.delete(mc.peer)
        // Match the outbound handler — clear the stream so the tile shows
        // the peer as not-streaming instead of a stale "connected" state.
        upsertRoster(mc.peer, { stream: null })
        try {
          const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
          pc?.close()
        } catch { /* noop */ }
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
    // M-r — while actively screen-sharing we want peers to keep receiving
    // the mixed (mic + tab-audio) track, not the raw new mic track. If
    // the mixer destination is still live, prefer it; otherwise fall
    // back to the raw mic. Graph rebuild with the new mic source is a
    // separate follow-up (requires disconnect + createMediaStreamSource +
    // reconnect on the shared AudioContext).
    const rawMicTrack = stream.getAudioTracks()[0] || null
    const mixed = mixedAudioTrackRef.current
    const preferMixed = screenSharingRef.current && mixed && mixed.readyState !== 'ended'
    const audioTrack = preferMixed ? mixed : rawMicTrack
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
    // Re-call every roster member with the publish stream so the offer
    // still carries a video m-line even in audio mode (dummy track) and
    // carries screen video if a share is active.
    const publishStream = getPublishStream() ?? stream
    rosterRef.current.forEach((_, pid) => {
      callPeerWithStream(pid, publishStream, newMode as CallMode)
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
  }, [localMedia.mode, isHost, broadcast, sendToHost, myPeerId, callPeerWithStream, clearRetryState, getPublishStream])

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

    // H11: duplicate-tab guard via atomic localStorage claim. The prior
    // BroadcastChannel probe was a notify-only protocol with a 300 ms wait
    // window — two tabs opening in the same window both saw silence and
    // both admitted, causing audio feedback. tryClaim writes our tabId to
    // `manifest-call-claim-${hostPeerId}`, waits CLAIM_RACE_DELAY_MS for
    // any concurrent writer to land, then re-reads. Whoever's tabId
    // survives the re-read wins; the loser refuses with `duplicate-tab`.
    // The "room" is the host's peerId — shared across tabs of the same
    // browser for non-hosts; hosts get unique peerIds per tab so they
    // can't accidentally double-join.
    if (!isHost && hostPeerId) {
      const won = await tryClaim(hostPeerId, TAB_ID)
      if (!won) {
        setCallError({
          code: 'duplicate-tab',
          message: "You're already in this call in another tab. Close the other tab to join here.",
          recoverable: false,
        })
        setJoining(false)
        return
      }
      // Hold the claim with a heartbeat so siblings see it as active.
      claimedHostRef.current = hostPeerId
      if (claimHeartbeatRef.current) clearInterval(claimHeartbeatRef.current)
      claimHeartbeatRef.current = setInterval(
        () => refreshClaim(hostPeerId, TAB_ID),
        CLAIM_HEARTBEAT_MS,
      )
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
        // Publish via getPublishStream so the offer carries a video
        // m-line (from the dummy track) — without it, a peer who starts
        // screen-sharing later can't send us frames because our PC has
        // no video sender slot to answer with.
        const publishStream = getPublishStream() ?? stream
        existingPeerIds.forEach(pid => callPeerWithStream(pid, publishStream, 'audio'))
        broadcast?.({ type: 'call-peer-joined', peerId: myPeerId!, name: myNameRef.current, mode: 'audio', screenSharing: false, from: myPeerId! } satisfies CallMsg)
      } else {
        sendToHost?.({ type: 'call-join', mode: 'audio', name: myNameRef.current, from: myPeerId! } satisfies CallMsg)
      }

      setJoined(true)
      joinedRef.current = true
    } catch (e) {
      // Release the duplicate-tab claim that we optimistically took before
      // the media prompt. Without this, a failed join leaves the localStorage
      // claim active and every retry sees itself as a sibling conflict.
      if (claimHeartbeatRef.current) {
        clearInterval(claimHeartbeatRef.current)
        claimHeartbeatRef.current = null
      }
      if (claimedHostRef.current) {
        releaseClaim(claimedHostRef.current, TAB_ID)
        claimedHostRef.current = null
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
  }, [peer, myPeerId, joining, localMediaStart, isHost, hostPeerId, broadcast, sendToHost, callPeerWithStream, getPublishStream])

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
      // 'detail' biases the encoder toward spatial quality (crisp text and
      // UI edges) over temporal smoothness — the right tradeoff for code
      // editors, docs, and slides, which are the bulk of what users share.
      try { sender.track.contentHint = 'detail' } catch {}
      try {
        const params = sender.getParameters()
        const enc = params.encodings?.[0] ?? {}
        enc.maxBitrate = 4_000_000
        enc.maxFramerate = 30
        params.encodings = [enc]
        // Prefer lower resolution over dropped frames when bandwidth
        // tightens — smoother perceived motion for screen content.
        type ParamsWithDegradation = RTCRtpSendParameters & { degradationPreference?: string }
        ;(params as ParamsWithDegradation).degradationPreference = 'maintain-framerate'
        void sender.setParameters(params)
      } catch {}
    })
  }, [])

  // Force the encoder to emit a keyframe on the given PC's video senders.
  // Toggling track.enabled false -> true is the most reliable cross-
  // browser nudge; Chromium emits a fresh keyframe on re-enable so a
  // freshly-negotiated receiver doesn't stare at black while waiting for
  // the next regular keyframe. Called after every new mc.on('stream')
  // during an active share.
  const forceKeyframe = useCallback((pc: RTCPeerConnection): void => {
    pc.getSenders().forEach(sender => {
      const track = sender.track
      if (!track || track.kind !== 'video' || track.readyState === 'ended') return
      try {
        track.enabled = false
        setTimeout(() => {
          try { if (track.readyState !== 'ended') track.enabled = true } catch {}
        }, 60)
      } catch {}
    })
  }, [])

  // M-v — camera senders cap. A 20-peer mesh means each local camera is
  // encoded 19 times (one stream per PC, no SFU). With the default encoder
  // budget ~2.5 Mbps per stream, a modest home uplink saturates around 4-5
  // active video peers. 600 kbps is a realistic ceiling for P2P mesh video
  // without simulcast. 24 fps is a smoother perceptual floor than 15 on
  // talking-head content. Apply to every fresh video PC.
  const tuneCameraSenders = useCallback((pc: RTCPeerConnection): void => {
    pc.getSenders().forEach(sender => {
      if (sender.track?.kind !== 'video') return
      try {
        const params = sender.getParameters()
        const enc = params.encodings?.[0] ?? {}
        enc.maxBitrate = 600_000
        enc.maxFramerate = 24
        params.encodings = [enc]
        type ParamsWithDegradation = RTCRtpSendParameters & { degradationPreference?: string }
        ;(params as ParamsWithDegradation).degradationPreference = 'maintain-framerate'
        void sender.setParameters(params)
      } catch { /* noop */ }
    })
  }, [])

  const tuneCameraSendersRef = useRef<((pc: RTCPeerConnection) => void) | null>(null)
  useEffect(() => { tuneCameraSendersRef.current = tuneCameraSenders }, [tuneCameraSenders])

  const tuneAllScreenSenders = useCallback((): void => {
    mediaConnsRef.current.forEach(mc => {
      const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
      if (pc) tuneScreenSenders(pc)
    })
  }, [tuneScreenSenders])

  // Keep the forward-reference ref current so callPeerWithStream / incoming
  // answer handler can tune newly-established PCs without a circular dep.
  useEffect(() => { tuneScreenSendersRef.current = tuneScreenSenders }, [tuneScreenSenders])
  useEffect(() => { forceKeyframeRef.current = forceKeyframe }, [forceKeyframe])

  // Sender-side visibility nudge: when the sharer's tab regains focus,
  // Chromium may have paused encoding while backgrounded. Toggle every
  // outgoing video track's `enabled` flag to force a fresh keyframe so
  // viewers' decoders resync instead of staring at a frozen frame for
  // 5–10 seconds until the next regular keyframe.
  useEffect(() => {
    if (typeof document === 'undefined') return
    const onVisibility = (): void => {
      if (document.visibilityState !== 'visible') return
      if (!joinedRef.current) return
      if (!screenSharingRef.current && modeRef.current !== 'video') return
      mediaConnsRef.current.forEach(mc => {
        const pc = (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
        if (!pc) return
        pc.getSenders().forEach(sender => {
          const track = sender.track
          if (!track || track.kind !== 'video' || track.readyState === 'ended') return
          try {
            track.enabled = false
            setTimeout(() => {
              try { if (track.readyState !== 'ended') track.enabled = true } catch {}
            }, 60)
          } catch {}
        })
      })
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => { document.removeEventListener('visibilitychange', onVisibility) }
  }, [])

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
    setScreenAudioShared(false)
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
          // iOS Safari / Chromium autoplay policy can hand back a suspended
          // context. A suspended destination silently emits no samples, so
          // peers would hear nothing until the user happens to interact with
          // the page again. The startScreenShare call sits behind a user
          // gesture (click on the share button), so resume() is permitted.
          if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
          const dest = ctx.createMediaStreamDestination()
          if (micTrack && micTrack.readyState !== 'ended') {
            ctx.createMediaStreamSource(new MediaStream([micTrack])).connect(dest)
          }
          ctx.createMediaStreamSource(new MediaStream([screenAudioTrack])).connect(dest)
          const mixed = dest.stream.getAudioTracks()[0] || null
          if (mixed) {
            screenAudioCtxRef.current = ctx
            mixedAudioTrackRef.current = mixed
            setScreenAudioShared(true)
            // If the user revokes tab audio (closes tab being shared), the
            // audio track ends. Swap back to raw mic so peers still hear us.
            screenAudioTrack.addEventListener('ended', () => {
              if (mixedAudioTrackRef.current !== mixed) return
              mixedAudioTrackRef.current = null
              if (screenAudioCtxRef.current === ctx) {
                try { void ctx.close() } catch {}
                screenAudioCtxRef.current = null
              }
              setScreenAudioShared(false)
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
    if (claimHeartbeatRef.current) {
      clearInterval(claimHeartbeatRef.current)
      claimHeartbeatRef.current = null
    }
    if (claimedHostRef.current) {
      releaseClaim(claimedHostRef.current, TAB_ID)
      claimedHostRef.current = null
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

  // M-t — periodic track-state heartbeat. The mute-toggle effect above is
  // edge-triggered: a single DataConnection drop (reconnect window, flap)
  // can swallow the message, stranding remote UI at the previous state
  // until the next toggle. Re-broadcast every 10 s while joined so any
  // drift reconciles within one cycle. No-op before join / after leave.
  useEffect(() => {
    if (!joinedRef.current) return
    const timer = setInterval(() => {
      if (!joinedRef.current) return
      const payload = {
        type: 'call-track-state',
        micMuted: localMedia.micMuted,
        cameraOff: localMedia.mode !== 'video',
        mode: (localMedia.mode === 'video' ? 'video' : 'audio') as CallMode,
        from: myPeerId!,
      } satisfies CallMsg
      if (isHost) broadcast?.(payload)
      else sendToHost?.(payload)
    }, 10_000)
    return () => clearInterval(timer)
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
      if (claimHeartbeatRef.current) {
        clearInterval(claimHeartbeatRef.current)
        claimHeartbeatRef.current = null
      }
      if (claimedHostRef.current) {
        releaseClaim(claimedHostRef.current, TAB_ID)
        claimedHostRef.current = null
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
    // H10: true while we're publishing tab/system audio. CallPanel renders
    // a one-line content-echo warning so users know to mute the shared tab
    // (or stop sharing audio) if peers report hearing themselves back.
    screenAudioShared,
    startScreenShare,
    stopScreenShare,
    dismissScreenShareError,
    screenStream: screenSharing ? screenStreamRef.current : null,
  }
}

export type UseCallReturn = ReturnType<typeof useCall>
