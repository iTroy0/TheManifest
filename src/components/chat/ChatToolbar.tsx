import React from 'react'
import { Users, Check, Volume2, VolumeX, Bell, BellOff } from 'lucide-react'
import { canNotify, requestNotificationPermission } from '../../utils/notifications'

interface ChatToolbarProps {
  onNicknameChange?: ((name: string) => void) | null
  editName: string
  setEditName: (v: string) => void
  nameChanged: boolean | string
  nameSaved: boolean
  handleSetName: () => void
  soundEnabled: boolean
  setSoundEnabled: (fn: (v: boolean) => boolean) => void
  notifyEnabled: boolean
  setNotifyEnabled: (v: boolean | ((v: boolean) => boolean)) => void
}

// Non-fullscreen inline toolbar above the message list. Renders the
// nickname input + sound + notification toggles. Fullscreen mode uses
// ChatMenu instead.
export default function ChatToolbar({
  onNicknameChange, editName, setEditName, nameChanged, nameSaved, handleSetName,
  soundEnabled, setSoundEnabled, notifyEnabled, setNotifyEnabled,
}: ChatToolbarProps) {
  return (
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
          <span className="text-[10px] text-muted">{editName.length}/20</span>
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
          {nameSaved && <span className="text-xs text-accent">Saved</span>}
        </div>
      )}
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
              setNotifyEnabled((n: boolean) => !n)
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
  )
}
