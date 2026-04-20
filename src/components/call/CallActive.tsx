import type { UseCallReturn } from '../../hooks/useCall'
import type { SpeakingLevels } from '../../hooks/useSpeakingLevels'
import type { RemotePeer } from '../../hooks/useCall'
import type { CallPanelConnectionStatus } from '../CallPanel'
import CallScreenShareBanner from './CallScreenShareBanner'
import CallTransportBanners from './CallTransportBanners'
import CallFooterBanners from './CallFooterBanners'
import CallControlBar from './CallControlBar'
import AudioTileStrip from './AudioTileStrip'
import VideoTileGrid from './VideoTileGrid'

interface CallActiveProps {
  call: UseCallReturn
  myName: string
  connectionStatus?: CallPanelConnectionStatus
  isReconnecting: boolean
  // Focus state + handlers (owned by CallPanel so Escape + auto-focus
  // effects can mutate focus from outside this tree).
  manualFocusId: string | null
  onFocusToggle: (id: string) => void
  onUnfocus: () => void
  // Shared analyser graph for every tile pulse.
  speakingLevels: SpeakingLevels
  // Volume controls (owned by CallPanel for popout persistence potential).
  volume: number
  onVolumeChange: (v: number) => void
  onToggleSpeakerMute: () => void
  // Per-peer silence, owned by CallPanel.
  mutedForMe: Set<string>
  onTogglePeerMute: (peerId: string) => void
  // Banner dismiss state, owned by CallPanel so the flags survive tile
  // remounts and auto-reset effects run at the panel level.
  softCapDismissed: boolean
  onDismissSoftCap: () => void
  echoWarningDismissed: boolean
  onDismissEchoWarning: () => void
  // Settings drawer open state + screen-share capability, both derived at
  // the panel level.
  showSettings: boolean
  onToggleSettings: () => void
  screenShareSupported: boolean
  // Precomputed derived slices of the roster consumed here.
  audioRemotes: RemotePeer[]
  remotePeersCount: number
}

export default function CallActive({
  call,
  myName,
  connectionStatus,
  isReconnecting,
  manualFocusId,
  onFocusToggle,
  onUnfocus,
  speakingLevels,
  volume,
  onVolumeChange,
  onToggleSpeakerMute,
  mutedForMe,
  onTogglePeerMute,
  softCapDismissed,
  onDismissSoftCap,
  echoWarningDismissed,
  onDismissEchoWarning,
  showSettings,
  onToggleSettings,
  screenShareSupported,
  audioRemotes,
  remotePeersCount,
}: CallActiveProps) {
  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Screen-share banner — reassures the sharer that the capture is
          live and gives a one-tap exit without hunting for the toolbar. */}
      <CallScreenShareBanner sharing={call.screenSharing} onStop={call.stopScreenShare} />

      {/* Transport banners — reconnect + soft-cap warning, both above the
          tile grid so they don't push the control bar around. */}
      <CallTransportBanners
        isReconnecting={isReconnecting}
        connectionStatus={connectionStatus}
        overSoftVideoCap={call.overSoftVideoCap}
        softCapDismissed={softCapDismissed}
        videoTileCount={call.videoTileCount}
        softVideoCap={call.softVideoCap}
        onDismissSoftCap={onDismissSoftCap}
      />

      <VideoTileGrid
        call={call}
        myName={myName}
        manualFocusId={manualFocusId}
        onFocusToggle={onFocusToggle}
        onUnfocus={onUnfocus}
        speakingLevels={speakingLevels}
        volume={volume}
        mutedForMe={mutedForMe}
        onTogglePeerMute={onTogglePeerMute}
      />

      <AudioTileStrip
        speakingLevels={speakingLevels}
        showSelf={call.mode === 'audio'}
        localStream={call.localStream}
        myName={myName}
        micMuted={call.micMuted}
        audioRemotes={audioRemotes}
        volume={volume}
        mutedForMe={mutedForMe}
        onTogglePeerMute={onTogglePeerMute}
        showEmptyHint={remotePeersCount === 0}
      />

      <CallFooterBanners
        callError={call.error}
        onDismissCallError={call.dismissError}
        screenShareError={call.screenShareError}
        onDismissScreenShareError={call.dismissScreenShareError}
        screenAudioShared={call.screenAudioShared}
        echoWarningDismissed={echoWarningDismissed}
        onDismissEchoWarning={onDismissEchoWarning}
        aiNoiseError={call.aiNoiseError}
        onDismissAiNoiseError={call.dismissAiNoiseError}
      />

      <CallControlBar
        call={call}
        volume={volume}
        onVolumeChange={onVolumeChange}
        onToggleSpeakerMute={onToggleSpeakerMute}
        showSettings={showSettings}
        onToggleSettings={onToggleSettings}
        screenShareSupported={screenShareSupported}
      />
    </div>
  )
}
