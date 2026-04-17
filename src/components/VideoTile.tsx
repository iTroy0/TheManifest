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
// and fullscreen methods. We type those extras as an optional bag and merge
// with HTMLVideoElement at the use site rather than declaring an extending
// interface (which would fight the standards types in lib.dom).
type WebkitVideoExtras = {
  webkitSupportsPresentationMode?: (mode: string) => boolean
  webkitSetPresentationMode?: (mode: string) => void
  webkitEnterFullscreen?: () => void
  webkitExitFullscreen?: () => void
  webkitDisplayingFullscreen?: boolean
}

export default function VideoTile({ stream, name, self = false, micMuted = false, cameraOff = false, connecting = false, focused = false, mini = false, onToggleFocus, volume = 1, level = 0, mutedForMe = false, onToggleMutedForMe }: VideoTileProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const [srcAspect, setSrcAspect] = useState<number>(16 / 9)
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false)
  const [isPip, setIsPip] = useState<boolean>(false)

  // Bind srcObject and kick playback. Mobile browsers (iOS Safari in
  // particular) don't always autoplay when srcObject changes on an
  // already-mounted element, even with the autoplay attribute — they
  // insist on an explicit .play() call. Swallow the resulting promise
  // rejection for the autoplay-policy case.
  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    if (stream && el.srcObject !== stream) {
      el.srcObject = stream
    }
    if (!stream && el.srcObject) {
      el.srcObject = null
      return
    }
    if (stream) {
      // Let the browser finish attaching the new srcObject before we call
      // play(); otherwise Chrome sometimes rejects the call with a
      // "AbortError: interrupted by a new load request".
      const raf = requestAnimationFrame(() => {
        el.play().catch(() => {})
      })
      return () => cancelAnimationFrame(raf)
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

  // Fullscreen state tracking. The standards path raises fullscreenchange
  // on the document. iOS Safari, where only <video> elements can enter
  // fullscreen, raises webkitbegin/endfullscreen on the <video> itself.
  useEffect(() => {
    const container = containerRef.current
    const videoEl = videoRef.current
    if (!container || !videoEl) return

    const onStandardsChange = (): void => {
      setIsFullscreen(document.fullscreenElement === container || document.fullscreenElement === videoEl)
    }
    const onWebkitBegin = (): void => setIsFullscreen(true)
    const onWebkitEnd = (): void => setIsFullscreen(false)

    document.addEventListener('fullscreenchange', onStandardsChange)
    videoEl.addEventListener('webkitbeginfullscreen', onWebkitBegin)
    videoEl.addEventListener('webkitendfullscreen', onWebkitEnd)
    return () => {
      document.removeEventListener('fullscreenchange', onStandardsChange)
      videoEl.removeEventListener('webkitbeginfullscreen', onWebkitBegin)
      videoEl.removeEventListener('webkitendfullscreen', onWebkitEnd)
    }
  }, [])

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

  // Fullscreen has three paths and we need all three:
  //   1. Standards requestFullscreen() on the container (desktop Chrome,
  //      Firefox, Edge, Safari 16.4+).
  //   2. webkitEnterFullscreen() on the <video> element (iOS Safari —
  //      cannot fullscreen divs, only media elements).
  //   3. Gracefully no-op if neither is supported.
  const toggleFullscreen = useCallback(async (): Promise<void> => {
    const container = containerRef.current
    const videoEl = videoRef.current as (HTMLVideoElement & WebkitVideoExtras) | null
    if (!container || !videoEl) return
    try {
      // Already in standards fullscreen → exit standards.
      if (document.fullscreenElement === container || document.fullscreenElement === videoEl) {
        await document.exitFullscreen()
        return
      }
      // Already in iOS webkit fullscreen → exit webkit.
      if (videoEl.webkitDisplayingFullscreen && typeof videoEl.webkitExitFullscreen === 'function') {
        videoEl.webkitExitFullscreen()
        return
      }
      // Enter: prefer standards (container keeps our custom overlay UI).
      if (typeof container.requestFullscreen === 'function') {
        await container.requestFullscreen()
        return
      }
      // Fall back to iOS: native video player takes over — our overlay
      // vanishes but the user sees a proper fullscreen video.
      if (typeof videoEl.webkitEnterFullscreen === 'function') {
        videoEl.webkitEnterFullscreen()
        return
      }
    } catch {
      // Refused by the browser (permissions policy, no user gesture, etc.).
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
      // Safari legacy presentation-mode fallback
      const webkit = el as unknown as WebkitVideoExtras
      if (typeof webkit.webkitSetPresentationMode === 'function' && webkit.webkitSupportsPresentationMode?.('picture-in-picture')) {
        const next = isPip ? 'inline' : 'picture-in-picture'
        webkit.webkitSetPresentationMode(next)
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

  // Mini PiP overlay tiles (the small strip in focused mode) stay locked
  // to a landscape shape so the strip layout stays neat. Full-size tiles
  // follow the source's intrinsic aspect. In fullscreen we drop the
  // aspect-ratio hint entirely so the container can fill the viewport.
  const effectiveAspect: number = mini ? 16 / 9 : srcAspect
  const maxHeight: string | undefined = mini || isFullscreen ? undefined : 'min(60vh, 500px)'

  // Highlight ring when the speaker is talking. Suppressed for self, mini
  // overlay tiles, and peers the listener has muted.
  const isSpeaking = !self && !mini && !micMuted && !mutedForMe && level > 0.1

  // Controls are visible on any tile that's clickable (not a mini overlay).
  const showControls = clickable && !mini

  // Object-fit selection:
  //   - Mini tiles: cover (uniform thumbnail look — cropping is OK)
  //   - Grid tiles: cover (uniform grid cells)
  //   - Focused or fullscreen: contain (show the full frame honestly —
  //     portrait mobile sources on a desktop focus were being zoomed and
  //     cropped because maxHeight clamped the container into a different
  //     aspect than the source)
  const objectFitClass: string = (focused || isFullscreen) && !mini ? 'object-contain' : 'object-cover'

  // Control button sizing: 40px tap targets on mobile (minimum touch
  // target), compact 24px on sm+ so they don't dominate desktop tiles.
  // The always-visible path for touch devices is `[@media(hover:none)]`.
  const controlButtonBase = 'flex items-center justify-center w-10 h-10 sm:w-7 sm:h-7 rounded-md backdrop-blur-sm transition-colors'
  const controlIconSize = 'w-4 h-4 sm:w-3 sm:h-3'

  // U3: keyboard accessibility. A clickable tile is reachable via Tab,
  // announces itself via aria-label, and toggles focus on Enter/Space.
  // We keep role="button" despite the nested <button>s in the control
  // cluster because the primary affordance of the tile IS click-to-focus;
  // screen readers announce nested interactive children anyway.
  const interactive = clickable && !isFullscreen
  const onKeyDown = interactive
    ? (e: React.KeyboardEvent<HTMLDivElement>): void => {
        if (e.target !== e.currentTarget) return // nested button handled it
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          handleClick()
        }
      }
    : undefined
  const ariaLabel = interactive
    ? `${name}${self ? ' (you)' : ''}. ${focused ? 'Focused tile. Press Enter or Escape to unfocus.' : 'Press Enter to focus.'}`
    : undefined

  return (
    <div
      ref={containerRef}
      onClick={interactive ? handleClick : undefined}
      onKeyDown={onKeyDown}
      tabIndex={interactive ? 0 : undefined}
      role={interactive ? 'button' : undefined}
      aria-pressed={interactive ? focused : undefined}
      aria-label={ariaLabel}
      style={{ aspectRatio: isFullscreen ? undefined : `${effectiveAspect}`, maxHeight }}
      className={`relative w-full rounded-xl overflow-hidden bg-surface-2/80 border border-border group ${
        interactive ? 'cursor-pointer hover:border-accent/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg' : ''
      } ${focused ? 'ring-2 ring-accent/60' : ''} ${isSpeaking ? 'shadow-[0_0_0_2px_rgba(100,255,218,0.45)]' : ''}`}
      title={interactive ? (focused ? 'Click to unfocus' : 'Click to focus') : undefined}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={self}
        className={`absolute inset-0 w-full h-full ${objectFitClass} bg-black transition-opacity duration-200 ${
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

      {/* Control cluster: per-peer mute, PiP, fullscreen, focus toggle.
          Hidden by default on hover-capable pointers and revealed on
          group-hover; always visible on touch devices (no hover). */}
      {showControls && (
        <div className="absolute top-2 right-2 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
          {!self && onToggleMutedForMe && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggleMutedForMe() }}
              className={`${controlButtonBase} ${
                mutedForMe ? 'bg-danger/70 hover:bg-danger/90 text-white' : 'bg-black/60 hover:bg-black/80 text-white'
              }`}
              aria-label={mutedForMe ? 'Unmute for me' : 'Mute for me'}
              title={mutedForMe ? 'Unmute for me' : 'Mute for me'}
            >
              {mutedForMe ? <VolumeX className={controlIconSize} /> : <Volume2 className={controlIconSize} />}
            </button>
          )}
          {hasAnyVideoTrack && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); void togglePip() }}
              className={`${controlButtonBase} bg-black/60 hover:bg-black/80 text-white`}
              aria-label={isPip ? 'Exit Picture-in-Picture' : 'Picture-in-Picture'}
              title={isPip ? 'Exit PiP' : 'Picture-in-Picture'}
            >
              <PictureInPicture2 className={controlIconSize} />
            </button>
          )}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); void toggleFullscreen() }}
            className={`${controlButtonBase} bg-black/60 hover:bg-black/80 text-white`}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            <Maximize className={controlIconSize} />
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); handleClick() }}
            className={`${controlButtonBase} bg-black/60 hover:bg-black/80 text-white`}
            aria-label={focused ? 'Unfocus' : 'Focus'}
            title={focused ? 'Back to grid' : 'Focus'}
          >
            {focused ? <Minimize2 className={controlIconSize} /> : <Maximize2 className={controlIconSize} />}
          </button>
        </div>
      )}

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
