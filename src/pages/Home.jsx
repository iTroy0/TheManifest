import { useState, useCallback, useEffect, useRef } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Shield, Zap, EyeOff, RotateCcw, Upload, Link as LinkIcon, Send, ChevronDown, Eye, Lock, Users, MessageCircle, MessagesSquare, Plus } from 'lucide-react'
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
import { ComponentErrorBoundary } from '../components/ErrorBoundary'

export default function Home() {
  const [files, setFilesState] = useState([])
  const [error, setError] = useState(null)
  const { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint, recipientCount, setPassword, setChatOnly, broadcastManifest, messages, sendMessage, clearMessages, rtt, senderName, changeSenderName, typingUsers, sendTyping, sendReaction } = useSender()
  const addInputRef = useRef(null)
  const [passwordInput, setPasswordInput] = useState('')
  const [filesOpen, setFilesOpen] = useState(true)
  const [chatMode, setChatMode] = useState(false)
  // Tracks whether the user intentionally started a session (added files
  // or started chat). Stays true even if all files are removed so the
  // portal link / chat / connection status remain visible. Only resets
  // on "New Session".
  const [sessionStarted, setSessionStarted] = useState(false)

  const hasFiles = files.length > 0
  const isActive = hasFiles || chatMode || sessionStarted
  const isTransferring = status === 'transferring'
  const showProgress = status === 'transferring' || status === 'done'
  const isFinished = status === 'done' || status === 'closed' || status === 'error'

  usePageTitle(isActive ? status : null, overallProgress)
  const elapsed = useElapsedTime(isTransferring)

  const prevFilesLen = useRef(files.length)
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
    const handler = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isActive])

  const handleFiles = useCallback((newFiles) => {
    setError(null)
    if (newFiles.length > 0) setSessionStarted(true)
    setFilesState(prev => [...prev, ...newFiles])
  }, [])

  const removeFile = useCallback((index) => {
    setFilesState(prev => prev.filter((_, i) => i !== index))
  }, [])

  const reorderFiles = useCallback((fromIndex, toIndex) => {
    setFilesState(prev => {
      const next = [...prev]
      const [moved] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, moved)
      return next
    })
  }, [])

  const startChatRoom = useCallback(() => {
    setChatMode(true)
    setChatOnly(true)
  }, [setChatOnly])

  const handleNewSession = useCallback(() => {
    setFilesState([])
    setError(null)
    setPasswordInput('')
    setChatMode(false)
    setSessionStarted(false)
    reset()
  }, [reset])

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">

      {/* ── Header ── */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sm:sticky sm:top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/" className="group" onClick={isActive ? (e) => { e.preventDefault(); handleNewSession() } : undefined}>
            <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
              The Manifest
            </h1>
            <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide">
              Encrypted file sharing & chat
            </p>
          </Link>
          <div className="flex items-center gap-2">
            {isActive && !isFinished && (
              <button
                onClick={handleNewSession}
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

      {/* ── Main ── */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        {/* Hero — only on landing */}
        {!isActive && (
          <div className="text-center py-6 animate-fade-in-up">
            <h2 className="font-mono text-2xl sm:text-3xl font-bold text-text-bright mb-3 tracking-tight text-balance">
              Share files & chat. No servers. No trace.
            </h2>
            <p className="text-sm text-muted-light max-w-md mx-auto leading-relaxed text-pretty">
              Files and messages stream directly browser-to-browser via WebRTC.
              End-to-end encrypted. Close the tab and it&apos;s gone.
            </p>
          </div>
        )}

        {/* Drop zone + chat room button — only on landing */}
        {!isActive && (
          <>
            <DropZone onFiles={handleFiles} disabled={isTransferring || isFinished} />
            <div className="flex items-center justify-center gap-4">
              <div className="h-px flex-1 bg-border/50" />
              <button
                onClick={startChatRoom}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
                  bg-surface-2/50 border border-border text-muted hover:border-accent/40 hover:text-accent hover:bg-surface-2 active:scale-[0.98] transition-all"
              >
                <MessagesSquare className="w-4 h-4" />
                Start a chat room
              </button>
              <div className="h-px flex-1 bg-border/50" />
            </div>
          </>
        )}

        {/* How it works — only on landing */}
        {!isActive && <HowItWorks />}

        {/* Feature cards — only on landing */}
        {!isActive && (
          <div className="animate-fade-in-up" style={{ animationDelay: '350ms' }}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <InfoCard icon={Shield} title="E2E encrypted" desc="Double encryption — AES-256-GCM + WebRTC DTLS. Even relays can't see your data." />
              <InfoCard icon={EyeOff} title="Zero knowledge" desc="No accounts. No logs. No analytics. Self-hosted signaling for full privacy." />
              <InfoCard icon={Zap} title="Ephemeral" desc="Close the tab and it's gone. No traces left behind." />
              <InfoCard icon={Users} title="Multi-recipient" desc="Unlimited simultaneous connections. Each gets their own encrypted channel." />
              <InfoCard icon={Lock} title="Password protect" desc="Lock your portal or chat room with an encrypted password." />
              <InfoCard icon={MessagesSquare} title="Chat rooms" desc="Encrypted group chat with reactions, replies, image sharing, and typing indicators." />
            </div>
          </div>
        )}

        {/* ── Active session UI ── */}
        {isActive && (
          <>
            {/* Warning banner — compact */}
            {status !== 'done' && (
              <div className="flex items-center gap-2 bg-warning/5 border border-warning/15 rounded-lg px-3 py-2 animate-fade-in-up">
                <AlertTriangle className="w-3.5 h-3.5 text-warning/70 shrink-0" />
                <span className="font-mono text-[10px] text-warning/70">
                  Keep this tab open — closing it ends {chatMode ? 'the chat room' : 'all transfers'}.
                </span>
              </div>
            )}

            {/* Chat room label */}
            {chatMode && (
              <div className="flex items-center gap-2 bg-accent/5 border border-accent/20 rounded-xl px-4 py-3 animate-fade-in-up">
                <MessagesSquare className="w-4 h-4 text-accent" />
                <span className="font-mono text-sm text-accent font-medium">Chat Room</span>
                <span className="font-mono text-xs text-muted">— share the link to invite people</span>
              </div>
            )}

            {/* Status + badges */}
            <StatusIndicator status={status}>
              {recipientCount > 0 && (
                <>
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={`${recipientCount} connected`}>
                    <Users className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">{recipientCount}</span>
                  </div>
                  {rtt !== null && (
                    <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${rtt < 100 ? 'bg-accent/5 border-accent/20' : rtt < 300 ? 'bg-yellow-400/5 border-yellow-400/20' : 'bg-danger/5 border-danger/20'}`} title={`Latency: ${rtt}ms`}>
                      <span className={`font-mono text-[10px] ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-yellow-400' : 'text-danger'}`}>{rtt}ms</span>
                    </div>
                  )}
                  {fingerprint && (
                    <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={`Verify fingerprint: ${fingerprint}`}>
                      <Shield className="w-3 h-3 text-accent" />
                      <span className="font-mono text-[10px] text-accent">E2E</span>
                      <code className="font-mono text-[9px] text-accent/50 hidden sm:inline">{fingerprint}</code>
                    </div>
                  )}
                </>
              )}
            </StatusIndicator>

            {/* Hidden file input for adding more files */}
            <input ref={addInputRef} type="file" multiple onChange={(e) => { handleFiles(Array.from(e.target.files)); e.target.value = '' }} className="hidden" />

            {/* Add files prompt — when session is active but no files */}
            {!hasFiles && !chatMode && !isTransferring && !isFinished && (
              <div
                onClick={() => addInputRef.current?.click()}
                className="glow-card flex items-center justify-center gap-3 px-4 py-6 cursor-pointer hover:border-accent/30 transition-colors"
              >
                <Upload className="w-5 h-5 text-muted" />
                <span className="font-mono text-sm text-muted">Add files to share</span>
              </div>
            )}

            {/* File list (collapsible) — only when files exist */}
            {hasFiles && <div className="glow-card overflow-hidden">
              <button
                onClick={() => setFilesOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3 text-left group"
              >
                <div className="flex items-center gap-2">
                  <Upload className="w-3.5 h-3.5 text-accent" />
                  <span className="font-mono text-sm text-text-bright font-bold">{files.length}</span>
                  <span className="text-xs text-muted">
                    file{files.length !== 1 ? 's' : ''} &middot; {formatBytes(files.reduce((s, f) => s + f.size, 0))}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {!isTransferring && !isFinished && (
                    <div
                      onClick={(e) => { e.stopPropagation(); addInputRef.current?.click() }}
                      className="p-1.5 rounded-lg text-muted hover:text-accent hover:bg-accent/10 transition-colors"
                      title="Add more files"
                    >
                      <Plus className="w-4 h-4" />
                    </div>
                  )}
                  <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${filesOpen ? 'rotate-180' : ''}`} />
                </div>
              </button>
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
              {/* Progress bar — attached to file list */}
              {(isTransferring || overallProgress > 0) && (
                <div className="px-4 pb-3 space-y-2 border-t border-border">
                  <div className="pt-3">
                    <ProgressBar percent={overallProgress} label="Overall progress" />
                  </div>
                  <div className="flex justify-between font-mono text-[10px] text-muted">
                    <span>{formatSpeed(speed)}</span>
                    <span>{!isTransferring
                      ? `${formatBytes(totalSent)} sent in ${formatElapsed(elapsed)}`
                      : `ETA: ${formatTime(eta)}`
                    }</span>
                  </div>
                  {isTransferring && (
                    <div className="flex justify-between font-mono text-[9px] text-muted/60">
                      <span>{formatBytes(totalSent)} transferred</span>
                      <span>Elapsed: {formatElapsed(elapsed)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>}

            {/* Password (collapsible) — hide once recipients connect */}
            {!isTransferring && !isFinished && recipientCount === 0 && (
              <PasswordSection password={passwordInput} onChange={(v) => { setPasswordInput(v); setPassword(v) }} />
            )}

            {/* Portal link */}
            {peerId && !isFinished && (
              <PortalLink peerId={peerId} />
            )}

{/* Chat */}
  {(recipientCount > 0 || chatMode) && !isFinished && (
    <ComponentErrorBoundary name="Chat">
      <ChatPanel messages={messages} onSend={sendMessage} onClearMessages={clearMessages} disabled={recipientCount === 0} onlineCount={recipientCount + 1} nickname={senderName} onNicknameChange={changeSenderName} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
    </ComponentErrorBoundary>
  )}
          </>
        )}

        {/* Error */}
        {error && (
          <div className="bg-danger/8 border border-danger/20 rounded-xl px-4 py-3 animate-fade-in-up">
            <p className="font-mono text-[11px] text-danger">{error}</p>
          </div>
        )}

        {/* Done / closed / error — show new session button */}
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
      </main>

      {/* ── Footer ── */}
      <footer className="border-t border-border/40 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between flex-wrap gap-2">
          <p className="font-mono text-xs text-muted">
            No servers. No storage. No tracking.
          </p>
          <p className="font-mono text-xs text-muted">
            <Link to="/faq" className="text-muted-light hover:text-accent transition-colors">FAQ</Link> &middot; <Link to="/privacy" className="text-muted-light hover:text-accent transition-colors">Privacy</Link> &middot; by <a href="https://github.com/iTroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">iTroy0</a> &middot; <a href="https://buymeacoffee.com/itroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">☕ buy me a coffee</a>
          </p>
        </div>
      </footer>
    </div>
  )
}

function HowItWorks() {
  const [open, setOpen] = useState(false)

  const steps = [
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
                    <div className="w-9 h-9 rounded-xl bg-accent/10 flex items-center justify-center shrink-0">
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

function PasswordSection({ password, onChange }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="glow-card overflow-hidden animate-fade-in-up">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center justify-between p-4 text-left group hover:bg-surface-2/30 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
            <Lock className="w-4 h-4 text-accent" />
          </div>
          <div>
            <span className="font-mono text-sm text-text font-medium">Password protect</span>
            <p className="font-mono text-[10px] text-muted">
              {password ? 'Password set' : 'Optional security'}
            </p>
          </div>
        </div>
        <ChevronDown className={`w-5 h-5 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className={`grid transition-all duration-400 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-4 pb-4">
            <input
              type="password"
              placeholder="Enter a password..."
              value={password}
              onChange={(e) => onChange(e.target.value)}
              className="w-full bg-bg border border-border rounded-xl px-4 py-3 font-mono text-sm text-text placeholder:text-muted/40 focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10 transition-all"
            />
            <p className="font-mono text-[10px] text-muted mt-2 px-1">Recipients will need this password to access the portal</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoCard({ icon: Icon, title, desc }) {
  return (
    <div className="group bg-surface border border-border rounded-xl p-4 space-y-2.5 hover:border-accent/30 hover:bg-surface-2/30 transition-all duration-300">
      <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center group-hover:bg-accent/15 transition-colors">
        <Icon className="w-4 h-4 text-accent" strokeWidth={1.5} />
      </div>
      <p className="font-mono text-sm text-text font-medium">{title}</p>
      <p className="text-xs text-muted-light leading-relaxed">{desc}</p>
    </div>
  )
}
