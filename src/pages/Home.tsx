import { useState, useCallback, useEffect, useRef, type ChangeEvent } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { AlertTriangle, Shield, Zap, EyeOff, RotateCcw, Upload, Link as LinkIcon, Send, ChevronDown, Eye, Lock, Users, MessagesSquare, Phone, Mic, Plus, Share2, type LucideIcon } from 'lucide-react'
import { useSender } from '../hooks/useSender'
import { formatSpeed, formatTime, formatBytes } from '../utils/formatBytes'
import { usePageTitle } from '../hooks/usePageTitle'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import DropZone from '../components/DropZone'
import FileList from '../components/FileList'
import PortalLink from '../components/PortalLink'
import ProgressBar from '../components/ProgressBar'
import StatusIndicator from '../components/StatusIndicator'
import ChatPanel from '../components/ChatPanel'
import CallPanelLazy from '../components/CallPanelLazy'
import AppFooter from '../components/AppFooter'
import { ComponentErrorBoundary } from '../components/ErrorBoundary'

export default function Home() {
  const [files, setFilesState] = useState<File[]>([])
  const [error, setError] = useState<string | null>(null)
  const { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint, recipientCount, setPassword, setChatOnly, peer, participants, sendCallMessage, broadcastCallMessage, setCallMessageHandler, broadcastManifest, messages, sendMessage, clearMessages, rtt, senderName, changeSenderName, typingUsers, sendTyping, sendReaction } = useSender()
  const addInputRef = useRef<HTMLInputElement>(null)
  const resetModalRef = useRef<HTMLDivElement>(null)
  const [passwordInput, setPasswordInput] = useState<string>('')
  const [filesOpen, setFilesOpen] = useState<boolean>(true)
  const [chatMode, setChatMode] = useState<boolean>(false)
  const [showResetConfirm, setShowResetConfirm] = useState<boolean>(false)
  // Tracks whether the user intentionally started a session (added files
  // or started chat). Stays true even if all files are removed so the
  // portal link / chat / connection status remain visible. Only resets
  // on "New Session".
  const [sessionStarted, setSessionStarted] = useState<boolean>(false)

  const hasFiles: boolean = files.length > 0
  const isActive: boolean = hasFiles || chatMode || sessionStarted
  const isTransferring: boolean = status === 'transferring'
  const showProgress: boolean = status === 'transferring' || status === 'done'
  const isFinished: boolean = status === 'done' || status === 'closed' || status === 'error'

  usePageTitle(isActive ? status : '', overallProgress)
  const elapsed: number = useElapsedTime(isTransferring)

  const prevFilesLen = useRef<number>(files.length)
  useEffect(() => {
    setFiles(files)
    // Broadcast updated manifest when files change while connected
    if (files.length !== prevFilesLen.current && recipientCount > 0) {
      broadcastManifest()
    }
    prevFilesLen.current = files.length
  }, [files, setFiles, recipientCount, broadcastManifest])

  useEffect(() => {
    if (!isActive) return
    const handler = (e: BeforeUnloadEvent): void => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isActive])

  useEffect(() => {
    if (!showResetConfirm) return
    const modal = resetModalRef.current
    if (!modal) return
    const focusables = modal.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const prevActive = document.activeElement as HTMLElement | null
    first?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || focusables.length === 0) return
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault()
        last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      prevActive?.focus?.()
    }
  }, [showResetConfirm])

  const handleFiles = useCallback((newFiles: File[]): void => {
    setError(null)
    if (newFiles.length > 0) setSessionStarted(true)
    setFilesState(prev => [...prev, ...newFiles])
  }, [])

  const removeFile = useCallback((index: number): void => {
    setFilesState(prev => prev.filter((_, i) => i !== index))
  }, [])

  const reorderFiles = useCallback((fromIndex: number, toIndex: number): void => {
    setFilesState(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])

  const startChatRoom = useCallback((): void => {
    setChatMode(true)
    setChatOnly(true)
    setSessionStarted(true)
  }, [setChatOnly])

  const performReset = useCallback((): void => {
    setShowResetConfirm(false)
    setFilesState([])
    setError(null)
    setPasswordInput('')
    setChatMode(false)
    setSessionStarted(false)
    reset()
  }, [reset])

  const handleNewSession = useCallback((): void => {
    if (sessionStarted) {
      setShowResetConfirm(true)
      return
    }
    performReset()
  }, [sessionStarted, performReset])

  return (
    <div className="min-h-screen flex flex-col bg-grid">

      <header className="border-b border-border/60 glass">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/" className="group flex items-center gap-3" onClick={isActive ? (e) => { e.preventDefault(); handleNewSession() } : undefined} aria-label="The Manifest — go to home">
            <span className="relative inline-flex w-9 h-9 rounded-xl items-center justify-center glass-accent shrink-0">
              <Shield className="w-4 h-4 text-accent" strokeWidth={2} />
              <span className="absolute inset-0 rounded-xl bg-accent/10 blur-md -z-10" />
            </span>
            <span>
              <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                The Manifest
              </h1>
              <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide">
                Encrypted file sharing & chat
              </p>
            </span>
          </Link>
          <div className="flex items-center gap-2">
            {isActive && !isFinished && (
              <button
                onClick={handleNewSession}
                aria-label="New session"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs
                  bg-surface border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">New</span>
              </button>
            )}
            <Link
              to="/faq"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs
                bg-surface border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors"
            >
              <span>FAQ</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-8">

        {!isActive && (
          <div className="max-w-[720px] mx-auto space-y-6">
            <div className="text-center py-6 animate-fade-in-up">
              <span className="inline-flex items-center gap-1.5 px-3 py-1 mb-4 rounded-full glass-accent text-[10px] font-mono text-accent uppercase tracking-[0.18em]">
                <span className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse" />
                Zero server &middot; Zero trace
              </span>
              <h2 className="font-mono text-2xl sm:text-3xl font-bold mb-3 tracking-tight text-balance">
                <span className="text-text-bright">Share files &amp; chat. </span>
                <span className="text-gradient-accent">No servers. No trace.</span>
              </h2>
              <p className="text-sm text-muted-light max-w-md mx-auto leading-relaxed text-pretty">
                Files and messages stream directly browser-to-browser via WebRTC.
                End-to-end encrypted. Close the tab and it&apos;s gone.
              </p>
            </div>

            <DropZone onFiles={handleFiles} disabled={isTransferring || isFinished} />
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 sm:gap-4">
              <div className="h-px flex-1 bg-border/50 hidden sm:block" />
              <button
                onClick={startChatRoom}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
                  glass text-muted-light hover:text-accent hover:border-accent/40 active:scale-[0.98] transition-all"
              >
                <MessagesSquare className="w-4 h-4" />
                Start a chat room
              </button>
              <Link
                to="/collab"
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
                  glass-accent text-accent hover:text-accent-bright hover:border-accent/50 active:scale-[0.98] transition-all"
              >
                <Share2 className="w-4 h-4" />
                Collaborative room
              </Link>
              <div className="h-px flex-1 bg-border/50 hidden sm:block" />
            </div>

            <HowItWorks />

            <div className="animate-fade-in-up" style={{ animationDelay: '350ms' }}>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 [&>*:last-child:nth-child(odd)]:col-span-2 sm:[&>*:last-child:nth-child(odd)]:col-span-1">
                <InfoCard icon={Shield} title="E2E encrypted" desc="Double encryption — AES-256-GCM + WebRTC DTLS. Even relays can't see your data." />
                <InfoCard icon={EyeOff} title="Zero knowledge" desc="No accounts. No logs. No analytics. Self-hosted signaling for full privacy." />
                <InfoCard icon={Zap} title="Ephemeral" desc="Close the tab and it's gone. No traces left behind." />
                <InfoCard icon={Users} title="Multi-recipient" desc="Unlimited simultaneous connections. Each gets their own encrypted channel." />
                <InfoCard icon={Lock} title="Password protect" desc="Lock your portal, chat, or collab room with an encrypted password." />
                <InfoCard icon={MessagesSquare} title="Chat rooms" desc="Encrypted group chat with reactions, replies, image sharing, and typing indicators." />
                <InfoCard icon={Share2} title="Collaborative rooms" desc="Multi-party workspaces where every guest can share files. Direct mesh P2P with per-pair fingerprints." />
                <InfoCard icon={Phone} title="Voice & video calls" desc="Live voice up to 20 peers, 1:1 video. DTLS-SRTP encrypted, mobile-friendly controls." />
                <InfoCard icon={Mic} title="Voice notes" desc="Record and send encrypted voice messages up to 3 minutes with seekable playback." />
              </div>
            </div>
          </div>
        )}

        {isActive && !isFinished && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
            <div className="space-y-6 min-w-0">
            <input
              ref={addInputRef}
              type="file"
              multiple
              aria-label="Select files to share"
              onChange={(e: ChangeEvent<HTMLInputElement>) => {
                if (e.target.files) handleFiles(Array.from(e.target.files))
                e.target.value = ''
              }}
              className="hidden"
            />

            <div className="glow-card overflow-hidden animate-fade-in-up">
              <div className="px-4 py-3 space-y-2">
                {chatMode && (
                  <div className="flex items-center gap-2">
                    <MessagesSquare className="w-4 h-4 text-accent" />
                    <span className="font-mono text-sm text-accent font-medium">Chat Room</span>
                  </div>
                )}
                <StatusIndicator status={status} embedded>
                  {recipientCount > 0 && (
                    <>
                      <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={`${recipientCount} connected`}>
                        <Users className="w-3 h-3 text-accent" />
                        <span className="font-mono text-[10px] text-accent">{recipientCount}</span>
                      </div>
                      {rtt !== null && (
                        <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${rtt < 100 ? 'bg-accent/5 border-accent/20' : rtt < 300 ? 'bg-warning-mid/5 border-warning-mid/20' : 'bg-danger/5 border-danger/20'}`} title={`Latency: ${rtt}ms`}>
                          <span className={`font-mono text-[10px] ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-warning-mid' : 'text-danger'}`}>{rtt}ms</span>
                        </div>
                      )}
                      {fingerprint && (
                        <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={`Verify fingerprint: ${fingerprint}`}>
                          <Shield className="w-3 h-3 text-accent" />
                          <span className="font-mono text-[10px] text-accent">E2E</span>
                          <code className="font-mono text-[10px] text-accent/50 hidden sm:inline">{fingerprint}</code>
                        </div>
                      )}
                    </>
                  )}
                </StatusIndicator>
                {status !== 'done' && (
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="w-3 h-3 text-warning/60 shrink-0" />
                    <span className="font-mono text-[10px] text-warning/60">
                      Keep this tab open — closing it ends {chatMode ? 'the chat room' : 'all transfers'}.
                    </span>
                  </div>
                )}
              </div>

              {!chatMode && (
                <div className="border-t border-border">
                  {hasFiles ? (
                    <>
                      <div className="w-full flex items-center justify-between px-4 py-3 group">
                        <button
                          type="button"
                          onClick={() => setFilesOpen(o => !o)}
                          aria-expanded={filesOpen}
                          className="flex items-center gap-2 text-left flex-1 min-w-0"
                        >
                          <Upload className="w-3.5 h-3.5 text-accent shrink-0" />
                          <span className="font-mono text-sm text-text-bright font-bold">{files.length}</span>
                          <span className="text-xs text-muted truncate">
                            file{files.length !== 1 ? 's' : ''} &middot; {formatBytes(files.reduce((s, f) => s + f.size, 0))}
                          </span>
                        </button>
                        <div className="flex items-center gap-1 shrink-0">
                          {!isTransferring && !isFinished && (
                            <button
                              type="button"
                              onClick={() => addInputRef.current?.click()}
                              className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                              title="Add more files"
                              aria-label="Add more files"
                            >
                              <Plus className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setFilesOpen(o => !o)}
                            aria-label={filesOpen ? 'Collapse file list' : 'Expand file list'}
                            className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                          >
                            <ChevronDown className={`w-4 h-4 transition-transform duration-300 ${filesOpen ? 'rotate-180' : ''}`} />
                          </button>
                        </div>
                      </div>
                      <div className={`grid transition-all duration-400 ease-in-out ${filesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                        <div className="overflow-hidden">
                          <div className="px-4 pb-3">
                            <ComponentErrorBoundary name="Files">
                              <FileList
                                files={files}
                                onRemove={isTransferring || isFinished ? null : removeFile}
                                onReorder={isTransferring || isFinished ? null : reorderFiles}
                                progress={showProgress ? progress : null}
                                currentFileIndex={isTransferring ? currentFileIndex : -1}
                              />
                            </ComponentErrorBoundary>
                          </div>
                        </div>
                      </div>
                      {(isTransferring || overallProgress > 0) && (
                        <div className="px-4 pb-3 space-y-2 border-t border-border">
                          <div className="pt-3">
                            <ProgressBar percent={overallProgress} label="Overall progress" />
                          </div>
                          <div className="flex justify-between font-mono text-[10px] text-muted">
                            <span>{formatSpeed(speed)}</span>
                            <span>{!isTransferring
                              ? `${formatBytes(totalSent)} sent in ${formatElapsed(elapsed)}`
                              : `ETA: ${formatTime(eta ?? 0)}`
                            }</span>
                          </div>
                          {isTransferring && (
                            <div className="flex justify-between font-mono text-[10px] text-muted/60">
                              <span>{formatBytes(totalSent)} transferred</span>
                              <span>Elapsed: {formatElapsed(elapsed)}</span>
                            </div>
                          )}
                        </div>
                      )}
                    </>
                  ) : !isTransferring && !isFinished ? (
                    <button
                      onClick={() => addInputRef.current?.click()}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addInputRef.current?.click() } }}
                      aria-label="Add more files"
                      className="w-full flex items-center justify-center gap-3 px-4 py-6 cursor-pointer hover:bg-surface-2/30 transition-colors"
                    >
                      <Upload className="w-5 h-5 text-muted" />
                      <span className="font-mono text-sm text-muted">Add files to share</span>
                    </button>
                  ) : null}
                </div>
              )}

              {peerId && !isFinished && (
                <div className="border-t border-border">
                  <PortalLink peerId={peerId} />
                </div>
              )}

              {!isTransferring && recipientCount === 0 && !chatMode && (
                <InlinePasswordRow
                  password={passwordInput}
                  onChange={(v: string) => { setPasswordInput(v); setPassword(v) }}
                />
              )}
            </div>
            </div>

            {(recipientCount > 0 || chatMode) && !isFinished ? (
              <aside className="space-y-6 lg:sticky lg:top-6">
                <ComponentErrorBoundary name="Call">
                  <CallPanelLazy
                    callOptions={{
                      peer,
                      myPeerId: peerId,
                      myName: senderName,
                      isHost: true,
                      hostPeerId: null,
                      participants,
                      sendToPeer: sendCallMessage,
                      broadcast: broadcastCallMessage,
                      setMessageHandler: setCallMessageHandler,
                    }}
                    myName={senderName}
                    disabled={recipientCount === 0}
                    connectionStatus={status}
                  />
                </ComponentErrorBoundary>
                <ComponentErrorBoundary name="Chat">
                  <ChatPanel messages={messages} onSend={sendMessage} onClearMessages={clearMessages} disabled={recipientCount === 0} onlineCount={recipientCount + 1} nickname={senderName} onNicknameChange={changeSenderName} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
                </ComponentErrorBoundary>
              </aside>
            ) : null}
          </div>
        )}

        {error && (
          <div className="bg-danger/8 border border-danger/20 rounded-xl px-4 py-3 animate-fade-in-up">
            <p className="font-mono text-[11px] text-danger">{error}</p>
          </div>
        )}

        {isFinished && (
          <div className="text-center py-12 animate-fade-in-up">
            <div className="max-w-sm mx-auto space-y-5">
              {status === 'done' && (
                <>
                  <div className="w-16 h-16 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto ring-4 ring-accent/10">
                    <svg className="w-8 h-8 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <p className="font-mono text-lg text-accent text-glow font-medium">Transfer complete</p>
                    <p className="font-mono text-sm text-muted mt-1">
                      {formatBytes(totalSent)} delivered in {formatElapsed(elapsed)}
                    </p>
                  </div>
                </>
              )}
              {status === 'closed' && (
                <div className="space-y-2">
                  <div className="w-16 h-16 rounded-2xl bg-muted/10 flex items-center justify-center mx-auto">
                    <Users className="w-8 h-8 text-muted" />
                  </div>
                  <p className="font-mono text-base text-muted">Recipient disconnected</p>
                </div>
              )}
              {status === 'error' && (
                <div className="space-y-2">
                  <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto">
                    <AlertTriangle className="w-8 h-8 text-danger" />
                  </div>
                  <p className="font-mono text-base text-danger">Connection error occurred</p>
                </div>
              )}
              <button
                onClick={handleNewSession}
                className="inline-flex items-center gap-2 px-6 py-3 rounded-xl font-mono text-sm font-medium
                  bg-accent text-bg hover:bg-accent-dim active:scale-[0.98] transition-all"
              >
                <RotateCcw className="w-4 h-4" />
                Start New Session
              </button>
            </div>
          </div>
        )}
        {showResetConfirm && createPortal(
          <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
            onClick={() => setShowResetConfirm(false)}
            onKeyDown={(e) => { if (e.key === 'Escape') setShowResetConfirm(false) }}
            role="dialog"
            aria-modal="true"
            aria-label="Confirm new session"
            tabIndex={-1}
          >
            <div ref={resetModalRef} className="bg-surface border border-border rounded-2xl p-6 max-w-sm mx-4 space-y-4 animate-fade-in-up" onClick={(e) => e.stopPropagation()}>
              <h3 className="font-mono text-base font-semibold text-text-bright">Start New Session?</h3>
              <p className="text-sm text-muted leading-relaxed">This will end the current session and disconnect all peers.</p>
              <div className="flex gap-3 justify-end">
                <button onClick={() => setShowResetConfirm(false)} className="px-4 py-2 rounded-xl bg-surface-2 border border-border hover:border-accent/30 text-muted-light text-sm font-mono transition-colors">
                  Cancel
                </button>
                <button onClick={performReset} className="px-4 py-2 rounded-xl bg-danger text-white text-sm font-mono hover:bg-danger/80 transition-colors">
                  End Session
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </main>

      <AppFooter />
    </div>
  )
}

interface StepDetail {
  num: string
  icon: LucideIcon
  title: string
  desc: string
  details: string[]
}

function HowItWorks() {
  const [open, setOpen] = useState<boolean>(true)

  const steps: StepDetail[] = [
    {
      num: '1', icon: Upload, title: 'Drop files or start a chat',
      desc: 'Drag files in, browse, or paste. Or start an encrypted chat room — no files needed.',
      details: [
        'Any file type, any number of files, no size limit.',
        'Set an optional password to protect access.',
        'Everything stays in your browser — nothing is uploaded.',
      ]
    },
    {
      num: '2', icon: LinkIcon, title: 'Share the link',
      desc: 'Copy the portal link, share natively on mobile, or let them scan the QR code.',
      details: [
        'Unlimited recipients can connect simultaneously.',
        'The link only works while your tab is open.',
        'Built-in group chat with reactions, replies, and image sharing.',
      ]
    },
    {
      num: '3', icon: Eye, title: 'Recipient chooses',
      desc: 'Recipients see files upfront and download individually or as a streaming zip.',
      details: [
        'Nothing downloads until they decide.',
        'Relay fallback for strict NATs — still encrypted.',
        'Live connection quality and typing indicators.',
      ]
    },
    {
      num: '4', icon: Send, title: 'Direct & encrypted',
      desc: 'Everything streams browser-to-browser with double encryption.',
      details: [
        'ECDH key exchange + AES-256-GCM, plus WebRTC DTLS.',
        'StreamSaver writes to disk — no size limit, no RAM bottleneck.',
        'Auto-resume on disconnect. Self-hosted signaling for full privacy.',
      ]
    },
  ]

  return (
    <div className="animate-fade-in-up" style={{ animationDelay: '200ms' }}>
      <div className="glow-card overflow-hidden">
        <button
          onClick={() => setOpen(o => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between p-5 text-left group"
        >
          <h2 className="font-mono text-xs text-accent uppercase tracking-widest">
            How it works
          </h2>
          <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
        </button>

        <div className={`grid transition-all duration-500 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="px-5 pb-5 space-y-0">
              {steps.map((step, i) => (
                <div key={step.num}>
                  {i > 0 && <div className="ml-[18px] w-px h-4 bg-border" />}
                  <div className="flex gap-4 items-start">
                    <div className="w-9 h-9 rounded-xl glass-accent flex items-center justify-center shrink-0">
                      <step.icon className="w-4 h-4 text-accent" strokeWidth={1.5} />
                    </div>
                    <div className="pt-1 pb-1">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-mono text-xs text-accent">{step.num}</span>
                        <p className="font-mono text-sm text-text font-medium">{step.title}</p>
                      </div>
                      <p className="text-sm text-text leading-relaxed mb-2">{step.desc}</p>
                      <ul className="space-y-1.5">
                        {step.details.map((d, j) => (
                          <li key={j} className="flex gap-2 text-xs text-muted-light leading-relaxed">
                            <span className="text-accent/50 mt-0.5 shrink-0">&bull;</span>
                            {d}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface InlinePasswordRowProps {
  password: string
  onChange: (value: string) => void
}

// Inline password controls matching the collab-host layout: a single row
// inside the session card. Typing stages a value; clicking Lock commits
// it. Once set, the row collapses to a confirmation chip + Unset button.
// Intentionally terse — this isn't a landing-page feature, it's a tweak
// on an already-live session.
function InlinePasswordRow({ password, onChange }: InlinePasswordRowProps) {
  const [staged, setStaged] = useState<string>('')
  const [showPassword, setShowPassword] = useState<boolean>(false)
  const isSet = password.length > 0

  if (isSet) {
    return (
      <div className="border-t border-border px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-accent">
          <Lock className="w-3.5 h-3.5" />
          <span className="font-mono text-xs">Password protected</span>
        </div>
        <button
          onClick={() => { onChange(''); setStaged('') }}
          className="px-2.5 py-1.5 rounded-lg font-mono text-[11px] border border-border text-muted hover:border-danger/40 hover:text-danger transition-colors"
        >
          Unset
        </button>
      </div>
    )
  }

  const commit = (): void => {
    const v = staged.trim()
    if (!v) return
    onChange(v)
    setStaged('')
  }

  return (
    <div className="border-t border-border px-4 py-3 flex items-center gap-2">
      <label htmlFor="portal-password" className="sr-only">Portal password</label>
      <div className="relative flex-1">
        <input
          id="portal-password"
          type={showPassword ? 'text' : 'password'}
          placeholder="Set password (optional)"
          value={staged}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setStaged(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit() } }}
          className="w-full bg-bg border border-border rounded-xl px-4 py-3 pr-10 font-mono text-sm text-text placeholder:text-muted/40 focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10 transition-all"
        />
        <button
          type="button"
          onClick={() => setShowPassword(v => !v)}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-accent transition-colors"
          aria-label={showPassword ? 'Hide password' : 'Show password'}
        >
          {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
        </button>
      </div>
      <button
        onClick={commit}
        disabled={!staged.trim()}
        aria-label="Set password"
        title="Set password"
        className="px-4 py-3 rounded-xl font-mono text-sm border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
      >
        <Lock className="w-4 h-4" />
      </button>
    </div>
  )
}

interface InfoCardProps {
  icon: LucideIcon
  title: string
  desc: string
}

function InfoCard({ icon: Icon, title, desc }: InfoCardProps) {
  return (
    <div className="group relative overflow-hidden glass rounded-xl p-4 space-y-2.5 hover:border-accent/30 transition-all duration-300">
      <div className="absolute -top-16 -right-16 w-32 h-32 rounded-full bg-accent/10 blur-2xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" aria-hidden />
      <div className="relative w-9 h-9 rounded-lg glass-accent flex items-center justify-center">
        <Icon className="w-4 h-4 text-accent" strokeWidth={1.5} />
      </div>
      <p className="relative font-mono text-sm text-text-bright font-medium">{title}</p>
      <p className="relative text-xs text-muted-light leading-relaxed">{desc}</p>
    </div>
  )
}
