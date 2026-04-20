import { AlertTriangle, MonitorOff, X } from 'lucide-react'
import type { CallError } from '../../hooks/useCall'

interface CallFooterBannersProps {
  callError: CallError | null
  onDismissCallError: () => void
  screenShareError: CallError | null
  onDismissScreenShareError: () => void
  screenAudioShared: boolean
  echoWarningDismissed: boolean
  onDismissEchoWarning: () => void
  aiNoiseError: string | null
  onDismissAiNoiseError: () => void
}

export default function CallFooterBanners({
  callError,
  onDismissCallError,
  screenShareError,
  onDismissScreenShareError,
  screenAudioShared,
  echoWarningDismissed,
  onDismissEchoWarning,
  aiNoiseError,
  onDismissAiNoiseError,
}: CallFooterBannersProps) {
  return (
    <>
      {callError && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 rounded-lg bg-danger/10 border border-danger/30 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-danger shrink-0 mt-0.5" />
            <p className="flex-1 font-mono text-[10px] text-danger">{callError.message}</p>
            <button
              type="button"
              onClick={onDismissCallError}
              className="shrink-0 text-danger/60 hover:text-danger transition-colors"
              aria-label="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {screenShareError && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2">
            <MonitorOff className="w-3.5 h-3.5 text-warning shrink-0 mt-0.5" />
            <p className="flex-1 font-mono text-[10px] text-warning">{screenShareError.message}</p>
            <button
              type="button"
              onClick={onDismissScreenShareError}
              className="shrink-0 text-warning/60 hover:text-warning transition-colors"
              aria-label="Dismiss screen share error"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {screenAudioShared && !echoWarningDismissed && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 rounded-lg bg-surface-2 border border-border px-3 py-2">
            <p className="flex-1 font-mono text-[10px] text-muted-light">
              Sharing tab audio. If the shared tab is playing another call, peers may hear themselves echoed back. Mute the shared tab or stop sharing audio to fix.
            </p>
            <button
              type="button"
              onClick={onDismissEchoWarning}
              className="shrink-0 text-muted/60 hover:text-muted transition-colors"
              aria-label="Dismiss echo warning"
              title="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}

      {aiNoiseError && (
        <div className="px-3 pb-2">
          <div className="flex items-start gap-2 rounded-lg bg-warning/10 border border-warning/30 px-3 py-2">
            <p className="flex-1 font-mono text-[10px] text-warning">{aiNoiseError}</p>
            <button
              type="button"
              onClick={onDismissAiNoiseError}
              className="shrink-0 text-warning/60 hover:text-warning transition-colors"
              aria-label="Dismiss noise suppression error"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
