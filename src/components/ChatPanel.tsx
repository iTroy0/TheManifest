import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { sounds, alertNewMessage } from '../utils/notifications'
import ImagePreviewOverlay from './chat/ImagePreviewOverlay'
import { ChatHeaderPopout, ChatHeaderFullscreen, ChatHeaderCollapsed } from './chat/ChatHeader'
import ChatToolbar from './chat/ChatToolbar'
import ChatMenu from './chat/ChatMenu'
import ChatMessages from './chat/ChatMessages'
import ChatComposer from './chat/ChatComposer'
import ChatClearConfirm from './chat/ChatClearConfirm'
import { groupMessages } from './chat/groupMessages'
import { prepareImage, ImageTooLargeError } from '../utils/chatImage'
import { useChatPanelState } from '../hooks/useChatPanelState'
import { useChatInteraction, type ImagePreview, type ReplyTo } from '../hooks/useChatInteraction'
import { usePopout } from '../hooks/usePopout'
import { useVoiceRecorder } from '../hooks/useVoiceRecorder'
import { ChatMessage } from '../types'

const POPOUT_DEFAULT = { w: 384, h: 600 }
const POPOUT_MIN = { w: 280, h: 300 }
const ERROR_HIDE_MS = 4000
const DROP_ERROR_HIDE_MS = 3000

interface ChatPanelProps {
  messages: ChatMessage[]
  onSend: (text: string, image?: ImagePreview | { bytes: Uint8Array; mime: string } | string, replyTo?: ReplyTo) => void
  onClearMessages?: (() => void) | null
  disabled?: boolean
  nickname?: string
  onNicknameChange?: ((name: string) => void) | null
  onlineCount?: number
  onTyping?: (() => void) | null
  typingUsers?: string[]
  onReaction?: ((msgId: string, emoji: string) => void) | null
}

export default function ChatPanel({ messages, onSend, onClearMessages, disabled, nickname, onNicknameChange, onlineCount, onTyping, typingUsers, onReaction }: ChatPanelProps) {
  const [panel, dispatchPanel] = useChatPanelState()
  const { open, unread, isFullscreen, showMenu, showClearConfirm, showScrollBtn, isNearBottom, menuPos, viewportHeight, viewportOffset } = panel
  const popout = usePopout({
    defaultSize: POPOUT_DEFAULT,
    minSize: POPOUT_MIN,
    onToggle: (isPopoutNow) => dispatchPanel({ type: 'SET', payload: { open: isPopoutNow } }),
  })
  const { isPopout, pos: popoutPos, size: popoutSize, popOut, dockBack, onDragStart: onPopoutDragStart, onResizeStart: onPopoutResizeStart, elementRef: popoutRef } = popout
  const [interact, dispatchInteract] = useChatInteraction()
  const { replyTo, reactingIdx, activeMsg, imagePreview, viewImage, isDragOver, dropError } = interact
  const [text, setText] = useState('')
  const [editName, setEditName] = useState(nickname || '')
  const [soundEnabled, setSoundEnabled] = useState(true)
  const [notifyEnabled, setNotifyEnabled] = useState(false)
  const [micError, setMicError] = useState<string | null>(null)
  const [nameSaved, setNameSaved] = useState(false)

  const chatBlobUrlsRef = useRef<string[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const prevLen = useRef(messages.length)
  // Messages mirror so the alert effect can read latest items without
  // putting `messages` in its deps (reactions/edits change the ref without
  // changing length and would otherwise re-run the effect for no reason).
  const messagesRef = useRef(messages)
  const imageInputRef = useRef<HTMLInputElement | null>(null)
  const textInputRef = useRef<HTMLTextAreaElement | null>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null)

  const createTrackedBlobUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob)
    chatBlobUrlsRef.current.push(url)
    return url
  }, [])

  useEffect(() => {
    return () => {
      chatBlobUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    }
  }, [])

  useEffect(() => {
    if (nickname) setEditName(nickname)
  }, [nickname])

  useEffect(() => {
    if (open && textInputRef.current) {
      const t = setTimeout(() => textInputRef.current?.focus(), 100)
      return () => clearTimeout(t)
    }
  }, [open])

  const handleScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const threshold = 100
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold
    dispatchPanel({ type: 'SET', payload: { isNearBottom: nearBottom, showScrollBtn: !nearBottom && messages.length > 5 } })
  }, [messages.length])

  // H16: mirror `isNearBottom` into a ref so the ResizeObserver effect can
  // read the latest value without re-subscribing on every flip.
  const isNearBottomRef = useRef(isNearBottom)
  useEffect(() => { isNearBottomRef.current = isNearBottom }, [isNearBottom])

  useEffect(() => {
    const el = scrollRef.current
    if (!el || !open) return
    const observer = new ResizeObserver(() => {
      if (isNearBottomRef.current) {
        el.scrollTop = el.scrollHeight
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [open])

  // Sync the messages mirror every render. The alert effect below reads
  // it via .slice() to figure out which entries are newly arrived; doing
  // the assignment in the render body (instead of an empty-deps effect)
  // ensures the ref is current before any other effect reads it.
  messagesRef.current = messages

  useEffect(() => {
    const prev = prevLen.current
    const cur = messages.length
    if (cur > prev) {
      if (open && scrollRef.current && isNearBottom) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight
      }
      if (!open) {
        dispatchPanel({ type: 'INCREMENT_UNREAD', count: cur - prev })
      }
      const newMsgs = messagesRef.current.slice(prev, cur)
      const shouldAlert = !open || (typeof document !== 'undefined' && document.hidden)
      for (const msg of newMsgs) {
        if (!msg.self && msg.from !== 'system') {
          if (soundEnabled && shouldAlert) sounds.messageReceived()
          if (notifyEnabled) alertNewMessage(msg.from, msg.text || 'Image', false)
        }
      }
    }
    prevLen.current = cur
  }, [messages.length, open, isNearBottom, soundEnabled, notifyEnabled])

  useEffect(() => {
    if (open) dispatchPanel({ type: 'SET', payload: { unread: 0 } })
  }, [open])

  useEffect(() => {
    if (isFullscreen) {
      document.body.style.overflow = 'hidden'
      dispatchPanel({ type: 'SET', payload: { open: true } })
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isFullscreen])

  useEffect(() => {
    if (isPopout) dispatchPanel({ type: 'SET', payload: { open: true } })
  }, [isPopout])

  useEffect(() => {
    if (!isFullscreen) return
    const vv = window.visualViewport
    if (!vv) {
      dispatchPanel({ type: 'SET', payload: { viewportHeight: '100dvh', viewportOffset: 0 } })
      return
    }

    let rafId: number | null = null

    function handleViewportChange() {
      if (rafId) cancelAnimationFrame(rafId)

      rafId = requestAnimationFrame(() => {
        dispatchPanel({ type: 'SET', payload: { viewportHeight: `${vv!.height}px`, viewportOffset: vv!.offsetTop } })

        if (scrollRef.current && isNearBottom) {
          scrollRef.current.scrollTo({
            top: scrollRef.current.scrollHeight,
            behavior: 'instant' as ScrollBehavior,
          })
        }
      })
    }

    dispatchPanel({ type: 'SET', payload: { viewportHeight: `${vv.height}px`, viewportOffset: vv.offsetTop } })

    vv.addEventListener('resize', handleViewportChange)
    vv.addEventListener('scroll', handleViewportChange)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      vv.removeEventListener('resize', handleViewportChange)
      vv.removeEventListener('scroll', handleViewportChange)
    }
  }, [isFullscreen, isNearBottom])

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' })
    }
  }, [])

  function handleTyping(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
    if (onTyping) {
      if (!typingTimer.current) onTyping()
      if (typingTimer.current) clearTimeout(typingTimer.current)
      typingTimer.current = setTimeout(() => { typingTimer.current = null }, 2000)
    }
  }

  useEffect(() => {
    if (!text && textInputRef.current) {
      textInputRef.current.style.height = 'auto'
    }
  }, [text])

  useEffect(() => {
    if (!isDragOver) return
    const reset = () => dispatchInteract({ type: 'SET', payload: { isDragOver: false } })
    window.addEventListener('dragend', reset)
    window.addEventListener('drop', reset)
    return () => { window.removeEventListener('dragend', reset); window.removeEventListener('drop', reset) }
  }, [isDragOver])

  function showTransientMicError(msg: string) {
    setMicError(msg)
    setTimeout(() => setMicError(null), ERROR_HIDE_MS)
  }

  function showTransientDropError(msg: string) {
    dispatchInteract({ type: 'SET', payload: { dropError: msg } })
    setTimeout(() => dispatchInteract({ type: 'SET', payload: { dropError: null } }), DROP_ERROR_HIDE_MS)
  }

  const handleImageFile = useCallback(async (file: File) => {
    try {
      const img = await prepareImage(file, createTrackedBlobUrl)
      dispatchInteract({ type: 'SET', payload: { imagePreview: img } })
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        showTransientDropError(err.message)
        return
      }
      console.warn('Image drop/paste failed:', err)
      showTransientMicError('Could not process image.')
    }
  }, [createTrackedBlobUrl])

  function handleDrop(e: React.DragEvent<HTMLFormElement>) {
    e.preventDefault()
    dispatchInteract({ type: 'SET', payload: { isDragOver: false } })
    const files = Array.from(e.dataTransfer?.files || [])
    const file = files.find(f => f.type.startsWith('image/'))
    if (file) {
      void handleImageFile(file)
    } else if (files.length > 0) {
      showTransientDropError('Only images are supported in chat')
    }
  }

  // Voice recorder hook owns the MediaRecorder lifecycle. We pass clips
  // directly to the latest onSend via a ref-mirror inside the hook.
  const recorder = useVoiceRecorder({
    createTrackedBlobUrl,
    onError: (msg) => msg ? setMicError(msg) : setMicError(null),
    onSent: () => { if (soundEnabled) sounds.messageSent() },
    onClip: (clip) => {
      onSend('', clip, undefined)
    },
  })

  function handleSend(e: { preventDefault: () => void }) {
    e.preventDefault()
    if ((!text.trim() && !imagePreview) || disabled) return
    if (soundEnabled) sounds.messageSent()
    onSend(text.trim(), imagePreview ?? undefined, replyTo ?? undefined)
    setText('')
    dispatchInteract({ type: 'CLEAR_SEND' })
    textInputRef.current?.focus()
  }

  async function handleImagePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    e.target.value = ''
    try {
      const img = await prepareImage(file, createTrackedBlobUrl)
      dispatchInteract({ type: 'SET', payload: { imagePreview: img } })
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        showTransientDropError(err.message)
        return
      }
      console.warn('Image processing failed:', err)
      showTransientMicError('Could not process image. Try a different file.')
    }
  }

  useEffect(() => {
    if (!open || disabled) return
    function handlePaste(e: ClipboardEvent) {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      void handleImageFile(file)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [open, disabled, handleImageFile])

  const nameChanged = !!(editName.trim() && editName.trim() !== nickname)

  function handleSetName() {
    if (!nameChanged || !onNicknameChange) return
    onNicknameChange(editName.trim())
    setNameSaved(true)
    setTimeout(() => setNameSaved(false), 2000)
  }

  function handleTouchStart(i: number) {
    longPressTimer.current = setTimeout(() => {
      dispatchInteract({ type: 'TOGGLE_MSG', index: i })
    }, 400)
  }

  function handleTouchEnd() {
    if (longPressTimer.current) clearTimeout(longPressTimer.current)
  }

  useEffect(() => {
    if (!showMenu) return
    function handleClick(e: MouseEvent | TouchEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) dispatchPanel({ type: 'SET', payload: { showMenu: false } })
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('touchstart', handleClick)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('touchstart', handleClick)
    }
  }, [showMenu])

  function handleMsgClick(i: number) {
    dispatchInteract({ type: 'TOGGLE_MSG', index: i })
  }

  const typingText = typingUsers && typingUsers.length > 0
    ? typingUsers.length === 1
      ? typingUsers[0]
      : `${typingUsers.slice(0, 2).join(', ')}${typingUsers.length > 2 ? ` +${typingUsers.length - 2}` : ''}`
    : null

  const groupedMessages = useMemo(() => groupMessages(messages), [messages])

  const setReactingIdx = (i: number | null) => dispatchInteract({ type: 'SET', payload: { reactingIdx: i } })
  const setActiveMsg = (i: number | null) => dispatchInteract({ type: 'SET', payload: { activeMsg: i } })
  const setReplyTo = (r: ReplyTo) => dispatchInteract({ type: 'SET', payload: { replyTo: r } })
  const clearReplyTo = () => dispatchInteract({ type: 'SET', payload: { replyTo: null } })
  const clearImagePreview = () => {
    if (imagePreview?.url?.startsWith('blob:')) URL.revokeObjectURL(imagePreview.url)
    dispatchInteract({ type: 'SET', payload: { imagePreview: null } })
  }

  return (
    <div
      ref={popoutRef}
      className={`animate-fade-in-up ${
        isFullscreen
          ? 'fixed left-0 right-0 z-[60] bg-bg flex flex-col'
          : isPopout
            ? 'fixed z-[60] rounded-2xl shadow-2xl glass-strong flex flex-col overflow-hidden'
            : 'glow-card overflow-hidden transition-all duration-300'
      }`}
      style={
        isFullscreen ? {
          top: `${viewportOffset}px`,
          height: viewportHeight,
          paddingBottom: 'env(safe-area-inset-bottom, 0)'
        }
        : isPopout ? {
          width: `${popoutSize.w}px`,
          height: `${popoutSize.h}px`,
          top: popoutPos ? `${popoutPos.y}px` : undefined,
          left: popoutPos ? `${popoutPos.x}px` : undefined,
          bottom: popoutPos ? undefined : '1rem',
          right: popoutPos ? undefined : '1rem',
        }
        : undefined
      }
    >
      {isPopout && !isFullscreen && (
        <ChatHeaderPopout
          onlineCount={onlineCount}
          hasMessages={messages.length > 0}
          hasClear={!!onClearMessages}
          onRequestClear={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: true } })}
          onDragStart={onPopoutDragStart}
          onResizeStart={onPopoutResizeStart}
          onFullscreen={() => dispatchPanel({ type: 'SET', payload: { isFullscreen: true } })}
          onDock={dockBack}
        />
      )}

      {isFullscreen ? (
        <div className="relative">
          <ChatHeaderFullscreen
            onlineCount={onlineCount}
            isPopout={isPopout}
            onExitFullscreen={() => dispatchPanel({ type: 'SET', payload: { isFullscreen: false, ...(!isPopout && { open: true }) } })}
            menuTriggerRef={menuTriggerRef}
            onMenuTriggerClick={(e) => {
              e.stopPropagation()
              const rect = e.currentTarget.getBoundingClientRect()
              dispatchPanel({ type: 'SET', payload: { menuPos: { top: rect.bottom + 4, right: window.innerWidth - rect.right } } })
              dispatchPanel({ type: 'TOGGLE_MENU' })
            }}
          />
          {showMenu && (
            <ChatMenu
              menuPos={menuPos}
              menuRef={menuRef}
              onNicknameChange={onNicknameChange}
              editName={editName}
              setEditName={setEditName}
              nameChanged={nameChanged}
              nameSaved={nameSaved}
              handleSetName={handleSetName}
              closeMenu={() => dispatchPanel({ type: 'SET', payload: { showMenu: false } })}
              soundEnabled={soundEnabled}
              setSoundEnabled={setSoundEnabled}
              notifyEnabled={notifyEnabled}
              setNotifyEnabled={setNotifyEnabled}
              onMicError={showTransientMicError}
              hasMessages={messages.length > 0}
              onClearMessages={onClearMessages}
              onRequestClear={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: true, showMenu: false } })}
            />
          )}
        </div>
      ) : !isPopout ? (
        <ChatHeaderCollapsed
          open={open}
          unread={unread}
          onlineCount={onlineCount}
          hasMessages={messages.length > 0}
          hasClear={!!onClearMessages}
          onRequestClear={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: true } })}
          onToggleOpen={() => dispatchPanel({ type: 'TOGGLE_OPEN' })}
          onPopOut={popOut}
          onFullscreen={() => dispatchPanel({ type: 'SET', payload: { isFullscreen: true } })}
        />
      ) : null}

      <div className={`transition-all duration-400 ease-in-out ${
        isFullscreen || isPopout
          ? 'flex-1 flex flex-col overflow-hidden'
          : `grid ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`
      }`}>
        <div className={isFullscreen || isPopout ? 'flex-1 flex flex-col overflow-hidden' : 'overflow-hidden'}>
          <div className={`${isFullscreen || isPopout ? 'flex-1 flex flex-col overflow-hidden' : 'px-3 sm:px-4 pb-4 space-y-3'}`}>
            {!isFullscreen && (
              <ChatToolbar
                onNicknameChange={onNicknameChange}
                editName={editName}
                setEditName={setEditName}
                nameChanged={nameChanged}
                nameSaved={nameSaved}
                handleSetName={handleSetName}
                soundEnabled={soundEnabled}
                setSoundEnabled={setSoundEnabled}
                notifyEnabled={notifyEnabled}
                setNotifyEnabled={setNotifyEnabled}
              />
            )}

            <ChatMessages
              scrollRef={scrollRef}
              onScroll={handleScroll}
              onContainerClick={() => {
                dispatchInteract({ type: 'SET', payload: { reactingIdx: null, activeMsg: null } })
                if (showMenu) dispatchPanel({ type: 'SET', payload: { showMenu: false } })
              }}
              groupedMessages={groupedMessages}
              hasMessages={messages.length > 0}
              isFullscreen={isFullscreen}
              isPopout={isPopout}
              showScrollBtn={showScrollBtn}
              scrollToBottom={scrollToBottom}
              activeMsg={activeMsg}
              reactingIdx={reactingIdx}
              onMsgClick={handleMsgClick}
              onTouchStart={handleTouchStart}
              onTouchEnd={handleTouchEnd}
              onReact={onReaction}
              setReactingIdx={setReactingIdx}
              setActiveMsg={setActiveMsg}
              setReplyTo={setReplyTo}
              onViewImage={(v) => dispatchInteract({ type: 'SET', payload: { viewImage: v } })}
            />

            <ChatComposer
              isFullscreen={isFullscreen}
              isPopout={isPopout}
              disabled={disabled}
              text={text}
              setText={setText}
              textInputRef={textInputRef}
              imageInputRef={imageInputRef}
              onTextChange={handleTyping}
              onImagePick={handleImagePick}
              onSubmit={handleSend}
              isDragOver={isDragOver}
              setIsDragOver={(v) => dispatchInteract({ type: 'SET', payload: { isDragOver: v } })}
              onDrop={handleDrop}
              imagePreview={imagePreview}
              clearImagePreview={clearImagePreview}
              replyTo={replyTo}
              clearReplyTo={clearReplyTo}
              typingText={typingText}
              dropError={dropError}
              micError={micError}
              isRecording={recorder.isRecording}
              recordingTime={recorder.recordingTime}
              hasRecordingSupport={recorder.hasRecordingSupport}
              startRecording={recorder.startRecording}
              stopRecording={recorder.stopRecording}
              cancelRecording={recorder.cancelRecording}
            />
          </div>
        </div>
      </div>
      {showClearConfirm && (
        <ChatClearConfirm
          onCancel={() => dispatchPanel({ type: 'SET', payload: { showClearConfirm: false } })}
          onConfirm={() => { onClearMessages?.(); dispatchPanel({ type: 'SET', payload: { showClearConfirm: false } }) }}
        />
      )}
      {viewImage && (
        <ImagePreviewOverlay viewImage={viewImage} onClose={() => dispatchInteract({ type: 'SET', payload: { viewImage: null } })} />
      )}
    </div>
  )
}
