// Module-level singleton AudioContext. Browsers cap the number of contexts
// per page (Chrome ~6) and creating one per remote tile burns CPU + memory.
// Every consumer that needs analysers or output processing should call
// getSharedAudioContext() so we share a single graph.
//
// Some browsers suspend the context until a user gesture; we lazily resume
// on first access from a click handler via ensureRunning().

let sharedCtx: AudioContext | null = null

function createCtx(): AudioContext | null {
  const AC: typeof AudioContext | undefined =
    (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext))
    || undefined
  if (!AC) return null
  try { return new AC() } catch { return null }
}

export function getSharedAudioContext(): AudioContext | null {
  if (sharedCtx) return sharedCtx
  sharedCtx = createCtx()
  return sharedCtx
}

// Best-effort resume after a user gesture. No-op if already running or
// unavailable. Safe to call from any click handler.
export function ensureAudioContextRunning(): void {
  const ctx = getSharedAudioContext()
  if (!ctx) return
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {})
  }
}
