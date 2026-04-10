import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { setupHeartbeat, handleTypingMessage } from './connectionHelpers'

describe('setupHeartbeat', () => {
  let conn

  beforeEach(() => {
    vi.useFakeTimers()
    conn = { send: vi.fn() }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends pings at the configured interval', () => {
    const { cleanup } = setupHeartbeat(conn, { onDead: vi.fn(), interval: 100 })
    vi.advanceTimersByTime(350)
    const pings = conn.send.mock.calls.filter(c => c[0]?.type === 'ping')
    expect(pings.length).toBe(3)
    cleanup()
  })

  it('calls onDead after timeout with no markAlive', () => {
    const onDead = vi.fn()
    const { cleanup } = setupHeartbeat(conn, { onDead, interval: 100, timeout: 500 })
    vi.advanceTimersByTime(600)
    expect(onDead).toHaveBeenCalledTimes(1)
    cleanup()
  })

  it('does not call onDead if markAlive is called within timeout', () => {
    const onDead = vi.fn()
    const { markAlive, cleanup } = setupHeartbeat(conn, { onDead, interval: 100, timeout: 500 })
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
    const { cleanup } = setupHeartbeat(conn, { onDead, interval: 100, timeout: 500 })
    cleanup()
    vi.advanceTimersByTime(10000)
    expect(onDead).not.toHaveBeenCalled()
    expect(conn.send).not.toHaveBeenCalled()
  })

  it('getLastSeen returns the time of last markAlive', () => {
    const { markAlive, getLastSeen, cleanup } = setupHeartbeat(conn, { onDead: vi.fn() })
    const t1 = getLastSeen()
    vi.advanceTimersByTime(1000)
    markAlive()
    expect(getLastSeen()).toBeGreaterThan(t1)
    cleanup()
  })

  it('swallows errors from conn.send', () => {
    conn.send = vi.fn(() => { throw new Error('dead') })
    const { cleanup } = setupHeartbeat(conn, { onDead: vi.fn(), interval: 100 })
    expect(() => vi.advanceTimersByTime(200)).not.toThrow()
    cleanup()
  })
})

describe('handleTypingMessage', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('adds the user to the typing list', () => {
    const setTyping = vi.fn(fn => fn([]))
    handleTypingMessage('Alice', setTyping, {})
    expect(setTyping).toHaveBeenCalled()
    const result = setTyping.mock.calls[0][0]([])
    expect(result).toEqual(['Alice'])
  })

  it('does not duplicate the user', () => {
    const setTyping = vi.fn(fn => fn(['Alice']))
    handleTypingMessage('Alice', setTyping, {})
    const result = setTyping.mock.calls[0][0](['Alice'])
    expect(result).toEqual(['Alice'])
  })

  it('removes the user after the duration', () => {
    const setTyping = vi.fn()
    const timeouts = {}
    handleTypingMessage('Bob', setTyping, timeouts, 500)
    vi.advanceTimersByTime(600)
    // Second call is the removal callback
    expect(setTyping).toHaveBeenCalledTimes(2)
    const removeFn = setTyping.mock.calls[1][0]
    expect(removeFn(['Bob', 'Alice'])).toEqual(['Alice'])
  })

  it('resets the timer on repeated typing', () => {
    const setTyping = vi.fn()
    const timeouts = {}
    handleTypingMessage('Eve', setTyping, timeouts, 500)
    vi.advanceTimersByTime(300)
    handleTypingMessage('Eve', setTyping, timeouts, 500)
    vi.advanceTimersByTime(300)
    // Should still be typing (timer was reset)
    expect(setTyping).toHaveBeenCalledTimes(2) // two add calls, no remove yet
    vi.advanceTimersByTime(300)
    expect(setTyping).toHaveBeenCalledTimes(3) // now the remove fires
  })
})
