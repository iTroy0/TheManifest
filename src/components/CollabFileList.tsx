import { useState, useMemo, useRef, useEffect, useCallback, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  FileText, Image, FileCode, Film, Music, Archive, File, X, Download, Pause, Play,
  Check, Clock, User, AlertTriangle, Upload, MoreVertical, Search, RotateCcw,
} from 'lucide-react'
import { formatBytes } from '../utils/formatBytes'
import type { SharedFile, FileDownload } from '../hooks/state/collabState'

// Progress-ring stroke-dasharray divisor. For a circle of radius 15 the
// circumference is 2*pi*15 ≈ 94.25, so each percentage point corresponds
// to ~0.94 length units along the dasharray. Using 0.94 keeps the ring
// visually accurate without hardcoding the math inline.
const PROGRESS_RING_CIRCUMFERENCE_PER_PERCENT = 0.94

// Confirm-remove auto-reset timeout (ms) — see fix #5.
const CONFIRM_REMOVE_TIMEOUT_MS = 3000
// Max elapsed seconds displayed for a 'requesting' row — see fix #6.
const REQUESTING_ELAPSED_CAP_S = 30
// File count threshold for showing the filter/sort bar — see fix #4.
const FILTER_BAR_THRESHOLD = 8

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
  const [pinned, setPinned] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!show || !pinned) return
    const onOutside = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) {
        setShow(false)
        setPinned(false)
      }
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [show, pinned])

  if (!preview) return null

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        onMouseEnter={() => { if (!pinned) setShow(true) }}
        onMouseLeave={() => { if (!pinned) setShow(false) }}
        onFocus={() => { if (!pinned) setShow(true) }}
        onBlur={() => { if (!pinned) setShow(false) }}
        onClick={(e) => {
          e.stopPropagation()
          // Toggle pin state on click; this lets mobile users open/close.
          setPinned(p => {
            const next = !p
            setShow(next)
            return next
          })
        }}
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

interface OverflowMenuProps {
  onRemove: () => void
  removeConfirming: boolean
}

function OverflowMenu({ onRemove, removeConfirming }: OverflowMenuProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent) => {
      if (!rootRef.current) return
      if (!rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [open])

  return (
    <div className="relative sm:hidden" ref={rootRef}>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen(o => !o) }}
        aria-label="More actions"
        className="p-2 rounded-lg text-muted hover:text-accent hover:bg-surface-2 active:scale-95 transition-all"
      >
        <MoreVertical className="w-3.5 h-3.5" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 min-w-[120px] bg-surface border border-border rounded-lg shadow-lg z-20 py-1">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
              if (removeConfirming) setOpen(false)
            }}
            className={`w-full px-3 py-1.5 text-left font-mono text-[11px] transition-colors ${
              removeConfirming
                ? 'text-danger bg-danger/10 hover:bg-danger/20'
                : 'text-muted hover:text-danger hover:bg-danger/10'
            }`}
          >
            {removeConfirming ? 'Confirm?' : 'Remove'}
          </button>
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); setOpen(false) }}
            className="w-full px-3 py-1.5 text-left font-mono text-[11px] text-muted/60 hover:text-muted"
            title="Coming soon"
            disabled
          >
            Rename
          </button>
        </div>
      )}
    </div>
  )
}

interface CollabFileItemProps {
  file: SharedFile
  download: FileDownload | undefined
  isOwn: boolean
  uploadEntry: { progress: number; speed: number; fileName: string } | undefined
  requestingElapsedS: number | null
  removeConfirming: boolean
  onDownload: () => void
  onRemove: () => void
  onPause: () => void
  onResume: () => void
  onCancel: () => void
  onDismissError: () => void
  onRequestConfirmRemove: () => void
}

function CollabFileItem({
  file,
  download,
  isOwn,
  uploadEntry,
  requestingElapsedS,
  removeConfirming,
  onDownload,
  onRemove,
  onPause,
  onResume,
  onCancel,
  onDismissError,
  onRequestConfirmRemove,
}: CollabFileItemProps) {
  const Icon = getIcon(file.type)
  const status = download?.status
  // Clamp to [0, 100] everywhere it's used, and guard against NaN% on zero-byte files.
  const rawProgress = download?.progress ?? 0
  const progress = Number.isFinite(rawProgress) ? Math.min(100, Math.max(0, Math.round(rawProgress))) : 0
  const speed = download?.speed ?? 0

  const isDone = status === 'complete'
  const isDownloading = status === 'downloading'
  const isPaused = status === 'paused'
  const isRequesting = status === 'requesting'
  const isQueued = status === 'queued'
  const isError = status === 'error'
  const isPending = isRequesting || isDownloading || isQueued
  const isIdle = !status || status === 'pending'

  // Fix #8(a): iconless-path keeps the SVG ring; thumbnail path uses a
  // thin bottom bar because the original ring geometry didn't match the
  // thumbnail container size.
  const progressRingIconless = isDownloading && !isDone ? (
    <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2" className="text-border" />
      <circle
        cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2"
        className="text-info transition-all duration-300"
        strokeDasharray={`${progress * PROGRESS_RING_CIRCUMFERENCE_PER_PERCENT} 100`}
        strokeLinecap="round"
      />
    </svg>
  ) : null

  // Keyboard navigation (fix #9) — Enter/Space routes to the primary action
  // for the current state.
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return
    // Ignore keys originating from inner interactive elements.
    const target = e.target as HTMLElement
    if (target !== e.currentTarget) return
    e.preventDefault()
    if (isError) { onDownload(); return }
    if (!isOwn && isIdle) { onDownload(); return }
    if (isOwn && !isPending) { onRequestConfirmRemove(); return }
    if (isPaused) { onResume(); return }
    if (isDownloading) { onPause(); return }
  }

  // Truncate error text — fix #3.
  const errorText = (download?.error || 'failed').slice(0, 40)

  return (
    <div
      role="button"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={`
        group/file relative flex items-center gap-3 rounded-xl px-3 py-2.5 sm:px-4 sm:py-3
        border transition-all duration-200 outline-none
        focus:ring-2 focus:ring-accent/50 focus:ring-offset-1 focus:ring-offset-bg
        ${isError
          ? 'bg-danger/5 border-danger/25'
          : isDone
            ? 'bg-accent/5 border-accent/25 hover:bg-accent/8'
            : isDownloading
              ? 'bg-info/5 border-info/25'
              : isPaused
                ? 'bg-yellow-400/5 border-yellow-400/20'
                : isOwn
                  ? 'bg-accent/5 border-accent/20 hover:bg-accent/8'
                  : 'bg-surface border-border hover:border-accent/30 hover:bg-surface-2/50'
        }
      `}
    >
      <div className="relative shrink-0">
        {file.thumbnail ? (
          <div className="relative w-9 h-9 sm:w-10 sm:h-10">
            <img src={file.thumbnail} alt="" className="w-full h-full rounded-lg object-cover" />
            {isVideoType(file.type) && (
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-5 h-5 rounded-full bg-black/60 flex items-center justify-center">
                  <Play className="w-2.5 h-2.5 text-white ml-0.5" fill="white" />
                </div>
              </div>
            )}
            {isDownloading && !isDone && (
              // Fix #8(a): thin bottom progress bar in place of the mis-sized ring.
              <div className="absolute left-0 right-0 bottom-0 h-[2px] bg-border rounded-b-lg overflow-hidden">
                <div
                  className="h-full bg-info transition-all duration-300"
                  style={{ width: `${progress}%` }}
                />
              </div>
            )}
          </div>
        ) : (
          <div className={`
            relative w-9 h-9 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center transition-colors
            ${isError
              ? 'bg-danger/10 text-danger'
              : isDone
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
            {isError ? (
              <AlertTriangle className="w-4 h-4" strokeWidth={2} />
            ) : isDone ? (
              <Check className="w-4 h-4" strokeWidth={2.5} />
            ) : (
              <Icon className="w-4 h-4" strokeWidth={1.5} />
            )}
            {progressRingIconless}
          </div>
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className={`text-xs sm:text-sm font-mono truncate transition-colors ${isDone ? 'text-accent' : 'text-text'}`}>
            {file.name}
          </p>
          {/* Fix #11: green check next to filename instead of "saved" text */}
          {isDone && !isOwn && (
            <Check className="w-3 h-3 text-accent shrink-0" strokeWidth={2.5} aria-label="Downloaded" />
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-[10px] sm:text-[11px] text-muted font-mono">{formatBytes(file.size)}</p>

          <span className="text-muted/40 font-mono text-[10px]">·</span>
          <span className={`inline-flex items-center gap-1 font-mono text-[10px] ${isOwn ? 'text-accent' : 'text-muted/70'}`}>
            <User className="w-2.5 h-2.5" />
            {isOwn ? 'You' : file.ownerName}
          </span>

          {file.textPreview && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <TextPreviewTooltip preview={file.textPreview} />
            </>
          )}

          {/* Fix #12: differentiated speed with pipe separator */}
          {isDownloading && !isPaused && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info/90">
                <span className="w-1 h-1 rounded-full bg-info animate-pulse" />
                {speed > 0 ? `${formatBytes(speed)}/s` : 'transferring'}
              </span>
            </>
          )}
          {isPaused && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-yellow-400">
                <Pause className="w-2.5 h-2.5" />
                paused
              </span>
            </>
          )}
          {isRequesting && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info/70">
                <Clock className="w-2.5 h-2.5" />
                requesting… {requestingElapsedS ?? 0}s
              </span>
            </>
          )}
          {isQueued && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-muted-light">
                <Clock className="w-2.5 h-2.5" />
                queued
              </span>
            </>
          )}
          {isError && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <span
                className="inline-flex items-center gap-1 font-mono text-[10px] text-danger bg-danger/10 px-1.5 py-0.5 rounded"
                title={download?.error || 'failed'}
              >
                <AlertTriangle className="w-2.5 h-2.5" />
                {errorText}
              </span>
            </>
          )}
          {/* Fix #17: uploading chip for own files */}
          {isOwn && uploadEntry && (
            <>
              <span className="text-muted/40 font-mono text-[10px]">·</span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info bg-info/10 px-1.5 py-0.5 rounded">
                <Upload className="w-2.5 h-2.5" />
                uploading {Math.round(uploadEntry.progress)}%
              </span>
            </>
          )}
        </div>
      </div>

      {isDownloading && !isDone && (
        <span className="font-mono text-xs sm:text-sm tabular-nums text-info font-medium">{progress}%</span>
      )}

      <div className="flex items-center gap-1.5">
        {isError && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDownload() }}
              className="flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg font-mono text-[11px] sm:text-xs
                bg-danger/10 text-danger hover:bg-danger/20 active:scale-95 transition-all"
              title="Retry download"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Retry</span>
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDismissError() }}
              aria-label="Dismiss error"
              className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10 active:scale-95 transition-all"
              title="Dismiss"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {!isError && !isOwn && isDone && (
          <>
            <span
              className="inline-flex items-center gap-1 px-2 py-1 sm:px-2.5 sm:py-1.5 rounded-lg font-mono text-[10px] sm:text-[11px]
                bg-accent/10 text-accent"
              title="Downloaded"
            >
              <Check className="w-3 h-3" strokeWidth={2.5} />
              <span className="hidden sm:inline">Downloaded</span>
            </span>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDownload() }}
              className="p-2 rounded-lg text-muted hover:text-accent hover:bg-accent/10 active:scale-95 transition-all"
              title="Download again"
              aria-label="Download again"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </>
        )}

        {!isError && !isOwn && isIdle && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDownload() }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg font-mono text-[11px] sm:text-xs
              bg-accent/10 text-accent hover:bg-accent/20 active:scale-95 transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download</span>
          </button>
        )}

        {!isError && isDownloading && !isPaused && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onPause() }}
            aria-label="Pause download"
            className="p-2 rounded-lg text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20 active:scale-95 transition-all"
            title="Pause"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
        )}

        {!isError && isPaused && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onResume() }}
            aria-label="Resume download"
            className="p-2 rounded-lg text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20 active:scale-95 transition-all"
            title="Resume"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        )}

        {!isError && isPending && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onCancel() }}
            className="p-2 rounded-lg text-danger bg-danger/10 hover:bg-danger/20 active:scale-95 transition-all"
            title="Cancel"
            aria-label="Cancel download"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        {!isError && isOwn && !isPending && (
          <>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeConfirming ? onRemove() : onRequestConfirmRemove() }}
              className={`hidden sm:inline-flex items-center p-2 rounded-lg active:scale-95 transition-all
                sm:opacity-0 sm:group-hover/file:opacity-100 focus:opacity-100
                ${removeConfirming
                  ? 'text-white bg-danger hover:bg-danger/90 !opacity-100 px-2'
                  : 'text-muted hover:text-danger hover:bg-danger/10'
                }`}
              title={removeConfirming ? 'Click again to confirm' : 'Remove file'}
              aria-label={removeConfirming ? 'Confirm remove' : 'Remove file'}
            >
              {removeConfirming ? (
                <span className="font-mono text-[10px]">Confirm?</span>
              ) : (
                <X className="w-3.5 h-3.5" />
              )}
            </button>
            <OverflowMenu
              onRemove={() => (removeConfirming ? onRemove() : onRequestConfirmRemove())}
              removeConfirming={removeConfirming}
            />
          </>
        )}
      </div>
    </div>
  )
}

type SortKey = 'newest' | 'name' | 'size'
type OwnerFilter = 'all' | 'mine' | 'others'

interface FilterBarProps {
  query: string
  setQuery: (v: string) => void
  sortKey: SortKey
  setSortKey: (v: SortKey) => void
  ownerFilter: OwnerFilter
  setOwnerFilter: (v: OwnerFilter) => void
}

function FilterBar({ query, setQuery, sortKey, setSortKey, ownerFilter, setOwnerFilter }: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-center px-2 py-2 border border-border rounded-lg bg-surface">
      <div className="relative flex-1 min-w-0">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search files…"
          className="w-full pl-7 pr-2 py-1 bg-surface-2 border border-border rounded font-mono text-[11px] text-text placeholder:text-muted/60 focus:outline-none focus:border-accent/40"
        />
      </div>
      <select
        value={sortKey}
        onChange={(e) => setSortKey(e.target.value as SortKey)}
        className="px-2 py-1 bg-surface-2 border border-border rounded font-mono text-[11px] text-text focus:outline-none focus:border-accent/40"
      >
        <option value="newest">Newest</option>
        <option value="name">Name</option>
        <option value="size">Size</option>
      </select>
      <div className="inline-flex rounded border border-border overflow-hidden">
        {(['all', 'mine', 'others'] as OwnerFilter[]).map(f => (
          <button
            key={f}
            type="button"
            onClick={() => setOwnerFilter(f)}
            className={`px-2 py-1 font-mono text-[11px] transition-colors ${
              ownerFilter === f
                ? 'bg-accent/15 text-accent'
                : 'bg-surface-2 text-muted hover:text-text'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
    </div>
  )
}

interface CollabFileListProps {
  files: SharedFile[]
  downloads: Record<string, FileDownload>
  myPeerId: string | null
  mySharedFiles: Set<string>
  onDownload: (fileId: string, ownerId: string) => void
  onRemove: (fileId: string) => void
  onPause: (fileId: string) => void
  onResume: (fileId: string) => void
  onCancel: (fileId: string) => void
  onDismissError?: (fileId: string) => void
  uploadsByFileId?: Record<string, { progress: number; speed: number; fileName: string }>
}

export default function CollabFileList({
  files,
  downloads,
  myPeerId,
  mySharedFiles,
  onDownload,
  onRemove,
  onPause,
  onResume,
  onCancel,
  onDismissError,
  uploadsByFileId,
}: CollabFileListProps) {
  // both checks handle edge cases where one lags behind the other — fix #16
  const isOwnFile = useCallback(
    (f: SharedFile) => f.owner === myPeerId || mySharedFiles.has(f.id),
    [myPeerId, mySharedFiles],
  )

  const totalSize = useMemo(() => files.reduce((sum, f) => sum + f.size, 0), [files])
  const ownCount = useMemo(() => files.filter(isOwnFile).length, [files, isOwnFile])

  // Filter/sort state (fix #4) — only meaningful when files.length > threshold.
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('newest')
  const [ownerFilter, setOwnerFilter] = useState<OwnerFilter>('all')

  // Confirm-remove state (fix #5) — stores per-file confirming flag and a
  // timeouts ref so we can clear timers on unmount.
  const [confirmingRemove, setConfirmingRemove] = useState<Record<string, boolean>>({})
  const confirmTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  useEffect(() => {
    const map = confirmTimersRef.current
    return () => {
      map.forEach(t => clearTimeout(t))
      map.clear()
    }
  }, [])

  const requestConfirmRemove = useCallback((fileId: string) => {
    setConfirmingRemove(prev => ({ ...prev, [fileId]: true }))
    const existing = confirmTimersRef.current.get(fileId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      setConfirmingRemove(prev => {
        if (!prev[fileId]) return prev
        const next = { ...prev }
        delete next[fileId]
        return next
      })
      confirmTimersRef.current.delete(fileId)
    }, CONFIRM_REMOVE_TIMEOUT_MS)
    confirmTimersRef.current.set(fileId, t)
  }, [])

  const doRemove = useCallback((fileId: string) => {
    const existing = confirmTimersRef.current.get(fileId)
    if (existing) clearTimeout(existing)
    confirmTimersRef.current.delete(fileId)
    setConfirmingRemove(prev => {
      if (!prev[fileId]) return prev
      const next = { ...prev }
      delete next[fileId]
      return next
    })
    onRemove(fileId)
  }, [onRemove])

  // Requesting-elapsed counter (fix #6) — single shared 500ms tick.
  // Tracks when each fileId first entered the 'requesting' state.
  const requestingSinceRef = useRef<Map<string, number>>(new Map())
  const [nowTick, setNowTick] = useState(Date.now())

  // Maintain requestingSinceRef based on the current downloads map.
  useEffect(() => {
    const since = requestingSinceRef.current
    const active = new Set<string>()
    for (const [id, d] of Object.entries(downloads)) {
      if (d.status === 'requesting') {
        active.add(id)
        if (!since.has(id)) since.set(id, Date.now())
      }
    }
    // Remove timers for file ids that are no longer requesting.
    for (const id of Array.from(since.keys())) {
      if (!active.has(id)) since.delete(id)
    }
  }, [downloads])

  // Drive a single 500ms interval while any row is in 'requesting'.
  const anyRequesting = useMemo(
    () => Object.values(downloads).some(d => d.status === 'requesting'),
    [downloads],
  )
  useEffect(() => {
    if (!anyRequesting) return
    const id = setInterval(() => setNowTick(Date.now()), 500)
    return () => clearInterval(id)
  }, [anyRequesting])

  const getRequestingElapsedS = useCallback((fileId: string): number | null => {
    const since = requestingSinceRef.current.get(fileId)
    if (since == null) return null
    const elapsed = Math.floor((nowTick - since) / 1000)
    return Math.min(REQUESTING_ELAPSED_CAP_S, Math.max(0, elapsed))
  }, [nowTick])

  // Derived visible list (filter → sort) — fix #4.
  const visibleFiles = useMemo(() => {
    let out = files
    if (files.length > FILTER_BAR_THRESHOLD) {
      const q = query.trim().toLowerCase()
      if (q) out = out.filter(f => f.name.toLowerCase().includes(q))
      if (ownerFilter === 'mine') out = out.filter(f => isOwnFile(f))
      else if (ownerFilter === 'others') out = out.filter(f => !isOwnFile(f))
      const sorted = [...out]
      if (sortKey === 'newest') sorted.sort((a, b) => b.addedAt - a.addedAt)
      else if (sortKey === 'name') sorted.sort((a, b) => a.name.localeCompare(b.name))
      else if (sortKey === 'size') sorted.sort((a, b) => b.size - a.size)
      out = sorted
    }
    return out
  }, [files, query, sortKey, ownerFilter, isOwnFile])

  // "Download all visible (N new)" count — fix #2 (respects filter per #4).
  const downloadableFileIds = useMemo(() => {
    return visibleFiles.filter(f => {
      if (isOwnFile(f)) return false
      const st = downloads[f.id]?.status
      return st !== 'complete' && st !== 'downloading' && st !== 'requesting' && st !== 'queued' && st !== 'paused'
    }).map(f => f.id)
  }, [visibleFiles, downloads, isOwnFile])

  const handleDownloadAll = useCallback(() => {
    for (const id of downloadableFileIds) {
      const f = files.find(x => x.id === id)
      if (f) onDownload(f.id, f.owner)
    }
  }, [downloadableFileIds, files, onDownload])

  const handleDismissError = useCallback((fileId: string) => {
    if (onDismissError) onDismissError(fileId)
  }, [onDismissError])

  // Fix #15: improved empty state.
  if (files.length === 0) {
    return (
      <div className="text-center py-8 flex flex-col items-center">
        <Upload className="w-6 h-6 text-muted/60 mb-2" strokeWidth={1.5} />
        <p className="font-mono text-xs text-muted">No files shared yet</p>
        <p className="text-muted/60 text-[10px] mt-1 font-mono">
          Drop files anywhere to share with the room
        </p>
      </div>
    )
  }

  const showFilterBar = files.length > FILTER_BAR_THRESHOLD

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center px-1 gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-mono text-[11px] text-muted">
            {files.length} file{files.length !== 1 ? 's' : ''}
            {ownCount > 0 && <span className="text-accent"> ({ownCount} yours)</span>}
          </span>
          {/* Fix #2: Download all visible (N new) */}
          {downloadableFileIds.length > 0 && (
            <button
              type="button"
              onClick={handleDownloadAll}
              className="inline-flex items-center gap-1 px-2 py-1 rounded font-mono text-[10px]
                bg-accent/10 text-accent hover:bg-accent/20 border border-accent/20 transition-colors"
              title="Download all visible files that aren't already downloaded"
            >
              <Download className="w-3 h-3" />
              Download all ({downloadableFileIds.length})
            </button>
          )}
        </div>
        <span className="font-mono text-[11px] text-muted">{formatBytes(totalSize)}</span>
      </div>

      {showFilterBar && (
        <FilterBar
          query={query}
          setQuery={setQuery}
          sortKey={sortKey}
          setSortKey={setSortKey}
          ownerFilter={ownerFilter}
          setOwnerFilter={setOwnerFilter}
        />
      )}

      <div className="space-y-1.5">
        {visibleFiles.map(file => {
          const isOwn = isOwnFile(file)
          const dl = downloads[file.id]
          const isRequesting = dl?.status === 'requesting'
          return (
            <CollabFileItem
              key={file.id}
              file={file}
              download={dl}
              isOwn={isOwn}
              uploadEntry={uploadsByFileId?.[file.id]}
              requestingElapsedS={isRequesting ? getRequestingElapsedS(file.id) : null}
              removeConfirming={!!confirmingRemove[file.id]}
              onDownload={() => onDownload(file.id, file.owner)}
              onRemove={() => doRemove(file.id)}
              onPause={() => onPause(file.id)}
              onResume={() => onResume(file.id)}
              onCancel={() => onCancel(file.id)}
              onDismissError={() => handleDismissError(file.id)}
              onRequestConfirmRemove={() => requestConfirmRemove(file.id)}
            />
          )
        })}
      </div>
    </div>
  )
}
