import React, { useState, useReducer, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, Send, ChevronDown, Users, Check, ImagePlus, X, Reply, ArrowDown, Smile, Volume2, VolumeX, Bell, BellOff, Trash2, Maximize2, Minimize2, MoreVertical, ExternalLink, Mic } from 'lucide-react'
import { sounds, canNotify, requestNotificationPermission, alertNewMessage } from '../utils/notifications'
import Linkify from './chat/Linkify'
import VoicePlayer from './chat/VoicePlayer'
import { ChatMessage } from '../types'

const EMOJIS = ['👍', '❤️', '😂', '😮', '🔥', '👎', '🎉', '💯', '👀', '🙏', '💀', '✨']

const TYPING_DELAY_0 = { animationDelay: '0ms' }
const TYPING_DELAY_1 = { animationDelay: '150ms' }
const TYPING_DELAY_2 = { animationDelay: '300ms' }

function TypingDots() {
  return (
    <span className="inline-flex gap-0.5 ml-1">
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={TYPING_DELAY_0} />
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={TYPING_DELAY_1} />
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={TYPING_DELAY_2} />
    </span>
  )
}

// ── panelReducer ─────────────────────────────────────────────────────────────

interface PopoutPos {
  x: number
  y: number
}

interface PopoutSize {
  w: number
  h: number
}

interface MenuPos {
  top: number
  right: number
}

interface PanelState {
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

type PanelAction =
  | { type: 'SET'; payload: Partial<PanelState> }
  | { type: 'TOGGLE_OPEN' }
  | { type: 'TOGGLE_MENU' }
  | { type: 'INCREMENT_UNREAD'; count: number }
  | { type: 'RESET_POPOUT' }

const initialPanel: PanelState = {
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

function panelReducer(state: PanelState, action: PanelAction): PanelState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'TOGGLE_OPEN': return { ...state, open: !state.open }
    case 'TOGGLE_MENU': return { ...state, showMenu: !state.showMenu }
    case 'INCREMENT_UNREAD': return { ...state, unread: state.unread + action.count }
    case 'RESET_POPOUT': return { ...state, isPopout: false, popoutPos: null, popoutSize: { w: 384, h: 600 } }
    default: return state
  }
}

// ── interactionReducer ───────────────────────────────────────────────────────

interface ImagePreview {
  url: string
  bytes: Uint8Array
  mime: string
  duration?: number
}

interface ViewImage {
  url?: string
  mime?: string
}

interface ReplyTo {
  text: string
  from: string
  time: number
}

interface InteractionState {
  replyTo: ReplyTo | null
  reactingIdx: number | null
  activeMsg: number | null
  imagePreview: ImagePreview | null
  viewImage: ViewImage | null
  isDragOver: boolean
  dropError: string | null
}

type InteractionAction =
  | { type: 'SET'; payload: Partial<InteractionState> }
  | { type: 'CLEAR_SEND' }
  | { type: 'TOGGLE_MSG'; index: number }

const initialInteraction: InteractionState = {
  replyTo: null,
  reactingIdx: null,
  activeMsg: null,
  imagePreview: null,
  viewImage: null,
  isDragOver: false,
  dropError: null,
}

function interactionReducer(state: InteractionState, action: InteractionAction): InteractionState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'CLEAR_SEND': return { ...state, imagePreview: null, replyTo: null }
    case 'TOGGLE_MSG': return { ...state, activeMsg: state.activeMsg === action.index ? null : action.index, reactingIdx: null }
    default: return state
  }
}

// ── DragRef shape ────────────────────────────────────────────────────────────

interface DragRef {
  startX: number
  startY: number
  origX: number
  origY: number
}

// ── ChatPanel props ──────────────────────────────────────────────────────────

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (text: string, image?: ImagePreview | { bytes: Uint8Array; mime: string } | string, replyTo?: ReplyTo) => void
  onClearMessages?: (() => void) | null
  disabled?: boolean
  nickname?: string
  onNicknameChange?: ((name: string) => void) | null
  onlineCount?: number
  onTyping?: (() => void) | null
  typingUsers?: string[]
  onReaction?: ((msgId: string, emoji: string) => void) | null
}

export default function ChatPanel({ messages, onSend, onClearMessages, disabled, nickname, onNicknameChange, onlineCount, onTyping, typingUsers, onReaction }: ChatPanelProps) {
  const [panel, dispatchPanel] = useReducer(panelReducer, initialPanel)
  const { open, unread, isFullscreen, isPopout, showMenu, showClearConfirm, showScrollBtn, isNearBottom, menuPos, popoutPos, popoutSize, viewportHeight, viewportOffset } = panel
  const [interact, dispatchInteract] = useReducer(interactionReducer, initialInteraction)
  const { replyTo, reactingIdx, activeMsg, imagePreview, viewImage, isDragOver, dropError } = interact
  const [text, setText] = useState('')
  const [editName, setEditName] = useState(nickname || '')
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [isRecording, setIsRecording] = useState(false)
  const [recordingTime, setRecordingTime] = useState(0)
  const [micError, setMicError] = useState<string | null>(null)
  const [nameSaved, setNameSaved] = useState(false)
  const recordingTimeRef = useRef(0) // ref mirror — closures read this, not stale state
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordingChunksRef = useRef<Blob[]>([])
  const chatBlobUrlsRef = useRef<string[]>([])

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const prevLen = useRef(messages.length)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const dragRef = useRef<DragRef | null>(null)
  const popoutRef = useRef<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)
  const clearConfirmRef = useRef<HTMLDivElement | null>(null)

  function createTrackedBlobUrl(blob: Blob): string {
    const url = URL.createObjectURL(blob)
    chatBlobUrlsRef.current.push(url)
    return url
  }

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      chatBlobUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    }
  }, [])

  useEffect(() => {
    if (nickname) setEditName(nickname)
  }, [nickname])

  // Fix 8: Auto-focus textarea when panel opens
  useEffect(() => {
    if (open && textInputRef.current) {
      const t = setTimeout(() => textInputRef.current?.focus(), 100)
      return () => clearTimeout(t)
    }
  }, [open])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 100
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    dispatchPanel({ type: 'SET', payload: { isNearBottom: nearBottom, showScrollBtn: !nearBottom && messages.length > 5 } })
  }, [messages.length])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !open) return
    const observer = new ResizeObserver(() => {
      if (isNearBottom) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [open, isNearBottom])

  useEffect(() => {
    if (messages.length > prevLen.current) {
      if (open && scrollRef.current && isNearBottom) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      if (!open) {
        dispatchPanel({ type: 'INCREMENT_UNREAD', count: messages.length - prevLen.current })
      }
      const newMsgs = messages.slice(prevLen.current)
      for (const msg of newMsgs) {
        if (!msg.self && msg.from !== 'system') {
          if (soundEnabled) sounds.messageReceived()
          if (notifyEnabled) alertNewMessage(msg.from, msg.text || 'Image', false)
        }
      }
    }
    prevLen.current = messages.length
  }, [messages.length, open, isNearBottom, soundEnabled, notifyEnabled, messages])

  useEffect(() => {
    if (open) dispatchPanel({ type: 'SET', payload: { unread: 0 } })
  }, [open])

  useEffect(() => {
    if (isFullscreen) {
      document.body.style.overflow = 'hidden'
      dispatchPanel({ type: 'SET', payload: { open: true } })
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isFullscreen])

  useEffect(() => {
    if (isPopout) dispatchPanel({ type: 'SET', payload: { open: true } })
  }, [isPopout])

  function clearResizeStyles() {
    const el = popoutRef.current
    if (el) { el.style.width = ''; el.style.height = '' }
  }

  useEffect(() => {
    if (!isFullscreen) return
    const vv = window.visualViewport
    if (!vv) {
      dispatchPanel({ type: 'SET', payload: { viewportHeight: '100dvh', viewportOffset: 0 } })
      return
    }

    let rafId: number | null = null

    function handleViewportChange() {
      if (rafId) cancelAnimationFrame(rafId)

      rafId = requestAnimationFrame(() => {
        dispatchPanel({ type: 'SET', payload: { viewportHeight: `${vv!.height}px`, viewportOffset: vv!.offsetTop } })

        if (scrollRef.current && isNearBottom) {
          scrollRef.current.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: 'instant' as ScrollBehavior,
          })
        }
      })
    }

    dispatchPanel({ type: 'SET', payload: { viewportHeight: `${vv.height}px`, viewportOffset: vv.offsetTop } })

    vv.addEventListener('resize', handleViewportChange)
    vv.addEventListener('scroll', handleViewportChange)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', handleViewportChange)
      vv.removeEventListener('scroll', handleViewportChange)
    }
  }, [isFullscreen, isNearBottom])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  function handleTyping(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    if (onTyping) {
      if (!typingTimer.current) onTyping()
      clearTimeout(typingTimer.current!)
      typingTimer.current = setTimeout(() => { typingTimer.current = null }, 2000)
    }
  }

  useEffect(() => {
    if (!text && textInputRef.current) {
      textInputRef.current.style.height = 'auto'
    }
  }, [text])

  useEffect(() => {
    if (!isDragOver) return
    const reset = () => dispatchInteract({ type: 'SET', payload: { isDragOver: false } })
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset) }
  }, [isDragOver])

  function handleDrop(e: React.DragEvent<HTMLFormElement>) {
    e.preventDefault()
    dispatchInteract({ type: 'SET', payload: { isDragOver: false } })
    const files = Array.from(e.dataTransfer?.files || [])
    const file = files.find(f => f.type.startsWith('image/'))
    if (file) {
      prepareImage(file).then(img => { if (img) dispatchInteract({ type: 'SET', payload: { imagePreview: img } }) }).catch(() => {})
    } else if (files.length > 0) {
      dispatchInteract({ type: 'SET', payload: { dropError: 'Only images are supported in chat' } })
      setTimeout(() => dispatchInteract({ type: 'SET', payload: { dropError: null } }), 3000)
    }
  }

  // ── Voice recording ──────────────────────────────────────────────────
  const MAX_RECORDING_SECS = 180

  function getRecordingMime(): string {
    if (typeof MediaRecorder === 'undefined') return ''
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus'
    if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm'
    if (MediaRecorder.isTypeSupported('audio/mp4')) return 'audio/mp4'
    return ''
  }

  async function startRecording() {
    const mime = getRecordingMime()
    if (!mime) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const recorder = new MediaRecorder(stream, { mimeType: mime })
      recordingChunksRef.current = []

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data)
      }

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop())
        if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
        const blob = new Blob(recordingChunksRef.current, { type: mime })
        recordingChunksRef.current = []
        if (blob.size === 0) {
          setIsRecording(false)
          setRecordingTime(0)
          return
        }
        const bytes = new Uint8Array(await blob.arrayBuffer())
        const url = createTrackedBlobUrl(blob)
        if (soundEnabled) sounds.messageSent()
        onSend('', { url, bytes, mime: mime.split(';')[0], duration: recordingTimeRef.current }, undefined)
        setIsRecording(false)
        setRecordingTime(0)
        recordingTimeRef.current = 0
      }

      recorder.start(250) // collect in 250ms chunks for smooth recording
      mediaRecorderRef.current = recorder
      setIsRecording(true)
      setRecordingTime(0)
      recordingTimerRef.current = setInterval(() => {
        setRecordingTime(t => {
          const next = t + 1
          recordingTimeRef.current = next
          if (next >= MAX_RECORDING_SECS) { stopRecording(); return t }
          return next
        })
      }, 1000)
    } catch (err) {
      console.warn('Microphone access failed:', err)
      setMicError('Microphone access denied. Check browser permissions.')
      setTimeout(() => setMicError(null), 4000)
    }
  }

  function stopRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
  }

  function cancelRecording() {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.ondataavailable = null
      mediaRecorderRef.current.onstop = () => {
        mediaRecorderRef.current?.stream?.getTracks().forEach(t => t.stop())
      }
      mediaRecorderRef.current.stop()
    }
    if (recordingTimerRef.current) { clearInterval(recordingTimerRef.current); recordingTimerRef.current = null }
    recordingChunksRef.current = []
    setIsRecording(false)
    setRecordingTime(0)
    recordingTimeRef.current = 0
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stream?.getTracks().forEach(t => t.stop())
        mediaRecorderRef.current.stop()
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current)
    }
  }, [])

  function handleSend(e: { preventDefault: () => void }) {
    e.preventDefault()
    if ((!text.trim() && !imagePreview) || disabled) return
    if (soundEnabled) sounds.messageSent()
    onSend(text.trim(), imagePreview ?? undefined, replyTo ?? undefined)
    setText('')
    dispatchInteract({ type: 'CLEAR_SEND' })
    textInputRef.current?.focus()
  }

  async function prepareImage(file: File): Promise<ImagePreview | null> {
    if (file.type === 'image/gif') {
      if (file.size > 3 * 1024 * 1024) {
        dispatchInteract({ type: 'SET', payload: { dropError: 'GIF is too large (max 3 MB)' } })
        setTimeout(() => dispatchInteract({ type: 'SET', payload: { dropError: null } }), 3000)
        return null
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const url = createTrackedBlobUrl(new Blob([bytes], { type: file.type }))
      return { url, bytes, mime: file.type }
    }
    const dataUri = await compressImage(file)
    const raw = atob(dataUri.split(',')[1])
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return { url: dataUri, bytes, mime: 'image/jpeg' }
  }

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    e.target.value = ''
    try {
      const img = await prepareImage(file)
      if (img) dispatchInteract({ type: 'SET', payload: { imagePreview: img } })
    } catch (err) {
      console.warn('Image processing failed:', err)
      setMicError('Could not process image. Try a different file.')
      setTimeout(() => setMicError(null), 4000)
    }
  }

  useEffect(() => {
    if (!open || disabled) return
    function handlePaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      prepareImage(file).then(img => { if (img) dispatchInteract({ type: 'SET', payload: { imagePreview: img } }) }).catch(() => {})
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [open, disabled])

  const nameChanged = editName.trim() && editName.trim() !== nickname

  function handleSetName() {
    if (!nameChanged) return
    onNicknameChange!(editName.trim())
    setNameSaved(true)
    setTimeout(() => setNameSaved(false), 2000)
  }

  function handleTouchStart(i: number) {
    longPressTimer.current = setTimeout(() => {
      dispatchInteract({ type: 'TOGGLE_MSG', index: i })
    }, 400)
  }

  function handleTouchEnd() {
    clearTimeout(longPressTimer.current!)
  }

  function handleDragStart(e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) {
    if (!isPopout || isFullscreen) return
    const el = popoutRef.current
    if (!el) return
    const touch = (e as React.TouchEvent).touches
    const clientX = touch ? touch[0].clientX : (e as React.MouseEvent).clientX
    const clientY = touch ? touch[0].clientY : (e as React.MouseEvent).clientY
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: clientX, startY: clientY, origX: rect.left, origY: rect.top }

    const onMove = (ev: MouseEvent | TouchEvent) => {
      const t = (ev as TouchEvent).touches
      const cx = t ? t[0].clientX : (ev as MouseEvent).clientX
      const cy = t ? t[0].clientY : (ev as MouseEvent).clientY
      const dx = cx - dragRef.current!.startX
      const dy = cy - dragRef.current!.startY
      const nx = Math.max(0, Math.min(window.innerWidth - 100, dragRef.current!.origX + dx))
      const ny = Math.max(0, Math.min(window.innerHeight - 50, dragRef.current!.origY + dy))
      dispatchPanel({ type: 'SET', payload: { popoutPos: { x: nx, y: ny } } })
    }
    const onEnd = () => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }

  function handleResizeStart(e: React.MouseEvent<HTMLDivElement> | React.TouchEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const el = popoutRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const startRight = rect.right
    const startBottom = rect.bottom

    const onMove = (ev: MouseEvent | TouchEvent) => {
      ev.preventDefault()
      const t = (ev as TouchEvent).touches
      const cx = t ? t[0].clientX : (ev as MouseEvent).clientX
      const cy = t ? t[0].clientY : (ev as MouseEvent).clientY
      const newW = Math.max(280, Math.min(window.innerWidth - 16, startRight - cx))
      const newH = Math.max(300, Math.min(window.innerHeight - 32, startBottom - cy))
      dispatchPanel({ type: 'SET', payload: { popoutSize: { w: newW, h: newH }, popoutPos: { x: startRight - newW, y: startBottom - newH } } })
    }
    const onEnd = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) dispatchPanel({ type: 'SET', payload: { showMenu: false } })
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('touchstart', handleClick)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('touchstart', handleClick)
    }
  }, [showMenu])

  // Fix 2: Auto-focus clear confirm dialog
  useEffect(() => {
    if (showClearConfirm && clearConfirmRef.current) {
      clearConfirmRef.current.focus()
    }
  }, [showClearConfirm])

  function handleMsgClick(i: number) {
    dispatchInteract({ type: 'TOGGLE_MSG', index: i })
  }

  const typingText = typingUsers && typingUsers.length > 0
    ? typingUsers.length === 1
      ? typingUsers[0]
      : `${typingUsers.slice(0, 2).join(', ')}${typingUsers.length > 2 ? ` +${typingUsers.length - 2}` : ''}`
    : null

  interface GroupedMessage extends ChatMessage {
    index: number
  }

  interface MessageGroup {
    from: string
    self: boolean
    isSystem: boolean
    messages: GroupedMessage[]
    lastTime: number
  }

  const groupedMessages = useMemo((): MessageGroup[] => {
    const groups: MessageGroup[] = []
    let currentGroup: MessageGroup | null = null

    messages.forEach((msg, i) => {
      const isSystemMsg = msg.from === 'system'
      const timeDiff = currentGroup ? msg.time - currentGroup.lastTime : Infinity
      const sameAuthor = currentGroup && currentGroup.from === msg.from
      const shouldGroup = sameAuthor && timeDiff < 60000 && !isSystemMsg

      if (shouldGroup) {
        currentGroup!.messages.push({ ...msg, index: i })
        currentGroup!.lastTime = msg.time
      } else {
        if (currentGroup) groups.push(currentGroup)
        currentGroup = {
          from: msg.from,
          self: msg.self,
          isSystem: isSystemMsg,
          messages: [{ ...msg, index: i }],
          lastTime: msg.time
        }
      }
    })
    if (currentGroup) groups.push(currentGroup)
    return groups
  }, [messages])

  return (
    <div
      ref={popoutRef}
      className={`animate-fade-in-up ${
        isFullscreen
          ? 'fixed left-0 right-0 z-50 bg-bg flex flex-col'
          : isPopout
            ? 'fixed z-50 rounded-2xl shadow-2xl border border-border bg-bg flex flex-col overflow-hidden'
            : 'glow-card overflow-hidden transition-all duration-300'
      }`}
      style={
        isFullscreen ? {
          top: `${viewportOffset}px`,
          height: viewportHeight,
          paddingBottom: 'env(safe-area-inset-bottom, 0)'
        }
        : isPopout ? {
          width: `${popoutSize.w}px`,
          height: `${popoutSize.h}px`,
          top: popoutPos ? `${popoutPos.y}px` : undefined,
          left: popoutPos ? `${popoutPos.x}px` : undefined,
          bottom: popoutPos ? undefined : '1rem',
          right: popoutPos ? undefined : '1rem',
        }
        : undefined
      }
    >
      {/* Header - popout mode */}
      {isPopout && !isFullscreen && (
        <div
          className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 bg-surface/80 backdrop-blur-sm cursor-move select-none relative"
          onMouseDown={handleDragStart}
          onTouchStart={handleDragStart}
        >
          {/* Top-left resize handle */}
          <div
            className="absolute -top-1 -left-1 w-5 h-5 cursor-nw-resize z-10 flex items-center justify-center opacity-40 hover:opacity-100 transition-opacity"
            onMouseDown={handleResizeStart}
            onTouchStart={handleResizeStart}
            title="Resize"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted">
              <line x1="0" y1="10" x2="10" y2="0" stroke="currentColor" strokeWidth="1.5" />
              <line x1="0" y1="6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
              <line x1="0" y1="2" x2="2" y2="0" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center">
              <MessageCircle className="w-4 h-4 text-accent" />
            </div>
            <div>
              <span className="font-mono text-sm text-text font-medium">Chat</span>
              {onlineCount != null && onlineCount > 0 && (
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                  <span className="font-mono text-[10px] text-muted">{onlineCount} online</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {onClearMessages && messages.length > 0 && (
              <button
                onClick={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: true } })}
                className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                title="Clear messages"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => { clearResizeStyles(); dispatchPanel({ type: 'SET', payload: { isFullscreen: true } }) }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
              title="Fullscreen"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => { clearResizeStyles(); dispatchPanel({ type: 'RESET_POPOUT' }) }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
              title="Minimize"
            >
              <Minimize2 className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Header - native messaging app style when fullscreen */}
      {isFullscreen ? (
        <div
          className="flex items-center justify-between px-2 border-b border-border shrink-0 bg-surface/80 backdrop-blur-sm"
          style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)', paddingBottom: '8px' }}
        >
          {/* Left: Back/Minimize button */}
          <button
            onClick={() => { clearResizeStyles(); dispatchPanel({ type: 'SET', payload: { isFullscreen: false, ...(!isPopout && { open: true }) } }) }}
            className="flex items-center gap-0.5 px-2 py-2 rounded-xl text-accent active:bg-accent/10 transition-colors"
          >
            {isPopout ? <Minimize2 className="w-5 h-5" /> : <ChevronDown className="w-5 h-5 rotate-90" />}
            <span className="font-mono text-sm font-medium">{isPopout ? 'Minimize' : 'Back'}</span>
          </button>

          {/* Center: Title and online count */}
          <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
            <span className="font-mono text-base text-text font-semibold">Chat</span>
            {onlineCount != null && onlineCount > 0 && (
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="font-mono text-[10px] text-muted">{onlineCount} online</span>
              </div>
            )}
          </div>

          {/* Right: Three-dot menu */}
          <div className="relative">
            <button
              ref={menuTriggerRef}
              data-menu-trigger
              onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
                e.stopPropagation()
                const rect = e.currentTarget.getBoundingClientRect()
                dispatchPanel({ type: 'SET', payload: { menuPos: { top: rect.bottom + 4, right: window.innerWidth - rect.right } } })
                dispatchPanel({ type: 'TOGGLE_MENU' })
              }}
              className="p-2.5 rounded-xl text-muted active:bg-surface-2 transition-colors"
              type="button"
            >
              <MoreVertical className="w-5 h-5" />
            </button>

            {showMenu && createPortal(
              <div
                ref={menuRef}
                className="fixed w-56 bg-surface border border-border rounded-xl shadow-xl overflow-hidden animate-fade-in-up"
                style={{ top: `${menuPos.top}px`, right: `${menuPos.right}px`, zIndex: 9999 }}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
              >
                {/* Nickname section */}
                {onNicknameChange && (
                  <div className="p-3 border-b border-border">
                    <label className="font-mono text-[10px] text-muted uppercase tracking-wide mb-2 block">Nickname</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                        onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && nameChanged && handleSetName()}
                        maxLength={20}
                        placeholder="Enter name"
                        className="flex-1 min-w-0 bg-bg border border-border rounded-lg px-2.5 py-2 font-mono text-sm text-text placeholder:text-muted/50 focus:outline-none focus:border-accent/50"
                      />
                      {nameChanged && (
                        <button
                          onClick={() => { handleSetName(); dispatchPanel({ type: 'SET', payload: { showMenu: false } }) }}
                          className="shrink-0 p-2 rounded-lg bg-accent text-bg active:scale-95 transition-transform"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className="text-[10px] text-zinc-500">{editName.length}/20</span>
                      {nameSaved && <span className="text-xs text-emerald-400">Saved</span>}
                    </div>
                  </div>
                )}

                {/* Toggle options */}
                <div className="py-1">
                  <button
                    onClick={() => setSoundEnabled(s => !s)}
                    className="w-full flex items-center justify-between px-4 py-3 active:bg-surface-2 transition-colors"
                    role="switch"
                    aria-checked={soundEnabled}
                  >
                    <div className="flex items-center gap-3">
                      {soundEnabled ? <Volume2 className="w-4 h-4 text-accent" /> : <VolumeX className="w-4 h-4 text-muted" />}
                      <span className="font-mono text-sm text-text">Sound</span>
                    </div>
                    <div className={`w-10 h-6 rounded-full transition-colors ${soundEnabled ? 'bg-accent' : 'bg-border'}`}>
                      <div className={`w-5 h-5 mt-0.5 rounded-full bg-white shadow transition-transform ${soundEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                    </div>
                  </button>

                  <button
                    onClick={async () => {
                      if (!notifyEnabled && !canNotify()) {
                        const granted = await requestNotificationPermission()
                        if (granted) setNotifyEnabled(true)
                      } else {
                        setNotifyEnabled(n => !n)
                      }
                    }}
                    className="w-full flex items-center justify-between px-4 py-3 active:bg-surface-2 transition-colors"
                    role="switch"
                    aria-checked={notifyEnabled}
                  >
                    <div className="flex items-center gap-3">
                      {notifyEnabled ? <Bell className="w-4 h-4 text-accent" /> : <BellOff className="w-4 h-4 text-muted" />}
                      <span className="font-mono text-sm text-text">Notifications</span>
                    </div>
                    <div className={`w-10 h-6 rounded-full transition-colors ${notifyEnabled ? 'bg-accent' : 'bg-border'}`}>
                      <div className={`w-5 h-5 mt-0.5 rounded-full bg-white shadow transition-transform ${notifyEnabled ? 'translate-x-[18px]' : 'translate-x-0.5'}`} />
                    </div>
                  </button>
                </div>

                {/* Clear messages */}
                {onClearMessages && messages.length > 0 && (
                  <>
                    <div className="border-t border-border" />
                    <button
                      onClick={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: true, showMenu: false } })}
                      className="w-full flex items-center gap-3 px-4 py-3 text-danger active:bg-danger/10 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                      <span className="font-mono text-sm">Clear Messages</span>
                    </button>
                  </>
                )}
              </div>,
              document.body
            )}
          </div>
        </div>
      ) : !isPopout ? (
        <div
          role="button"
          tabIndex={0}
          onClick={() => dispatchPanel({ type: 'TOGGLE_OPEN' })}
          onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => (e.key === 'Enter' || e.key === ' ') && dispatchPanel({ type: 'TOGGLE_OPEN' })}
          className="w-full flex items-center justify-between p-4 text-left group hover:bg-surface-2/30 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="w-8 h-8 rounded-xl bg-accent/10 flex items-center justify-center">
                <MessageCircle className="w-4 h-4 text-accent" />
              </div>
              {unread > 0 && (
                <span className="absolute -top-1 -right-1 flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-accent text-bg font-mono text-[10px] font-bold px-1 shadow-lg shadow-accent/30 animate-pulse">
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </div>
            <div>
              <span className="font-mono text-sm text-text font-medium">Chat</span>
              {onlineCount != null && onlineCount > 0 && (
                <div className="flex items-center gap-1 mt-0.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                  <span className="font-mono text-[10px] text-muted">{onlineCount} online</span>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-1">
            {onClearMessages && messages.length > 0 && (
              <button
                onClick={(e: React.MouseEvent) => { e.stopPropagation(); dispatchPanel({ type: 'SET', payload: { showClearConfirm: true } }) }}
                className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                title="Clear messages"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Pop-out button - desktop only */}
            <button
              onClick={(e: React.MouseEvent) => {
                e.stopPropagation()
                dispatchPanel({ type: 'SET', payload: { popoutPos: { x: Math.round((window.innerWidth - 384) / 2), y: Math.round((window.innerHeight - 600) / 2) }, isPopout: true, open: true } })
              }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors hidden sm:flex"
              title="Pop out chat"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
            {/* Fullscreen toggle */}
            <button
              onClick={(e: React.MouseEvent) => { e.stopPropagation(); clearResizeStyles(); dispatchPanel({ type: 'SET', payload: { isFullscreen: true } }) }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
              title="Fullscreen chat"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <ChevronDown className={`w-5 h-5 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
          </div>
        </div>
      ) : null}

      <div className={`transition-all duration-400 ease-in-out ${
        isFullscreen || isPopout
          ? 'flex-1 flex flex-col overflow-hidden'
          : `grid ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`
      }`}>
        <div className={isFullscreen || isPopout ? 'flex-1 flex flex-col overflow-hidden' : 'overflow-hidden'}>
          <div className={`${isFullscreen || isPopout ? 'flex-1 flex flex-col overflow-hidden' : 'px-3 sm:px-4 pb-4 space-y-3'}`}>
            {/* Nickname editor + settings - hidden in fullscreen (moved to menu) */}
            {!isFullscreen && (
            <div className="flex items-center justify-between gap-2">
              {onNicknameChange && (
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-2 p-2 bg-surface-2 rounded-lg border border-border">
                    <Users className="w-3.5 h-3.5 text-accent shrink-0" />
                    <input
                      type="text"
                      value={editName}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => setEditName(e.target.value)}
                      onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => e.key === 'Enter' && nameChanged && handleSetName()}
                      maxLength={20}
                      placeholder="Nickname"
                      className="w-24 sm:w-28 bg-transparent font-mono text-sm text-text
                        placeholder:text-muted/50 focus:outline-none"
                    />
                  </div>
                  <span className="text-[10px] text-zinc-500">{editName.length}/20</span>
                  {nameChanged && (
                    <button
                      onClick={handleSetName}
                      className="shrink-0 flex items-center gap-1 px-2.5 py-2 rounded-lg font-mono text-xs
                        bg-accent text-bg font-medium hover:bg-accent-dim active:scale-95 transition-all"
                    >
                      <Check className="w-3 h-3" />
                      Save
                    </button>
                  )}
                  {nameSaved && <span className="text-xs text-emerald-400">Saved</span>}
                </div>
              )}
              {/* Sound and notification toggles */}
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={() => setSoundEnabled(s => !s)}
                  className={`p-2 rounded-lg transition-colors ${soundEnabled ? 'text-accent bg-accent/10' : 'text-muted hover:text-accent hover:bg-accent/10'}`}
                  title={soundEnabled ? 'Sound on' : 'Sound off'}
                  role="switch"
                  aria-checked={soundEnabled}
                >
                  {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                </button>
                <button
                  onClick={async () => {
                    if (!notifyEnabled && !canNotify()) {
                      const granted = await requestNotificationPermission()
                      if (granted) setNotifyEnabled(true)
                    } else {
                      setNotifyEnabled(n => !n)
                    }
                  }}
                  className={`p-2 rounded-lg transition-colors ${notifyEnabled ? 'text-accent bg-accent/10' : 'text-muted hover:text-accent hover:bg-accent/10'}`}
                  title={notifyEnabled ? 'Notifications on' : 'Notifications off'}
                  role="switch"
                  aria-checked={notifyEnabled}
                >
                  {notifyEnabled ? <Bell className="w-4 h-4" /> : <BellOff className="w-4 h-4" />}
                </button>
              </div>
            </div>
            )}

            {/* Messages */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className={`relative overflow-y-auto space-y-3 scrollbar-thin overscroll-contain ${
                isFullscreen || isPopout
                  ? 'flex-1 min-h-0 px-4 py-3 bg-bg'
                  : 'h-[320px] pr-1'
              }`}
              onClick={() => { dispatchInteract({ type: 'SET', payload: { reactingIdx: null, activeMsg: null } }); if (showMenu) dispatchPanel({ type: 'SET', payload: { showMenu: false } }) }}
            >
              {messages.length === 0 && (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="w-12 h-12 rounded-xl bg-accent/5 border border-accent/10 flex items-center justify-center mb-3">
                    <MessageCircle className="w-5 h-5 text-accent/40" />
                  </div>
                  <p className="font-mono text-xs text-muted">No messages yet</p>
                  <p className="text-[10px] text-muted/60 mt-1">Start the conversation</p>
                </div>
              )}

              {groupedMessages.map((group, groupIdx) => {
                if (group.isSystem) {
                  return group.messages.map(msg => (
                    <div key={`${msg.time}-system`} className="flex justify-center animate-fade-in-up">
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-2/50 border border-border/50 font-mono text-[10px] text-muted">
                        {msg.text}
                      </span>
                    </div>
                  ))
                }

                return (
                  <div
                    key={`group-${groupIdx}-${group.messages[0].time}`}
                    className={`flex ${group.self ? 'justify-end' : 'justify-start'} animate-fade-in-up`}
                  >
                    <div className={`flex flex-col gap-0.5 max-w-[90%] sm:max-w-[80%] ${group.self ? 'items-end' : 'items-start'}`}>
                      {/* Show author name only once per group */}
                      {!group.self && (
                        <p className="font-mono text-[10px] text-accent/70 mb-0.5 px-1">{group.from}</p>
                      )}

                      {group.messages.map((msg, msgIdx) => {
                        const i = msg.index
                        const msgId = `${msg.time}`
                        const showActions = activeMsg === i
                        const isFirst = msgIdx === 0
                        const isLast = msgIdx === group.messages.length - 1

                        return (
                          <div key={`${msg.time}-${i}`} className="relative group/msg">
                            <div
                              className={`
                                px-3 py-2 sm:px-3.5 sm:py-2.5 space-y-1 transition-colors cursor-pointer
                                ${group.self
                                  ? `bg-accent/10 border border-accent/20 active:bg-accent/20 sm:hover:bg-accent/15
                                     ${isFirst && isLast ? 'rounded-2xl rounded-tr-md' : isFirst ? 'rounded-t-2xl rounded-tr-md rounded-b-md' : isLast ? 'rounded-b-2xl rounded-t-md' : 'rounded-md'}`
                                  : `bg-surface-2 border border-border active:bg-surface-2/70 sm:hover:bg-surface-2/80
                                     ${isFirst && isLast ? 'rounded-2xl rounded-tl-md' : isFirst ? 'rounded-t-2xl rounded-tl-md rounded-b-md' : isLast ? 'rounded-b-2xl rounded-t-md' : 'rounded-md'}`
                                }
                              `}
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); handleMsgClick(i) }}
                              onTouchStart={() => handleTouchStart(i)}
                              onTouchEnd={handleTouchEnd}
                            >
                              {msg.replyTo && (
                                <div className={`border-l-2 pl-2 mb-1.5 ${group.self ? 'border-accent/40' : 'border-muted/30'}`}>
                                  <p className="font-mono text-[9px] text-accent/60">{msg.replyTo.from}</p>
                                  <p className="text-[11px] text-muted truncate">{msg.replyTo.text || 'Image'}</p>
                                </div>
                              )}

                              {msg.image && msg.mime?.startsWith('audio/') ? (
                                <VoicePlayer src={msg.image} knownDuration={msg.duration} />
                              ) : msg.image ? (
                                <img
                                  src={msg.image}
                                  alt={`Image from ${msg.from}`}
                                  className="rounded-lg max-w-full max-h-[200px] object-contain cursor-pointer hover:opacity-90 transition-opacity shadow-sm"
                                  onClick={(e: React.MouseEvent) => { e.stopPropagation(); dispatchInteract({ type: 'SET', payload: { viewImage: { url: msg.image, mime: msg.mime } } }) }}
                                />
                              ) : null}

                              {msg.text && (
                                <p className="text-[13px] text-text break-words leading-relaxed">
                                  <Linkify text={msg.text} />
                                </p>
                              )}

                              <p className="text-[9px] text-muted/50 font-mono mt-0.5">
                                {new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </p>
                            </div>

                            {/* Reactions display */}
                            {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                              <div className={`flex gap-1 mt-1 flex-wrap ${group.self ? 'justify-end' : 'justify-start'}`}>
                                {Object.entries(msg.reactions).map(([emoji, users]) => (
                                  <span
                                    key={emoji}
                                    className="inline-flex items-center gap-0.5 bg-surface border border-border/80 rounded-full px-1.5 py-0.5 text-[11px] cursor-default hover:bg-surface-2 transition-colors shadow-sm"
                                    title={users.join(', ')}
                                  >
                                    {emoji} <span className="font-mono text-muted-light text-[10px]">{users.length}</span>
                                  </span>
                                ))}
                              </div>
                            )}

                            {/* Action buttons */}
                            {onReaction && (
                              <div className={`
                                flex items-center gap-1 mt-1 transition-all duration-150
                                ${showActions || reactingIdx === i ? 'opacity-100 max-h-20' : 'opacity-0 max-h-0 overflow-hidden sm:group-hover/msg:opacity-100 sm:group-hover/msg:max-h-20'}
                              `}>
                                {reactingIdx === i ? (
                                  <div className="flex flex-wrap gap-0.5 p-1 bg-surface border border-border rounded-lg">
                                    {EMOJIS.slice(0, 6).map(emoji => (
                                      <button
                                        key={emoji}
                                        onClick={(e: React.MouseEvent) => { e.stopPropagation(); onReaction(msgId, emoji); dispatchInteract({ type: 'SET', payload: { reactingIdx: null, activeMsg: null } }) }}
                                        className="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center rounded hover:bg-accent/15 active:scale-90 transition-all text-sm sm:text-base"
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                    <button
                                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); dispatchInteract({ type: 'SET', payload: { reactingIdx: null } }) }}
                                      className="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center rounded hover:bg-danger/15 text-muted hover:text-danger active:scale-90 transition-all text-xs"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); dispatchInteract({ type: 'SET', payload: { reactingIdx: i, activeMsg: i } }) }}
                                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors text-[11px] font-mono"
                                    >
                                      <Smile className="w-3 h-3" />
                                      <span className="hidden sm:inline">React</span>
                                    </button>
                                    <button
                                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); dispatchInteract({ type: 'SET', payload: { replyTo: { text: msg.text, from: msg.from, time: msg.time }, activeMsg: null } }) }}
                                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors text-[11px] font-mono"
                                    >
                                      <Reply className="w-3 h-3" />
                                      <span className="hidden sm:inline">Reply</span>
                                    </button>
                                  </>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )
              })}

              {/* Scroll to bottom button */}
              {showScrollBtn && (
                <button
                  onClick={scrollToBottom}
                  className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface border border-border shadow-lg shadow-black/30 text-muted hover:text-accent hover:border-accent/30 transition-colors animate-fade-in-up"
                >
                  <ArrowDown className="w-3 h-3" />
                  <span className="font-mono text-[10px]">New messages</span>
                </button>
              )}
            </div>

            {/* Input section - sticky bottom in fullscreen/popout */}
            <div className={`shrink-0 ${isFullscreen || isPopout ? 'bg-surface/80 backdrop-blur-sm border-t border-border' : 'space-y-2'}`}>
              {/* Typing indicator */}
              {typingText && (
                <div className={`flex items-center gap-2 ${isFullscreen || isPopout ? 'px-4 py-1.5' : 'px-1'}`}>
                  <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-2/50 border border-border/50">
                    <span className="font-mono text-[10px] text-muted-light">{typingText}</span>
                    <TypingDots />
                  </div>
                </div>
              )}

              {/* Drop error toast */}
              {dropError && (
                <div className={`flex items-center gap-2 bg-danger/10 border border-danger/20 animate-fade-in-up ${isFullscreen || isPopout ? 'mx-4 my-2 px-3 py-2 rounded-xl' : 'px-3 py-2 rounded-xl'}`}>
                  <X className="w-3.5 h-3.5 text-danger shrink-0" />
                  <span className="font-mono text-xs text-danger">{dropError}</span>
                </div>
              )}

              {/* Mic/image error feedback */}
              {micError && (
                <div className={`flex items-center gap-2 bg-danger/10 border border-danger/20 animate-fade-in-up ${isFullscreen || isPopout ? 'mx-4 my-2 px-3 py-2 rounded-xl' : 'px-3 py-2 rounded-xl'}`}>
                  <X className="w-3.5 h-3.5 text-danger shrink-0" />
                  <span className="font-mono text-xs text-danger">{micError}</span>
                </div>
              )}

              {/* Reply preview */}
              {replyTo && (
                <div className={`flex items-center gap-2 bg-accent/5 animate-fade-in-up ${isFullscreen || isPopout ? 'px-4 py-2 border-b border-accent/20' : 'px-3 py-2 border border-accent/20 rounded-xl'}`}>
                  <div className="w-1 h-8 bg-accent/60 rounded-full shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-[10px] text-accent font-medium">Replying to {replyTo.from}</p>
                    <p className="text-xs text-muted truncate mt-0.5">{replyTo.text || 'Image'}</p>
                  </div>
                  <button
                    onClick={() => dispatchInteract({ type: 'SET', payload: { replyTo: null } })}
                    className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Image preview */}
              {imagePreview && (
                <div className={`relative inline-block animate-fade-in-up ${isFullscreen || isPopout ? 'mx-4 my-2' : ''}`}>
                  <img src={imagePreview.url} alt="Upload preview" className="h-20 rounded-xl border border-border shadow-sm object-cover" />
                  <button
                    onClick={() => {
                      if (imagePreview?.url?.startsWith('blob:')) URL.revokeObjectURL(imagePreview.url)
                      dispatchInteract({ type: 'SET', payload: { imagePreview: null } })
                    }}
                    className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-danger text-white flex items-center justify-center shadow-md hover:bg-danger/90 transition-colors"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Input form */}
              <form
                onSubmit={handleSend}
                onDragOver={(e: React.DragEvent<HTMLFormElement>) => { e.preventDefault(); dispatchInteract({ type: 'SET', payload: { isDragOver: true } }) }}
                onDragLeave={() => dispatchInteract({ type: 'SET', payload: { isDragOver: false } })}
                onDrop={handleDrop}
                className={`flex gap-1.5 sm:gap-2 items-end ${isFullscreen || isPopout ? 'px-3 py-2' : ''} ${isDragOver ? 'ring-2 ring-accent/40 rounded-xl' : ''}`}
                style={{ paddingBottom: isFullscreen ? 'env(safe-area-inset-bottom, 0px)' : undefined }}
              >
              <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImagePick} className="hidden" />

              {isRecording ? (
                <>
                  {/* Recording indicator */}
                  <button
                    type="button"
                    onClick={cancelRecording}
                    aria-label="Cancel recording"
                    className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-surface border border-border text-danger
                      hover:bg-danger/10 active:scale-95 transition-all flex items-center justify-center self-end"
                  >
                    <X className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                  <div className="flex-1 flex items-center gap-3 px-3 py-2.5 bg-bg border border-danger/30 rounded-xl min-h-[40px] sm:min-h-[44px]">
                    <span className="w-2.5 h-2.5 rounded-full bg-danger animate-pulse shrink-0" />
                    <span className="font-mono text-sm text-danger">{Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}</span>
                    <div className="flex-1 flex items-center gap-0.5">
                      {Array.from({ length: 20 }).map((_, i) => (
                        <div key={i} className={`w-1 rounded-full bg-danger/60 transition-all ${i < (recordingTime % 5) + 1 ? 'h-3' : 'h-1'}`} />
                      ))}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={stopRecording}
                    aria-label="Send voice note"
                    className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-accent text-bg
                      hover:bg-accent-dim active:scale-90 shadow-lg shadow-accent/25 transition-all flex items-center justify-center self-end"
                  >
                    <Send className="w-4 h-4" />
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => imageInputRef.current?.click()}
                    disabled={disabled}
                    aria-label="Attach image"
                    className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-surface border border-border text-muted
                      hover:text-accent hover:border-accent/30 active:scale-95 transition-all flex items-center justify-center
                      disabled:opacity-30 disabled:cursor-not-allowed self-end"
                  >
                    <ImagePlus className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                  <textarea
                    ref={textInputRef}
                    dir="auto"
                    rows={1}
                    autoComplete="off"
                    autoCorrect="on"
                    autoCapitalize="sentences"
                    spellCheck={true}
                    enterKeyHint="send"
                    data-form-type="other"
                    data-lpignore="true"
                    data-1p-ignore="true"
                    value={text}
                    onChange={handleTyping}
                    onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault()
                        handleSend(e)
                      }
                    }}
                    placeholder={disabled ? 'Connect to chat' : 'Message...'}
                    maxLength={2000}
                    disabled={disabled}
                    className="flex-1 min-w-0 bg-bg border border-border rounded-xl px-3 py-2.5 sm:px-4 sm:py-3 font-mono text-[16px] sm:text-sm text-text
                      placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-all
                      disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px] sm:min-h-[44px] max-h-[120px]
                      resize-none overflow-y-auto scrollbar-thin"
                  />
                  {/* Show mic button when input is empty, send button when there's content */}
                  {!text.trim() && !imagePreview ? (
                    <button
                      type="button"
                      onClick={startRecording}
                      disabled={disabled || !getRecordingMime()}
                      aria-label="Record voice note"
                      className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-surface border border-border text-muted
                        hover:text-accent hover:border-accent/30 active:scale-95 transition-all flex items-center justify-center
                        disabled:opacity-30 disabled:cursor-not-allowed self-end"
                    >
                      <Mic className="w-4 h-4 sm:w-5 sm:h-5" />
                    </button>
                  ) : (
                    <button
                      type="submit"
                      disabled={disabled || (!text.trim() && !imagePreview)}
                      aria-label="Send message"
                      className={`shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center transition-all self-end
                        ${!disabled && (text.trim() || imagePreview)
                          ? 'bg-accent text-bg hover:bg-accent-dim active:scale-90 shadow-lg shadow-accent/25'
                          : 'bg-surface border border-border text-muted/40 cursor-not-allowed'
                        }`}
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            </form>
            </div>
          </div>
        </div>
      </div>
      {showClearConfirm && createPortal(
        <div
          ref={clearConfirmRef}
          className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4 animate-fade-in-up"
          onClick={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: false } })}
          onKeyDown={(e: React.KeyboardEvent) => {
            if (e.key === 'Escape') dispatchPanel({ type: 'SET', payload: { showClearConfirm: false } })
            if (e.key === 'Tab') e.preventDefault()
          }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="clear-confirm-title"
          tabIndex={-1}
        >
          <div className="bg-surface border border-border rounded-2xl shadow-2xl max-w-sm w-full p-6 space-y-4" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-danger/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-danger" />
              </div>
              <div>
                <p id="clear-confirm-title" className="font-mono text-sm font-medium text-text">Clear messages?</p>
                <p className="text-xs text-muted mt-0.5">This will only clear messages on your side. Other participants will still see their messages.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: false } })}
                className="px-4 py-2 rounded-xl font-mono text-sm bg-surface border border-border text-muted hover:text-text hover:border-border-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onClearMessages!(); dispatchPanel({ type: 'SET', payload: { showClearConfirm: false } }) }}
                className="px-4 py-2 rounded-xl font-mono text-sm bg-danger text-white hover:bg-danger/90 active:scale-95 transition-all"
              >
                Clear
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
      {viewImage && createPortal(
        <ImagePreviewOverlay viewImage={viewImage} onClose={() => dispatchInteract({ type: 'SET', payload: { viewImage: null } })} />,
        document.body
      )}
    </div>
  )
}

// ── ImagePreviewOverlay ───────────────────────────────────────────────────────

interface ImagePreviewOverlayProps {
  viewImage: ViewImage
  onClose: () => void
}

function ImagePreviewOverlay({ viewImage, onClose }: ImagePreviewOverlayProps) {
  const [showControls, setShowControls] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    return () => clearTimeout(hideTimer.current!)
  }, [])

  // Auto-focus the overlay for keyboard accessibility
  useEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.focus()
    }
  }, [])

  function handleTap(e: React.MouseEvent<HTMLDivElement>) {
    if ((e.target as HTMLElement).closest('a') || (e.target as HTMLElement).closest('button')) return
    clearTimeout(hideTimer.current!)
    if (showControls) {
      setShowControls(false)
    } else {
      setShowControls(true)
      hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    }
  }

  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Tab') {
      e.preventDefault() // Keep focus trapped on the dialog
    }
  }

  const imgUrl = viewImage.url ?? ''

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-4"
      onClick={handleTap}
      onKeyDown={handleDialogKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      tabIndex={-1}
    >
      <div className={`absolute top-4 right-4 flex gap-2 z-10 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <a
          href={imgUrl}
          download={imageFilename(imgUrl, viewImage.mime)}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="px-4 py-2.5 rounded-lg font-mono text-sm bg-accent text-bg hover:bg-accent-dim transition-colors min-h-[44px] flex items-center"
        >
          Save
        </a>
        <button
          onClick={onClose}
          autoFocus
          aria-label="Close preview"
          className="px-4 py-2.5 rounded-lg font-mono text-sm bg-surface border border-border text-text hover:border-border-hover transition-colors min-h-[44px]"
        >
          Close
        </button>
      </div>
      <img src={imgUrl} alt="Preview" className="max-w-full max-h-[85vh] object-contain rounded-lg" />
    </div>
  )
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function imageFilename(url: string, mime: string | undefined): string {
  const dataMatch = /^data:image\/([a-z0-9+.-]+)/i.exec(url || '')
  if (dataMatch) {
    let ext = dataMatch[1].toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (ext === 'svg+xml') ext = 'svg'
    return `image.${ext}`
  }
  if (mime) {
    let ext = (mime.split('/')[1] || 'jpg').toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (ext === 'svg+xml') ext = 'svg'
    return `image.${ext}`
  }
  return 'image.jpg'
}

async function compressImage(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.onload = () => {
      img.onerror = () => reject(new Error('Failed to load image'))
      img.onload = () => {
        const canvas = document.createElement('canvas')
        let { width, height } = img
        const maxDim = 2000
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d')!
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.92))
      }
      img.src = reader.result as string
    }
    reader.readAsDataURL(file)
  })
}
