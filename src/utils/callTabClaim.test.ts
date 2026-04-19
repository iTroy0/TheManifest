import { describe, it, expect, beforeEach } from 'vitest'
import {
  tryClaim, refreshClaim, releaseClaim,
  CALL_CLAIM_PREFIX,
  type ClaimRecord,
} from './callTabClaim'

// In-memory storage stub matching the localStorage surface we use.
function makeStorage() {
  const store = new Map<string, string>()
  return {
    storage: {
      getItem(k: string): string | null { return store.has(k) ? store.get(k)! : null },
      setItem(k: string, v: string): void { store.set(k, v) },
      removeItem(k: string): void { store.delete(k) },
    },
    raw: store,
  }
}

const HOST = 'host-1'
const KEY = CALL_CLAIM_PREFIX + HOST

describe('tryClaim', () => {
  let s: ReturnType<typeof makeStorage>
  beforeEach(() => { s = makeStorage() })

  it('writes a fresh claim and returns true on empty storage', async () => {
    let now = 1000
    const ok = await tryClaim(HOST, 'tab-A', { storage: s.storage, raceDelayMs: 0, now: () => now })
    expect(ok).toBe(true)
    const rec = JSON.parse(s.raw.get(KEY)!) as ClaimRecord
    expect(rec.tabId).toBe('tab-A')
    expect(rec.ts).toBe(1000)
    void now
  })

  it('refuses when an active claim from another tab exists', async () => {
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-A', ts: 5000 }))
    const ok = await tryClaim(HOST, 'tab-B', {
      storage: s.storage, raceDelayMs: 0, now: () => 5500,
    })
    expect(ok).toBe(false)
    // Storage unchanged.
    expect(JSON.parse(s.raw.get(KEY)!).tabId).toBe('tab-A')
  })

  it('reclaims a stale record after CLAIM_STALE_MS', async () => {
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-A', ts: 0 }))
    const ok = await tryClaim(HOST, 'tab-B', {
      storage: s.storage, raceDelayMs: 0, staleMs: 10_000, now: () => 20_000,
    })
    expect(ok).toBe(true)
    expect(JSON.parse(s.raw.get(KEY)!).tabId).toBe('tab-B')
  })

  it('refreshes own claim without conflict (same tabId, fresh ts)', async () => {
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-A', ts: 100 }))
    const ok = await tryClaim(HOST, 'tab-A', {
      storage: s.storage, raceDelayMs: 0, now: () => 200,
    })
    expect(ok).toBe(true)
    expect(JSON.parse(s.raw.get(KEY)!).ts).toBe(200)
  })

  it('detects concurrent write via re-read after race delay', async () => {
    let now = 1000
    // Schedule a sibling write to land during our race delay.
    const racePromise = tryClaim(HOST, 'tab-A', {
      storage: s.storage, raceDelayMs: 30, now: () => now,
    })
    // Sibling tab overwrites at ts+10ms.
    setTimeout(() => {
      s.storage.setItem(KEY, JSON.stringify({ tabId: 'tab-B', ts: now + 10 } satisfies ClaimRecord))
    }, 10)
    const ok = await racePromise
    expect(ok).toBe(false)
    expect(JSON.parse(s.raw.get(KEY)!).tabId).toBe('tab-B')
  })

  it('degrades open when storage is unavailable', async () => {
    const ok = await tryClaim(HOST, 'tab-A', {
      // Storage that throws on every op.
      storage: {
        getItem() { throw new Error('blocked') },
        setItem() { throw new Error('blocked') },
        removeItem() { throw new Error('blocked') },
      },
      raceDelayMs: 0,
    })
    expect(ok).toBe(true)
  })

  it('treats malformed JSON as no claim', async () => {
    s.raw.set(KEY, '{not json')
    const ok = await tryClaim(HOST, 'tab-A', {
      storage: s.storage, raceDelayMs: 0, now: () => 1000,
    })
    expect(ok).toBe(true)
    expect(JSON.parse(s.raw.get(KEY)!).tabId).toBe('tab-A')
  })
})

describe('refreshClaim', () => {
  it('updates ts when own claim still present', () => {
    const s = makeStorage()
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-A', ts: 100 }))
    refreshClaim(HOST, 'tab-A', { storage: s.storage, now: () => 500 })
    expect(JSON.parse(s.raw.get(KEY)!).ts).toBe(500)
  })

  it('no-op when claim now owned by another tab', () => {
    const s = makeStorage()
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-B', ts: 100 }))
    refreshClaim(HOST, 'tab-A', { storage: s.storage, now: () => 500 })
    expect(JSON.parse(s.raw.get(KEY)!).tabId).toBe('tab-B')
    expect(JSON.parse(s.raw.get(KEY)!).ts).toBe(100)
  })

  it('no-op when key absent', () => {
    const s = makeStorage()
    refreshClaim(HOST, 'tab-A', { storage: s.storage, now: () => 500 })
    expect(s.raw.has(KEY)).toBe(false)
  })
})

describe('releaseClaim', () => {
  it('removes own claim', () => {
    const s = makeStorage()
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-A', ts: 100 }))
    releaseClaim(HOST, 'tab-A', { storage: s.storage })
    expect(s.raw.has(KEY)).toBe(false)
  })

  it('does not touch a sibling tab\'s claim', () => {
    const s = makeStorage()
    s.raw.set(KEY, JSON.stringify({ tabId: 'tab-B', ts: 100 }))
    releaseClaim(HOST, 'tab-A', { storage: s.storage })
    expect(JSON.parse(s.raw.get(KEY)!).tabId).toBe('tab-B')
  })
})
