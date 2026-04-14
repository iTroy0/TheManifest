import { useEffect, useRef } from 'react'
import { Mic, MicOff } from 'lucide-react'

interface AudioTileProps {
  stream: MediaStream | null
  name: string
  self?: boolean
  micMuted?: boolean
  volume?: number
  // Loudness 0–1 supplied by the parent's shared analyser graph. When
  // omitted we don't compute it locally — silence is the safe default.
  level?: number
}

export default function AudioTile({ stream, name, self = false, micMuted = false, volume = 1, level = 0 }: AudioTileProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (stream && el.srcObject !== stream) { el.srcObject = stream }
    if (!stream && el.srcObject) { el.srcObject = null }
  }, [stream])

  useEffect(() => {
    const el = audioRef.current
    if (el) el.volume = Math.max(0, Math.min(1, volume))
  }, [volume])

  const isSpeaking: boolean = !self && !micMuted && level > 0.08

  return (
    <div
      className={`relative flex items-center gap-2 rounded-xl px-3 py-2 border transition-all duration-150 ${
        isSpeaking
          ? 'bg-accent/10 border-accent/50 shadow-[0_0_0_2px_rgba(100,255,218,0.15)]'
          : 'bg-surface-2/60 border-border'
      }`}
    >
      {!self && stream && <audio ref={audioRef} autoPlay playsInline />}

      <div className={`relative w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
        isSpeaking ? 'bg-accent/20' : 'bg-accent/5'
      }`}>
        <span className="font-mono text-xs text-accent font-bold uppercase">
          {name.slice(0, 2)}
        </span>
        {isSpeaking && (
          <span
            className="absolute inset-0 rounded-full ring-2 ring-accent/40 animate-pulse pointer-events-none"
            style={{ opacity: Math.min(1, 0.3 + level) }}
          />
        )}
      </div>

      <span className="font-mono text-xs text-text truncate flex-1 min-w-0">
        {name}{self ? ' (you)' : ''}
      </span>

      {micMuted ? (
        <MicOff className="w-3.5 h-3.5 text-danger shrink-0" />
      ) : (
        <Mic className={`w-3.5 h-3.5 shrink-0 ${isSpeaking ? 'text-accent' : 'text-muted'}`} />
      )}
    </div>
  )
}
