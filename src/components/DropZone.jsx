import { useState, useRef, useEffect, useCallback } from 'react'
import { Upload, MousePointerClick, Clipboard } from 'lucide-react'

export default function DropZone({ onFiles, disabled }) {
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)
  const dragCounter = useRef(0)

  useEffect(() => {
    if (disabled) return
    function handlePaste(e) {
      const files = Array.from(e.clipboardData?.files || [])
      if (files.length) {
        e.preventDefault()
        onFiles(files)
      }
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [disabled, onFiles])

  function handleDragEnter(e) {
    e.preventDefault()
    dragCounter.current++
    if (!disabled) setDragging(true)
  }

  function handleDragOver(e) {
    e.preventDefault()
  }

  function handleDragLeave(e) {
    e.preventDefault()
    dragCounter.current--
    if (dragCounter.current === 0) setDragging(false)
  }

  function handleDrop(e) {
    e.preventDefault()
    dragCounter.current = 0
    setDragging(false)
    if (disabled) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length) onFiles(files)
  }

  function handleClick() {
    if (!disabled) inputRef.current?.click()
  }

  function handleInput(e) {
    const files = Array.from(e.target.files)
    if (files.length) onFiles(files)
    e.target.value = ''
  }

  return (
    <>
      <input ref={inputRef} type="file" multiple onChange={handleInput} className="hidden" />
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={handleClick}
        className={`
          relative rounded-2xl text-center cursor-pointer overflow-hidden
          transition-all duration-400 group mobile-full-drop
          ${disabled
            ? 'border border-border/50 opacity-40 cursor-not-allowed py-8 px-8'
            : dragging
              ? 'border-2 border-accent bg-accent/5 py-8 px-8 scale-[1.01] animate-pulse-glow'
              : 'border-2 border-dashed border-border/60 hover:border-accent/50 py-8 px-8'
          }
        `}
      >
        {/* Subtle gradient overlay on hover */}
        {!disabled && (
          <div className={`absolute inset-0 transition-opacity duration-500 pointer-events-none
            ${dragging ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}
          `}>
            <div className="absolute inset-0 bg-gradient-to-b from-accent/[0.03] to-transparent" />
            <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-3/4 h-24 bg-accent/5 blur-3xl" />
          </div>
        )}

        <div className={`relative transition-transform duration-300 ${dragging ? 'scale-105' : ''}`}>
          {/* Icon container with ring effect */}
          <div className={`
            relative w-14 h-14 mx-auto mb-4 rounded-2xl flex items-center justify-center transition-all duration-400
            ${dragging 
              ? 'bg-accent/20 text-accent ring-4 ring-accent/20' 
              : disabled 
                ? 'bg-surface-2 text-muted' 
                : 'bg-surface-2 text-muted group-hover:text-accent group-hover:bg-accent/10 group-hover:ring-4 group-hover:ring-accent/10'
            }
          `}>
            <Upload className={`w-6 h-6 transition-transform duration-300 ${dragging ? 'animate-bounce' : ''}`} strokeWidth={1.5} />
          </div>

          {disabled ? (
            <p className="font-mono text-sm text-muted">Portal is active</p>
          ) : dragging ? (
            <p className="font-mono text-base text-accent text-glow font-medium">Release to add files</p>
          ) : (
            <>
              <p className="font-mono text-base text-text font-medium mb-3">Drop files to share</p>
              <div className="flex items-center justify-center gap-4 text-muted flex-wrap">
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2/50 hover:bg-surface-2 transition-colors">
                  <MousePointerClick className="w-3.5 h-3.5" />
                  <p className="font-mono text-xs">browse</p>
                </div>
                <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-2/50 hover:bg-surface-2 transition-colors">
                  <Clipboard className="w-3.5 h-3.5" />
                  <p className="font-mono text-xs">paste</p>
                </div>
              </div>
              <p className="font-mono text-[10px] text-muted/70 mt-4">
                Any file type &bull; No size limit &bull; End-to-end encrypted
              </p>
            </>
          )}
        </div>
      </div>
    </>
  )
}
