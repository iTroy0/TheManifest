const TURN_URL = import.meta.env.VITE_TURN_URL as string | undefined
const SIGNAL_HOST = import.meta.env.VITE_SIGNAL_HOST as string | undefined
const SIGNAL_PATH = (import.meta.env.VITE_SIGNAL_PATH as string | undefined) || '/'
// Port + secure default to 443 / true so production deploys keep the
// existing behaviour. The test harness overrides both to point at a
// local peerjs-server over plain HTTP.
const SIGNAL_PORT_ENV = import.meta.env.VITE_SIGNAL_PORT as string | undefined
const SIGNAL_PORT = SIGNAL_PORT_ENV ? parseInt(SIGNAL_PORT_ENV, 10) : 443
const SIGNAL_SECURE = (import.meta.env.VITE_SIGNAL_SECURE as string | undefined) !== 'false'

interface SignalConfig {
  host: string
  port: number
  secure: boolean
  path: string
}

export interface PeerConfig {
  host?: string
  port?: number
  secure?: boolean
  path?: string
  config: {
    iceServers: RTCIceServer[]
    iceTransportPolicy?: RTCIceTransportPolicy
  }
}

const signalConfig: SignalConfig | Record<string, never> = SIGNAL_HOST ? {
  host: SIGNAL_HOST,
  port: SIGNAL_PORT,
  secure: SIGNAL_SECURE,
  path: SIGNAL_PATH,
} : {}

// STUN servers — self-hosted coturn first (same host as TURN, port 3478),
// Google's public STUN as fallback if our box is unreachable. ICE will try
// each in order during candidate gathering.
const selfHostedStun: RTCIceServer[] = TURN_URL ? [{ urls: `stun:${TURN_URL}:3478` }] : []
const googleStun: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]
const stunServers: RTCIceServer[] = [...selfHostedStun, ...googleStun]

export const STUN_ONLY: PeerConfig = {
  ...signalConfig,
  config: {
    iceServers: stunServers,
  },
}

// Fetches ephemeral HMAC-based TURN credentials (expire after 2 hours).
async function fetchTurnCredentials(signal: AbortSignal): Promise<{ username: string; credential: string; urls: string[] } | null> {
  try {
    const res = await fetch('/api/turn-credentials', { signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// L-a: extends `PeerConfig` with a `relayFallback` flag the UI can read to
// warn the user that the requested relay-only path failed and the session
// is now using STUN (which exposes the user's public IP to peers + STUN
// servers, contradicting the privacy claim that motivated requesting TURN
// in the first place). `relayFallback` is true only when TURN was requested
// AND every credential fetch attempt failed — when no TURN_URL is configured
// at all, the STUN-only path is intentional and `relayFallback` stays false.
// peerjs ignores unknown top-level keys, so `new Peer(result)` works as before.
export interface TurnResult extends PeerConfig {
  relayFallback: boolean
}

export async function getWithTurn(): Promise<TurnResult> {
  if (!TURN_URL) return { ...STUN_ONLY, relayFallback: false }

  // Try twice with a 3-second timeout each attempt (max 6s total vs 10s).
  // Between attempts, wait ~500 ms + jitter so a transient TURN API blip
  // isn't hit with a second request 0 ms later (which very often rides the
  // same failing connection). Jitter avoids thundering-herd if multiple
  // tabs recover simultaneously.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      const backoff = 500 + Math.floor(Math.random() * 500)
      await new Promise<void>(resolve => setTimeout(resolve, backoff))
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const creds = await fetchTurnCredentials(controller.signal)
      clearTimeout(timeout)
      if (creds) {
        return {
          ...signalConfig,
          config: {
            // Force relay so the browser doesn't gather host/srflx candidates
            // and leak the user's IP despite the explicit relay request.
            iceTransportPolicy: 'relay' as RTCIceTransportPolicy,
            // Omit Google STUN under relay-only: the ICE agent probes STUN
            // during gathering even when only relay candidates are used —
            // that would reveal the user's public IP to a third party.
            // Self-hosted STUN is kept (same trust domain as TURN).
            iceServers: [
              ...selfHostedStun,
              ...((creds.urls as string[]) || []).map((url: string) => ({ urls: url, username: creds.username, credential: creds.credential })),
            ],
          },
          relayFallback: false,
        }
      }
    } catch {
      clearTimeout(timeout)
    }
  }

  console.warn('TURN credential fetch failed after 2 attempts — falling back to STUN-only')
  return { ...STUN_ONLY, relayFallback: true }
}
