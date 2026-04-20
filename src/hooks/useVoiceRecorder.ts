import { useEffect, useRef, useState } from 'react'

export interface VoiceClip {
  url: string
  bytes: Uint8Array
  mime: string
  duration: number
}

export interface UseVoiceRecorderOptions {
  // Called once when a clip finishes recording. Implementations typically
  // pass the clip down to the chat send pipeline.
  onClip: (clip: VoiceClip) => void
  // Called on user-facing failures (mic permission, codec, etc.). Pass null
  // through to clear any prior message after a timeout.
  onError: (message: string | null) => void
  // Track every blob: URL we mint so the parent can revoke on unmount.
  createTrackedBlobUrl: (blob: Blob) => string
  // Optional UX side effect — caller decides whether to play the sent ping.
  onSent?: () => void
}

export interface VoiceRecorderApi {
  isRecording: boolean
  recordingTime: number
  hasRecordingSupport: boolean
  startRecording: () => Promise<void>
  stopRecording: () => void
  cancelRecording: () => void
}

const MAX_RECORDING_SECS = 180
const ERROR_HIDE_MS = 4000

function getRecordingMime(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
  if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
  return ''
}

// Owns the MediaRecorder lifecycle for chat voice notes. Mirrors the
// callbacks into refs so the long-lived MediaRecorder closure always reads
// the current onClip / onSent / soundEnabled values, not the snapshot
// captured at startRecording time.
export function useVoiceRecorder({ onClip, onError, createTrackedBlobUrl, onSent }: UseVoiceRecorderOptions): VoiceRecorderApi {
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const recordingTimeRef = useRef(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])

  const onClipRef = useRef(onClip)
  const onSentRef = useRef(onSent)
  const onErrorRef = useRef(onError)
  useEffect(() => { onClipRef.current = onClip }, [onClip])
  useEffect(() => { onSentRef.current = onSent }, [onSent])
  useEffect(() => { onErrorRef.current = onError }, [onError])

  const stopRecording = (): void => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  const cancelRecording = (): void => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.ondataavailable = null
      mediaRecorderRef.current.onstop = () => {
        mediaRecorderRef.current?.stream?.getTracks().forEach(t => t.stop())
      }
      mediaRecorderRef.current.stop()
    }
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
    recordingChunksRef.current = []
    setIsRecording(false)
    setRecordingTime(0)
    recordingTimeRef.current = 0
  }

  const startRecording = async (): Promise<void> => {
    const mime = getRecordingMime()
    if (!mime) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      recordingChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
        const blob = new Blob(recordingChunksRef.current, { type: mime })
        recordingChunksRef.current = []
        if (blob.size === 0) {
          setIsRecording(false)
          setRecordingTime(0)
          return
        }
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const url = createTrackedBlobUrl(blob)
        onSentRef.current?.()
        onClipRef.current({ url, bytes, mime: mime.split(';')[0], duration: recordingTimeRef.current })
        setIsRecording(false)
        setRecordingTime(0)
        recordingTimeRef.current = 0
      }

      recorder.start(250)
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setRecordingTime(0)
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(t => {
          const next = t + 1
          recordingTimeRef.current = next
          if (next >= MAX_RECORDING_SECS) { stopRecording(); return t }
          return next
        })
      }, 1000)
    } catch (err) {
      console.warn('Microphone access failed:', err)
      onErrorRef.current('Microphone access denied. Check browser permissions.')
      setTimeout(() => onErrorRef.current(null), ERROR_HIDE_MS)
    }
  }

  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stream?.getTracks().forEach(t => t.stop())
        mediaRecorderRef.current.stop()
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
  }, [])

  return {
    isRecording,
    recordingTime,
    hasRecordingSupport: getRecordingMime() !== '',
    startRecording,
    stopRecording,
    cancelRecording,
  }
}
