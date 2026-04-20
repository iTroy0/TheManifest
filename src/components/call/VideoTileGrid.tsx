import { type ComponentProps } from 'react'
import VideoTile from '../VideoTile'
import { useSpeakingLevel, type SpeakingLevels } from '../../hooks/useSpeakingLevels'
import type { UseCallReturn } from '../../hooks/useCall'

// H12: per-tile level subscriber so a pulse update on peer A doesn't
// re-render peers B-T's tiles. See the audio-strip variant in
// `./AudioTileStrip.tsx`.
type VideoTileBaseProps = Omit<ComponentProps<typeof VideoTile>, 'level'>
function LeveledVideoTile({ controller, levelId, ...rest }: VideoTileBaseProps & { controller: SpeakingLevels; levelId: string }) {
  const level = useSpeakingLevel(controller, levelId)
  return <VideoTile {...rest} level={level} />
}

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

interface VideoTileGridProps {
  call: UseCallReturn
  myName: string
  manualFocusId: string | null
  onFocusToggle: (id: string) => void
  onUnfocus: () => void
  speakingLevels: SpeakingLevels
  volume: number
  mutedForMe: Set<string>
  onTogglePeerMute: (peerId: string) => void
}

export default function VideoTileGrid({
  call,
  myName,
  manualFocusId,
  onFocusToggle,
  onUnfocus,
  speakingLevels,
  volume,
  mutedForMe,
  onTogglePeerMute,
}: VideoTileGridProps) {
  // Camera/audio tiles track the main mc; screen tiles track the dedicated
  // screen mc. A peer can show up in both (camera on + sharing) as two
  // separate tiles — receivers no longer get their screen track hot-swapped
  // into the camera tile, which was stalling the decoder mid-session.
  const remotePeers = call.remotePeers
  const videoRemotes = remotePeers.filter(p => p.mode === 'video')
  const screenSharingRemotes = remotePeers.filter(p => !!p.screenStream)
  const showLocalCamera = call.mode === 'video'
  const showLocalScreen = call.screenSharing

  const videoTiles: VideoTileInfo[] = []
  if (showLocalCamera) {
    videoTiles.push({
      id: 'self',
      isSelf: true,
      name: myName,
      stream: call.localStream,
      micMuted: call.micMuted,
      cameraOff: call.cameraOff,
      connecting: false,
      screenShare: false,
    })
  }
  if (showLocalScreen) {
    videoTiles.push({
      id: 'self:screen',
      isSelf: true,
      name: `${myName} (screen)`,
      stream: call.screenStream,
      micMuted: call.micMuted,
      cameraOff: false,
      connecting: false,
      screenShare: true,
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
      screenShare: false,
    })
  })
  screenSharingRemotes.forEach(p => {
    videoTiles.push({
      id: `${p.peerId}:screen`,
      isSelf: false,
      name: `${p.name} (screen)`,
      stream: p.screenStream,
      micMuted: p.micMuted,
      cameraOff: false,
      connecting: !p.screenStream,
      screenShare: true,
    })
  })

  if (videoTiles.length === 0) return null

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

  return (
    <div className="px-3 pt-3 pb-2">
      {/* Unified, stable render tree: every VideoTile instance stays
          mounted across focus changes; the wrapper's style is swapped
          instead of swapping parent divs. Keeping the underlying
          <video> element alive is what stops the local preview from
          freezing on mobile when the user taps between tiles quickly. */}
      <div
        className={focusedTile ? 'relative' : 'grid gap-2 items-center'}
        style={focusedTile ? undefined : {
          gridTemplateColumns: videoTiles.length === 1 ? '1fr' : 'repeat(auto-fit, minmax(240px, 1fr))',
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
                onToggleMutedForMe={v.isSelf ? undefined : () => onTogglePeerMute(v.id)}
                focused={isFocused}
                mini={isMini}
                onToggleFocus={isFocused ? onUnfocus : () => onFocusToggle(v.id)}
                screenShare={v.screenShare}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}
