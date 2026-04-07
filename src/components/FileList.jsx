import { useState, useEffect } from 'react'
import { FileText, Image, FileCode, Film, Music, Archive, File, X, Download } from 'lucide-react'
import { formatBytes } from '../utils/formatBytes'

const iconMap = {
  'application/pdf': FileText,
  'text/': FileCode,
  'image/': Image,
  'video/': Film,
  'audio/': Music,
  'application/zip': Archive,
  'application/x-rar': Archive,
  'application/gzip': Archive,
  'application/x-7z': Archive,
}

function getIcon(type) {
  if (!type) return File
  for (const [key, Icon] of Object.entries(iconMap)) {
    if (type.startsWith(key)) return Icon
  }
  return File
}

function isImageType(type) {
  return type && type.startsWith('image/')
}

function ImageThumb({ file }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!(file instanceof window.File) || !isImageType(file.type)) return
    const url = URL.createObjectURL(file)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  if (!src) return null
  return <img src={src} alt="" className="w-8 h-8 rounded-lg object-cover" />
}

export default function FileList({ files, onRemove, progress, pendingFiles, onRequest, onSave, currentFileIndex }) {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-1 px-1">
        <span className="font-mono text-[10px] text-muted uppercase tracking-widest">
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
        <span className="font-mono text-[10px] text-muted">{formatBytes(totalSize)}</span>
      </div>

      <div className="space-y-1.5">
        {files.map((file, i) => {
          const Icon = getIcon(file.type)
          const pct = progress?.[file.name]
          const isDone = pct === 100
          const isPending = pendingFiles && pendingFiles[i]
          const isActive = currentFileIndex === i && pct != null && !isDone
          const showThumb = isImageType(file.type) && file instanceof window.File
          // onSave being a function with the index means this file is saved and ready
          const isSaved = onSave && isDone

          return (
            <div
              key={`${file.name}-${i}`}
              className={`
                flex items-center gap-3 rounded-xl px-4 py-3
                border transition-all duration-300 animate-fade-in-up
                ${isDone
                  ? 'bg-accent/5 border-accent/20'
                  : isActive
                    ? 'bg-info/5 border-info/20'
                    : 'bg-surface border-border hover:border-border-hover'
                }
              `}
              style={{ animationDelay: `${i * 50}ms` }}
            >
              {showThumb ? (
                <ImageThumb file={file} />
              ) : (
                <div className={`
                  w-8 h-8 rounded-lg flex items-center justify-center shrink-0
                  ${isDone ? 'bg-accent/15 text-accent' : isActive ? 'bg-info/15 text-info' : 'bg-surface-2 text-muted-light'}
                `}>
                  <Icon className="w-4 h-4" strokeWidth={1.5} />
                </div>
              )}

              <div className="flex-1 min-w-0">
                <p className="text-sm font-mono truncate text-text">{file.name}</p>
                <div className="flex items-center gap-2">
                  <p className="text-[11px] text-muted font-mono">{formatBytes(file.size)}</p>
                  {isActive && <span className="font-mono text-[10px] text-info animate-pulse">transferring</span>}
                  {isPending && !isActive && pct == null && <span className="font-mono text-[10px] text-info animate-pulse">queued</span>}
                </div>
              </div>

              {/* Progress */}
              {pct != null && !isDone && (
                <span className="font-mono text-xs tabular-nums text-info">{pct}%</span>
              )}

              {/* Download button — request file from sender */}
              {onRequest && !isPending && !isDone && pct == null && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRequest(i) }}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs
                    bg-info/10 text-info hover:bg-info/20 transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download
                </button>
              )}

              {/* Saved indicator */}
              {isDone && (
                <span className="font-mono text-xs text-accent">saved</span>
              )}

              {/* Remove button (sender side) */}
              {onRemove && (
                <button
                  onClick={(e) => { e.stopPropagation(); onRemove(i) }}
                  className="text-muted hover:text-danger transition-colors p-1 rounded-lg hover:bg-danger/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
