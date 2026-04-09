import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { MessageCircle, Send, ChevronDown, Users, Check, ImagePlus, X, Reply } from 'lucide-react'

const EMOJIS = ['👍', '❤️', '😂', '😮', '🔥', '👎']
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
  const scrollRef = useRef(null)
  const prevLen = useRef(messages.length)
  const imageInputRef = useRef(null)
  const typingTimer = useRef(null)
  const longPressTimer = useRef(null)

  useEffect(() => {
    if (nickname) setEditName(nickname)
  }, [nickname])

  useEffect(() => {
    if (messages.length > prevLen.current) {
      if (open && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      if (!open) {
        setUnread(u => u + (messages.length - prevLen.current))
      }
    }
    prevLen.current = messages.length
  }, [messages.length, open])

  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

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
      ? `${typingUsers[0]} is typing...`
      : `${typingUsers.slice(0, 2).join(', ')} ${typingUsers.length > 2 ? `+${typingUsers.length - 2} ` : ''}typing...`
    : null

  return (
    <div className="glow-card overflow-hidden animate-fade-in-up">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 text-left group"
      >
        <div className="flex items-center gap-2">
          <MessageCircle className="w-3.5 h-3.5 text-accent" />
          <span className="font-mono text-xs text-accent uppercase tracking-widest">Chat</span>
          {onlineCount > 0 && (
            <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
              <Users className="w-3 h-3 text-accent" />
              <span className="font-mono text-[9px] text-accent">{onlineCount}</span>
            </div>
          )}
          {unread > 0 && (
            <span className="flex items-center justify-center min-w-[18px] h-[18px] rounded-full bg-accent text-bg font-mono text-[10px] font-bold px-1">
              {unread}
            </span>
          )}
        </div>
        <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>

      <div className={`grid transition-all duration-400 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-3 sm:px-4 pb-4 space-y-3">
            {/* Nickname editor */}
            {onNicknameChange && (
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-muted-light shrink-0">Nickname:</span>
                <input
                  type="text"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  maxLength={20}
                  className="w-28 bg-bg border border-border rounded-lg px-2.5 py-1.5 font-mono text-xs text-accent
                    focus:outline-none focus:border-accent/40 transition-colors"
                />
                {nameChanged && (
                  <button
                    onClick={handleSetName}
                    className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-lg font-mono text-[10px]
                      bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                  >
                    <Check className="w-3 h-3" />
                    Set
                  </button>
                )}
              </div>
            )}

            {/* Messages */}
            <div
              ref={scrollRef}
              className="max-h-[min(50vh,400px)] min-h-[150px] overflow-y-auto space-y-2 scrollbar-thin pr-1"
              onClick={() => { setReactingIdx(null); setActiveMsg(null) }}
            >
              {messages.length === 0 && (
                <p className="text-center text-xs text-muted py-8 font-mono">No messages yet</p>
              )}
              {messages.map((msg, i) => {
                const msgKey = `${msg.time}-${msg.from}-${i}`
                const msgId = `${msg.time}`
                const showActions = activeMsg === i

                if (msg.from === 'system') {
                  return (
                    <div key={msgKey} className="text-center">
                      <span className="font-mono text-xs text-muted">{msg.text}</span>
                    </div>
                  )
                }

                return (
                  <div key={msgKey} className={`flex ${msg.self ? 'justify-end' : 'justify-start'}`}>
                    <div className="relative max-w-[85%] sm:max-w-[80%]">
                      <div
                        className={`
                          rounded-xl px-3 py-2 space-y-1
                          ${msg.self
                            ? 'bg-accent/10 border border-accent/20 rounded-tr-sm'
                            : 'bg-surface-2 border border-border rounded-tl-sm'
                          }
                        `}
                        onClick={(e) => { e.stopPropagation(); handleMsgClick(i) }}
                        onTouchStart={() => handleTouchStart(i)}
                        onTouchEnd={handleTouchEnd}
                      >
                        {!msg.self && (
                          <p className="font-mono text-[10px] text-accent/70">{msg.from}</p>
                        )}

                        {msg.replyTo && (
                          <div className="border-l-2 border-accent/30 pl-2 mb-1">
                            <p className="font-mono text-[9px] text-accent/50">{msg.replyTo.from}</p>
                            <p className="text-xs text-muted truncate">{msg.replyTo.text || '📷 Image'}</p>
                          </div>
                        )}

                        {msg.image && (
                          <img src={msg.image} alt="" className="rounded-lg max-w-full max-h-[200px] object-contain cursor-pointer hover:opacity-80 transition-opacity" onClick={(e) => { e.stopPropagation(); setViewImage(msg.image) }} />
                        )}

                        {msg.text && <p className="text-sm text-text break-words"><Linkify text={msg.text} /></p>}

                        <p className="text-[10px] text-muted-light font-mono">
                          {new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>

                      {/* Reactions display */}
                      {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {Object.entries(msg.reactions).map(([emoji, users]) => (
                            <span key={emoji} className="inline-flex items-center gap-0.5 bg-surface-2 border border-border rounded-full px-1.5 py-0.5 text-[10px] cursor-default" title={users.join(', ')}>
                              {emoji} <span className="font-mono text-muted-light">{users.length}</span>
                            </span>
                          ))}
                        </div>
                      )}

                      {/* Action buttons — tap on mobile, hover on desktop */}
                      {onReaction && msg.from !== 'system' && (
                        <div className={`
                          absolute ${msg.self ? 'left-0 -translate-x-full pr-1' : 'right-0 translate-x-full pl-1'} top-0
                          flex items-center gap-0.5 transition-opacity
                          ${showActions ? 'opacity-100' : 'opacity-0 sm:group-hover/msg:opacity-100 pointer-events-none sm:pointer-events-auto'}
                        `}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setReactingIdx(reactingIdx === i ? null : i) }}
                            className="p-1.5 rounded-md bg-surface border border-border text-muted hover:text-text transition-colors text-xs"
                          >
                            😀
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setReplyTo({ text: msg.text, from: msg.from, time: msg.time }); setActiveMsg(null) }}
                            className="p-1.5 rounded-md bg-surface border border-border text-muted hover:text-text transition-colors"
                          >
                            <Reply className="w-3 h-3" />
                          </button>
                        </div>
                      )}

                      {/* Emoji picker — below for first 2 messages, above for rest */}
                      {reactingIdx === i && (
                        <div className={`absolute ${msg.self ? 'right-0' : 'left-0'} ${i < 2 ? 'top-full mt-1' : '-top-10'} flex gap-1 bg-surface border border-border rounded-xl px-2 py-1.5 shadow-lg shadow-black/30 z-10`}>
                          {EMOJIS.map(emoji => (
                            <button
                              key={emoji}
                              onClick={(e) => { e.stopPropagation(); onReaction(msgId, emoji); setReactingIdx(null); setActiveMsg(null) }}
                              className="hover:scale-125 active:scale-110 transition-transform text-base p-0.5"
                            >
                              {emoji}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Typing indicator */}
            {typingText && (
              <p className="font-mono text-[10px] text-muted-light animate-pulse">{typingText}</p>
            )}

            {/* Reply preview */}
            {replyTo && (
              <div className="flex items-center gap-2 bg-surface-2 border border-border rounded-lg px-3 py-2">
                <Reply className="w-3 h-3 text-accent shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="font-mono text-[9px] text-accent">{replyTo.from}</p>
                  <p className="text-xs text-muted truncate">{replyTo.text || '📷 Image'}</p>
                </div>
                <button onClick={() => setReplyTo(null)} className="text-muted hover:text-text transition-colors p-1">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}

            {/* Image preview */}
            {imagePreview && (
              <div className="relative inline-block">
                <img src={imagePreview} alt="" className="h-20 rounded-lg border border-border" />
                <button
                  onClick={() => setImagePreview(null)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-danger text-white flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            )}

            {/* Input */}
            <form onSubmit={handleSend} className="flex gap-1.5">
              <input
                type="text"
                value={text}
                onChange={handleTyping}
                placeholder={disabled ? 'Connect to chat' : 'Message...'}
                maxLength={2000}
                disabled={disabled}
                className="flex-1 bg-bg border border-border rounded-xl px-3 py-2.5 font-mono text-sm text-text
                  placeholder:text-muted/40 focus:outline-none focus:border-accent/40 transition-colors
                  disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
              />
              <input ref={imageInputRef} type="file" accept="image/*" onChange={handleImagePick} className="hidden" />
              <button
                type="button"
                onClick={() => imageInputRef.current?.click()}
                disabled={disabled}
                aria-label="Send image"
                className="shrink-0 w-[44px] h-[44px] rounded-xl bg-accent/10 text-accent/70
                  hover:text-accent hover:bg-accent/20 active:bg-accent/25 transition-colors flex items-center justify-center
                  disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <ImagePlus className="w-4 h-4" />
              </button>
              <button
                type="submit"
                disabled={disabled || (!text.trim() && !imagePreview)}
                aria-label="Send message"
                className="shrink-0 w-[44px] h-[44px] rounded-xl bg-accent/10 text-accent
                  hover:bg-accent/20 active:bg-accent/25 transition-colors flex items-center justify-center
                  disabled:opacity-30 disabled:cursor-not-allowed"
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
