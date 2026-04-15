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
  | 'error'
  | 'closed'
  | 'kicked'

export interface CollabParticipant {
  peerId: string
  name: string
  isHost: boolean
  connectionStatus: 'connecting' | 'connected' | 'disconnected'
  directConnection: boolean // true if P2P established, false if relay through host
}

export interface SharedFile {
  id: string
  name: string
  size: number
  type: string
  owner: string        // peerId of who shared it
  ownerName: string
  thumbnail?: string
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
  progress: Record<string, number>      // progress by filename for FileList
  pendingFiles: Record<number, boolean> // pending by index for FileList
  pausedFiles: Record<number, boolean>  // paused by index for FileList
  completedFiles: Record<number, boolean> // completed by index
  currentFileIndex: number | null       // active download index
  mySharedFiles: Set<string> // fileIds I've shared
}

export type FilesAction =
  | { type: 'ADD_SHARED_FILE'; payload: SharedFile }
  | { type: 'REMOVE_SHARED_FILE'; fileId: string }
  | { type: 'SET_SHARED_FILES'; payload: SharedFile[] }
  | { type: 'ADD_MY_SHARED_FILE'; fileId: string }
  | { type: 'SET_DOWNLOAD'; fileId: string; download: FileDownload }
  | { type: 'UPDATE_DOWNLOAD'; fileId: string; payload: Partial<FileDownload> }
  | { type: 'FILE_PROGRESS'; name: string; value: number }
  | { type: 'ADD_PENDING'; index: number }
  | { type: 'REMOVE_PENDING'; index: number }
  | { type: 'PAUSE_FILE'; index: number }
  | { type: 'RESUME_FILE'; index: number }
  | { type: 'COMPLETE_FILE'; index: number; name: string }
  | { type: 'CANCEL_FILE'; index: number; name?: string }
  | { type: 'SET_CURRENT_FILE'; index: number | null }
  | { type: 'RESET' }

export const initialFilesState: CollabFilesState = {
  sharedFiles: [],
  downloads: {},
  progress: {},
  pendingFiles: {},
  pausedFiles: {},
  completedFiles: {},
  currentFileIndex: null,
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
    case 'FILE_PROGRESS':
      return { ...state, progress: { ...state.progress, [action.name]: action.value } }
    case 'ADD_PENDING':
      return { ...state, pendingFiles: { ...state.pendingFiles, [action.index]: true } }
    case 'REMOVE_PENDING': {
      const p = { ...state.pendingFiles }; delete p[action.index]
      return { ...state, pendingFiles: p }
    }
    case 'PAUSE_FILE':
      return { ...state, pausedFiles: { ...state.pausedFiles, [action.index]: true } }
    case 'RESUME_FILE': {
      const p = { ...state.pausedFiles }; delete p[action.index]
      return { ...state, pausedFiles: p }
    }
    case 'COMPLETE_FILE': {
      const pending = { ...state.pendingFiles }; delete pending[action.index]
      const paused = { ...state.pausedFiles }; delete paused[action.index]
      return {
        ...state,
        progress: { ...state.progress, [action.name]: 100 },
        completedFiles: { ...state.completedFiles, [action.index]: true },
        pendingFiles: pending,
        pausedFiles: paused,
        currentFileIndex: null,
      }
    }
    case 'CANCEL_FILE': {
      const pending = { ...state.pendingFiles }; delete pending[action.index]
      const paused = { ...state.pausedFiles }; delete paused[action.index]
      const progress = { ...state.progress }; if (action.name) delete progress[action.name]
      return {
        ...state,
        pendingFiles: pending,
        pausedFiles: paused,
        progress,
        currentFileIndex: state.currentFileIndex === action.index ? null : state.currentFileIndex,
      }
    }
    case 'SET_CURRENT_FILE':
      return { ...state, currentFileIndex: action.index }
    case 'RESET':
      return { ...initialFilesState, mySharedFiles: new Set() }
    default:
      return state
  }
}

// ── Transfer State ───────────────────────────────────────────────────────

export interface CollabTransferState {
  uploading: boolean
  uploadProgress: number
  uploadSpeed: number
  uploadFileId: string | null
  uploadFileName: string | null
}

export type TransferAction =
  | { type: 'START_UPLOAD'; fileId: string; fileName: string }
  | { type: 'UPDATE_UPLOAD'; progress: number; speed: number }
  | { type: 'END_UPLOAD' }
  | { type: 'RESET' }

export const initialTransferState: CollabTransferState = {
  uploading: false,
  uploadProgress: 0,
  uploadSpeed: 0,
  uploadFileId: null,
  uploadFileName: null,
}

export function transferReducer(state: CollabTransferState, action: TransferAction): CollabTransferState {
  switch (action.type) {
    case 'START_UPLOAD':
      return { ...state, uploading: true, uploadProgress: 0, uploadSpeed: 0, uploadFileId: action.fileId, uploadFileName: action.fileName }
    case 'UPDATE_UPLOAD':
      return { ...state, uploadProgress: action.progress, uploadSpeed: action.speed }
    case 'END_UPLOAD':
      return { ...state, uploading: false, uploadProgress: 0, uploadSpeed: 0, uploadFileId: null, uploadFileName: null }
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
