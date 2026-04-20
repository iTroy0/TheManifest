import { AlertTriangle, Loader2, Phone, PhoneOff, WifiOff, X } from 'lucide-react'
import { ensureAudioContextRunning } from '../../utils/audioContext'
import type { UseCallReturn } from '../../hooks/useCall'

interface CallPreJoinProps {
  call: UseCallReturn
  disabled: boolean
  isConnectionDead: boolean
  isReconnecting: boolean
  remotePeersCount: number
}

export default function CallPreJoin({
  call,
  disabled,
  isConnectionDead,
  isReconnecting,
  remotePeersCount,
}: CallPreJoinProps) {
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
          : remotePeersCount > 0
          ? `${remotePeersCount} already in call`
          : 'No one is in the call yet'}
      </p>
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
