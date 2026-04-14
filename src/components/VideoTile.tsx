import { useEffect, useRef, useState, useCallback } from 'react'
import { MicOff, User, VideoOff, Maximize2, Minimize2, Maximize, PictureInPicture2, Volume2, VolumeX } from 'lucide-react'

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
  // Loudness 0–1 supplied by the parent's analyser graph. Drives a subtle
  // ring on the tile when the speaker is talking — same visual language as
  // AudioTile so the two surfaces feel like one.
  level?: number
  // Per-peer mute: silences this peer locally without affecting anyone
  // else in the call.
  mutedForMe?: boolean
  onToggleMutedForMe?: () => void
}

// Clamp the container's aspect ratio so an unusual source can't produce a
// ridiculously tall or wide tile. 9/16 ≈ 0.5625, 16/9 ≈ 1.778.
const MIN_ASPECT = 9 / 16
const MAX_ASPECT = 16 / 9

// Safari ships a legacy presentation-mode API instead of the standards PiP
// methods. We type those extras as an optional bag and merge with HTMLVideoElement
// at the use site rather than declaring an extending interface (which would
// fight the standards types in lib.dom).
type SafariPiPVideoExtras = {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
}

export default function VideoTile({ stream, name, self = false, micMuted = false, cameraOff = false, connecting = false, focused = false, mini = false, onToggleFocus, volume = 1, level = 0, mutedForMe = false, onToggleMutedForMe }: VideoTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [srcAspect, setSrcAspect] = useState<number>(16 / 9)
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false)
  const [isPip, setIsPip] = useState<boolean>(false)

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

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.volume = Math.max(0, Math.min(1, volume))
    // The local self preview is hard-muted via the `muted` attribute below
    // (loop-prevention). Per-peer mute only matters for remotes.
    if (!self) el.muted = mutedForMe
  }, [volume, mutedForMe, self])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const update = (): void => {
      const w = el.videoWidth
      const h = el.videoHeight
      if (w > 0 && h > 0) {
        const raw = w / h
        setSrcAspect(Math.max(MIN_ASPECT, Math.min(MAX_ASPECT, raw)))
      }
    }
    update()
    el.addEventListener('loadedmetadata', update)
    el.addEventListener('resize', update)
    return () => {
      el.removeEventListener('loadedmetadata', update)
      el.removeEventListener('resize', update)
    }
  }, [stream])

  // Fullscreen state is owned by the document, not React. Subscribe to the
  // change event so the button label stays correct when the user hits ESC
  // or uses the browser UI.
  useEffect(() => {
    const onChange = (): void => {
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    }
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // PiP state similarly lives on the document. enterpictureinpicture and
  // leavepictureinpicture fire on the video element itself.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    const onEnter = (): void => setIsPip(true)
    const onLeave = (): void => setIsPip(false)
    el.addEventListener('enterpictureinpicture', onEnter)
    el.addEventListener('leavepictureinpicture', onLeave)
    return () => {
      el.removeEventListener('enterpictureinpicture', onEnter)
      el.removeEventListener('leavepictureinpicture', onLeave)
    }
  }, [])

  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const el = containerRef.current
    if (!el) return
    try {
      if (document.fullscreenElement === el) {
        await document.exitFullscreen()
      } else {
        await el.requestFullscreen()
      }
    } catch {
      // Browser refused (e.g., iOS Safari without webkit support). Silent.
    }
  }, [])

  const togglePip = useCallback(async (): Promise<void> => {
    const el = videoRef.current
    if (!el) return
    try {
      // Standards path
      if (typeof el.requestPictureInPicture === 'function' && document.pictureInPictureEnabled) {
        if (document.pictureInPictureElement === el) {
          await document.exitPictureInPicture()
        } else {
          await el.requestPictureInPicture()
        }
        return
      }
      // Safari fallback (legacy presentation mode API)
      const safari = el as unknown as SafariPiPVideoExtras
      if (typeof safari.webkitSetPresentationMode === 'function' && safari.webkitSupportsPresentationMode?.('picture-in-picture')) {
        const next = isPip ? 'inline' : 'picture-in-picture'
        safari.webkitSetPresentationMode(next)
        setIsPip(!isPip)
      }
    } catch {
      // Refused (e.g., no video track yet). Silent.
    }
  }, [isPip])

  const hasAnyVideoTrack: boolean = !!(stream && stream.getVideoTracks().length > 0)
  const shouldShowBlackout: boolean = !hasAnyVideoTrack || cameraOff
  const clickable: boolean = !!onToggleFocus
  const avatarSize: string = mini ? 'w-8 h-8' : 'w-14 h-14'
  const avatarIcon: string = mini ? 'w-4 h-4' : 'w-7 h-7'

  const handleClick = (): void => {
    if (onToggleFocus) onToggleFocus()
  }

  // Mini PiP overlay tiles (the small strip in focused mode) stay locked to a
  // landscape shape so the strip layout stays neat. Full-size tiles follow
  // the source's intrinsic aspect.
  const effectiveAspect: number = mini ? 16 / 9 : srcAspect
  const maxHeight: string | undefined = mini ? undefined : (isFullscreen ? undefined : 'min(60vh, 500px)')

  // Highlight ring when the speaker is talking. Suppressed for self, mini
  // overlay tiles, and peers the listener has muted (the "you can't hear
  // them" state).
  const isSpeaking = !self && !mini && !micMuted && !mutedForMe && level > 0.1
  // Keep the existing focus ring; layer the speaking ring as an outline so
  // both can coexist without fighting border styles.

  const showControls = clickable && !mini

  return (
    <div
      ref={containerRef}
      onClick={clickable && !isFullscreen ? handleClick : undefined}
      style={{ aspectRatio: `${effectiveAspect}`, maxHeight }}
      className={`relative w-full rounded-xl overflow-hidden bg-surface-2/80 border border-border group ${
        clickable && !isFullscreen ? 'cursor-pointer hover:border-accent/60 transition-colors' : ''
      } ${focused ? 'ring-2 ring-accent/60' : ''} ${isSpeaking ? 'shadow-[0_0_0_2px_rgba(100,255,218,0.45)]' : ''}`}
      title={clickable && !isFullscreen ? (focused ? 'Click to unfocus' : 'Click to focus') : undefined}
    >
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

      {/* Top-right control cluster: per-peer mute, PiP, fullscreen, focus toggle. */}
      {showControls && (
        <div className="absolute top-2 right-2 flex items-center gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {!self && onToggleMutedForMe && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleMutedForMe() }}
              className={`p-1.5 rounded-md backdrop-blur-sm ${
                mutedForMe ? 'bg-danger/70 hover:bg-danger/90 text-white' : 'bg-black/60 hover:bg-black/80 text-white'
              }`}
              aria-label={mutedForMe ? 'Unmute for me' : 'Mute for me'}
              title={mutedForMe ? 'Unmute for me' : 'Mute for me'}
            >
              {mutedForMe ? <VolumeX className="w-3 h-3" /> : <Volume2 className="w-3 h-3" />}
            </button>
          )}
          {hasAnyVideoTrack && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void togglePip() }}
              className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm"
              aria-label={isPip ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
              title={isPip ? 'Exit PiP' : 'Picture-in-Picture'}
            >
              <PictureInPicture2 className="w-3 h-3" />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void toggleFullscreen() }}
            className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm"
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <Maximize className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleClick() }}
            className="p-1.5 rounded-md bg-black/60 hover:bg-black/80 text-white backdrop-blur-sm"
            aria-label={focused ? 'Unfocus' : 'Focus'}
            title={focused ? 'Back to grid' : 'Focus'}
          >
            {focused ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
          </button>
        </div>
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
