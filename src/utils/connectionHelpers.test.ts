import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupHeartbeat, handleTypingMessage } from './connectionHelpers'
import type { DataConnection } from 'peerjs'
import type { Dispatch, SetStateAction } from 'react'

interface MockConn {
  send: ReturnType<typeof vi.fn>
}

describe('setupHeartbeat', () => {
  let conn: MockConn

  beforeEach(() => {
    vi.useFakeTimers()
    conn = { send: vi.fn() }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends pings at the configured interval', () => {
    const { cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead: vi.fn(), interval: 100 })
    vi.advanceTimersByTime(350)
    const pings = conn.send.mock.calls.filter((c: unknown[]) => (c[0] as { type: string })?.type === 'ping')
    expect(pings.length).toBe(3)
    cleanup()
  })

  it('calls onDead after timeout with no markAlive', () => {
    const onDead = vi.fn()
    const { cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead, interval: 100, timeout: 500 })
    vi.advanceTimersByTime(600)
    expect(onDead).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does not call onDead if markAlive is called within timeout', () => {
    const onDead = vi.fn()
    const { markAlive, cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead, interval: 100, timeout: 500 })
    vi.advanceTimersByTime(400)
    markAlive()
    vi.advanceTimersByTime(400)
    markAlive()
    vi.advanceTimersByTime(400)
    expect(onDead).not.toHaveBeenCalled()
    cleanup()
  })

  it('cleanup stops all timers', () => {
    const onDead = vi.fn()
    const { cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead, interval: 100, timeout: 500 })
    cleanup()
    vi.advanceTimersByTime(10000)
    expect(onDead).not.toHaveBeenCalled()
    expect(conn.send).not.toHaveBeenCalled()
  })

  it('getLastSeen returns the time of last markAlive', () => {
    const { markAlive, getLastSeen, cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead: vi.fn() })
    const t1: number = getLastSeen()
    vi.advanceTimersByTime(1000)
    markAlive()
    expect(getLastSeen()).toBeGreaterThan(t1)
    cleanup()
  })

  it('swallows errors from conn.send', () => {
    conn.send = vi.fn(() => { throw new Error('dead') })
    const { cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead: vi.fn(), interval: 100 })
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    cleanup()
  })
})

describe('handleTypingMessage', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('adds the user to the typing list', () => {
    const setTyping = vi.fn((fn: (prev: string[]) => string[]) => fn([]))
    handleTypingMessage('Alice', setTyping as unknown as Dispatch<SetStateAction<string[]>>, {})
    expect(setTyping).toHaveBeenCalled()
    const result: string[] = setTyping.mock.calls[0][0]([])
    expect(result).toEqual(['Alice'])
  })

  it('does not duplicate the user', () => {
    const setTyping = vi.fn((fn: (prev: string[]) => string[]) => fn(['Alice']))
    handleTypingMessage('Alice', setTyping as unknown as Dispatch<SetStateAction<string[]>>, {})
    const result: string[] = setTyping.mock.calls[0][0](['Alice'])
    expect(result).toEqual(['Alice'])
  })

  it('removes the user after the duration', () => {
    const setTyping = vi.fn()
    const timeouts: Record<string, ReturnType<typeof setTimeout>> = {}
    handleTypingMessage('Bob', setTyping as unknown as Dispatch<SetStateAction<string[]>>, timeouts, 500)
    vi.advanceTimersByTime(600)
    // Second call is the removal callback
    expect(setTyping).toHaveBeenCalledTimes(2)
    const removeFn = setTyping.mock.calls[1][0] as (prev: string[]) => string[]
    expect(removeFn(['Bob', 'Alice'])).toEqual(['Alice'])
  })

  it('resets the timer on repeated typing', () => {
    const setTyping = vi.fn()
    const timeouts: Record<string, ReturnType<typeof setTimeout>> = {}
    handleTypingMessage('Eve', setTyping as unknown as Dispatch<SetStateAction<string[]>>, timeouts, 500)
    vi.advanceTimersByTime(300)
    handleTypingMessage('Eve', setTyping as unknown as Dispatch<SetStateAction<string[]>>, timeouts, 500)
    vi.advanceTimersByTime(300)
    // Should still be typing (timer was reset)
    expect(setTyping).toHaveBeenCalledTimes(2) // two add calls, no remove yet
    vi.advanceTimersByTime(300)
    expect(setTyping).toHaveBeenCalledTimes(3) // now the remove fires
  })

  it('handles empty string nickname gracefully', () => {
    const setTyping = vi.fn((fn: (prev: string[]) => string[]) => fn([]))
    expect(() =>
      handleTypingMessage('', setTyping as unknown as Dispatch<SetStateAction<string[]>>, {})
    ).not.toThrow()
    expect(setTyping).toHaveBeenCalled()
    const result: string[] = setTyping.mock.calls[0][0]([])
    expect(result).toEqual([''])
  })

  it('rapid calls for the same user do not duplicate and reset the timer each time', () => {
    const setTyping = vi.fn()
    const timeouts: Record<string, ReturnType<typeof setTimeout>> = {}

    // Fire 5 rapid calls
    for (let i = 0; i < 5; i++) {
      handleTypingMessage('Charlie', setTyping as unknown as Dispatch<SetStateAction<string[]>>, timeouts, 500)
    }
    // Each call adds once — 5 add setTyping calls, no removals yet
    expect(setTyping).toHaveBeenCalledTimes(5)

    // Advance past only one timeout duration — only one removal should fire (the last timer)
    vi.advanceTimersByTime(600)
    expect(setTyping).toHaveBeenCalledTimes(6) // 5 adds + 1 remove

    // Verify the removal callback filters correctly
    const removeFn = setTyping.mock.calls[5][0] as (prev: string[]) => string[]
    expect(removeFn(['Charlie', 'Dave'])).toEqual(['Dave'])
  })
})

describe('setupHeartbeat additional edge cases', () => {
  let conn: { send: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    conn = { send: vi.fn() }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calling cleanup() twice does not throw', () => {
    const { cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead: vi.fn(), interval: 100 })
    expect(() => {
      cleanup()
      cleanup()
    }).not.toThrow()
  })

  it('getLastSeen returns a non-zero timestamp before any markAlive call', () => {
    const { getLastSeen, cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead: vi.fn() })
    // lastSeen is initialised to Date.now() at construction time — must be > 0
    expect(getLastSeen()).toBeGreaterThan(0)
    cleanup()
  })

  it('markAlive called after cleanup does not throw', () => {
    const { markAlive, cleanup } = setupHeartbeat(conn as unknown as DataConnection, { onDead: vi.fn(), interval: 100 })
    cleanup()
    expect(() => markAlive()).not.toThrow()
  })
})
