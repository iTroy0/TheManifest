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
          relative rounded-2xl text-center cursor-pointer
          transition-all duration-500 group mobile-full-drop
          ${disabled
            ? 'border border-border/50 opacity-40 cursor-not-allowed p-10'
            : dragging
              ? 'border-2 border-accent bg-accent/5 p-10 scale-[1.02] animate-pulse-glow'
              : 'border-2 border-dashed border-border hover:border-accent/40 p-10 hover:shadow-[0_0_30px_rgba(0,255,136,0.06)]'
          }
        `}
      >
        {!disabled && !dragging && (
          <div className="absolute inset-0 rounded-2xl bg-accent/0 group-hover:bg-accent/[0.02] transition-all duration-500 pointer-events-none" />
        )}

        <div className={`relative transition-transform duration-300 ${dragging ? 'scale-110' : ''}`}>
          <div className={`
            w-16 h-16 mx-auto mb-5 rounded-2xl flex items-center justify-center transition-all duration-500
            ${dragging ? 'bg-accent/15 text-accent' : disabled ? 'bg-surface-2 text-muted' : 'bg-surface-2 text-muted group-hover:text-accent group-hover:bg-accent/10'}
          `}>
            <Upload className="w-7 h-7" strokeWidth={1.5} />
          </div>

          {disabled ? (
            <p className="font-mono text-sm text-muted">Portal is active</p>
          ) : dragging ? (
            <p className="font-mono text-sm text-accent text-glow">Release to add files</p>
          ) : (
            <>
              <p className="font-mono text-sm text-text mb-2">Drag & drop files here</p>
              <div className="flex items-center justify-center gap-3 text-muted flex-wrap">
                <div className="flex items-center gap-1.5">
                  <MousePointerClick className="w-3.5 h-3.5" />
                  <p className="font-mono text-xs">click to browse</p>
                </div>
                <span className="text-border hidden sm:inline">&middot;</span>
                <div className="flex items-center gap-1.5">
                  <Clipboard className="w-3.5 h-3.5" />
                  <p className="font-mono text-xs">Ctrl+V to paste</p>
                </div>
              </div>
              <p className="font-mono text-xs text-muted mt-4">
                Any file type &middot; Multiple files &middot; No size limit
              </p>
            </>
          )}
        </div>
      </div>
    </>
  )
}
