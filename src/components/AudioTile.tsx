import { useEffect, useRef } from 'react'
import { Mic, MicOff, VolumeX, Volume2 } from 'lucide-react'

interface AudioTileProps {
  stream: MediaStream | null
  name: string
  self?: boolean
  micMuted?: boolean
  volume?: number
  // Loudness 0–1 supplied by the parent's shared analyser graph. When
  // omitted we don't compute it locally — silence is the safe default.
  level?: number
  // Per-peer mute: silences this peer locally without affecting anyone
  // else in the call. Independent of the master volume slider.
  mutedForMe?: boolean
  onToggleMutedForMe?: () => void
}

export default function AudioTile({ stream, name, self = false, micMuted = false, volume = 1, level = 0, mutedForMe = false, onToggleMutedForMe }: AudioTileProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    if (stream && el.srcObject !== stream) { el.srcObject = stream }
    if (!stream && el.srcObject) { el.srcObject = null }
  }, [stream])

  useEffect(() => {
    const el = audioRef.current
    if (!el) return
    el.volume = Math.max(0, Math.min(1, volume))
    el.muted = mutedForMe
  }, [volume, mutedForMe])

  // Speaking ring is suppressed when the listener has muted this peer —
  // it would be misleading to show a "talking" pulse for someone you can't
  // actually hear.
  const isSpeaking: boolean = !self && !micMuted && !mutedForMe && level > 0.08

  return (
    <div
      className={`relative flex items-center gap-2 rounded-xl px-3 py-2 border transition-all duration-150 ${
        isSpeaking
          ? 'bg-accent/10 border-accent/50 shadow-[0_0_0_2px_var(--color-accent-glow)]'
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

      {!self && onToggleMutedForMe && (
        <button
          type="button"
          onClick={onToggleMutedForMe}
          className={`shrink-0 w-9 h-9 sm:w-6 sm:h-6 rounded-md flex items-center justify-center transition-colors ${
            mutedForMe ? 'text-danger hover:bg-danger/10' : 'text-muted hover:text-accent hover:bg-accent/10'
          }`}
          title={mutedForMe ? 'Unmute for me' : 'Mute for me'}
          aria-label={mutedForMe ? 'Unmute for me' : 'Mute for me'}
        >
          {mutedForMe ? <VolumeX className="w-4 h-4 sm:w-3 sm:h-3" /> : <Volume2 className="w-4 h-4 sm:w-3 sm:h-3" />}
        </button>
      )}

      {micMuted ? (
        <MicOff className="w-3.5 h-3.5 text-danger shrink-0" />
      ) : (
        <Mic className={`w-3.5 h-3.5 shrink-0 ${isSpeaking ? 'text-accent' : 'text-muted'}`} />
      )}
    </div>
  )
}
