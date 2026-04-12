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
export const STUN_ONLY = {
  ...signalConfig,
  config: {
    iceServers: stunServers,
  },
}

// Fetch ephemeral TURN credentials from the server-side API.
// Credentials are HMAC-based and expire after 24 hours.
// Falls back to STUN-only if the API is unavailable.
export async function getWithTurn(): Promise<typeof STUN_ONLY> {
  if (!TURN_URL) return STUN_ONLY

  try {
    const res = await fetch('/api/turn-credentials')
    if (!res.ok) return STUN_ONLY
    const { username, credential, urls } = await res.json()
    return {
      ...signalConfig,
      config: {
        iceServers: [
          ...stunServers,
          ...((urls as string[]) || []).map((url: string) => ({ urls: url, username, credential })),
        ],
      },
    }
  } catch {
    return STUN_ONLY
  }
}
