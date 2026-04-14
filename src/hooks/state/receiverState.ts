import { ManifestData } from '../../types'

export interface TransferState {
  progress: Record<string, number>
  overallProgress: number
  speed: number
  eta: number | null
  pendingFiles: Record<number, boolean>
  completedFiles: Record<number, boolean>
  pausedFiles: Record<number, boolean>
}

export type TransferAction =
  | { type: 'SET'; payload: Partial<TransferState> }
  | { type: 'FILE_PROGRESS'; name: string; value: number }
  | { type: 'COMPLETE_FILE'; index: number; name: string }
  | { type: 'CANCEL_FILE'; index: number; name?: string }
  | { type: 'REMOVE_PENDING'; index: number }
  | { type: 'ADD_PENDING'; index: number }
  | { type: 'PAUSE_FILE'; index: number }
  | { type: 'RESUME_FILE'; index: number }
  | { type: 'RESET' }

export const initialTransfer: TransferState = {
  progress: {},
  overallProgress: 0,
  speed: 0,
  eta: null,
  pendingFiles: {},
  completedFiles: {},
  pausedFiles: {},
}

export function transferReducer(state: TransferState, action: TransferAction): TransferState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'FILE_PROGRESS':
      return { ...state, progress: { ...state.progress, [action.name]: action.value } }
    case 'COMPLETE_FILE': {
      const p = { ...state.pendingFiles }; delete p[action.index]
      return { ...state, progress: { ...state.progress, [action.name]: 100 }, completedFiles: { ...state.completedFiles, [action.index]: true }, pendingFiles: p }
    }
    case 'CANCEL_FILE': {
      const pending = { ...state.pendingFiles }; delete pending[action.index]
      const paused = { ...state.pausedFiles }; delete paused[action.index]
      const progress = { ...state.progress }; if (action.name) delete progress[action.name]
      return { ...state, pendingFiles: pending, pausedFiles: paused, progress }
    }
    case 'REMOVE_PENDING': {
      const p = { ...state.pendingFiles }; delete p[action.index]; return { ...state, pendingFiles: p }
    }
    case 'ADD_PENDING':
      return { ...state, pendingFiles: { ...state.pendingFiles, [action.index]: true } }
    case 'PAUSE_FILE':
      return { ...state, pausedFiles: { ...state.pausedFiles, [action.index]: true } }
    case 'RESUME_FILE': {
      const p = { ...state.pausedFiles }; delete p[action.index]; return { ...state, pausedFiles: p }
    }
    case 'RESET': return initialTransfer
    default: return state
  }
}

export interface ConnectionState {
  status: string
  manifest: ManifestData | null
  fingerprint: string | null
  retryCount: number
  useRelay: boolean
  zipMode: boolean
  onlineCount: number
  passwordRequired: boolean
  passwordError: boolean
}

export type ConnectionAction =
  | { type: 'SET'; payload: Partial<ConnectionState> }
  | { type: 'SET_STATUS'; payload: string | ((prev: string) => string) }
  | { type: 'RESET' }

export const initialConnection: ConnectionState = {
  status: 'connecting',
  manifest: null,
  fingerprint: null,
  retryCount: 0,
  useRelay: false,
  zipMode: false,
  onlineCount: 0,
  passwordRequired: false,
  passwordError: false,
}

export function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'SET_STATUS': {
      const next = typeof action.payload === 'function' ? action.payload(state.status) : action.payload
      return next === state.status ? state : { ...state, status: next }
    }
    case 'RESET': return initialConnection
    default: return state
  }
}
