import { useEffect, useState } from 'react'

export interface Viewport {
  width: number
  height: number
  isMobile: boolean
  isPortrait: boolean
}

const MOBILE_BREAKPOINT = 720

function read(): Viewport {
  if (typeof window === 'undefined') {
    return { width: 0, height: 0, isMobile: false, isPortrait: false }
  }
  const width = window.innerWidth
  const height = window.innerHeight
  const isMobile = width < MOBILE_BREAKPOINT
  return {
    width,
    height,
    isMobile,
    isPortrait: isMobile && height > width,
  }
}

// Tracks the window's size and derives `isMobile` / `isPortrait` flags.
// Subscribes to both resize and orientationchange so mobile rotation
// updates immediately.
export function useViewport(): Viewport {
  const [viewport, setViewport] = useState<Viewport>(() => read())
  useEffect(() => {
    const update = (): void => setViewport(read())
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
    }
  }, [])
  return viewport
}
