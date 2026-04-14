import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, MicOff, Video, VideoOff, PhoneOff, Phone, Minimize2, ExternalLink, Settings2, ChevronDown, Volume2, Volume1, VolumeX, SwitchCamera } from 'lucide-react'
import { UseCallReturn } from '../hooks/useCall'
import { useViewport } from '../hooks/useViewport'
import VideoTile from './VideoTile'
import AudioTile from './AudioTile'

interface CallPanelProps {
  call: UseCallReturn
  myName: string
  myPeerId: string | null
  disabled?: boolean
}

type PopoutPos = { x: number; y: number }
type PopoutSize = { w: number; h: number }

const POPOUT_DEFAULT: PopoutSize = { w: 420, h: 520 }
const POPOUT_MIN: PopoutSize = { w: 320, h: 360 }

export default function CallPanel({ call, myName, disabled = false }: CallPanelProps) {
  const [open, setOpen] = useState<boolean>(false)
  const [isPopout, setIsPopout] = useState<boolean>(false)
  const [popoutPos, setPopoutPos] = useState<PopoutPos | null>(null)
  const [popoutSize, setPopoutSize] = useState<PopoutSize>(POPOUT_DEFAULT)
  const [showSettings, setShowSettings] = useState<boolean>(false)
  // Viewport detection is shared with other panels via useViewport. `isMobile`
  // gates the popout and bumps control sizes; tile aspect is handled inside
  // VideoTile via the source's natural dimensions.
  const { isMobile } = useViewport()
  // Master remote-volume (0-1). Applied to every remote audio/video tile.
  // Ephemeral on purpose — we don't persist to localStorage (privacy ethos).
  const [volume, setVolume] = useState<number>(1)
  const lastNonZeroVolumeRef = useRef<number>(1)
  // Discord-style focus: clicking a video tile spotlights it; others become
  // small overlays. Special sentinel 'self' refers to the local preview.
  const [focusedId, setFocusedId] = useState<string | null>(null)

  const popoutRef = useRef<HTMLDivElement | null>(null)

  const handleVolumeChange = useCallback((v: number): void => {
    const clamped = Math.max(0, Math.min(1, v))
    if (clamped > 0) lastNonZeroVolumeRef.current = clamped
    setVolume(clamped)
  }, [])

  const toggleSpeakerMute = useCallback((): void => {
    setVolume(prev => {
      if (prev > 0) {
        lastNonZeroVolumeRef.current = prev
        return 0
      }
      return lastNonZeroVolumeRef.current || 1
    })
  }, [])

  // When a call becomes active, auto-open the panel.
  useEffect(() => {
    if (call.joined && !open) setOpen(true)
  }, [call.joined, open])

  // Popout drag — window-level listeners so the cursor doesn't have to
  // stay over the element while dragging (matches ChatPanel's pattern).
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  const handleDragStart = useCallback((e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>): void => {
    if (!isPopout) return
    const el = popoutRef.current
    if (!el) return
    const touch = (e as React.TouchEvent).touches
    const clientX = touch ? touch[0].clientX : (e as React.MouseEvent).clientX
    const clientY = touch ? touch[0].clientY : (e as React.MouseEvent).clientY
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: clientX, startY: clientY, origX: rect.left, origY: rect.top }

    const onMove = (ev: MouseEvent | TouchEvent): void => {
      const t = (ev as TouchEvent).touches
      const cx = t ? t[0].clientX : (ev as MouseEvent).clientX
      const cy = t ? t[0].clientY : (ev as MouseEvent).clientY
      const d = dragRef.current
      if (!d) return
      const dx = cx - d.startX
      const dy = cy - d.startY
      const nx = Math.max(0, Math.min(window.innerWidth - 100, d.origX + dx))
      const ny = Math.max(0, Math.min(window.innerHeight - 50, d.origY + dy))
      setPopoutPos({ x: nx, y: ny })
    }
    const onEnd = (): void => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }, [isPopout])

  const handleResizeStart = useCallback((e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = popoutRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const startRight = rect.right
    const startBottom = rect.bottom

    const onMove = (ev: MouseEvent | TouchEvent): void => {
      ev.preventDefault()
      const t = (ev as TouchEvent).touches
      const cx = t ? t[0].clientX : (ev as MouseEvent).clientX
      const cy = t ? t[0].clientY : (ev as MouseEvent).clientY
      const newW = Math.max(POPOUT_MIN.w, Math.min(window.innerWidth - 16, startRight - cx))
      const newH = Math.max(POPOUT_MIN.h, Math.min(window.innerHeight - 32, startBottom - cy))
      setPopoutSize({ w: newW, h: newH })
      setPopoutPos({ x: startRight - newW, y: startBottom - newH })
    }
    const onEnd = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }, [])

  const popOut = useCallback((): void => {
    setIsPopout(true)
    setPopoutPos({
      x: Math.round((window.innerWidth - POPOUT_DEFAULT.w) / 2),
      y: Math.round((window.innerHeight - POPOUT_DEFAULT.h) / 2),
    })
    setOpen(true)
  }, [])
  const dockBack = useCallback((): void => { setIsPopout(false); setPopoutPos(null); setPopoutSize(POPOUT_DEFAULT) }, [])

  const remotePeers = call.remotePeers
  const videoRemotes = remotePeers.filter(p => p.mode === 'video')
  const audioRemotes = remotePeers.filter(p => p.mode === 'audio')
  const showLocalVideo: boolean = call.mode === 'video'

  // ── Pre-join screen ────────────────────────────────────────────────────

  const renderPreJoin = (): React.ReactElement => (
    <div className="flex flex-col items-center justify-center gap-5 py-6 px-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center ring-2 ring-accent/20">
        <Phone className="w-6 h-6 text-accent" strokeWidth={1.75} />
      </div>
      <div>
        <p className="font-mono text-sm text-text font-medium">Start a call</p>
        <p className="font-mono text-[10px] text-muted mt-1">Voice up to 20 · Video 1:1</p>
      </div>
      {call.error && (
        <p className="font-mono text-[10px] text-danger max-w-[260px]">{call.error}</p>
      )}
      <div className="flex items-center gap-2 w-full max-w-[280px]">
        <button
          type="button"
          onClick={() => { void call.joinAudio() }}
          disabled={disabled || call.joining}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent/15 hover:bg-accent/25 border border-accent/30 text-accent font-mono text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
        >
          <Mic className="w-3.5 h-3.5" />
          Join Audio
        </button>
        <button
          type="button"
          onClick={() => { void call.joinVideo() }}
          disabled={disabled || call.joining || !call.canJoinVideo}
          className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent/15 hover:bg-accent/25 border border-accent/30 text-accent font-mono text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed active:scale-[0.98]"
          title={!call.canJoinVideo ? 'Video full (1:1)' : 'Join with camera'}
        >
          <Video className="w-3.5 h-3.5" />
          Join Video
        </button>
      </div>
      <p className="font-mono text-[10px] text-muted/60">
        {call.videoSlotsUsed > 0 && `${call.videoSlotsUsed}/2 in video · `}
        {remotePeers.length > 0 ? `${remotePeers.length} already in call` : 'No one is in the call yet'}
      </p>
    </div>
  )

  // ── Active call content ────────────────────────────────────────────────

  const renderActive = (): React.ReactElement => {
    // Build the list of video tiles (self + remotes). Each one can be
    // focused or mini, depending on focusedId.
    type VideoTileInfo = {
      id: string
      isSelf: boolean
      name: string
      stream: MediaStream | null
      micMuted: boolean
      cameraOff: boolean
      connecting: boolean
    }
    const videoTiles: VideoTileInfo[] = []
    if (showLocalVideo) {
      videoTiles.push({
        id: 'self',
        isSelf: true,
        name: myName,
        stream: call.localStream,
        micMuted: call.micMuted,
        cameraOff: call.cameraOff,
        connecting: false,
      })
    }
    videoRemotes.forEach(p => {
      videoTiles.push({
        id: p.peerId,
        isSelf: false,
        name: p.name,
        stream: p.stream,
        micMuted: p.micMuted,
        cameraOff: p.cameraOff,
        connecting: !p.stream,
      })
    })
    // Auto-unfocus if the focused tile is gone
    const effectiveFocus: string | null = focusedId && videoTiles.some(v => v.id === focusedId) ? focusedId : null
    const focusedTile: VideoTileInfo | null = effectiveFocus ? videoTiles.find(v => v.id === effectiveFocus) || null : null
    const miniTiles: VideoTileInfo[] = focusedTile ? videoTiles.filter(v => v.id !== focusedTile.id) : []

    return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Video area */}
      {videoTiles.length > 0 && (
        <div className="px-3 pt-3 pb-2">
          {focusedTile ? (
            // Focused: one big tile, others as PiP overlay in the top-right
            <div className="relative">
              <VideoTile
                stream={focusedTile.stream}
                name={focusedTile.name}
                self={focusedTile.isSelf}
                micMuted={focusedTile.micMuted}
                cameraOff={focusedTile.cameraOff}
                connecting={focusedTile.connecting}
                volume={focusedTile.isSelf ? 1 : volume}
                focused
                onToggleFocus={() => setFocusedId(null)}
              />
              {miniTiles.length > 0 && (
                <div className="absolute top-2 left-2 flex flex-col gap-1.5 w-24 sm:w-28">
                  {miniTiles.map(v => (
                    <VideoTile
                      key={v.id}
                      stream={v.stream}
                      name={v.name}
                      self={v.isSelf}
                      micMuted={v.micMuted}
                      cameraOff={v.cameraOff}
                      connecting={v.connecting}
                      volume={v.isSelf ? 1 : volume}
                      mini
                      onToggleFocus={() => setFocusedId(v.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            // Grid: 1 tile full-width, 2 tiles side-by-side. Each tile's
            // aspect follows its own source (VideoTile derives from
            // videoWidth/videoHeight). items-center vertically centers a
            // shorter tile in a row dominated by a taller sibling so a
            // landscape + portrait pair doesn't leave one orphaned.
            <div
              className="grid gap-2 items-center"
              style={{
                gridTemplateColumns: videoTiles.length === 1 ? '1fr' : '1fr 1fr',
              }}
            >
              {videoTiles.map(v => (
                <VideoTile
                  key={v.id}
                  stream={v.stream}
                  name={v.name}
                  self={v.isSelf}
                  micMuted={v.micMuted}
                  cameraOff={v.cameraOff}
                  connecting={v.connecting}
                  volume={v.isSelf ? 1 : volume}
                  onToggleFocus={() => setFocusedId(v.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Audio tiles */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2">
        <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5">
          {/* Local audio-only tile: show only when not publishing video */}
          {call.mode === 'audio' && (
            <AudioTile stream={call.localStream} name={myName} self micMuted={call.micMuted} />
          )}
          {audioRemotes.map(p => (
            <AudioTile key={p.peerId} stream={p.stream} name={p.name} micMuted={p.micMuted} volume={volume} />
          ))}
        </div>
        {remotePeers.length === 0 && (
          <p className="font-mono text-[10px] text-muted/60 text-center py-6">
            Waiting for others to join…
          </p>
        )}
      </div>

      {/* Error banner */}
      {call.error && (
        <div className="px-3 pb-2">
          <div className="rounded-lg bg-danger/10 border border-danger/30 px-3 py-2">
            <p className="font-mono text-[10px] text-danger">{call.error}</p>
          </div>
        </div>
      )}

      {/* Controls bar */}
      <div className="border-t border-border bg-surface-2/40 px-3 py-2">
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          <ControlButton
            active={!call.micMuted}
            onClick={call.toggleMic}
            title={call.micMuted ? 'Unmute' : 'Mute'}
            icon={call.micMuted ? MicOff : Mic}
            danger={call.micMuted}
          />
          {call.mode === 'video' && (
            <ControlButton
              active={!call.cameraOff}
              onClick={call.toggleCamera}
              title={call.cameraOff ? 'Camera on' : 'Camera off'}
              icon={call.cameraOff ? VideoOff : Video}
              danger={call.cameraOff}
            />
          )}
          {call.mode === 'video' && call.cameraDevices.length > 1 && (
            <ControlButton
              active
              onClick={() => { void call.flipCamera() }}
              title="Switch camera"
              icon={SwitchCamera}
            />
          )}
          <ControlButton
            active={volume > 0}
            onClick={toggleSpeakerMute}
            title={volume === 0 ? 'Unmute speakers' : 'Mute speakers'}
            icon={volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2}
            danger={volume === 0}
          />
          <ControlButton
            active={showSettings}
            onClick={() => setShowSettings(s => !s)}
            title="Settings"
            icon={Settings2}
          />
          <div className="w-px h-6 bg-border mx-1" />
          <button
            type="button"
            onClick={call.leave}
            className="flex items-center gap-2 px-4 h-11 sm:h-9 rounded-lg bg-danger hover:bg-danger/90 text-white font-mono text-[11px] font-medium transition-all active:scale-[0.97] shadow-[0_0_0_1px_rgba(239,68,68,0.25)]"
            title="Leave call"
          >
            <PhoneOff className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            Leave
          </button>
        </div>
        {showSettings && (
          <div className="mt-2 pt-2 border-t border-border/50 flex flex-col gap-2">
            <VolumeRow volume={volume} onChange={handleVolumeChange} onToggleMute={toggleSpeakerMute} />
            <DeviceRow label="Microphone" devices={call.micDevices} selectedId={call.selectedMicId} onSelect={(id) => { void call.selectMic(id) }} />
            {call.mode === 'video' && (
              <DeviceRow label="Camera" devices={call.cameraDevices} selectedId={call.selectedCameraId} onSelect={(id) => { void call.selectCamera(id) }} />
            )}
          </div>
        )}
      </div>
    </div>
  )
  }

  // ── Panel header ───────────────────────────────────────────────────────

  const participantCount: number = remotePeers.length + (call.joined ? 1 : 0)
  const headerLabel: string = call.joined
    ? `${participantCount} in call${call.mode === 'video' ? ' · video' : ''}`
    : 'Call'

  const renderHeader = (): React.ReactElement => (
    <div
      className={`flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40 relative ${
        isPopout && !isMobile ? 'cursor-move select-none' : ''
      }`}
      onMouseDown={isPopout && !isMobile ? handleDragStart : undefined}
      onTouchStart={isPopout && !isMobile ? handleDragStart : undefined}
    >
      {/* Top-left resize handle (popout only) */}
      {isPopout && !isMobile && (
        <div
          className="absolute -top-1 -left-1 w-5 h-5 cursor-nw-resize z-10 flex items-center justify-center opacity-40 hover:opacity-100 transition-opacity"
          onMouseDown={handleResizeStart}
          onTouchStart={handleResizeStart}
          title="Resize"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted">
            <line x1="0" y1="10" x2="10" y2="0" stroke="currentColor" strokeWidth="1.5" />
            <line x1="0" y1="6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
            <line x1="0" y1="2" x2="2" y2="0" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </div>
      )}
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div
          className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${
            call.joined ? 'bg-accent/20 ring-1 ring-accent/40' : 'bg-accent/10'
          }`}
        >
          <Phone className="w-3 h-3 text-accent" />
        </div>
        <span className="font-mono text-[11px] text-text font-medium truncate">{headerLabel}</span>
        <span className="font-mono text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-warning/15 text-warning border border-warning/30 shrink-0">
          Beta
        </span>
        {call.joined && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(100,255,218,0.8)] animate-pulse shrink-0" />
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!isPopout && !isMobile && (
          <button
            type="button"
            onClick={popOut}
            className="p-1.5 rounded-md text-muted-light hover:text-accent hover:bg-accent/10 transition-colors"
            title="Pop out"
            aria-label="Pop out call"
          >
            <ExternalLink className="w-3.5 h-3.5" />
          </button>
        )}
        {isPopout && (
          <button
            type="button"
            onClick={dockBack}
            className="p-1.5 rounded-md text-muted-light hover:text-accent hover:bg-accent/10 transition-colors"
            title="Dock"
            aria-label="Dock call panel"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        )}
        {!isPopout && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="p-1.5 rounded-md text-muted-light hover:text-accent hover:bg-accent/10 transition-colors"
            title={open ? 'Collapse' : 'Expand'}
            aria-label={open ? 'Collapse call panel' : 'Expand call panel'}
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
        )}
      </div>
    </div>
  )

  // ── Unified render ─────────────────────────────────────────────────────
  // Single div with conditional classes — same pattern as ChatPanel. No
  // portal needed because `position: fixed` already takes the element out
  // of normal flow when popped out.

  const popoutActive: boolean = isPopout && !isMobile

  return (
    <div
      ref={popoutRef}
      className={`animate-fade-in-up ${
        popoutActive
          ? 'fixed z-50 rounded-2xl shadow-2xl border border-border bg-bg flex flex-col overflow-hidden'
          : 'glow-card overflow-hidden flex flex-col'
      }`}
      style={
        popoutActive
          ? {
              width: `${popoutSize.w}px`,
              height: `${popoutSize.h}px`,
              top: popoutPos ? `${popoutPos.y}px` : '10%',
              left: popoutPos ? `${popoutPos.x}px` : '20%',
            }
          : undefined
      }
    >
      {renderHeader()}

      {popoutActive ? (
        <div className="flex-1 min-h-0 flex flex-col">
          {call.joined ? renderActive() : renderPreJoin()}
        </div>
      ) : (
        <div className={`grid transition-all duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden min-h-0">
            <div className="flex flex-col">
              {call.joined ? renderActive() : renderPreJoin()}
            </div>
          </div>
        </div>
      )}

    </div>
  )
}

// ── Internal components ──────────────────────────────────────────────────

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  active?: boolean
  danger?: boolean
}
function ControlButton({ icon: Icon, onClick, title, active: _active = true, danger = false }: ControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-lg transition-all active:scale-[0.95] ${
        danger
          ? 'bg-danger/15 hover:bg-danger/25 text-danger ring-1 ring-danger/30'
          : 'bg-accent/10 hover:bg-accent/20 text-accent ring-1 ring-accent/20'
      }`}
    >
      <Icon className="w-5 h-5 sm:w-4 sm:h-4" />
    </button>
  )
}

interface VolumeRowProps {
  volume: number
  onChange: (v: number) => void
  onToggleMute: () => void
}
function VolumeRow({ volume, onChange, onToggleMute }: VolumeRowProps) {
  const Icon = volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2
  const percent = Math.round(volume * 100)
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-muted w-[70px] shrink-0">Volume</span>
      <button
        type="button"
        onClick={onToggleMute}
        className="shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-accent hover:bg-accent/10 transition-colors"
        aria-label={volume === 0 ? 'Unmute speakers' : 'Mute speakers'}
        title={volume === 0 ? 'Unmute speakers' : 'Mute speakers'}
      >
        <Icon className="w-3.5 h-3.5" />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={percent}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        className="flex-1 min-w-0 accent-accent cursor-pointer"
        aria-label="Remote volume"
      />
      <span className="font-mono text-[10px] text-muted w-9 text-right tabular-nums">{percent}%</span>
    </div>
  )
}

interface DeviceRowProps {
  label: string
  devices: MediaDeviceInfo[]
  selectedId: string | null
  onSelect: (id: string) => void
}
function DeviceRow({ label, devices, selectedId, onSelect }: DeviceRowProps) {
  return (
    <label className="flex items-center gap-2">
      <span className="font-mono text-[10px] text-muted w-[70px] shrink-0">{label}</span>
      <select
        value={selectedId || (devices[0]?.deviceId || '')}
        onChange={(e) => onSelect(e.target.value)}
        className="flex-1 min-w-0 bg-bg border border-border rounded-md font-mono text-[10px] text-text px-2 py-1 focus:outline-none focus:border-accent/50 cursor-pointer truncate"
      >
        {devices.length === 0 && <option value="">No devices</option>}
        {devices.map(d => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${label} ${d.deviceId.slice(0, 6)}`}
          </option>
        ))}
      </select>
    </label>
  )
}
