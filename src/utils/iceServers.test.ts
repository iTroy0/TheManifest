import { describe, it, expect, vi, beforeEach } from 'vitest'

async function loadModule() {
  const mod = await import('./iceServers')
  return mod
}

describe('iceServers – default config (no env vars set)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', '')
    vi.stubEnv('VITE_SIGNAL_HOST', '')
    vi.stubEnv('VITE_SIGNAL_PATH', '')
    // Blank port/secure so production defaults (443 / true) apply.
    vi.stubEnv('VITE_SIGNAL_PORT', '')
    vi.stubEnv('VITE_SIGNAL_SECURE', '')
  })

  it('STUN_ONLY.config.iceServers contains only Google STUN fallbacks', async () => {
    const { STUN_ONLY } = await loadModule()
    const urls = STUN_ONLY.config.iceServers.map((s: RTCIceServer) => s.urls)
    expect(urls).toContain('stun:stun.l.google.com:19302')
    expect(urls).toContain('stun:stun1.l.google.com:19302')
  })

  it('STUN_ONLY.config.iceServers has no TURN servers when no env vars are set', async () => {
    const { STUN_ONLY } = await loadModule()
    const hasTurn = STUN_ONLY.config.iceServers.some((s: RTCIceServer) =>
      typeof s.urls === 'string' ? s.urls.startsWith('turn:') : false
    )
    expect(hasTurn).toBe(false)
  })

  it('getWithTurn returns STUN_ONLY (relayFallback=false) when VITE_TURN_URL is not set', async () => {
    const { STUN_ONLY, getWithTurn } = await loadModule()
    const result = await getWithTurn()
    expect(result).toEqual({ ...STUN_ONLY, relayFallback: false })
    expect(result.relayFallback).toBe(false)
  })

  it('STUN_ONLY does not include signalConfig keys when VITE_SIGNAL_HOST is not set', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as unknown as Record<string, unknown>).host).toBeUndefined()
    expect((STUN_ONLY as unknown as Record<string, unknown>).port).toBeUndefined()
  })
})

describe('iceServers – with VITE_SIGNAL_HOST configured', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_SIGNAL_HOST', 'signal.example.com')
    vi.stubEnv('VITE_SIGNAL_PATH', '/peerjs')
    // Blank port/secure so production defaults (443 / true) apply.
    vi.stubEnv('VITE_SIGNAL_PORT', '')
    vi.stubEnv('VITE_SIGNAL_SECURE', '')
  })

  it('STUN_ONLY includes host from VITE_SIGNAL_HOST', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as unknown as Record<string, unknown>).host).toBe('signal.example.com')
  })

  it('STUN_ONLY includes port 443', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as unknown as Record<string, unknown>).port).toBe(443)
  })

  it('STUN_ONLY includes secure: true', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as unknown as Record<string, unknown>).secure).toBe(true)
  })

  it('STUN_ONLY includes path from VITE_SIGNAL_PATH', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as unknown as Record<string, unknown>).path).toBe('/peerjs')
  })

  it('getWithTurn also includes signalConfig when VITE_SIGNAL_HOST is set', async () => {
    vi.stubEnv('VITE_TURN_URL', 'turn.example.com')
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        username: 'testuser',
        credential: 'testcred',
        urls: ['turn:turn.example.com:3478'],
      }),
    })
    const { getWithTurn } = await loadModule()
    const result = await getWithTurn()
    expect((result as unknown as Record<string, unknown>).host).toBe('signal.example.com')
    expect((result as unknown as Record<string, unknown>).port).toBe(443)
  })

  it('defaults VITE_SIGNAL_PATH to "/" when not provided', async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_SIGNAL_HOST', 'signal.example.com')
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as unknown as Record<string, unknown>).path).toBe('/')
  })
})

describe('iceServers – getWithTurn with API response', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', 'turn.example.com')
    vi.stubEnv('VITE_SIGNAL_PORT', '')
    vi.stubEnv('VITE_SIGNAL_SECURE', '')
  })

  it('getWithTurn includes TURN servers from API response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        username: 'ephemeral-user',
        credential: 'ephemeral-cred',
        urls: ['turn:turn.example.com:3478', 'turn:turn.example.com:3478?transport=tcp'],
      }),
    })
    const { getWithTurn } = await loadModule()
    const result = await getWithTurn()
    const servers = result.config.iceServers as RTCIceServer[]
    const udpTurn = servers.find(
      (s) => typeof s.urls === 'string' && s.urls === 'turn:turn.example.com:3478'
    )
    expect(udpTurn).toBeDefined()
    expect(udpTurn?.username).toBe('ephemeral-user')
    expect(udpTurn?.credential).toBe('ephemeral-cred')
  })

  it('getWithTurn includes TCP TURN server from API response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        username: 'ephemeral-user',
        credential: 'ephemeral-cred',
        urls: ['turn:turn.example.com:3478', 'turn:turn.example.com:3478?transport=tcp'],
      }),
    })
    const { getWithTurn } = await loadModule()
    const result = await getWithTurn()
    const servers = result.config.iceServers as RTCIceServer[]
    const tcpTurn = servers.find(
      (s) => typeof s.urls === 'string' && s.urls === 'turn:turn.example.com:3478?transport=tcp'
    )
    expect(tcpTurn).toBeDefined()
    expect(tcpTurn?.username).toBe('ephemeral-user')
    expect(tcpTurn?.credential).toBe('ephemeral-cred')
  })

  it('getWithTurn omits Google STUN under relay-only policy to prevent IP leak', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        username: 'u', credential: 'c',
        urls: ['turn:turn.example.com:3478'],
      }),
    })
    const { getWithTurn } = await loadModule()
    const result = await getWithTurn()
    const urls = result.config.iceServers.map((s: RTCIceServer) => s.urls)
    expect(urls).not.toContain('stun:stun.l.google.com:19302')
    expect(urls).not.toContain('stun:stun1.l.google.com:19302')
    expect(result.config.iceTransportPolicy).toBe('relay')
  })

  it('getWithTurn includes self-hosted STUN entry from VITE_TURN_URL', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        username: 'u', credential: 'c',
        urls: ['turn:turn.example.com:3478'],
      }),
    })
    const { getWithTurn } = await loadModule()
    const result = await getWithTurn()
    const urls = result.config.iceServers.map((s: RTCIceServer) => s.urls)
    expect(urls).toContain('stun:turn.example.com:3478')
  })

  it('getWithTurn falls back to STUN_ONLY when API fails (relayFallback=true)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const { STUN_ONLY, getWithTurn } = await loadModule()
    const result = await getWithTurn()
    expect(result).toEqual({ ...STUN_ONLY, relayFallback: true })
    expect(result.relayFallback).toBe(true)
  })

  it('getWithTurn falls back to STUN_ONLY when API returns non-ok (relayFallback=true)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 503 })
    const { STUN_ONLY, getWithTurn } = await loadModule()
    const result = await getWithTurn()
    expect(result).toEqual({ ...STUN_ONLY, relayFallback: true })
    expect(result.relayFallback).toBe(true)
  })

  it('getWithTurn returns relayFallback=false on successful TURN credential fetch', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        username: 'u', credential: 'c',
        urls: ['turn:turn.example.com:3478'],
      }),
    })
    const { getWithTurn } = await loadModule()
    const result = await getWithTurn()
    expect(result.relayFallback).toBe(false)
  })
})

describe('iceServers – STUN_ONLY never has TURN servers regardless of env', () => {
  it('STUN_ONLY has no TURN servers with VITE_TURN_URL set', async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', 'turn.example.com')
    const { STUN_ONLY } = await loadModule()
    const hasTurn = STUN_ONLY.config.iceServers.some((s: RTCIceServer) =>
      typeof s.urls === 'string' ? s.urls.startsWith('turn:') : false
    )
    expect(hasTurn).toBe(false)
  })

  it('STUN_ONLY has no TURN servers with no env vars set', async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    const { STUN_ONLY } = await loadModule()
    const hasTurn = STUN_ONLY.config.iceServers.some((s: RTCIceServer) =>
      typeof s.urls === 'string' ? s.urls.startsWith('turn:') : false
    )
    expect(hasTurn).toBe(false)
  })
})
