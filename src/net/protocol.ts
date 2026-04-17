// Typed wire-message unions for every hook. Inlining object literals
// across useSender/useReceiver/useCollabHost/useCollabGuest/useCall has
// let rename drift in — a new field in one place silently didn't reach
// its peer. This module is the single source of truth.
//
// Organization mirrors the lanes:
//   - Portal    : useSender ↔ useReceiver (1:N file share)
//   - Collab    : useCollabHost ↔ useCollabGuest (room + mesh)
//   - Call      : useCall (overlay on either lane)
//
// Binary chunk packets (6-byte header + ciphertext) stay on the existing
// `buildChunkPacket` / `parseChunkPacket` path — they are NOT JSON and
// deliberately not typed here. See `src/utils/fileChunker.ts`.
//
// Shared keys used by multiple lanes are defined once at the top.

import { encryptJSON, decryptJSON } from '../utils/crypto'

// ── Shared primitives ────────────────────────────────────────────────────

export interface PingMsg { type: 'ping'; ts: number }
export interface PongMsg { type: 'pong'; ts: number }
// Raw public-key bytes for ECDH. Serialized as a plain number[] so JSON
// round-trips survive (Uint8Array is not directly JSON-representable).
export interface PublicKeyMsg { type: 'public-key'; key: number[] }

// Online-count and system-msg exist on both portal and collab wires, with
// identical shape. Defined once here; each lane union re-exports them.
export interface OnlineCountMsg { type: 'online-count'; count: number }
export interface SystemMsgMsg { type: 'system-msg'; text: string; time: number }

// Chat image streaming (both portal and collab use the same shapes).
// The binary chunks between start and end flow through the chunk packet
// pipeline, keyed by the 0xFFFF sentinel fileIndex (see CHAT_IMAGE_FILE_INDEX
// in fileChunker.ts). Only the start/end/abort control messages are JSON.
export interface ChatImageStartEncMsg {
  type: 'chat-image-start-enc'
  data: string
  from?: string
  time?: number
}
export interface ChatImageEndEncMsg {
  type: 'chat-image-end-enc'
  data?: string
}
// Emitted by the streamer on mid-stream failure so the receiver clears its
// in-progress image slot instead of sitting on accumulated partial bytes
// until the next start arrives.
export interface ChatImageAbortMsg { type: 'chat-image-abort' }

// ── Portal (useSender ↔ useReceiver) ─────────────────────────────────────
// Unencrypted manifest (legacy — still sent only for the error branch).
// The canonical path is `manifest-enc`, produced after the ECDH handshake.
export interface ManifestEncMsg { type: 'manifest-enc'; data: string }
// Password flow — gates manifest delivery.
export interface PasswordRequiredMsg { type: 'password-required' }
export interface PasswordEncryptedMsg { type: 'password-encrypted'; data: string }
export interface PasswordAcceptedMsg { type: 'password-accepted' }
export interface PasswordWrongMsg { type: 'password-wrong' }
export interface PasswordLockedMsg { type: 'password-locked' }
export interface PasswordRateLimitedMsg { type: 'password-rate-limited' }
// Receiver tells sender which file(s) it wants.
export interface ReadyMsg { type: 'ready' }
export interface RequestFileMsg { type: 'request-file'; index: number; resumeChunk?: number }
export interface RequestAllMsg { type: 'request-all'; indices?: number[] }
export interface ResumeMsg { type: 'resume'; fileIndex: number; chunkIndex: number }
// Per-file control (either direction, same shape).
export interface PauseFileMsg { type: 'pause-file'; index: number }
export interface ResumeFileMsg { type: 'resume-file'; index: number }
export interface CancelFileMsg { type: 'cancel-file'; index: number }
export interface CancelAllMsg { type: 'cancel-all' }
// End-of-transfer / per-file status.
export interface FileSkippedMsg { type: 'file-skipped'; index: number; reason: string }
export interface FileCancelledMsg { type: 'file-cancelled'; index: number }
export interface BatchDoneMsg { type: 'batch-done' }
export interface DoneMsg { type: 'done' }
export interface CancelAllAckMsg { type: 'cancel-all-ack' }
export interface RejectedMsg { type: 'rejected'; reason?: string }
export interface ClosingMsg { type: 'closing' }
// Participant metadata (portal also has chat).
export interface JoinMsg { type: 'join'; nickname: string }
export interface TypingMsg { type: 'typing'; nickname: string }
export interface ReactionMsg {
  type: 'reaction'
  msgId: string
  emoji: string
  nickname: string
}
// Chat body (encrypted per peer). `from` / `time` are present on relay
// frames so each recipient can attribute the message correctly.
export interface ChatEncryptedMsg {
  type: 'chat-encrypted'
  data: string
  from?: string
  time?: number
  nickname?: string
}
export interface RelayChatEncryptedMsg { type: 'relay-chat-encrypted'; data: string }

export type PortalMsg =
  | PingMsg | PongMsg | PublicKeyMsg
  | OnlineCountMsg | SystemMsgMsg
  | ManifestEncMsg
  | PasswordRequiredMsg | PasswordEncryptedMsg | PasswordAcceptedMsg
  | PasswordWrongMsg | PasswordLockedMsg | PasswordRateLimitedMsg
  | ReadyMsg | ResumeMsg
  | RequestFileMsg | RequestAllMsg
  | PauseFileMsg | ResumeFileMsg | CancelFileMsg | CancelAllMsg
  | FileSkippedMsg | FileCancelledMsg | BatchDoneMsg | DoneMsg
  | CancelAllAckMsg | RejectedMsg | ClosingMsg
  | JoinMsg | TypingMsg | ReactionMsg
  | ChatEncryptedMsg | RelayChatEncryptedMsg
  | ChatImageStartEncMsg | ChatImageEndEncMsg | ChatImageAbortMsg

// ── Collab envelope + inner ──────────────────────────────────────────────
// Two-layer protocol: outer `collab-msg-enc` carries base64 ciphertext of
// an inner JSON message. Don't collapse these types — the host
// intentionally can't read some collab-* inner payloads (peer-to-peer
// mesh chat is end-to-end between guests).
export interface CollabEnvelope { type: 'collab-msg-enc'; data: string }

// Inner payloads (encrypted body of CollabEnvelope). Typed as `unknown` for
// `SharedFile` / participant-snapshot shapes to avoid a circular import
// through `state/collabState.ts`; the sanitizer in that file is the
// runtime validator.
export type CollabInnerMsg =
  | { type: 'collab-request-file'; fileId: string; owner?: string; requesterPeerId?: string }
  | { type: 'collab-file-start'; fileId: string; name: string; size: number; totalChunks: number }
  | { type: 'collab-file-end'; fileId: string }
  | { type: 'collab-file-shared'; file: unknown; from?: string }
  | { type: 'collab-file-removed'; fileId: string; from?: string }
  | { type: 'collab-file-list'; files: unknown[] }
  | { type: 'collab-pause-file'; fileId: string; requesterPeerId?: string }
  | { type: 'collab-resume-file'; fileId: string; requesterPeerId?: string }
  | { type: 'collab-cancel-file'; fileId: string; requesterPeerId?: string }
  | { type: 'collab-cancel-all' }
  | { type: 'collab-file-unavailable'; fileId: string; reason?: string; requesterPeerId?: string }
  | { type: 'collab-participant-list'; participants: Array<{ peerId: string; name: string }> }

// Participant-management messages that ride the same DataConnection but
// are NOT encrypted. Trust is established via host-owned peerId; the host
// rewrites `peerId` to the authenticated connection source before
// broadcasting rename/join/leave events (see useCollabHost L6 comment).
export type CollabUnencryptedMsg =
  | CollabEnvelope
  | PingMsg | PongMsg | PublicKeyMsg
  | OnlineCountMsg | SystemMsgMsg
  | ChatEncryptedMsg | RelayChatEncryptedMsg
  | ChatImageStartEncMsg | ChatImageEndEncMsg | ChatImageAbortMsg
  | { type: 'collab-signal'; target: string; signal: unknown }
  | { type: 'collab-peer-joined'; peerId: string; name: string }
  | { type: 'collab-peer-left'; peerId: string; name?: string }
  | { type: 'collab-peer-renamed'; peerId: string; oldName: string; newName: string }
  | { type: 'collab-participant-list'; participants: Array<{ peerId: string; name: string }> }
  | { type: 'room-closed' }
  | { type: 'kicked' }
  | { type: 'nickname-change'; newName: string }
  | { type: 'password-required' }
  | { type: 'password-encrypted'; data: string }
  | { type: 'password-accepted' }
  | { type: 'password-wrong' }
  | { type: 'password-locked' }
  | { type: 'password-rate-limited' }

// ── Call lane ────────────────────────────────────────────────────────────
// Signaling overlay on top of either lane's DataConnection. Every call
// message carries `from` so the receiver can route without trusting the
// transport's peerId (useful across host-relayed guest↔guest).
export type CallMode = 'audio' | 'video'

export type CallMsg =
  | { type: 'call-join'; mode: CallMode; name: string; from: string }
  | { type: 'call-leave'; from: string }
  | {
      type: 'call-peer-joined'
      peerId: string
      name: string
      mode: CallMode
      from: string
    }
  | { type: 'call-peer-left'; peerId: string; from: string }
  | {
      type: 'call-roster'
      peers: Array<{ peerId: string; name: string; mode: CallMode }>
      from: string
    }
  | {
      type: 'call-track-state'
      peerId: string
      micMuted: boolean
      cameraOff: boolean
      mode: CallMode
      from: string
    }

// ── Encryption helpers ───────────────────────────────────────────────────
// Thin wrappers around `encryptJSON` / `decryptJSON`. The win is that the
// caller states which message shape is expected; the compiler then
// narrows the return type downstream. Runtime behaviour is identical.
export async function encodeEnc<T>(key: CryptoKey, msg: T): Promise<string> {
  return encryptJSON(key, msg)
}

export async function decodeEnc<T>(key: CryptoKey, base64Data: string): Promise<T> {
  return decryptJSON<T>(key, base64Data)
}

// Exhaustiveness guard for `switch (msg.type)` handlers. Putting this at
// the default branch forces TS to complain at compile time when a new
// variant is added without a corresponding case. Throws at runtime to
// catch a payload whose `type` is off-union (e.g., malicious peer).
export function assertNever(x: never, context: string): never {
  const serialized = (() => {
    try { return JSON.stringify(x) } catch { return String(x) }
  })()
  throw new Error(`unhandled protocol variant in ${context}: ${serialized}`)
}
