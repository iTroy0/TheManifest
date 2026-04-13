import { useState, useEffect, useRef, useCallback } from 'react'

export type LocalMediaMode = 'none' | 'audio' | 'video'

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

  const streamRef = useRef<MediaStream | null>(null)
  const modeRef = useRef<LocalMediaMode>('none')

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
    const audio: MediaTrackConstraints = selectedMicId
      ? { deviceId: { exact: selectedMicId }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    // Portrait mobile: request portrait-aspect capture. Browsers honour this
    // as a hint; on most phones it yields a 720×1280 stream so the receiver
    // actually sees a portrait frame instead of a letterboxed landscape one.
    const portraitCapture: boolean = typeof window !== 'undefined'
      && window.innerWidth < 720
      && window.innerHeight > window.innerWidth
    const videoDims: MediaTrackConstraints = portraitCapture
      ? { width: { ideal: 720 }, height: { ideal: 1280 } }
      : { width: { ideal: 1280 }, height: { ideal: 720 } }
    const video: MediaTrackConstraints | false = mode === 'video'
      ? (selectedCameraId
          ? { deviceId: { exact: selectedCameraId }, ...videoDims }
          : videoDims)
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
  }, [selectedMicId, selectedCameraId, stopStream, refreshDevices])

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
    if (streamRef.current && modeRef.current !== 'none') {
      // Restart with the new device so existing call publishers pick it up
      // via the track-change effect in useCall.
      try { await start(modeRef.current === 'video' ? 'video' : 'audio') } catch {}
    }
  }, [start])

  const selectCamera = useCallback(async (deviceId: string): Promise<void> => {
    setSelectedCameraId(deviceId)
    if (streamRef.current && modeRef.current === 'video') {
      try { await start('video') } catch {}
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
    start,
    stop,
    toggleMic,
    toggleCamera,
    selectMic,
    selectCamera,
  }
}

export type UseLocalMediaReturn = ReturnType<typeof useLocalMedia>
