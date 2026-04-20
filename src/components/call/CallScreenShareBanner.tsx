import { MonitorUp, MonitorOff } from 'lucide-react'

interface CallScreenShareBannerProps {
  sharing: boolean
  onStop: () => void
}

export default function CallScreenShareBanner({ sharing, onStop }: CallScreenShareBannerProps) {
  if (!sharing) return null
  return (
    <div className="px-3 pt-2">
      <div className="flex items-center gap-2 rounded-lg bg-accent/10 border border-accent/30 px-3 py-2">
        <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse shrink-0" aria-hidden="true" />
        <MonitorUp className="w-3.5 h-3.5 text-accent shrink-0" />
        <p className="font-mono text-[10px] text-accent flex-1">
          You&apos;re sharing your screen
        </p>
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md bg-danger/90 hover:bg-danger text-white font-mono text-[10px] transition-colors"
          aria-label="Stop screen share"
          title="Stop sharing"
        >
          <MonitorOff className="w-3 h-3" />
          Stop
        </button>
      </div>
    </div>
  )
}
