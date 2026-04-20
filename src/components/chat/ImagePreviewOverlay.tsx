import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export interface ViewImage {
  url?: string
  mime?: string
}

interface ImagePreviewOverlayProps {
  viewImage: ViewImage
  onClose: () => void
}

// Given a data-URL or a mime type, pick a reasonable filename for the
// Save button. Normalises JPEG → jpg and svg+xml → svg.
function imageFilename(url: string, mime: string | undefined): string {
  const dataMatch = /^data:image\/([a-z0-9+.-]+)/i.exec(url || '')
  if (dataMatch) {
    let ext = dataMatch[1].toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (ext === 'svg+xml') ext = 'svg'
    return `image.${ext}`
  }
  if (mime) {
    let ext = (mime.split('/')[1] || 'jpg').toLowerCase()
    if (ext === 'jpeg') ext = 'jpg'
    if (ext === 'svg+xml') ext = 'svg'
    return `image.${ext}`
  }
  return 'image.jpg'
}

export default function ImagePreviewOverlay({ viewImage, onClose }: ImagePreviewOverlayProps) {
  const [showControls, setShowControls] = useState(true)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    return () => clearTimeout(hideTimer.current!)
  }, [])

  useEffect(() => {
    if (overlayRef.current) {
      overlayRef.current.focus()
    }
  }, [])

  function handleTap(e: React.MouseEvent<HTMLDivElement>): void {
    if ((e.target as HTMLElement).closest('a') || (e.target as HTMLElement).closest('button')) return
    clearTimeout(hideTimer.current!)
    if (showControls) {
      setShowControls(false)
    } else {
      setShowControls(true)
      hideTimer.current = setTimeout(() => setShowControls(false), 3000)
    }
  }

  const handleDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'Tab') {
      e.preventDefault() // Keep focus trapped on the dialog
    }
  }

  const imgUrl = viewImage.url ?? ''

  return createPortal(
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[9999] bg-black/90 flex flex-col items-center justify-center p-4"
      onClick={handleTap}
      onKeyDown={handleDialogKeyDown}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
      tabIndex={-1}
    >
      <div className={`absolute top-4 right-4 flex gap-2 z-10 transition-opacity duration-300 ${showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
        <a
          href={imgUrl}
          download={imageFilename(imgUrl, viewImage.mime)}
          onClick={(e: React.MouseEvent) => e.stopPropagation()}
          className="px-4 py-2.5 rounded-lg font-mono text-sm bg-accent text-bg hover:bg-accent-dim transition-colors min-h-[44px] flex items-center"
        >
          Save
        </a>
        <button
          onClick={onClose}
          autoFocus
          aria-label="Close preview"
          className="px-4 py-2.5 rounded-lg font-mono text-sm bg-surface border border-border text-text hover:border-border-hover transition-colors min-h-[44px]"
        >
          Close
        </button>
      </div>
      <img src={imgUrl} alt="Preview" className="max-w-full max-h-[85vh] object-contain rounded-lg" />
    </div>,
    document.body,
  )
}
