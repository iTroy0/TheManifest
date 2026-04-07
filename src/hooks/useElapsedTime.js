import { useState, useEffect, useRef } from 'react'

export function useElapsedTime(active) {
  const [elapsed, setElapsed] = useState(0)
  const startRef = useRef(null)

  useEffect(() => {
    if (!active) {
      startRef.current = null
      return
    }

    if (!startRef.current) startRef.current = Date.now()

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [active])

  return elapsed
}

export function formatElapsed(seconds) {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
