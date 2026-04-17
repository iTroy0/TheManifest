// Session state machine + lifecycle tests. Covers every non-terminal
// transition listed in docs/plan-session.md, the terminal close paths,
// event emission, cleanup, and a keyExchange integration check that
// proves the session wrapper lands on the same artefacts as direct
// `finalizeKeyExchange` calls.

import { describe, it, expect, vi } from 'vitest'
import type { DataConnection } from 'peerjs'
import {
  createSession,
  type Session,
  type SessionRole,
  type CreateSessionOpts,
} from './session'
import {
  generateKeyPair,
  exportPublicKey,
  encryptChunk,
  decryptChunk,
} from '../utils/crypto'
import { finalizeKeyExchange } from './keyExchange'

// ── Helpers ──────────────────────────────────────────────────────────────

function mockConn(peerId = 'remote-peer'): DataConnection {
  return {
    peer: peerId,
    open: true,
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    close: vi.fn(),
  } as unknown as DataConnection
}

function makeSession(
  role: SessionRole = 'portal-receiver',
  opts: Partial<CreateSessionOpts> = {},
): Session {
  return createSession({ conn: mockConn(), role, ...opts })
}

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  )
}

async function walkToAuthenticated(
  s: Session,
  requiresPassword = false,
): Promise<void> {
  s.dispatch({ type: 'connect-start' })
  s.dispatch({ type: 'conn-open' })
  s.dispatch({
    type: 'keys-derived',
    encryptKey: await aesKey(),
    fingerprint: 'ab:cd',
    requiresPassword,
  })
  if (s.state === 'password-gate') {
    s.dispatch({ type: 'password-accepted' })
  }
}

// ── Construction ─────────────────────────────────────────────────────────

describe('Session — construction', () => {
  it('starts in idle with sane defaults', () => {
    const s = makeSession()
    expect(s.state).toBe('idle')
    expect(s.generation).toBe(0)
    expect(s.encryptKey).toBeNull()
    expect(s.fingerprint).toBeNull()
    expect(s.nickname).toBeNull()
    expect(s.passwordRequired).toBe(false)
    expect(s.passwordVerified).toBe(false)
    expect(s.passwordAttempts).toBe(0)
    expect(s.activeTransfers.size).toBe(0)
    expect(s.requestedFileIds.size).toBe(0)
  })

  it('picks up peerId from conn.peer when not supplied', () => {
    const s = createSession({ conn: mockConn('alice-1'), role: 'portal-sender' })
    expect(s.peerId).toBe('alice-1')
  })

  it('carries an explicit generation', () => {
    const s = makeSession('portal-receiver', { generation: 7 })
    expect(s.generation).toBe(7)
  })

  it('generates distinct ids', () => {
    const a = makeSession()
    const b = makeSession()
    expect(a.id).not.toBe(b.id)
  })
})

// ── Happy-path transitions ──────────────────────────────────────────────

describe('Session — transition table', () => {
  it('idle → connecting → key-exchange → authenticated', async () => {
    const s = makeSession('portal-receiver')
    s.dispatch({ type: 'connect-start' })
    expect(s.state).toBe('connecting')
    s.dispatch({ type: 'conn-open' })
    expect(s.state).toBe('key-exchange')
    s.dispatch({
      type: 'keys-derived',
      encryptKey: await aesKey(),
      fingerprint: 'de:ad',
    })
    expect(s.state).toBe('authenticated')
  })

  it('routes a password-gated receiver through password-gate', async () => {
    const s = makeSession('portal-receiver', { passwordRequired: true })
    s.dispatch({ type: 'connect-start' })
    s.dispatch({ type: 'conn-open' })
    s.dispatch({
      type: 'keys-derived',
      encryptKey: await aesKey(),
      fingerprint: 'aa:bb',
      requiresPassword: true,
    })
    expect(s.state).toBe('password-gate')
    s.dispatch({ type: 'password-accepted' })
    expect(s.state).toBe('authenticated')
  })

  it('roles that never gate skip password-gate even with requiresPassword', async () => {
    const roles: SessionRole[] = [
      'portal-sender',
      'collab-host',
      'collab-guest-mesh',
    ]
    for (const role of roles) {
      const s = makeSession(role)
      s.dispatch({ type: 'connect-start' })
      s.dispatch({ type: 'conn-open' })
      s.dispatch({
        type: 'keys-derived',
        encryptKey: await aesKey(),
        fingerprint: 'ff:00',
        requiresPassword: true,
      })
      expect(s.state).toBe('authenticated')
    }
  })

  it('collab-guest-host honours requiresPassword', async () => {
    const s = makeSession('collab-guest-host')
    s.dispatch({ type: 'connect-start' })
    s.dispatch({ type: 'conn-open' })
    s.dispatch({
      type: 'keys-derived',
      encryptKey: await aesKey(),
      fingerprint: '11:22',
      requiresPassword: true,
    })
    expect(s.state).toBe('password-gate')
  })

  it('ignores out-of-order dispatches without throwing', () => {
    const s = makeSession()
    s.dispatch({ type: 'conn-open' })
    expect(s.state).toBe('idle')
    s.dispatch({ type: 'password-accepted' })
    expect(s.state).toBe('idle')
  })

  it('keys-derived atomically sets encryptKey and fingerprint', async () => {
    const s = makeSession('portal-sender')
    s.dispatch({ type: 'connect-start' })
    s.dispatch({ type: 'conn-open' })
    const k = await aesKey()
    s.dispatch({ type: 'keys-derived', encryptKey: k, fingerprint: '44:55' })
    expect(s.encryptKey).toBe(k)
    expect(s.fingerprint).toBe('44:55')
    expect(s.state).toBe('authenticated')
  })

  it('keys-derived disarms any pending keyExchangeTimeout', async () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const s = makeSession('portal-receiver')
    s.dispatch({ type: 'connect-start' })
    s.dispatch({ type: 'conn-open' })
    s.keyExchangeTimeout = setTimeout(fired, 10_000)
    s.dispatch({
      type: 'keys-derived',
      encryptKey: await aesKey(),
      fingerprint: '66:77',
    })
    expect(s.keyExchangeTimeout).toBeNull()
    vi.advanceTimersByTime(20_000)
    expect(fired).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
})

// ── Transfer state ──────────────────────────────────────────────────────

describe('Session — transfers', () => {
  it('beginTransfer flips to transferring', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    s.beginTransfer({
      transferId: 't1',
      direction: 'outbound',
      aborted: false,
      paused: false,
    })
    expect(s.state).toBe('transferring')
    expect(s.activeTransfers.get('t1')).toBeDefined()
  })

  it('endTransfer waits for the last transfer before returning to authenticated', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    s.beginTransfer({ transferId: 't1', direction: 'outbound', aborted: false, paused: false })
    s.beginTransfer({ transferId: 't2', direction: 'outbound', aborted: false, paused: false })
    s.endTransfer('t1', 'complete')
    expect(s.state).toBe('transferring')
    s.endTransfer('t2', 'complete')
    expect(s.state).toBe('authenticated')
  })

  it('cancelAllTransfers aborts handles and returns to authenticated', async () => {
    const s = makeSession('collab-host')
    await walkToAuthenticated(s)
    let resolved = false
    const h = {
      transferId: 't1',
      direction: 'outbound' as const,
      aborted: false,
      paused: true,
      pauseResolver: () => {
        resolved = true
      },
    }
    s.beginTransfer(h)
    s.cancelAllTransfers()
    expect(h.aborted).toBe(true)
    expect(resolved).toBe(true)
    expect(s.state).toBe('authenticated')
    expect(s.activeTransfers.size).toBe(0)
  })

  it('pauseTransfer + resumeTransfer toggles the flag and fires the resolver', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    let fired = false
    const h = {
      transferId: 't1',
      direction: 'outbound' as const,
      aborted: false,
      paused: false,
      pauseResolver: undefined as undefined | (() => void),
    }
    s.beginTransfer(h)
    s.pauseTransfer('t1')
    expect(h.paused).toBe(true)
    h.pauseResolver = () => {
      fired = true
    }
    s.resumeTransfer('t1')
    expect(h.paused).toBe(false)
    expect(fired).toBe(true)
  })

  it('cancelTransfer marks the handle aborted and fires the resolver', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    let fired = false
    const h = {
      transferId: 't1',
      direction: 'outbound' as const,
      aborted: false,
      paused: true,
      pauseResolver: () => {
        fired = true
      },
    }
    s.beginTransfer(h)
    s.cancelTransfer('t1')
    expect(h.aborted).toBe(true)
    expect(fired).toBe(true)
  })

  it('pause/resume/cancel on an unknown transferId are no-ops', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    expect(() => s.pauseTransfer('nope')).not.toThrow()
    expect(() => s.resumeTransfer('nope')).not.toThrow()
    expect(() => s.cancelTransfer('nope')).not.toThrow()
  })
})

// ── Send path ───────────────────────────────────────────────────────────

describe('Session — send', () => {
  it('send() invokes conn.send when not terminal', () => {
    const conn = mockConn()
    const s = createSession({ conn, role: 'portal-receiver' })
    s.send({ type: 'ping', ts: 1 })
    expect(conn.send).toHaveBeenCalledWith({ type: 'ping', ts: 1 })
  })

  it('send() throws from every terminal state', () => {
    for (const reason of ['session-abort', 'kicked', 'error'] as const) {
      const s = makeSession()
      s.close(reason)
      expect(() => s.send({ type: 'ping', ts: 1 })).toThrowError(
        /terminal state/,
      )
    }
  })

  it('sendBinary() throws from terminal state', () => {
    const s = makeSession()
    s.close('session-abort')
    expect(() => s.sendBinary(new ArrayBuffer(4))).toThrowError(/terminal state/)
  })
})

// ── Events ──────────────────────────────────────────────────────────────

describe('Session — events', () => {
  it('emits state-change for every real transition', async () => {
    const s = makeSession()
    const seen: Array<{ from: string; to: string }> = []
    s.on('state-change', e => {
      seen.push({ from: e.from, to: e.to })
    })
    await walkToAuthenticated(s)
    expect(seen).toEqual([
      { from: 'idle', to: 'connecting' },
      { from: 'connecting', to: 'key-exchange' },
      { from: 'key-exchange', to: 'authenticated' },
    ])
  })

  it('does not emit state-change on no-op dispatches', () => {
    const s = makeSession()
    const fn = vi.fn()
    s.on('state-change', fn)
    s.dispatch({ type: 'conn-open' }) // invalid from idle
    expect(fn).not.toHaveBeenCalled()
  })

  it('emits fingerprint on keys-derived', async () => {
    const s = makeSession()
    let fp: string | null = null
    s.on('fingerprint', e => {
      fp = e.value
    })
    s.dispatch({ type: 'connect-start' })
    s.dispatch({ type: 'conn-open' })
    s.dispatch({
      type: 'keys-derived',
      encryptKey: await aesKey(),
      fingerprint: '77:88',
    })
    expect(fp).toBe('77:88')
  })

  it('emits nickname on setNickname', () => {
    const s = makeSession()
    let name: string | null = null
    s.on('nickname', e => {
      name = e.value
    })
    s.setNickname('alice')
    expect(name).toBe('alice')
    expect(s.nickname).toBe('alice')
  })

  it('emits transfer-begin and transfer-end', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    const begin = vi.fn()
    const end = vi.fn()
    s.on('transfer-begin', begin)
    s.on('transfer-end', end)
    s.beginTransfer({
      transferId: 't1',
      direction: 'outbound',
      aborted: false,
      paused: false,
    })
    s.endTransfer('t1', 'complete')
    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transfer-begin', transferId: 't1' }),
    )
    expect(end).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'transfer-end',
        transferId: 't1',
        reason: 'complete',
      }),
    )
  })

  it('emits closed with the originating reason', () => {
    const s = makeSession()
    let reason: string | null = null
    s.on('closed', e => {
      reason = e.reason
    })
    s.close('heartbeat-dead')
    expect(reason).toBe('heartbeat-dead')
  })

  it('on() returns an unsubscribe fn', () => {
    const s = makeSession()
    const fn = vi.fn()
    const off = s.on('state-change', fn)
    off()
    s.dispatch({ type: 'connect-start' })
    expect(fn).not.toHaveBeenCalled()
  })

  it('listener throws do not corrupt downstream delivery', () => {
    const s = makeSession()
    const good = vi.fn()
    s.on('state-change', () => {
      throw new Error('boom')
    })
    s.on('state-change', good)
    s.dispatch({ type: 'connect-start' })
    expect(good).toHaveBeenCalled()
  })
})

// ── Close / cleanup ─────────────────────────────────────────────────────

describe('Session — close and cleanup', () => {
  it('every CloseReason lands on the right terminal state', () => {
    const cases: Array<{
      reason: Parameters<Session['close']>[0]
      state: string
    }> = [
      { reason: 'peer-disconnect', state: 'closed' },
      { reason: 'heartbeat-dead', state: 'closed' },
      { reason: 'session-abort', state: 'closed' },
      { reason: 'complete', state: 'closed' },
      { reason: 'kicked', state: 'kicked' },
      { reason: 'error', state: 'error' },
      { reason: 'protocol-off-union', state: 'error' },
      { reason: 'key-exchange-timeout', state: 'error' },
      { reason: 'password-locked', state: 'error' },
    ]
    for (const c of cases) {
      const s = makeSession()
      s.close(c.reason)
      expect(s.state).toBe(c.state)
    }
  })

  it('close is idempotent', () => {
    const s = makeSession()
    s.close('session-abort')
    s.close('kicked') // ignored — already terminal
    s.close('error')
    expect(s.state).toBe('closed')
  })

  it('terminal state rejects further non-terminal dispatches', () => {
    const s = makeSession()
    s.close('session-abort')
    s.dispatch({ type: 'connect-start' })
    s.dispatch({ type: 'conn-open' })
    expect(s.state).toBe('closed')
  })

  it('clears keyExchangeTimeout on close', () => {
    vi.useFakeTimers()
    const fired = vi.fn()
    const s = makeSession()
    s.keyExchangeTimeout = setTimeout(fired, 10_000)
    s.close('session-abort')
    vi.advanceTimersByTime(20_000)
    expect(fired).not.toHaveBeenCalled()
    expect(s.keyExchangeTimeout).toBeNull()
    vi.useRealTimers()
  })

  it('stops heartbeat and rttPoller on close', () => {
    const hbStop = vi.fn()
    const rttStop = vi.fn()
    const s = makeSession()
    s.heartbeat = { stop: hbStop } as unknown as Session['heartbeat']
    s.rttPoller = { stop: rttStop } as unknown as Session['rttPoller']
    s.close('session-abort')
    expect(hbStop).toHaveBeenCalled()
    expect(rttStop).toHaveBeenCalled()
    expect(s.heartbeat).toBeNull()
    expect(s.rttPoller).toBeNull()
  })

  it('aborts every active transfer on close', async () => {
    const s = makeSession('portal-sender')
    await walkToAuthenticated(s)
    let resolved = false
    const h = {
      transferId: 't1',
      direction: 'outbound' as const,
      aborted: false,
      paused: true,
      pauseResolver: () => {
        resolved = true
      },
    }
    s.beginTransfer(h)
    s.close('peer-disconnect')
    expect(h.aborted).toBe(true)
    expect(resolved).toBe(true)
  })

  it('sets disconnectHandled on close', () => {
    const s = makeSession()
    s.close('session-abort')
    expect(s.disconnectHandled).toBe(true)
  })
})

// ── Password plumbing ───────────────────────────────────────────────────

describe('Session — password plumbing', () => {
  it('incrementPasswordAttempts bumps the counter', () => {
    const s = makeSession('collab-host', { passwordRequired: true })
    expect(s.incrementPasswordAttempts()).toBe(1)
    expect(s.incrementPasswordAttempts()).toBe(2)
    expect(s.passwordAttempts).toBe(2)
  })

  it('setPasswordVerified flips the flag', () => {
    const s = makeSession('collab-host', { passwordRequired: true })
    expect(s.passwordVerified).toBe(false)
    s.setPasswordVerified()
    expect(s.passwordVerified).toBe(true)
  })
})

// ── Key exchange integration ────────────────────────────────────────────

describe('Session — key exchange integration (P1.A)', () => {
  it('two sessions end up with matching encryptKey + fingerprint', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const aPub = await exportPublicKey(a.publicKey)
    const bPub = await exportPublicKey(b.publicKey)

    const aResult = await finalizeKeyExchange({
      localPrivate: a.privateKey,
      localPublic: aPub,
      remotePublic: bPub,
    })
    const bResult = await finalizeKeyExchange({
      localPrivate: b.privateKey,
      localPublic: bPub,
      remotePublic: aPub,
    })

    const sa = makeSession('portal-sender')
    const sb = makeSession('portal-receiver')
    sa.dispatch({ type: 'connect-start' })
    sa.dispatch({ type: 'conn-open' })
    sa.dispatch({
      type: 'keys-derived',
      encryptKey: aResult.encryptKey,
      fingerprint: aResult.fingerprint,
    })
    sb.dispatch({ type: 'connect-start' })
    sb.dispatch({ type: 'conn-open' })
    sb.dispatch({
      type: 'keys-derived',
      encryptKey: bResult.encryptKey,
      fingerprint: bResult.fingerprint,
    })

    expect(sa.fingerprint).toBe(sb.fingerprint)
    expect(sa.state).toBe('authenticated')
    expect(sb.state).toBe('authenticated')

    const enc = await encryptChunk(
      sa.encryptKey!,
      new TextEncoder().encode('via session'),
    )
    const dec = await decryptChunk(sb.encryptKey!, enc)
    expect(new TextDecoder().decode(dec)).toBe('via session')
  })
})
