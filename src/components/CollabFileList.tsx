import { useState, useMemo } from 'react'
import { FileText, Image, FileCode, Film, Music, Archive, File, X, Download, Pause, Play, Check, Clock, User } from 'lucide-react'
import { formatBytes } from '../utils/formatBytes'
import type { SharedFile, FileDownload } from '../hooks/state/collabState'

type LucideIcon = React.ComponentType<React.SVGProps<SVGSVGElement> & { strokeWidth?: number | string }>

const iconMap: Record<string, LucideIcon> = {
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

function getIcon(type: string | undefined): LucideIcon {
  if (!type) return File
  for (const [key, Icon] of Object.entries(iconMap)) {
    if (type.startsWith(key)) return Icon
  }
  return File
}

function isVideoType(type: string | undefined): boolean {
  return !!type && type.startsWith('video/')
}

interface TextPreviewTooltipProps {
  preview: string | undefined
}

function TextPreviewTooltip({ preview }: TextPreviewTooltipProps) {
  const [show, setShow] = useState(false)
  if (!preview) return null

  return (
    <div className="relative">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        onFocus={() => setShow(true)}
        onBlur={() => setShow(false)}
        aria-label="Show text preview"
        className="text-[9px] text-muted hover:text-accent transition-colors font-mono"
      >
        preview
      </button>
      {show && (
        <div className="absolute bottom-full left-0 mb-2 w-64 p-2 bg-surface border border-border rounded-lg shadow-lg z-10">
          <pre className="text-[10px] text-muted-light font-mono whitespace-pre-wrap break-all overflow-hidden max-h-32">
            {preview}
          </pre>
        </div>
      )}
    </div>
  )
}

interface CollabFileItemProps {
  file: SharedFile
  download: FileDownload | undefined
  isOwn: boolean
  myName: string
  onDownload: () => void
  onRemove: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}

function CollabFileItem({ file, download, isOwn, myName, onDownload, onRemove, onPause, onResume, onCancel }: CollabFileItemProps) {
  const Icon = getIcon(file.type)
  const status = download?.status
  const progress = download?.progress ?? 0
  const speed = download?.speed ?? 0
  
  const isDone = status === 'complete'
  const isDownloading = status === 'downloading'
  const isPaused = status === 'paused'
  const isPending = status === 'requesting' || isDownloading
  const isIdle = !status || status === 'pending'
  
  // Progress ring for downloading state
  const progressRing = isDownloading && !isDone ? (
    <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2" className="text-border" />
      <circle
        cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2"
        className="text-info transition-all duration-300"
        strokeDasharray={`${progress * 0.94} 100`}
        strokeLinecap="round"
      />
    </svg>
  ) : null

  return (
    <div className={`
      group/file relative flex items-center gap-3 rounded-xl px-3 py-2.5 sm:px-4 sm:py-3
      border transition-all duration-200
      ${isDone
        ? 'bg-accent/5 border-accent/25 hover:bg-accent/8'
        : isDownloading
          ? 'bg-info/5 border-info/25'
          : isPaused
            ? 'bg-yellow-400/5 border-yellow-400/20'
            : isOwn
              ? 'bg-accent/5 border-accent/20 hover:bg-accent/8'
              : 'bg-surface border-border hover:border-accent/30 hover:bg-surface-2/50'
      }
    `}>
      {/* File icon/thumbnail with progress ring */}
      <div className="relative shrink-0">
        {file.thumbnail ? (
          <div className="relative">
            <img src={file.thumbnail} alt="" className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg object-cover" />
            {isVideoType(file.type) && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                  <Play className="w-2.5 h-2.5 text-white ml-0.5" fill="white" />
                </div>
              </div>
            )}
            {progressRing && <div className="absolute -inset-0.5">{progressRing}</div>}
          </div>
        ) : (
          <div className={`
            relative w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center transition-colors
            ${isDone
              ? 'bg-accent/15 text-accent'
              : isDownloading
                ? 'bg-info/10 text-info'
                : isPaused
                  ? 'bg-yellow-400/10 text-yellow-400'
                  : isOwn
                    ? 'bg-accent/10 text-accent'
                    : 'bg-surface-2 text-muted-light group-hover/file:text-accent group-hover/file:bg-accent/10'
            }
          `}>
            {isDone ? (
              <Check className="w-4 h-4" strokeWidth={2.5} />
            ) : (
              <Icon className="w-4 h-4" strokeWidth={1.5} />
            )}
            {progressRing}
          </div>
        )}
      </div>

      {/* File info */}
      <div className="flex-1 min-w-0">
        <p className={`text-xs sm:text-sm font-mono truncate transition-colors ${isDone ? 'text-accent' : 'text-text'}`}>
          {file.name}
        </p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-[10px] sm:text-[11px] text-muted font-mono">{formatBytes(file.size)}</p>
          
          {/* Owner indicator */}
          <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${isOwn ? 'text-accent' : 'text-muted/70'}`}>
            <User className="w-2.5 h-2.5" />
            {isOwn ? 'You' : file.ownerName}
          </span>
          
          {file.textPreview && <TextPreviewTooltip preview={file.textPreview} />}
          
          {isDownloading && !isPaused && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info">
              <span className="w-1 h-1 rounded-full bg-info animate-pulse" />
              {speed > 0 ? `${formatBytes(speed)}/s` : 'transferring'}
            </span>
          )}
          {isPaused && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-yellow-400">
              <Pause className="w-2.5 h-2.5" />
              paused
            </span>
          )}
          {status === 'requesting' && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info/70">
              <Clock className="w-2.5 h-2.5" />
              requesting
            </span>
          )}
          {isDone && (
            <span className="font-mono text-[10px] text-accent/70">saved</span>
          )}
        </div>
      </div>

      {/* Progress percentage */}
      {isDownloading && !isDone && (
        <span className="font-mono text-xs sm:text-sm tabular-nums text-info font-medium">{progress}%</span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {/* Download button - only for files NOT owned by user and not already downloading/done */}
        {!isOwn && isIdle && (
          <button
            onClick={onDownload}
            className="flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg font-mono text-[11px] sm:text-xs
              bg-accent/10 text-accent hover:bg-accent/20 active:scale-95 transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download</span>
          </button>
        )}

        {/* Pause button */}
        {isDownloading && !isPaused && (
          <button
            onClick={onPause}
            aria-label="Pause download"
            className="p-2 rounded-lg text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20 active:scale-95 transition-all"
            title="Pause"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Resume button */}
        {isPaused && (
          <button
            onClick={onResume}
            aria-label="Resume download"
            className="p-2 rounded-lg text-accent bg-accent/10 hover:bg-accent/20 active:scale-95 transition-all"
            title="Resume"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Cancel button */}
        {isPending && (
          <button
            onClick={onCancel}
            className="p-2 rounded-lg text-danger bg-danger/10 hover:bg-danger/20 active:scale-95 transition-all"
            title="Cancel"
            aria-label="Cancel download"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Remove button - only for own files */}
        {isOwn && !isPending && (
          <button
            onClick={onRemove}
            className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10 active:scale-95 transition-all
              opacity-100 sm:opacity-0 sm:group-hover/file:opacity-100 focus:opacity-100"
            title="Remove file"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

interface CollabFileListProps {
  files: SharedFile[]
  downloads: Record<string, FileDownload>
  myPeerId: string | null
  mySharedFiles: Set<string>
  myName: string
  onDownload: (fileId: string, ownerId: string) => void
  onRemove: (fileId: string) => void
  onPause: (fileId: string) => void
  onResume: (fileId: string) => void
  onCancel: (fileId: string) => void
}

export default function CollabFileList({
  files,
  downloads,
  myPeerId,
  mySharedFiles,
  myName,
  onDownload,
  onRemove,
  onPause,
  onResume,
  onCancel,
}: CollabFileListProps) {
  const totalSize = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files])
  const ownCount = useMemo(() => files.filter(f => f.owner === myPeerId || mySharedFiles.has(f.id)).length, [files, myPeerId, mySharedFiles])

  if (files.length === 0) {
    return (
      <div className="text-center py-6">
        <p className="font-mono text-xs text-muted">No files shared yet</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center px-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted">
            {files.length} file{files.length !== 1 ? 's' : ''}
            {ownCount > 0 && <span className="text-accent"> ({ownCount} yours)</span>}
          </span>
        </div>
        <span className="font-mono text-[11px] text-muted">{formatBytes(totalSize)}</span>
      </div>

      <div className="space-y-1.5">
        {files.map(file => {
          const isOwn = file.owner === myPeerId || mySharedFiles.has(file.id)
          return (
            <CollabFileItem
              key={file.id}
              file={file}
              download={downloads[file.id]}
              isOwn={isOwn}
              myName={myName}
              onDownload={() => onDownload(file.id, file.owner)}
              onRemove={() => onRemove(file.id)}
              onPause={() => onPause(file.id)}
              onResume={() => onResume(file.id)}
              onCancel={() => onCancel(file.id)}
            />
          )
        })}
      </div>
    </div>
  )
}
