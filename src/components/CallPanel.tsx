import { useState, useEffect, useRef, useCallback, useMemo, type ComponentProps } from 'react'
import { Mic, MicOff, Video, VideoOff, PhoneOff, Phone, Minimize2, ExternalLink, Settings2, ChevronDown, Volume2, Volume1, VolumeX, SwitchCamera, AlertTriangle, Loader2, RefreshCw, X, WifiOff, MonitorUp, MonitorOff } from 'lucide-react'
import { UseCallReturn } from '../hooks/useCall'
import { useViewport } from '../hooks/useViewport'
import { usePopout } from '../hooks/usePopout'
import { useSpeakingLevels, useSpeakingLevel, StreamEntry, SpeakingLevels } from '../hooks/useSpeakingLevels'
import { ensureAudioContextRunning } from '../utils/audioContext'
import VideoTile from './VideoTile'
import AudioTile from './AudioTile'

// H12: subscriber wrappers so a per-tile speaking-level update only re-renders
// that one tile. Before this, `useSpeakingLevels` set React state on
// CallPanel ~8×/sec which cascaded to every VideoTile + AudioTile child
// (~160 tile renders/sec at 20 peers in audio mode). Each wrapper subscribes
// to its own id via `useSpeakingLevel`; a level change on peer A leaves
// peers B-T's tiles untouched.
type VideoTileBaseProps = Omit<ComponentProps<typeof VideoTile>, 'level'>
type AudioTileBaseProps = Omit<ComponentProps<typeof AudioTile>, 'level'>

function LeveledVideoTile({ controller, levelId, ...rest }: VideoTileBaseProps & { controller: SpeakingLevels; levelId: string }) {
  const level = useSpeakingLevel(controller, levelId)
  return <VideoTile {...rest} level={level} />
}

function LeveledAudioTile({ controller, levelId, ...rest }: AudioTileBaseProps & { controller: SpeakingLevels; levelId: string }) {
  const level = useSpeakingLevel(controller, levelId)
  return <AudioTile {...rest} level={level} />
}

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
    const selfFocused = manualFocusId === 'self' && call.joined && (call.mode === 'video' || call.screenSharing)
    const remoteFocused = call.remotePeers.some(p => p.peerId === manualFocusId && (p.mode === 'video' || p.screenSharing))
    if (!selfFocused && !remoteFocused) setManualFocusId(null)
  }, [manualFocusId, call.remotePeers, call.joined, call.mode, call.screenSharing])

  // Auto-focus the first remote peer who starts sharing. Keeps the UX
  // "screen shares take center stage" without clobbering a manual focus
  // the user already picked. We track the last peer set we auto-focused
  // for so repeated renders don't re-focus endlessly.
  const lastAutoFocusedSharerRef = useRef<string | null>(null)
  useEffect(() => {
    const sharer = call.remotePeers.find(p => p.screenSharing)
    if (!sharer) {
      lastAutoFocusedSharerRef.current = null
      return
    }
    if (sharer.peerId === lastAutoFocusedSharerRef.current) return
    lastAutoFocusedSharerRef.current = sharer.peerId
    // Only override when nothing is currently focused — respect the user.
    if (manualFocusId === null) setManualFocusId(sharer.peerId)
  }, [call.remotePeers, manualFocusId])

  const remotePeers = call.remotePeers
  // A peer with screenSharing but stale mode='audio' still deserves a video
  // tile — otherwise a dropped call-track-state packet hides their share.
  const videoRemotes = remotePeers.filter(p => p.mode === 'video' || p.screenSharing)
  const audioRemotes = remotePeers.filter(p => p.mode !== 'video' && !p.screenSharing)
  // Include screen-share so the self preview tile renders while sharing
  // even when the local camera is off (call.mode stays 'audio' because
  // useLocalMedia never switched — the screen track lives in screenStream).
  const showLocalVideo: boolean = call.mode === 'video' || call.screenSharing

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


  // ── Pre-join screen ────────────────────────────────────────────────────

  const renderPreJoin = (): React.ReactElement => {
    const lastReason = call.endReason
    // U1: skip the banner for explicit user leaves — users who just tapped
    // Leave know they left; surfacing it again is noise.
    const showEndReason = lastReason !== null && lastReason !== 'user-left'
    return (
    <div className="flex flex-col items-center justify-center gap-5 py-6 px-4 text-center">
      <div className="w-14 h-14 rounded-2xl glass-accent flex items-center justify-center">
        <Phone className="w-6 h-6 text-accent" strokeWidth={1.75} />
      </div>
      <div>
        <p className="font-mono text-sm text-text font-medium">Start a call</p>
        <p className="font-mono text-[10px] text-muted mt-1">Mic on, camera off — toggle anytime.</p>
      </div>

      {showEndReason && lastReason && (
        <div className="flex items-start gap-2 max-w-[300px] w-full bg-surface-2/60 border border-border rounded-lg px-3 py-2 text-left">
          <div className="shrink-0 mt-0.5">
            {lastReason === 'connection-lost' && <WifiOff className="w-3.5 h-3.5 text-warning" />}
            {lastReason === 'rejected' && <AlertTriangle className="w-3.5 h-3.5 text-danger" />}
            {lastReason === 'host-ended' && <PhoneOff className="w-3.5 h-3.5 text-muted" />}
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
        disabled={disabled || call.joining || isConnectionDead || isReconnecting}
        // U7/U8: explain WHY the button is unavailable so the user isn't
        // staring at a dead button wondering what went wrong.
        title={joinDisabledTooltip(disabled, call.joining, isConnectionDead, isReconnecting)}
        className="w-full max-w-[260px] flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-accent/15 hover:bg-accent/25 border border-accent/30 text-accent font-mono text-xs font-medium transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
      >
        {call.joining ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Phone className="w-3.5 h-3.5" />}
        {call.joining ? 'Joining…' : 'Join Call'}
      </button>

      {/* U6: pre-join status line reflects the true transport state. */}
      <p className="font-mono text-[10px] text-muted/60">
        {isReconnecting
          ? 'Reconnecting…'
          : isConnectionDead
          ? 'Connection closed'
          : remotePeers.length > 0
          ? `${remotePeers.length} already in call`
          : 'No one is in the call yet'}
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
      screenShare: boolean
    }
    const videoTiles: VideoTileInfo[] = []
    if (showLocalVideo) {
      // When screen-sharing, the outgoing video sender carries the screen
      // track but the LOCAL preview keeps rendering the camera feed (so the
      // sharer still sees themselves as a small self-check). Preview stream
      // prefers the screen capture so the user sees what peers see.
      videoTiles.push({
        id: 'self',
        isSelf: true,
        name: myName,
        stream: call.screenSharing ? (call.screenStream ?? call.localStream) : call.localStream,
        micMuted: call.micMuted,
        cameraOff: call.cameraOff && !call.screenSharing,
        connecting: false,
        screenShare: call.screenSharing,
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
        screenShare: p.screenSharing,
      })
    })
    // Focus is fully manual. Auto active-speaker focus was removed because
    // the switching jitter hurt the UX more than the convenience helped.
    const focusedTile: VideoTileInfo | null = manualFocusId
      ? videoTiles.find(v => v.id === manualFocusId) ?? null
      : null

    // P3: precompute the mini-tile index in a single O(n) pass instead of
    // doing an O(n) filter+findIndex inside every map iteration below.
    const miniIndexById = new Map<string, number>()
    if (focusedTile) {
      let i = 0
      for (const t of videoTiles) {
        if (t.id !== focusedTile.id) {
          miniIndexById.set(t.id, i++)
        }
      }
    }

    const handleFocusToggle = (id: string): void => {
      setManualFocusId(prev => prev === id ? null : id)
    }
    const handleUnfocus = (): void => {
      setManualFocusId(null)
    }

    return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Screen-share banner — reassures the sharer that the capture is
          live and gives a one-tap exit without hunting for the toolbar. */}
      {call.screenSharing && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-accent/10 border border-accent/30 px-3 py-2">
            <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" aria-hidden="true" />
            <MonitorUp className="w-3.5 h-3.5 text-accent shrink-0" />
            <p className="font-mono text-[10px] text-accent flex-1">
              You&apos;re sharing your screen
            </p>
            <button
              type="button"
              onClick={() => call.stopScreenShare()}
              className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-danger/90 hover:bg-danger text-white font-mono text-[10px] transition-colors"
              aria-label="Stop screen share"
              title="Stop sharing"
            >
              <MonitorOff className="w-3 h-3" />
              Stop
            </button>
          </div>
        </div>
      )}

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

      {/* Soft cap warning — informational, dismissible per surge. */}
      {call.overSoftVideoCap && !softCapDismissed && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-info/10 border border-info/30 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-info shrink-0" />
            <p className="font-mono text-[10px] text-info/90 flex-1">
              {call.videoTileCount} video tiles — bandwidth may suffer above {call.softVideoCap}.
            </p>
            <button
              type="button"
              onClick={() => setSoftCapDismissed(true)}
              className="shrink-0 text-info/70 hover:text-info transition-colors"
              aria-label="Dismiss bandwidth warning"
              title="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {videoTiles.length > 0 && (
        <div className="px-3 pt-3 pb-2">
          {/* Unified, stable render tree: every VideoTile instance stays
              mounted across focus changes, the wrapper's style is swapped
              instead of swapping parent divs. Keeping the underlying
              <video> element alive is what stops the local preview from
              freezing on mobile when the user taps between tiles quickly. */}
          <div
            className={focusedTile ? 'relative' : 'grid gap-2 items-center'}
            style={focusedTile ? undefined : {
              gridTemplateColumns: videoTiles.length === 1 ? '1fr' : 'repeat(2, 1fr)',
            }}
          >
            {videoTiles.map(v => {
              const isFocused = focusedTile?.id === v.id
              const isMini = !!focusedTile && !isFocused
              const miniIdx = isMini ? (miniIndexById.get(v.id) ?? -1) : -1
              // Mini tile layout: width 96px, height ≈ 54 (16/9), vertical
              // footprint 60px (tile + gap). Wrap to a new column every
              // MINI_PER_COL tiles so a crowded focus view doesn't escape
              // the parent's vertical bounds.
              const MINI_PER_COL = 4
              const miniCol = isMini ? Math.floor(miniIdx / MINI_PER_COL) : 0
              const miniRow = isMini ? miniIdx % MINI_PER_COL : 0
              const wrapperStyle: React.CSSProperties | undefined = focusedTile
                ? (isFocused
                    ? { position: 'relative', zIndex: 1, width: '100%' }
                    : {
                        position: 'absolute',
                        top: `${8 + miniRow * 60}px`,
                        left: `${8 + miniCol * 104}px`,
                        width: '96px',
                        zIndex: 10,
                      })
                : undefined
              return (
                <div key={v.id} style={wrapperStyle}>
                  <LeveledVideoTile
                    controller={speakingLevels}
                    levelId={v.id}
                    stream={v.stream}
                    name={v.name}
                    self={v.isSelf}
                    micMuted={v.micMuted}
                    cameraOff={v.cameraOff}
                    connecting={v.connecting}
                    volume={v.isSelf ? 1 : volume}
                    mutedForMe={!v.isSelf && mutedForMe.has(v.id)}
                    onToggleMutedForMe={v.isSelf ? undefined : () => togglePeerMute(v.id)}
                    focused={isFocused}
                    mini={isMini}
                    onToggleFocus={isFocused ? handleUnfocus : () => handleFocusToggle(v.id)}
                    screenShare={v.screenShare}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2">
        <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5">
          {call.mode === 'audio' && (
            <LeveledAudioTile
              controller={speakingLevels}
              levelId="self"
              stream={call.localStream}
              name={myName}
              self
              micMuted={call.micMuted}
            />
          )}
          {audioRemotes.map(p => (
            <LeveledAudioTile
              key={p.peerId}
              controller={speakingLevels}
              levelId={p.peerId}
              stream={p.stream}
              name={p.name}
              micMuted={p.micMuted}
              volume={volume}
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

      {call.screenShareError && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2">
            <MonitorOff className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
            <p className="flex-1 font-mono text-[10px] text-warning">{call.screenShareError.message}</p>
            <button
              type="button"
              onClick={call.dismissScreenShareError}
              className="shrink-0 text-warning/60 hover:text-warning transition-colors"
              aria-label="Dismiss screen share error"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {call.screenAudioShared && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 rounded-lg bg-surface-2 border border-border px-3 py-2">
            <p className="flex-1 font-mono text-[10px] text-muted-light">
              Sharing tab audio. If the shared tab is playing another call, peers may hear themselves echoed back. Mute the shared tab or stop sharing audio to fix.
            </p>
          </div>
        </div>
      )}

      <div className="border-t border-border bg-surface-2/40 px-3 py-2">
        <div className="flex items-center justify-center gap-1.5 flex-wrap">
          <ControlButton
            onClick={call.toggleMic}
            title={call.micMuted ? 'Unmute' : 'Mute'}
            icon={call.micMuted ? MicOff : Mic}
            danger={call.micMuted}
          />
          <ControlButton
            onClick={call.toggleCamera}
            title={
              call.screenSharing
                ? 'Camera is unavailable while sharing'
                : call.cameraStarting ? 'Camera starting…'
                : call.cameraOff ? 'Turn camera on' : 'Turn camera off'
            }
            icon={call.cameraStarting ? Loader2 : call.cameraOff ? VideoOff : Video}
            danger={call.cameraOff}
            disabled={call.cameraStarting || call.screenSharing}
            spinning={call.cameraStarting}
          />
          {call.mode === 'video' && call.cameraDevices.length > 1 && (
            <ControlButton
              onClick={() => { void call.flipCamera() }}
              title="Switch camera"
              icon={SwitchCamera}
            />
          )}
          {!isMobile && (
            <ControlButton
              onClick={() => {
                if (call.screenSharing) call.stopScreenShare()
                else void call.startScreenShare()
              }}
              title={
                call.screenShareStarting
                  ? 'Starting screen share…'
                  : call.screenSharing
                    ? 'Stop sharing'
                    : 'Share screen'
              }
              icon={call.screenShareStarting ? Loader2 : call.screenSharing ? MonitorOff : MonitorUp}
              danger={call.screenSharing}
              disabled={call.screenShareStarting}
              spinning={call.screenShareStarting}
            />
          )}
          <ControlButton
            onClick={toggleSpeakerMute}
            title={volume === 0 ? 'Unmute speakers' : 'Mute speakers'}
            icon={volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2}
            danger={volume === 0}
          />
          <ControlButton
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
        isPopout && !isMobile ? 'cursor-move select-none' : 'cursor-pointer select-none'
      }`}
      onMouseDown={isPopout && !isMobile ? popout.onDragStart : undefined}
      onTouchStart={isPopout && !isMobile ? popout.onDragStart : undefined}
      onClick={!isPopout ? () => setOpen(o => !o) : undefined}
      role={!isPopout ? 'button' : undefined}
      tabIndex={!isPopout ? 0 : undefined}
      aria-expanded={!isPopout ? open : undefined}
      onKeyDown={!isPopout ? e => {
        if (e.target !== e.currentTarget) return
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setOpen(o => !o)
        }
      } : undefined}
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
      <div className="flex items-center gap-2 min-w-0 flex-1">
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
      </div>
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

function joinDisabledTooltip(disabled: boolean, joining: boolean, connectionDead: boolean, reconnecting: boolean): string | undefined {
  if (joining) return 'Joining — check your browser permission prompt'
  if (reconnecting) return 'Reconnecting to the session…'
  if (connectionDead) return 'Connection closed — refresh the page to rejoin'
  if (disabled) return 'Not available right now'
  return undefined
}

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  danger?: boolean
  disabled?: boolean
  spinning?: boolean
}
function ControlButton({ icon: Icon, onClick, title, danger = false, disabled = false, spinning = false }: ControlButtonProps) {
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
