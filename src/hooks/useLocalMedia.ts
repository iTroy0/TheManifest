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
    const video: MediaTrackConstraints | false = mode === 'video'
      ? (selectedCameraId
          ? { deviceId: { exact: selectedCameraId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } })
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

  const toggleMic = useCallback((): void => {
    const s = streamRef.current
    if (!s) return
    const tracks = s.getAudioTracks()
    if (!tracks.length) return
    const newMuted = tracks[0].enabled
    tracks.forEach(t => { t.enabled = !newMuted })
    setState(prev => ({ ...prev, micMuted: newMuted }))
  }, [])

  const toggleCamera = useCallback((): void => {
    const s = streamRef.current
    if (!s) return
    const tracks = s.getVideoTracks()
    if (!tracks.length) return
    const newOff = tracks[0].enabled
    tracks.forEach(t => { t.enabled = !newOff })
    setState(prev => ({ ...prev, cameraOff: newOff }))
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
