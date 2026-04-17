import React, { useEffect, useRef, useState } from 'react'
import { Play, Pause } from 'lucide-react'

interface VoicePlayerProps {
  src: string
  knownDuration?: number
}

function formatDur(s: number): string {
  if (!s || !isFinite(s)) return '0:00'
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

export default function VoicePlayer({ src, knownDuration }: VoicePlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const barRef = useRef<HTMLDivElement>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(knownDuration || 0)

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const getDur = () => (a.duration && isFinite(a.duration)) ? a.duration : (knownDuration || 0)
    const onTime = () => {
      setCurrentTime(a.currentTime)
      const dur = getDur()
      setProgress(dur ? (a.currentTime / dur) * 100 : 0)
      // Once playing, browser resolves the real duration
      if (a.duration && isFinite(a.duration)) setDuration(a.duration)
    }
    const onMeta = () => { const d = getDur(); if (d) setDuration(d) }
    const onEnd = () => { setPlaying(false); setProgress(0); setCurrentTime(0) }
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('loadedmetadata', onMeta)
    a.addEventListener('durationchange', onMeta)
    a.addEventListener('ended', onEnd)
    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('loadedmetadata', onMeta)
      a.removeEventListener('durationchange', onMeta)
      a.removeEventListener('ended', onEnd)
    }
  }, [knownDuration])

  function toggle(): void {
    const a = audioRef.current
    if (!a) return
    if (playing) { a.pause(); setPlaying(false) }
    else { a.play(); setPlaying(true) }
  }

  function seek(e: React.MouseEvent | React.TouchEvent): void {
    const a = audioRef.current
    const bar = barRef.current
    // MediaRecorder output often reports Infinity for duration until fully
    // buffered — filter for a usable finite number before seeking.
    if (!a || !bar || !Number.isFinite(a.duration) || a.duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX
    const pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    const target = pct * a.duration
    if (Number.isFinite(target)) a.currentTime = target
  }

  return (
    <div className="flex items-center gap-2.5 min-w-[200px]">
      <audio ref={audioRef} src={src} preload="metadata" />
      <button
        onClick={(e) => { e.stopPropagation(); toggle() }}
        className="shrink-0 w-9 h-9 rounded-full bg-accent flex items-center justify-center text-bg active:scale-90 transition-transform"
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div
          ref={barRef}
          onClick={(e) => { e.stopPropagation(); seek(e) }}
          onTouchStart={(e) => { e.stopPropagation(); seek(e) }}
          className="h-2 bg-border rounded-full overflow-hidden cursor-pointer relative group"
        >
          <div className="h-full bg-accent rounded-full transition-all duration-75" style={{ width: `${progress}%` }} />
        </div>
        <div className="flex justify-between mt-0.5">
          <span className="font-mono text-[9px] text-muted">{formatDur(currentTime)}</span>
          <span className="font-mono text-[9px] text-muted">{formatDur(duration)}</span>
        </div>
      </div>
    </div>
  )
}
