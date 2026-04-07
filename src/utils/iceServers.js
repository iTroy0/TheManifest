const TURN_URL = import.meta.env.VITE_TURN_URL
const TURN_USER = import.meta.env.VITE_TURN_USER
const TURN_PASS = import.meta.env.VITE_TURN_PASS

// Direct P2P only — no relay
export const STUN_ONLY = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  },
}

// With TURN relay fallback (only if configured)
export const WITH_TURN = {
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
