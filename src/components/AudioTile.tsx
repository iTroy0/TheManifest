import { useEffect, useRef, useState } from 'react'
import { Mic, MicOff } from 'lucide-react'

interface AudioTileProps {
  stream: MediaStream | null
  name: string
  self?: boolean
  micMuted?: boolean
  volume?: number
}

// Small, inline speaking detector using the Web Audio API. Runs a cheap
// time-domain analyzer and pulses the tile when RMS crosses a threshold.
function useSpeakingLevel(stream: MediaStream | null, active: boolean): number {
  const [level, setLevel] = useState<number>(0)

  useEffect(() => {
    if (!stream || !active) { setLevel(0); return }
    const audioTracks = stream.getAudioTracks()
    if (!audioTracks.length) { setLevel(0); return }

    const AC: typeof AudioContext | undefined = (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
    if (!AC) return

    let ctx: AudioContext
    try { ctx = new AC() } catch { return }

    let src: MediaStreamAudioSourceNode
    try { src = ctx.createMediaStreamSource(stream) } catch { try { ctx.close() } catch {} ; return }

    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.6
    src.connect(analyser)

    const buf = new Uint8Array(analyser.fftSize)
    let raf = 0
    let lastUpdate = 0

    const tick = (): void => {
      analyser.getByteTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128
        sum += v * v
      }
      const rms = Math.sqrt(sum / buf.length)
      const now = performance.now()
      if (now - lastUpdate > 100) {
        lastUpdate = now
        setLevel(Math.min(1, rms * 3))
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      try { src.disconnect() } catch {}
      try { analyser.disconnect() } catch {}
      try { ctx.close() } catch {}
    }
  }, [stream, active])

  return level
}

export default function AudioTile({ stream, name, self = false, micMuted = false, volume = 1 }: AudioTileProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speaking = useSpeakingLevel(stream, !self && !micMuted)

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

  const isSpeaking: boolean = speaking > 0.08

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
            style={{ opacity: Math.min(1, 0.3 + speaking) }}
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
