import { useState, useEffect, useRef, useCallback } from 'react'

export type LocalMediaMode = 'none' | 'audio' | 'video'
export type CameraFacing = 'user' | 'environment'

export interface LocalMediaState {
  stream: MediaStream | null
  mode: LocalMediaMode
  micMuted: boolean
  cameraOff: boolean
  error: string | null
}

// Thin wrapper around getUserMedia. The call lane doesn't touch this
// directly — it subscribes via useEffect on the returned `stream` identity
// so device swaps propagate to active RTCPeerConnections via replaceTrack.
export function useLocalMedia() {
  const [state, setState] = useState<LocalMediaState>({
    stream: null,
    mode: 'none',
    micMuted: false,
    cameraOff: false,
    error: null,
  })

  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([])
  const [selectedMicId, setSelectedMicId] = useState<string | null>(null)
  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null)
  const [cameraFacing, setCameraFacing] = useState<CameraFacing>('user')

  const streamRef = useRef<MediaStream | null>(null)
  const modeRef = useRef<LocalMediaMode>('none')
  // Refs mirror state so `start` can read the latest selection synchronously
  // without re-capturing closures — essential when `flipCamera` sets state and
  // then immediately restarts the stream in the same tick.
  const selectedMicIdRef = useRef<string | null>(null)
  const selectedCameraIdRef = useRef<string | null>(null)
  const cameraFacingRef = useRef<CameraFacing>('user')
  const flippingRef = useRef<boolean>(false)

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

  const start = useCallback(async (mode: 'audio' | 'video'): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getUserMedia) {
      const err = 'Microphone/camera access is not supported in this browser.'
      setState(s => ({ ...s, error: err }))
      throw new Error(err)
    }
    stopStream()
    const micId = selectedMicIdRef.current
    const camId = selectedCameraIdRef.current
    const facing = cameraFacingRef.current
    const audio: MediaTrackConstraints = micId
      ? { deviceId: { exact: micId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    // Let the browser pick a sensible resolution via ideal hints. When the
    // user hasn't explicitly chosen a camera we also pass `facingMode` so the
    // front/back flip toggle can work on mobile.
    const videoDims: MediaTrackConstraints = { width: { ideal: 1280 }, height: { ideal: 720 } }
    const video: MediaTrackConstraints | false = mode === 'video'
      ? (camId
          ? { deviceId: { exact: camId }, ...videoDims }
          : { facingMode: facing, ...videoDims })
      : false
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio, video })
      streamRef.current = stream
      modeRef.current = mode
      // After first successful getUserMedia browsers reveal device labels,
      // so refreshing here gets the user friendly names for the selectors.
      refreshDevices()
      setState({ stream, mode, micMuted: false, cameraOff: false, error: null })
      return stream
    } catch (e) {
      const err = e instanceof Error ? e.message : 'Failed to access media devices'
      setState(s => ({ ...s, error: err }))
      throw e
    }
  }, [stopStream, refreshDevices])

  const stop = useCallback((): void => {
    stopStream()
    modeRef.current = 'none'
    setState({ stream: null, mode: 'none', micMuted: false, cameraOff: false, error: null })
  }, [stopStream])

  // State is the source of truth for mute/camera; we flip it and then
  // align track.enabled to match. Reading track.enabled is fragile after
  // device swaps or when the track has been restarted between clicks.
  const toggleMic = useCallback((): void => {
    setState(prev => {
      const s = streamRef.current
      if (!s) return prev
      const tracks = s.getAudioTracks()
      if (!tracks.length) return prev
      const nextMuted = !prev.micMuted
      tracks.forEach(t => { t.enabled = !nextMuted })
      return { ...prev, micMuted: nextMuted }
    })
  }, [])

  const toggleCamera = useCallback((): void => {
    setState(prev => {
      const s = streamRef.current
      if (!s) return prev
      const tracks = s.getVideoTracks()
      if (!tracks.length) return prev
      const nextOff = !prev.cameraOff
      tracks.forEach(t => { t.enabled = !nextOff })
      return { ...prev, cameraOff: nextOff }
    })
  }, [])

  const selectMic = useCallback(async (deviceId: string): Promise<void> => {
    setSelectedMicId(deviceId)
    selectedMicIdRef.current = deviceId
    if (streamRef.current && modeRef.current !== 'none') {
      // Restart with the new device so existing call publishers pick it up
      // via the track-change effect in useCall.
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

  // Flip between front ('user') and back ('environment') cameras. Clears any
  // explicit deviceId selection so the browser picks whichever device best
  // matches the requested facingMode.
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
      // Silent — we may be on a device that ignores facingMode, or permission
      // was just revoked. State stays consistent because start() sets an error.
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
