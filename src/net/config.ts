// Centralized constants for the P2P net layer. Previously duplicated
// verbatim across useSender / useReceiver / useCollabHost / useCollabGuest;
// a change had to land in up to four places. Keep this file flat and
// comment-heavy — the hooks are already large, this should stay trivial
// to read.

// ── Reconnect policy ────────────────────────────────────────────────────
export const MAX_RETRIES = 2
export const TIMEOUT_MS = 10_000
export const RECONNECT_DELAY = 2_000
export const MAX_RECONNECTS = 3

// ── Room / connection caps ──────────────────────────────────────────────
// Hardcoded everywhere today; future work should drive this from
// navigator.deviceMemory and measured heap headroom instead of a literal.
export const MAX_CONNECTIONS = 20

// ── In-memory download fallback (collab) ────────────────────────────────
// When StreamSaver isn't available (e.g., Safari/iOS) we buffer the
// whole file into RAM before saving. Cap prevents the tab from OOMing.
export const FALLBACK_MAX_BYTES = 200 * 1024 * 1024
export const FALLBACK_TOO_LARGE_MSG =
  'File too large for this browser. Max 200 MB without Chrome/Edge.'

// ── Download request lifetime (collab) ──────────────────────────────────
// Guest waits this long after requesting a file before giving up and
// surfacing 'unavailable' in the UI.
export const DOWNLOAD_REQUEST_TIMEOUT_MS = 30_000

// ── Password rate-limit ─────────────────────────────────────────────────
// Per-connection wrong-password attempts. Collab host uses this directly;
// the sender has a separate lifetime counter for backoff math (see
// useSender) — those are intentionally different scopes.
export const MAX_PASSWORD_ATTEMPTS = 5

// ── Chat image size cap ─────────────────────────────────────────────────
// Both sender and receiver abort an in-flight chat image once it exceeds
// this size. One constant used from both sides so they can't drift.
export const MAX_CHAT_IMAGE_SIZE = 10 * 1024 * 1024
