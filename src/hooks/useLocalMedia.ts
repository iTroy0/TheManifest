import { useState, useEffect, useRef, useCallback } from 'react'

export type LocalMediaMode = 'none' | 'audio' | 'video'
export type CameraFacing = 'user' | 'environment'

// Structured error so callers can react without parsing strings. `code`
// names a recognised failure mode; `message` is the human-readable detail.
export interface MediaError {
  code: 'unsupported' | 'permission-denied' | 'device-not-found' | 'in-use' | 'overconstrained' | 'unknown'
  message: string
}

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
    setState(s => ({ ...s, starting: true, error: null }))
    try {
      // Acquire FIRST, then stop the old stream. Doing it the other way
      // around means a failed camera-on (no camera plugged in, permission
      // revoked, device in use, …) leaves the user with no audio stream
      // either, silently nuking the call. acquire-then-swap keeps the call
      // alive on failure: state.stream is untouched and the error surfaces.
      const stream = await acquire(mode)
      stopStream()
      streamRef.current = stream
      modeRef.current = mode
      // Re-apply user mute preference to the fresh audio track so a restart
      // doesn't silently un-mute someone.
      const muted = micMutedPrefRef.current
      if (muted) stream.getAudioTracks().forEach(t => { t.enabled = false })
      // Watch every track for an `ended` event. If the OS yanks a device
      // (USB headset unplugged, permission revoked from the address bar,
      // camera taken over by another app), the corresponding track ends
      // without throwing. Surface this as a structured error and trigger
      // the listener so useCall can react.
      stream.getTracks().forEach(track => {
        track.addEventListener('ended', () => {
          // Ignore endings that happen because *we* swapped streams.
          if (streamRef.current !== stream) return
          const code: MediaError['code'] = track.kind === 'audio' ? 'in-use' : 'device-not-found'
          const message = track.kind === 'audio'
            ? 'Microphone disconnected. Check your device and try again.'
            : 'Camera disconnected. Reconnect it or turn the camera off.'
          setState(s => ({ ...s, error: { code, message } }))
        })
      })
      // After first successful getUserMedia browsers reveal device labels,
      // so refreshing here surfaces the user-friendly names for the selectors.
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
      const err = classify(e)
      setState(s => ({ ...s, starting: false, error: err }))
      throw e
    }
  }, [stopStream, refreshDevices, acquire])

  const stop = useCallback((): void => {
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

  // Cleanup on unmount
  useEffect(() => {
    return () => { stopStream() }
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
