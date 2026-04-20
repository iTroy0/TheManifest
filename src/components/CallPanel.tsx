import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Phone, Minimize2, ExternalLink, ChevronDown } from 'lucide-react'
import { UseCallReturn } from '../hooks/useCall'
import { useViewport } from '../hooks/useViewport'
import { usePopout } from '../hooks/usePopout'
import { useSpeakingLevels, StreamEntry } from '../hooks/useSpeakingLevels'
import CallPreJoin from './call/CallPreJoin'
import CallActive from './call/CallActive'

// Loose union — three different parent hooks (sender / receiver / collab)
// supply their own status unions, so we accept `string` as an escape hatch
// while keeping the known values discoverable in IntelliSense.
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
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  | (string & {})

interface CallPanelProps {
  call: UseCallReturn
  myName: string
  disabled?: boolean
  connectionStatus?: CallPanelConnectionStatus
}

const POPOUT_DEFAULT = { w: 420, h: 520 }
const POPOUT_MIN = { w: 320, h: 360 }

export default function CallPanel({ call, myName, disabled = false, connectionStatus }: CallPanelProps) {
  const [open, setOpen] = useState<boolean>(false)
  const [showSettings, setShowSettings] = useState<boolean>(false)
  const { isMobile } = useViewport()
  // Screen-share affordance gates on capability, not viewport width. A
  // narrow desktop window or a popout call panel dips below the mobile
  // breakpoint but still has getDisplayMedia — the old isMobile check
  // disabled the button for those users.
  const screenShareSupported = typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia
  const popout = usePopout({ defaultSize: POPOUT_DEFAULT, minSize: POPOUT_MIN })
  const { isPopout, pos: popoutPos, size: popoutSize, popOut, dockBack } = popout
  // Master remote-volume (0–1). Ephemeral on purpose — we don't persist it.
  const [volume, setVolume] = useState<number>(1)
  const lastNonZeroVolumeRef = useRef<number>(1)
  const [manualFocusId, setManualFocusId] = useState<string | null>(null)
  // Peers the local listener has silenced. Independent of master volume.
  const [mutedForMe, setMutedForMe] = useState<Set<string>>(new Set())
  const togglePeerMute = useCallback((peerId: string): void => {
    setMutedForMe(prev => {
      const next = new Set(prev)
      if (next.has(peerId)) next.delete(peerId)
      else next.add(peerId)
      return next
    })
  }, [])
  // U2: dismissed state for the soft-cap informational banner. Reset when
  // the count drops under the cap OR when it grows beyond the last seen
  // count, so both recovery and further surges re-surface the warning.
  const [softCapDismissed, setSoftCapDismissed] = useState<boolean>(false)
  const lastTileCountRef = useRef<number>(0)
  useEffect(() => {
    if (!call.overSoftVideoCap) {
      setSoftCapDismissed(false)
    } else if (call.videoTileCount > lastTileCountRef.current) {
      setSoftCapDismissed(false)
    }
    lastTileCountRef.current = call.videoTileCount
  }, [call.overSoftVideoCap, call.videoTileCount])

  // Echo-warning dismiss — sticky for the life of a single share. Reset on
  // the rising edge of `screenAudioShared` so the next share re-surfaces the
  // warning even if the user dismissed it last time.
  const [echoWarningDismissed, setEchoWarningDismissed] = useState<boolean>(false)
  const prevScreenAudioSharedRef = useRef<boolean>(false)
  useEffect(() => {
    if (call.screenAudioShared && !prevScreenAudioSharedRef.current) {
      setEchoWarningDismissed(false)
    }
    prevScreenAudioSharedRef.current = call.screenAudioShared
  }, [call.screenAudioShared])

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
  }, [isConnectionDead, call.joined, call.leave])

  // U4: Escape-to-unfocus. Only subscribe while a tile is focused — keeps
  // us out of the keyboard event bus when there's nothing to handle.
  useEffect(() => {
    if (!manualFocusId) return
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setManualFocusId(null)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [manualFocusId])

  // Drop focus when the focused peer leaves, so a rejoin with the same id
  // doesn't silently restore focus.
  useEffect(() => {
    if (!manualFocusId) return
    const selfFocused = (manualFocusId === 'self' && call.joined && call.mode === 'video')
      || (manualFocusId === 'self:screen' && call.joined && call.screenSharing)
    const remotePresent = call.remotePeers.some(p => {
      if (manualFocusId === `${p.peerId}:screen`) return !!p.screenStream
      return p.peerId === manualFocusId && p.mode === 'video'
    })
    if (!selfFocused && !remotePresent) setManualFocusId(null)
  }, [manualFocusId, call.remotePeers, call.joined, call.mode, call.screenSharing])

  // Auto-focus the first remote peer's screen tile when they start sharing.
  // Keeps the UX "screen shares take center stage" without clobbering a
  // manual focus the user already picked.
  const lastAutoFocusedSharerRef = useRef<string | null>(null)
  useEffect(() => {
    const sharer = call.remotePeers.find(p => p.screenStream)
    if (!sharer) {
      lastAutoFocusedSharerRef.current = null
      return
    }
    const focusId = `${sharer.peerId}:screen`
    if (focusId === lastAutoFocusedSharerRef.current) return
    lastAutoFocusedSharerRef.current = focusId
    if (manualFocusId === null) setManualFocusId(focusId)
  }, [call.remotePeers, manualFocusId])

  const remotePeers = call.remotePeers
  // Audio tile strip: peers who aren't sending video and aren't sharing
  // screen. Camera + screen derivations live inside VideoTileGrid.
  const audioRemotes = remotePeers.filter(p => p.mode !== 'video' && !p.screenStream)

  // Speaking levels: one shared analyser graph drives every tile's pulse.
  const speakingEntries: StreamEntry[] = useMemo(() => {
    const entries: StreamEntry[] = []
    if (call.localStream && call.joined) {
      entries.push({ id: 'self', stream: call.localStream, skip: call.micMuted })
    }
    remotePeers.forEach(p => {
      entries.push({ id: p.peerId, stream: p.stream, skip: p.micMuted })
    })
    return entries
  }, [call.localStream, call.joined, call.micMuted, remotePeers])

  const speakingLevels = useSpeakingLevels(speakingEntries)

  const handleFocusToggle = useCallback((id: string): void => {
    setManualFocusId(prev => prev === id ? null : id)
  }, [])
  const handleUnfocus = useCallback((): void => {
    setManualFocusId(null)
  }, [])
  const handleToggleSettings = useCallback((): void => {
    setShowSettings(s => !s)
  }, [])
  const handleDismissSoftCap = useCallback((): void => {
    setSoftCapDismissed(true)
  }, [])
  const handleDismissEchoWarning = useCallback((): void => {
    setEchoWarningDismissed(true)
  }, [])

  // ── Panel header ───────────────────────────────────────────────────────

  const participantCount: number = remotePeers.length + (call.joined ? 1 : 0)
  const headerLabel: string = call.joined
    ? `${participantCount} in call${call.mode === 'video' ? ' · video' : ''}`
    : 'Call'

  // Header layout: a wrapper div carries drag (popout) + the row container,
  // a real `<button>` carries the toggle/expand semantics for the title area.
  // Side actions (pop-out / dock / etc.) sit as siblings of the title button,
  // not nested inside it — so screen readers no longer hear a button-in-button.
  const titleContent = (
    <>
      <div
        className={`w-6 h-6 rounded-md flex items-center justify-center shrink-0 ${
          call.joined ? 'bg-accent/20 ring-1 ring-accent/40' : 'bg-accent/10'
        }`}
      >
        <Phone className="w-3 h-3 text-accent" />
      </div>
      <span className="font-mono text-[11px] text-text font-medium truncate">{headerLabel}</span>
      {call.joined && !isReconnecting && (
        <span className="w-1.5 h-1.5 rounded-full bg-accent shadow-[0_0_8px_rgba(34,211,238,0.9)] animate-pulse shrink-0" />
      )}
      {isReconnecting && (
        <span className="w-1.5 h-1.5 rounded-full bg-warning shadow-[0_0_6px_rgba(250,204,21,0.8)] animate-pulse shrink-0" />
      )}
    </>
  )

  const renderHeader = (): React.ReactElement => (
    <div
      className={`flex items-center justify-between px-3 py-2 border-b border-border bg-surface-2/40 relative ${
        isPopout && !isMobile ? 'cursor-move select-none' : 'cursor-pointer select-none'
      }`}
      onMouseDown={isPopout && !isMobile ? popout.onDragStart : undefined}
      onTouchStart={isPopout && !isMobile ? popout.onDragStart : undefined}
      // Click-anywhere-to-toggle is a UX power-user shortcut. Screen-reader
      // users get the same affordance through the explicit title button
      // below (which carries the aria-expanded / aria-label semantics).
      onClick={!isPopout ? () => setOpen(o => !o) : undefined}
    >
      {isPopout && !isMobile && (
        <div
          role="separator"
          aria-label="Resize call panel"
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
      {!isPopout ? (
        // Title is the screen-reader / keyboard handle for the toggle. The
        // outer div's onClick provides the same toggle for pointer users.
        // Stop propagation here so we don't run setOpen twice on a click.
        <button
          type="button"
          onClick={e => { e.stopPropagation(); setOpen(o => !o) }}
          aria-expanded={open}
          aria-label={open ? 'Collapse call panel' : 'Expand call panel'}
          className="flex items-center gap-2 min-w-0 flex-1 text-left cursor-pointer"
        >
          {titleContent}
        </button>
      ) : (
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {titleContent}
        </div>
      )}
      <div className="flex items-center gap-1 shrink-0">
        {!isPopout && !isMobile && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); popOut() }}
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
            onClick={e => { e.stopPropagation(); dockBack() }}
            className="p-1.5 rounded-md text-muted-light hover:text-accent hover:bg-accent/10 transition-colors"
            title="Dock"
            aria-label="Dock call panel"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
        )}
        {!isPopout && (
          // Chevron is purely visual affordance now — the whole bar toggles.
          // We still render it as a focusable button for keyboard users, but
          // it bubbles up to the bar's onClick instead of double-toggling.
          <div
            className="p-1.5 rounded-md text-muted-light pointer-events-none"
            aria-hidden="true"
          >
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
          </div>
        )}
      </div>
    </div>
  )

  const popoutActive: boolean = isPopout && !isMobile

  const body: React.ReactElement = call.joined
    ? (
      <CallActive
        call={call}
        myName={myName}
        connectionStatus={connectionStatus}
        isReconnecting={isReconnecting}
        manualFocusId={manualFocusId}
        onFocusToggle={handleFocusToggle}
        onUnfocus={handleUnfocus}
        speakingLevels={speakingLevels}
        volume={volume}
        onVolumeChange={handleVolumeChange}
        onToggleSpeakerMute={toggleSpeakerMute}
        mutedForMe={mutedForMe}
        onTogglePeerMute={togglePeerMute}
        softCapDismissed={softCapDismissed}
        onDismissSoftCap={handleDismissSoftCap}
        echoWarningDismissed={echoWarningDismissed}
        onDismissEchoWarning={handleDismissEchoWarning}
        showSettings={showSettings}
        onToggleSettings={handleToggleSettings}
        screenShareSupported={screenShareSupported}
        audioRemotes={audioRemotes}
        remotePeersCount={remotePeers.length}
      />
    )
    : (
      <CallPreJoin
        call={call}
        disabled={disabled}
        isConnectionDead={isConnectionDead}
        isReconnecting={isReconnecting}
        remotePeersCount={remotePeers.length}
      />
    )

  return (
    <div
      ref={popout.elementRef}
      className={`animate-fade-in-up ${
        popoutActive
          ? 'fixed z-[60] rounded-2xl shadow-2xl border border-border bg-bg flex flex-col overflow-hidden'
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
          {body}
        </div>
      ) : (
        <div className={`grid transition-all duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden min-h-0">
            <div className="flex flex-col">
              {body}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
