import { useState, useEffect } from 'react'
import { Check } from 'lucide-react'

export default function Toast({ message, visible, onHide }) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (visible) {
      setShow(true)
      const timer = setTimeout(() => {
        setShow(false)
        setTimeout(onHide, 300) // wait for exit animation
      }, 2500)
      return () => clearTimeout(timer)
    }
  }, [visible, onHide])

  if (!visible && !show) return null

  return (
    <div className={`
      fixed bottom-6 left-1/2 -translate-x-1/2 z-50
      flex items-center gap-2 bg-surface border border-accent/30 rounded-xl px-4 py-2.5
      shadow-lg shadow-accent/10
      transition-all duration-300
      ${show ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-3'}
    `}>
      <Check className="w-4 h-4 text-accent" />
      <span className="font-mono text-xs text-text">{message}</span>
    </div>
  )
}
