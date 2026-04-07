import { useState, useEffect, useMemo } from 'react'
import { FileText, Image, FileCode, Film, Music, Archive, File, X, Download, GripVertical } from 'lucide-react'
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

function ImageThumb({ file }) {
  const [src, setSrc] = useState(null)
  useEffect(() => {
    if (!(file instanceof window.File) || !isImageType(file.type)) return
    const url = URL.createObjectURL(file)
    setSrc(url)
    return () => URL.revokeObjectURL(url)
  }, [file])
  if (!src) return null
  return <img src={src} alt="" className="w-7 h-7 rounded-md object-cover" />
}

function SortableFileItem({ id, file, index, pct, isDone, isPending, isActive, showThumb, Icon, canDrag, onRequest, onRemove }) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`
        sortable-item flex items-center gap-2.5 rounded-lg px-3 py-2
        border animate-fade-in-up
        ${isDone
          ? 'bg-accent/5 border-accent/20'
          : isActive
            ? 'bg-info/5 border-info/20'
            : 'bg-surface border-border hover:border-border-hover'
        }
        ${isDragging ? 'sortable-placeholder' : ''}
      `}
    >
      {canDrag && (
        <div
          {...attributes}
          {...listeners}
          className="flex items-center cursor-grab active:cursor-grabbing shrink-0 py-2 -my-2 px-1 rounded hover:bg-surface-2 transition-colors touch-none"
        >
          <GripVertical className="w-4 h-4 text-muted/40 hover:text-muted-light transition-colors" />
        </div>
      )}

      {showThumb ? (
        <ImageThumb file={file} />
      ) : (
        <div className={`
          w-7 h-7 rounded-md flex items-center justify-center shrink-0
          ${isDone ? 'bg-accent/15 text-accent' : isActive ? 'bg-info/15 text-info' : 'bg-surface-2 text-muted-light'}
        `}>
          <Icon className="w-3.5 h-3.5" strokeWidth={1.5} />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="text-xs font-mono truncate text-text">{file.name}</p>
        <div className="flex items-center gap-2">
          <p className="text-[10px] text-muted font-mono">{formatBytes(file.size)}</p>
          {isActive && <span className="font-mono text-[10px] text-info animate-pulse">transferring</span>}
          {isPending && !isActive && pct == null && <span className="font-mono text-[10px] text-info animate-pulse">queued</span>}
        </div>
      </div>

      {pct != null && !isDone && (
        <span className="font-mono text-xs tabular-nums text-info">{pct}%</span>
      )}

      {onRequest && !isPending && !isDone && pct == null && (
        <button
          onClick={(e) => { e.stopPropagation(); onRequest(index) }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs
            bg-info/10 text-info hover:bg-info/20 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Download
        </button>
      )}

      {isDone && (
        <span className="font-mono text-xs text-accent">saved</span>
      )}

      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(index) }}
          className="text-muted hover:text-danger transition-colors p-1 rounded-lg hover:bg-danger/10"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

function FileItemContent({ file, Icon, showThumb }) {
  return (
    <>
      {showThumb ? (
        <ImageThumb file={file} />
      ) : (
        <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 bg-surface-2 text-muted-light">
          <Icon className="w-4 h-4" strokeWidth={1.5} />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-mono truncate text-text">{file.name}</p>
        <p className="text-[11px] text-muted font-mono">{formatBytes(file.size)}</p>
      </div>
    </>
  )
}

export default function FileList({ files, onRemove, onReorder, progress, pendingFiles, onRequest, onSave, currentFileIndex }) {
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  const canDrag = !!onReorder && files.length > 1
  const [activeId, setActiveId] = useState(null)

  const itemIds = useMemo(() => files.map((_, i) => `file-${i}`), [files.length])

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
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
        onRequest={onRequest}
        onRemove={onRemove}
      />
    )
  })

  return (
    <div className="space-y-2">
      <div className="flex justify-between items-center mb-1 px-1">
        <span className="font-mono text-[10px] text-muted uppercase tracking-widest">
          {files.length} file{files.length !== 1 ? 's' : ''}
        </span>
        <span className="font-mono text-[10px] text-muted">{formatBytes(totalSize)}</span>
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

          <DragOverlay dropAnimation={{ duration: 250, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' }}>
            {activeFile ? (
              <div className="sortable-overlay flex items-center gap-3 rounded-xl px-4 py-3 border border-accent/30 bg-surface">
                <div className="flex items-center shrink-0 px-1">
                  <GripVertical className="w-4 h-4 text-accent/60" />
                </div>
                <FileItemContent file={activeFile} Icon={ActiveIcon} showThumb={activeShowThumb} />
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
