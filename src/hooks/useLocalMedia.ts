import { useState, useEffect, useRef, useCallback } from 'react'

export type LocalMediaMode = 'none' | 'audio' | 'video'
export type CameraFacing = 'user' | 'environment'

// Structured error so callers can react without parsing strings. `code`
// names a recognised failure mode; `message` is the human-readable detail.
export interface MediaError {
  code: 'unsupported' | 'permission-denied' | 'device-not-found' | 'in-use' | 'overconstrained' | 'timeout' | 'unknown'
  message: string
}

// How long we wait for getUserMedia before assuming the user ignored the
// permission prompt or the browser hung. After this we reject with a
// TimeoutError and the UI can offer a retry.
const START_WATCHDOG_MS = 30_000

export interface LocalMediaState {
  stream: MediaStream | null
  mode: LocalMediaMode
  micMuted: boolean
  cameraOff: boolean
  starting: boolean
  error: MediaError | null
}

function classify(e: unknown): MediaError {
  const name = (e as { name?: string })?.name || ''
  const msg = (e as { message?: string })?.message || 'Failed to access media devices'
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return { code: 'permission-denied', message: 'Permission denied. Allow microphone/camera access in your browser settings.' }
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return { code: 'device-not-found', message: 'No microphone or camera was found on this device.' }
    case 'NotReadableError':
    case 'TrackStartError':
      return { code: 'in-use', message: 'Another app is using your microphone or camera. Close it and try again.' }
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return { code: 'overconstrained', message: 'The selected device is unavailable.' }
    case 'TimeoutError':
      return { code: 'timeout', message: msg || "Timed out waiting for media access. Check your browser's permission prompt and try again." }
    default:
      return { code: 'unknown', message: msg }
  }
}

// Thin wrapper around getUserMedia. The call lane subscribes to the
// returned `stream` identity so device swaps propagate to active
// RTCPeerConnections via replaceTrack.
//
// Camera toggling works by restarting the stream with/without a video
// track — there is no "publish a frozen black frame" trick. This means
// flipping the camera off truly releases the camera (the green LED goes
// out), which matches user intuition for a privacy-first app.
export function useLocalMedia() {
  const [state, setState] = useState<LocalMediaState>({
    stream: null,
    mode: 'none',
    micMuted: false,
    cameraOff: true,
    starting: false,
    error: null,
  })

  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null)
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null)
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>('user')

  const streamRef = useRef<MediaStream | null>(null)
  const modeRef = useRef<LocalMediaMode>('none')
  // Refs mirror state so `start` reads the latest selection synchronously
  // without re-capturing closures.
  const selectedMicIdRef = useRef<string | null>(null)
  const selectedCameraIdRef = useRef<string | null>(null)
  const cameraFacingRef = useRef<CameraFacing>('user')
  const flippingRef = useRef<boolean>(false)
  const togglingCameraRef = useRef<boolean>(false)
  // Persists user mute preference across stream restarts.
  const micMutedPrefRef = useRef<boolean>(false)
  // Tracks whether the hook is still mounted. A start() call that awaits
  // getUserMedia can outlive the component; when it resolves after unmount
  // we must stop the orphan tracks instead of binding them to no-one.
  const mountedRef = useRef<boolean>(true)
  // Per-start token. Every start() bumps this. Late resolvers compare their
  // captured token against the current one; a mismatch means they were
  // superseded (by another start(), a stop(), an unmount, or the watchdog)
  // and must stop their newly-acquired stream instead of assigning it.
  const startTokenRef = useRef<symbol>(Symbol('initial'))

  useEffect(() => { selectedMicIdRef.current = selectedMicId }, [selectedMicId])
  useEffect(() => { selectedCameraIdRef.current = selectedCameraId }, [selectedCameraId])
  useEffect(() => { cameraFacingRef.current = cameraFacing }, [cameraFacing])

  const refreshDevices = useCallback(async (): Promise<void> => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      setMicDevices(devices.filter(d => d.kind === 'audioinput'))
      setCameraDevices(devices.filter(d => d.kind === 'videoinput'))
    } catch {}
  }, [])

  useEffect(() => {
    refreshDevices()
    if (!navigator.mediaDevices?.addEventListener) return
    const handler = (): void => { refreshDevices() }
    navigator.mediaDevices.addEventListener('devicechange', handler)
    return () => {
      try { navigator.mediaDevices.removeEventListener('devicechange', handler) } catch {}
    }
  }, [refreshDevices])

  const stopStream = useCallback((): void => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => { try { t.stop() } catch {} })
      streamRef.current = null
    }
  }, [])

  // Internal: acquire a stream for `mode` honouring the current device
  // selection. On OverconstrainedError, retry without the exact deviceId
  // so an unplugged-then-replaced device doesn't permanently break the lane.
  const acquire = useCallback(async (mode: 'audio' | 'video'): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw Object.assign(new Error('Microphone/camera access is not supported in this browser.'), { name: 'NotSupportedError' })
    }
    const micId = selectedMicIdRef.current
    const camId = selectedCameraIdRef.current
    const facing = cameraFacingRef.current
    const baseAudio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    const audioExact: MediaTrackConstraints = micId
      ? { deviceId: { exact: micId }, ...baseAudio }
      : baseAudio
    const videoDims: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } }
    const videoExact: MediaTrackConstraints | false = mode === 'video'
      ? (camId
          ? { deviceId: { exact: camId }, ...videoDims }
          : { facingMode: facing, ...videoDims })
      : false
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: audioExact, video: videoExact })
    } catch (e) {
      const name = (e as { name?: string })?.name || ''
      // Stale deviceId / disappeared peripheral: drop the exact constraint
      // and try again. We also clear the cached selection so the UI doesn't
      // keep targeting a phantom device.
      if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
        if (micId) { selectedMicIdRef.current = null; setSelectedMicId(null) }
        if (camId && mode === 'video') { selectedCameraIdRef.current = null; setSelectedCameraId(null) }
        const audioFallback: MediaTrackConstraints = baseAudio
        const videoFallback: MediaTrackConstraints | false = mode === 'video' ? { facingMode: facing, ...videoDims } : false
        return await navigator.mediaDevices.getUserMedia({ audio: audioFallback, video: videoFallback })
      }
      throw e
    }
  }, [])

  const start = useCallback(async (mode: 'audio' | 'video'): Promise<MediaStream> => {
    // Every start() owns a symbol token. Late resolvers compare their
    // captured token to the ref; if a newer start(), a stop(), an unmount,
    // or the watchdog has invalidated it, the orphan stream is stopped and
    // an AbortError is thrown.
    const myToken = Symbol('start')
    startTokenRef.current = myToken
    if (mountedRef.current) setState(s => ({ ...s, starting: true, error: null }))

    // Watchdog: getUserMedia can hang indefinitely if the user ignores the
    // permission prompt. After START_WATCHDOG_MS we reject the race with a
    // TimeoutError AND invalidate the token so a late acquire() resolve is
    // treated as an orphan.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_, reject) => {
      watchdogTimer = setTimeout(() => {
        if (startTokenRef.current === myToken) {
          startTokenRef.current = Symbol('watchdog')
        }
        reject(Object.assign(
          new Error("Timed out waiting for media access. Check your browser's permission prompt and try again."),
          { name: 'TimeoutError' },
        ))
      }, START_WATCHDOG_MS)
    })

    // Self-guarding acquire: when it resolves, check all abort conditions
    // (unmount, supersede, watchdog). If any apply, stop the fresh tracks
    // and throw AbortError so no state is mutated.
    const acquirePromise = acquire(mode).then(
      (stream): MediaStream => {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
        if (!mountedRef.current || startTokenRef.current !== myToken) {
          try { stream.getTracks().forEach(t => { try { t.stop() } catch {} }) } catch {}
          throw Object.assign(new Error('start aborted'), { name: 'AbortError' })
        }
        return stream
      },
      (e: unknown) => {
        if (watchdogTimer) { clearTimeout(watchdogTimer); watchdogTimer = null }
        throw e
      },
    )

    try {
      const stream = await Promise.race([acquirePromise, watchdog])
      // Double-check after await — paranoia in case React synchronously
      // invalidated mountedRef between the .then and here (strict mode).
      if (!mountedRef.current || startTokenRef.current !== myToken) {
        try { stream.getTracks().forEach(t => { try { t.stop() } catch {} }) } catch {}
        throw Object.assign(new Error('start aborted'), { name: 'AbortError' })
      }

      // Swap in the new stream. Only NOW do we stop the previous one — the
      // acquire-then-swap invariant guarantees a failed acquire leaves the
      // existing call untouched.
      stopStream()
      streamRef.current = stream
      modeRef.current = mode

      // Re-apply user mute preference so a restart doesn't silently un-mute.
      const muted = micMutedPrefRef.current
      if (muted) stream.getAudioTracks().forEach(t => { t.enabled = false })

      // Track-ended recovery: if the OS yanks a device mid-call (USB
      // headset unplugged, permission revoked, camera grabbed by another
      // app), the corresponding track fires `ended`. We distinguish:
      //   - Video track dies, audio still alive → remove the video track,
      //     flip mode to 'audio'. useCall's mode-reconnect effect will
      //     re-establish the media connections as audio-only, keeping the
      //     call going instead of silently tearing down.
      //   - Audio track dies (or the last live track dies) → stop the
      //     whole stream and flip to 'none'. useCall's mode-watcher will
      //     fire a leave('error').
      stream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          // Ignore endings that happen because *we* swapped streams.
          if (streamRef.current !== stream) return
          if (!mountedRef.current) return

          if (track.kind === 'video') {
            const audioAlive = stream.getAudioTracks().some(t => t.readyState !== 'ended')
            if (audioAlive) {
              try { stream.removeTrack(track) } catch {}
              modeRef.current = 'audio'
              setState(s => ({
                ...s,
                mode: 'audio',
                cameraOff: true,
                error: { code: 'device-not-found', message: 'Camera disconnected. You can keep talking; the camera is off.' },
              }))
              return
            }
          }
          // Audio track died, or video died with no audio backup.
          try { stream.getTracks().forEach(t => { try { t.stop() } catch {} }) } catch {}
          streamRef.current = null
          modeRef.current = 'none'
          const isAudio = track.kind === 'audio'
          setState({
            stream: null,
            mode: 'none',
            micMuted: micMutedPrefRef.current,
            cameraOff: true,
            starting: false,
            error: {
              code: isAudio ? 'in-use' : 'device-not-found',
              message: isAudio
                ? 'Microphone disconnected. The call ended.'
                : 'Camera disconnected.',
            },
          })
        })
      })

      // After the first successful getUserMedia, browsers reveal device
      // labels — refresh so the selector dropdowns show friendly names.
      refreshDevices()
      setState({
        stream,
        mode,
        micMuted: muted,
        cameraOff: mode !== 'video',
        starting: false,
        error: null,
      })
      return stream
    } catch (e) {
      const name = (e as Error).name
      // AbortError: superseded by another start(), stop(), unmount. Silent
      // — the winning path (or unmount cleanup) owns state.
      if (name === 'AbortError') throw e
      // Real error (including TimeoutError). Only write state if the hook
      // is still mounted; otherwise nobody is listening.
      if (mountedRef.current) {
        const err = classify(e)
        setState(s => ({ ...s, starting: false, error: err }))
      }
      throw e
    }
  }, [stopStream, refreshDevices, acquire])

  const stop = useCallback((): void => {
    // Bump the start-token so an in-flight start() (awaiting a permission
    // prompt, say) aborts and stops its orphan stream on resolve.
    startTokenRef.current = Symbol('stop')
    stopStream()
    modeRef.current = 'none'
    setState({ stream: null, mode: 'none', micMuted: micMutedPrefRef.current, cameraOff: true, starting: false, error: null })
  }, [stopStream])

  // State is the source of truth for mute. We flip it and align track.enabled
  // to match. Reading track.enabled is fragile after device swaps.
  const toggleMic = useCallback((): void => {
    setState(prev => {
      const s = streamRef.current
      const nextMuted = !prev.micMuted
      micMutedPrefRef.current = nextMuted
      if (s) {
        const tracks = s.getAudioTracks()
        tracks.forEach(t => { t.enabled = !nextMuted })
      }
      return { ...prev, micMuted: nextMuted }
    })
  }, [])

  // Toggling the camera restarts the local stream with a different mode.
  // The existing useCall track-replacement effect handles propagation when
  // the kind matches; useCall also reacts to mode changes by closing and
  // re-opening MediaConnections so a remote can render the new tracks.
  const toggleCamera = useCallback(async (): Promise<void> => {
    if (togglingCameraRef.current) return
    if (modeRef.current === 'none') return
    togglingCameraRef.current = true
    try {
      if (modeRef.current === 'audio') {
        await start('video')
      } else if (modeRef.current === 'video') {
        await start('audio')
      }
    } catch {
      // start() already populated state.error
    } finally {
      togglingCameraRef.current = false
    }
  }, [start])

  const selectMic = useCallback(async (deviceId: string): Promise<void> => {
    setSelectedMicId(deviceId)
    selectedMicIdRef.current = deviceId
    if (streamRef.current && modeRef.current !== 'none') {
      try { await start(modeRef.current === 'video' ? 'video' : 'audio') } catch {}
    }
  }, [start])

  const selectCamera = useCallback(async (deviceId: string): Promise<void> => {
    setSelectedCameraId(deviceId)
    selectedCameraIdRef.current = deviceId
    if (streamRef.current && modeRef.current === 'video') {
      try { await start('video') } catch {}
    }
  }, [start])

  // Flip between front ('user') and back ('environment') cameras. Clears
  // any explicit deviceId selection so the browser picks whichever device
  // best matches the requested facingMode.
  const flipCamera = useCallback(async (): Promise<void> => {
    if (modeRef.current !== 'video') return
    if (flippingRef.current) return
    flippingRef.current = true
    try {
      const next: CameraFacing = cameraFacingRef.current === 'user' ? 'environment' : 'user'
      cameraFacingRef.current = next
      setCameraFacing(next)
      setSelectedCameraId(null)
      selectedCameraIdRef.current = null
      await start('video')
    } catch {
      // Silent — start() already set state.error.
    } finally {
      flippingRef.current = false
    }
  }, [start])

  // Cleanup on unmount. Flipping mountedRef first means any in-flight
  // start() awaiting getUserMedia will abort when acquire() resolves
  // (it checks mountedRef + startTokenRef and stops the orphan stream
  // instead of binding it to a dead component).
  useEffect(() => {
    return () => {
      mountedRef.current = false
      startTokenRef.current = Symbol('unmount')
      stopStream()
    }
  }, [stopStream])

  return {
    ...state,
    micDevices,
    cameraDevices,
    selectedMicId,
    selectedCameraId,
    cameraFacing,
    start,
    stop,
    toggleMic,
    toggleCamera,
    selectMic,
    selectCamera,
    flipCamera,
  }
}

export type UseLocalMediaReturn = ReturnType<typeof useLocalMedia>
