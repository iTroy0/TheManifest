// Per-peer state machine for every live DataConnection in the app.
// Collapses four parallel models (`ConnState` in useSender,
// `GuestConnection` in useCollabHost, `PeerConnection` in
// useCollabGuest mesh, and the ad-hoc refs in useReceiver) into a
// single typed object with a documented transition table.
//
// The session is a headless state machine — it does not know React.
// Hooks own the `Peer` instance, the connection map, participant
// reducers, and UI dispatch. Sessions just model "the per-peer
// bytes in flight and how they are authenticated."
//
// P1.C contract: writes go through `dispatch` / `close` / the
// `set*` helpers so that terminal transitions are always
// accompanied by the matching cleanup (heartbeat stop, key-exchange
// timer clear, transfer aborts). External code reads `session.state`
// etc. directly but must not mutate those fields.

import type { DataConnection } from 'peerjs'
import type { setupHeartbeat, setupRTTPolling } from '../utils/connectionHelpers'

// ── Enums ────────────────────────────────────────────────────────────────

export type SessionState =
  | 'idle'
  | 'connecting'
  | 'key-exchange'
  | 'password-gate'
  | 'authenticated'
  | 'transferring'
  | 'closed'
  | 'error'
  | 'kicked'

export type SessionRole =
  | 'portal-sender'
  | 'portal-receiver'
  | 'collab-host'
  | 'collab-guest-host'
  | 'collab-guest-mesh'

export type CloseReason =
  | 'peer-disconnect'
  | 'heartbeat-dead'
  | 'session-abort'
  | 'kicked'
  | 'error'
  | 'protocol-off-union'
  | 'key-exchange-timeout'
  | 'password-locked'
  | 'complete'

// ── Bookkeeping ──────────────────────────────────────────────────────────

// A single in-flight transfer on this session. Covers both outbound
// (sender → peer) and inbound (peer → sender) because `activeTransfers`
// replaces the four hook-level variants of "files I'm moving on this
// peer" that were drifting before P1.C.
export interface TransferHandle {
  transferId: string
  direction: 'outbound' | 'inbound'
  aborted: boolean
  paused: boolean
  // Populated by the sender loop when it enters a pause wait; the
  // session helpers (resume/cancel) invoke it to unblock.
  pauseResolver?: () => void
}

// Shape shared by chat-image receivers across portal + collab. Typed
// as a superset; fields absent in one lane stay undefined.
export interface InProgressImageSlot {
  id?: string
  mime: string
  size: number
  text: string
  replyTo: { text: string; from: string; time: number } | null
  time: number
  from: string
  duration?: number
  chunks: Uint8Array[]
  receivedBytes: number
}

// ── Events ───────────────────────────────────────────────────────────────

// Non-terminal transitions + bookkeeping. Terminal transitions go
// through `session.close(reason)` — this keeps the dispatch surface
// bounded and guarantees close-time cleanup runs on every terminal
// path.
export type SessionInput =
  | { type: 'connect-start' }
  | { type: 'conn-open' }
  | {
      type: 'keys-derived'
      encryptKey: CryptoKey
      fingerprint: string
      requiresPassword?: boolean
    }
  | { type: 'password-accepted' }
  | { type: 'transfer-start' }
  | { type: 'transfer-end' }
  | { type: 'cancel-all' }

// Emitted to subscribers. Hook-side reducers translate these into
// UI dispatch actions.
export type SessionEvent =
  | { type: 'state-change'; from: SessionState; to: SessionState }
  | { type: 'fingerprint'; value: string }
  | { type: 'nickname'; value: string }
  | { type: 'transfer-begin'; transferId: string }
  | {
      type: 'transfer-end'
      transferId: string
      reason: 'complete' | 'cancelled' | 'error'
    }
  | { type: 'closed'; reason: CloseReason }

// ── Session interface ────────────────────────────────────────────────────

export interface Session {
  // Identity. Stable for the session's life.
  readonly id: string
  readonly generation: number
  readonly role: SessionRole
  readonly peerId: string
  readonly conn: DataConnection

  // State — mutated via dispatch/close/set*.
  state: SessionState
  encryptKey: CryptoKey | null
  keyPair: CryptoKeyPair | null
  fingerprint: string | null
  nickname: string | null
  passwordRequired: boolean
  passwordVerified: boolean
  passwordAttempts: number

  // Handshake scratch — cleared on terminal.
  pendingRemoteKey: Uint8Array | null
  keyExchangeTimeout: ReturnType<typeof setTimeout> | null

  // Liveness — cleared on terminal.
  heartbeat: ReturnType<typeof setupHeartbeat> | null
  rttPoller: ReturnType<typeof setupRTTPolling> | null
  disconnectHandled: boolean

  // Serialization lanes.
  chunkQueue: Promise<void>
  imageSendQueue: Promise<void>
  uploadQueue: Promise<void>

  // Bookkeeping.
  activeTransfers: Map<string, TransferHandle>
  requestedFileIds: Set<string>
  recentFileShares: number[]
  inProgressImage: InProgressImageSlot | null

  // Event bus.
  on<T extends SessionEvent['type']>(
    type: T,
    fn: (ev: Extract<SessionEvent, { type: T }>) => void,
  ): () => void

  // State machine. Terminal-state dispatches are dropped silently
  // (matches the "inbound logged and dropped" rule from the plan).
  dispatch(input: SessionInput): void

  // Outbound. Throws from terminal state — callers must check first
  // (or catch and route to close()).
  send(msg: Record<string, unknown>): void
  sendBinary(bytes: ArrayBuffer | ArrayBufferView): void

  // Transfer helpers. Session-side bookkeeping only — the actual
  // chunk streaming sits on `transferEngine` (P1.D) later.
  beginTransfer(handle: TransferHandle): void
  endTransfer(
    transferId: string,
    reason: 'complete' | 'cancelled' | 'error',
  ): void
  pauseTransfer(transferId: string): void
  resumeTransfer(transferId: string): void
  cancelTransfer(transferId: string): void
  cancelAllTransfers(): void

  // Field mutators that also emit events.
  setKeyPair(pair: CryptoKeyPair): void
  setNickname(name: string): void
  setPasswordVerified(): void
  incrementPasswordAttempts(): number

  // Terminal. Idempotent.
  close(reason: CloseReason): void
}

// ── Factory opts ─────────────────────────────────────────────────────────

export interface CreateSessionOpts {
  conn: DataConnection
  role: SessionRole
  peerId?: string
  generation?: number
  passwordRequired?: boolean
  id?: string
}

// ── Transition table ─────────────────────────────────────────────────────

function isTerminal(s: SessionState): boolean {
  return s === 'closed' || s === 'error' || s === 'kicked'
}

function terminalForReason(reason: CloseReason): SessionState {
  switch (reason) {
    case 'kicked':
      return 'kicked'
    case 'error':
    case 'protocol-off-union':
    case 'key-exchange-timeout':
    case 'password-locked':
      return 'error'
    case 'peer-disconnect':
    case 'heartbeat-dead':
    case 'session-abort':
    case 'complete':
      return 'closed'
  }
}

// Given the current state + an input + role, return the next state.
// Pure — the session wrapper mutates fields around this call.
function nextState(
  from: SessionState,
  input: SessionInput,
  role: SessionRole,
  remainingActiveTransfers: number,
): SessionState {
  if (isTerminal(from)) return from

  switch (input.type) {
    case 'connect-start':
      return from === 'idle' ? 'connecting' : from

    case 'conn-open':
      return from === 'connecting' ? 'key-exchange' : from

    case 'keys-derived': {
      if (from !== 'key-exchange') return from
      // Only `portal-receiver` + `collab-guest-host` can be password-gated:
      // the gate sits on the receiving/joining side. Senders, hosts, and
      // mesh peers skip the gate regardless of the `requiresPassword`
      // flag (the mesh is authenticated at the host-conn layer, not per
      // mesh peer).
      const canGate =
        role === 'portal-receiver' || role === 'collab-guest-host'
      return canGate && input.requiresPassword ? 'password-gate' : 'authenticated'
    }

    case 'password-accepted':
      return from === 'password-gate' ? 'authenticated' : from

    case 'transfer-start':
      return from === 'authenticated' || from === 'transferring'
        ? 'transferring'
        : from

    case 'transfer-end':
      // Only flip back to authenticated once every active transfer has
      // ended. Multiple concurrent transfers stack until the map drains.
      return from === 'transferring' && remainingActiveTransfers === 0
        ? 'authenticated'
        : from

    case 'cancel-all':
      return from === 'transferring' ? 'authenticated' : from
  }
}

// ── Factory ──────────────────────────────────────────────────────────────

function makeSessionId(): string {
  const g = globalThis as unknown as { crypto?: Crypto }
  if (g.crypto && typeof g.crypto.randomUUID === 'function') {
    return g.crypto.randomUUID()
  }
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

type ListenerBag = Map<SessionEvent['type'], Set<(ev: SessionEvent) => void>>

export function createSession(opts: CreateSessionOpts): Session {
  const listeners: ListenerBag = new Map()

  function emit(ev: SessionEvent): void {
    const set = listeners.get(ev.type)
    if (!set) return
    for (const fn of set) {
      // A listener throw must not corrupt session state. Swallow and
      // continue; hooks can add their own logging inside the listener
      // if they care.
      try {
        fn(ev)
      } catch {
        /* noop */
      }
    }
  }

  function cleanup(): void {
    if (session.keyExchangeTimeout) {
      clearTimeout(session.keyExchangeTimeout)
      session.keyExchangeTimeout = null
    }
    const hb = session.heartbeat as { stop?: () => void } | null
    if (hb && typeof hb.stop === 'function') {
      try {
        hb.stop()
      } catch {
        /* noop */
      }
    }
    session.heartbeat = null
    const rtt = session.rttPoller as { stop?: () => void } | null
    if (rtt && typeof rtt.stop === 'function') {
      try {
        rtt.stop()
      } catch {
        /* noop */
      }
    }
    session.rttPoller = null
    for (const handle of session.activeTransfers.values()) {
      handle.aborted = true
      const r = handle.pauseResolver
      if (r) {
        handle.pauseResolver = undefined
        try {
          r()
        } catch {
          /* noop */
        }
      }
    }
    session.pendingRemoteKey = null
    session.disconnectHandled = true
  }

  const session: Session = {
    id: opts.id ?? makeSessionId(),
    generation: opts.generation ?? 0,
    role: opts.role,
    peerId: opts.peerId ?? opts.conn.peer,
    conn: opts.conn,

    state: 'idle',
    encryptKey: null,
    keyPair: null,
    fingerprint: null,
    nickname: null,
    passwordRequired: opts.passwordRequired ?? false,
    passwordVerified: false,
    passwordAttempts: 0,

    pendingRemoteKey: null,
    keyExchangeTimeout: null,

    heartbeat: null,
    rttPoller: null,
    disconnectHandled: false,

    chunkQueue: Promise.resolve(),
    imageSendQueue: Promise.resolve(),
    uploadQueue: Promise.resolve(),

    activeTransfers: new Map(),
    requestedFileIds: new Set(),
    recentFileShares: [],
    inProgressImage: null,

    on(type, fn) {
      let set = listeners.get(type)
      if (!set) {
        set = new Set()
        listeners.set(type, set)
      }
      set.add(fn as (ev: SessionEvent) => void)
      return () => {
        set?.delete(fn as (ev: SessionEvent) => void)
      }
    },

    dispatch(input) {
      const from = session.state
      if (isTerminal(from)) return

      // Special-case: `keys-derived` carries the derived artefacts so
      // the state flip and the encryptKey/fingerprint assignment happen
      // atomically. Keeps the invariant `state ∈ post-key-exchange ⇒
      // encryptKey !== null` true by construction. Also disarms the
      // handshake watchdog — once a key lands, the timer's job is done.
      if (input.type === 'keys-derived') {
        session.encryptKey = input.encryptKey
        session.fingerprint = input.fingerprint
        if (session.keyExchangeTimeout) {
          clearTimeout(session.keyExchangeTimeout)
          session.keyExchangeTimeout = null
        }
        emit({ type: 'fingerprint', value: input.fingerprint })
      }

      const remaining =
        input.type === 'transfer-end'
          ? session.activeTransfers.size
          : input.type === 'cancel-all'
            ? 0
            : session.activeTransfers.size

      const to = nextState(from, input, session.role, remaining)
      if (to !== from) {
        session.state = to
        emit({ type: 'state-change', from, to })
      }
    },

    send(msg) {
      if (isTerminal(session.state)) {
        throw new Error(
          `Session.send: cannot send from terminal state '${session.state}'`,
        )
      }
      session.conn.send(msg)
    },

    sendBinary(bytes) {
      if (isTerminal(session.state)) {
        throw new Error(
          `Session.sendBinary: cannot send from terminal state '${session.state}'`,
        )
      }
      session.conn.send(bytes)
    },

    beginTransfer(handle) {
      session.activeTransfers.set(handle.transferId, handle)
      session.dispatch({ type: 'transfer-start' })
      emit({ type: 'transfer-begin', transferId: handle.transferId })
    },

    endTransfer(transferId, reason) {
      const handle = session.activeTransfers.get(transferId)
      if (!handle) return
      session.activeTransfers.delete(transferId)
      session.dispatch({ type: 'transfer-end' })
      emit({ type: 'transfer-end', transferId, reason })
    },

    pauseTransfer(transferId) {
      const handle = session.activeTransfers.get(transferId)
      if (handle) handle.paused = true
    },

    resumeTransfer(transferId) {
      const handle = session.activeTransfers.get(transferId)
      if (!handle) return
      handle.paused = false
      const r = handle.pauseResolver
      if (r) {
        handle.pauseResolver = undefined
        r()
      }
    },

    cancelTransfer(transferId) {
      const handle = session.activeTransfers.get(transferId)
      if (!handle) return
      handle.aborted = true
      const r = handle.pauseResolver
      if (r) {
        handle.pauseResolver = undefined
        r()
      }
    },

    cancelAllTransfers() {
      for (const h of session.activeTransfers.values()) {
        h.aborted = true
        const r = h.pauseResolver
        if (r) {
          h.pauseResolver = undefined
          r()
        }
      }
      session.activeTransfers.clear()
      session.dispatch({ type: 'cancel-all' })
    },

    setKeyPair(pair) {
      session.keyPair = pair
    },

    setNickname(name) {
      session.nickname = name
      emit({ type: 'nickname', value: name })
    },

    setPasswordVerified() {
      session.passwordVerified = true
    },

    incrementPasswordAttempts() {
      session.passwordAttempts += 1
      return session.passwordAttempts
    },

    close(reason) {
      if (isTerminal(session.state)) return
      const from = session.state
      const to = terminalForReason(reason)
      session.state = to
      cleanup()
      emit({ type: 'state-change', from, to })
      emit({ type: 'closed', reason })
    },
  }

  return session
}
