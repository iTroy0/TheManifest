// Sender-side state shape and reducers. Separated from the hook itself so
// the hook file can focus on effects and orchestration.

export interface TransferState {
  progress: Record<string, number>
  overallProgress: number
  speed: number
  eta: number | null
  currentFileIndex: number
  totalSent: number
}

export type TransferAction =
  | { type: 'SET'; payload: Partial<TransferState> }
  | { type: 'RESET' }

export const initialTransfer: TransferState = {
  progress: {},
  overallProgress: 0,
  speed: 0,
  eta: null,
  currentFileIndex: -1,
  totalSent: 0,
}

export function transferReducer(state: TransferState, action: TransferAction): TransferState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'RESET': return initialTransfer
    default: return state
  }
}

export interface ConnectionState {
  peerId: string | null
  status: string
  fingerprint: string | null
  recipientCount: number
}

export type ConnectionAction =
  | { type: 'SET'; payload: Partial<ConnectionState> }
  | { type: 'SET_STATUS'; payload: string | ((prev: string) => string) }
  | { type: 'RESET' }

export const initialConnection: ConnectionState = {
  peerId: null,
  status: 'initializing',
  fingerprint: null,
  recipientCount: 0,
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
