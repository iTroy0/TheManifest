import { useState, useEffect, useRef, useCallback } from 'react'
import Peer, { MediaConnection } from 'peerjs'
import { UseLocalMediaReturn, LocalMediaMode } from './useLocalMedia'

// ── Types ────────────────────────────────────────────────────────────────

export type CallMode = 'audio' | 'video'

export interface RemotePeer {
  peerId: string
  name: string
  mode: CallMode
  stream: MediaStream | null
  micMuted: boolean
  cameraOff: boolean
}

export interface UseCallOptions {
  peer: InstanceType<typeof Peer> | null
  myPeerId: string | null
  myName: string
  isHost: boolean
  hostPeerId: string | null
  // For hosts: current wire-level recipients. Used to scope broadcasts.
  participants: Array<{ peerId: string; name: string }>
  // Signaling plumbing. One of sendToHost / (sendToPeer + broadcast) will
  // be usable depending on role. Both roles share setMessageHandler.
  sendToHost?: (msg: Record<string, unknown>) => void
  sendToPeer?: (peerId: string, msg: Record<string, unknown>) => void
  broadcast?: (msg: Record<string, unknown>, exceptPeerId?: string) => void
  setMessageHandler: (h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null) => void
  localMedia: UseLocalMediaReturn
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useCall(options: UseCallOptions) {
  const {
    peer, myPeerId, myName, isHost,
    sendToHost, sendToPeer, broadcast, setMessageHandler,
    localMedia,
  } = options

  const [joined, setJoined] = useState<boolean>(false)
  const [joining, setJoining] = useState<boolean>(false)
  const [mode, setMode] = useState<LocalMediaMode>('none')
  const [error, setError] = useState<string | null>(null)
  const [roster, setRoster] = useState<Map<string, RemotePeer>>(new Map())

  const mediaConnsRef = useRef<Map<string, MediaConnection>>(new Map())
  const joinedRef = useRef<boolean>(false)
  const modeRef = useRef<LocalMediaMode>('none')
  const rosterRef = useRef<Map<string, RemotePeer>>(new Map())
  const myNameRef = useRef<string>(myName)
  const localStreamRef = useRef<MediaStream | null>(localMedia.stream)

  useEffect(() => { joinedRef.current = joined }, [joined])
  useEffect(() => { modeRef.current = mode }, [mode])
  useEffect(() => { rosterRef.current = roster }, [roster])
  useEffect(() => { myNameRef.current = myName }, [myName])
  useEffect(() => { localStreamRef.current = localMedia.stream }, [localMedia.stream])

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
        cameraOff: false,
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

  // ── Video slot enforcement ─────────────────────────────────────────────

  const videoSlotsUsed = Array.from(roster.values()).filter(p => p.mode === 'video').length
    + (mode === 'video' ? 1 : 0)
  const canJoinVideo = videoSlotsUsed < 2 || mode === 'video'

  // ── Outgoing: call a specific peer (used when we join with an existing roster) ──

  const callPeerWithStream = useCallback((peerId: string, stream: MediaStream, myMode: CallMode): void => {
    if (!peer || peerId === myPeerId) return
    if (mediaConnsRef.current.has(peerId)) return
    try {
      const mc = peer.call(peerId, stream, { metadata: { kind: 'manifest-call', mode: myMode, name: myNameRef.current } })
      mediaConnsRef.current.set(peerId, mc)
      mc.on('stream', (remoteStream: MediaStream) => {
        upsertRoster(peerId, { stream: remoteStream })
      })
      mc.on('close', () => {
        mediaConnsRef.current.delete(peerId)
        upsertRoster(peerId, { stream: null })
      })
      mc.on('error', () => {
        mediaConnsRef.current.delete(peerId)
      })
    } catch (e) {
      console.warn('peer.call failed for', peerId, e)
    }
  }, [peer, myPeerId, upsertRoster])

  // ── Incoming: answer a media call while we're joined ───────────────────

  useEffect(() => {
    if (!peer) return
    const handler = (mc: MediaConnection): void => {
      const meta = (mc.metadata || {}) as { kind?: string; mode?: CallMode; name?: string }
      if (meta.kind !== 'manifest-call') {
        // Not our call — ignore (some other future feature could reuse peer.call)
        try { mc.close() } catch {}
        return
      }
      if (!joinedRef.current || !localStreamRef.current) {
        // Not in a call — reject
        try { mc.close() } catch {}
        return
      }
      // Close any existing connection to this peer before accepting a new one
      // (handles simultaneous dial / reconnect races without leaking).
      const existing = mediaConnsRef.current.get(mc.peer)
      if (existing && existing !== mc) {
        try { existing.close() } catch {}
        mediaConnsRef.current.delete(mc.peer)
      }
      try { mc.answer(localStreamRef.current) } catch { return }
      mediaConnsRef.current.set(mc.peer, mc)

      // Ensure a roster entry exists (name may be filled in later by signaling)
      upsertRoster(mc.peer, { name: meta.name || rosterRef.current.get(mc.peer)?.name || 'Anon', mode: meta.mode || 'audio' })

      mc.on('stream', (remoteStream: MediaStream) => {
        upsertRoster(mc.peer, { stream: remoteStream })
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
    return () => {
      try { peer.off('call', handler) } catch {}
    }
  }, [peer, upsertRoster])

  // ── Track hot-swap on device changes ───────────────────────────────────
  // When useLocalMedia restarts (device change), the new stream lands on
  // localMedia.stream. Replace the outgoing tracks on every active media
  // connection so receivers immediately hear/see the new source.
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

  // ── Signaling message handler ──────────────────────────────────────────

  useEffect(() => {
    const handler = (fromPeerId: string, msg: Record<string, unknown>): void => {
      const type = msg.type as string

      if (type === 'call-join' && isHost) {
        // A receiver wants to join. Validate and update roster.
        const incomingMode = (msg.mode as CallMode) || 'audio'
        const incomingName = (msg.name as string) || 'Anon'
        // Enforce video cap including host itself.
        const currentVideoCount = Array.from(rosterRef.current.values()).filter(p => p.mode === 'video').length
          + (modeRef.current === 'video' ? 1 : 0)
        if (incomingMode === 'video' && currentVideoCount >= 2) {
          sendToPeer?.(fromPeerId, { type: 'call-rejected', reason: 'video-full', from: myPeerId })
          return
        }
        upsertRoster(fromPeerId, { name: incomingName, mode: incomingMode, micMuted: false, cameraOff: false })
        // Send the joiner a snapshot of the current roster (excluding themselves).
        const snapshot: Array<{ peerId: string; name: string; mode: CallMode }> = []
        rosterRef.current.forEach((p, pid) => {
          if (pid !== fromPeerId) snapshot.push({ peerId: pid, name: p.name, mode: p.mode })
        })
        // Include the host itself in the roster snapshot if host is joined.
        if (joinedRef.current && myPeerId && modeRef.current !== 'none') {
          snapshot.push({ peerId: myPeerId, name: myNameRef.current, mode: modeRef.current as CallMode })
        }
        sendToPeer?.(fromPeerId, { type: 'call-roster', peers: snapshot, from: myPeerId })
        // Tell everyone else that this peer has joined.
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
        // Relay and update local view.
        const micMuted = !!msg.micMuted
        const cameraOff = !!msg.cameraOff
        upsertRoster(fromPeerId, { micMuted, cameraOff })
        broadcast?.({ type: 'call-track-state', peerId: fromPeerId, micMuted, cameraOff, from: myPeerId }, fromPeerId)
        return
      }

      // ── Non-host handling ─────────────────────────────────────────────

      if (type === 'call-roster') {
        const peers = (msg.peers as Array<{ peerId: string; name: string; mode: CallMode }>) || []
        peers.forEach(p => { upsertRoster(p.peerId, { name: p.name, mode: p.mode }) })
        // Now initiate calls to everyone in the roster.
        const stream = localStreamRef.current
        if (stream && modeRef.current !== 'none') {
          peers.forEach(p => callPeerWithStream(p.peerId, stream, modeRef.current as CallMode))
        }
        return
      }

      if (type === 'call-peer-joined') {
        const peerId = msg.peerId as string
        const name = (msg.name as string) || 'Anon'
        const joinedMode = (msg.mode as CallMode) || 'audio'
        if (peerId && peerId !== myPeerId) {
          upsertRoster(peerId, { name, mode: joinedMode })
        }
        return
      }

      if (type === 'call-peer-left') {
        const peerId = msg.peerId as string
        if (peerId) {
          closeMediaConn(peerId)
          removeFromRoster(peerId)
        }
        return
      }

      if (type === 'call-track-state') {
        const peerId = msg.peerId as string || fromPeerId
        upsertRoster(peerId, { micMuted: !!msg.micMuted, cameraOff: !!msg.cameraOff })
        return
      }

      if (type === 'call-rejected') {
        setError(msg.reason === 'video-full' ? 'Video call is full (max 2 participants).' : 'Call join rejected.')
        setJoining(false)
        // Stop local media if we started it
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

  const join = useCallback(async (wantMode: CallMode): Promise<void> => {
    if (joinedRef.current || joining) return
    if (!peer || !myPeerId) {
      setError('Not connected yet — try again in a moment.')
      return
    }
    if (wantMode === 'video' && !canJoinVideo) {
      setError('Video call is full (max 2 participants).')
      return
    }
    setJoining(true)
    setError(null)
    try {
      const stream = await localMedia.start(wantMode)
      setMode(wantMode)
      modeRef.current = wantMode
      localStreamRef.current = stream

      if (isHost) {
        // Host joins by adding itself to its own roster and calling every
        // currently-joined remote peer, then broadcasting its arrival.
        const existingPeerIds: string[] = Array.from(rosterRef.current.keys())
        existingPeerIds.forEach(pid => callPeerWithStream(pid, stream, wantMode))
        broadcast?.({ type: 'call-peer-joined', peerId: myPeerId, name: myNameRef.current, mode: wantMode, from: myPeerId })
      } else {
        // Non-host asks the host to add them. The host replies with a
        // roster snapshot, which triggers outgoing calls in the handler above.
        sendToHost?.({ type: 'call-join', mode: wantMode, name: myNameRef.current, from: myPeerId })
      }

      setJoined(true)
      joinedRef.current = true
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to join call'
      setError(msg)
    } finally {
      setJoining(false)
    }
  }, [peer, myPeerId, joining, canJoinVideo, localMedia, isHost, broadcast, sendToHost, callPeerWithStream])

  const joinAudio = useCallback(() => join('audio'), [join])
  const joinVideo = useCallback(() => join('video'), [join])

  const leave = useCallback((): void => {
    // Close all media connections
    mediaConnsRef.current.forEach(mc => { try { mc.close() } catch {} })
    mediaConnsRef.current.clear()
    // Signal departure
    if (isHost) {
      broadcast?.({ type: 'call-peer-left', peerId: myPeerId, from: myPeerId })
    } else {
      sendToHost?.({ type: 'call-leave', from: myPeerId })
    }
    // Stop local media
    localMedia.stop()
    setMode('none')
    modeRef.current = 'none'
    setJoined(false)
    joinedRef.current = false
    setError(null)
    // Clear remote roster (we're leaving — tiles should disappear)
    setRoster(new Map())
  }, [isHost, broadcast, sendToHost, myPeerId, localMedia])

  // ── Track-state broadcast on mic/cam toggle ────────────────────────────

  const toggleMic = useCallback((): void => {
    localMedia.toggleMic()
  }, [localMedia])

  const toggleCamera = useCallback((): void => {
    localMedia.toggleCamera()
  }, [localMedia])

  // Broadcast track state changes so remote peers can show mute icons.
  const prevMicMutedRef = useRef<boolean>(false)
  const prevCameraOffRef = useRef<boolean>(false)
  useEffect(() => {
    if (!joinedRef.current) return
    if (localMedia.micMuted === prevMicMutedRef.current && localMedia.cameraOff === prevCameraOffRef.current) return
    prevMicMutedRef.current = localMedia.micMuted
    prevCameraOffRef.current = localMedia.cameraOff
    const payload = { type: 'call-track-state', micMuted: localMedia.micMuted, cameraOff: localMedia.cameraOff, from: myPeerId }
    if (isHost) {
      broadcast?.(payload)
    } else {
      sendToHost?.(payload)
    }
  }, [localMedia.micMuted, localMedia.cameraOff, isHost, broadcast, sendToHost, myPeerId])

  // ── Cleanup on unmount or peer change ──────────────────────────────────
  // Receiver reconnects swap the Peer instance. When that happens the existing
  // media connections are on a dead peer — close them and wipe the roster so
  // the user sees a clean "not joined" state and can rejoin fresh.
  // Intentionally only depends on `peer` to avoid re-running on every render;
  // localMedia.stop is captured via ref to stay up-to-date.
  const localMediaStopRef = useRef<() => void>(localMedia.stop)
  useEffect(() => { localMediaStopRef.current = localMedia.stop }, [localMedia.stop])
  useEffect(() => {
    return () => {
      mediaConnsRef.current.forEach(mc => { try { mc.close() } catch {} })
      mediaConnsRef.current.clear()
      if (joinedRef.current) {
        try { localMediaStopRef.current() } catch {}
        setMode('none')
        modeRef.current = 'none'
        setJoined(false)
        joinedRef.current = false
        setRoster(new Map())
      }
    }
  }, [peer])

  return {
    joined,
    joining,
    mode,
    error,
    remotePeers: Array.from(roster.values()),
    videoSlotsUsed,
    canJoinVideo,
    joinAudio,
    joinVideo,
    leave,
    toggleMic,
    toggleCamera,
    micMuted: localMedia.micMuted,
    cameraOff: localMedia.cameraOff,
    // Device plumbing for the controls bar
    micDevices: localMedia.micDevices,
    cameraDevices: localMedia.cameraDevices,
    selectedMicId: localMedia.selectedMicId,
    selectedCameraId: localMedia.selectedCameraId,
    selectMic: localMedia.selectMic,
    selectCamera: localMedia.selectCamera,
    // For rendering local preview
    localStream: localMedia.stream,
  }
}

export type UseCallReturn = ReturnType<typeof useCall>
