import React from 'react'
import { createPortal } from 'react-dom'
import { Volume2, VolumeX, Bell, BellOff, Trash2, Check } from 'lucide-react'
import { canNotify, requestNotificationPermission } from '../../utils/notifications'
import type { MenuPos } from '../../hooks/useChatPanelState'

interface ChatMenuProps {
  menuPos: MenuPos
  menuRef: React.RefObject<HTMLDivElement | null>
  onNicknameChange?: ((name: string) => void) | null
  editName: string
  setEditName: (name: string) => void
  nameChanged: boolean | string
  nameSaved: boolean
  handleSetName: () => void
  closeMenu: () => void
  soundEnabled: boolean
  setSoundEnabled: (fn: (v: boolean) => boolean) => void
  notifyEnabled: boolean
  setNotifyEnabled: (v: boolean | ((v: boolean) => boolean)) => void
  onMicError: (msg: string) => void
  hasMessages: boolean
  onClearMessages?: (() => void) | null
  onRequestClear: () => void
}

export default function ChatMenu({
  menuPos, menuRef, onNicknameChange, editName, setEditName, nameChanged, nameSaved, handleSetName, closeMenu,
  soundEnabled, setSoundEnabled, notifyEnabled, setNotifyEnabled, onMicError, hasMessages, onClearMessages, onRequestClear,
}: ChatMenuProps) {
  return createPortal(
    <div
      ref={menuRef}
      className="fixed w-56 bg-surface border border-border rounded-xl shadow-xl overflow-hidden animate-fade-in-up"
      style={{ top: `${menuPos.top}px`, right: `${menuPos.right}px`, zIndex: 9999 }}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
    >
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
                onClick={() => { handleSetName(); closeMenu() }}
                className="shrink-0 p-2 rounded-lg bg-accent text-bg active:scale-95 transition-transform"
              >
                <Check className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[10px] text-muted">{editName.length}/20</span>
            {nameSaved && <span className="text-xs text-accent">Saved</span>}
          </div>
        </div>
      )}

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
              if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
                onMicError('Notifications blocked — enable in your browser site settings.')
                return
              }
              const granted = await requestNotificationPermission()
              if (granted) setNotifyEnabled(true)
            } else {
              setNotifyEnabled((n: boolean) => !n)
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

      {onClearMessages && hasMessages && (
        <>
          <div className="border-t border-border" />
          <button
            onClick={onRequestClear}
            className="w-full flex items-center gap-3 px-4 py-3 text-danger active:bg-danger/10 transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            <span className="font-mono text-sm">Clear Messages</span>
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
