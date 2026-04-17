# The Manifest — Audit Findings & Production-Grade Roadmap

Baseline: branch `dev`, HEAD = `b5b6dc0` (refactor(net): centralize duplicated constants).
Audit date: 2026-04-17. Sources: architect + code-reviewer passes over the full
tree, plus hand-verification of critical findings against the actual code.

Use this file as the resume point when picking up the hardening work from a
different machine. Pick a phase (P1/P2/P3), skim the findings, implement,
cross off.

---

## TL;DR

- **P0 is complete and shipped.** Seven high-severity issues fixed, logger
  utility added, constants centralized. See the "Already shipped" section.
- **P1 is partially complete.** `src/net/config.ts` is live;
  `src/net/keyExchange.ts` (P1.A) has landed with round-trip tests;
  `src/net/protocol.ts` (P1.B) is now both-directions locked — all
  five hooks dispatch inbound against the discriminated unions and
  construct outbound literals with `satisfies`. `src/net/session.ts`
  (P1.C) shipped with 38 unit tests; **all five hooks are now on
  Session**: useReceiver collapses ten per-connection refs into a
  single `sessionRef`; useSender splits every ConnState into
  `ConnEntry = { session, meta }` with pause/resume/cancel driven
  by `TransferHandle`; useCollabHost replaces `GuestConnection`
  with `GuestEntry = { session, meta }` keyed by `session.peerId`
  and preserves M12/M19/host-origin-rewrite invariants;
  useCollabGuest carries a `hostSessionRef` plus a
  `Map<peerId, MeshEntry>` for mesh peers, with a routing table
  (`activeTransferRoutesRef`) that keeps the P0 fix #3 origin
  check intact. `ConnState`, `GuestConnection`, `PeerConnection`,
  and `ActiveTransfer` are all deleted. `tsc` clean; 309/309
  tests pass. P1.C is complete; P1.D (`transferEngine.ts`) is
  the next optional milestone.
- **P2.1 done.** All ~200 silent `catch {}` in the four hooks migrated to
  `log.warn()` — 191 log sites across useSender/useReceiver/useCollabHost/
  useCollabGuest. Diagnostics buffer captures everything. "Copy diagnostics"
  + "Clear" buttons now live on the Privacy page.
- **P2 / P3 otherwise planning-only** — no code written yet.

---

## Already shipped (P0 + partial P1)

| Commit | Type | What it did |
|--------|------|-------------|
| `202b557` | chore | gitignore CLAUDE.md |
| `bb9970a` | feat(logger) | bounded ring buffer + `copyDiagnostics()` in `src/utils/logger.ts` |
| `e43c2c0` | fix(security) | P0 batch — see breakdown below |
| `b5b6dc0` | refactor(net) | centralize constants in `src/net/config.ts` (P1.item7) |

### P0 fixes inside `e43c2c0`
1. `iceServers.ts` — drop Google STUN under relay-only policy (IP-leak fix).
2. `api/turn-credentials.ts` — ignore client-leftmost `x-forwarded-for`;
   prefer `x-real-ip` or rightmost XFF. Rate-limit bucket no longer forgeable.
3. `useCollabGuest.ts:1225-1261` — owner verifies `requesterPeerId ===
   transfer.targetPeerId` before honoring forwarded pause/resume/cancel. Fixes
   the cross-guest grief vulnerability (any guest could cancel another guest's
   in-flight download just by replaying the fileId).
4. `useCollabGuest.ts` — mesh `peer.on('connection')` rejects inbound from
   peerIds not in the participant list.
5. `useCollabGuest.ts` — mesh handshake extracted `drainPendingRemoteKey` with
   a late re-check so the initiator never stalls to the 10 s timeout.
6. `useReceiver.ts:687-700` — `enableRelay` bumps `reconnectTokenRef`
   synchronously so in-flight async handlers detect the relay switch.
7. `useSender.ts` — reset `globalPasswordAttempts` on success so a room can't
   be permanently locked after 8 lifetime wrong guesses; use `timingSafeEqual`.
8. `fileChunker.ts` — `'onbufferedamountlow' in dc` replaces the always-true
   `typeof` check that left the polling fallback dead; added safety poll.

---

## Known findings NOT yet fixed

These came out of the code review. Severities are the reviewer's; I've
verified each one in the tree. Fix them in whichever phase fits.

### Medium

| # | File / line | Issue |
|---|-------------|-------|
| ~~M1~~ | ~~`utils/crypto.ts:53-63`~~ `sortedKeyDigest` | **DONE** — replaced the ambiguous two-branch loop with a proper `cmp = -1/0/+1` compare and an explicit `cmp === 0 ? cmp = a.length - b.length` tie-breaker. Defensive for any future variable-length caller; no change to current P-256 behaviour. |
| ~~M2~~ | ~~`utils/crypto.ts:11-16`~~ `base64ToUint8` | **DONE** — non-string inputs and `atob` failures now throw a typed `CryptoDecodeError` (exported). Existing try/catch sites still work because we still throw; new sites can branch on `instanceof CryptoDecodeError` if they need to distinguish decode failure from other errors. |
| ~~M3~~ | ~~`utils/fileChunker.ts:205-211`~~ | **DONE** — drain timeout now scales with `bufferedAmount` assuming a 128 KB/s slow-cellular floor: `min(60s, max(15s, ceil(bufferedAmount/128KB*2s)))`. A 4 MB queued buffer on a weak link gets ~60 s instead of 15 s and survives instead of killing the file mid-transfer. Fast paths still see the 15 s floor. |
| ~~M4~~ | ~~`utils/connectionHelpers.ts:50-55`~~ | **DONE** — `consecutivePingFailures = 0` after a successful `conn.send` in the ping timer. A short blip in the middle of a healthy session can no longer snowball into 3 consecutive failures across 15 s. `markAlive` and `visibilitychange` resets stay as additional paths. |
| M5 | `api/turn-credentials.ts` rate limiter | **WON'T-DO (in-code).** Infra work, not code work — requires migrating bucket storage to Vercel KV / Upstash Redis. Already documented in the code as advisory. Re-open when a persistent KV is actually provisioned. |
| ~~M6~~ | ~~`api/turn-credentials.ts:44-55`~~ | **DONE** — handler refuses to sign and returns 503 when `TURN_SECRET.length < 32`, with a loud `console.error` so the operator sees the 503s in the Vercel function log. L2 is rolled into this fix. |
| ~~M7~~ | ~~`useSender.ts:981-987`~~ `handleHostChunk` | **DONE** — added an early `if (!connState.inProgressImage) return` before `decryptChunk`. Stray chat-image chunks from a peer without a matching start no longer burn AES-GCM cycles. The post-await re-check stays so we still handle the race where `inProgressImage` got cleared while we were decrypting. |
| ~~M8~~ | ~~`useSender.ts:580-597`~~ | **DONE** — `startTransfer` and `endTransfer` hoisted out of `conn.on('data')` up to the same scope as `announceJoin` / `aggregateUI` (right after connState is created). Same lifetime as the connection, no allocation per inbound message. |
| ~~M9~~ | ~~`useSender.ts:439, 797`~~ | **VERIFIED-NOT-A-BUG** — every outbound `senderName` read lives inside a `useCallback` whose deps include `senderName` (sendMessage 816, sendTyping 822, sendReaction 842, changeSenderName 853). Long-lived `conn.on('data')` handler only relays `msg.nickname` from the original sender, never our own name. Re-check after each refactor; current tree is clean. |
| ~~M10~~ | ~~`useReceiver.ts:311-322`~~ | **DONE** (during P2.1) — `pendingManifestRef.current = null` now set in the key-exchange catch. |
| ~~M11~~ | ~~`useReceiver.ts:856`~~ | **DONE** — `lastChunkIndexRef.current = Math.max(lastChunkIndexRef.current, chunkIndex + 1)`. Out-of-order arrival can no longer roll the resume cursor backwards and corrupt reconnect continuation. |
| ~~M12~~ | ~~`useCollabHost.ts:944-1025`~~ | **DONE** — `gs.requestedFileIds: Set<string>` added to `GuestConnection`. Populated in the `collab-request-file` branch (before forwarding to the owner). Cleared on `collab-cancel-file` from the guest, on `collab-cancel-all`, on `collab-file-end` (successful), and on `collab-file-unavailable` (failure). The forward paths for `collab-pause-file` / `collab-resume-file` refuse to relay to the owner when the fileId is not in the set. Guest-side owner check (P0) remains the primary gate; this kills amplification-DoS. |
| ~~M13~~ | ~~`useCollabHost.ts:1535-1561`~~ `streamImageToConn` | **DONE** — all three streamers (`useSender`, `useCollabHost`, `useCollabGuest.streamImageToHost`) now wrap the chunk loop in try/catch and emit `{ type: 'chat-image-abort' }` on mid-stream failure. Every receiver side (useSender / useReceiver / useCollabHost / useCollabGuest) handles `chat-image-abort` by nulling its in-progress image slot. No more parked partial bytes waiting for the next start. |
| ~~M14~~ | ~~`useCollabHost.ts:470-471`~~ `sendFileToRequester` | **VERIFIED-NOT-A-BUG** — every site that sets `transfer.aborted = true` (cancel-file, cancel-all, disconnect paths at 636, 1047, 1076, 1236, 1265) already calls `transfer.pauseResolver()` afterwards. The pause loop's `while (paused && !aborted)` exits on the next tick. No separate `abortResolver` needed; re-check after any refactor. |
| ~~M15~~ | ~~`useCollabHost.ts:1293, 1070`~~ | **DONE** — `collab-file-end` now awaits `gs.chunkQueue` (per-peer) instead of `chunkQueueRef.current` (hook-level dead await — nothing actually appended to it after `gs.chunkQueue` landed). Removed the dead `chunkQueueRef` declaration. End-of-file processing no longer races against in-flight decrypts from other guests' uploads. |
| ~~M16~~ | ~~`useCall.ts:506`~~ | **DONE** — resolves the removeListener slot via `emitter.off ?? emitter.removeListener` (eventemitter3 exposes both), typed once, runtime-checked, still wrapped in try/catch. No behaviour change today; robust if either alias is dropped by a future peerjs/eventemitter3 upgrade. |
| ~~M17~~ | ~~`useCall.ts:74-114`~~ | **DONE** — folded into one `classifyMediaError(key, fallbackMessage, preferTableMessage)` keyed by the shared `MEDIA_ERROR_TABLE`. Both call sites (getUserMedia error handler + the ?? chain that lifts `useLocalMedia.error`) pass the appropriate preference flag. Behaviour unchanged; dead duplicated switch gone. |
| ~~M18~~ | ~~`useCall.ts:752-790`~~ | **DONE** — extended the duplicate-tab probe window from 150 ms to 300 ms. A sibling tab replying at 160-250 ms (main thread busy, under load) no longer slips past the guard and lets the user join twice. Still reads as instantaneous. |
| ~~M19~~ | ~~`state/collabState.ts:84` `isValidSharedFile`~~ | **DONE** — `addedAt` rejects negative values and anything more than 24 h in the future (blocks sort-top manipulation while tolerating normal cross-timezone clock skew). `size: 0` kept — empty files are legitimate. Host now rate-limits `collab-file-shared` broadcasts at 10/s per guest via `gs.recentFileShares` sliding window; excess shares are dropped with a log line instead of costing N-1 encrypted relays. |
| M20 | `ChatPanel.tsx:75-83` + `FileList.tsx:64-66` | **DEFERRED** — structural UI refactor (touches 63 KB ChatPanel + 32 KB FileList) disproportionate to the bug surface in practice. Revisit when ChatPanel gets broken up, ideally alongside P3.3 Playwright harness so the move can be smoke-tested end-to-end. |
| ~~M21~~ | ~~`useCollabGuest.ts:1636-1647`~~ | **DONE** — `retryWithRelay` deleted, `enableRelay` is the sole entry point. All UI (Portal, CollabGuestView) already called `enableRelay`; no caller churn. |
| ~~M22~~ | ~~`useCollabGuest.ts:1649-1656`~~ `leave()` | **DONE** — `leave()` now aborts `inProgressFilesRef` streams, clears download timeouts, and loops mesh `peerConnectionsRef` entries aborting each per-peer `inProgressFiles` writer before `peer.destroy()`. Mirrors the unmount teardown so nothing survives the room exit. |

### Low / nit

~~L1~~ `iceServers.ts` — **DONE.** Added a 500-1000 ms jittered backoff between the 2 TURN credential attempts so a transient API blip isn't hit again 0 ms later over the same failing connection. Jitter prevents thundering-herd when multiple tabs recover at once.
~~L2~~ `api/turn-credentials.ts` — **DONE with M6.**
~~L3~~ `useReceiver.ts:150` — **VERIFIED-NOT-A-BUG.** No outer `conn` parameter in the enclosing `connect()` scope; the inner `const conn = peer.connect(...)` is the first binding. Audit referred to an earlier tree.
~~L4~~ `useSender.ts:624` — **DONE.** Both `request-all` and `ready` loops now emit `{ type: 'file-skipped', index, reason }` to the receiver on per-file send failure. `useReceiver.ts` handles the message: dispatches `CANCEL_FILE` so the pending row disappears from the UI and appends a system message `"<name> skipped: <reason>"`. Before this the pending row sat at 0% forever and `batch-done` arrived with completedFiles < requested.
~~L5~~ `useSender.ts:159-170` `announceJoin` — **DONE.** `cs.nickname || 'Anon'` fallback applied to both the local system-msg and the fan-out `system-msg` broadcast. No more "  joined" when the reconnect/password-gate path fires the announce before the nickname lands.
~~L6~~ `useCollabHost.ts:844-855` — **DONE.** Comment now documents the trust model at the broadcast site: host rewrites the peer identity to `gs.peerId` (the authenticated connection owner) and explicitly warns future edits not to echo `msg.peerId` without adding validation, because that would reopen the impersonation path.
L7 `useCollabGuest.ts:442` `teardownMesh` — **WON'T-DO.** Reducer is already a no-op; the extra array allocation is micro-scale and the guard would make the teardown path harder to read. Leave unless profiler says otherwise.
L8 `useCall.ts:45` `TAB_ID` — not unique across hot-reload in dev. Acknowledged in comment; leave.
~~L9~~ **DONE.** Removed the `avgThroughput` compute + `void avgThroughput` suppression from `AdaptiveChunker.adjustChunkSize`. The `ChunkerStats.avgThroughput` field still exists — `getStats()` recomputes it on demand, which is the only caller.

---

## P1 — Network layer extraction (remaining)

Goal: shrink each of the four hooks to under ~400 lines and eliminate
protocol duplication.

### P1.A — `src/net/keyExchange.ts` **[DONE]**

~~Factor out the ECDH public-key receive/derive/fingerprint sequence
duplicated in all four hooks.~~ Done. `src/net/keyExchange.ts` exposes
`finalizeKeyExchange({ localPrivate, localPublic, remotePublic })` →
`{ encryptKey, fingerprint }`. Tests in `src/net/keyExchange.test.ts`
round-trip two keypairs and assert matching fingerprints + working AES
encrypt/decrypt across sides.

Migrated call sites (all 7):
- `useSender.ts` — `public-key` handler + `pendingRemoteKey` drain.
- `useReceiver.ts` — `public-key` handler.
- `useCollabHost.ts` — `public-key` handler + `pendingRemoteKey` drain.
- `useCollabGuest.ts` — host-conn `public-key`, mesh `public-key`,
  and `drainPendingRemoteKey`.

Hooks no longer import `importPublicKey` / `deriveSharedKey` /
`getKeyFingerprint` directly. 256/256 existing tests still pass.

### P1.B — `src/net/protocol.ts` **[DONE]**

Typed discriminated unions for every wire message. Landed as nine
commits — five inbound, four outbound.

**Inbound (already shipped):**

1. `6d5f8b5` — `src/net/protocol.ts` + round-trip tests. `PortalMsg`,
   `CollabEnvelope` + `CollabInnerMsg`, `CollabUnencryptedMsg`,
   `CallMsg`, `encodeEnc`/`decodeEnc`/`assertNever` helpers.
2. `a96fecf` — useSender inbound: `msg = data as PortalMsg`, call-*
   hoist, `NicknameChangeMsg` added to union.
3. `9a6239b` — useReceiver + useCollabHost + useCollabGuest inbound.
   Added `ManifestMsg`/`FileStartMsg`/`FileEndMsg` to PortalMsg,
   `ClosingMsg`/`JoinMsg`/`TypingMsg`/`ReactionMsg` to
   CollabUnencryptedMsg, `collab-peer-renamed` to CollabInnerMsg.
   Encrypted inner payloads go through
   `decryptJSON<CollabInnerMsg>`.
4. `9161bd3` — useCall: `call = msg as CallMsg`, `call-rejected`
   added to the union.

**Outbound (this pass):**

5. useSender — 34 sites → `satisfies PortalMsg`.
6. useReceiver — 18 sites → `satisfies PortalMsg`.
7. useCollabHost — ~50 sites → `satisfies CollabUnencryptedMsg` on
   outer DataConnection sends (including `collab-msg-enc` envelopes),
   `satisfies CollabInnerMsg` on `encryptJSON` inner payloads.
8. useCollabGuest — ~40 sites → same split as useCollabHost across
   host-conn and mesh PeerJS connections.
9. useCall — 11 sites → `satisfies CallMsg` via
   broadcast/sendToHost/sendToPeer.

Protocol adjustments picked up along the way:
- `collab-signal` now models both wire shapes: guest→host carries
  `target?`, host→target-guest carries `from?`.
- `CollabUnencryptedMsg.nickname-change` carries optional `oldName` to
  match guest/receiver senders.
- `call-track-state.peerId` is optional — guest self-reports omit it,
  host pins to the authenticated sender id on re-broadcast.
- `myPeerId!` non-null assertions at the call sites in useCall — the
  surrounding joinedRef / peer-connected guards already imply non-null;
  the assertion is an intent statement, runtime bytes unchanged.

`broadcast` / `sendToHost` / `sendToPeer` in the collab hooks still
type their `msg` param as `Record<string, unknown>` so they can carry
opaque CallMsg payloads from `setCallMessageHandler`. The lock-in sits
on each constructed literal at the call site, not on the bus function
itself — locks the shape where it matters, keeps the bus flexible.

tsc: clean across all nine commits. vitest: 271/271.

---

### P1.B — notes from the original plan (kept for reference)

Typed discriminated union for every wire message. Replace inline object
literals.

**Approach: domain-scoped unions.**
```ts
// Shared
export type PingMsg = { type: 'ping'; ts: number }
export type PongMsg = { type: 'pong'; ts: number }
export type PublicKeyMsg = { type: 'public-key'; key: number[] }

// Portal (useSender ↔ useReceiver)
export type PortalMsg =
  | PingMsg | PongMsg | PublicKeyMsg
  | { type: 'manifest-enc'; data: string }
  | { type: 'password-encrypted'; data: string }
  | { type: 'password-accepted' }
  | { type: 'password-wrong' }
  | { type: 'password-locked' }
  | { type: 'password-rate-limited' }
  | { type: 'request-file'; index: number }
  | { type: 'request-all' }
  | { type: 'pause-file'; index: number }
  | { type: 'resume-file'; index: number }
  | { type: 'cancel-file'; index: number }
  | { type: 'cancel-all' }
  | { type: 'typing'; nickname: string }
  | { type: 'reaction'; msgId: string; emoji: string; nickname: string }
  | { type: 'chat-encrypted'; data: string }
  | { type: 'relay-chat-encrypted'; data: string }
  | { type: 'file-cancelled'; index: number }
  | { type: 'cancel-all-ack' }

// Collab envelope
export type CollabEnvelope = { type: 'collab-msg-enc'; data: string }

// Collab inner payload types (encrypted inside CollabEnvelope)
export type CollabInner =
  | { type: 'collab-join'; ... }
  | { type: 'collab-peer-joined'; ... }
  | { type: 'collab-peer-left'; ... }
  | { type: 'collab-peer-renamed'; peerId: string; newName: string }
  | { type: 'collab-file-shared'; file: SharedFile }
  | { type: 'collab-file-removed'; fileId: string }
  | { type: 'collab-file-list'; files: SharedFile[] }
  | { type: 'collab-request-file'; fileId: string; owner?: string; requesterPeerId?: string }
  | { type: 'collab-file-start'; fileId: string; name: string; size: number; totalChunks: number }
  | { type: 'collab-pause-file'; fileId: string; requesterPeerId?: string }
  | { type: 'collab-resume-file'; fileId: string; requesterPeerId?: string }
  | { type: 'collab-cancel-file'; fileId: string; requesterPeerId?: string }
  | { type: 'collab-cancel-all' }
  | { type: 'collab-file-unavailable'; fileId: string; reason: string; requesterPeerId?: string }
  | { type: 'collab-chat'; ... }
  | { type: 'collab-typing'; nickname: string }
  | { type: 'collab-reaction'; ... }
  | { type: 'collab-kick' }
  | { type: 'collab-password-required' }
  | { type: 'collab-password-accepted' }
  | { type: 'collab-password-wrong' }
  | { type: 'collab-password-locked' }
  // … plus ~10 more collab-* messages; grep `type: 'collab-` to enumerate

// Call
export type CallMsg =
  | { type: 'call-offer'; ... }
  | { type: 'call-answer'; ... }
  | { type: 'call-hangup'; ... }
  | { type: 'call-mode-change'; mode: 'audio' | 'video' }
  // … plus peer-state messages; grep `callMessageHandlerRef` for full set
```

Helpers:
```ts
export async function encodeEnc<T>(key: CryptoKey, msg: T): Promise<string>
export async function decodeEnc<T>(key: CryptoKey, envelope: string): Promise<T>
```

`encodeEnc` / `decodeEnc` wrap `encryptJSON` / `decryptJSON` from
`utils/crypto.ts` — the behaviour is identical; the win is compile-time
exhaustiveness on the consuming switches.

**Migration strategy:** do one hook at a time, one message family at a time.
Add the type, cast the outbound construction, then tighten the inbound
switch to `assertNever`. Land each hook as its own commit so bisect is
useful if something regresses at runtime. Don't try to migrate all four
in one PR — the diff is unreadable.

**Gotchas:**
- `CollabEnvelope` wraps an encrypted `CollabInner`. Two-layer decode;
  don't collapse the types.
- Several messages include optional `requesterPeerId` — that's part of
  the P0 origin-check contract. Type it as optional, document why.
- Binary chunk packets (6-byte header) are NOT JSON and stay on the
  existing `buildChunkPacket` / `parseChunkPacket` path. Out of scope for
  protocol.ts.

### P1.C — `src/net/session.ts` (~1 week, High risk)

Per-peer state machine that collapses `ConnState` (useSender) +
`GuestConnection` (useCollabHost) + `PeerConnection` (useCollabGuest mesh) +
the receiver's ad-hoc connection refs.

**Plan:** `docs/plan-session.md`. Open questions answered
2026-04-17 (callMessageHandler stays on hook; event bus is a tiny
hand-written `on(type,fn)`; connectionsRef stays on hook; Session is
monomorphic with empty `requestedFileIds` / `recentFileShares` on
every role).

**Progress:**

- **Step 1 [DONE]** — `src/net/session.ts` landed alongside the
  existing hooks. No consumers migrated yet. Exposes:
  - `SessionState` / `SessionRole` / `CloseReason` enums.
  - `TransferHandle` + `InProgressImageSlot`.
  - `SessionInput` (non-terminal transitions) +
    `SessionEvent` (subscriber payloads).
  - `Session` interface: fields for handshake (`encryptKey`,
    `keyPair`, `pendingRemoteKey`, `keyExchangeTimeout`,
    `fingerprint`), liveness (`heartbeat`, `rttPoller`,
    `disconnectHandled`), lanes (`chunkQueue`, `imageSendQueue`,
    `uploadQueue`), bookkeeping (`activeTransfers`,
    `requestedFileIds`, `recentFileShares`, `inProgressImage`),
    password (`passwordVerified`, `passwordAttempts`), and methods
    `dispatch`, `close`, `send`, `sendBinary`, transfer helpers,
    field mutators, and a typed `on(type, fn)` bus.
  - `createSession({ conn, role, generation, passwordRequired, id? })`
    factory.
  - Pure `nextState(from, input, role, remaining)` transition fn
    encodes the table from `plan-session.md`. Terminal states are
    reached exclusively via `close(reason)`; non-terminal
    transitions flow through `dispatch`. `close()` runs cleanup
    (clears `keyExchangeTimeout`, stops heartbeat + rttPoller,
    aborts + unblocks every active transfer) and is idempotent.
  - Invariant preserved by construction: the `keys-derived` event
    carries `encryptKey` + `fingerprint` so the state flip and the
    field assignment happen atomically.
  - `send` / `sendBinary` throw from any terminal state.
- `src/net/session.test.ts` — 37 tests. Covers every valid
  non-terminal transition, every `CloseReason` → terminal-state
  mapping, `send` throwing from terminal, event emission (including
  listener-throw isolation), transfer begin/end/pause/resume/cancel
  bookkeeping, cleanup on terminal (`keyExchangeTimeout` cleared,
  heartbeat + rttPoller stopped, active transfers aborted),
  `close()` idempotence, `generation` plumbing, password
  `incrementPasswordAttempts` + `setPasswordVerified`, and a
  keyExchange integration check that two sessions end up at
  matching `encryptKey` + `fingerprint` via direct
  `finalizeKeyExchange`.
- Full suite: **308/308** (271 prior + 37 new). `tsc --noEmit` clean.

- **Step 5 [DONE]** — useCollabGuest migrated onto `Session`
  (host-conn + mesh peers in one commit — they share too many code
  paths to split cleanly). Two sessions per hook:
  `hostSessionRef: Session | null` (role `'collab-guest-host'`)
  replaces the 10 per-host refs (`hostConnRef`, `decryptKeyRef`,
  `keyPairRef`, `heartbeatRef`, `rttPollerRef`,
  `keyExchangeTimeoutRef`, `chunkQueueRef`, `imageSendQueueRef`,
  `inProgressImageRef`, `hostUploadQueueRef`), and
  `peerConnectionsRef: Map<peerId, MeshEntry>` with
  `MeshEntry = { session, meta: MeshMeta }` replaces
  `PeerConnection`. `MeshMeta` keeps two fields:
  `inProgressFiles` + `currentDownloadFileId` (per-mesh-peer
  inbound-download bookkeeping that doesn't belong on Session).
  Mesh sessions use role `'collab-guest-mesh'`.
  `activeTransfersRef` became
  `activeTransferRoutesRef: Map<fileId, { targetPeerId, session }>`
  — a router whose actual `TransferHandle` lives inside
  `session.activeTransfers`. A host-relayed `collab-pause-file` /
  `resume-file` / `cancel-file` looks up the route, enforces the
  P0 fix #3 origin check (`route.targetPeerId === requesterPeerId`),
  then dispatches `session.pauseTransfer` / `resumeTransfer` /
  `cancelTransfer`. Mesh-side control messages skip the origin
  check (the mesh conn is authenticated end-to-end via ECDH) and
  go straight to `session.pauseTransfer` etc. Host-session
  teardown on disconnect closes every mesh session and clears
  router entries; M22 `leave()` mirrors the unmount teardown.
  Guest line count: **2023 -> 1974** (-49 lines) — the
  `PeerConnection` interface and every per-mesh-peer field
  block are gone, replaced by Session + MeshMeta.
- **Step 4 [DONE]** — useCollabHost migrated onto `Session`.
  `GuestConnection` replaced by `GuestEntry = { session, meta }`
  where `GuestMeta` is two fields: `chunker` + `progressThrottler`.
  Every other per-guest field — handshake, liveness (heartbeat,
  rttPoller, disconnectHandled), lanes (chunkQueue, imageSendQueue,
  uploadQueue), password (verified, attempts), active transfers,
  requestedFileIds (M12), recentFileShares (M19), nickname,
  inProgressImage — now lives on the Session. The connection map
  keys are `session.peerId`. Per-file uploads drive through
  `session.beginTransfer(fileId)` + `session.endTransfer`;
  inbound pause/resume/cancel from a guest route via
  `session.pauseTransfer` / `resumeTransfer` / `cancelTransfer` /
  `cancelAllTransfers` — the `ActiveTransfer` interface is gone.
  Security invariants preserved: M12 requestedFileIds gate
  on pause/resume forwards, M19 sliding-window rate limit on
  collab-file-shared, host-origin rewrite on collab-peer-renamed
  and collab-file-shared broadcasts (peer identity always bound
  to `session.peerId`, never echoed from the payload). Password
  attempts use `session.incrementPasswordAttempts` +
  `session.setPasswordVerified`. The password-accepted branch
  also dispatches `password-accepted` to flip state
  `password-gate` -> `authenticated`. Host line count:
  **1704 -> 1635** (-69 lines) — the `GuestConnection` +
  `ActiveTransfer` interfaces plus every ad-hoc abort/pause
  bookkeeping clump are gone.
- **Step 3 [DONE]** — useSender migrated onto `Session`. The
  N-receiver room map now keys `Map<connId, ConnEntry>` where
  `ConnEntry = { session: Session, meta: SenderMeta }`. Session
  absorbs all per-connection state (handshake, liveness, lanes,
  inProgressImage, password counters, active-transfer bookkeeping,
  nickname). `SenderMeta` keeps UI accounting that is not session
  state: `progress`, `totalSent`, `startTime`, `transferTotalSize`,
  `speed`, `currentFileIndex`, `transferring`, `chunker`,
  `progressThrottler`, and the whole-connection `abort: { aborted }`
  bag (kept as a fresh object per transfer to preserve the
  old-code async-closure semantics). The old `pauseResolvers`,
  `cancelledFiles`, and `pausedFiles` sets are replaced by
  `TransferHandle` records per file, driven via
  `session.beginTransfer('file-${index}')`,
  `session.pauseTransfer`, `session.resumeTransfer`,
  `session.cancelTransfer`, and `session.cancelAllTransfers`.
  `sendSingleFile` now begins/ends the transfer around the chunk
  loop so session.state tracks transferring/authenticated
  accurately and `endTransfer` emits the right reason
  (`complete` / `cancelled` / `error`). Password flow uses
  `session.incrementPasswordAttempts` +
  `session.setPasswordVerified` in place of
  `connState.passwordAttempts`. Sender line count: **1113 → 1126**
  (slight growth from the cleaner Session/Meta/Entry separation;
  the wins are on the deleted `ConnState` interface and the
  uniform transfer-handle model).
- **Step 2 [DONE]** — useReceiver migrated onto `Session`. Ten
  per-connection refs are gone: `decryptKeyRef`, `keyPairRef`,
  `heartbeatRef`, `rttPollerRef`, `keyExchangeTimeoutRef`,
  `chunkQueueRef`, `imageSendQueueRef`, `inProgressImageRef`,
  `connRef`, and the receiver-side `reconnectTokenRef`'s per-session
  role. One `sessionRef: Session | null` carries them all. Hook-
  level `reconnectTokenRef` stays (it coordinates reconnect-intent
  across the hook lifetime; orthogonal to session identity, per
  `plan-session.md`). Extended `session.ts` so `keys-derived`
  auto-clears `keyExchangeTimeout` — single source of truth for
  the handshake watchdog. All paths that used to reach into
  individual refs (public-key handler, chunk decrypt, chat-image
  assembly, cancel/pause/resume/typing/reaction, enableRelay,
  beforeunload, online, visibilitychange, unmount cleanup) now
  read through `sessionRef.current` and use `sess.send` /
  `sess.close('peer-disconnect' | 'session-abort')`. Behaviour
  preserved: M10 pendingManifest null-on-error, M11 out-of-order
  chunk-cursor max, fingerprint rotation warning, and the
  zip-resume path all typecheck and test.
- Receiver line count: **1061 → 1056** (structural churn, not
  shrinkage — the real win is the centralised lifecycle).
- Full suite: **309/309** (271 prior + 38 session). `tsc --noEmit`
  clean.

**Still to do (in order, each its own commit):**

1. ~~Migrate useReceiver.~~ Done (step 2).
2. ~~Migrate useSender.~~ Done (step 3).
3. ~~Migrate useCollabHost guests.~~ Done (step 4).
4. ~~Migrate useCollabGuest host-conn.~~ Done (step 5).
5. ~~Migrate useCollabGuest mesh peers.~~ Done (step 5 — same
   commit; the two paths share enough code that splitting them
   would have needed a throwaway intermediate state).
6. ~~Delete `ConnState`, `GuestConnection`, `PeerConnection`.~~
   All three done as of steps 3-5. P1.C is complete.

### P1.C — historical note (kept for reference)

**Before writing code, write the plan.** Target: `docs/plan-session.md`
with:
1. Enumerated states: `idle → connecting → key-exchange → password-gate →
   authenticated → transferring → closed` (+ `error`, `kicked`).
2. Enumerated events: inbound-public-key, inbound-password, inbound-typing,
   outbound-send-chunk, peer-disconnect, heartbeat-dead, …
3. State transition table.
4. What's per-session vs per-hook (heartbeat is per-session, participant
   dispatches are per-hook).
5. How reconnect tokens interact with session lifecycle.

Without this plan, the extraction becomes a whack-a-mole of regressions.
Don't start coding until the plan is reviewed.

Depends on P1.A (keyExchange extraction) and P1.B (protocol types).

### P1.D — `src/net/transferEngine.ts` (~1 week, High risk)

Unified chunk send/receive engine consumed by all four hooks. Replaces:
- `useSender.sendSingleFile` + the aggregate loop.
- `useReceiver.handleChunk` + `streamsRef` management.
- `useCollabHost.sendFileToRequester` + `inProgressDownloadsRef`.
- `useCollabGuest.sendFileToRequester` + `inProgressFilesRef`.

Inputs: a `Session` (from P1.C) + a `File` / `fileId` + progress callback.
Outputs: progress events, completion, abort.

**Depends on P1.C.** Do not attempt in parallel.

### P1.E — `src/net/callBus.ts` (~30 min, Low risk, low ROI)

Already 80% extracted via `setMessageHandler` / `sendToHost` / `sendToPeer`
/ `broadcast`. Formalizing the interface is nice-to-have. Skip unless
you're about to touch call plumbing for another reason.

---

## P2 — Reliability & UX

### P2.1 — Full `catch {}` → `log.warn()` migration **[DONE]**

Logger is shipped (`src/utils/logger.ts`). ~~Now replace the ~200 silent
catches in the four hooks with `log.warn(...)`.~~ Done: 191 log sites
across useSender (44), useReceiver (28), useCollabHost (56),
useCollabGuest (63). Every silent catch now records context to the
ring buffer.

~~"Copy diagnostics" button~~ Done — `src/pages/Privacy.tsx` has a
Diagnostics section with Copy/Clear buttons that call `copyDiagnostics()`
/ `clearDiagnostics()` and write to the clipboard.

### P2.2 — Property / fuzz tests at protocol boundary **[DONE]**

`src/net/protocol-fuzz.test.ts` — 24 tests covering the pure helpers
that untrusted peer data flows through:

- **Round-trip fuzz** — 200 random `PortalMsg` + 200 random
  `CollabInnerMsg` + 100 `CollabUnencryptedMsg` + 100 `CallMsg`, each
  encoded via `encodeEnc` and decoded via `decodeEnc`, asserting deep
  equality. Fresh AES-GCM key per test.
- **Malformed ciphertext** — empty string, random non-base64 garbage,
  and ciphertext encrypted with a different key all reject via
  `decodeEnc`.
- **`assertNever` robustness** — 100 random off-union payloads,
  20 circular-reference payloads, and every primitive type (null,
  undefined, number, string, boolean, NaN) all throw with the
  context label intact. The guard never crashes the caller.
- **`sanitizeSharedFile` / `validateSharedFile` stress** — 500 valid
  shares accepted, 500 random-junk-field variants never throw, every
  invalid `size` (negative, NaN, Infinity, float, > 100 GB) rejected,
  `addedAt` future/negative rejected, oversized name/id rejected,
  oversized `thumbnail` and `textPreview` stripped by `sanitize` while
  the rest of the share stays valid, 500 purely random-shape inputs
  never throw.
- **Large payload round-trip** — 100 KB `chat-encrypted.data` and a
  `collab-file-list` with 100 entries both round-trip cleanly.

No third-party property library; one small hand-rolled generator in
the test file. Vitest picks it up via the glob and runs in ~400 ms.

**Not in scope:** hook-level fuzz (feeding msgs into
useSender/useReceiver/useCollabHost/useCollabGuest data handlers).
That needs a mocked DataConnection + Peer harness and is deferred.
The protocol-layer tests here catch every failure mode that isn't
hook-state dependent.

### P2.3 — Scale `waitForBufferDrain` timeout to observed throughput

See M3 above. Makes slow-cellular transfers survive.

### P2.4 — Mandatory fingerprint verification gate (opt-in UX)

Today the per-connection fingerprint panel is purely informational.
Add a toggle "Require fingerprint confirmation before first send" that
blocks the chat/file send actions until the user has clicked a
"Verified ✓" button on each peer. This is a real-world MITM defense
once users actually compare out-of-band.

Store the preference in-memory only (survives for the session, dies with
the tab — consistent with the zero-storage claim).

### P2.5 — Structured error taxonomy in the UI

`useCall.ts` has `CallError.code` (not-connected / permission-denied / etc).
Extend that pattern to the file transfer + collab paths. Every user-visible
error message should map to a single code; the UI maps codes to strings.
Avoids the current situation where "it got stuck" corresponds to ~6
different underlying failures with inconsistent wording.

### P2.6 — Host-side defense-in-depth for forwarded control messages

M12 — track `gs.requestedFileIds` on the host. Populate on
`collab-request-file`, clear on `collab-cancel-file` from gs or on
transfer completion. Refuse to forward pause/resume/cancel if gs isn't
in the set. Guest-side check (P0) is primary defense; this is the
amplification-DoS counter.

---

## P3 — Scale & ops

### P3.1 — `CONNECTION_LIMIT` driven by device capability

`MAX_CONNECTIONS = 20` is hardcoded in `src/net/config.ts`. Replace with
`getConnectionLimit()` that reads `navigator.deviceMemory` and a
measured heap headroom. Fallback to 20 when the API is missing.

### P3.2 — Self-hosted telemetry (optional)

Glitchtip or a minimal self-hosted Sentry. **Must be opt-in** and must
not log message content or file names. Only errors, stack traces, and
redacted peerIds. Document in the privacy page.

### P3.3 — Playwright / integration harness **[DONE (V1)]**

Playwright harness landed against a local `peerjs-server` so E2E
runs without depending on the public PeerJS cloud.

**Scaffold shipped:**

- `docs/plan-playwright.md` — design doc (scope, selectors,
  transport, CI integration, known risks, acceptance).
- `@playwright/test` + `peer` added as devDeps.
- `playwright.config.ts` — Chromium project, workers=1 (one
  signaling server per run), trace/video on failure, fake media
  devices so call-panel smoke doesn't prompt for mic/cam.
- `.env.test` — points the app at `localhost:9000` over plain
  HTTP; production defaults (port 443, secure) preserved.
- `src/utils/iceServers.ts` — added `VITE_SIGNAL_PORT` +
  `VITE_SIGNAL_SECURE` env hooks (default 443 / true).
- `e2e/global-setup.ts` / `global-teardown.ts` — in-process
  `peerjs-server` on port 9000.
- `e2e/helpers.ts` — shared page actions (getPortalUrl, uploadFile,
  sendChatMessage, expectDownloadMatches, etc.).

**V1 tests (shipped):**

- `portal.spec.ts` — 1:1 file round-trip with deterministic byte
  verification; chat round-trip (sender ↔ receiver); 1:N transfer
  to two concurrent receivers; fingerprint visibility on both
  sides.
- `collab.spec.ts` — host + guest admit, chat round-trip, join
  system-msg surfaces for host, navigating to a non-existent
  room shows an error, call panel structural smoke.

**V2 tests [DONE]:**

- Portal password gate — wrong password shows error, correct
  unlocks manifest, file downloads with byte-level verification.
  Waits 1200ms between attempts to clear the sender's 1s
  backoff.
- Portal receiver cancel — 10 MB fixture gives a real mid-stream
  window; click Download then Cancel before completion; sender
  leaves `transferring` state.
- Collab kick — host clicks kick, guest sees terminal banner.
  Test accepts either "removed from the room" (kicked status
  message) or "Room Closed" (conn.on('close') overwrites
  status='kicked' with 'closed'). Both are valid evidence.
- Collab close-room — host clicks Close Room, guest sees
  "Room Closed".
- Collab rename — host clicks edit-name pencil, fills new name,
  submits. Guest chat receives "renamed to <newName>" system
  message. Follow-up chat from renamed host still propagates.
- Collab guest→host file share — guest's file input (aria-label
  "Share files with the room", className="hidden") accepts
  setInputFiles; host's shared-file list renders the filename.

Data-testid attrs added to keep selectors stable across UI
copy changes:
- `portal-password-submit` (Portal password form)
- `collab-kick-${peerId}` (per-guest kick button)
- `collab-close-room`
- `collab-edit-name` (pencil next to host's own name)

**V2 tests still deferred (lower ROI / harder to assert):**

- Portal reconnect (offline → online event). Playwright has
  `context.setOffline(true)` but the assertion surface is fuzzy;
  reconnect success relies on PeerJS's ReconnectToken path that
  takes 2-3 s even on loopback.
- Collab mesh file share (guest1 owns, guest2 downloads direct).
  Byte-level verify is the same on mesh vs host-relay; DOM doesn't
  distinguish which route carried the chunks. A useful assertion
  would require a data-testid on the participant's
  `directConnection: true` chip and one guest seeing it for the
  other.

Full local run (Windows Chromium): **12/12 passing** after two
iteration rounds — one on V1 selectors, one on V2 timing +
hidden-input edge cases.

V2 needs targeted `data-testid` attributes on `CollabFileList` +
`FileList` + `ChatPanel` to be selector-stable across future UI
tweaks. Not a blocker to V1 — V1 uses role + text matching that
survives copy changes.

**Local run status:** 8/8 tests passing on Windows Chromium after
two selector-iteration rounds (`fix(e2e): chat focus, error copy,
fingerprint separator`). First run hit four failures on:
1. `<code>` locator assumption for share URLs (collab URL lives in
   a `<div>`, not `<code>`).
2. `input[type="file"]` aria-label mismatch (DropZone's input has
   no aria-label; Home's gated behind `isActive`).
3. Chat input `.click()` intercepted by overlapping glow-card —
   swapped to `.focus()`.
4. Error copy regex too narrow; fingerprint renders with space
   separator, not colon.

All four resolved; helpers are now tolerant of both states.

**CI:**

- `test.yml` gains an `e2e` job that depends on the unit-test job,
  installs Chromium with `npx playwright install --with-deps
  chromium`, runs `npm run test:e2e`, and uploads the
  `playwright-report` artifact on failure.

**Acceptance (partial):** V1 tests listed above are in the repo.
Full acceptance (every scope bullet) lives in the V2 list and will
land in a follow-up as data-testid attributes settle.

### P3.4 — Self-host runbook

`turn-setup.sh` and `signal-setup.sh` install the infra but don't cover
- cert rotation (Let's Encrypt renew is in cron by default but worth confirming)
- coturn log rotation (grows unbounded today)
- upgrade path (what `apt upgrade` is safe vs. needs a manual review)
- monitoring (systemd watchdog? basic `systemctl status` loop?)

Add `docs/self-hosting.md`.

### P3.5 — Bundle size **[DONE]**

Split the call stack into its own chunk via `React.lazy` + Suspense.
Added `src/components/CallPanelLazy.tsx` (tiny always-loaded stub)
and `src/components/CallPanelRuntime.tsx` (the lazy target that
calls `useLocalMedia` + `useCall` and renders `CallPanel`). All
four pages (Home / Portal / CollabHostView / CollabGuestView)
now import `CallPanelLazy` instead of the raw hooks/component.

Measured (vite build):

- Initial `index-*.js`: **591 KB -> 565 KB** (-26 KB raw,
  -6 KB gzip)
- New `CallPanelRuntime-*.js`: 50 KB / 15 KB gzip — loads after
  the page's main layout has rendered.

Net: ~50 KB / 15 KB gzip of call-lane code deferred off the
critical path. Less than the roadmap's "~150 KB" estimate, but a
real win and zero behaviour change (309/309 tests, production
build clean). Can't gate on "user clicked start call" because the
host needs `useCall`'s signaling handler installed BEFORE any
guest's `call-join` arrives; otherwise we drop the message and
the guest never gets a roster. A future pass could add a
lightweight signaling-stub that buffers `call-*` messages and
triggers the lazy load on first arrival, but that's a separate
design problem and the current split already pays for itself.

---

## Architecture observations (from audit)

### Hook gigantism — quantified

| File | Lines | Primary role |
|------|------:|--------------|
| `useCollabGuest.ts` | ~1800 | Collab guest: room join, mesh, file up/download, chat |
| `useCollabHost.ts`  | ~1560 | Collab host: signaling, fan-out, password, upload/relay |
| `useCall.ts`        | ~1045 | Voice/video call state machine (audio + video + signaling) |
| `useSender.ts`      | ~1040 | Portal 1:N sender |
| `useReceiver.ts`    | ~1005 | Portal receiver |
| `ChatPanel.tsx`     | ~1270 | Chat UI — messages, replies, images, voice notes |

The first five are effect-heavy state machines that happen to be React
hooks. Each carries: PeerJS lifecycle, ICE state tracking, key exchange,
reconnect policy, chunk routing, password flow, UI dispatch, call plumbing.
The P1 extractions are the path to <400 lines/hook.

### Protocol drift

~40 wire message types today, ~half of them `collab-*`. No single source
of truth. Rename = grep-and-pray. This is what P1.B (`protocol.ts`) fixes.

### Observability

Hundreds of `catch {}` in the four hot hooks. When a user reports "stuck
at 42%" there is nothing to look at. P0 shipped the logger; P2.1 is the
mechanical replacement pass.

### Security invariants that must be preserved

- Per-chunk IV in AES-GCM (don't ever reuse).
- `timingSafeEqual` for password checks — no early-exit compare.
- `importPublicKey` validates P-256 curve points; don't bypass.
- `iceTransportPolicy: 'relay'` when TURN is forced — and no Google STUN
  in the server list under that policy (P0).
- Collab host never decrypts guest↔guest content. Every pair-wise link
  gets its own ECDH key for a reason. Don't "optimise" this.
- Constant-time XOR for any credential comparison (applies to future
  features too — don't `===` a token).

### Things intentionally out of scope

- `libp2p` / `Yjs` / `Automerge-repo` migration — violates the
  self-hosted / zero-third-party claim. Don't.
- Third-party fonts / CDNs. CSP blocks them; everything is bundled via
  `@fontsource-variable/*`.
- Any "AI-assisted" inline features that phone home.

---

## Recommended ordering

If picking this up fresh:

1. Ship P2.1 first — the `catch {}` migration. Low risk, high observability
   value, unblocks every subsequent investigation.
2. P1.A (keyExchange). Bounded, has tests, visible de-duplication.
3. P1.B (protocol). Bigger, but now the compiler is your friend.
4. Pause — verify with a real mesh session that nothing regressed.
5. Write `docs/plan-session.md` for P1.C before touching session code.
6. P1.C + P1.D in its own branch. Land behind a feature flag if possible,
   or ship after a staging run with multiple real participants.
7. P2.x — pick based on user reports.
8. P3.x — pick based on scale.

The M1–M22 / L1–L9 findings can be interleaved with the bigger items
whenever you're already editing the relevant file.
