// Centralized constants for the P2P net layer. Previously duplicated
// verbatim across useSender / useReceiver / useCollabHost / useCollabGuest;
// a change had to land in up to four places. Keep this file flat and
// comment-heavy — the hooks are already large, this should stay trivial
// to read.

export const MAX_RETRIES = 2
export const TIMEOUT_MS = 10_000
export const RECONNECT_DELAY = 2_000
export const MAX_RECONNECTS = 3

// Future work: drive from navigator.deviceMemory + heap headroom instead of a literal.
export const MAX_CONNECTIONS = 20

// When StreamSaver isn't available (e.g., Safari/iOS) we buffer the whole file into RAM.
// Cap prevents the tab from OOMing.
export const FALLBACK_MAX_BYTES = 200 * 1024 * 1024
export const FALLBACK_TOO_LARGE_MSG =
  'File too large for this browser. Max 200 MB without Chrome/Edge.'

// Guest waits this long after requesting a file before surfacing 'unavailable' in the UI.
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000

// Per-connection wrong-password attempts. Collab host uses this directly;
// the sender has a separate lifetime counter for backoff math (see
// useSender) — those are intentionally different scopes.
export const MAX_PASSWORD_ATTEMPTS = 5

// One constant shared by sender + receiver so the abort threshold can't drift.
export const MAX_CHAT_IMAGE_SIZE = 10 * 1024 * 1024
