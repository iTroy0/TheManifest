import type { ComponentProps } from 'react'
import AudioTile from '../AudioTile'
import { useSpeakingLevel, type SpeakingLevels } from '../../hooks/useSpeakingLevels'
import type { RemotePeer } from '../../hooks/useCall'

// Per-tile subscriber: a level update only re-renders the tile it belongs
// to, not the whole strip. Matches the LeveledVideoTile wrapper in
// CallPanel.tsx.
type AudioTileBaseProps = Omit<ComponentProps<typeof AudioTile>, 'level'>
function LeveledAudioTile({ controller, levelId, ...rest }: AudioTileBaseProps & { controller: SpeakingLevels; levelId: string }) {
  const level = useSpeakingLevel(controller, levelId)
  return <AudioTile {...rest} level={level} />
}

interface AudioTileStripProps {
  speakingLevels: SpeakingLevels
  showSelf: boolean
  localStream: MediaStream | null
  myName: string
  micMuted: boolean
  audioRemotes: RemotePeer[]
  volume: number
  mutedForMe: Set<string>
  onTogglePeerMute: (peerId: string) => void
  showEmptyHint: boolean
}

export default function AudioTileStrip({
  speakingLevels,
  showSelf,
  localStream,
  myName,
  micMuted,
  audioRemotes,
  volume,
  mutedForMe,
  onTogglePeerMute,
  showEmptyHint,
}: AudioTileStripProps) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2">
      <div className="grid grid-cols-2 sm:grid-cols-2 gap-1.5">
        {showSelf && (
          <LeveledAudioTile
            controller={speakingLevels}
            levelId="self"
            stream={localStream}
            name={myName}
            self
            micMuted={micMuted}
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
            onToggleMutedForMe={() => onTogglePeerMute(p.peerId)}
          />
        ))}
      </div>
      {showEmptyHint && (
        <p className="font-mono text-[10px] text-muted/60 text-center py-6">
          Waiting for others to join…
        </p>
      )}
    </div>
  )
}
