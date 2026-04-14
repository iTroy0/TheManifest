import { useState, useEffect, useRef, useCallback } from 'react'
import Peer, { MediaConnection } from 'peerjs'
import { UseLocalMediaReturn, LocalMediaMode } from './useLocalMedia'

// ── Types ────────────────────────────────────────────────────────────────

export type CallMode = 'audio' | 'video'

// Per-peer roster entry. `mode` is the *current* publishing mode and is
// updated live as peers turn their cameras on/off — it is NOT frozen at
// join time. `hasVideo` is the lower-level truth derived from the actual
// MediaStream, which we use as a fallback when track-state messages haven't
// arrived yet.
export interface RemotePeer {
  peerId: string
  name: string
  mode: CallMode
  stream: MediaStream | null
  micMuted: boolean
  cameraOff: boolean
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

// ── Helpers ──────────────────────────────────────────────────────────────

function classifyMediaError(e: unknown): CallError {
  const name = (e as { name?: string })?.name || ''
  const msg = (e as { message?: string })?.message || 'Failed to start media'
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { code: 'permission-denied', message: 'Microphone access was blocked. Allow it in your browser settings and try again.', recoverable: true }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: 'device-not-found', message: 'No microphone was found on this device.', recoverable: false }
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'device-in-use', message: 'Your microphone is in use by another app. Close it and try again.', recoverable: true }
    default:
      return { code: 'media-failed', message: msg, recoverable: true }
  }
}

// Lift a useLocalMedia error into the call lane's CallError shape so the
// panel only watches a single error surface. We translate the code, expand
// the message, and decide whether the failure is recoverable.
function liftLocalMediaError(err: { code: string; message: string }): CallError {
  switch (err.code) {
    case 'permission-denied':
      return { code: 'permission-denied', message: err.message, recoverable: true }
    case 'device-not-found':
      return { code: 'device-not-found', message: err.message, recoverable: false }
    case 'in-use':
      return { code: 'device-in-use', message: err.message, recoverable: true }
    case 'overconstrained':
      return { code: 'overconstrained', message: err.message, recoverable: true }
    case 'unsupported':
      return { code: 'media-failed', message: err.message, recoverable: false }
    default:
      return { code: 'media-failed', message: err.message, recoverable: true }
  }
}

function streamHasLiveVideo(stream: MediaStream | null): boolean {
  if (!stream) return false
  const tracks = stream.getVideoTracks()
  return tracks.length > 0 && tracks.some(t => t.readyState !== 'ended')
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useCall(options: UseCallOptions) {
  const {
    peer, myPeerId, myName, isHost, hostPeerId,
    sendToHost, sendToPeer, broadcast, setMessageHandler,
    localMedia,
  } = options

  const [joined, setJoined] = useState<boolean>(false)
  const [joining, setJoining] = useState<boolean>(false)
  const [mode, setMode] = useState<LocalMediaMode>('none')
  // Internal call-layer errors (rejection, peer-unavailable, …). Local-media
  // errors come in via `localMedia.error` and we merge them into the public
  // `error` field below so consumers only watch one surface.
  const [callError, setCallError] = useState<CallError | null>(null)
  const [endReason, setEndReason] = useState<CallEndReason | null>(null)
  const [roster, setRoster] = useState<Map<string, RemotePeer>>(new Map())
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null)

  const mediaConnsRef = useRef<Map<string, MediaConnection>>(new Map())
  const joinedRef = useRef<boolean>(false)
  const modeRef = useRef<LocalMediaMode>('none')
  const rosterRef = useRef<Map<string, RemotePeer>>(new Map())
  const myNameRef = useRef<string>(myName)
  const localStreamRef = useRef<MediaStream | null>(localMedia.stream)
  const hostPeerIdRef = useRef<string | null>(hostPeerId)
  // Per-join token. Any async work that captures this value can compare it
  // to the current ref to detect a stale join attempt.
  const joinAttemptRef = useRef<symbol>(Symbol('initial'))
  // BroadcastChannel used to detect "this user is already in the same call
  // in another tab", which would create an audio feedback loop. We only
  // claim a channel when joining as a non-host (the host's peerId is
  // stable per-tab, so two host tabs can't be in the same room anyway).
  const tabChannelRef = useRef<BroadcastChannel | null>(null)

  useEffect(() => { joinedRef.current = joined }, [joined])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { rosterRef.current = roster }, [roster])
  useEffect(() => { myNameRef.current = myName }, [myName])
  useEffect(() => { localStreamRef.current = localMedia.stream }, [localMedia.stream])
  useEffect(() => { hostPeerIdRef.current = hostPeerId }, [hostPeerId])

  // ── Roster helpers ─────────────────────────────────────────────────────

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
  }, [])

  const closeMediaConn = useCallback((peerId: string): void => {
    const mc = mediaConnsRef.current.get(peerId)
    if (mc) {
      try { mc.close() } catch {}
      mediaConnsRef.current.delete(peerId)
    }
  }, [])

  // ── Soft cap (informational only) ──────────────────────────────────────

  const videoTileCount = Array.from(roster.values()).filter(p => p.mode === 'video').length
    + (mode === 'video' ? 1 : 0)
  const overSoftVideoCap = videoTileCount > SOFT_VIDEO_CAP

  // ── Outgoing: call a specific peer ─────────────────────────────────────

  const callPeerWithStream = useCallback((peerId: string, stream: MediaStream, myMode: CallMode): void => {
    if (!peer || peerId === myPeerId) return
    if (mediaConnsRef.current.has(peerId)) return
    try {
      const mc = peer.call(peerId, stream, { metadata: { kind: 'manifest-call', mode: myMode, name: myNameRef.current } })
      mediaConnsRef.current.set(peerId, mc)
      mc.on('stream', (remoteStream: MediaStream) => {
        upsertRoster(peerId, {
          stream: remoteStream,
          mode: streamHasLiveVideo(remoteStream) ? 'video' : 'audio',
        })
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })
      })
      mc.on('error', (err: unknown) => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })
        // Surface a scoped error so the user knows which peer dropped.
        // We don't override a more important global error if one already exists.
        const peerName = rosterRef.current.get(peerId)?.name || 'A peer'
        console.warn('media connection error', peerId, err)
        setCallError(prev => prev ?? {
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
  }, [peer, myPeerId, upsertRoster])

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
      try { mc.answer(localStreamRef.current) } catch { return }
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
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(mc.peer)
        upsertRoster(mc.peer, { stream: null })
      })
      mc.on('error', () => {
        mediaConnsRef.current.delete(mc.peer)
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
      // handler. eventemitter3's removeListener is the canonical method.
      try { (peer as unknown as { removeListener: (e: string, h: (...a: unknown[]) => void) => void }).removeListener('error', errHandler) } catch {}
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
    const videoTrack = stream.getVideoTracks()[0] || null
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
  // loses a video track. RTCPeerConnection sender lists are negotiated up-front
  // and peerjs has no public renegotiation API, so the honest fix is to close
  // the existing media connections and re-call everyone with the new stream.
  // The brief audio drop is the cost — alternative approaches that fudge the
  // black-frame state cause more confusion than they save.
  useEffect(() => {
    if (!joinedRef.current) return
    const newMode: LocalMediaMode = localMedia.mode
    if (newMode === 'none') return
    if (modeRef.current === newMode) return

    modeRef.current = newMode
    setMode(newMode)

    const stream = localMedia.stream
    if (!stream) return

    // Snapshot existing peer ids before tearing down (which mutates the map).
    const peerIds: string[] = Array.from(mediaConnsRef.current.keys())
    peerIds.forEach(pid => {
      const mc = mediaConnsRef.current.get(pid)
      if (mc) { try { mc.close() } catch {} }
      mediaConnsRef.current.delete(pid)
    })
    // Re-call every roster member with the new stream.
    rosterRef.current.forEach((_, pid) => {
      callPeerWithStream(pid, stream, newMode as CallMode)
    })
    // Tell everyone our new track-state so their tile renders the right kind.
    const payload = {
      type: 'call-track-state',
      micMuted: localMedia.micMuted,
      cameraOff: newMode !== 'video',
      mode: newMode,
      from: myPeerId,
    }
    if (isHost) broadcast?.(payload)
    else sendToHost?.(payload)
  }, [localMedia.mode, localMedia.stream, localMedia.micMuted, isHost, broadcast, sendToHost, myPeerId, callPeerWithStream])

  // ── Signaling message handler ──────────────────────────────────────────

  useEffect(() => {
    const handler = (fromPeerId: string, msg: Record<string, unknown>): void => {
      const type = msg.type as string

      // ── Host-side ─────────────────────────────────────────────────────

      if (type === 'call-join' && isHost) {
        const incomingMode = (msg.mode as CallMode) || 'audio'
        const incomingName = (msg.name as string) || 'Anon'
        upsertRoster(fromPeerId, { name: incomingName, mode: incomingMode, micMuted: false, cameraOff: incomingMode !== 'video' })
        // Send the joiner a roster snapshot (excluding themselves).
        const snapshot: Array<{ peerId: string; name: string; mode: CallMode }> = []
        rosterRef.current.forEach((p, pid) => {
          if (pid !== fromPeerId) snapshot.push({ peerId: pid, name: p.name, mode: p.mode })
        })
        if (joinedRef.current && myPeerId && modeRef.current !== 'none') {
          snapshot.push({ peerId: myPeerId, name: myNameRef.current, mode: modeRef.current as CallMode })
        }
        sendToPeer?.(fromPeerId, { type: 'call-roster', peers: snapshot, from: myPeerId })
        broadcast?.({ type: 'call-peer-joined', peerId: fromPeerId, name: incomingName, mode: incomingMode, from: myPeerId }, fromPeerId)
        return
      }

      if (type === 'call-leave' && isHost) {
        removeFromRoster(fromPeerId)
        closeMediaConn(fromPeerId)
        broadcast?.({ type: 'call-peer-left', peerId: fromPeerId, from: myPeerId }, fromPeerId)
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
        broadcast?.({ type: 'call-track-state', peerId: fromPeerId, micMuted, cameraOff, mode: nextMode, from: myPeerId }, fromPeerId)
        return
      }

      // ── Non-host: only trust messages claimed to be from the host ─────

      if (type === 'call-roster') {
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-roster from non-host', fromPeerId)
          return
        }
        const peers = (msg.peers as Array<{ peerId: string; name: string; mode: CallMode }>) || []
        peers.forEach(p => { upsertRoster(p.peerId, { name: p.name, mode: p.mode, cameraOff: p.mode !== 'video' }) })
        const stream = localStreamRef.current
        if (stream && modeRef.current !== 'none') {
          peers.forEach(p => callPeerWithStream(p.peerId, stream, modeRef.current as CallMode))
        }
        return
      }

      if (type === 'call-peer-joined') {
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-peer-joined from non-host', fromPeerId)
          return
        }
        const peerId = msg.peerId as string
        const name = (msg.name as string) || 'Anon'
        const joinedMode = (msg.mode as CallMode) || 'audio'
        if (peerId && peerId !== myPeerId) {
          upsertRoster(peerId, { name, mode: joinedMode, cameraOff: joinedMode !== 'video' })
        }
        return
      }

      if (type === 'call-peer-left') {
        if (fromPeerId !== hostPeerIdRef.current) {
          console.warn('Ignoring call-peer-left from non-host', fromPeerId)
          return
        }
        const peerId = msg.peerId as string
        if (peerId) {
          closeMediaConn(peerId)
          removeFromRoster(peerId)
        }
        return
      }

      if (type === 'call-track-state') {
        // Non-host receives a relayed update from the host. The host already
        // pinned peerId to the original sender, so we trust the embedded
        // peerId only when the relayer is the host. If we got it from
        // anyone else, fall back to fromPeerId (a peer reporting itself).
        const isFromHost = fromPeerId === hostPeerIdRef.current
        const peerId = isFromHost ? ((msg.peerId as string) || fromPeerId) : fromPeerId
        const reportedMode = (msg.mode as CallMode | undefined)
        const cameraOff = !!msg.cameraOff
        const nextMode: CallMode = reportedMode || (cameraOff ? 'audio' : 'video')
        upsertRoster(peerId, { micMuted: !!msg.micMuted, cameraOff, mode: nextMode })
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
          localMedia.stop()
          setMode('none')
        }
        return
      }
    }
    setMessageHandler(handler)
    return () => { setMessageHandler(null) }
  }, [isHost, myPeerId, sendToPeer, broadcast, setMessageHandler, upsertRoster, removeFromRoster, closeMediaConn, callPeerWithStream, localMedia])

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
    // this room. If anyone responds within 150ms, refuse the join. The
    // "room" is the host's peerId for non-hosts, which is shared across
    // tabs of the same browser. Hosts have a unique peerId per tab, so
    // they can't accidentally double-join the same room.
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
        await new Promise<void>(resolve => setTimeout(resolve, 150))
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
      const stream = await localMedia.start('audio')
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
        broadcast?.({ type: 'call-peer-joined', peerId: myPeerId, name: myNameRef.current, mode: 'audio', from: myPeerId })
      } else {
        sendToHost?.({ type: 'call-join', mode: 'audio', name: myNameRef.current, from: myPeerId })
      }

      setJoined(true)
      joinedRef.current = true
    } catch (e) {
      const err = classifyMediaError(e)
      setCallError(err)
      setEndReason(null) // join failure isn't a "call ended"
    } finally {
      if (joinAttemptRef.current === attempt) setJoining(false)
    }
  }, [peer, myPeerId, joining, localMedia, isHost, broadcast, sendToHost, callPeerWithStream])

  const leave = useCallback((reason: CallEndReason = 'user-left'): void => {
    // Invalidate any in-flight join attempt.
    joinAttemptRef.current = Symbol('leave')
    mediaConnsRef.current.forEach(mc => { try { mc.close() } catch {} })
    mediaConnsRef.current.clear()
    if (joinedRef.current) {
      if (isHost) {
        broadcast?.({ type: 'call-peer-left', peerId: myPeerId, from: myPeerId })
      } else {
        sendToHost?.({ type: 'call-leave', from: myPeerId })
      }
    }
    // Release the duplicate-tab claim so a sibling tab can take over.
    if (tabChannelRef.current) {
      try { tabChannelRef.current.close() } catch {}
      tabChannelRef.current = null
    }
    localMedia.stop()
    setMode('none')
    modeRef.current = 'none'
    setJoined(false)
    joinedRef.current = false
    setRoster(new Map())
    setActiveSpeakerId(null)
    setEndReason(reason)
  }, [isHost, broadcast, sendToHost, myPeerId, localMedia])

  const dismissEndReason = useCallback((): void => {
    setEndReason(null)
  }, [])

  // Clear both layers. localMedia.error gets reset by the next start()
  // attempt; until then dismissing only the call-layer copy is enough.
  const dismissError = useCallback((): void => {
    setCallError(null)
  }, [])

  // Merge call-layer + media-layer errors into one surface for the UI.
  // Call-layer errors take priority because they're usually about a
  // specific remote (more time-sensitive); media errors fall through.
  const error: CallError | null = callError
    ?? (localMedia.error ? liftLocalMediaError(localMedia.error) : null)

  // ── Track-state broadcast on local mic toggle ──────────────────────────

  const toggleMic = useCallback((): void => {
    localMedia.toggleMic()
  }, [localMedia])

  const toggleCamera = useCallback((): void => {
    void localMedia.toggleCamera()
  }, [localMedia])

  // Broadcast track state changes so remote peers can show mute icons.
  // Mode changes are handled by the mode-reconnect effect above (which also
  // emits a track-state message), so this effect handles mic-only changes.
  const prevMicMutedRef = useRef<boolean>(false)
  useEffect(() => {
    if (!joinedRef.current) return
    if (localMedia.micMuted === prevMicMutedRef.current) return
    prevMicMutedRef.current = localMedia.micMuted
    const payload = {
      type: 'call-track-state',
      micMuted: localMedia.micMuted,
      cameraOff: localMedia.mode !== 'video',
      mode: localMedia.mode === 'video' ? 'video' : 'audio',
      from: myPeerId,
    }
    if (isHost) broadcast?.(payload)
    else sendToHost?.(payload)
  }, [localMedia.micMuted, localMedia.mode, isHost, broadcast, sendToHost, myPeerId])

  // ── Cleanup on unmount or peer change ──────────────────────────────────
  // Receiver reconnects swap the Peer instance. When that happens the
  // existing media connections are on a dead peer — close them, wipe the
  // roster, and surface a connection-lost reason if we were mid-call.
  const localMediaStopRef = useRef<() => void>(localMedia.stop)
  useEffect(() => { localMediaStopRef.current = localMedia.stop }, [localMedia.stop])
  useEffect(() => {
    return () => {
      mediaConnsRef.current.forEach(mc => { try { mc.close() } catch {} })
      mediaConnsRef.current.clear()
      if (tabChannelRef.current) {
        try { tabChannelRef.current.close() } catch {}
        tabChannelRef.current = null
      }
      if (joinedRef.current) {
        try { localMediaStopRef.current() } catch {}
        setMode('none')
        modeRef.current = 'none'
        setJoined(false)
        joinedRef.current = false
        setRoster(new Map())
        setActiveSpeakerId(null)
        setEndReason('connection-lost')
      }
    }
  }, [peer])

  // ── Active speaker selection ───────────────────────────────────────────
  // CallPanel feeds us a peerId+level table; we apply hysteresis so the
  // spotlight doesn't ping-pong between near-equal speakers.
  const lastSpeakerSwitchRef = useRef<number>(0)
  const reportSpeakingLevels = useCallback((levels: Record<string, number>): void => {
    // Only consider levels above an audible threshold.
    let bestId: string | null = null
    let bestLevel = 0.12
    for (const [id, level] of Object.entries(levels)) {
      if (level > bestLevel) {
        bestLevel = level
        bestId = id
      }
    }
    const now = performance.now()
    setActiveSpeakerId(prev => {
      if (bestId === prev) return prev
      // Require 600ms of dominance before switching to avoid flicker.
      if (now - lastSpeakerSwitchRef.current < 600 && prev !== null) return prev
      lastSpeakerSwitchRef.current = now
      return bestId
    })
  }, [])

  return {
    joined,
    joining,
    mode,
    error,
    endReason,
    dismissEndReason,
    dismissError,
    remotePeers: Array.from(roster.values()),
    videoTileCount,
    overSoftVideoCap,
    softVideoCap: SOFT_VIDEO_CAP,
    activeSpeakerId,
    reportSpeakingLevels,
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
  }
}

export type UseCallReturn = ReturnType<typeof useCall>
