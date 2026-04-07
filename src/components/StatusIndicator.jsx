const statusConfig = {
  initializing: { color: 'bg-muted',      ring: 'ring-muted/30',      text: 'Initializing...', pulse: true },
  waiting:      { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Waiting for recipient...', pulse: true },
  connecting:   { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Connecting...', pulse: true },
  retrying:         { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Retrying...', pulse: true },
  reconnecting:     { color: 'bg-yellow-400',  ring: 'ring-yellow-400/30', text: 'Reconnecting...', pulse: true },
  'password-required': { color: 'bg-yellow-400', ring: 'ring-yellow-400/30', text: 'Password required', pulse: true },
  'direct-failed':  { color: 'bg-warning',     ring: 'ring-warning/30',    text: 'Direct connection failed', pulse: false },
  connected:            { color: 'bg-accent',      ring: 'ring-accent/30',     text: 'Connected', pulse: false },
  'manifest-received':  { color: 'bg-accent',      ring: 'ring-accent/30',     text: 'Ready to download', pulse: true },
  transferring:         { color: 'bg-info',        ring: 'ring-info/30',       text: 'Transferring...', pulse: true },
  receiving:    { color: 'bg-info',        ring: 'ring-info/30',       text: 'Receiving...', pulse: true },
  done:         { color: 'bg-accent',      ring: 'ring-accent/30',     text: 'Complete', pulse: false },
  closed:       { color: 'bg-danger',      ring: 'ring-danger/30',     text: 'Disconnected', pulse: false },
  rejected:     { color: 'bg-danger',      ring: 'ring-danger/30',     text: 'Connection rejected', pulse: false },
  error:        { color: 'bg-danger',      ring: 'ring-danger/30',     text: 'Connection error', pulse: false },
}

export default function StatusIndicator({ status }) {
  const config = statusConfig[status] || statusConfig.error
  return (
    <div className="flex items-center gap-3 bg-surface border border-border rounded-xl px-4 py-3">
      <span className="relative flex h-2.5 w-2.5">
        {config.pulse && (
          <span className={`absolute inset-0 rounded-full ${config.color} opacity-60 animate-ping`} />
        )}
        <span className={`relative inline-flex rounded-full h-2.5 w-2.5 ${config.color} ring-2 ${config.ring}`} />
      </span>
      <span className="font-mono text-xs text-muted-light">{config.text}</span>
    </div>
  )
}
