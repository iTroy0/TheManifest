import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, Send, ChevronDown, Users, Check, ImagePlus, X, Reply, ArrowDown, Smile } from 'lucide-react'

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

function TypingDots() {
  return (
    <span className="inline-flex gap-0.5 ml-1">
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
      <span className="w-1 h-1 bg-accent/60 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
    </span>
  )
}

export default function ChatPanel({ messages, onSend, disabled, nickname, onNicknameChange, onlineCount, onTyping, typingUsers, onReaction }) {
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
  const scrollRef = useRef(null)
  const prevLen = useRef(messages.length)
  const imageInputRef = useRef(null)
  const textInputRef = useRef(null)
  const typingTimer = useRef(null)
  const longPressTimer = useRef(null)

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
    }
    prevLen.current = messages.length
  }, [messages.length, open, isNearBottom])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  function handleTyping(e) {
    setText(e.target.value)
    if (onTyping) {
      if (!typingTimer.current) onTyping()
      clearTimeout(typingTimer.current)
      typingTimer.current = setTimeout(() => { typingTimer.current = null }, 2000)
    }
  }

  function handleSend(e) {
    e.preventDefault()
    if ((!text.trim() && !imagePreview) || disabled) return
    onSend(text.trim(), imagePreview, replyTo)
    setText('')
    setImagePreview(null)
    setReplyTo(null)
    textInputRef.current?.focus()
  }

  async function handleImagePick(e) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    e.target.value = ''
    try {
      const compressed = await compressImage(file)
      setImagePreview(compressed)
    } catch { /* invalid image */ }
  }

  useEffect(() => {
    if (!open || disabled) return
    function handlePaste(e) {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (file) compressImage(file).then(setImagePreview).catch(() => {})
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
    <div className="glow-card overflow-hidden animate-fade-in-up">
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
        <ChevronDown className={`w-5 h-5 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>

      <div className={`grid transition-all duration-400 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-3 sm:px-4 pb-4 space-y-3">
            {/* Nickname editor */}
            {onNicknameChange && (
              <div className="flex items-center gap-2 p-2 bg-surface-2/30 rounded-xl border border-border/50">
                <div className="w-7 h-7 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
                  <Users className="w-3.5 h-3.5 text-accent/70" />
                </div>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && nameChanged && handleSetName()}
                  maxLength={20}
                  placeholder="Your nickname"
                  className="flex-1 min-w-0 bg-transparent font-mono text-sm text-text
                    placeholder:text-muted/40 focus:outline-none"
                />
                {nameChanged && (
                  <button
                    onClick={handleSetName}
                    className="shrink-0 flex items-center gap-1 px-3 py-1.5 rounded-lg font-mono text-xs
                      bg-accent text-bg font-medium hover:bg-accent-dim transition-colors"
                  >
                    <Check className="w-3 h-3" />
                    Save
                  </button>
                )}
              </div>
            )}

            {/* Messages */}
            <div
              ref={scrollRef}
              onScroll={handleScroll}
              className="relative max-h-[min(55vh,450px)] min-h-[180px] overflow-y-auto space-y-3 scrollbar-thin pr-1"
              onClick={() => { setReactingIdx(null); setActiveMsg(null) }}
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
                    <div className={`flex flex-col gap-0.5 max-w-[85%] sm:max-w-[75%] ${group.self ? 'items-end' : 'items-start'}`}>
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
                          <div key={`${msg.time}-${i}`} className="relative group/msg w-full">
                            <div
                              className={`
                                px-3 py-2 space-y-1 transition-colors
                                ${group.self
                                  ? `bg-accent/10 border border-accent/20 hover:bg-accent/15
                                     ${isFirst && isLast ? 'rounded-2xl rounded-tr-md' : isFirst ? 'rounded-t-2xl rounded-tr-md rounded-b-md' : isLast ? 'rounded-b-2xl rounded-t-md' : 'rounded-md'}`
                                  : `bg-surface-2 border border-border hover:bg-surface-2/80
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
                                  onClick={(e) => { e.stopPropagation(); setViewImage(msg.image) }} 
                                />
                              )}

                              {msg.text && (
                                <p className="text-[13px] text-text break-words leading-relaxed">
                                  <Linkify text={msg.text} />
                                </p>
                              )}

                              {/* Show time only on last message or if time gaps */}
                              {isLast && (
                                <p className="text-[9px] text-muted/60 font-mono mt-1">
                                  {formatRelativeTime(msg.time)}
                                </p>
                              )}
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

                            {/* Action buttons — visible on hover/tap */}
                            {onReaction && (
                              <div className={`
                                absolute ${group.self ? 'left-0 -translate-x-full pr-1.5' : 'right-0 translate-x-full pl-1.5'} top-1/2 -translate-y-1/2
                                flex items-center gap-1 transition-all duration-200
                                ${showActions ? 'opacity-100 scale-100' : 'opacity-0 scale-95 sm:group-hover/msg:opacity-100 sm:group-hover/msg:scale-100 pointer-events-none sm:pointer-events-auto'}
                              `}>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setReactingIdx(reactingIdx === i ? null : i) }}
                                  className="p-1.5 rounded-lg bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors shadow-sm"
                                >
                                  <Smile className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setReplyTo({ text: msg.text, from: msg.from, time: msg.time }); setActiveMsg(null) }}
                                  className="p-1.5 rounded-lg bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors shadow-sm"
                                >
                                  <Reply className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            )}

                            {/* Emoji picker */}
                            {reactingIdx === i && (
                              <div 
                                className={`
                                  absolute z-20 ${group.self ? 'right-0' : 'left-0'} 
                                  ${i < 3 ? 'top-full mt-2' : 'bottom-full mb-2'}
                                  bg-surface border border-border rounded-xl p-2 shadow-xl shadow-black/40
                                `}
                              >
                                <div className="grid grid-cols-6 gap-1">
                                  {EMOJIS.map(emoji => (
                                    <button
                                      key={emoji}
                                      onClick={(e) => { e.stopPropagation(); onReaction(msgId, emoji); setReactingIdx(null); setActiveMsg(null) }}
                                      className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent/10 hover:scale-110 active:scale-95 transition-all text-lg"
                                    >
                                      {emoji}
                                    </button>
                                  ))}
                                </div>
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

            {/* Typing indicator */}
            {typingText && (
              <div className="flex items-center gap-2 px-1">
                <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-full bg-surface-2/50 border border-border/50">
                  <span className="font-mono text-[10px] text-muted-light">{typingText}</span>
                  <TypingDots />
                </div>
              </div>
            )}

            {/* Reply preview */}
            {replyTo && (
              <div className="flex items-center gap-2 bg-accent/5 border border-accent/20 rounded-xl px-3 py-2 animate-fade-in-up">
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
              <div className="relative inline-block animate-fade-in-up">
                <img src={imagePreview} alt="Upload preview" className="h-24 rounded-xl border border-border shadow-sm object-cover" />
                <button
                  onClick={() => setImagePreview(null)}
                  className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-danger text-white flex items-center justify-center shadow-md hover:bg-danger/90 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Input */}
            <form onSubmit={handleSend} className="flex gap-2 items-end">
              <div className="flex-1 relative">
                <input
                  ref={textInputRef}
                  type="text"
                  value={text}
                  onChange={handleTyping}
                  placeholder={disabled ? 'Connect to chat' : 'Type a message...'}
                  maxLength={2000}
                  disabled={disabled}
                  className="w-full bg-bg border border-border rounded-2xl px-4 py-3 pr-12 font-mono text-sm text-text
                    placeholder:text-muted/40 focus:outline-none focus:border-accent/40 focus:ring-2 focus:ring-accent/10 transition-all
                    disabled:opacity-40 disabled:cursor-not-allowed min-h-[48px]"
                />
                <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImagePick} className="hidden" />
                <button
                  type="button"
                  onClick={() => imageInputRef.current?.click()}
                  disabled={disabled}
                  aria-label="Attach image"
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-lg text-muted/60 
                    hover:text-accent hover:bg-accent/10 active:scale-95 transition-all
                    disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ImagePlus className="w-4 h-4" />
                </button>
              </div>
              <button
                type="submit"
                disabled={disabled || (!text.trim() && !imagePreview)}
                aria-label="Send message"
                className={`shrink-0 w-12 h-12 rounded-2xl flex items-center justify-center transition-all
                  ${!disabled && (text.trim() || imagePreview)
                    ? 'bg-accent text-bg hover:bg-accent-dim active:scale-95 shadow-lg shadow-accent/20'
                    : 'bg-surface border border-border text-muted/40 cursor-not-allowed'
                  }`}
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
      {viewImage && createPortal(
        <div className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-4" onClick={() => setViewImage(null)} onKeyDown={(e) => e.key === 'Escape' && setViewImage(null)} role="dialog" aria-label="Image preview">
          <div className="absolute top-4 right-4 flex gap-2 z-10">
            <a
              href={viewImage}
              download="image.jpg"
              onClick={(e) => e.stopPropagation()}
              className="px-4 py-2.5 rounded-lg font-mono text-sm bg-accent text-bg hover:bg-accent-dim transition-colors min-h-[44px] flex items-center"
            >
              Save
            </a>
            <button
              onClick={() => setViewImage(null)}
              autoFocus
              aria-label="Close preview"
              className="px-4 py-2.5 rounded-lg font-mono text-sm bg-surface border border-border text-text hover:border-border-hover transition-colors min-h-[44px]"
            >
              Close
            </button>
          </div>
          <img src={viewImage} alt="Preview" className="max-w-full max-h-[85vh] object-contain rounded-lg" onClick={(e) => e.stopPropagation()} />
        </div>,
        document.body
      )}
    </div>
  )
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
