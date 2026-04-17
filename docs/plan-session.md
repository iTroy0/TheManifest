# P1.C — `src/net/session.ts` plan

Unify four independent per-peer state machines into one `Session` type
consumed by every hook.

Baseline: branch `dev`, HEAD after the P1.B outbound pass.
Plan date: 2026-04-17. This document is the contract — don't start
coding until it's reviewed and the open questions at the bottom are
answered.

---

## Motivation

Today four structs model "a live peer connection":

| Struct | File | Scope |
|--------|------|------|
| `ConnState` | `useSender.ts:34` | Per receiver of a portal sender |
| `GuestConnection` | `useCollabHost.ts:57` | Per guest of a collab host |
| `PeerConnection` | `useCollabGuest.ts:47` | Per mesh peer of a collab guest |
| _ad-hoc refs_ | `useReceiver.ts:63-93` | Single host connection (30+ Refs) |

They carry 80%-overlapping fields with drift:
- `encryptKey`, `keyPair`, `pendingRemoteKey`, `keyExchangeTimeout`,
  `fingerprint` — identical ECDH state across all four, phrasing subtly
  different (useCollabGuest uses `encryptKey: null` sentinel,
  useReceiver uses `decryptKeyRef` — same object, different name).
- `heartbeat`, `rttPoller`, `disconnectHandled`, `chunkQueue` —
  identical plumbing, copy-pasted three times.
- Password state (`passwordVerified`, `passwordAttempts`) lives on
  `GuestConnection` only; useSender tracks it as a loose `ConnState`
  optional + a hook-level `globalPasswordAttempts`.
- `activeTransfers` / `inProgressFiles` / `pausedFiles` / etc — four
  distinct shapes for the same "what's in-flight on this peer" concept.

The consequences are visible in the audit: M11 (lastChunkIndexRef reset
bug) and M15 (per-peer vs hook-level chunkQueue await race) both came
from ad-hoc state that would not exist if every peer went through a
single session object with documented invariants.

The P1.B pass made protocol drift a compile-time error. P1.C does the
same for session-lifecycle drift.

---

## States

Every peer-facing connection is in exactly one state at any moment.
Transitions are driven by explicit events; the `current === x` check
is valid from outside the session as long as callers never mutate state
directly (all mutation goes through `session.dispatch(event)`).

```
idle
  ↓ connect-start
connecting
  ↓ conn-open
key-exchange
  ↓ keys-derived          ↓ keys-derived (pwd required)
authenticated             password-gate
                            ↓ pwd-accepted
                          authenticated
  ↓ transfer-start
transferring ──── (loop: chunks + pause/resume/cancel) ──── authenticated
  ↓ peer-disconnect / heartbeat-dead / abort
closed

(error)  — terminal, set on any unrecoverable failure (key-exchange
          timeout, decrypt failure past a threshold, invalid public key,
          peer sent off-union message, etc.)
(kicked) — terminal, host-originated or self-initiated room exit
```

**Invariants:**
- `encryptKey !== null` ⇔ state ∈ {authenticated, password-gate, transferring, closed}
  (password-gate only enters after keys are derived).
- `fingerprint !== undefined` ⇔ `encryptKey !== null`.
- `transferring` is re-entrant — multiple concurrent transfers on the
  same session share the state; we track per-transfer refs inside the
  session but the session-level flag is set if ≥1 transfer is active.
- `closed` and `error` and `kicked` are terminal; no outbound send is
  legal from these states. `session.send(m)` throws if called from a
  terminal state.
- Heartbeat only starts in `key-exchange` (first data round-trip proves
  the channel is up). Ping/pong before that wastes cycles on a channel
  we don't trust yet.

---

## Events

Inbound (from peer):
- `inbound:public-key` — remote ECDH public key bytes. Triggers
  `finalizeKeyExchange` via P1.A. First event that can transition us
  out of `key-exchange`.
- `inbound:password-encrypted` — host-only; guest's encrypted password
  attempt. Subject to global + per-conn attempt caps (see P0 fix #7).
- `inbound:password-*` — guest-only; accepted/wrong/locked/rate-limited.
- `inbound:ping`, `inbound:pong` — heartbeat plumbing, don't change
  state but reset the liveness timer.
- `inbound:typing`, `inbound:reaction` — UI dispatch only.
- `inbound:chat-encrypted`, `inbound:chat-image-*` — UI dispatch only.
- `inbound:manifest-enc` (portal) / `inbound:collab-file-list` (collab)
  — first real payload that unblocks the UI from the "waiting for
  manifest" gate.
- `inbound:file-start`, `inbound:chunk`, `inbound:file-end`,
  `inbound:file-cancelled`, `inbound:file-skipped` — transfer-control.
- `inbound:pause-file`, `inbound:resume-file`, `inbound:cancel-file`,
  `inbound:cancel-all` — transfer-control (either direction).
- `inbound:nickname-change` — participant-table update.
- `inbound:closing`, `inbound:room-closed`, `inbound:kicked` —
  terminal, transitions to closed/kicked.
- `inbound:off-union` — the protocol guard rejected the `type`.
  Transitions to `error` and closes the conn.

Outbound (from hook):
- `outbound:send-public-key`
- `outbound:send-password`
- `outbound:request-file` / `outbound:request-all`
- `outbound:send-chunk` (binary — bypasses the session's JSON lane,
  but the session tracks the queued promise so pause/cancel has a
  handle).
- `outbound:pause-file` / `outbound:resume-file` / `outbound:cancel-file`
- `outbound:send-chat`, `outbound:send-image`
- `outbound:send-typing`, `outbound:send-reaction`
- `outbound:send-nickname-change`

Lifecycle:
- `connect-start` — hook asked peer.connect(). Enter `connecting`.
- `conn-open` — DataConnection emitted 'open'. Enter `key-exchange`.
- `peer-disconnect` — peerJS `close` or `error`. Enter `closed`.
- `heartbeat-dead` — heartbeat watcher declared the peer dead after
  N consecutive ping failures. Enter `closed`.
- `session-abort` — hook is unmounting / user left the room. Terminal.
- `reconnect-intent` — user-initiated or auto-reconnect. Spawns a new
  session (doesn't mutate the existing one — see reconnect section).

---

## Transition table

Only the transitions that change `state`. Pure side-effects on other
fields (e.g. `inbound:ping` resetting `lastAlive`) are implicit.

| From | Event | To | Notes |
|------|-------|----|------|
| `idle` | `connect-start` | `connecting` | — |
| `connecting` | `conn-open` | `key-exchange` | Start keypair generate + send public-key. Arm 10s keyExchangeTimeout. |
| `connecting` | `peer-disconnect` | `closed` | Peer never came up. |
| `key-exchange` | `inbound:public-key` | `authenticated` or `password-gate` | Derive via finalizeKeyExchange (P1.A). If `passwordRequired`, → password-gate; else → authenticated and send manifest/participant-list. |
| `key-exchange` | `keyExchangeTimeout` | `error` | 10s elapsed without remote key. |
| `password-gate` | `inbound:password-encrypted` (host) | `authenticated` on match; stays on mismatch (with attempt-count incremented); → `closed` on lockout | See P0 fix #7 for attempt caps. |
| `password-gate` | `inbound:password-accepted` (guest) | `authenticated` | — |
| `password-gate` | `inbound:password-locked` (guest) | `error` | — |
| `authenticated` | `outbound:request-file` / `inbound:request-file` | `transferring` | Side-effect: spawn a chunk sender task. Multiple concurrent requests stack on `activeTransfers`. |
| `transferring` | last transfer ends | `authenticated` | Triggered when `activeTransfers` empties. |
| `transferring` | `inbound:cancel-all` / `outbound:cancel-all` | `authenticated` | Aborts all active transfers, clears queues. |
| {any live} | `peer-disconnect` | `closed` | — |
| {any live} | `heartbeat-dead` | `closed` | — |
| {any live} | `session-abort` | `closed` | Local tear-down. |
| {any live} | `inbound:kicked` | `kicked` | Collab host kicked the guest. |
| {any live} | `inbound:off-union` | `error` | Protocol guard caught a bad `type`. |
| `closed` / `error` / `kicked` | any | — | Terminal; outbound throws, inbound logged and dropped. |

---

## Per-session vs per-hook

Per-session (moves into `Session`):
- `conn: DataConnection`
- `state`, `encryptKey`, `keyPair`, `pendingRemoteKey`,
  `keyExchangeTimeout`, `fingerprint`
- `heartbeat`, `rttPoller`, `disconnectHandled`
- `chunkQueue` (inbound dispatch serialization)
- `imageSendQueue` (outbound chat-image serialization)
- `uploadQueue` (outbound file serialization — currently only on host /
  guest; sender will gain it via P1.D's transferEngine)
- `activeTransfers: Map<transferId, TransferHandle>` — replaces
  `pauseResolvers`, `cancelledFiles`, `pausedFiles` (portal) and
  `activeTransfers` / `inProgressFiles` (collab)
- `inProgressImage` (inbound chat image assembly)
- `passwordVerified`, `passwordAttempts`, `passwordRequired`
- `nickname`, `peerId`
- `requestedFileIds` (collab host only — M12 defense-in-depth gate)
- `recentFileShares` (collab host only — M19 rate limit window)

Stays per-hook (does not move into Session):
- `connectionsRef: Map<peerId, Session>` — the hook owns the map; the
  session doesn't know about its siblings.
- Participant dispatch (`dispatchParticipants`) — reducer is hook-
  owned; session emits events that the hook consumes to update it.
- `filesRef`, `myFilesRef`, `filesState` — file catalog is room-wide,
  not per-peer.
- `messages` — chat history is room-wide.
- Global password attempt counter — lifts to the hook (the session
  tracks per-conn attempts, the hook tracks the global cap).
- `peerRef: Peer` — the PeerJS instance is hook-level.
- UI dispatch (`dispatchTransfer`, `dispatchFiles`, `dispatchRoom`) —
  the session emits typed `SessionEvent`s, the hook's reducer bridge
  translates them into UI actions.

The session is a headless state machine. It does not know React.
This is deliberate — makes it unit-testable without a DOM and lets
the transferEngine (P1.D) consume sessions without importing React.

---

## Reconnect tokens

Reconnect semantics differ by hook and this is the trickiest part of
the extraction. Today:

- **useSender** has no reconnect concept at the session level — a
  receiver that drops is simply removed from the map; when it
  reconnects, it arrives as a new PeerJS connection and gets a fresh
  `ConnState`. No token.
- **useReceiver** has a single session and a `reconnectTokenRef:
  Symbol` (receiver.ts:97). On every reconnect the symbol rotates;
  async handlers capture the token at entry and compare at resume to
  detect "the session I belonged to is gone." P0 fix #6 bumped this
  synchronously on `enableRelay` so in-flight handlers notice the
  relay switch.
- **useCollabGuest** mesh connections have no explicit token — the
  mesh re-negotiates ECDH from scratch on every open, so there's no
  stale state to invalidate.
- **useCollabHost** treats guest reconnects as brand-new connections.

**Session model:** each `Session` carries a `generation: number`
(simpler than Symbol — testable, serializable, and already how the
receiver's `attemptRef` works). On any reconnect the hook spawns a
new Session with `generation = prev.generation + 1` and tears down
the old one; async work captured under the old generation compares
`if (session.generation !== captured) return` before resuming.

Sessions never mutate back to a non-terminal state. A "reconnected"
peer gets a fresh session object; the old one stays in `closed`
forever. This means no state transition out of a terminal state ever
exists, which makes the state machine easier to reason about.

For the receiver specifically: `session.streams` (the per-file write
streams) is per-session and dies with the session. Resume-from-chunk
is a hook-level concern: the hook persists the last-written chunk
offset in its own ref (same `lastChunkIndexRef` pattern as today) and
feeds it to the new session's initial `request-file` as `resumeChunk`.

---

## Proposed API

```ts
// src/net/session.ts

export type SessionState =
  | 'idle' | 'connecting' | 'key-exchange' | 'password-gate'
  | 'authenticated' | 'transferring' | 'closed' | 'error' | 'kicked'

export type SessionRole = 'portal-sender' | 'portal-receiver'
                        | 'collab-host' | 'collab-guest-host'
                        | 'collab-guest-mesh'

export interface Session {
  readonly id: string                // uuid, stable for the session's life
  readonly generation: number
  readonly role: SessionRole
  readonly peerId: string            // peer identifier (DataConnection.peer)
  readonly conn: DataConnection

  // Observable state. Reads are safe; writes go through dispatch.
  readonly state: SessionState
  readonly encryptKey: CryptoKey | null
  readonly fingerprint: string | null
  readonly nickname: string | null
  readonly passwordVerified: boolean

  // Event bus — the hook subscribes and translates events into UI
  // reducer actions. Listeners are sync.
  on<E extends SessionEvent>(ev: E['type'], fn: (e: E) => void): () => void

  // Typed send: `satisfies PortalMsg | CollabUnencryptedMsg | CallMsg`
  // at the call site, checked by the session's role.
  send(msg: RoleMsg<this>): void

  // Transfer-control shortcuts — these wrap `send` + `activeTransfers`
  // bookkeeping so callers don't have to duplicate the mutation.
  beginTransfer(handle: TransferHandle): void
  endTransfer(transferId: string): void
  pauseTransfer(transferId: string): void
  resumeTransfer(transferId: string): void
  cancelTransfer(transferId: string): void

  // Terminal — idempotent.
  close(reason: CloseReason): void
}

export type SessionEvent =
  | { type: 'state-change'; from: SessionState; to: SessionState }
  | { type: 'fingerprint'; value: string }
  | { type: 'nickname'; value: string }
  | { type: 'chat'; msg: ChatMessage }
  | { type: 'transfer-progress'; transferId: string; progress: number; speed: number }
  | { type: 'transfer-end'; transferId: string; reason: 'complete' | 'cancelled' | 'error' }
  | { type: 'closed'; reason: CloseReason }
  | { type: 'error'; err: Error }
  // …
```

Factory:

```ts
export function createSession(opts: {
  conn: DataConnection
  role: SessionRole
  generation: number
  passwordRequired: boolean
  // pure translators: given an inbound `PortalMsg | CollabUnencryptedMsg`,
  // return the SessionEvent(s) to emit. Keeps role-specific dispatch
  // logic out of the session core.
  onInbound: (session: Session, msg: RoleMsg<SessionRole>) => void
}): Session
```

---

## Migration strategy

Land in order. Each step is its own commit, bisectable.

1. **Write `src/net/session.ts` alongside the existing hooks.** No
   consumers yet. Ship with tests (see below).
2. **Move one role at a time:**
   - Portal receiver first — single session, smallest surface, most
     test coverage via `transfer.test.ts`.
   - Portal sender — multi-session but the map owner stays on the hook.
   - Collab host guests.
   - Collab guest host-conn.
   - Collab guest mesh.
3. **Consolidate duplicated helpers.** After all five are on `Session`,
   delete `ConnState`, `GuestConnection`, `PeerConnection`, and the
   individual receiver refs that moved into the session.

Migration is **not** "land behind a feature flag" — the session API is
an internal refactor, not a runtime toggle. Each step gets its own
staging bake with a real two-person mesh session before moving on.

### Tests to write before migration

Without these, the extraction is guesswork:

- `session.test.ts` — unit. Drive a session through every valid
  transition using a mocked DataConnection. Assert:
  - `state` progresses as the transition table says.
  - Outbound `send` from terminal states throws.
  - `keyExchangeTimeout` arms on `conn-open` and disarms on
    `inbound:public-key`.
  - Heartbeat only starts after `key-exchange`.
  - `close()` is idempotent.
  - `generation` bumps on reconnect-intent; async work captured under
    the old generation gets dropped.
- `session-protocol.test.ts` — integration. Two sessions with in-memory
  DataConnection stubs. Full portal handshake (public-key round trip +
  manifest + one-file transfer + close). Smoke test the collab
  envelope path.
- Extend `keyExchange.test.ts` to assert the session wrapper arrives
  at the same `encryptKey` / `fingerprint` as direct `finalizeKeyExchange`.

---

## Gotchas

- **Binary chunk packets bypass `session.send`.** Chunks go through
  `buildChunkPacket` / `parseChunkPacket` today and will continue to
  bypass the typed send. The session exposes `session.sendBinary(ab)`
  (thin wrapper for the queue + drain logic) and `session.onBinary(fn)`
  as two separate lanes. Do not try to unify JSON and binary at the
  session layer — `DataConnection.send` already handles the switch.
- **Collab guest mesh is conceptually different.** The mesh sessions
  don't ever enter `password-gate` (password is enforced at the host-
  conn session, not the mesh). Encode this as a Role-level invariant:
  `role === 'collab-guest-mesh'` ⇒ no password-gate transition is legal.
- **useSender has no password-gate for the first connection.** The
  sender sets the password; guests authenticate. Role
  `'portal-sender'` sessions skip password-gate and go straight to
  authenticated. `'portal-receiver'` sessions can enter it.
- **`callMessageHandler` is orthogonal to the session.** The call
  lane rides on top of the same DataConnection but doesn't mutate
  session state. The session's inbound dispatch checks
  `msg.type.startsWith('call-')` and routes to the handler; it does
  not participate in the state machine. Keep it that way — don't
  force CallMsg into Session transitions.
- **P0 fix #3 (origin check for forwarded control messages) stays in
  the hook.** The session doesn't know who requested what in a room
  context; the owner-check lives on the guest hook and the
  amplification check (M12) lives on the host hook. The session just
  carries the `requestedFileIds` set; both hooks read it.
- **Heartbeat cleanup.** Every session must clean up its heartbeat /
  rttPoller / keyExchangeTimeout on `close()`. Audit trace: M15
  showed what happens when an await resolves against a torn-down
  ref. Add a test that forces `close()` while a chunk-queue await is
  in flight.

---

## Open questions (answer before coding)

1. **Does `Session` own `callMessageHandler`, or does it stay on the
   hook?** Current proposal: stays on the hook, routed from the
   session's inbound dispatch. But it might be cleaner to give the
   session a `callMessageHandler` slot mirroring the current
   `callMessageHandlerRef` pattern. Decide before step 2.
2. **Event emission: callbacks vs EventTarget vs tiny bus?** The API
   sketch uses `on(type, fn)` — a tiny handwritten bus. Alternatives:
   native `EventTarget` (verbose, poor TS narrowing), `mitt` (pulls a
   dep, violates zero-third-party). Recommend: tiny bus, keep it in
   `session.ts`.
3. **Should the session own `connectionsRef` for multi-peer roles
   (sender, collab-host)?** No — the map is room-wide, belongs on the
   hook. But some operations (broadcast, sendToPeer) want access to
   siblings. Exposing a `Room` container above sessions is a P1.D/E
   concern, not P1.C.
4. **Role-specific fields: where do `requestedFileIds` and
   `recentFileShares` live?** Today these only exist on
   `GuestConnection`. Two options: (a) put them on every session
   regardless of role, defaulted to empty; (b) split into
   `CollabHostSession extends Session` with the extras. Prefer (a) —
   keeps Session monomorphic, costs two empty Maps per session, beats
   a discriminated-union session type that callers have to narrow.

---

## Out of scope for P1.C

- `src/net/transferEngine.ts` (P1.D) — consumes `Session` but is its
  own extraction. Do not attempt both at once.
- Replacing PeerJS. The session wraps `DataConnection` intentionally;
  a future P3 transport swap would change the session's constructor
  argument, not its state machine.
- Moving ChatPanel / CallPanel state into the session. UI state is
  not session state.
- Any behaviour change. P1.C is a pure refactor; no logic moves
  between hooks, no wire bytes change.

---

## Acceptance

P1.C is done when:
- All five call-sites use `Session`.
- `ConnState`, `GuestConnection`, `PeerConnection` are deleted.
- 271 existing tests still pass.
- The new session tests cover every transition in the table above.
- A real two-peer staging run (portal 1:1, portal 1:N, collab host
  + 2 guests with a mesh, voice call) reproduces no regressions.
- Every hook's line count has dropped — session extraction shouldn't
  add net lines; if it does, something leaked that shouldn't have.
