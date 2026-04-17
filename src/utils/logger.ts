// Lightweight logger with a bounded in-memory ring buffer.
// Goals: replace silent `catch {}` in hot paths with something the user can
// copy when reporting an issue, without a third-party service and without
// leaking chat/file content (so the E2E claim stays honest).
//
// Rules for callers:
// - Pass a short `ctx` string — e.g., 'useSender.passwordDecrypt'. Greppable.
// - Never log message text, file names, or payload bodies. Errors only.
// - Redact ids to first 8 chars via `redactId` before logging.

const MAX_ENTRIES = 200

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogEntry {
  t: number
  level: LogLevel
  ctx: string
  msg: string
}

const buffer: LogEntry[] = []

function push(level: LogLevel, ctx: string, msg: string): void {
  const entry: LogEntry = { t: Date.now(), level, ctx, msg }
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()
}

function toMsg(err: unknown): string {
  if (err instanceof Error) return err.name + ': ' + (err.message || 'no message')
  if (typeof err === 'string') return err
  try { return JSON.stringify(err) } catch { return String(err) }
}

export const log = {
  debug(ctx: string, err?: unknown): void {
    push('debug', ctx, err === undefined ? '' : toMsg(err))
  },
  info(ctx: string, err?: unknown): void {
    push('info', ctx, err === undefined ? '' : toMsg(err))
  },
  warn(ctx: string, err?: unknown): void {
    const m = err === undefined ? '' : toMsg(err)
    push('warn', ctx, m)
    if (typeof console !== 'undefined') console.warn('[' + ctx + ']', m)
  },
  error(ctx: string, err?: unknown): void {
    const m = err === undefined ? '' : toMsg(err)
    push('error', ctx, m)
    if (typeof console !== 'undefined') console.error('[' + ctx + ']', m)
  },
}

export function redactId(id: string | null | undefined): string {
  if (!id) return '-'
  return id.length > 8 ? id.slice(0, 8) + '…' : id
}

export function copyDiagnostics(): string {
  const lines = buffer.map(e => {
    const ts = new Date(e.t).toISOString()
    return ts + ' ' + e.level.padEnd(5) + ' ' + e.ctx + (e.msg ? ' — ' + e.msg : '')
  })
  return lines.join('\n')
}

export function clearDiagnostics(): void {
  buffer.length = 0
}

export function getDiagnosticsBuffer(): readonly LogEntry[] {
  return buffer
}
