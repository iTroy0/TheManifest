import { useReducer } from 'react'

export interface PopoutPos {
  x: number
  y: number
}

export interface PopoutSize {
  w: number
  h: number
}

export interface MenuPos {
  top: number
  right: number
}

export interface PanelState {
  open: boolean
  unread: number
  isFullscreen: boolean
  isPopout: boolean
  showMenu: boolean
  showClearConfirm: boolean
  showScrollBtn: boolean
  isNearBottom: boolean
  menuPos: MenuPos
  popoutPos: PopoutPos | null
  popoutSize: PopoutSize
  viewportHeight: string
  viewportOffset: number
}

export type PanelAction =
  | { type: 'SET'; payload: Partial<PanelState> }
  | { type: 'TOGGLE_OPEN' }
  | { type: 'TOGGLE_MENU' }
  | { type: 'INCREMENT_UNREAD'; count: number }
  | { type: 'RESET_POPOUT' }

export const initialPanel: PanelState = {
  open: false,
  unread: 0,
  isFullscreen: false,
  isPopout: false,
  showMenu: false,
  showClearConfirm: false,
  showScrollBtn: false,
  isNearBottom: true,
  menuPos: { top: 0, right: 0 },
  popoutPos: null,
  popoutSize: { w: 384, h: 600 },
  viewportHeight: '100dvh',
  viewportOffset: 0,
}

export function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'TOGGLE_OPEN': return { ...state, open: !state.open }
    case 'TOGGLE_MENU': return { ...state, showMenu: !state.showMenu }
    case 'INCREMENT_UNREAD': return { ...state, unread: state.unread + action.count }
    case 'RESET_POPOUT': return { ...state, isPopout: false, popoutPos: null, popoutSize: { w: 384, h: 600 } }
    default: return state
  }
}

// Thin hook wrapper so ChatPanel can call a single line instead of
// importing both the reducer and its initial state.
export function useChatPanelState() {
  return useReducer(panelReducer, initialPanel)
}
