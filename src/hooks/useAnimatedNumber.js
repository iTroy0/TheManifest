import { useState, useEffect, useRef } from 'react'

export function useAnimatedNumber(target, duration = 150) {
  const [display, setDisplay] = useState(target)
  const frameRef = useRef(null)
  const fromRef = useRef(target)

  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    fromRef.current = target

    const start = performance.now()

    function tick(now) {
      const t = Math.min((now - start) / duration, 1)
      setDisplay(Math.round(from + (target - from) * t))
      if (t < 1) frameRef.current = requestAnimationFrame(tick)
    }

    frameRef.current = requestAnimationFrame(tick)
    return () => { if (frameRef.current) cancelAnimationFrame(frameRef.current) }
  }, [target, duration])

  return display
}
