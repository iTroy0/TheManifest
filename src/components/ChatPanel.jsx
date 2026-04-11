import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, Send, ChevronDown, Users, Check, ImagePlus, X, Reply, ArrowDown, Smile, Volume2, VolumeX, Bell, BellOff, Trash2, Maximize2, Minimize2, MoreVertical } from 'lucide-react'
import { sounds, canNotify, requestNotificationPermission, alertNewMessage } from '../utils/notifications'

const EMOJIS = ['👍', '❤️', '😂', '😮', '🔥', '👎', '🎉', '💯', '👀', '🙏', '💀', '✨']
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/g

function Linkify({ text }) {
  if (!text) return null
  const parts = text.split(URL_REGEX)
  return parts.map((part, i) =>
    URL_REGEX.test(part)
      ? <a key={i} href={part} target="_blank" rel="noopener noreferrer" className="text-info underline hover:text-info/80 break-all">{part}</a>
      : part
  )
}

function formatRelativeTime(timestamp) {
  const now = Date.now()
  const diff = now - timestamp
  const seconds = Math.floor(diff / 1000)
  const minutes = Math.floor(seconds / 60)
  const hours = Math.floor(minutes / 60)
  
  if (seconds < 30) return 'just now'
  if (seconds < 60) return `${seconds}s`
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  return new Date(timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

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

export default function ChatPanel({ messages, onSend, onClearMessages, disabled, nickname, onNicknameChange, onlineCount, onTyping, typingUsers, onReaction }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [unread, setUnread] = useState(0)
  const [editName, setEditName] = useState(nickname || '')
  const [replyTo, setReplyTo] = useState(null)
  const [reactingIdx, setReactingIdx] = useState(null)
  const [activeMsg, setActiveMsg] = useState(null) // for mobile long-press
  const [imagePreview, setImagePreview] = useState(null)
  const [viewImage, setViewImage] = useState(null)
  const [showScrollBtn, setShowScrollBtn] = useState(false)
  const [isNearBottom, setIsNearBottom] = useState(true)
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [showMenu, setShowMenu] = useState(false)
  const [viewportHeight, setViewportHeight] = useState('100dvh')
  const [viewportOffset, setViewportOffset] = useState(0)
  const [isPopout, setIsPopout] = useState(false)
  const [popoutPos, setPopoutPos] = useState(null) // { x, y } or null for default
  const [popoutSize, setPopoutSize] = useState({ w: 384, h: 600 }) // w-96 = 384px
  const scrollRef = useRef(null)
  const prevLen = useRef(messages.length)
  const imageInputRef = useRef(null)
  const textInputRef = useRef(null)
  const typingTimer = useRef(null)
  const longPressTimer = useRef(null)
  const dragRef = useRef(null) // { startX, startY, origX, origY }
  const popoutRef = useRef(null)
  const menuRef = useRef(null)
  const menuTriggerRef = useRef(null)
  const [menuPos, setMenuPos] = useState({ top: 0, right: 0 })

  useEffect(() => {
    if (nickname) setEditName(nickname)
  }, [nickname])

  // Check if user is near bottom of scroll
  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 100
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    setIsNearBottom(nearBottom)
    setShowScrollBtn(!nearBottom && messages.length > 5)
  }, [messages.length])

  // Auto-scroll when chat container resizes (mobile keyboard open/close)
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
        setUnread(u => u + (messages.length - prevLen.current))
      }
      // Play sound and/or notify for new incoming messages
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
    if (open) setUnread(0)
  }, [open])

  // Lock body scroll when fullscreen on mobile (not for desktop popout)
  useEffect(() => {
    if (isFullscreen) {
      document.body.style.overflow = 'hidden'
      setOpen(true)
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isFullscreen])

  // Auto-open when popout is enabled
  useEffect(() => {
    if (isPopout) setOpen(true)
  }, [isPopout])

  // Clear inline width/height left by CSS resize when leaving popout
  // or entering fullscreen — otherwise the stale dimensions override
  // the new layout mode.
  function clearResizeStyles() {
    const el = popoutRef.current
    if (el) { el.style.width = ''; el.style.height = '' }
  }

  // Handle visual viewport changes (keyboard open/close on mobile)
  // iOS Safari fix: use offsetTop to compensate for page scroll when keyboard opens
  useEffect(() => {
    if (!isFullscreen) return
    const vv = window.visualViewport
    if (!vv) {
      // Fallback for browsers without visualViewport
      setViewportHeight('100dvh')
      setViewportOffset(0)
      return
    }
    
    let rafId = null
    
    function handleViewportChange() {
      if (rafId) cancelAnimationFrame(rafId)
      
      rafId = requestAnimationFrame(() => {
        // Height accounts for keyboard, offsetTop accounts for iOS scroll
        setViewportHeight(`${vv.height}px`)
        setViewportOffset(vv.offsetTop)
        
        // Scroll messages to bottom after keyboard change
        if (scrollRef.current && isNearBottom) {
          scrollRef.current.scrollTo({ 
            top: scrollRef.current.scrollHeight, 
            behavior: 'instant' 
          })
        }
      })
    }
    
    // Set initial values
    setViewportHeight(`${vv.height}px`)
    setViewportOffset(vv.offsetTop)
    
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

  function handleTyping(e) {
    setText(e.target.value)
    // Auto-resize textarea to fit content
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    if (onTyping) {
      if (!typingTimer.current) onTyping()
      clearTimeout(typingTimer.current)
      typingTimer.current = setTimeout(() => { typingTimer.current = null }, 2000)
    }
  }

  // Reset textarea height after send
  useEffect(() => {
    if (!text && textInputRef.current) {
      textInputRef.current.style.height = 'auto'
    }
  }, [text])

  // Drag-and-drop images onto the chat area
  const [isDragOver, setIsDragOver] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)

  // Reset drag highlight if user drags out of the window entirely
  useEffect(() => {
    if (!isDragOver) return
    const reset = () => setIsDragOver(false)
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset) }
  }, [isDragOver])
  const [dropError, setDropError] = useState(null)
  function handleDrop(e) {
    e.preventDefault()
    setIsDragOver(false)
    const files = Array.from(e.dataTransfer?.files || [])
    const file = files.find(f => f.type.startsWith('image/'))
    if (file) {
      prepareImage(file).then(img => { if (img) setImagePreview(img) }).catch(() => {})
    } else if (files.length > 0) {
      setDropError('Only images are supported in chat')
      setTimeout(() => setDropError(null), 3000)
    }
  }

  function handleSend(e) {
    e.preventDefault()
    if ((!text.trim() && !imagePreview) || disabled) return
    if (soundEnabled) sounds.messageSent()
    onSend(text.trim(), imagePreview, replyTo)
    setText('')
    setImagePreview(null)
    setReplyTo(null)
    textInputRef.current?.focus()
  }

  // Build an image payload: { url, bytes, mime } — `url` for preview,
  // `bytes` + `mime` for sending through the binary chunk pipeline.
  async function prepareImage(file) {
    if (file.type === 'image/gif') {
      if (file.size > 3 * 1024 * 1024) {
        alert('GIF is too large (max 3 MB)')
        return null
      }
      const bytes = new Uint8Array(await file.arrayBuffer())
      const url = URL.createObjectURL(new Blob([bytes], { type: file.type }))
      return { url, bytes, mime: file.type }
    }
    // Non-GIF: compress to JPEG, then extract bytes for binary transport.
    const dataUri = await compressImage(file)
    const raw = atob(dataUri.split(',')[1])
    const bytes = new Uint8Array(raw.length)
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return { url: dataUri, bytes, mime: 'image/jpeg' }
  }

  async function handleImagePick(e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    e.target.value = ''
    try {
      const img = await prepareImage(file)
      if (img) setImagePreview(img)
    } catch { /* invalid image */ }
  }

  useEffect(() => {
    if (!open || disabled) return
    function handlePaste(e) {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      prepareImage(file).then(img => { if (img) setImagePreview(img) }).catch(() => {})
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [open, disabled])

  const nameChanged = editName.trim() && editName.trim() !== nickname

  function handleSetName() {
    if (!nameChanged) return
    onNicknameChange(editName.trim())
  }

  // Long press for mobile — show actions
  function handleTouchStart(i) {
    longPressTimer.current = setTimeout(() => {
      setActiveMsg(activeMsg === i ? null : i)
    }, 400)
  }
  function handleTouchEnd() {
    clearTimeout(longPressTimer.current)
  }

  // ── Popout drag-to-move ──────────────────────────────────────────────
  function handleDragStart(e) {
    if (!isPopout || isFullscreen) return
    const el = popoutRef.current
    if (!el) return
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: clientX, startY: clientY, origX: rect.left, origY: rect.top }
    const onMove = (ev) => {
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY
      const dx = cx - dragRef.current.startX
      const dy = cy - dragRef.current.startY
      const nx = Math.max(0, Math.min(window.innerWidth - 100, dragRef.current.origX + dx))
      const ny = Math.max(0, Math.min(window.innerHeight - 50, dragRef.current.origY + dy))
      setPopoutPos({ x: nx, y: ny })
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

  // ── Popout resize from top-left corner ───────────────────────────────
  function handleResizeStart(e) {
    e.preventDefault()
    e.stopPropagation()
    const el = popoutRef.current
    if (!el) return
    const clientX = e.touches ? e.touches[0].clientX : e.clientX
    const clientY = e.touches ? e.touches[0].clientY : e.clientY
    const rect = el.getBoundingClientRect()
    const startW = rect.width
    const startH = rect.height
    const startRight = rect.right
    const startBottom = rect.bottom
    const onMove = (ev) => {
      ev.preventDefault()
      const cx = ev.touches ? ev.touches[0].clientX : ev.clientX
      const cy = ev.touches ? ev.touches[0].clientY : ev.clientY
      const newW = Math.max(320, Math.min(window.innerWidth - 32, startRight - cx))
      const newH = Math.max(300, Math.min(window.innerHeight - 32, startBottom - cy))
      setPopoutSize({ w: newW, h: newH })
      setPopoutPos({ x: startRight - newW, y: startBottom - newH })
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

  // Close menu on click outside
  useEffect(() => {
    if (!showMenu) return
    function handleClick(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setShowMenu(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('touchstart', handleClick)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('touchstart', handleClick)
    }
  }, [showMenu])

  function handleMsgClick(i) {
    // Toggle actions on tap (mobile) or keep hover behavior (desktop)
    setActiveMsg(activeMsg === i ? null : i)
    setReactingIdx(null)
  }

  const typingText = typingUsers?.length > 0
    ? typingUsers.length === 1
      ? typingUsers[0]
      : `${typingUsers.slice(0, 2).join(', ')}${typingUsers.length > 2 ? ` +${typingUsers.length - 2}` : ''}`
    : null

  // Group consecutive messages from same sender
  const groupedMessages = useMemo(() => {
    const groups = []
    let currentGroup = null
    
    messages.forEach((msg, i) => {
      const isSystemMsg = msg.from === 'system'
      const timeDiff = currentGroup ? msg.time - currentGroup.lastTime : Infinity
      const sameAuthor = currentGroup && currentGroup.from === msg.from
      const shouldGroup = sameAuthor && timeDiff < 60000 && !isSystemMsg // Group if <1min apart
      
      if (shouldGroup) {
        currentGroup.messages.push({ ...msg, index: i })
        currentGroup.lastTime = msg.time
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
              {onlineCount > 0 && (
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
                onClick={() => setShowClearConfirm(true)}
                className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                title="Clear messages"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => { clearResizeStyles(); setIsFullscreen(true) }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
              title="Fullscreen"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => { clearResizeStyles(); setIsPopout(false); setPopoutPos(null); setPopoutSize({ w: 384, h: 600 }) }}
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
            onClick={() => { clearResizeStyles(); setIsFullscreen(false); if (!isPopout) setOpen(true) }}
            className="flex items-center gap-0.5 px-2 py-2 rounded-xl text-accent active:bg-accent/10 transition-colors"
          >
            {isPopout ? <Minimize2 className="w-5 h-5" /> : <ChevronDown className="w-5 h-5 rotate-90" />}
            <span className="font-mono text-sm font-medium">{isPopout ? 'Minimize' : 'Back'}</span>
          </button>
          
          {/* Center: Title and online count */}
          <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
            <span className="font-mono text-base text-text font-semibold">Chat</span>
            {onlineCount > 0 && (
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
              onClick={(e) => {
                e.stopPropagation()
                // Compute menu position relative to the trigger button
                const rect = e.currentTarget.getBoundingClientRect()
                setMenuPos({ top: rect.bottom + 4, right: window.innerWidth - rect.right })
                setShowMenu(m => !m)
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
                onClick={(e) => e.stopPropagation()}
              >
                {/* Nickname section */}
                {onNicknameChange && (
                  <div className="p-3 border-b border-border">
                    <label className="font-mono text-[10px] text-muted uppercase tracking-wide mb-2 block">Nickname</label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && nameChanged && handleSetName()}
                        maxLength={20}
                        placeholder="Enter name"
                        className="flex-1 min-w-0 bg-bg border border-border rounded-lg px-2.5 py-2 font-mono text-sm text-text placeholder:text-muted/50 focus:outline-none focus:border-accent/50"
                      />
                      {nameChanged && (
                        <button
                          onClick={() => { handleSetName(); setShowMenu(false) }}
                          className="shrink-0 p-2 rounded-lg bg-accent text-bg active:scale-95 transition-transform"
                        >
                          <Check className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                )}
                
                {/* Toggle options */}
                <div className="py-1">
                  <button
                    onClick={() => setSoundEnabled(s => !s)}
                    className="w-full flex items-center justify-between px-4 py-3 active:bg-surface-2 transition-colors"
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
                      onClick={() => { setShowClearConfirm(true); setShowMenu(false) }}
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
        <button
          onClick={() => setOpen(o => !o)}
          className="w-full flex items-center justify-between p-4 text-left group hover:bg-surface-2/30 transition-colors"
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
              {onlineCount > 0 && (
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
                onClick={(e) => { e.stopPropagation(); setShowClearConfirm(true) }}
                className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                title="Clear messages"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
            {/* Pop-out button - desktop only */}
            <button
              onClick={(e) => {
                e.stopPropagation()
                setPopoutPos({ x: Math.round((window.innerWidth - 384) / 2), y: Math.round((window.innerHeight - 600) / 2) })
                setIsPopout(true)
                setOpen(true)
              }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors hidden sm:flex"
              title="Pop out chat"
            >
              <ExternalLink className="w-4 h-4" />
            </button>
            {/* Fullscreen toggle */}
            <button
              onClick={(e) => { e.stopPropagation(); clearResizeStyles(); setIsFullscreen(true) }}
              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
              title="Fullscreen chat"
            >
              <Maximize2 className="w-4 h-4" />
            </button>
            <ChevronDown className={`w-5 h-5 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
          </div>
        </button>
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
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && nameChanged && handleSetName()}
                      maxLength={20}
                      placeholder="Nickname"
                      className="w-24 sm:w-28 bg-transparent font-mono text-sm text-text
                        placeholder:text-muted/50 focus:outline-none"
                    />
                  </div>
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
                </div>
              )}
              {/* Sound and notification toggles */}
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={() => setSoundEnabled(s => !s)}
                  className={`p-2 rounded-lg transition-colors ${soundEnabled ? 'text-accent bg-accent/10' : 'text-muted hover:text-accent hover:bg-accent/10'}`}
                  title={soundEnabled ? 'Sound on' : 'Sound off'}
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
              onClick={() => { setReactingIdx(null); setActiveMsg(null); if (showMenu) setShowMenu(false) }}
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
                // System messages
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
                              onClick={(e) => { e.stopPropagation(); handleMsgClick(i) }}
                              onTouchStart={() => handleTouchStart(i)}
                              onTouchEnd={handleTouchEnd}
                            >
                              {msg.replyTo && (
                                <div className={`border-l-2 pl-2 mb-1.5 ${group.self ? 'border-accent/40' : 'border-muted/30'}`}>
                                  <p className="font-mono text-[9px] text-accent/60">{msg.replyTo.from}</p>
                                  <p className="text-[11px] text-muted truncate">{msg.replyTo.text || 'Image'}</p>
                                </div>
                              )}

                              {msg.image && (
                                <img 
                                  src={msg.image} 
                                  alt="" 
                                  className="rounded-lg max-w-full max-h-[200px] object-contain cursor-pointer hover:opacity-90 transition-opacity shadow-sm" 
                                  onClick={(e) => { e.stopPropagation(); setViewImage({ url: msg.image, mime: msg.mime }) }} 
                                />
                              )}

                              {msg.text && (
                                <p className="text-[13px] text-text break-words leading-relaxed">
                                  <Linkify text={msg.text} />
                                </p>
                              )}

                              {/* Timestamp on every message */}
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

                            {/* Action buttons — visible on tap (mobile) or hover (desktop) */}
                            {onReaction && (
                              <div className={`
                                flex items-center gap-1 mt-1 transition-all duration-150
                                ${showActions || reactingIdx === i ? 'opacity-100 max-h-20' : 'opacity-0 max-h-0 overflow-hidden sm:group-hover/msg:opacity-100 sm:group-hover/msg:max-h-20'}
                              `}>
                                {/* Emoji picker inline */}
                                {reactingIdx === i ? (
                                  <div className="flex flex-wrap gap-0.5 p-1 bg-surface border border-border rounded-lg">
                                    {EMOJIS.slice(0, 6).map(emoji => (
                                      <button
                                        key={emoji}
                                        onClick={(e) => { e.stopPropagation(); onReaction(msgId, emoji); setReactingIdx(null); setActiveMsg(null) }}
                                        className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center rounded hover:bg-accent/15 active:scale-90 transition-all text-sm sm:text-base"
                                      >
                                        {emoji}
                                      </button>
                                    ))}
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setReactingIdx(null) }}
                                      className="w-6 h-6 sm:w-7 sm:h-7 flex items-center justify-center rounded hover:bg-danger/15 text-muted hover:text-danger active:scale-90 transition-all text-xs"
                                    >
                                      <X className="w-3 h-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setReactingIdx(i); setActiveMsg(i) }}
                                      className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors text-[11px] font-mono"
                                    >
                                      <Smile className="w-3 h-3" />
                                      <span className="hidden sm:inline">React</span>
                                    </button>
                                    <button
                                      onClick={(e) => { e.stopPropagation(); setReplyTo({ text: msg.text, from: msg.from, time: msg.time }); setActiveMsg(null) }}
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

              {/* Reply preview */}
              {replyTo && (
                <div className={`flex items-center gap-2 bg-accent/5 animate-fade-in-up ${isFullscreen || isPopout ? 'px-4 py-2 border-b border-accent/20' : 'px-3 py-2 border border-accent/20 rounded-xl'}`}>
                  <div className="w-1 h-8 bg-accent/60 rounded-full shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-mono text-[10px] text-accent font-medium">Replying to {replyTo.from}</p>
                    <p className="text-xs text-muted truncate mt-0.5">{replyTo.text || 'Image'}</p>
                  </div>
                  <button 
                    onClick={() => setReplyTo(null)} 
                    className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}

              {/* Image preview */}
              {imagePreview && (
                <div className={`relative inline-block animate-fade-in-up ${isFullscreen || isPopout ? 'mx-4 my-2' : ''}`}>
                  <img src={imagePreview.url || imagePreview} alt="Upload preview" className="h-20 rounded-xl border border-border shadow-sm object-cover" />
                  <button
                    onClick={() => {
                      if (imagePreview?.url?.startsWith('blob:')) URL.revokeObjectURL(imagePreview.url)
                      setImagePreview(null)
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
                onDragOver={(e) => { e.preventDefault(); setIsDragOver(true) }}
                onDragLeave={() => setIsDragOver(false)}
                onDrop={handleDrop}
                className={`flex gap-1.5 sm:gap-2 items-end ${isFullscreen || isPopout ? 'px-3 py-2' : ''} ${isDragOver ? 'ring-2 ring-accent/40 rounded-xl' : ''}`}
              >
              <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImagePick} className="hidden" />
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
                spellCheck="true"
                enterKeyHint="send"
                data-form-type="other"
                data-lpignore="true"
                data-1p-ignore="true"
                value={text}
                onChange={handleTyping}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    handleSend(e)
                  }
                }}
                placeholder={disabled ? 'Connect to chat' : 'Message...'}
                maxLength={2000}
                disabled={disabled}
                className="flex-1 min-w-0 bg-bg border border-border rounded-xl px-3 py-2.5 sm:px-4 sm:py-3 font-mono text-sm text-text
                  placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-all
                  disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px] sm:min-h-[44px] max-h-[120px]
                  resize-none overflow-y-auto scrollbar-thin"
              />
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
            </form>
            </div>
          </div>
        </div>
      </div>
      {showClearConfirm && createPortal(
        <div className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4 animate-fade-in-up" onClick={() => setShowClearConfirm(false)}>
          <div className="bg-surface border border-border rounded-2xl shadow-2xl max-w-sm w-full p-6 space-y-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-danger/10 flex items-center justify-center shrink-0">
                <Trash2 className="w-5 h-5 text-danger" />
              </div>
              <div>
                <p className="font-mono text-sm font-medium text-text">Clear messages?</p>
                <p className="text-xs text-muted mt-0.5">This will only clear messages on your side. Other participants will still see their messages.</p>
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setShowClearConfirm(false)}
                className="px-4 py-2 rounded-xl font-mono text-sm bg-surface border border-border text-muted hover:text-text hover:border-border-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => { onClearMessages(); setShowClearConfirm(false) }}
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
        <ImagePreviewOverlay viewImage={viewImage} onClose={() => setViewImage(null)} />,
        document.body
      )}
    </div>
  )
}

function ImagePreviewOverlay({ viewImage, onClose }) {
  const [showControls, setShowControls] = useState(true)
  const hideTimer = useRef(null)

  // Auto-hide controls after 3s, reset on tap
  useEffect(() => {
    hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    return () => clearTimeout(hideTimer.current)
  }, [])

  function handleTap(e) {
    // Don't toggle when tapping the buttons themselves
    if (e.target.closest('a') || e.target.closest('button')) return
    clearTimeout(hideTimer.current)
    if (showControls) {
      setShowControls(false)
    } else {
      setShowControls(true)
      hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-4"
      onClick={handleTap}
      onKeyDown={(e) => e.key === 'Escape' && onClose()}
      role="dialog"
      aria-label="Image preview"
    >
      <div className={`absolute top-4 right-4 flex gap-2 z-10 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <a
          href={viewImage.url || viewImage}
          download={imageFilename(viewImage.url || viewImage, viewImage.mime)}
          onClick={(e) => e.stopPropagation()}
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
      <img src={viewImage.url || viewImage} alt="Preview" className="max-w-full max-h-[85vh] object-contain rounded-lg" />
    </div>
  )
}

// Pick a sensible filename for the Save button. For data URIs the MIME is
// embedded in the prefix; for blob URLs we need the separate `mime` hint
// (passed from the message's .mime field).
function imageFilename(url, mime) {
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

async function compressImage(file) {
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
        canvas.getContext('2d').drawImage(img, 0, 0, width, height)
        resolve(canvas.toDataURL('image/jpeg', 0.92))
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}
