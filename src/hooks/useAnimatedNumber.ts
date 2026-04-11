import { useState, useEffect, useRef } from 'react'

export function useAnimatedNumber(target: number, duration: number = 150): number {
  const [display, setDisplay] = useState<number>(target)
  const frameRef = useRef<number | null>(null)
  const fromRef = useRef<number>(target)

  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    fromRef.current = display

    const start = performance.now()

    function tick(now: number): void {
      const t = Math.min((now - start) / duration, 1)
      setDisplay(Math.round(from + (target - from) * t))
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [target, duration])

  return display
}
