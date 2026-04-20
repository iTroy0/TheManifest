// Centralized constants for the P2P net layer. Previously duplicated
// verbatim across useSender / useReceiver / useCollabHost / useCollabGuest;
// a change had to land in up to four places. Keep this file flat and
// comment-heavy — the hooks are already large, this should stay trivial
// to read.

export const MAX_RETRIES = 2
export const TIMEOUT_MS = 10_000
export const RECONNECT_DELAY = 2_000
export const MAX_RECONNECTS = 3

// P3.1: derive from navigator.deviceMemory (approximate device RAM in GB,
// reported in 0.25/0.5/1/2/4/8 buckets). Each live DataConnection retains
// a Session, AdaptiveChunker, per-peer image queue, heartbeat timer, and
// transfer bookkeeping — ~1-2 MB resident under load. The cap exists to
// keep low-RAM devices (1 GB Android) from OOM-crashing under a full
// 1:N portal or 20-peer collab room while letting workstations carry more
// peers without an arbitrary low ceiling. `navigator.deviceMemory` is
// unsupported on Safari/Firefox today; absent → fall back to the legacy
// 20 (the value shipped before this fix, known-safe for everyday hardware).
export function getMaxConnections(deviceMemoryGb?: number): number {
  const mem = deviceMemoryGb ?? (typeof navigator !== 'undefined' ? (navigator as { deviceMemory?: number }).deviceMemory : undefined)
  if (mem === undefined) return 20
  if (mem >= 8) return 30
  if (mem >= 4) return 20
  if (mem >= 2) return 12
  if (mem >= 1) return 6
  return 4
}

// Computed once at module load. Tests that need a different cap call
// getMaxConnections(<gb>) directly with an explicit memory hint.
export const MAX_CONNECTIONS = getMaxConnections()

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

// Receiver waits this long for the sender's manifest after `connected`
// before surfacing a "taking longer than expected" escape with a Reload CTA.
// Keeps the spinner from being a dead end if the sender's manifest never
// arrives (slow link, sender bug, etc.).
export const MANIFEST_TIMEOUT_MS = 15_000
