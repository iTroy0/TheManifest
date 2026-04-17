export function isNotificationSupported(): boolean {
  return 'Notification' in window
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNotificationSupported()) return false
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  const result = await Notification.requestPermission()
  return result === 'granted'
}

export function canNotify(): boolean {
  return isNotificationSupported() && Notification.permission === 'granted'
}

interface NotificationOptions {
  tag?: string
  renotify?: boolean
  silent?: boolean
  body?: string
  onClick?: () => void
}

function sendNotification(title: string, options: NotificationOptions = {}): Notification | null {
  if (!canNotify()) return null
  if (document.visibilityState === 'visible') return null

  try {
    const notification = new Notification(title, {
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: options.tag || 'manifest-notification',
      renotify: options.renotify || false,
      silent: options.silent || false,
      ...options
    })
    notification.onclick = () => { window.focus(); notification.close(); options.onClick?.() }
    setTimeout(() => notification.close(), 5000)
    return notification
  } catch {
    return null
  }
}

// ── Sound Effects ────────────────────────────────────────────────────────

let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || (window as typeof window & { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    } catch {
      return null
    }
  }
  return audioContext
}

function playTone(frequency: number, duration: number, volume = 0.1, type: OscillatorType = 'sine'): void {
  const ctx = getAudioContext()
  if (!ctx) return
  try {
    const oscillator = ctx.createOscillator()
    const gainNode = ctx.createGain()
    oscillator.connect(gainNode)
    gainNode.connect(ctx.destination)
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, ctx.currentTime)
    gainNode.gain.setValueAtTime(0, ctx.currentTime)
    gainNode.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.01)
    gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + duration)
    oscillator.start(ctx.currentTime)
    oscillator.stop(ctx.currentTime + duration)
  } catch {}
}

function playTwoTone(freq1: number, freq2: number, duration = 0.15, gap = 0.08, volume = 0.08): void {
  const ctx = getAudioContext()
  if (!ctx) return
  playTone(freq1, duration, volume)
  setTimeout(() => playTone(freq2, duration, volume), (duration + gap) * 1000)
}

export const sounds = {
  messageReceived: () => playTwoTone(440, 587, 0.1, 0.05, 0.06),
  messageSent: () => playTone(800, 0.05, 0.03, 'square'),
  transferComplete: () => {
    const ctx = getAudioContext()
    if (!ctx) return
    playTone(523, 0.15, 0.06)
    setTimeout(() => playTone(659, 0.15, 0.06), 100)
    setTimeout(() => playTone(784, 0.2, 0.06), 200)
  },
  recipientConnected: () => playTwoTone(392, 523, 0.12, 0.06, 0.05),
  recipientDisconnected: () => playTwoTone(523, 392, 0.12, 0.06, 0.04),
  error: () => playTone(200, 0.2, 0.05, 'sawtooth'),
  click: () => playTone(1000, 0.02, 0.02, 'square'),
}

// ── Combined notification + sound helpers ────────────────────────────────

export function alertNewMessage(from: string, text: string, playSound = true): Notification | null {
  if (playSound) sounds.messageReceived()
  const body = text.length > 50 ? text.slice(0, 50) + '...' : text
  return sendNotification(`New message from ${from}`, { body, tag: 'manifest-chat', renotify: true })
}
