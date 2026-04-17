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
- **P1 is partially started.** `src/net/config.ts` is live, and
  `src/net/keyExchange.ts` (P1.A) has landed with round-trip tests — all
  seven ECDH derive call sites in the four hooks now funnel through
  `finalizeKeyExchange`. The remaining P1 pieces (protocol, session,
  transferEngine) are staged as independent commits.
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
| M3 | `utils/fileChunker.ts:205-211` | 15 s drain timeout rejects mid-transfer on slow cellular. Fix: scale to `max(15s, bufferedAmount / observedThroughput * 2)` or make configurable via `config.ts`. |
| ~~M4~~ | ~~`utils/connectionHelpers.ts:50-55`~~ | **DONE** — `consecutivePingFailures = 0` after a successful `conn.send` in the ping timer. A short blip in the middle of a healthy session can no longer snowball into 3 consecutive failures across 15 s. `markAlive` and `visibilitychange` resets stay as additional paths. |
| M5 | `api/turn-credentials.ts` rate limiter | Per-instance on Vercel → advisory only. Already documented in the code. Upgrade path: Vercel KV / Upstash Redis keyed by the same IP. |
| ~~M6~~ | ~~`api/turn-credentials.ts:44-55`~~ | **DONE** — handler refuses to sign and returns 503 when `TURN_SECRET.length < 32`, with a loud `console.error` so the operator sees the 503s in the Vercel function log. L2 is rolled into this fix. |
| ~~M7~~ | ~~`useSender.ts:981-987`~~ `handleHostChunk` | **DONE** — added an early `if (!connState.inProgressImage) return` before `decryptChunk`. Stray chat-image chunks from a peer without a matching start no longer burn AES-GCM cycles. The post-await re-check stays so we still handle the race where `inProgressImage` got cleared while we were decrypting. |
| M8 | `useSender.ts:580-597` `conn.on('data')` | `startTransfer` / `endTransfer` declared inside the handler → new closure per message. GC pressure on an active chat channel. Fix: hoist to `conn.on('open')` or module scope. |
| ~~M9~~ | ~~`useSender.ts:439, 797`~~ | **VERIFIED-NOT-A-BUG** — every outbound `senderName` read lives inside a `useCallback` whose deps include `senderName` (sendMessage 816, sendTyping 822, sendReaction 842, changeSenderName 853). Long-lived `conn.on('data')` handler only relays `msg.nickname` from the original sender, never our own name. Re-check after each refactor; current tree is clean. |
| ~~M10~~ | ~~`useReceiver.ts:311-322`~~ | **DONE** (during P2.1) — `pendingManifestRef.current = null` now set in the key-exchange catch. |
| ~~M11~~ | ~~`useReceiver.ts:856`~~ | **DONE** — `lastChunkIndexRef.current = Math.max(lastChunkIndexRef.current, chunkIndex + 1)`. Out-of-order arrival can no longer roll the resume cursor backwards and corrupt reconnect continuation. |
| M12 | `useCollabHost.ts:944-1025` | **Defense-in-depth follow-up to P0 fix #3.** Host-side should also track `gs.requestedFileIds` and refuse to forward pause/resume/cancel if gs hasn't requested the file. Guest-side check is currently sufficient; this closes the amplification-DoS angle. |
| M13 | `useCollabHost.ts:1535-1561` `streamImageToConn` | `await waitForBufferDrain` not wrapped — 15 s rejection propagates out of the image queue; partial transfer leaves receiver with stuck `inProgressImage`. Fix: try/catch and emit `chat-image-abort`. |
| M14 | `useCollabHost.ts:470-471` `sendFileToRequester` | Pause-loop has no wake signal on **abort** (only on pauseResolver). `handleDisconnect` clears the resolver but only in disconnect paths. Fix: add explicit `abortResolver` alongside `pauseResolver`. |
| M15 | `useCollabHost.ts:1293, 1070` | `chunkQueueRef` is hook-level — every inbound chunk from any guest blocks end-of-file processing for other guests. `gs.chunkQueue` exists and should be used per-peer instead. |
| ~~M16~~ | ~~`useCall.ts:506`~~ | **DONE** — resolves the removeListener slot via `emitter.off ?? emitter.removeListener` (eventemitter3 exposes both), typed once, runtime-checked, still wrapped in try/catch. No behaviour change today; robust if either alias is dropped by a future peerjs/eventemitter3 upgrade. |
| M17 | `useCall.ts:74-114` | `classifyMediaError` and `liftLocalMediaError` near-identical AI-shaped switches. Fix: single classifier keyed by normalized `{name|code}` table. |
| ~~M18~~ | ~~`useCall.ts:752-790`~~ | **DONE** — extended the duplicate-tab probe window from 150 ms to 300 ms. A sibling tab replying at 160-250 ms (main thread busy, under load) no longer slips past the guard and lets the user join twice. Still reads as instantaneous. |
| M19 | `state/collabState.ts:84` `isValidSharedFile` | **PARTIAL** — `addedAt` now rejects negative values and anything more than 24 h in the future (blocks sort-top manipulation while tolerating normal cross-timezone clock skew). `size: 0` is kept — empty files are legitimate. Per-peer host-side rate-limit of shared-file broadcasts is still open. |
| M20 | `ChatPanel.tsx:75-83` + `FileList.tsx:64-66` | Blob-URL lifecycle owned by UI components (`chatBlobUrlsRef`) instead of the hook; can desync on Fast Refresh. Fix: hoist into `useChatPanelState`. |
| ~~M21~~ | ~~`useCollabGuest.ts:1636-1647`~~ | **DONE** — `retryWithRelay` deleted, `enableRelay` is the sole entry point. All UI (Portal, CollabGuestView) already called `enableRelay`; no caller churn. |
| ~~M22~~ | ~~`useCollabGuest.ts:1649-1656`~~ `leave()` | **DONE** — `leave()` now aborts `inProgressFilesRef` streams, clears download timeouts, and loops mesh `peerConnectionsRef` entries aborting each per-peer `inProgressFiles` writer before `peer.destroy()`. Mirrors the unmount teardown so nothing survives the room exit. |

### Low / nit

~~L1~~ `iceServers.ts` — **DONE.** Added a 500-1000 ms jittered backoff between the 2 TURN credential attempts so a transient API blip isn't hit again 0 ms later over the same failing connection. Jitter prevents thundering-herd when multiple tabs recover at once.
~~L2~~ `api/turn-credentials.ts` — **DONE with M6.**
L3 `useReceiver.ts:150` — inner `conn` shadows outer param; rename for readability.
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

### P1.B — `src/net/protocol.ts`  (~3–4 h, Medium risk)

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

### P2.2 — Property / fuzz tests at protocol boundary

Once `protocol.ts` lands (P1.B), write a fuzzer that generates:
- Random valid `PortalMsg` / `CollabInner` / `CallMsg`.
- Intentionally malformed variants (wrong field types, missing required fields,
  oversized strings up to the `isValidSharedFile` limits).
Assert the hook's message dispatch never throws and never leaks memory
(peerConnectionsRef and downloads are cleared on error).

Suggested tool: Vitest + a small home-rolled property generator. Don't pull
in a dependency.

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

### P3.3 — Playwright / integration harness

`ChatPanel.tsx` (63 KB), `CallPanel.tsx` (31 KB), and `CollabFileList.tsx`
(32 KB) are un-unit-testable. Add a Playwright suite that boots two
headless browsers and drives a real portal + collab flow. Even one golden
path per entry hook catches 80% of future regressions.

### P3.4 — Self-host runbook

`turn-setup.sh` and `signal-setup.sh` install the infra but don't cover
- cert rotation (Let's Encrypt renew is in cron by default but worth confirming)
- coturn log rotation (grows unbounded today)
- upgrade path (what `apt upgrade` is safe vs. needs a manual review)
- monitoring (systemd watchdog? basic `systemctl status` loop?)

Add `docs/self-hosting.md`.

### P3.5 — Bundle size

`dist/assets/index-*.js` is 591 KB (167 KB gzip). `vite.config.ts` already
splits peerjs / streamsaver / dnd / qrcode. Remaining win: lazy-load the
call stack (useCall + CallPanel + useLocalMedia + useSpeakingLevels +
AudioTile + VideoTile) — only needed when the user clicks "Start call".
Could cut ~150 KB off the initial bundle.

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
