import React from 'react'
import { MessageCircle, ChevronDown, Trash2, Maximize2, Minimize2, MoreVertical, ExternalLink } from 'lucide-react'

interface ChatHeaderCommonProps {
  onlineCount?: number
  hasMessages: boolean
  hasClear: boolean
  onRequestClear: () => void
}

interface ChatHeaderPopoutProps extends ChatHeaderCommonProps {
  onDragStart: (e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>) => void
  onResizeStart: (e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>) => void
  onFullscreen: () => void
  onDock: () => void
}

export function ChatHeaderPopout({ onlineCount, hasMessages, hasClear, onRequestClear, onDragStart, onResizeStart, onFullscreen, onDock }: ChatHeaderPopoutProps) {
  return (
    <div
      className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0 bg-surface/80 backdrop-blur-sm cursor-move select-none relative"
      onMouseDown={onDragStart}
      onTouchStart={onDragStart}
    >
      <div
        className="absolute -top-1 -left-1 w-5 h-5 cursor-nw-resize z-10 flex items-center justify-center opacity-40 hover:opacity-100 transition-opacity"
        onMouseDown={onResizeStart}
        onTouchStart={onResizeStart}
        title="Resize"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-muted">
          <line x1="0" y1="10" x2="10" y2="0" stroke="currentColor" strokeWidth="1.5" />
          <line x1="0" y1="6" x2="6" y2="0" stroke="currentColor" strokeWidth="1.5" />
          <line x1="0" y1="2" x2="2" y2="0" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl glass-accent flex items-center justify-center">
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
        {hasClear && hasMessages && (
          <button
            onClick={onRequestClear}
            className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
            title="Clear messages"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        )}
        <button
          onClick={onFullscreen}
          className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
          title="Fullscreen"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        <button
          onClick={onDock}
          className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
          title="Minimize"
        >
          <Minimize2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}

interface ChatHeaderFullscreenProps {
  onlineCount?: number
  isPopout: boolean
  onExitFullscreen: () => void
  menuTriggerRef: React.RefObject<HTMLButtonElement | null>
  onMenuTriggerClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}

export function ChatHeaderFullscreen({ onlineCount, isPopout, onExitFullscreen, menuTriggerRef, onMenuTriggerClick }: ChatHeaderFullscreenProps) {
  return (
    <div
      className="flex items-center justify-between px-2 border-b border-border shrink-0 bg-surface/80 backdrop-blur-sm"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 8px)', paddingBottom: '8px' }}
    >
      <button
        onClick={onExitFullscreen}
        className="flex items-center gap-0.5 px-2 py-2 rounded-xl text-accent active:bg-accent/10 transition-colors"
      >
        {isPopout ? <Minimize2 className="w-5 h-5" /> : <ChevronDown className="w-5 h-5 rotate-90" />}
        <span className="font-mono text-sm font-medium">{isPopout ? 'Minimize' : 'Back'}</span>
      </button>

      <div className="absolute left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none">
        <span className="font-mono text-base text-text font-semibold">Chat</span>
        {onlineCount != null && onlineCount > 0 && (
          <div className="flex items-center gap-1">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            <span className="font-mono text-[10px] text-muted">{onlineCount} online</span>
          </div>
        )}
      </div>

      <button
        ref={menuTriggerRef}
        data-menu-trigger
        onClick={onMenuTriggerClick}
        className="p-2.5 rounded-xl text-muted active:bg-surface-2 transition-colors"
        type="button"
      >
        <MoreVertical className="w-5 h-5" />
      </button>
    </div>
  )
}

interface ChatHeaderCollapsedProps extends ChatHeaderCommonProps {
  open: boolean
  unread: number
  onToggleOpen: () => void
  onPopOut: () => void
  onFullscreen: () => void
}

export function ChatHeaderCollapsed({ open, unread, onlineCount, hasMessages, hasClear, onRequestClear, onToggleOpen, onPopOut, onFullscreen }: ChatHeaderCollapsedProps) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onToggleOpen}
      onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onToggleOpen()
        }
      }}
      className="w-full flex items-center justify-between p-4 text-left group hover:bg-surface-2/30 transition-colors cursor-pointer"
    >
      <div className="flex items-center gap-3">
        <div className="relative">
          <div className="w-8 h-8 rounded-xl glass-accent flex items-center justify-center">
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
        {hasClear && hasMessages && (
          <button
            onClick={(e: React.MouseEvent) => { e.stopPropagation(); onRequestClear() }}
            className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
            title="Clear messages"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
        <button
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onPopOut() }}
          className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors hidden sm:flex"
          title="Pop out chat"
        >
          <ExternalLink className="w-4 h-4" />
        </button>
        <button
          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onFullscreen() }}
          className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
          title="Fullscreen chat"
        >
          <Maximize2 className="w-4 h-4" />
        </button>
        <ChevronDown className={`w-5 h-5 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
      </div>
    </div>
  )
}
