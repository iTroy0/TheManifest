import { describe, it, expect } from 'vitest'
import {
  transferReducer,
  connectionReducer,
  initialTransfer,
  initialConnection,
} from './receiverState'

describe('receiver transferReducer', () => {
  it('SET merges partial payload', () => {
    const next = transferReducer(initialTransfer, { type: 'SET', payload: { speed: 100, overallProgress: 50 } })
    expect(next.speed).toBe(100)
    expect(next.overallProgress).toBe(50)
  })

  it('FILE_PROGRESS updates one filename without touching others', () => {
    const state = { ...initialTransfer, progress: { a: 40 } }
    const next = transferReducer(state, { type: 'FILE_PROGRESS', name: 'b', value: 80 })
    expect(next.progress).toEqual({ a: 40, b: 80 })
  })

  it('COMPLETE_FILE marks completed, bumps progress to 100, drops pending entry', () => {
    const state = {
      ...initialTransfer,
      pendingFiles: { 3: true, 7: true },
      progress: { 'doc.pdf': 50 },
    }
    const next = transferReducer(state, { type: 'COMPLETE_FILE', index: 3, name: 'doc.pdf' })
    expect(next.completedFiles[3]).toBe(true)
    expect(next.pendingFiles[3]).toBeUndefined()
    expect(next.pendingFiles[7]).toBe(true)
    expect(next.progress['doc.pdf']).toBe(100)
  })

  it('CANCEL_FILE drops pending, paused, and progress by name', () => {
    const state = {
      ...initialTransfer,
      pendingFiles: { 0: true, 1: true },
      pausedFiles: { 0: true },
      progress: { 'x.bin': 30, 'y.bin': 60 },
    }
    const next = transferReducer(state, { type: 'CANCEL_FILE', index: 0, name: 'x.bin' })
    expect(next.pendingFiles).toEqual({ 1: true })
    expect(next.pausedFiles).toEqual({})
    expect(next.progress).toEqual({ 'y.bin': 60 })
  })

  it('CANCEL_FILE without a name leaves progress alone', () => {
    const state = {
      ...initialTransfer,
      pendingFiles: { 5: true },
      progress: { 'kept.bin': 30 },
    }
    const next = transferReducer(state, { type: 'CANCEL_FILE', index: 5 })
    expect(next.pendingFiles).toEqual({})
    expect(next.progress).toEqual({ 'kept.bin': 30 })
  })

  it('ADD_PENDING + REMOVE_PENDING round-trip', () => {
    const added = transferReducer(initialTransfer, { type: 'ADD_PENDING', index: 2 })
    expect(added.pendingFiles).toEqual({ 2: true })
    const removed = transferReducer(added, { type: 'REMOVE_PENDING', index: 2 })
    expect(removed.pendingFiles).toEqual({})
  })

  it('PAUSE_FILE / RESUME_FILE toggle the pausedFiles set', () => {
    const paused = transferReducer(initialTransfer, { type: 'PAUSE_FILE', index: 1 })
    expect(paused.pausedFiles).toEqual({ 1: true })
    const resumed = transferReducer(paused, { type: 'RESUME_FILE', index: 1 })
    expect(resumed.pausedFiles).toEqual({})
  })

  it('RESET returns initial', () => {
    const state = {
      ...initialTransfer,
      speed: 10,
      pendingFiles: { 0: true },
      completedFiles: { 1: true },
    }
    const next = transferReducer(state, { type: 'RESET' })
    expect(next).toEqual(initialTransfer)
  })

  it('unknown action returns same reference', () => {
    const unknown = { type: 'NOPE' } as unknown as Parameters<typeof transferReducer>[1]
    const next = transferReducer(initialTransfer, unknown)
    expect(next).toBe(initialTransfer)
  })
})

describe('receiver connectionReducer', () => {
  it('SET merges partial payload', () => {
    const next = connectionReducer(initialConnection, {
      type: 'SET',
      payload: { onlineCount: 3, passwordRequired: true },
    })
    expect(next.onlineCount).toBe(3)
    expect(next.passwordRequired).toBe(true)
    expect(next.retryCount).toBe(0)
  })

  it('SET_STATUS with string replaces status', () => {
    const next = connectionReducer(initialConnection, { type: 'SET_STATUS', payload: 'ready' })
    expect(next.status).toBe('ready')
  })

  it('SET_STATUS functional form reads previous', () => {
    const state = { ...initialConnection, retryCount: 2, status: 'reconnecting' }
    const next = connectionReducer(state, {
      type: 'SET_STATUS',
      payload: prev => prev === 'reconnecting' ? 'connected' : prev,
    })
    expect(next.status).toBe('connected')
  })

  it('SET_STATUS with matching status returns same ref', () => {
    const state = { ...initialConnection, status: 'ready' }
    const next = connectionReducer(state, { type: 'SET_STATUS', payload: 'ready' })
    expect(next).toBe(state)
  })

  it('RESET returns initial', () => {
    const state = { ...initialConnection, status: 'x', onlineCount: 9, passwordError: true }
    const next = connectionReducer(state, { type: 'RESET' })
    expect(next).toEqual(initialConnection)
  })
})
