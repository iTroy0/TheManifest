import { useState, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Shield, Zap, EyeOff, RotateCcw, Upload, Link as LinkIcon, Send, ChevronDown, Eye, Lock, Users, QrCode, Gauge, GripVertical, Wifi, MessageCircle, UserPlus } from 'lucide-react'
import { useSender } from '../hooks/useSender'
import { formatSpeed, formatTime, formatBytes } from '../utils/formatBytes'
import { usePageTitle } from '../hooks/usePageTitle'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import DropZone from '../components/DropZone'
import FileList from '../components/FileList'
import PortalLink from '../components/PortalLink'
import ProgressBar from '../components/ProgressBar'
import StatusIndicator from '../components/StatusIndicator'
import ConnectionViz from '../components/ConnectionViz'
import ChatPanel from '../components/ChatPanel'

export default function Home() {
  const [files, setFilesState] = useState([])
  const [error, setError] = useState(null)
  const { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint, recipientCount, setPassword, messages, sendMessage, rtt } = useSender()
  const [passwordInput, setPasswordInput] = useState('')

  const hasFiles = files.length > 0
  const isTransferring = status === 'transferring'
  const showProgress = status === 'transferring' || status === 'done'
  const isFinished = status === 'done' || status === 'closed' || status === 'error'

  usePageTitle(hasFiles ? status : null, overallProgress)
  const elapsed = useElapsedTime(isTransferring)

  useEffect(() => {
    setFiles(files)
  }, [files, setFiles])

  useEffect(() => {
    if (files.length === 0) return
    const handler = (e) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [files.length])

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

  const handleNewSession = useCallback(() => {
    setFilesState([])
    setError(null)
    setPasswordInput('')
    reset()
  }, [reset])

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">

      {/* ── Header ── */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sticky top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between">
          <Link to="/" className="group">
            <div className="flex items-center gap-3">
              <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                The Manifest
              </h1>
              <div className="flex items-center gap-1.5 bg-surface border border-border rounded-full px-2 py-0.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inset-0 rounded-full bg-accent animate-ping opacity-50" />
                  <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-accent" />
                </span>
                <span className="font-mono text-[9px] text-muted-light">P2P</span>
              </div>
            </div>
            <p className="font-mono text-xs text-muted-light mt-0.5 tracking-wide">
              Zero-server file sharing portal
            </p>
          </Link>
        </div>
      </header>

      {/* ── Main ── */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        {/* Hero — only when no files yet */}
        {!hasFiles && (
          <div className="text-center py-4 animate-fade-in-up">
            <p className="font-mono text-xl font-bold text-text-bright mb-2 tracking-tight">
              Share files. No servers. No trace.
            </p>
            <p className="text-xs text-muted-light max-w-sm mx-auto leading-relaxed">
              Files stream directly from your browser to theirs via WebRTC.
              Nothing is uploaded. The link dies when you close the tab.
            </p>
          </div>
        )}

        {/* Drop zone — only before files or before recipients connect */}
        {recipientCount === 0 && (
          <DropZone onFiles={handleFiles} disabled={isTransferring || isFinished} />
        )}

        {/* How it works — only when no files */}
        {!hasFiles && <HowItWorks />}

        {/* Feature cards — only when no files */}
        {!hasFiles && (
          <div className="animate-fade-in-up" style={{ animationDelay: '350ms' }}>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <InfoCard icon={Shield} title="E2E encrypted" desc="ECDH key exchange + AES-256-GCM on every chunk, on top of WebRTC DTLS." />
              <InfoCard icon={EyeOff} title="Zero knowledge" desc="No accounts. No logs. No analytics. We never see your files." />
              <InfoCard icon={Zap} title="Ephemeral" desc="Close the tab and the portal is gone. No traces left behind." />
              <InfoCard icon={Users} title="Multiple recipients" desc="Share with many people at once. Each gets their own encrypted channel." />
              <InfoCard icon={Lock} title="Password protect" desc="Optionally lock your portal. Recipients enter the password to access files." />
              <InfoCard icon={MessageCircle} title="Live chat" desc="Built-in encrypted chat with auto-generated nicknames for group conversations." />
            </div>
          </div>
        )}

        {/* ── Active session UI (only when files loaded) ── */}
        {hasFiles && (
          <>
            {/* Warning banner */}
            {status !== 'done' && (
              <div className="flex items-center gap-3 bg-warning/8 border border-warning/20 rounded-xl px-4 py-3 animate-fade-in-up">
                <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
                <span className="font-mono text-[11px] text-warning">
                  Keep this tab open. Closing it destroys the portal and cancels all transfers.
                </span>
              </div>
            )}

            {/* Status */}
            <StatusIndicator status={status} />

            {/* File list */}
            <FileList
              files={files}
              onRemove={isTransferring || isFinished ? null : removeFile}
              onReorder={isTransferring || isFinished ? null : reorderFiles}
              progress={showProgress ? progress : null}
              currentFileIndex={isTransferring ? currentFileIndex : -1}
            />

            {/* Password (collapsible) */}
            {!isTransferring && !isFinished && (
              <PasswordSection password={passwordInput} onChange={(v) => { setPasswordInput(v); setPassword(v) }} />
            )}

            {/* Portal link */}
            {peerId && !isFinished && (
              <PortalLink peerId={peerId} />
            )}

            {/* Connection info bar */}
            {(recipientCount > 0 || fingerprint) && (
              <div className="flex items-center gap-3 flex-wrap animate-fade-in-up">
                {recipientCount > 0 && (
                  <div className="flex items-center gap-2 bg-accent/5 border border-accent/20 rounded-xl px-4 py-2">
                    <Users className="w-3.5 h-3.5 text-accent" />
                    <span className="font-mono text-xs text-accent">{recipientCount} recipient{recipientCount !== 1 ? 's' : ''}</span>
                  </div>
                )}
                {rtt !== null && (
                  <div className={`flex items-center gap-1.5 rounded-xl px-3 py-2 border ${rtt < 100 ? 'bg-accent/5 border-accent/20' : rtt < 300 ? 'bg-yellow-400/5 border-yellow-400/20' : 'bg-danger/5 border-danger/20'}`}>
                    <Wifi className={`w-3 h-3 ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-yellow-400' : 'text-danger'}`} />
                    <span className={`font-mono text-[11px] ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-yellow-400' : 'text-danger'}`}>{rtt}ms</span>
                  </div>
                )}
                {fingerprint && (
                  <div className="flex items-center gap-1.5 bg-surface border border-accent/20 rounded-xl px-3 py-2">
                    <Shield className="w-3 h-3 text-accent shrink-0" />
                    <code className="font-mono text-[10px] text-accent">{fingerprint}</code>
                  </div>
                )}
              </div>
            )}

            {/* Connection visualization */}
            <ConnectionViz status={status} />

            {/* Transfer progress */}
            {showProgress && (
              <div className="glow-card p-5 space-y-4 animate-fade-in-up">
                <ProgressBar percent={overallProgress} label="Overall progress" />
                <div className="flex justify-between font-mono text-xs text-muted">
                  <span>{formatSpeed(speed)}</span>
                  <span>{status === 'done'
                    ? `${formatBytes(totalSent)} sent in ${formatElapsed(elapsed)}`
                    : `ETA: ${formatTime(eta)}`
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

            {/* Chat */}
            {recipientCount > 0 && !isFinished && (
              <ChatPanel messages={messages} onSend={sendMessage} disabled={recipientCount === 0} />
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
      num: '01', icon: Upload, title: 'Drop your files',
      desc: 'Drag files in, click to browse, or paste with Ctrl+V. Drag to reorder before sharing.',
      details: [
        'Any file type, any number of files, no size limit.',
        'Set an optional password to protect your portal.',
        'Files stay in your browser — nothing is uploaded anywhere.',
      ]
    },
    {
      num: '02', icon: LinkIcon, title: 'Share the link',
      desc: 'Copy the portal link, share via the native share menu, or let them scan the QR code.',
      details: [
        'Multiple recipients can connect simultaneously.',
        'The link only works while your tab is open.',
        'Use the built-in chat to coordinate with recipients.',
      ]
    },
    {
      num: '03', icon: Eye, title: 'Recipient reviews',
      desc: 'Recipients see the full file list and choose what to download — individually or as a zip.',
      details: [
        'Nothing downloads until they decide.',
        'If direct P2P fails, they can opt-in to an encrypted relay.',
        'Connection quality is shown in real time.',
      ]
    },
    {
      num: '04', icon: Send, title: 'Direct transfer',
      desc: 'Files stream browser-to-browser with double encryption and real-time progress.',
      details: [
        'ECDH key exchange + AES-256-GCM on every chunk, plus WebRTC DTLS.',
        'StreamSaver writes directly to disk — no file size limit, no RAM bottleneck.',
        'Auto-resume if the connection drops mid-transfer.',
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
