import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { Trash2 } from 'lucide-react'

interface ChatClearConfirmProps {
  onCancel: () => void
  onConfirm: () => void
}

export default function ChatClearConfirm({ onCancel, onConfirm }: ChatClearConfirmProps) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onCancel(); return }
    if (e.key === 'Tab') {
      const root = dialogRef.current
      if (!root) return
      const focusables = root.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')
      if (focusables.length === 0) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[10000] bg-black/70 flex items-center justify-center p-4 animate-fade-in-up"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
      role="dialog"
      aria-modal="true"
      aria-labelledby="clear-confirm-title"
      tabIndex={-1}
    >
      <div className="glass-strong rounded-2xl shadow-2xl max-w-sm w-full p-6 space-y-4" onClick={(e: React.MouseEvent) => e.stopPropagation()}>
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
            onClick={onCancel}
            className="px-4 py-2 rounded-xl font-mono text-sm bg-surface border border-border text-muted hover:text-text hover:border-border-hover transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="px-4 py-2 rounded-xl font-mono text-sm bg-danger text-white hover:bg-danger/90 active:scale-95 transition-all"
          >
            Clear
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
