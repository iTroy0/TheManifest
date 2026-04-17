import { useCallback, useRef, useState, type MutableRefObject } from 'react'
import type React from 'react'

export interface PopoutPos {
  x: number
  y: number
}

export interface PopoutSize {
  w: number
  h: number
}

export interface UsePopoutOptions {
  defaultSize: PopoutSize
  minSize: PopoutSize
  // Fires after every popOut/dockBack transition with the new isPopout
  // value. Lets the consumer keep its own "panel open" state in sync
  // without having to remember to dispatch alongside every call.
  onToggle?: (isPopout: boolean) => void
}

export interface PopoutApi {
  isPopout: boolean
  pos: PopoutPos | null
  size: PopoutSize
  popOut: () => void
  dockBack: () => void
  onDragStart: (e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>) => void
  onResizeStart: (e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>) => void
  elementRef: MutableRefObject<HTMLDivElement | null>
}

// Encapsulates the draggable + resizable popout window pattern shared
// between CallPanel and (eventually) ChatPanel. The consumer supplies a
// default and minimum size; everything else — mouse/touch event wiring,
// position clamping to viewport, cleanup — lives here.
export function usePopout({ defaultSize, minSize, onToggle }: UsePopoutOptions): PopoutApi {
  const [isPopout, setIsPopout] = useState<boolean>(false)
  const [pos, setPos] = useState<PopoutPos | null>(null)
  const [size, setSize] = useState<PopoutSize>(defaultSize)
  const elementRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null)
  // Ref-mirror so popOut/dockBack don't need to depend on onToggle and
  // change identity whenever the consumer defines a fresh inline callback.
  const onToggleRef = useRef(onToggle)
  onToggleRef.current = onToggle

  const popOut = useCallback((): void => {
    setIsPopout(true)
    setPos({
      x: Math.round((window.innerWidth - defaultSize.w) / 2),
      y: Math.round((window.innerHeight - defaultSize.h) / 2),
    })
    onToggleRef.current?.(true)
  }, [defaultSize])

  const dockBack = useCallback((): void => {
    setIsPopout(false)
    setPos(null)
    setSize(defaultSize)
    onToggleRef.current?.(false)
  }, [defaultSize])

  const onDragStart = useCallback((e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>): void => {
    const el = elementRef.current
    if (!el) return
    const touch = (e as React.TouchEvent).touches
    const clientX = touch ? touch[0].clientX : (e as React.MouseEvent).clientX
    const clientY = touch ? touch[0].clientY : (e as React.MouseEvent).clientY
    const rect = el.getBoundingClientRect()
    dragRef.current = { startX: clientX, startY: clientY, origX: rect.left, origY: rect.top }

    const onMove = (ev: MouseEvent | TouchEvent): void => {
      const t = (ev as TouchEvent).touches
      const cx = t ? t[0].clientX : (ev as MouseEvent).clientX
      const cy = t ? t[0].clientY : (ev as MouseEvent).clientY
      const d = dragRef.current
      if (!d) return
      const dx = cx - d.startX
      const dy = cy - d.startY
      const nx = Math.max(0, Math.min(window.innerWidth - 100, d.origX + dx))
      const ny = Math.max(0, Math.min(window.innerHeight - 50, d.origY + dy))
      setPos({ x: nx, y: ny })
    }
    const onEnd = (): void => {
      dragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }, [])

  const onResizeStart = useCallback((e: React.MouseEvent<HTMLElement> | React.TouchEvent<HTMLElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    const el = elementRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const startRight = rect.right
    const startBottom = rect.bottom

    const onMove = (ev: MouseEvent | TouchEvent): void => {
      ev.preventDefault()
      const t = (ev as TouchEvent).touches
      const cx = t ? t[0].clientX : (ev as MouseEvent).clientX
      const cy = t ? t[0].clientY : (ev as MouseEvent).clientY
      const newW = Math.max(minSize.w, Math.min(window.innerWidth - 16, startRight - cx))
      const newH = Math.max(minSize.h, Math.min(window.innerHeight - 32, startBottom - cy))
      setSize({ w: newW, h: newH })
      setPos({ x: startRight - newW, y: startBottom - newH })
    }
    const onEnd = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onEnd)
      window.removeEventListener('touchmove', onMove)
      window.removeEventListener('touchend', onEnd)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onEnd)
    window.addEventListener('touchmove', onMove, { passive: false })
    window.addEventListener('touchend', onEnd)
  }, [minSize])

  return { isPopout, pos, size, popOut, dockBack, onDragStart, onResizeStart, elementRef }
}
