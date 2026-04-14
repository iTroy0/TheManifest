import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Mic, MicOff, Video, VideoOff, PhoneOff, Phone, Minimize2, ExternalLink, Settings2, ChevronDown, Volume2, Volume1, VolumeX, SwitchCamera, AlertTriangle, Loader2, RefreshCw, X, WifiOff } from 'lucide-react'
import { UseCallReturn } from '../hooks/useCall'
import { useViewport } from '../hooks/useViewport'
import { usePopout } from '../hooks/usePopout'
import { useSpeakingLevels, StreamEntry } from '../hooks/useSpeakingLevels'
import { ensureAudioContextRunning } from '../utils/audioContext'
import VideoTile from './VideoTile'
import AudioTile from './AudioTile'

// Lifecycle states the parent connection can be in. We accept the loose
// receiver/sender status strings rather than imposing a tighter union here.
export type CallPanelConnectionStatus =
  | 'connecting'
  | 'retrying'
  | 'reconnecting'
  | 'connected'
  | 'manifest-received'
  | 'transferring'
  | 'waiting'
  | 'done'
  | 'closed'
  | 'rejected'
  | 'error'
  | 'direct-failed'
  | string

interface CallPanelProps {
  call: UseCallReturn
  myName: string
  myPeerId: string | null
  disabled?: boolean
  // Connection state from the host receiver/sender hook. Drives the
  // reconnect banner and forces a clean leave when the underlying transport
  // dies. Optional so existing callers compile during the migration.
  connectionStatus?: CallPanelConnectionStatus
}

const POPOUT_DEFAULT = { w: 420, h: 520 }
const POPOUT_MIN = { w: 320, h: 360 }

export default function CallPanel({ call, myName, disabled = false, connectionStatus }: CallPanelProps) {
  const [open, setOpen] = useState<boolean>(false)
  const [showSettings, setShowSettings] = useState<boolean>(false)
  const { isMobile } = useViewport()
  const popout = usePopout({ defaultSize: POPOUT_DEFAULT, minSize: POPOUT_MIN })
  const { isPopout, pos: popoutPos, size: popoutSize, popOut, dockBack } = popout
  // Master remote-volume (0–1). Applied to every remote tile. Ephemeral on
  // purpose — we don't persist to localStorage (privacy ethos).
  const [volume, setVolume] = useState<number>(1)
  const lastNonZeroVolumeRef = useRef<number>(1)
  // Manual focus state. When the user explicitly focuses a tile, auto
  // active-speaker switching is suspended until they unfocus.
  const [manualFocusId, setManualFocusId] = useState<string | null>(null)
  // Per-peer mute set — peers the local listener has silenced. Independent
  // of the master volume slider and of the peer's own mic state. Cleared
  // automatically when the peer leaves (filtered on read).
  const [mutedForMe, setMutedForMe] = useState<Set<string>>(new Set())
  const togglePeerMute = useCallback((peerId: string): void => {
    setMutedForMe(prev => {
      const next = new Set(prev)
      if (next.has(peerId)) next.delete(peerId)
      else next.add(peerId)
      return next
    })
  }, [])

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

  useEffect(() => {
    if (isPopout) setOpen(true)
  }, [isPopout])

  // Reconnect banner — visible when the parent connection is reconnecting
  // or transiently dead. We don't auto-leave the call here; useCall already
  // tears down on `peer` change. This is just user-facing communication.
  const isReconnecting: boolean = connectionStatus === 'reconnecting' || connectionStatus === 'retrying'
  const isConnectionDead: boolean = connectionStatus === 'closed' || connectionStatus === 'error' || connectionStatus === 'rejected'

  // Force-leave when the underlying transport is gone — keeps audio from
  // limping along with no signaling backbone.
  useEffect(() => {
    if (isConnectionDead && call.joined) {
      call.leave('connection-lost')
    }
  }, [isConnectionDead, call])

  const remotePeers = call.remotePeers
  // Tile classification is now derived from the peer's *current* mode (which
  // useCall keeps in sync with track-state messages and stream contents),
  // not a frozen-at-join-time value.
  const videoRemotes = remotePeers.filter(p => p.mode === 'video')
  const audioRemotes = remotePeers.filter(p => p.mode !== 'video')
  const showLocalVideo: boolean = call.mode === 'video'

  // ── Speaking levels — single shared analyser graph for everyone ────────
  // We sample every remote audio stream plus self (so the local "you're
  // talking" hint stays accurate). Self is sampled but excluded from active-
  // speaker auto-focus below.
  const speakingEntries: StreamEntry[] = useMemo(() => {
    const entries: StreamEntry[] = []
    if (call.localStream && call.joined) {
      entries.push({ id: 'self', stream: call.localStream, skip: call.micMuted })
    }
    remotePeers.forEach(p => {
      entries.push({ id: p.peerId, stream: p.stream, skip: p.micMuted })
    })
    return entries
    // localStream identity changes on restart; remotePeers re-derives on each
    // roster mutation.
  }, [call.localStream, call.joined, call.micMuted, remotePeers])

  const levels = useSpeakingLevels(speakingEntries)

  // Feed levels back to useCall for active-speaker selection. Only the
  // remote levels matter for spotlight selection, AND we exclude peers
  // the listener has muted — auto-focusing someone you can't hear would
  // be misleading.
  useEffect(() => {
    const remoteOnly: Record<string, number> = {}
    for (const [id, level] of Object.entries(levels)) {
      if (id === 'self') continue
      if (mutedForMe.has(id)) continue
      remoteOnly[id] = level
    }
    call.reportSpeakingLevels(remoteOnly)
  }, [levels, mutedForMe, call])

  // ── Pre-join screen ────────────────────────────────────────────────────

  const renderPreJoin = (): React.ReactElement => {
    const lastReason = call.endReason
    return (
    <div className="flex flex-col items-center justify-center gap-5 py-6 px-4 text-center">
      <div className="w-14 h-14 rounded-2xl bg-accent/10 flex items-center justify-center ring-2 ring-accent/20">
        <Phone className="w-6 h-6 text-accent" strokeWidth={1.75} />
      </div>
      <div>
        <p className="font-mono text-sm text-text font-medium">Start a call</p>
        <p className="font-mono text-[10px] text-muted mt-1">Mic on, camera off — toggle anytime.</p>
      </div>

      {/* Post-call reason banner. Honest about why we're back here. */}
      {lastReason && (
        <div className="flex items-start gap-2 max-w-[300px] w-full bg-surface-2/60 border border-border rounded-lg px-3 py-2 text-left">
          <div className="shrink-0 mt-0.5">
            {lastReason === 'connection-lost' && <WifiOff className="w-3.5 h-3.5 text-warning" />}
            {lastReason === 'rejected' && <AlertTriangle className="w-3.5 h-3.5 text-danger" />}
            {lastReason === 'host-ended' && <PhoneOff className="w-3.5 h-3.5 text-muted" />}
            {lastReason === 'user-left' && <PhoneOff className="w-3.5 h-3.5 text-muted" />}
            {lastReason === 'error' && <AlertTriangle className="w-3.5 h-3.5 text-danger" />}
          </div>
          <p className="flex-1 font-mono text-[10px] text-muted leading-relaxed">
            {endReasonLabel(lastReason)}
          </p>
          <button
            type="button"
            onClick={call.dismissEndReason}
            className="shrink-0 text-muted/60 hover:text-muted transition-colors"
            aria-label="Dismiss"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      {/* Structured error from a failed start. */}
      {call.error && (
        <div className="flex items-start gap-2 max-w-[300px] w-full bg-danger/10 border border-danger/30 rounded-lg px-3 py-2 text-left">
          <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
          <p className="flex-1 font-mono text-[10px] text-danger leading-relaxed">{call.error.message}</p>
          <button
            type="button"
            onClick={call.dismissError}
            className="shrink-0 text-danger/60 hover:text-danger transition-colors"
            aria-label="Dismiss error"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <button
        type="button"
        onClick={() => { ensureAudioContextRunning(); void call.join() }}
        disabled={disabled || call.joining || isConnectionDead}
        className="w-full max-w-[260px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-accent/15 hover:bg-accent/25 border border-accent/30 text-accent font-mono text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
      >
        {call.joining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
        {call.joining ? 'Joining…' : 'Join Call'}
      </button>

      <p className="font-mono text-[10px] text-muted/60">
        {remotePeers.length > 0 ? `${remotePeers.length} already in call` : 'No one is in the call yet'}
      </p>
    </div>
    )
  }

  // ── Active call content ────────────────────────────────────────────────

  const renderActive = (): React.ReactElement => {
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
    // Effective focus: manual override > auto active speaker (only when there
    // are 2+ video tiles, since auto-focus is meaningless on a single tile).
    const autoFocusId: string | null = videoTiles.length >= 2 && call.activeSpeakerId && videoTiles.some(v => v.id === call.activeSpeakerId)
      ? call.activeSpeakerId
      : null
    const effectiveFocus: string | null = manualFocusId && videoTiles.some(v => v.id === manualFocusId)
      ? manualFocusId
      : autoFocusId
    const focusedTile: VideoTileInfo | null = effectiveFocus ? videoTiles.find(v => v.id === effectiveFocus) || null : null
    const miniTiles: VideoTileInfo[] = focusedTile ? videoTiles.filter(v => v.id !== focusedTile.id) : []

    const handleFocusToggle = (id: string): void => {
      setManualFocusId(prev => prev === id ? null : id)
    }
    const handleUnfocus = (): void => {
      setManualFocusId(null)
    }

    const cameraButtonDisabled: boolean = call.cameraStarting

    return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Reconnect banner — visible whenever the underlying transport is
          flailing. Doesn't block the call UI; the audio that is still up
          keeps playing. */}
      {isReconnecting && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2">
            <RefreshCw className="w-3.5 h-3.5 text-warning animate-spin shrink-0" />
            <p className="font-mono text-[10px] text-warning flex-1">
              Reconnecting to {connectionStatus === 'retrying' ? 'host' : 'session'}…
            </p>
          </div>
        </div>
      )}

      {/* Soft cap warning — informational only; we don't block the join. */}
      {call.overSoftVideoCap && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-info/10 border border-info/30 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-info shrink-0" />
            <p className="font-mono text-[10px] text-info/90 flex-1">
              {call.videoTileCount} video tiles — bandwidth may suffer above {call.softVideoCap}.
            </p>
          </div>
        </div>
      )}

      {videoTiles.length > 0 && (
        <div className="px-3 pt-3 pb-2">
          {focusedTile ? (
            <div className="relative">
              <VideoTile
                stream={focusedTile.stream}
                name={focusedTile.name}
                self={focusedTile.isSelf}
                micMuted={focusedTile.micMuted}
                cameraOff={focusedTile.cameraOff}
                connecting={focusedTile.connecting}
                volume={focusedTile.isSelf ? 1 : volume}
                level={levels[focusedTile.id] || 0}
                mutedForMe={!focusedTile.isSelf && mutedForMe.has(focusedTile.id)}
                onToggleMutedForMe={focusedTile.isSelf ? undefined : () => togglePeerMute(focusedTile.id)}
                focused
                onToggleFocus={handleUnfocus}
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
                      level={levels[v.id] || 0}
                      mutedForMe={!v.isSelf && mutedForMe.has(v.id)}
                      mini
                      onToggleFocus={() => handleFocusToggle(v.id)}
                    />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div
              className="grid gap-2 items-center"
              style={{
                gridTemplateColumns: videoTiles.length === 1 ? '1fr' : videoTiles.length === 2 ? '1fr 1fr' : 'repeat(2, 1fr)',
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
                  level={levels[v.id] || 0}
                  mutedForMe={!v.isSelf && mutedForMe.has(v.id)}
                  onToggleMutedForMe={v.isSelf ? undefined : () => togglePeerMute(v.id)}
                  onToggleFocus={() => handleFocusToggle(v.id)}
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
            <AudioTile
              stream={call.localStream}
              name={myName}
              self
              micMuted={call.micMuted}
              level={levels['self'] || 0}
            />
          )}
          {audioRemotes.map(p => (
            <AudioTile
              key={p.peerId}
              stream={p.stream}
              name={p.name}
              micMuted={p.micMuted}
              volume={volume}
              level={levels[p.peerId] || 0}
              mutedForMe={mutedForMe.has(p.peerId)}
              onToggleMutedForMe={() => togglePeerMute(p.peerId)}
            />
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
          <div className="flex items-start gap-2 rounded-lg bg-danger/10 border border-danger/30 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
            <p className="flex-1 font-mono text-[10px] text-danger">{call.error.message}</p>
            <button
              type="button"
              onClick={call.dismissError}
              className="shrink-0 text-danger/60 hover:text-danger transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
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
          <ControlButton
            active={!call.cameraOff}
            onClick={call.toggleCamera}
            title={call.cameraStarting ? 'Camera starting…' : call.cameraOff ? 'Turn camera on' : 'Turn camera off'}
            icon={call.cameraStarting ? Loader2 : call.cameraOff ? VideoOff : Video}
            danger={call.cameraOff}
            disabled={cameraButtonDisabled}
            spinning={call.cameraStarting}
          />
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
            onClick={() => call.leave('user-left')}
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
      onMouseDown={isPopout && !isMobile ? popout.onDragStart : undefined}
      onTouchStart={isPopout && !isMobile ? popout.onDragStart : undefined}
    >
      {isPopout && !isMobile && (
        <div
          className="absolute -top-1 -left-1 w-5 h-5 cursor-nw-resize z-10 flex items-center justify-center opacity-40 hover:opacity-100 transition-opacity"
          onMouseDown={popout.onResizeStart}
          onTouchStart={popout.onResizeStart}
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
        {call.joined && !isReconnecting && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_6px_rgba(100,255,218,0.8)] animate-pulse shrink-0" />
        )}
        {isReconnecting && (
          <span className="w-1.5 h-1.5 rounded-full bg-warning shadow-[0_0_6px_rgba(250,204,21,0.8)] animate-pulse shrink-0" />
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

  const popoutActive: boolean = isPopout && !isMobile

  return (
    <div
      ref={popout.elementRef}
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

function endReasonLabel(reason: NonNullable<UseCallReturn['endReason']>): string {
  switch (reason) {
    case 'user-left': return 'You left the call.'
    case 'host-ended': return 'The host ended the call.'
    case 'connection-lost': return 'Call ended — connection lost.'
    case 'rejected': return 'Call join was rejected.'
    case 'error': return 'Call ended due to an error.'
    default: return 'Call ended.'
  }
}

// ── Internal components ──────────────────────────────────────────────────

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  active?: boolean
  danger?: boolean
  disabled?: boolean
  spinning?: boolean
}
function ControlButton({ icon: Icon, onClick, title, active: _active = true, danger = false, disabled = false, spinning = false }: ControlButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-lg transition-all active:scale-[0.95] disabled:opacity-50 disabled:cursor-not-allowed ${
        danger
          ? 'bg-danger/15 hover:bg-danger/25 text-danger ring-1 ring-danger/30'
          : 'bg-accent/10 hover:bg-accent/20 text-accent ring-1 ring-accent/20'
      }`}
    >
      <Icon className={`w-5 h-5 sm:w-4 sm:h-4 ${spinning ? 'animate-spin' : ''}`} />
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
