import React from 'react'

type StatusKey =
  | 'initializing'
  | 'waiting'
  | 'connecting'
  | 'retrying'
  | 'reconnecting'
  | 'password-required'
  | 'direct-failed'
  | 'connected'
  | 'manifest-received'
  | 'transferring'
  | 'receiving'
  | 'done'
  | 'closed'
  | 'rejected'
  | 'error'

interface StatusConfig {
  color: string
  ring: string
  text: string
  pulse: boolean
}

const statusConfig: Record<StatusKey, StatusConfig> = {
  initializing:        { color: 'bg-muted',      ring: 'ring-muted/30',      text: 'Initializing...', pulse: true },
  waiting:             { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Waiting for recipient...', pulse: true },
  connecting:          { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Connecting...', pulse: true },
  retrying:            { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Retrying...', pulse: true },
  reconnecting:        { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Reconnecting...', pulse: true },
  'password-required': { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Password required', pulse: true },
  'direct-failed':     { color: 'bg-warning',     ring: 'ring-warning/30',    text: 'Direct connection failed', pulse: false },
  connected:           { color: 'bg-accent',      ring: 'ring-accent/30',     text: 'Connected', pulse: false },
  'manifest-received': { color: 'bg-accent',      ring: 'ring-accent/30',     text: 'Connected', pulse: false },
  transferring:        { color: 'bg-info',        ring: 'ring-info/30',       text: 'Transferring...', pulse: true },
  receiving:           { color: 'bg-info',        ring: 'ring-info/30',       text: 'Receiving...', pulse: true },
  done:                { color: 'bg-accent',      ring: 'ring-accent/30',     text: 'Complete', pulse: false },
  closed:              { color: 'bg-danger',      ring: 'ring-danger/30',     text: 'Disconnected', pulse: false },
  rejected:            { color: 'bg-danger',      ring: 'ring-danger/30',     text: 'Connection rejected', pulse: false },
  error:               { color: 'bg-danger',      ring: 'ring-danger/30',     text: 'Connection error', pulse: false },
}

interface StatusIndicatorProps {
  status: StatusKey | string
  children?: React.ReactNode
}

export default function StatusIndicator({ status, children }: StatusIndicatorProps) {
  const config = statusConfig[status as StatusKey] || statusConfig.error
  const isGood = status === 'connected' || status === 'manifest-received' || status === 'done'
  const isActive = status === 'transferring' || status === 'receiving'
  const isBad = status === 'closed' || status === 'error' || status === 'rejected'

  return (
    <div
      role="status"
      aria-live="polite"
      className={`
      flex items-center gap-3 rounded-xl px-4 py-3 flex-wrap transition-colors duration-300
      ${isGood ? 'bg-accent/5 border border-accent/20' :
        isActive ? 'bg-info/5 border border-info/20' :
        isBad ? 'bg-danger/5 border border-danger/20' :
        'bg-surface border border-border'}
    `}>
      <span className="relative flex h-3 w-3 shrink-0">
        {config.pulse && (
          <span className={`absolute inset-0 rounded-full ${config.color} opacity-50 animate-ping`} />
        )}
        <span className={`relative inline-flex rounded-full h-3 w-3 ${config.color} ring-2 ${config.ring}`} />
      </span>
      <span className={`font-mono text-sm font-medium ${
        isGood ? 'text-accent' : isActive ? 'text-info' : isBad ? 'text-danger' : 'text-muted-light'
      }`}>{config.text}</span>
      {children && <div className="flex items-center gap-2 ml-auto flex-wrap">{children}</div>}
    </div>
  )
}
