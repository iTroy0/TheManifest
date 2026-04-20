import React, { useCallback, useEffect, useRef } from 'react'
import { prepareImage, ImageTooLargeError } from '../utils/chatImage'
import type { ImagePreview } from './useChatInteraction'

export interface UseChatDropAndPasteOptions {
  // Controls whether the global paste listener is active. ChatPanel sets
  // this to `open && !disabled` so paste only intercepts when the chat
  // surface is engaged.
  enabled: boolean
  // Receives the prepared image preview (compressed JPEG or raw GIF) so
  // the caller can stash it in its own reducer / state.
  onImage: (preview: ImagePreview) => void
  // Generic image-processing failure (canvas refused, unsupported codec).
  onError: (msg: string) => void
  // Drop-specific user-facing error (oversize GIF, non-image file dropped)
  // — separated because the host UI usually wants different copy + a
  // different display window than `onError`.
  onDropError: (msg: string) => void
}

export interface ChatDropAndPasteApi {
  // Mints a `blob:` URL and tracks it so the hook can revoke on unmount —
  // exported so callers can hand the same tracker to other consumers
  // (e.g., useVoiceRecorder for voice-note URLs).
  createTrackedBlobUrl: (blob: Blob) => string
  // Form `onDrop` handler. Filters to the first image file, surfaces a
  // user-facing message if the drop carried only non-image files.
  handleDrop: (e: React.DragEvent<HTMLFormElement>) => void
  // <input type="file"> change handler. Resets the input value so the
  // same file can be re-picked back-to-back.
  handleImagePick: (e: React.ChangeEvent<HTMLInputElement>) => void
}

// Owns the chat composer's image-input lifecycle: blob-URL tracking,
// image preparation (GIF passthrough vs compress), and the global paste
// listener. Extracted from ChatPanel so the orchestrator stays focused
// on layout + state wiring.
export function useChatDropAndPaste({ enabled, onImage, onError, onDropError }: UseChatDropAndPasteOptions): ChatDropAndPasteApi {
  const chatBlobUrlsRef = useRef<string[]>([])

  const createTrackedBlobUrl = useCallback((blob: Blob): string => {
    const url = URL.createObjectURL(blob)
    chatBlobUrlsRef.current.push(url)
    return url
  }, [])

  // Mirror callbacks into refs so the long-lived paste listener / drop
  // handler always read the latest props without re-subscribing.
  const onImageRef = useRef(onImage)
  const onErrorRef = useRef(onError)
  const onDropErrorRef = useRef(onDropError)
  useEffect(() => { onImageRef.current = onImage }, [onImage])
  useEffect(() => { onErrorRef.current = onError }, [onError])
  useEffect(() => { onDropErrorRef.current = onDropError }, [onDropError])

  useEffect(() => {
    return () => {
      chatBlobUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
    }
  }, [])

  const handleImageFile = useCallback(async (file: File): Promise<void> => {
    try {
      const img = await prepareImage(file, createTrackedBlobUrl)
      onImageRef.current(img)
    } catch (err) {
      if (err instanceof ImageTooLargeError) {
        onDropErrorRef.current(err.message)
        return
      }
      console.warn('Image processing failed:', err)
      onErrorRef.current('Could not process image.')
    }
  }, [createTrackedBlobUrl])

  const handleDrop = useCallback((e: React.DragEvent<HTMLFormElement>): void => {
    e.preventDefault()
    const files = Array.from(e.dataTransfer?.files || [])
    const file = files.find(f => f.type.startsWith('image/'))
    if (file) {
      void handleImageFile(file)
    } else if (files.length > 0) {
      onDropErrorRef.current('Only images are supported in chat')
    }
  }, [handleImageFile])

  const handleImagePick = useCallback((e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0]
    if (!file || !file.type.startsWith('image/')) return
    e.target.value = ''
    void handleImageFile(file)
  }, [handleImageFile])

  useEffect(() => {
    if (!enabled) return
    function handlePaste(e: ClipboardEvent): void {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))
      if (!item) return
      e.preventDefault()
      const file = item.getAsFile()
      if (!file) return
      void handleImageFile(file)
    }
    window.addEventListener('paste', handlePaste)
    return () => window.removeEventListener('paste', handlePaste)
  }, [enabled, handleImageFile])

  return { createTrackedBlobUrl, handleDrop, handleImagePick }
}
