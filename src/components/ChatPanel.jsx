import { useState, useRef, useEffect } from 'react'
import { MessageCircle, Send, ChevronDown } from 'lucide-react'

export default function ChatPanel({ messages, onSend, disabled }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [unread, setUnread] = useState(0)
  const scrollRef = useRef(null)
  const prevLen = useRef(messages.length)

  // Auto-scroll + unread badge
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

  // Clear unread when opening
  useEffect(() => {
    if (open) setUnread(0)
  }, [open])

  function handleSend(e) {
    e.preventDefault()
    if (!text.trim() || disabled) return
    onSend(text)
    setText('')
  }

  return (
    <div className="glow-card overflow-hidden animate-fade-in-up">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 text-left group"
      >
        <div className="flex items-center gap-2">
          <MessageCircle className="w-3.5 h-3.5 text-accent" />
          <span className="font-mono text-xs text-accent uppercase tracking-widest">Chat</span>
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
          <div className="px-4 pb-4 space-y-3">
            {/* Messages */}
            <div
              ref={scrollRef}
              className="h-[200px] overflow-y-auto space-y-2 scrollbar-thin pr-1"
            >
              {messages.length === 0 && (
                <p className="text-center text-xs text-muted py-8 font-mono">No messages yet</p>
              )}
              {messages.map((msg, i) => (
                <div key={i} className={`flex ${msg.from === 'sender' ? 'justify-start' : 'justify-end'}`}>
                  <div className={`
                    max-w-[80%] rounded-xl px-3 py-2 space-y-0.5
                    ${msg.from === 'sender'
                      ? 'bg-surface-2 border border-border rounded-tl-sm'
                      : 'bg-accent/10 border border-accent/20 rounded-tr-sm'
                    }
                  `}>
                    <p className="text-sm text-text break-words">{msg.text}</p>
                    <p className="text-[9px] text-muted font-mono">
                      {new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </p>
                  </div>
                </div>
              ))}
            </div>

            {/* Input */}
            <form onSubmit={handleSend} className="flex gap-2">
              <input
                type="text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={disabled ? 'Connect to chat' : 'Type a message...'}
                disabled={disabled}
                className="flex-1 bg-bg border border-border rounded-xl px-3 py-2.5 font-mono text-sm text-text
                  placeholder:text-muted/40 focus:outline-none focus:border-accent/40 transition-colors
                  disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]"
              />
              <button
                type="submit"
                disabled={disabled || !text.trim()}
                className="shrink-0 w-[44px] h-[44px] rounded-xl bg-accent/10 text-accent
                  hover:bg-accent/20 transition-colors flex items-center justify-center
                  disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}
