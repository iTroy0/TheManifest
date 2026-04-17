import { useReducer } from 'react'
import type { ViewImage } from '../components/chat/ImagePreviewOverlay'

export interface ImagePreview {
  url: string
  bytes: Uint8Array
  mime: string
  duration?: number
}

export interface ReplyTo {
  text: string
  from: string
  time: number
}

export interface InteractionState {
  replyTo: ReplyTo | null
  reactingIdx: number | null
  activeMsg: number | null
  imagePreview: ImagePreview | null
  viewImage: ViewImage | null
  isDragOver: boolean
  dropError: string | null
}

export type InteractionAction =
  | { type: 'SET'; payload: Partial<InteractionState> }
  | { type: 'CLEAR_SEND' }
  | { type: 'TOGGLE_MSG'; index: number }

export const initialInteraction: InteractionState = {
  replyTo: null,
  reactingIdx: null,
  activeMsg: null,
  imagePreview: null,
  viewImage: null,
  isDragOver: false,
  dropError: null,
}

export function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'CLEAR_SEND': return { ...state, imagePreview: null, replyTo: null }
    case 'TOGGLE_MSG': return { ...state, activeMsg: state.activeMsg === action.index ? null : action.index, reactingIdx: null }
    default: return state
  }
}

export function useChatInteraction() {
  return useReducer(interactionReducer, initialInteraction)
}
