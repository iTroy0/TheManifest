import { useState, useEffect, useMemo, useCallback } from 'react'
import { FileText, Image, FileCode, Film, Music, Archive, File, X, Download, GripVertical, Pause, Play, Check, Clock } from 'lucide-react'
import { formatBytes } from '../utils/formatBytes'
import {
  DndContext,
  DragOverlay,
  closestCenter,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

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

function isVideoType(type) {
  return type && type.startsWith('video/')
}

function isTextType(type) {
  return type && (type.startsWith('text/') || type === 'application/json' || type === 'application/javascript')
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
  return <img src={src} alt="" className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg object-cover" />
}

// Text preview tooltip
function TextPreviewTooltip({ preview }) {
  const [show, setShow] = useState(false)
  if (!preview) return null
  
  return (
    <div className="relative">
      <button 
        onMouseEnter={() => setShow(true)} 
        onMouseLeave={() => setShow(false)}
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

function SortableFileItem({ id, file, index, pct, isDone, isPending, isActive, isPaused, showThumb, Icon, canDrag, onRequest, onRemove, onCancel, onPause, onResume }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isSorting,
  } = useSortable({ id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: isSorting ? transition : undefined,
  }

  // Progress ring for active transfers
  const progressRing = pct != null && !isDone ? (
    <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 36 36">
      <circle cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2" className="text-border" />
      <circle 
        cx="18" cy="18" r="15" fill="none" stroke="currentColor" strokeWidth="2" 
        className="text-info transition-all duration-300"
        strokeDasharray={`${pct * 0.94} 100`}
        strokeLinecap="round"
      />
    </svg>
  ) : null

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        sortable-item group/file relative flex items-center gap-3 rounded-xl px-3 py-2.5 sm:px-4 sm:py-3
        border transition-all duration-200
        ${isDone
          ? 'bg-accent/5 border-accent/25 hover:bg-accent/8'
          : isActive
            ? 'bg-info/5 border-info/25'
            : isPaused
              ? 'bg-yellow-400/5 border-yellow-400/20'
              : isPending
                ? 'bg-surface border-border'
                : 'bg-surface border-border hover:border-accent/30 hover:bg-surface-2/50'
        }
        ${isDragging ? 'sortable-placeholder' : ''}
      `}
    >
      {/* Drag handle */}
      {canDrag && (
        <div
          {...attributes}
          {...listeners}
          className="flex items-center cursor-grab active:cursor-grabbing shrink-0 py-3 -my-3 px-1.5 -ml-1.5 rounded-lg 
            hover:bg-accent/10 transition-colors touch-none opacity-40 group-hover/file:opacity-100"
        >
          <GripVertical className="w-4 h-4 text-muted group-hover/file:text-accent transition-colors" />
        </div>
      )}

      {/* File icon/thumbnail with progress ring */}
      <div className="relative shrink-0">
        {showThumb ? (
          <div className="relative">
            <ImageThumb file={file} />
            {progressRing && <div className="absolute -inset-0.5">{progressRing}</div>}
          </div>
        ) : file.thumbnail ? (
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
              : isActive 
                ? 'bg-info/10 text-info' 
                : isPaused
                  ? 'bg-yellow-400/10 text-yellow-400'
                  : isPending
                    ? 'bg-info/5 text-info/60'
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
        <div className="flex items-center gap-2 mt-0.5">
          <p className="text-[10px] sm:text-[11px] text-muted font-mono">{formatBytes(file.size)}</p>
          {file.textPreview && <TextPreviewTooltip preview={file.textPreview} />}
          {isActive && !isPaused && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info">
              <span className="w-1 h-1 rounded-full bg-info animate-pulse" />
              transferring
            </span>
          )}
          {isPaused && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-yellow-400">
              <Pause className="w-2.5 h-2.5" />
              paused
            </span>
          )}
          {isPending && !isActive && !isPaused && pct == null && (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-info/70">
              <Clock className="w-2.5 h-2.5" />
              queued
            </span>
          )}
          {isDone && (
            <span className="font-mono text-[10px] text-accent/70">saved</span>
          )}
        </div>
      </div>

      {/* Progress percentage */}
      {pct != null && !isDone && (
        <span className="font-mono text-xs sm:text-sm tabular-nums text-info font-medium">{pct}%</span>
      )}

      {/* Actions */}
      <div className="flex items-center gap-1.5">
        {/* Download button */}
        {onRequest && !isPending && !isDone && pct == null && (
          <button
            onClick={(e) => { e.stopPropagation(); onRequest(index) }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2 rounded-lg font-mono text-[11px] sm:text-xs
              bg-accent/10 text-accent hover:bg-accent/20 active:scale-95 transition-all"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download</span>
          </button>
        )}

        {/* Pause button */}
        {onPause && isPending && isActive && !isPaused && (
          <button
            onClick={(e) => { e.stopPropagation(); onPause(index) }}
            aria-label="Pause download"
            className="p-2 rounded-lg text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20 active:scale-95 transition-all"
            title="Pause"
          >
            <Pause className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Resume button */}
        {onResume && isPaused && (
          <button
            onClick={(e) => { e.stopPropagation(); onResume(index) }}
            aria-label="Resume download"
            className="p-2 rounded-lg text-accent bg-accent/10 hover:bg-accent/20 active:scale-95 transition-all"
            title="Resume"
          >
            <Play className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Cancel button */}
        {onCancel && isPending && (
          <button
            onClick={(e) => { e.stopPropagation(); onCancel(index) }}
            className="p-2 rounded-lg text-danger bg-danger/10 hover:bg-danger/20 active:scale-95 transition-all"
            title="Cancel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}

        {/* Remove button */}
        {onRemove && (
          <button
            onClick={(e) => { e.stopPropagation(); onRemove(index) }}
            className="p-2 rounded-lg text-muted hover:text-danger hover:bg-danger/10 active:scale-95 transition-all 
              opacity-0 group-hover/file:opacity-100 focus:opacity-100"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  )
}

function FileItemContent({ file, Icon, showThumb, isDone }) {
  return (
    <>
      {showThumb ? (
        <ImageThumb file={file} />
      ) : (
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 transition-colors
          ${isDone ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-muted-light'}
        `}>
          {isDone ? <Check className="w-4 h-4" strokeWidth={2.5} /> : <Icon className="w-4 h-4" strokeWidth={1.5} />}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-mono truncate ${isDone ? 'text-accent' : 'text-text'}`}>{file.name}</p>
        <p className="text-[11px] text-muted font-mono">{formatBytes(file.size)}</p>
      </div>
    </>
  )
}

export default function FileList({ files, onRemove, onReorder, progress, pendingFiles, pausedFiles, onRequest, onCancel, onPause, onResume, onSave, currentFileIndex }) {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  const completedCount = files.filter((_, i) => progress?.[files[i]?.name] === 100).length
  const canDrag = !!onReorder && files.length > 1
  const [activeId, setActiveId] = useState(null)

  const itemIds = useMemo(() => files.map((_, i) => `file-${i}`), [files.length])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  function handleDragStart(event) {
    setActiveId(event.active.id)
  }

  function handleDragEnd(event) {
    setActiveId(null)
    const { active, over } = event
    if (!active || !over || active.id === over.id) return
    const from = itemIds.indexOf(active.id)
    const to = itemIds.indexOf(over.id)
    if (from !== -1 && to !== -1) onReorder(from, to)
  }

  function handleDragCancel() {
    setActiveId(null)
  }

  // Build the overlay content for the actively dragged item
  const activeIndex = activeId ? itemIds.indexOf(activeId) : -1
  const activeFile = activeIndex >= 0 ? files[activeIndex] : null
  const ActiveIcon = activeFile ? getIcon(activeFile.type) : File
  const activeShowThumb = activeFile && isImageType(activeFile.type) && activeFile instanceof window.File

  const fileItems = files.map((file, i) => {
    const Icon = getIcon(file.type)
    const pct = progress?.[file.name]
    const isDone = pct === 100
    const isPending = pendingFiles && pendingFiles[i]
    const isPaused = pausedFiles && pausedFiles[i]
    const isActive = currentFileIndex === i && pct != null && !isDone
    const showThumb = isImageType(file.type) && file instanceof window.File

    return (
      <SortableFileItem
        key={itemIds[i]}
        id={itemIds[i]}
        file={file}
        index={i}
        pct={pct}
        isDone={isDone}
        isPending={isPending}
        isActive={isActive}
        showThumb={showThumb}
        Icon={Icon}
        canDrag={canDrag}
        isPaused={isPaused}
        onRequest={onRequest}
        onRemove={onRemove}
        onCancel={onCancel}
        onPause={onPause}
        onResume={onResume}
      />
    )
  })

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center px-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted">
            {files.length} file{files.length !== 1 ? 's' : ''}
          </span>
          {canDrag && (
            <span className="hidden sm:inline-flex items-center gap-1 text-[10px] text-muted/50 font-mono">
              <GripVertical className="w-3 h-3" /> drag to reorder
            </span>
          )}
        </div>
        <span className="font-mono text-[11px] text-muted">{formatBytes(totalSize)}</span>
      </div>

      {canDrag ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            <div className="space-y-1.5">
              {fileItems}
            </div>
          </SortableContext>

          <DragOverlay dropAnimation={{ duration: 200, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }}>
            {activeFile ? (
              <div className="sortable-overlay flex items-center gap-3 rounded-xl px-4 py-3 border border-accent/40 bg-surface">
                <div className="flex items-center shrink-0 px-1">
                  <GripVertical className="w-4 h-4 text-accent" />
                </div>
                <FileItemContent file={activeFile} Icon={ActiveIcon} showThumb={activeShowThumb} isDone={false} />
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        <div className="space-y-1.5">
          {fileItems}
        </div>
      )}
    </div>
  )
}
