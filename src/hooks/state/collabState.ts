// Collaborative Portal state management
// Handles room state, participants, shared files, and P2P connections

import { ChatMessage } from '../../types'

// ── Types ────────────────────────────────────────────────────────────────

export type CollabStatus =
  | 'initializing'
  | 'creating'
  | 'waiting'      // Host waiting for guests
  | 'joining'
  | 'connected'
  | 'password-required'
  | 'reconnecting'
  | 'direct-failed'
  | 'error'
  | 'closed'
  | 'kicked'

export interface CollabParticipant {
  peerId: string
  name: string
  isHost: boolean
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  directConnection: boolean // true if P2P established, false if relay through host
  fingerprint?: string      // Short fingerprint for MITM verification (per-connection)
}

export interface SharedFile {
  id: string
  name: string
  size: number
  type: string
  owner: string        // peerId of who shared it
  ownerName: string
  thumbnail?: string
  textPreview?: string
  addedAt: number
}

export interface FileDownload {
  status: 'pending' | 'requesting' | 'downloading' | 'paused' | 'complete' | 'error'
  progress: number
  speed: number
  error?: string
}

// For FileList compatibility - matches FileEntry interface
export interface CollabFileEntry {
  name: string
  size: number
  type: string
  thumbnail?: string
  textPreview?: string
  // Collab-specific extensions
  id: string
  owner: string
  ownerName: string
  addedAt: number
}

// ── SharedFile validator (C2 — security hardening) ───────────────────────

// Maximum allowed values for incoming file metadata.
const MAX_FILE_ID = 64
const MAX_FILE_NAME = 255
// Upper bound exists purely as a sanity gate against a peer sending a
// garbage size (e.g. Number.MAX_SAFE_INTEGER) that downstream code would
// divide by, allocate against, or pass to progress math. Legitimate shares
// stream over chunked WebRTC + StreamSaver so there is no intrinsic
// transfer-size limit; 100 GB is well above any realistic single-file use
// case while still rejecting obviously malformed values.
const MAX_FILE_SIZE = 100 * 1024 * 1024 * 1024 // 100 GB
const MAX_FILE_TYPE = 128
const MAX_OWNER_ID = 64
const MAX_OWNER_NAME = 32
const MAX_THUMB_LEN = 200_000 // ~150KB decoded
const MAX_TEXT_PREVIEW = 2000

/**
 * Validate a SharedFile payload received from a peer/host. Used to drop
 * malformed or oversized entries instead of trusting the wire format.
 *
 * Returns null when valid; otherwise a short reason string so callers can
 * log which field failed (the original boolean answer lost that signal and
 * made field-level regressions invisible in production).
 */
export function validateSharedFile(obj: unknown): string | null {
  if (!obj || typeof obj !== 'object') return 'not-object'
  const f = obj as Record<string, unknown>
  if (typeof f.id !== 'string') return 'id:not-string'
  if (f.id.length === 0 || f.id.length > MAX_FILE_ID) return `id:len=${f.id.length}`
  if (typeof f.name !== 'string') return 'name:not-string'
  if (f.name.length === 0 || f.name.length > MAX_FILE_NAME) return `name:len=${f.name.length}`
  if (typeof f.size !== 'number') return `size:type=${typeof f.size}`
  if (!Number.isFinite(f.size)) return 'size:not-finite'
  if (!Number.isInteger(f.size)) return `size:not-integer(${f.size})`
  if (f.size < 0 || f.size > MAX_FILE_SIZE) return `size:out-of-range(${f.size})`
  if (typeof f.type !== 'string') return `type:type=${typeof f.type}`
  if (f.type.length > MAX_FILE_TYPE) return `type:len=${f.type.length}`
  if (typeof f.owner !== 'string') return `owner:type=${typeof f.owner}`
  if (f.owner.length === 0 || f.owner.length > MAX_OWNER_ID) return `owner:len=${f.owner.length}`
  if (typeof f.ownerName !== 'string') return `ownerName:type=${typeof f.ownerName}`
  if (f.ownerName.length === 0 || f.ownerName.length > MAX_OWNER_NAME) return `ownerName:len=${f.ownerName.length}`
  if (f.thumbnail !== undefined) {
    if (typeof f.thumbnail !== 'string') return `thumbnail:type=${typeof f.thumbnail}`
    if (f.thumbnail.length > MAX_THUMB_LEN) return `thumbnail:len=${f.thumbnail.length}`
  }
  if (f.textPreview !== undefined) {
    if (typeof f.textPreview !== 'string') return `textPreview:type=${typeof f.textPreview}`
    if (f.textPreview.length > MAX_TEXT_PREVIEW) return `textPreview:len=${f.textPreview.length}`
  }
  if (typeof f.addedAt !== 'number') return `addedAt:type=${typeof f.addedAt}`
  if (!Number.isFinite(f.addedAt)) return 'addedAt:not-finite'
  return null
}

export function isValidSharedFile(obj: unknown): obj is SharedFile {
  return validateSharedFile(obj) === null
}

/**
 * Accept a SharedFile if the essential fields are valid, stripping cosmetic
 * fields (`thumbnail`, `textPreview`) that exceed their size bounds.
 *
 * The C2 validator was rejecting whole file shares when an unexpectedly
 * large thumbnail/preview pushed one optional field past its cap, which
 * was the failure path seen in practice (the file would never appear on
 * the host or other guests). Cosmetic overage is not a security issue —
 * drop it and keep the share.
 *
 * Returns `{ file, droppedReasons[] }` on success, or `null` if an
 * essential field is still invalid.
 */
export function sanitizeSharedFile(obj: unknown): { file: SharedFile; droppedReasons: string[] } | null {
  if (!obj || typeof obj !== 'object') return null
  const copy: Record<string, unknown> = { ...(obj as Record<string, unknown>) }
  const droppedReasons: string[] = []
  for (let i = 0; i < 2; i++) {
    const reason = validateSharedFile(copy)
    if (reason === null) break
    if (reason.startsWith('thumbnail:') && 'thumbnail' in copy) {
      delete copy.thumbnail
      droppedReasons.push(reason)
      continue
    }
    if (reason.startsWith('textPreview:') && 'textPreview' in copy) {
      delete copy.textPreview
      droppedReasons.push(reason)
      continue
    }
    return null
  }
  if (validateSharedFile(copy) !== null) return null
  return { file: copy as unknown as SharedFile, droppedReasons }
}

// ── Room State ───────────────────────────────────────────────────────────

export interface CollabRoomState {
  roomId: string | null
  isHost: boolean
  status: CollabStatus
  myPeerId: string | null
  myName: string
  password: string | null
  passwordRequired: boolean
  passwordError: boolean
  fingerprint: string | null
  errorMessage: string | null
}

export type RoomAction =
  | { type: 'SET'; payload: Partial<CollabRoomState> }
  | { type: 'SET_STATUS'; payload: CollabStatus }
  | { type: 'RESET' }

export const initialRoomState: CollabRoomState = {
  roomId: null,
  isHost: false,
  status: 'initializing',
  myPeerId: null,
  myName: 'Guest',
  password: null,
  passwordRequired: false,
  passwordError: false,
  fingerprint: null,
  errorMessage: null,
}

export function roomReducer(state: CollabRoomState, action: RoomAction): CollabRoomState {
  switch (action.type) {
    case 'SET':
      return { ...state, ...action.payload }
    case 'SET_STATUS':
      return state.status === action.payload ? state : { ...state, status: action.payload }
    case 'RESET':
      return initialRoomState
    default:
      return state
  }
}

// ── Participants State ───────────────────────────────────────────────────

export interface CollabParticipantsState {
  participants: CollabParticipant[]
  onlineCount: number
}

export type ParticipantsAction =
  | { type: 'SET_PARTICIPANTS'; payload: CollabParticipant[] }
  | { type: 'ADD_PARTICIPANT'; payload: CollabParticipant }
  | { type: 'REMOVE_PARTICIPANT'; peerId: string }
  | { type: 'UPDATE_PARTICIPANT'; peerId: string; payload: Partial<CollabParticipant> }
  | { type: 'SET_ONLINE_COUNT'; count: number }
  | { type: 'RESET' }

export const initialParticipantsState: CollabParticipantsState = {
  participants: [],
  onlineCount: 0,
}

export function participantsReducer(state: CollabParticipantsState, action: ParticipantsAction): CollabParticipantsState {
  switch (action.type) {
    case 'SET_PARTICIPANTS':
      return { ...state, participants: action.payload, onlineCount: action.payload.length }
    case 'ADD_PARTICIPANT': {
      if (state.participants.find(p => p.peerId === action.payload.peerId)) {
        return state // Already exists
      }
      const newList = [...state.participants, action.payload]
      return { ...state, participants: newList, onlineCount: newList.length }
    }
    case 'REMOVE_PARTICIPANT': {
      const newList = state.participants.filter(p => p.peerId !== action.peerId)
      return { ...state, participants: newList, onlineCount: newList.length }
    }
    case 'UPDATE_PARTICIPANT': {
      const newList = state.participants.map(p =>
        p.peerId === action.peerId ? { ...p, ...action.payload } : p
      )
      return { ...state, participants: newList }
    }
    case 'SET_ONLINE_COUNT':
      return { ...state, onlineCount: action.count }
    case 'RESET':
      return initialParticipantsState
    default:
      return state
  }
}

// ── Files State ──────────────────────────────────────────────────────────

export interface CollabFilesState {
  sharedFiles: SharedFile[]
  downloads: Record<string, FileDownload>
  mySharedFiles: Set<string> // fileIds I've shared
}

export type FilesAction =
  | { type: 'ADD_SHARED_FILE'; payload: SharedFile }
  | { type: 'REMOVE_SHARED_FILE'; fileId: string }
  | { type: 'SET_SHARED_FILES'; payload: SharedFile[] }
  | { type: 'ADD_MY_SHARED_FILE'; fileId: string }
  | { type: 'SET_DOWNLOAD'; fileId: string; download: FileDownload }
  | { type: 'UPDATE_DOWNLOAD'; fileId: string; payload: Partial<FileDownload> }
  | { type: 'REMOVE_DOWNLOAD'; fileId: string }
  | { type: 'CANCEL_ALL_DOWNLOADS' }
  | { type: 'REMOVE_FILES_BY_OWNER'; ownerId: string }
  | { type: 'UPDATE_SHARED_FILE_OWNER_NAME'; ownerId: string; newName: string }
  | { type: 'RESET' }

export const initialFilesState: CollabFilesState = {
  sharedFiles: [],
  downloads: {},
  mySharedFiles: new Set(),
}

export function filesReducer(state: CollabFilesState, action: FilesAction): CollabFilesState {
  switch (action.type) {
    case 'ADD_SHARED_FILE': {
      if (state.sharedFiles.find(f => f.id === action.payload.id)) {
        return state // Already exists
      }
      return { ...state, sharedFiles: [...state.sharedFiles, action.payload] }
    }
    case 'REMOVE_SHARED_FILE': {
      const newFiles = state.sharedFiles.filter(f => f.id !== action.fileId)
      const newDownloads = { ...state.downloads }
      delete newDownloads[action.fileId]
      const newMyShared = new Set(state.mySharedFiles)
      newMyShared.delete(action.fileId)
      return { ...state, sharedFiles: newFiles, downloads: newDownloads, mySharedFiles: newMyShared }
    }
    case 'SET_SHARED_FILES':
      return { ...state, sharedFiles: action.payload }
    case 'ADD_MY_SHARED_FILE': {
      const newSet = new Set(state.mySharedFiles)
      newSet.add(action.fileId)
      return { ...state, mySharedFiles: newSet }
    }
    case 'SET_DOWNLOAD':
      return { ...state, downloads: { ...state.downloads, [action.fileId]: action.download } }
    case 'UPDATE_DOWNLOAD': {
      const existing = state.downloads[action.fileId]
      if (!existing) return state
      return { ...state, downloads: { ...state.downloads, [action.fileId]: { ...existing, ...action.payload } } }
    }
    case 'REMOVE_DOWNLOAD': {
      const newDownloads = { ...state.downloads }
      delete newDownloads[action.fileId]
      return { ...state, downloads: newDownloads }
    }
    case 'CANCEL_ALL_DOWNLOADS':
      // Clear every download entry without touching sharedFiles/mySharedFiles.
      return { ...state, downloads: {} }
    case 'REMOVE_FILES_BY_OWNER': {
      const remainingFiles = state.sharedFiles.filter(f => f.owner !== action.ownerId)
      const removedIds = new Set(state.sharedFiles.filter(f => f.owner === action.ownerId).map(f => f.id))
      const newDownloads: Record<string, FileDownload> = {}
      for (const [id, d] of Object.entries(state.downloads)) {
        if (!removedIds.has(id)) newDownloads[id] = d
      }
      return { ...state, sharedFiles: remainingFiles, downloads: newDownloads }
    }
    case 'UPDATE_SHARED_FILE_OWNER_NAME': {
      const newFiles = state.sharedFiles.map(f =>
        f.owner === action.ownerId ? { ...f, ownerName: action.newName } : f
      )
      return { ...state, sharedFiles: newFiles }
    }
    case 'RESET':
      return { ...initialFilesState, mySharedFiles: new Set() }
    default:
      return state
  }
}

// ── Transfer State (H1 — per-fileId upload tracking) ─────────────────────

export interface UploadEntry {
  progress: number
  speed: number
  fileName: string
}

export interface CollabTransferState {
  uploads: Record<string, UploadEntry>
}

export type TransferAction =
  | { type: 'START_UPLOAD'; fileId: string; fileName: string }
  | { type: 'UPDATE_UPLOAD'; fileId: string; progress: number; speed: number }
  | { type: 'END_UPLOAD'; fileId: string }
  | { type: 'RESET' }

export const initialTransferState: CollabTransferState = {
  uploads: {},
}

export function transferReducer(state: CollabTransferState, action: TransferAction): CollabTransferState {
  switch (action.type) {
    case 'START_UPLOAD':
      return {
        ...state,
        uploads: {
          ...state.uploads,
          [action.fileId]: { progress: 0, speed: 0, fileName: action.fileName },
        },
      }
    case 'UPDATE_UPLOAD': {
      const existing = state.uploads[action.fileId]
      if (!existing) return state
      return {
        ...state,
        uploads: {
          ...state.uploads,
          [action.fileId]: { ...existing, progress: action.progress, speed: action.speed },
        },
      }
    }
    case 'END_UPLOAD': {
      const newUploads = { ...state.uploads }
      delete newUploads[action.fileId]
      return { ...state, uploads: newUploads }
    }
    case 'RESET':
      return initialTransferState
    default:
      return state
  }
}

// ── Combined Collab State (for context or single-hook scenarios) ─────────

export interface CollabState {
  room: CollabRoomState
  participants: CollabParticipantsState
  files: CollabFilesState
  transfer: CollabTransferState
  messages: ChatMessage[]
}

export const initialCollabState: CollabState = {
  room: initialRoomState,
  participants: initialParticipantsState,
  files: initialFilesState,
  transfer: initialTransferState,
  messages: [],
}
