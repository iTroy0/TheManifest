import React from 'react'
import { Send, X, ImagePlus, Mic } from 'lucide-react'
import TypingDots from './TypingDots'
import type { ImagePreview, ReplyTo } from '../../hooks/useChatInteraction'

interface ChatComposerProps {
  isFullscreen: boolean
  isPopout: boolean
  disabled?: boolean
  text: string
  setText: (v: string) => void
  textInputRef: React.RefObject<HTMLTextAreaElement | null>
  imageInputRef: React.RefObject<HTMLInputElement | null>
  onTextChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onImagePick: (e: React.ChangeEvent<HTMLInputElement>) => void
  onSubmit: (e: { preventDefault: () => void }) => void
  isDragOver: boolean
  setIsDragOver: (v: boolean) => void
  onDrop: (e: React.DragEvent<HTMLFormElement>) => void
  imagePreview: ImagePreview | null
  clearImagePreview: () => void
  replyTo: ReplyTo | null
  clearReplyTo: () => void
  typingText: string | null
  dropError: string | null
  micError: string | null
  // Voice recorder
  isRecording: boolean
  recordingTime: number
  hasRecordingSupport: boolean
  startRecording: () => void
  stopRecording: () => void
  cancelRecording: () => void
}

export default function ChatComposer({
  isFullscreen, isPopout, disabled,
  text, textInputRef, imageInputRef, onTextChange, onImagePick, onSubmit,
  isDragOver, setIsDragOver, onDrop,
  imagePreview, clearImagePreview, replyTo, clearReplyTo,
  typingText, dropError, micError,
  isRecording, recordingTime, hasRecordingSupport, startRecording, stopRecording, cancelRecording,
}: ChatComposerProps) {
  const isFloating = isFullscreen || isPopout
  return (
    <div className={`shrink-0 ${isFloating ? 'bg-surface/80 backdrop-blur-sm border-t border-border' : 'space-y-2'}`}>
      {typingText && (
        <div className={`flex items-center gap-2 ${isFloating ? 'px-4 py-1.5' : 'px-1'}`}>
          <div className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-2/50 border border-border/50">
            <span className="font-mono text-[10px] text-muted-light">{typingText}</span>
            <TypingDots />
          </div>
        </div>
      )}

      {dropError && (
        <div className={`flex items-center gap-2 bg-danger/10 border border-danger/20 animate-fade-in-up ${isFloating ? 'mx-4 my-2 px-3 py-2 rounded-xl' : 'px-3 py-2 rounded-xl'}`}>
          <X className="w-3.5 h-3.5 text-danger shrink-0" />
          <span className="font-mono text-xs text-danger">{dropError}</span>
        </div>
      )}

      {micError && (
        <div className={`flex items-center gap-2 bg-danger/10 border border-danger/20 animate-fade-in-up ${isFloating ? 'mx-4 my-2 px-3 py-2 rounded-xl' : 'px-3 py-2 rounded-xl'}`}>
          <X className="w-3.5 h-3.5 text-danger shrink-0" />
          <span className="font-mono text-xs text-danger">{micError}</span>
        </div>
      )}

      {(replyTo || imagePreview) && (
        // Cap the above-fold strip on mobile so reply + image previews can't
        // push the textarea below the keyboard. Tablet+ has room to spare.
        <div className="max-h-[40vh] overflow-y-auto sm:max-h-none sm:overflow-visible">
          {replyTo && (
            <div className={`flex items-center gap-2 bg-accent/5 animate-fade-in-up ${isFloating ? 'px-4 py-2 border-b border-accent/20' : 'px-3 py-2 border border-accent/20 rounded-xl'}`}>
              <div className="w-1 h-8 bg-accent/60 rounded-full shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[10px] text-accent font-medium">Replying to {replyTo.from}</p>
                <p className="text-xs text-muted truncate mt-0.5">{replyTo.text || 'Image'}</p>
              </div>
              <button
                onClick={clearReplyTo}
                className="p-1.5 rounded-lg text-muted hover:text-danger hover:bg-danger/10 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {imagePreview && (
            <div className={`relative inline-block animate-fade-in-up ${isFloating ? 'mx-4 my-2' : ''}`}>
              <img src={imagePreview.url} alt="Upload preview" className="h-20 rounded-xl border border-border shadow-sm object-cover" />
              <button
                onClick={clearImagePreview}
                className="absolute -top-2 -right-2 w-6 h-6 rounded-full bg-danger text-white flex items-center justify-center shadow-md hover:bg-danger/90 transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      <form
        onSubmit={onSubmit}
        onDragOver={(e: React.DragEvent<HTMLFormElement>) => { e.preventDefault(); setIsDragOver(true) }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={onDrop}
        className={`flex gap-1.5 sm:gap-2 items-end ${isFloating ? 'px-3 py-2' : ''} ${isDragOver ? 'ring-2 ring-accent/40 rounded-xl' : ''}`}
        style={{ paddingBottom: isFullscreen ? 'env(safe-area-inset-bottom, 0px)' : undefined }}
      >
        <input ref={imageInputRef} type="file" accept="image/*" onChange={onImagePick} className="hidden" />

        {isRecording ? (
          <>
            <button
              type="button"
              onClick={cancelRecording}
              aria-label="Cancel recording"
              className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-surface border border-border text-danger
                hover:bg-danger/10 active:scale-95 transition-all flex items-center justify-center self-end"
            >
              <X className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <div className="flex-1 flex items-center gap-3 px-3 py-2.5 bg-bg border border-danger/30 rounded-xl min-h-[40px] sm:min-h-[44px]">
              <span className="w-2.5 h-2.5 rounded-full bg-danger animate-pulse shrink-0" />
              <span className="font-mono text-sm text-danger">{Math.floor(recordingTime / 60)}:{(recordingTime % 60).toString().padStart(2, '0')}</span>
              <div className="flex-1 flex items-center gap-0.5">
                {Array.from({ length: 20 }).map((_, i) => (
                  <div key={i} className={`w-1 rounded-full bg-danger/60 transition-all ${i < (recordingTime % 5) + 1 ? 'h-3' : 'h-1'}`} />
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={stopRecording}
              aria-label="Send voice note"
              className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-accent text-bg
                hover:bg-accent-dim active:scale-90 shadow-lg shadow-accent/25 transition-all flex items-center justify-center self-end"
            >
              <Send className="w-4 h-4" />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={disabled}
              aria-label="Attach image"
              className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-surface border border-border text-muted
                hover:text-accent hover:border-accent/30 active:scale-95 transition-all flex items-center justify-center
                disabled:opacity-30 disabled:cursor-not-allowed self-end"
            >
              <ImagePlus className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <textarea
              ref={textInputRef}
              dir="auto"
              rows={1}
              autoComplete="off"
              autoCorrect="on"
              autoCapitalize="sentences"
              spellCheck={true}
              enterKeyHint="send"
              data-form-type="other"
              data-lpignore="true"
              data-1p-ignore="true"
              value={text}
              onChange={onTextChange}
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSubmit(e)
                }
              }}
              placeholder={disabled ? 'Connect to chat' : 'Message...'}
              maxLength={2000}
              disabled={disabled}
              className="flex-1 min-w-0 bg-bg border border-border rounded-xl px-3 py-2.5 sm:px-4 sm:py-3 font-mono text-[16px] sm:text-sm text-text
                placeholder:text-muted/50 focus:outline-none focus:border-accent/50 transition-all
                disabled:opacity-40 disabled:cursor-not-allowed min-h-[40px] sm:min-h-[44px] max-h-[120px]
                resize-none overflow-y-auto scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent"
            />
            {!text.trim() && !imagePreview ? (
              <button
                type="button"
                onClick={startRecording}
                disabled={disabled || !hasRecordingSupport}
                aria-label="Record voice note"
                className="shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-surface border border-border text-muted
                  hover:text-accent hover:border-accent/30 active:scale-95 transition-all flex items-center justify-center
                  disabled:opacity-30 disabled:cursor-not-allowed self-end"
              >
                <Mic className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            ) : (
              <button
                type="submit"
                disabled={disabled || (!text.trim() && !imagePreview)}
                aria-label="Send message"
                className={`shrink-0 w-10 h-10 sm:w-11 sm:h-11 rounded-xl flex items-center justify-center transition-all self-end
                  ${!disabled && (text.trim() || imagePreview)
                    ? 'bg-accent text-bg hover:bg-accent-dim active:scale-90 shadow-lg shadow-accent/25'
                    : 'bg-surface border border-border text-muted/40 cursor-not-allowed'
                  }`}
              >
                <Send className="w-4 h-4" />
              </button>
            )}
          </>
        )}
      </form>
    </div>
  )
}
