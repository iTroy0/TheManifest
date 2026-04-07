import { useState, useEffect, useRef } from 'react'

export function useAnimatedNumber(target, duration = 400) {
  const [display, setDisplay] = useState(target)
  const frameRef = useRef(null)
  const startRef = useRef(null)
  const fromRef = useRef(target)

  useEffect(() => {
    const from = fromRef.current
    if (from === target) return

    const start = performance.now()
    startRef.current = start

    function tick(now) {
      const elapsed = now - start
      const t = Math.min(elapsed / duration, 1)
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3)
      const current = Math.round(from + (target - from) * eased)
      setDisplay(current)

      if (t < 1) {
        frameRef.current = requestAnimationFrame(tick)
      } else {
        fromRef.current = target
      }
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [target, duration])

  return display
}
