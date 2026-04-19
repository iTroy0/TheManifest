// Cross-tab "I am in this call" claim, backed by localStorage.
//
// H11: the prior BroadcastChannel-based duplicate-tab guard was a probe-
// reply protocol with a 300 ms wait window. Two tabs opening within that
// window both saw silence (neither was past its own wait when the other
// asked) and both admitted → duplicate join → audio feedback. BroadcastChannel
// is notify-only; it cannot serve as a consensus layer.
//
// This module replaces the probe with an atomic claim:
//
//   1. Read the current claim record from `manifest-call-claim-${hostPeerId}`.
//   2. If a non-stale record exists with a different tabId → refuse.
//   3. Otherwise write our own record.
//   4. Wait CLAIM_RACE_DELAY_MS so a concurrent writer's value lands.
//   5. Re-read; if our tabId is still the winner → success, else refuse.
//
// `Date.now() - record.ts < CLAIM_STALE_MS` lets a tab killed without cleanup
// be reclaimed after CLAIM_STALE_MS. `refreshClaim` keeps the timestamp
// fresh while joined so siblings see an active claim. `releaseClaim` clears
// the record on leave / unmount only when we still own it (prevents a sibling
// tab from accidentally clearing the active call's claim).
//
// localStorage is sync within a tab and eventually consistent across tabs.
// Re-read after CLAIM_RACE_DELAY_MS catches the common simultaneous-write
// race; a perfectly synchronized cross-tab race remains theoretically
// possible but vanishingly rare for human-driven tab opens. Web Locks API
// would close the residual gap but lacks Safari support — revisit if the
// gap shows up in real telemetry.

export const CALL_CLAIM_PREFIX = 'manifest-call-claim-'
export const CLAIM_STALE_MS = 10_000
export const CLAIM_HEARTBEAT_MS = 3_000
export const CLAIM_RACE_DELAY_MS = 80

export interface ClaimRecord {
  tabId: string
  ts: number
}

interface StorageLike {
  getItem(k: string): string | null
  setItem(k: string, v: string): void
  removeItem(k: string): void
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage !== 'undefined') return localStorage
  } catch { /* SecurityError in some private modes */ }
  return null
}

function readRaw(storage: StorageLike, key: string): ClaimRecord | null {
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as ClaimRecord
    if (typeof parsed?.tabId !== 'string' || typeof parsed?.ts !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

// Returns true if the claim was acquired (we may proceed with join), false
// if a sibling tab holds an active claim. Storage unavailable → returns
// true (degrade open rather than block).
export async function tryClaim(
  hostPeerId: string,
  tabId: string,
  opts: { storage?: StorageLike; raceDelayMs?: number; staleMs?: number; now?: () => number } = {},
): Promise<boolean> {
  const storage = opts.storage ?? defaultStorage()
  if (!storage) return true
  const now = opts.now ?? Date.now
  const staleMs = opts.staleMs ?? CLAIM_STALE_MS
  const raceDelayMs = opts.raceDelayMs ?? CLAIM_RACE_DELAY_MS
  const key = CALL_CLAIM_PREFIX + hostPeerId

  const existing = readRaw(storage, key)
  if (existing && existing.tabId !== tabId && now() - existing.ts < staleMs) {
    return false
  }

  try {
    storage.setItem(key, JSON.stringify({ tabId, ts: now() } satisfies ClaimRecord))
  } catch {
    // Quota / SecurityError — degrade open.
    return true
  }

  if (raceDelayMs > 0) {
    await new Promise<void>(resolve => setTimeout(resolve, raceDelayMs))
  }

  const final = readRaw(storage, key)
  if (!final) {
    // Cleared between our write and re-read — treat as conflict to be safe.
    return false
  }
  return final.tabId === tabId
}

// Refresh `ts` so siblings see an active claim. No-op when storage is gone
// or the record now belongs to a different tab (we lost it somehow — don't
// stomp the new owner).
export function refreshClaim(
  hostPeerId: string,
  tabId: string,
  opts: { storage?: StorageLike; now?: () => number } = {},
): void {
  const storage = opts.storage ?? defaultStorage()
  if (!storage) return
  const now = opts.now ?? Date.now
  const key = CALL_CLAIM_PREFIX + hostPeerId
  const existing = readRaw(storage, key)
  if (!existing || existing.tabId !== tabId) return
  try {
    storage.setItem(key, JSON.stringify({ tabId, ts: now() } satisfies ClaimRecord))
  } catch { /* ignore */ }
}

// Release the claim only when we still own it. Storage unavailable or
// record owned by another tab → no-op.
export function releaseClaim(
  hostPeerId: string,
  tabId: string,
  opts: { storage?: StorageLike } = {},
): void {
  const storage = opts.storage ?? defaultStorage()
  if (!storage) return
  const key = CALL_CLAIM_PREFIX + hostPeerId
  const existing = readRaw(storage, key)
  if (!existing || existing.tabId !== tabId) return
  try {
    storage.removeItem(key)
  } catch { /* ignore */ }
}

// Stable per-tab id. sessionStorage survives reload + hot-reload within the
// same tab, so a refresh doesn't lose ownership of an active claim. Falls
// back to a fresh UUID when sessionStorage is blocked.
export function getStableTabId(): string {
  const k = 'manifest-tab-id'
  try {
    if (typeof sessionStorage !== 'undefined') {
      const existing = sessionStorage.getItem(k)
      if (existing) return existing
      const fresh = generateId()
      sessionStorage.setItem(k, fresh)
      return fresh
    }
  } catch { /* ignore */ }
  return generateId()
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}
