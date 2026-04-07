const TURN_URL = import.meta.env.VITE_TURN_URL
const TURN_USER = import.meta.env.VITE_TURN_USER
const TURN_PASS = import.meta.env.VITE_TURN_PASS
const SIGNAL_HOST = import.meta.env.VITE_SIGNAL_HOST
const SIGNAL_PATH = import.meta.env.VITE_SIGNAL_PATH || '/'

// Self-hosted PeerJS signaling config (falls back to PeerJS cloud if not set)
const signalConfig = SIGNAL_HOST ? {
  host: SIGNAL_HOST,
  port: 443,
  secure: true,
  path: SIGNAL_PATH,
} : {}

// Direct P2P only — no relay
export const STUN_ONLY = {
  ...signalConfig,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
}

// With TURN relay fallback (only if configured)
export const WITH_TURN = {
  ...signalConfig,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      ...(TURN_URL ? [
        { urls: `turn:${TURN_URL}:3478`, username: TURN_USER, credential: TURN_PASS },
        { urls: `turn:${TURN_URL}:3478?transport=tcp`, username: TURN_USER, credential: TURN_PASS },
      ] : []),
    ],
  },
}
