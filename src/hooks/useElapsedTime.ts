import { useState, useEffect, useRef } from 'react'

export function useElapsedTime(active: boolean): number {
  const [elapsed, setElapsed] = useState<number>(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    if (!active) {
      startRef.current = null
      setElapsed(0)
      return
    }

    if (!startRef.current) startRef.current = Date.now()

    const interval = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startRef.current!) / 1000))
    }, 1000)

    return () => clearInterval(interval)
  }, [active])

  return elapsed
}

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
