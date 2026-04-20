import { AlertTriangle, RefreshCw, X } from 'lucide-react'
import type { CallPanelConnectionStatus } from '../CallPanel'

interface CallTransportBannersProps {
  isReconnecting: boolean
  connectionStatus?: CallPanelConnectionStatus
  overSoftVideoCap: boolean
  softCapDismissed: boolean
  videoTileCount: number
  softVideoCap: number
  onDismissSoftCap: () => void
}

export default function CallTransportBanners({
  isReconnecting,
  connectionStatus,
  overSoftVideoCap,
  softCapDismissed,
  videoTileCount,
  softVideoCap,
  onDismissSoftCap,
}: CallTransportBannersProps) {
  return (
    <>
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
      {overSoftVideoCap && !softCapDismissed && (
        <div className="px-3 pt-2">
          <div className="flex items-center gap-2 rounded-lg bg-info/10 border border-info/30 px-3 py-2">
            <AlertTriangle className="w-3.5 h-3.5 text-info shrink-0" />
            <p className="font-mono text-[10px] text-info/90 flex-1">
              {videoTileCount} video tiles — bandwidth may suffer above {softVideoCap}.
            </p>
            <button
              type="button"
              onClick={onDismissSoftCap}
              className="shrink-0 text-info/70 hover:text-info transition-colors"
              aria-label="Dismiss bandwidth warning"
              title="Dismiss"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
