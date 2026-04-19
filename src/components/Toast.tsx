import { useState, useEffect } from 'react'
import { Check } from 'lucide-react'

interface ToastProps {
  message: string
  visible: boolean
  onHide: () => void
  duration?: number
}

export default function Toast({ message, visible, onHide, duration = 3500 }: ToastProps) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (visible) {
      setShow(true)
      // H15 — depend on `message` too. If the parent re-triggers the toast
      // with a new message while an older timer is still running, cleanup
      // clears the stale timer and a fresh duration starts; otherwise the
      // old timer would hide the new message early.
      const timer = setTimeout(() => {
        setShow(false)
        setTimeout(onHide, 300) // wait for exit animation
      }, duration)
      return () => clearTimeout(timer)
    }
  }, [visible, onHide, message])

  if (!visible && !show) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className={`
      fixed top-6 left-1/2 -translate-x-1/2 z-50
      flex items-center gap-2 bg-surface border border-accent/30 rounded-xl px-4 py-2.5
      shadow-lg shadow-accent/10
      transition-all duration-300
      ${show ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-3'}
    `}>
      <Check className="w-4 h-4 text-accent" />
      <span className="font-mono text-xs text-text">{message}</span>
    </div>
  )
}
