import { describe, it, expect, vi, beforeEach } from 'vitest'

// Each test group resets modules so import.meta.env is re-read fresh
// vi.stubEnv patches import.meta.env keys for the duration of the test

async function loadModule() {
  const mod = await import('./iceServers')
  return mod
}

describe('iceServers – default config (no env vars set)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', '')
    vi.stubEnv('VITE_TURN_USER', '')
    vi.stubEnv('VITE_TURN_PASS', '')
    vi.stubEnv('VITE_SIGNAL_HOST', '')
    vi.stubEnv('VITE_SIGNAL_PATH', '')
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

  it('WITH_TURN.config.iceServers has no TURN servers when no env vars are set', async () => {
    const { WITH_TURN } = await loadModule()
    const hasTurn = WITH_TURN.config.iceServers.some((s: RTCIceServer) =>
      typeof s.urls === 'string' ? s.urls.startsWith('turn:') : false
    )
    expect(hasTurn).toBe(false)
  })

  it('STUN_ONLY does not include signalConfig keys when VITE_SIGNAL_HOST is not set', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as Record<string, unknown>).host).toBeUndefined()
    expect((STUN_ONLY as Record<string, unknown>).port).toBeUndefined()
  })

  it('WITH_TURN does not include signalConfig keys when VITE_SIGNAL_HOST is not set', async () => {
    const { WITH_TURN } = await loadModule()
    expect((WITH_TURN as Record<string, unknown>).host).toBeUndefined()
    expect((WITH_TURN as Record<string, unknown>).port).toBeUndefined()
  })
})

describe('iceServers – with VITE_SIGNAL_HOST configured', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_SIGNAL_HOST', 'signal.example.com')
    vi.stubEnv('VITE_SIGNAL_PATH', '/peerjs')
  })

  it('STUN_ONLY includes host from VITE_SIGNAL_HOST', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as Record<string, unknown>).host).toBe('signal.example.com')
  })

  it('STUN_ONLY includes port 443', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as Record<string, unknown>).port).toBe(443)
  })

  it('STUN_ONLY includes secure: true', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as Record<string, unknown>).secure).toBe(true)
  })

  it('STUN_ONLY includes path from VITE_SIGNAL_PATH', async () => {
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as Record<string, unknown>).path).toBe('/peerjs')
  })

  it('WITH_TURN also includes signalConfig when VITE_SIGNAL_HOST is set', async () => {
    const { WITH_TURN } = await loadModule()
    expect((WITH_TURN as Record<string, unknown>).host).toBe('signal.example.com')
    expect((WITH_TURN as Record<string, unknown>).port).toBe(443)
  })

  it('defaults VITE_SIGNAL_PATH to "/" when not provided', async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_SIGNAL_HOST', 'signal.example.com')
    // VITE_SIGNAL_PATH intentionally not set
    const { STUN_ONLY } = await loadModule()
    expect((STUN_ONLY as Record<string, unknown>).path).toBe('/')
  })
})

describe('iceServers – with TURN credentials configured', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', 'turn.example.com')
    vi.stubEnv('VITE_TURN_USER', 'turnuser')
    vi.stubEnv('VITE_TURN_PASS', 'turnpass')
  })

  it('WITH_TURN.config.iceServers includes a UDP TURN server with credentials', async () => {
    const { WITH_TURN } = await loadModule()
    const servers = WITH_TURN.config.iceServers as RTCIceServer[]
    const udpTurn = servers.find(
      (s) => typeof s.urls === 'string' && s.urls === 'turn:turn.example.com:3478'
    )
    expect(udpTurn).toBeDefined()
    expect(udpTurn?.username).toBe('turnuser')
    expect(udpTurn?.credential).toBe('turnpass')
  })

  it('WITH_TURN.config.iceServers includes a TCP TURN server with credentials', async () => {
    const { WITH_TURN } = await loadModule()
    const servers = WITH_TURN.config.iceServers as RTCIceServer[]
    const tcpTurn = servers.find(
      (s) => typeof s.urls === 'string' && s.urls === 'turn:turn.example.com:3478?transport=tcp'
    )
    expect(tcpTurn).toBeDefined()
    expect(tcpTurn?.username).toBe('turnuser')
    expect(tcpTurn?.credential).toBe('turnpass')
  })

  it('WITH_TURN.config.iceServers still includes Google STUN fallbacks', async () => {
    const { WITH_TURN } = await loadModule()
    const urls = WITH_TURN.config.iceServers.map((s: RTCIceServer) => s.urls)
    expect(urls).toContain('stun:stun.l.google.com:19302')
    expect(urls).toContain('stun:stun1.l.google.com:19302')
  })

  it('WITH_TURN.config.iceServers includes a self-hosted STUN entry from VITE_TURN_URL', async () => {
    const { WITH_TURN } = await loadModule()
    const urls = WITH_TURN.config.iceServers.map((s: RTCIceServer) => s.urls)
    expect(urls).toContain('stun:turn.example.com:3478')
  })

  it('STUN_ONLY never includes TURN servers even when TURN env vars are set', async () => {
    const { STUN_ONLY } = await loadModule()
    const hasTurn = STUN_ONLY.config.iceServers.some((s: RTCIceServer) =>
      typeof s.urls === 'string' ? s.urls.startsWith('turn:') : false
    )
    expect(hasTurn).toBe(false)
  })

  it('STUN_ONLY includes the self-hosted STUN entry from VITE_TURN_URL', async () => {
    const { STUN_ONLY } = await loadModule()
    const urls = STUN_ONLY.config.iceServers.map((s: RTCIceServer) => s.urls)
    expect(urls).toContain('stun:turn.example.com:3478')
  })
})

describe('iceServers – partial env (TURN_URL without user/pass)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', 'turn.example.com')
    vi.stubEnv('VITE_TURN_USER', '')
    vi.stubEnv('VITE_TURN_PASS', '')
    vi.stubEnv('VITE_SIGNAL_HOST', '')
    vi.stubEnv('VITE_SIGNAL_PATH', '')
  })

  it('WITH_TURN includes TURN entry but with empty/undefined credentials', async () => {
    const { WITH_TURN } = await loadModule()
    const servers = WITH_TURN.config.iceServers as RTCIceServer[]
    const turnEntry = servers.find(
      (s) => typeof s.urls === 'string' && s.urls.startsWith('turn:')
    )
    expect(turnEntry).toBeDefined()
    expect(turnEntry?.username).toBeFalsy()
    expect(turnEntry?.credential).toBeFalsy()
  })

  it('STUN_ONLY still has no TURN servers with partial env', async () => {
    const { STUN_ONLY } = await loadModule()
    const hasTurn = STUN_ONLY.config.iceServers.some((s: RTCIceServer) =>
      typeof s.urls === 'string' ? s.urls.startsWith('turn:') : false
    )
    expect(hasTurn).toBe(false)
  })
})

describe('iceServers – STUN_ONLY never has TURN servers regardless of env', () => {
  it('STUN_ONLY has no TURN servers with all TURN env vars set', async () => {
    vi.resetModules()
    vi.unstubAllEnvs()
    vi.stubEnv('VITE_TURN_URL', 'turn.example.com')
    vi.stubEnv('VITE_TURN_USER', 'user')
    vi.stubEnv('VITE_TURN_PASS', 'pass')
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
