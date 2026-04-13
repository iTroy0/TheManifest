import { useEffect, useRef } from 'react'
import { MicOff, User, VideoOff, Maximize2, Minimize2 } from 'lucide-react'

interface VideoTileProps {
  stream: MediaStream | null
  name: string
  self?: boolean
  micMuted?: boolean
  cameraOff?: boolean
  connecting?: boolean
  focused?: boolean
  mini?: boolean
  onToggleFocus?: () => void
  volume?: number
}

export default function VideoTile({ stream, name, self = false, micMuted = false, cameraOff = false, connecting = false, focused = false, mini = false, onToggleFocus, volume = 1 }: VideoTileProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null)

  // Attach/detach srcObject whenever the stream reference changes. The
  // <video> element is always mounted (see below), so this effect always
  // runs against a live ref — no remount races when cameraOff toggles.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream
    }
    if (!stream && el.srcObject) {
      el.srcObject = null
    }
  }, [stream])

  // Remote audio comes through the <video> element when in video mode.
  // Self-video is HTML-muted anyway, so this is a no-op for local preview.
  useEffect(() => {
    const el = videoRef.current
    if (el) el.volume = Math.max(0, Math.min(1, volume))
  }, [volume])

  const hasAnyVideoTrack: boolean = !!(stream && stream.getVideoTracks().length > 0)
  const shouldShowBlackout: boolean = !hasAnyVideoTrack || cameraOff
  const clickable: boolean = !!onToggleFocus
  const avatarSize: string = mini ? 'w-8 h-8' : 'w-14 h-14'
  const avatarIcon: string = mini ? 'w-4 h-4' : 'w-7 h-7'

  const handleClick = (): void => {
    if (onToggleFocus) onToggleFocus()
  }

  return (
    <div
      onClick={clickable ? handleClick : undefined}
      className={`relative aspect-video w-full rounded-xl overflow-hidden bg-surface-2/80 border border-border group ${
        clickable ? 'cursor-pointer hover:border-accent/60 transition-colors' : ''
      } ${focused ? 'ring-2 ring-accent/60' : ''}`}
      title={clickable ? (focused ? 'Click to unfocus' : 'Click to focus') : undefined}
    >
      {/* Always-mounted video element. Hidden (not unmounted) when blackout
          applies so that toggling cameraOff never loses the srcObject binding. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={self}
        className={`absolute inset-0 w-full h-full object-cover bg-black transition-opacity duration-200 ${
          shouldShowBlackout ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
        style={{ transform: self ? 'scaleX(-1)' : undefined }}
      />

      {shouldShowBlackout && (
        <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-surface-2 to-bg">
          <div className={`${avatarSize} rounded-2xl bg-accent/10 flex items-center justify-center ring-2 ring-accent/20`}>
            {cameraOff ? <VideoOff className={`${avatarIcon} text-muted-light`} /> : <User className={`${avatarIcon} text-accent`} />}
          </div>
        </div>
      )}

      {connecting && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="font-mono text-[10px] text-muted">Connecting…</div>
        </div>
      )}

      {/* Focus toggle button — top-right, appears on hover */}
      {clickable && !mini && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); handleClick() }}
          className="absolute top-2 right-2 p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white opacity-0 group-hover:opacity-100 transition-opacity backdrop-blur-sm"
          aria-label={focused ? 'Unfocus' : 'Focus'}
          title={focused ? 'Back to grid' : 'Focus'}
        >
          {focused ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </button>
      )}

      {/* Name + mute badge overlay */}
      <div className={`absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent flex items-center justify-between gap-2 ${
        mini ? 'px-2 py-1' : 'px-3 py-2'
      }`}>
        <span className={`font-mono text-white truncate ${mini ? 'text-[9px]' : 'text-[11px]'}`}>{name}{self ? ' (you)' : ''}</span>
        {micMuted && (
          <div className={`flex items-center justify-center rounded-md bg-danger/90 ring-1 ring-black/20 shrink-0 ${
            mini ? 'w-3.5 h-3.5' : 'w-5 h-5'
          }`}>
            <MicOff className={mini ? 'w-2.5 h-2.5 text-white' : 'w-3 h-3 text-white'} />
          </div>
        )}
      </div>
    </div>
  )
}
