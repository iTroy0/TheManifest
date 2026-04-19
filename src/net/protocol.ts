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

export interface PingMsg { type: 'ping'; ts: number }
export interface PongMsg { type: 'pong'; ts: number }
// Raw public-key bytes for ECDH. Serialized as a plain number[] so JSON
// round-trips survive (Uint8Array is not directly JSON-representable).
export interface PublicKeyMsg { type: 'public-key'; key: number[] }

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
export interface ManifestEncMsg { type: 'manifest-enc'; data: string }
// Kept so the receiver can still match `msg.type === 'manifest'` and reject
// it loudly (MITM-safety log line).
export interface ManifestMsg { type: 'manifest' }
// `resumeFrom` lets a reconnect skip chunks already written.
export interface FileStartMsg {
  type: 'file-start'
  index: number
  name: string
  size: number
  totalChunks: number
  resumeFrom?: number
}
export interface FileEndMsg { type: 'file-end'; index: number }
export interface PasswordRequiredMsg { type: 'password-required' }
export interface PasswordEncryptedMsg { type: 'password-encrypted'; data: string }
export interface PasswordAcceptedMsg { type: 'password-accepted' }
export interface PasswordWrongMsg { type: 'password-wrong' }
export interface PasswordLockedMsg { type: 'password-locked' }
export interface PasswordRateLimitedMsg { type: 'password-rate-limited' }
export interface ReadyMsg { type: 'ready' }
export interface RequestFileMsg { type: 'request-file'; index: number; resumeChunk?: number }
export interface RequestAllMsg { type: 'request-all'; indices?: number[] }
export interface ResumeMsg { type: 'resume'; fileIndex: number; chunkIndex: number }
export interface PauseFileMsg { type: 'pause-file'; index: number }
export interface ResumeFileMsg { type: 'resume-file'; index: number }
export interface CancelFileMsg { type: 'cancel-file'; index: number }
export interface CancelAllMsg { type: 'cancel-all' }
export interface FileSkippedMsg { type: 'file-skipped'; index: number; reason: string }
export interface FileCancelledMsg { type: 'file-cancelled'; index: number }
export interface BatchDoneMsg { type: 'batch-done' }
export interface DoneMsg { type: 'done' }
export interface CancelAllAckMsg { type: 'cancel-all-ack' }
export interface RejectedMsg { type: 'rejected'; reason?: string }
export interface ClosingMsg { type: 'closing' }
export interface JoinMsg { type: 'join'; nickname: string }
// Portal rename message. Differs from the collab equivalent in that the
// old name travels in the payload (portal has no authenticated peerId
// the sender can use to look up the previous name server-side).
export interface NicknameChangeMsg { type: 'nickname-change'; oldName?: string; newName: string }
export interface TypingMsg { type: 'typing'; nickname: string }
export interface ReactionMsg {
  type: 'reaction'
  msgId: string
  emoji: string
  nickname: string
}
// `from` / `time` are present on relay frames so recipients can attribute the message correctly.
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
  | ManifestEncMsg | ManifestMsg
  | FileStartMsg | FileEndMsg
  | PasswordRequiredMsg | PasswordEncryptedMsg | PasswordAcceptedMsg
  | PasswordWrongMsg | PasswordLockedMsg | PasswordRateLimitedMsg
  | ReadyMsg | ResumeMsg
  | RequestFileMsg | RequestAllMsg
  | PauseFileMsg | ResumeFileMsg | CancelFileMsg | CancelAllMsg
  | FileSkippedMsg | FileCancelledMsg | BatchDoneMsg | DoneMsg
  | CancelAllAckMsg | RejectedMsg | ClosingMsg
  | JoinMsg | NicknameChangeMsg | TypingMsg | ReactionMsg
  | ChatEncryptedMsg | RelayChatEncryptedMsg
  | ChatImageStartEncMsg | ChatImageEndEncMsg | ChatImageAbortMsg

// Two-layer protocol: outer `collab-msg-enc` carries base64 ciphertext of
// an inner JSON message. Don't collapse these types — the host
// intentionally can't read some collab-* inner payloads (peer-to-peer
// mesh chat is end-to-end between guests).
export interface CollabEnvelope { type: 'collab-msg-enc'; data: string }

// `SharedFile` / participant-snapshot shapes typed as `unknown` to avoid a
// circular import through `state/collabState.ts`; the sanitizer there is the runtime validator.
export type CollabInnerMsg =
  | { type: 'collab-request-file'; fileId: string; owner?: string; requesterPeerId?: string }
  | { type: 'collab-file-start'; fileId: string; name: string; size: number; totalChunks: number; packetIndex: number }
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
  // `collab-peer-renamed` is primarily broadcast unencrypted (see
  // `CollabUnencryptedMsg`), but useCollabGuest carries a legacy
  // encrypted-path handler. Keep the variant here so that handler
  // still typechecks until it's removed in a cleanup pass.
  | { type: 'collab-peer-renamed'; peerId: string; oldName?: string; newName: string }

// Participant-management messages that ride the same DataConnection but
// are NOT encrypted. Trust is established via host-owned peerId; the host
// rewrites `peerId` to the authenticated connection source before
// broadcasting rename/join/leave events (see useCollabHost L6 comment).
export type CollabUnencryptedMsg =
  | CollabEnvelope
  | PingMsg | PongMsg | PublicKeyMsg
  | OnlineCountMsg | SystemMsgMsg | ClosingMsg
  | ChatEncryptedMsg | RelayChatEncryptedMsg
  | ChatImageStartEncMsg | ChatImageEndEncMsg | ChatImageAbortMsg
  | JoinMsg | TypingMsg | ReactionMsg
  // Two shapes on the wire: guest→host carries `target` (the intended
  // destination); host→target-guest carries `from` (the originator, since
  // the destination is already implied by the DataConnection). Both fields
  // are optional in the type; senders always populate exactly one.
  | { type: 'collab-signal'; target?: string; from?: string; signal: unknown }
  | { type: 'collab-peer-joined'; peerId: string; name: string }
  | { type: 'collab-peer-left'; peerId: string; name?: string }
  | { type: 'collab-peer-renamed'; peerId: string; oldName: string; newName: string }
  | { type: 'collab-participant-list'; participants: Array<{ peerId: string; name: string }> }
  | { type: 'room-closed' }
  | { type: 'kicked' }
  | { type: 'nickname-change'; oldName?: string; newName: string }
  | { type: 'password-required' }
  | { type: 'password-encrypted'; data: string }
  | { type: 'password-accepted' }
  | { type: 'password-wrong' }
  | { type: 'password-locked' }
  | { type: 'password-rate-limited' }
  // M-m — guest requests fresh participant + file lists. Used when the
  // guest suspects drift (reconnect, missed broadcast). Host replies by
  // re-running sendParticipantListToGuest + sendFileListToGuest.
  | { type: 'collab-resync-request' }

// ── Call lane ────────────────────────────────────────────────────────────
// Every call message carries `from` so the receiver can route without
// trusting the transport's peerId (useful across host-relayed guest↔guest).
export type CallMode = 'audio' | 'video'

export type CallMsg =
  | { type: 'call-join'; mode: CallMode; name: string; from: string }
  | { type: 'call-leave'; from: string }
  | {
      type: 'call-peer-joined'
      peerId: string
      name: string
      mode: CallMode
      // Whether this peer is actively sharing their screen. Optional for
      // backward compatibility with older clients that predate screen share.
      screenSharing?: boolean
      from: string
    }
  | { type: 'call-peer-left'; peerId: string; from: string }
  | {
      type: 'call-roster'
      peers: Array<{ peerId: string; name: string; mode: CallMode; screenSharing?: boolean }>
      from: string
    }
  | {
      type: 'call-track-state'
      // Guest self-reports omit peerId; the host pins it to the
      // authenticated sender id before re-broadcasting. Optional so both
      // wire shapes typecheck.
      peerId?: string
      micMuted: boolean
      cameraOff: boolean
      mode: CallMode
      from: string
    }
  // Host can reject a join after a call-join arrives (e.g., soft video
  // cap exceeded). Carries no extra payload beyond `from`.
  | { type: 'call-rejected'; from: string }
  // Screen share state. `active` flips true/false as the peer starts/stops
  // sharing their display. Guests omit peerId; host pins it and rebroadcasts.
  | {
      type: 'call-screen-state'
      peerId?: string
      active: boolean
      from: string
    }

// Typed wrappers around `encryptJSON` / `decryptJSON` — the compiler narrows
// the return type to the caller's stated message shape.
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
