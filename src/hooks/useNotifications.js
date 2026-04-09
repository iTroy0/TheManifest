import { useState, useEffect, useCallback, useRef } from 'react'
import {
  isNotificationSupported,
  requestNotificationPermission,
  canNotify,
  alertNewMessage,
  alertTransferComplete,
  alertRecipientConnected,
  alertRecipientDisconnected,
  sounds
} from '../utils/notifications'

/**
 * React hook for managing notifications and sound effects
 */
export function useNotifications() {
  const [permission, setPermission] = useState(() => {
    if (!isNotificationSupported()) return 'unsupported'
    return Notification.permission
  })
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  
  // Track previous values to detect changes
  const prevMessagesRef = useRef(null)
  const prevRecipientsRef = useRef(0)
  
  // Request permission
  const requestPermission = useCallback(async () => {
    const granted = await requestNotificationPermission()
    setPermission(granted ? 'granted' : 'denied')
    return granted
  }, [])
  
  // Toggle sound
  const toggleSound = useCallback(() => {
    setSoundEnabled(prev => !prev)
  }, [])
  
  // Toggle notifications
  const toggleNotifications = useCallback(() => {
    setNotificationsEnabled(prev => !prev)
  }, [])
  
  // Notification helpers
  const notifyMessage = useCallback((from, text) => {
    if (!notificationsEnabled && !soundEnabled) return
    alertNewMessage(from, text, soundEnabled)
  }, [soundEnabled, notificationsEnabled])
  
  const notifyTransfer = useCallback((fileName, fileCount = 1) => {
    if (!notificationsEnabled && !soundEnabled) return
    alertTransferComplete(fileName, fileCount, soundEnabled)
  }, [soundEnabled, notificationsEnabled])
  
  const notifyConnect = useCallback((name) => {
    if (!notificationsEnabled && !soundEnabled) return
    alertRecipientConnected(name, soundEnabled)
  }, [soundEnabled, notificationsEnabled])
  
  const notifyDisconnect = useCallback((name) => {
    if (!notificationsEnabled && !soundEnabled) return
    alertRecipientDisconnected(name, soundEnabled)
  }, [soundEnabled, notificationsEnabled])
  
  // Sound-only helpers
  const playSendSound = useCallback(() => {
    if (soundEnabled) sounds.messageSent()
  }, [soundEnabled])
  
  const playClickSound = useCallback(() => {
    if (soundEnabled) sounds.click()
  }, [soundEnabled])
  
  const playErrorSound = useCallback(() => {
    if (soundEnabled) sounds.error()
  }, [soundEnabled])
  
  // Watch for new messages (pass messages array)
  const watchMessages = useCallback((messages, myName = 'You') => {
    if (prevMessagesRef.current === null) {
      prevMessagesRef.current = messages
      return
    }
    
    if (messages.length > prevMessagesRef.current.length) {
      const newMessages = messages.slice(prevMessagesRef.current.length)
      for (const msg of newMessages) {
        if (msg.from !== myName && msg.from !== 'system') {
          notifyMessage(msg.from, msg.text)
        }
      }
    }
    
    prevMessagesRef.current = messages
  }, [notifyMessage])
  
  // Watch for recipient changes
  const watchRecipients = useCallback((count, nameOrMsg) => {
    if (prevRecipientsRef.current === null) {
      prevRecipientsRef.current = count
      return
    }
    
    if (count > prevRecipientsRef.current) {
      notifyConnect(nameOrMsg || 'Someone')
    } else if (count < prevRecipientsRef.current) {
      notifyDisconnect(nameOrMsg || 'Someone')
    }
    
    prevRecipientsRef.current = count
  }, [notifyConnect, notifyDisconnect])
  
  return {
    // State
    permission,
    isSupported: permission !== 'unsupported',
    canNotify: permission === 'granted' && notificationsEnabled,
    soundEnabled,
    notificationsEnabled,
    
    // Actions
    requestPermission,
    toggleSound,
    toggleNotifications,
    
    // Notification helpers
    notifyMessage,
    notifyTransfer,
    notifyConnect,
    notifyDisconnect,
    
    // Sound helpers
    playSendSound,
    playClickSound,
    playErrorSound,
    
    // Watchers
    watchMessages,
    watchRecipients,
    
    // Raw sounds
    sounds
  }
}
