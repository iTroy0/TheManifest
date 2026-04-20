import { Mic, MicOff, Video, VideoOff, PhoneOff, Settings2, Volume2, Volume1, VolumeX, SwitchCamera, Loader2, MonitorUp, MonitorOff, AudioLines } from 'lucide-react'
import type { UseCallReturn } from '../../hooks/useCall'

interface CallControlBarProps {
  call: UseCallReturn
  volume: number
  onVolumeChange: (v: number) => void
  onToggleSpeakerMute: () => void
  showSettings: boolean
  onToggleSettings: () => void
  screenShareSupported: boolean
}

export default function CallControlBar({
  call,
  volume,
  onVolumeChange,
  onToggleSpeakerMute,
  showSettings,
  onToggleSettings,
  screenShareSupported,
}: CallControlBarProps) {
  return (
    <div className="border-t border-border bg-surface-2/40 px-3 py-2">
      {/* Mobile: nowrap + horizontal scroll so Leave never orphans onto a
          second row. Tablet+: wrap centered as before. */}
      <div className="flex items-center gap-1.5 flex-nowrap overflow-x-auto scrollbar-none sm:flex-wrap sm:overflow-visible sm:justify-center">
        <ControlButton
          onClick={call.toggleMic}
          title={call.micMuted ? 'Unmute' : 'Mute'}
          icon={call.micMuted ? MicOff : Mic}
          danger={call.micMuted}
        />
        <ControlButton
          onClick={() => { void call.toggleAiNoiseSuppression() }}
          title={
            call.aiNoiseStarting
              ? 'Loading noise suppression…'
              : call.aiNoiseSuppression
                ? 'Noise suppression: ON (click to turn off)'
                : 'Noise suppression: OFF (click to turn on)'
          }
          icon={call.aiNoiseStarting ? Loader2 : AudioLines}
          disabled={call.aiNoiseStarting}
          spinning={call.aiNoiseStarting}
          info={call.aiNoiseSuppression}
          danger={!call.aiNoiseSuppression && !call.aiNoiseStarting}
        />
        <ControlButton
          onClick={call.toggleCamera}
          title={
            call.cameraStarting ? 'Camera starting…'
              : call.cameraOff ? 'Turn camera on' : 'Turn camera off'
          }
          icon={call.cameraStarting ? Loader2 : call.cameraOff ? VideoOff : Video}
          danger={call.cameraOff}
          disabled={call.cameraStarting}
          spinning={call.cameraStarting}
        />
        {call.mode === 'video' && call.cameraDevices.length > 1 && (
          <ControlButton
            onClick={() => { void call.flipCamera() }}
            title="Switch camera"
            icon={SwitchCamera}
          />
        )}
        {screenShareSupported ? (
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
        ) : (
          <ControlButton
            onClick={() => { /* not supported */ }}
            title="Screen share is not supported in this browser"
            icon={MonitorOff}
            disabled
          />
        )}
        <ControlButton
          onClick={onToggleSpeakerMute}
          title={volume === 0 ? 'Unmute speakers' : 'Mute speakers'}
          icon={volume === 0 ? VolumeX : volume < 0.5 ? Volume1 : Volume2}
          danger={volume === 0}
        />
        <ControlButton
          onClick={onToggleSettings}
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
          <VolumeRow volume={volume} onChange={onVolumeChange} onToggleMute={onToggleSpeakerMute} />
          <DeviceRow label="Microphone" devices={call.micDevices} selectedId={call.selectedMicId} onSelect={(id) => { void call.selectMic(id) }} />
          {call.mode === 'video' && (
            <DeviceRow label="Camera" devices={call.cameraDevices} selectedId={call.selectedCameraId} onSelect={(id) => { void call.selectCamera(id) }} />
          )}
        </div>
      )}
    </div>
  )
}

interface ControlButtonProps {
  icon: React.ComponentType<{ className?: string }>
  onClick: () => void
  title: string
  danger?: boolean
  disabled?: boolean
  spinning?: boolean
  // Renders the blue/info variant — used by toggles whose ON state is
  // informational rather than destructive (e.g., noise suppression).
  // Mutually exclusive with `danger`; if both are set, danger wins. When set
  // (true or false), the button is announced as a two-state toggle via
  // aria-pressed. Leave undefined for one-shot actions (e.g. Leave, Refresh).
  info?: boolean
}
function ControlButton({ icon: Icon, onClick, title, danger = false, disabled = false, spinning = false, info }: ControlButtonProps) {
  const tone =
    danger
      ? 'bg-danger/15 hover:bg-danger/25 text-danger ring-1 ring-danger/30'
      : info
        ? 'bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 ring-1 ring-blue-500/50'
        : 'bg-accent/10 hover:bg-accent/20 text-accent ring-1 ring-accent/20'
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={info === undefined ? undefined : info}
      className={`flex items-center justify-center w-11 h-11 sm:w-9 sm:h-9 rounded-lg transition-all active:scale-[0.95] disabled:opacity-50 disabled:cursor-not-allowed ${tone}`}
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
