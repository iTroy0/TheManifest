import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// notifications.ts uses `'Notification' in window` and `document.visibilityState`
// at call time (not module load time), so we stub window/document in each group.

// ── Type helpers ──────────────────────────────────────────────────────────────

type NotificationPermission = 'granted' | 'denied' | 'default'

interface MockNotificationInstance {
  onclick: (() => void) | null
  close: ReturnType<typeof vi.fn>
}

interface MockNotificationConstructor {
  new (title: string, options?: object): MockNotificationInstance
  permission: NotificationPermission
  requestPermission: ReturnType<typeof vi.fn>
}

function makeMockNotification(
  permission: NotificationPermission = 'granted'
): MockNotificationConstructor {
  const MockNotification = vi.fn(function (
    this: MockNotificationInstance,
    _title: string,
    _options?: object
  ) {
    this.onclick = null
    this.close = vi.fn()
  }) as unknown as MockNotificationConstructor

  MockNotification.permission = permission
  MockNotification.requestPermission = vi.fn()
  return MockNotification
}

function stubWindowWithNotification(permission: NotificationPermission = 'granted') {
  const mock = makeMockNotification(permission)
  vi.stubGlobal('window', { Notification: mock })
  vi.stubGlobal('Notification', mock)
  return mock
}

function stubWindowWithoutNotification() {
  vi.stubGlobal('window', {})
  vi.stubGlobal('Notification', undefined)
}

// ── isNotificationSupported ───────────────────────────────────────────────────

describe('isNotificationSupported', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns true when Notification exists on window', async () => {
    stubWindowWithNotification('granted')
    const { isNotificationSupported } = await import('./notifications')
    expect(isNotificationSupported()).toBe(true)
  })

  it('returns false when Notification does not exist on window', async () => {
    vi.resetModules()
    stubWindowWithoutNotification()
    const { isNotificationSupported } = await import('./notifications')
    expect(isNotificationSupported()).toBe(false)
  })
})

// ── canNotify ─────────────────────────────────────────────────────────────────

describe('canNotify', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns true when Notification is supported and permission is granted', async () => {
    stubWindowWithNotification('granted')
    const { canNotify } = await import('./notifications')
    expect(canNotify()).toBe(true)
  })

  it('returns false when Notification is supported but permission is denied', async () => {
    vi.resetModules()
    stubWindowWithNotification('denied')
    const { canNotify } = await import('./notifications')
    expect(canNotify()).toBe(false)
  })

  it('returns false when Notification is supported but permission is default', async () => {
    vi.resetModules()
    stubWindowWithNotification('default')
    const { canNotify } = await import('./notifications')
    expect(canNotify()).toBe(false)
  })

  it('returns false when Notification is not supported', async () => {
    vi.resetModules()
    stubWindowWithoutNotification()
    const { canNotify } = await import('./notifications')
    expect(canNotify()).toBe(false)
  })
})

// ── requestNotificationPermission ─────────────────────────────────────────────

describe('requestNotificationPermission', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns true immediately when permission is already granted', async () => {
    stubWindowWithNotification('granted')
    const { requestNotificationPermission } = await import('./notifications')
    const result = await requestNotificationPermission()
    expect(result).toBe(true)
  })

  it('returns false immediately when permission is already denied', async () => {
    vi.resetModules()
    stubWindowWithNotification('denied')
    const { requestNotificationPermission } = await import('./notifications')
    const result = await requestNotificationPermission()
    expect(result).toBe(false)
  })

  it('returns false when Notification is not supported', async () => {
    vi.resetModules()
    stubWindowWithoutNotification()
    const { requestNotificationPermission } = await import('./notifications')
    const result = await requestNotificationPermission()
    expect(result).toBe(false)
  })

  it('prompts and returns true when permission transitions from default to granted', async () => {
    vi.resetModules()
    const mock = stubWindowWithNotification('default')
    mock.requestPermission = vi.fn().mockResolvedValue('granted')
    const { requestNotificationPermission } = await import('./notifications')
    const result = await requestNotificationPermission()
    expect(mock.requestPermission).toHaveBeenCalledOnce()
    expect(result).toBe(true)
  })

  it('prompts and returns false when permission transitions from default to denied', async () => {
    vi.resetModules()
    const mock = stubWindowWithNotification('default')
    mock.requestPermission = vi.fn().mockResolvedValue('denied')
    const { requestNotificationPermission } = await import('./notifications')
    const result = await requestNotificationPermission()
    expect(result).toBe(false)
  })
})

// ── alertNewMessage ───────────────────────────────────────────────────────────

describe('alertNewMessage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    vi.useRealTimers()
  })

  it('creates a Notification when document is hidden and permission is granted', async () => {
    vi.useFakeTimers()
    const mock = stubWindowWithNotification('granted')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const { alertNewMessage } = await import('./notifications')
    alertNewMessage('Alice', 'Hello!', false)
    expect(mock).toHaveBeenCalledOnce()
  })

  it('does not create a Notification when document is visible', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const mock = stubWindowWithNotification('granted')
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const { alertNewMessage } = await import('./notifications')
    const result = alertNewMessage('Alice', 'Hello!', false)
    expect(result).toBeNull()
    expect(mock).not.toHaveBeenCalled()
  })

  it('truncates message body to 50 characters with ellipsis when text is longer than 50 chars', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const mock = stubWindowWithNotification('granted')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const { alertNewMessage } = await import('./notifications')
    const longText = 'a'.repeat(60)
    alertNewMessage('Alice', longText, false)
    const callArgs = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = callArgs[1] as { body: string }
    expect(options.body).toBe('a'.repeat(50) + '...')
  })

  it('does not truncate message body when text is 50 characters or fewer', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const mock = stubWindowWithNotification('granted')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const { alertNewMessage } = await import('./notifications')
    const shortText = 'Short message'
    alertNewMessage('Alice', shortText, false)
    const callArgs = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    const options = callArgs[1] as { body: string }
    expect(options.body).toBe('Short message')
  })

  it('includes the sender name in the notification title', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    const mock = stubWindowWithNotification('granted')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const { alertNewMessage } = await import('./notifications')
    alertNewMessage('Bob', 'Hi there', false)
    const callArgs = (mock as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(callArgs[0]).toBe('New message from Bob')
  })

  it('returns null when Notification is not supported', async () => {
    vi.resetModules()
    stubWindowWithoutNotification()
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const { alertNewMessage } = await import('./notifications')
    const result = alertNewMessage('Alice', 'Hi', false)
    expect(result).toBeNull()
  })

  it('returns null when permission is not granted', async () => {
    vi.resetModules()
    stubWindowWithNotification('denied')
    vi.stubGlobal('document', { visibilityState: 'hidden' })
    const { alertNewMessage } = await import('./notifications')
    const result = alertNewMessage('Alice', 'Hi', false)
    expect(result).toBeNull()
  })
})

// ── sounds ────────────────────────────────────────────────────────────────────

describe('sounds', () => {
  function makeAudioContextMock() {
    const gainNode = {
      connect: vi.fn(),
      gain: {
        setValueAtTime: vi.fn(),
        linearRampToValueAtTime: vi.fn(),
      },
    }
    const oscillator = {
      connect: vi.fn(),
      type: 'sine' as OscillatorType,
      frequency: { setValueAtTime: vi.fn() },
      start: vi.fn(),
      stop: vi.fn(),
    }
    // Must use a class (not an arrow function) so `new AudioContext()` works
    // without vitest's "did not use function or class" warning.
    return class MockAudioContext {
      createOscillator = vi.fn().mockReturnValue(oscillator)
      createGain = vi.fn().mockReturnValue(gainNode)
      destination = {}
      currentTime = 0
    }
  }

  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('sounds.messageReceived does not throw when AudioContext is available', async () => {
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.messageReceived()).not.toThrow()
  })

  it('sounds.messageSent does not throw when AudioContext is available', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.messageSent()).not.toThrow()
  })

  it('sounds.transferComplete does not throw when AudioContext is available', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.transferComplete()).not.toThrow()
  })

  it('sounds.recipientConnected does not throw when AudioContext is available', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.recipientConnected()).not.toThrow()
  })

  it('sounds.recipientDisconnected does not throw when AudioContext is available', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.recipientDisconnected()).not.toThrow()
  })

  it('sounds.error does not throw when AudioContext is available', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.error()).not.toThrow()
  })

  it('sounds.click does not throw when AudioContext is available', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(() => sounds.click()).not.toThrow()
  })

  it('sounds.messageReceived does not throw when AudioContext is unavailable', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: undefined, webkitAudioContext: undefined })
    vi.stubGlobal('AudioContext', undefined)
    const { sounds } = await import('./notifications')
    expect(() => sounds.messageReceived()).not.toThrow()
  })

  it('sounds.messageSent does not throw when AudioContext constructor throws', async () => {
    vi.resetModules()
    class ThrowingAudioContext {
      constructor() { throw new Error('not allowed') }
    }
    vi.stubGlobal('window', { AudioContext: ThrowingAudioContext })
    vi.stubGlobal('AudioContext', ThrowingAudioContext)
    const { sounds } = await import('./notifications')
    expect(() => sounds.messageSent()).not.toThrow()
  })

  it('sounds object exposes all expected sound methods', async () => {
    vi.resetModules()
    vi.stubGlobal('window', { AudioContext: makeAudioContextMock() })
    vi.stubGlobal('AudioContext', makeAudioContextMock())
    const { sounds } = await import('./notifications')
    expect(typeof sounds.messageReceived).toBe('function')
    expect(typeof sounds.messageSent).toBe('function')
    expect(typeof sounds.transferComplete).toBe('function')
    expect(typeof sounds.recipientConnected).toBe('function')
    expect(typeof sounds.recipientDisconnected).toBe('function')
    expect(typeof sounds.error).toBe('function')
    expect(typeof sounds.click).toBe('function')
  })
})
