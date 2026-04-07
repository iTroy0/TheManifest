import { useState, useCallback, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { AlertTriangle, Shield, Zap, EyeOff, RotateCcw, Upload, Link as LinkIcon, Send, ChevronDown, Eye, Lock, Users, QrCode, Gauge } from 'lucide-react'
import { useSender } from '../hooks/useSender'
import { formatSpeed, formatTime, formatBytes } from '../utils/formatBytes'
import { usePageTitle } from '../hooks/usePageTitle'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import DropZone from '../components/DropZone'
import FileList from '../components/FileList'
import PortalLink from '../components/PortalLink'
import ProgressBar from '../components/ProgressBar'
import StatusIndicator from '../components/StatusIndicator'
import PortalRing from '../components/PortalRing'
import ConnectionViz from '../components/ConnectionViz'

export default function Home() {
  const [files, setFilesState] = useState([])
  const [error, setError] = useState(null)
  const { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint } = useSender()

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

  const handleNewSession = useCallback(() => {
    setFilesState([])
    setError(null)
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
              Zero-server file portal
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

        {/* Warning banner */}
        {hasFiles && status !== 'done' && (
          <div className="flex items-center gap-3 bg-warning/8 border border-warning/20 rounded-xl px-4 py-3 animate-fade-in-up">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0" />
            <span className="font-mono text-[11px] text-warning">
              Keep this tab open. Closing it destroys the portal and cancels all transfers.
            </span>
          </div>
        )}


        {/* Status */}
        {hasFiles && <StatusIndicator status={status} />}

        {/* E2E fingerprint */}
        {fingerprint && (
          <div className="flex items-center gap-2 bg-surface border border-accent/20 rounded-xl px-4 py-2 animate-fade-in-up">
            <Shield className="w-3 h-3 text-accent shrink-0" />
            <span className="font-mono text-[10px] text-muted">E2E key:</span>
            <code className="font-mono text-[10px] text-accent">{fingerprint}</code>
          </div>
        )}

        {/* Portal ring animation */}
        {hasFiles && (status === 'waiting' || status === 'connected' || status === 'transferring' || status === 'done') && (
          <PortalRing status={status} />
        )}

        {/* Connection visualization */}
        <ConnectionViz status={status} />

        {/* Error */}
        {error && (
          <div className="bg-danger/8 border border-danger/20 rounded-xl px-4 py-3 animate-fade-in-up">
            <p className="font-mono text-[11px] text-danger">{error}</p>
          </div>
        )}

        {/* Drop zone */}
        <DropZone onFiles={handleFiles} disabled={isTransferring || isFinished} />

        {/* How it works — only when no files */}
        {!hasFiles && <HowItWorks />}

        {/* Privacy notice — only when no files */}
        {!hasFiles && (
          <div className="animate-fade-in-up" style={{ animationDelay: '350ms' }}>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <InfoCard icon={Shield} title="End-to-end encrypted" desc="WebRTC DTLS encryption is mandatory by spec. Your data is protected in transit." />
              <InfoCard icon={EyeOff} title="Zero knowledge" desc="No accounts. No logs. No analytics. We never see your files." />
              <InfoCard icon={Zap} title="Ephemeral by design" desc="Close the tab and the portal is gone. No traces left behind." />
            </div>
          </div>
        )}

        {/* File list */}
        {hasFiles && (
          <FileList
            files={files}
            onRemove={isTransferring || isFinished ? null : removeFile}
            progress={showProgress ? progress : null}
            currentFileIndex={isTransferring ? currentFileIndex : -1}
          />
        )}

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

        {/* Portal link */}
        {peerId && hasFiles && !isFinished && (
          <PortalLink peerId={peerId} />
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
      desc: 'Drag files into the portal zone above, click to browse your device, or paste from clipboard with Ctrl+V.',
      details: [
        'Supports any file type — documents, images, videos, archives, code, and more.',
        'Add multiple files at once. Drag to reorder them before sharing.',
        'Files are held in your browser memory — nothing is uploaded anywhere.',
        'No file size limit. No limit on number of files.',
      ]
    },
    {
      num: '02', icon: LinkIcon, title: 'Share the link',
      desc: 'A unique portal link and QR code are generated the moment you add files.',
      details: [
        'Copy the link and send it via any messaging app, email, or chat.',
        'Or let the recipient scan the QR code with their phone camera.',
        'The link is tied to your browser session — it only works while your tab is open.',
        'Only one recipient can connect at a time for security.',
      ]
    },
    {
      num: '03', icon: Eye, title: 'Recipient reviews',
      desc: 'Your recipient opens the link and sees the full file list before anything transfers.',
      details: [
        'They see file names, sizes, and total transfer size upfront.',
        'Nothing downloads until they click "Accept & Start Download".',
        'If the direct connection fails, they can opt-in to an encrypted relay.',
      ]
    },
    {
      num: '04', icon: Send, title: 'Direct transfer',
      desc: 'Files stream directly browser-to-browser via WebRTC with real-time progress.',
      details: [
        'Data is encrypted with DTLS — mandatory by the WebRTC specification.',
        'Transfer speed, ETA, and per-file progress are shown on both sides.',
        'Backpressure control prevents memory overflow on large transfers.',
        'Files are saved manually by the recipient — no auto-downloads.',
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

function InfoCard({ icon: Icon, title, desc }) {
  return (
    <div className="bg-surface border border-border rounded-xl p-4 space-y-2 hover:border-border-hover transition-colors">
      <Icon className="w-4 h-4 text-accent" strokeWidth={1.5} />
      <p className="font-mono text-xs text-text font-medium">{title}</p>
      <p className="text-xs text-muted-light leading-relaxed">{desc}</p>
    </div>
  )
}
