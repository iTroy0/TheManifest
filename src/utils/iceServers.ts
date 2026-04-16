// TURN URL is safe to expose (just a hostname, no credentials)
const TURN_URL = import.meta.env.VITE_TURN_URL as string | undefined
const SIGNAL_HOST = import.meta.env.VITE_SIGNAL_HOST as string | undefined
const SIGNAL_PATH = (import.meta.env.VITE_SIGNAL_PATH as string | undefined) || '/'

interface SignalConfig {
  host: string
  port: number
  secure: boolean
  path: string
}

// Shape of the config object passed to `new Peer(...)`. Includes the optional
// iceTransportPolicy so callers that force relay (TURN-only) typecheck.
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

// Self-hosted PeerJS signaling config (falls back to PeerJS cloud if not set)
const signalConfig: SignalConfig | Record<string, never> = SIGNAL_HOST ? {
  host: SIGNAL_HOST,
  port: 443,
  secure: true,
  path: SIGNAL_PATH,
} : {}

// STUN servers — self-hosted coturn first (same host as TURN, port 3478),
// Google's public STUN as fallback if our box is unreachable. ICE will try
// each in order during candidate gathering.
const stunServers: RTCIceServer[] = [
  ...(TURN_URL ? [{ urls: `stun:${TURN_URL}:3478` }] : []),
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

// Direct P2P only — no relay
export const STUN_ONLY: PeerConfig = {
  ...signalConfig,
  config: {
    iceServers: stunServers,
  },
}

// Fetch ephemeral TURN credentials from the server-side API.
// Credentials are HMAC-based and expire after 2 hours.
// Retries once on transient failure, then falls back to STUN-only.
async function fetchTurnCredentials(signal: AbortSignal): Promise<{ username: string; credential: string; urls: string[] } | null> {
  try {
    const res = await fetch('/api/turn-credentials', { signal })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

export async function getWithTurn(): Promise<PeerConfig> {
  if (!TURN_URL) return STUN_ONLY

  // Try twice with a 3-second timeout each attempt (max 6s total vs 10s)
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const creds = await fetchTurnCredentials(controller.signal)
      clearTimeout(timeout)
      if (creds) {
        return {
          ...signalConfig,
          config: {
            // Force all ICE candidates through TURN when the user opted into
            // relay. Without this flag the browser still gathers direct
            // host/srflx candidates and may leak the user's IP despite the
            // explicit relay request.
            iceTransportPolicy: 'relay' as RTCIceTransportPolicy,
            iceServers: [
              ...stunServers,
              ...((creds.urls as string[]) || []).map((url: string) => ({ urls: url, username: creds.username, credential: creds.credential })),
            ],
          },
        }
      }
    } catch {
      clearTimeout(timeout)
    }
  }

  console.warn('TURN credential fetch failed after 2 attempts — falling back to STUN-only')
  return STUN_ONLY
}
