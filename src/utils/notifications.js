/**
 * Browser notifications and sound effects for The Manifest
 */

// Check if notifications are supported
export function isNotificationSupported() {
  return 'Notification' in window
}

// Request notification permission
export async function requestNotificationPermission() {
  if (!isNotificationSupported()) return false
  
  if (Notification.permission === 'granted') return true
  if (Notification.permission === 'denied') return false
  
  const result = await Notification.requestPermission()
  return result === 'granted'
}

// Check if we can send notifications
export function canNotify() {
  return isNotificationSupported() && Notification.permission === 'granted'
}

// Send a browser notification
export function sendNotification(title, options = {}) {
  if (!canNotify()) return null
  if (document.visibilityState === 'visible') return null // Don't notify if tab is active
  
  try {
    const notification = new Notification(title, {
      icon: '/favicon.ico',
      badge: '/favicon.ico',
      tag: options.tag || 'manifest-notification',
      renotify: options.renotify || false,
      silent: options.silent || false,
      ...options
    })
    
    notification.onclick = () => {
      window.focus()
      notification.close()
      options.onClick?.()
    }
    
    // Auto-close after 5 seconds
    setTimeout(() => notification.close(), 5000)
    
    return notification
  } catch {
    return null
  }
}

// Notification types
export function notifyNewMessage(from, text) {
  const body = text.length > 50 ? text.slice(0, 50) + '...' : text
  return sendNotification(`New message from ${from}`, {
    body,
    tag: 'manifest-chat',
    renotify: true
  })
}

export function notifyTransferComplete(fileName, fileCount) {
  const body = fileCount > 1 
    ? `${fileCount} files transferred successfully`
    : `${fileName} transferred successfully`
  return sendNotification('Transfer Complete', {
    body,
    tag: 'manifest-transfer'
  })
}

export function notifyRecipientConnected(name) {
  return sendNotification('Recipient Connected', {
    body: `${name} has joined the portal`,
    tag: 'manifest-connection'
  })
}

export function notifyRecipientDisconnected(name) {
  return sendNotification('Recipient Disconnected', {
    body: `${name} has left the portal`,
    tag: 'manifest-connection'
  })
}

// =========================================
// Sound Effects
// =========================================

// Audio context for generating sounds
let audioContext = null

function getAudioContext() {
  if (!audioContext) {
    try {
      audioContext = new (window.AudioContext || window.webkitAudioContext)()
    } catch {
      return null
    }
  }
  return audioContext
}

// Play a simple tone
function playTone(frequency, duration, volume = 0.1, type = 'sine') {
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
  } catch {
    // Audio failed, ignore
  }
}

// Play a two-tone notification
function playTwoTone(freq1, freq2, duration = 0.15, gap = 0.08, volume = 0.08) {
  const ctx = getAudioContext()
  if (!ctx) return
  
  playTone(freq1, duration, volume)
  setTimeout(() => playTone(freq2, duration, volume), (duration + gap) * 1000)
}

// Sound effect presets
export const sounds = {
  // New message received - two ascending tones
  messageReceived: () => playTwoTone(440, 587, 0.1, 0.05, 0.06),
  
  // Message sent - subtle click
  messageSent: () => playTone(800, 0.05, 0.03, 'square'),
  
  // Transfer complete - pleasant ascending arpeggio
  transferComplete: () => {
    const ctx = getAudioContext()
    if (!ctx) return
    playTone(523, 0.15, 0.06) // C5
    setTimeout(() => playTone(659, 0.15, 0.06), 100) // E5
    setTimeout(() => playTone(784, 0.2, 0.06), 200) // G5
  },
  
  // Recipient connected - warm tone
  recipientConnected: () => playTwoTone(392, 523, 0.12, 0.06, 0.05),
  
  // Recipient disconnected - descending tone
  recipientDisconnected: () => playTwoTone(523, 392, 0.12, 0.06, 0.04),
  
  // Error - low buzz
  error: () => playTone(200, 0.2, 0.05, 'sawtooth'),
  
  // Click - subtle feedback
  click: () => playTone(1000, 0.02, 0.02, 'square'),
}

// =========================================
// Notification + Sound combined helpers
// =========================================

export function alertNewMessage(from, text, playSound = true) {
  if (playSound) sounds.messageReceived()
  return notifyNewMessage(from, text)
}

export function alertTransferComplete(fileName, fileCount = 1, playSound = true) {
  if (playSound) sounds.transferComplete()
  return notifyTransferComplete(fileName, fileCount)
}

export function alertRecipientConnected(name, playSound = true) {
  if (playSound) sounds.recipientConnected()
  return notifyRecipientConnected(name)
}

export function alertRecipientDisconnected(name, playSound = true) {
  if (playSound) sounds.recipientDisconnected()
  return notifyRecipientDisconnected(name)
}
