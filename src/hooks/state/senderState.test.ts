import { describe, it, expect } from 'vitest'
import {
  transferReducer,
  connectionReducer,
  initialTransfer,
  initialConnection,
} from './senderState'

describe('sender transferReducer', () => {
  it('SET merges partial payload', () => {
    const next = transferReducer(initialTransfer, { type: 'SET', payload: { speed: 100, overallProgress: 42 } })
    expect(next.speed).toBe(100)
    expect(next.overallProgress).toBe(42)
    expect(next.progress).toEqual({})
  })

  it('SET preserves unrelated fields', () => {
    const state = { ...initialTransfer, eta: 5, totalSent: 1024 }
    const next = transferReducer(state, { type: 'SET', payload: { speed: 10 } })
    expect(next.eta).toBe(5)
    expect(next.totalSent).toBe(1024)
    expect(next.speed).toBe(10)
  })

  it('RESET restores initial', () => {
    const state = { ...initialTransfer, speed: 100, totalSent: 999 }
    const next = transferReducer(state, { type: 'RESET' })
    expect(next).toEqual(initialTransfer)
  })

  it('unknown action returns same reference', () => {
    const unknown = { type: 'NOPE' } as unknown as Parameters<typeof transferReducer>[1]
    const next = transferReducer(initialTransfer, unknown)
    expect(next).toBe(initialTransfer)
  })
})

describe('sender connectionReducer', () => {
  it('SET merges partial payload', () => {
    const next = connectionReducer(initialConnection, {
      type: 'SET',
      payload: { peerId: 'abc', recipientCount: 2 },
    })
    expect(next.peerId).toBe('abc')
    expect(next.recipientCount).toBe(2)
    expect(next.status).toBe('initializing')
  })

  it('SET_STATUS with a string replaces status', () => {
    const next = connectionReducer(initialConnection, { type: 'SET_STATUS', payload: 'ready' })
    expect(next.status).toBe('ready')
  })

  it('SET_STATUS with a function receives previous status', () => {
    const state = { ...initialConnection, status: 'connecting' }
    const next = connectionReducer(state, {
      type: 'SET_STATUS',
      payload: prev => prev === 'connecting' ? 'connected' : prev,
    })
    expect(next.status).toBe('connected')
  })

  it('SET_STATUS is a no-op (returns same ref) when the new status matches', () => {
    const state = { ...initialConnection, status: 'ready' }
    const next = connectionReducer(state, { type: 'SET_STATUS', payload: 'ready' })
    expect(next).toBe(state)
  })

  it('SET_STATUS functional no-op returns same ref', () => {
    const state = { ...initialConnection, status: 'x' }
    const next = connectionReducer(state, { type: 'SET_STATUS', payload: prev => prev })
    expect(next).toBe(state)
  })

  it('RESET restores initial', () => {
    const state = { ...initialConnection, peerId: 'x', status: 'connected' }
    const next = connectionReducer(state, { type: 'RESET' })
    expect(next).toEqual(initialConnection)
  })
})
