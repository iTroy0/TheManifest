import { useState, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Shield, Zap, EyeOff, RotateCcw, Upload, Link as LinkIcon, Send, ChevronDown, Eye, Lock, Users, MessageCircle, MessagesSquare } from 'lucide-react'
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

export default function Home() {
  const [files, setFilesState] = useState([])
  const [error, setError] = useState(null)
  const { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint, recipientCount, setPassword, setChatOnly, messages, sendMessage, rtt, senderName, changeSenderName, typingUsers, sendTyping, sendReaction } = useSender()
  const [passwordInput, setPasswordInput] = useState('')
  const [filesOpen, setFilesOpen] = useState(true)
  const [chatMode, setChatMode] = useState(false)

  const hasFiles = files.length > 0
  const isActive = hasFiles || chatMode
  const isTransferring = status === 'transferring'
  const showProgress = status === 'transferring' || status === 'done'
  const isFinished = status === 'done' || status === 'closed' || status === 'error'

  usePageTitle(isActive ? status : null, overallProgress)
  const elapsed = useElapsedTime(isTransferring)

  useEffect(() => {
    setFiles(files)
  }, [files, setFiles])

  useEffect(() => {
    if (!isActive) return
    const handler = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [isActive])

  const handleFiles = useCallback((newFiles) => {
    setError(null)
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
    reset()
  }, [reset])

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">

      {/* ── Header ── */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sticky top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/" className="group">
            <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
              The Manifest
            </h1>
            <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide">
              Encrypted file sharing & chat
            </p>
          </Link>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        {/* Hero — only on landing */}
        {!isActive && (
          <div className="text-center py-4 animate-fade-in-up">
            <p className="font-mono text-xl font-bold text-text-bright mb-2 tracking-tight">
              Share files & chat. No servers. No trace.
            </p>
            <p className="text-xs text-muted-light max-w-sm mx-auto leading-relaxed">
              Files and messages stream directly browser-to-browser via WebRTC.
              End-to-end encrypted. Close the tab and it's gone.
            </p>
          </div>
        )}

        {/* Drop zone + chat room button — only on landing */}
        {!isActive && (
          <>
            <DropZone onFiles={handleFiles} disabled={isTransferring || isFinished} />
            <div className="text-center">
              <button
                onClick={startChatRoom}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs
                  bg-surface border border-border text-muted-light hover:border-accent/40 hover:text-accent transition-colors"
              >
                <MessagesSquare className="w-3.5 h-3.5" />
                Or start a chat room
              </button>
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
                <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${filesOpen ? 'rotate-180' : ''}`} />
              </button>
              <div className={`grid transition-all duration-400 ease-in-out ${filesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="px-4 pb-3">
                    <FileList
                      files={files}
                      onRemove={isTransferring || isFinished ? null : removeFile}
                      onReorder={isTransferring || isFinished ? null : reorderFiles}
                      progress={showProgress ? progress : null}
                      currentFileIndex={isTransferring ? currentFileIndex : -1}
                    />
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
              <ChatPanel messages={messages} onSend={sendMessage} disabled={recipientCount === 0} onlineCount={recipientCount + 1} nickname={senderName} onNicknameChange={changeSenderName} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
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
          <div className="text-center py-8 animate-fade-in-up space-y-4">
            {status === 'done' && (
              <>
                <div className="w-14 h-14 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto">
                  <svg className="w-7 h-7 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <p className="font-mono text-sm text-accent text-glow">Transfer complete</p>
                <p className="font-mono text-xs text-muted">
                  {formatBytes(totalSent)} delivered in {formatElapsed(elapsed)}
                </p>
              </>
            )}
            {status === 'closed' && (
              <p className="font-mono text-sm text-muted">Recipient disconnected.</p>
            )}
            {status === 'error' && (
              <p className="font-mono text-sm text-danger">Connection error occurred.</p>
            )}
            <button
              onClick={handleNewSession}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
                bg-surface border border-border text-text hover:border-accent/40 hover:text-accent transition-colors"
            >
              <RotateCcw className="w-4 h-4" />
              New Session
            </button>
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
            by <a href="https://github.com/iTroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">iTroy0</a> &middot; <a href="https://buymeacoffee.com/itroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">☕ buy me a coffee</a>
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
        className="w-full flex items-center justify-between p-4 text-left group"
      >
        <div className="flex items-center gap-2">
          <Lock className="w-3.5 h-3.5 text-accent" />
          <span className="font-mono text-xs text-accent uppercase tracking-widest">Password</span>
          <span className="font-mono text-[10px] text-muted">(optional)</span>
          {password && !open && (
            <span className="font-mono text-[10px] text-accent/60">set</span>
          )}
        </div>
        <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className={`grid transition-all duration-400 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <div className="px-4 pb-4">
            <input
              type="password"
              placeholder="Set a password to protect this portal"
              value={password}
              onChange={(e) => onChange(e.target.value)}
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 font-mono text-sm text-text placeholder:text-muted/40 focus:outline-none focus:border-accent/40 transition-colors"
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function InfoCard({ icon: Icon, title, desc }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-2 hover:border-border-hover transition-colors">
      <Icon className="w-4 h-4 text-accent" strokeWidth={1.5} />
      <p className="font-mono text-xs text-text font-medium">{title}</p>
      <p className="text-xs text-muted-light leading-relaxed">{desc}</p>
    </div>
  )
}
