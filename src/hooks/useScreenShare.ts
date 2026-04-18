import { useCallback, useEffect, useRef, useState } from 'react'

export interface ScreenShareError {
  code: 'unsupported' | 'permission-denied' | 'unknown'
  message: string
}

export interface UseScreenShareReturn {
  stream: MediaStream | null
  active: boolean
  starting: boolean
  error: ScreenShareError | null
  start: () => Promise<MediaStream | null>
  stop: () => void
  clearError: () => void
}

function classify(e: unknown): ScreenShareError {
  const name = (e as { name?: string })?.name || ''
  const msg = (e as { message?: string })?.message || 'Could not start screen sharing.'
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return { code: 'permission-denied', message: 'Screen sharing was blocked.' }
  }
  if (name === 'NotSupportedError') {
    return { code: 'unsupported', message: 'This browser does not support screen sharing.' }
  }
  return { code: 'unknown', message: msg }
}

// Thin wrapper around getDisplayMedia. The call lane subscribes to `stream`
// and swaps its video track into every outgoing RTCPeerConnection via
// sender.replaceTrack, so the remote sees screen frames in place of camera
// frames without renegotiation.
export function useScreenShare(): UseScreenShareReturn {
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [starting, setStarting] = useState<boolean>(false)
  const [error, setError] = useState<ScreenShareError | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const mountedRef = useRef<boolean>(true)

  useEffect(() => {
    return () => {
      mountedRef.current = false
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => { try { t.stop() } catch {} })
        streamRef.current = null
      }
    }
  }, [])

  const stop = useCallback((): void => {
    const s = streamRef.current
    streamRef.current = null
    if (s) s.getTracks().forEach(t => { try { t.stop() } catch {} })
    if (mountedRef.current) setStream(null)
  }, [])

  const start = useCallback(async (): Promise<MediaStream | null> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) {
      setError({ code: 'unsupported', message: 'This browser does not support screen sharing.' })
      return null
    }
    if (streamRef.current) return streamRef.current
    setStarting(true)
    setError(null)
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 60 } },
        audio: false,
      })
      if (!mountedRef.current) {
        s.getTracks().forEach(t => { try { t.stop() } catch {} })
        return null
      }
      streamRef.current = s
      // Browser's native "Stop sharing" chrome fires `ended` on the track.
      // Clean up so callers don't have to listen themselves.
      s.getVideoTracks().forEach(t => {
        t.addEventListener('ended', () => {
          if (streamRef.current === s) stop()
        })
      })
      setStream(s)
      return s
    } catch (e) {
      if (mountedRef.current) setError(classify(e))
      return null
    } finally {
      if (mountedRef.current) setStarting(false)
    }
  }, [stop])

  const clearError = useCallback((): void => setError(null), [])

  return {
    stream,
    active: stream !== null,
    starting,
    error,
    start,
    stop,
    clearError,
  }
}
