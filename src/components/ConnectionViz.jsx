export default function ConnectionViz({ status, useRelay }) {
  const isActive = status === 'transferring' || status === 'receiving'
  const isDone = status === 'done'

  if (!isActive && !isDone) return null

  return (
    <div className="flex items-center justify-center gap-3 py-3">
      {/* Sender node */}
      <div className="flex flex-col items-center gap-1">
        <div className="w-8 h-8 rounded-lg bg-accent/15 flex items-center justify-center">
          <span className="font-mono text-[10px] text-accent font-bold">S</span>
        </div>
        <span className="font-mono text-[9px] text-muted">Sender</span>
      </div>

      {/* Connection line */}
      <div className="flex-1 max-w-[180px] h-8 relative flex items-center">
        <div className="w-full h-px bg-border" />

        {/* Animated dots flowing */}
        {isActive && (
          <div className="absolute inset-0 overflow-hidden flex items-center">
            <div className="dot-flow" />
          </div>
        )}

        {/* Relay indicator */}
        {useRelay && (
          <div className="absolute left-1/2 -translate-x-1/2 -translate-y-1/2 top-1/2">
            <div className="w-5 h-5 rounded-md bg-surface border border-border flex items-center justify-center">
              <span className="font-mono text-[8px] text-warning">R</span>
            </div>
          </div>
        )}

        {/* Done checkmark */}
        {isDone && (
          <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
            <div className="w-5 h-5 rounded-full bg-accent/20 flex items-center justify-center">
              <svg className="w-3 h-3 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Receiver node */}
      <div className="flex flex-col items-center gap-1">
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${isDone ? 'bg-accent/15' : 'bg-info/15'}`}>
          <span className={`font-mono text-[10px] font-bold ${isDone ? 'text-accent' : 'text-info'}`}>R</span>
        </div>
        <span className="font-mono text-[9px] text-muted">Receiver</span>
      </div>
    </div>
  )
}
