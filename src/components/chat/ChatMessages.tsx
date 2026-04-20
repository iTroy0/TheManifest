import React from 'react'
import { MessageCircle, ArrowDown, Smile, Reply, X } from 'lucide-react'
import Linkify from './Linkify'
import VoicePlayer from './VoicePlayer'
import type { MessageGroup } from './groupMessages'
import type { ReplyTo } from '../../hooks/useChatInteraction'
import type { ViewImage } from './ImagePreviewOverlay'

const EMOJIS = ['👍', '❤️', '😂', '😮', '🔥', '👎', '🎉', '💯', '👀', '🙏', '💀', '✨']

interface ChatMessagesProps {
  scrollRef: React.RefObject<HTMLDivElement | null>
  onScroll: () => void
  onContainerClick: () => void
  groupedMessages: MessageGroup[]
  hasMessages: boolean
  isFullscreen: boolean
  isPopout: boolean
  showScrollBtn: boolean
  scrollToBottom: () => void
  activeMsg: number | null
  reactingIdx: number | null
  onMsgClick: (i: number) => void
  onTouchStart: (i: number) => void
  onTouchEnd: () => void
  onReact: ((msgId: string, emoji: string) => void) | null | undefined
  setReactingIdx: (i: number | null) => void
  setActiveMsg: (i: number | null) => void
  setReplyTo: (r: ReplyTo) => void
  onViewImage: (v: ViewImage) => void
}

export default function ChatMessages({
  scrollRef, onScroll, onContainerClick, groupedMessages, hasMessages, isFullscreen, isPopout, showScrollBtn, scrollToBottom,
  activeMsg, reactingIdx, onMsgClick, onTouchStart, onTouchEnd, onReact, setReactingIdx, setActiveMsg, setReplyTo, onViewImage,
}: ChatMessagesProps) {
  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className={`relative overflow-y-auto space-y-3 scrollbar-thin scrollbar-thumb-border scrollbar-track-transparent overscroll-contain ${
        isFullscreen || isPopout
          ? 'flex-1 min-h-0 px-4 py-3 bg-bg'
          : 'h-[320px] pr-1'
      }`}
      onClick={onContainerClick}
    >
      {!hasMessages && (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <div className="w-12 h-12 rounded-xl glass-accent flex items-center justify-center mb-3">
            <MessageCircle className="w-5 h-5 text-accent/40" />
          </div>
          <p className="font-mono text-xs text-muted">No messages yet</p>
          <p className="text-[10px] text-muted/60 mt-1">Start the conversation</p>
        </div>
      )}

      {groupedMessages.map((group, groupIdx) => {
        if (group.isSystem) {
          return group.messages.map(msg => (
            <div key={`${msg.time}-system`} className="flex justify-center animate-fade-in-up">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-surface-2/50 border border-border/50 font-mono text-[10px] text-muted">
                {msg.text}
              </span>
            </div>
          ))
        }

        return (
          <div
            key={`group-${groupIdx}-${group.messages[0].time}`}
            className={`flex ${group.self ? 'justify-end' : 'justify-start'} animate-fade-in-up`}
          >
            <div className={`flex flex-col gap-0.5 max-w-[90%] sm:max-w-[80%] ${group.self ? 'items-end' : 'items-start'}`}>
              {!group.self && (
                <p className="font-mono text-[10px] text-accent/70 mb-0.5 px-1">{group.from}</p>
              )}

              {group.messages.map((msg, msgIdx) => {
                const i = msg.index
                const msgId = msg.id ?? `${msg.time}`
                const showActions = activeMsg === i
                const isFirst = msgIdx === 0
                const isLast = msgIdx === group.messages.length - 1

                return (
                  <div key={`${msg.time}-${i}`} className="relative group/msg">
                    <div
                      className={`
                        px-3 py-2 sm:px-3.5 sm:py-2.5 space-y-1 transition-colors cursor-pointer
                        ${group.self
                          ? `bg-accent/10 border border-accent/20 active:bg-accent/20 sm:hover:bg-accent/15
                             ${isFirst && isLast ? 'rounded-2xl rounded-tr-md' : isFirst ? 'rounded-t-2xl rounded-tr-md rounded-b-md' : isLast ? 'rounded-b-2xl rounded-t-md' : 'rounded-md'}`
                          : `bg-surface-2 border border-border active:bg-surface-2/70 sm:hover:bg-surface-2/80
                             ${isFirst && isLast ? 'rounded-2xl rounded-tl-md' : isFirst ? 'rounded-t-2xl rounded-tl-md rounded-b-md' : isLast ? 'rounded-b-2xl rounded-t-md' : 'rounded-md'}`
                        }
                      `}
                      onClick={(e: React.MouseEvent) => { e.stopPropagation(); onMsgClick(i) }}
                      onTouchStart={() => onTouchStart(i)}
                      onTouchEnd={onTouchEnd}
                    >
                      {msg.replyTo && (
                        <div className={`border-l-2 pl-2 mb-1.5 ${group.self ? 'border-accent/40' : 'border-muted/30'}`}>
                          <p className="font-mono text-[9px] text-accent/60">{msg.replyTo.from}</p>
                          <p className="text-[11px] text-muted truncate">{msg.replyTo.text || 'Image'}</p>
                        </div>
                      )}

                      {msg.image && msg.mime?.startsWith('audio/') ? (
                        <VoicePlayer src={msg.image} knownDuration={msg.duration} />
                      ) : msg.image ? (
                        <img
                          src={msg.image}
                          alt={`Image from ${msg.from}`}
                          className="rounded-lg max-w-full max-h-[200px] object-contain cursor-pointer hover:opacity-90 transition-opacity shadow-sm"
                          onClick={(e: React.MouseEvent) => { e.stopPropagation(); onViewImage({ url: msg.image, mime: msg.mime }) }}
                        />
                      ) : null}

                      {msg.text && (
                        <p className="text-[13px] text-text break-words leading-relaxed">
                          <Linkify text={msg.text} />
                        </p>
                      )}

                      <p className="text-[9px] text-muted/50 font-mono mt-0.5">
                        {new Date(msg.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>

                    {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                      <div className={`flex gap-1 mt-1 flex-wrap ${group.self ? 'justify-end' : 'justify-start'}`}>
                        {Object.entries(msg.reactions).map(([emoji, users]) => (
                          <span
                            key={emoji}
                            className="inline-flex items-center gap-0.5 bg-surface border border-border/80 rounded-full px-1.5 py-0.5 text-[11px] cursor-default hover:bg-surface-2 transition-colors shadow-sm"
                            title={users.join(', ')}
                          >
                            {emoji} <span className="font-mono text-muted-light text-[10px]">{users.length}</span>
                          </span>
                        ))}
                      </div>
                    )}

                    {onReact && (
                      <div className={`
                        flex items-center gap-1 mt-1 transition-all duration-150
                        ${showActions || reactingIdx === i ? 'opacity-100 max-h-20' : 'opacity-0 max-h-0 overflow-hidden sm:group-hover/msg:opacity-100 sm:group-hover/msg:max-h-20'}
                      `}>
                        {reactingIdx === i ? (
                          <div className="flex flex-wrap gap-0.5 p-1 bg-surface border border-border rounded-lg">
                            {EMOJIS.slice(0, 6).map(emoji => (
                              <button
                                key={emoji}
                                onClick={(e: React.MouseEvent) => { e.stopPropagation(); onReact(msgId, emoji); setReactingIdx(null); setActiveMsg(null) }}
                                className="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center rounded hover:bg-accent/15 active:scale-90 transition-all text-sm sm:text-base"
                              >
                                {emoji}
                              </button>
                            ))}
                            <button
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setReactingIdx(null) }}
                              className="w-8 h-8 sm:w-7 sm:h-7 flex items-center justify-center rounded hover:bg-danger/15 text-muted hover:text-danger active:scale-90 transition-all text-xs"
                            >
                              <X className="w-3 h-3" />
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setReactingIdx(i); setActiveMsg(i) }}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors text-[11px] font-mono"
                            >
                              <Smile className="w-3 h-3" />
                              <span className="hidden sm:inline">React</span>
                            </button>
                            <button
                              onClick={(e: React.MouseEvent) => { e.stopPropagation(); setReplyTo({ text: msg.text, from: msg.from, time: msg.time }); setActiveMsg(null) }}
                              className="flex items-center gap-1 px-2 py-1 rounded-md bg-surface border border-border text-muted hover:text-accent hover:border-accent/30 transition-colors text-[11px] font-mono"
                            >
                              <Reply className="w-3 h-3" />
                              <span className="hidden sm:inline">Reply</span>
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}

      {showScrollBtn && (
        <button
          onClick={scrollToBottom}
          className="sticky bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface border border-border shadow-lg shadow-black/30 text-muted hover:text-accent hover:border-accent/30 transition-colors animate-fade-in-up"
        >
          <ArrowDown className="w-3 h-3" />
          <span className="font-mono text-[10px]">New messages</span>
        </button>
      )}
    </div>
  )
}
