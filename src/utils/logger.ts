// DEV-gated console logger. Zero persistence: nothing buffered, nothing copyable.
// Prod builds: all calls are no-ops.
// Callers: pass a short `ctx` (e.g. 'useSender.passwordDecrypt') + optional error.

const DEV = import.meta.env.DEV

function toMsg(err: unknown): string {
  if (err instanceof Error) return err.name + ': ' + (err.message || 'no message')
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

export const log = {
  debug(ctx: string, err?: unknown): void {
    if (!DEV) return
    console.debug('[' + ctx + ']', err === undefined ? '' : toMsg(err))
  },
  info(ctx: string, err?: unknown): void {
    if (!DEV) return
    console.info('[' + ctx + ']', err === undefined ? '' : toMsg(err))
  },
  warn(ctx: string, err?: unknown): void {
    if (!DEV) return
    console.warn('[' + ctx + ']', err === undefined ? '' : toMsg(err))
  },
  error(ctx: string, err?: unknown): void {
    if (!DEV) return
    console.error('[' + ctx + ']', err === undefined ? '' : toMsg(err))
  },
}
