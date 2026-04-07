import { useParams, Link } from 'react-router-dom'
import { useReceiver } from '../hooks/useReceiver'
import { formatBytes, formatSpeed, formatTime } from '../utils/formatBytes'
import { usePageTitle } from '../hooks/usePageTitle'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import FileList from '../components/FileList'
import ProgressBar from '../components/ProgressBar'
import StatusIndicator from '../components/StatusIndicator'
import ConnectionViz from '../components/ConnectionViz'
import { ArrowLeft, AlertCircle, Download, Shield, Info, Radio, Plus, Wifi, Archive } from 'lucide-react'

export default function Portal() {
  const { peerId } = useParams()
  const {
    manifest, status, progress, overallProgress, speed, eta,
    pendingFiles, completedFiles, requestFile, requestAllAsZip,
    retryCount, useRelay, enableRelay, zipMode, fingerprint,
  } = useReceiver(peerId)
  usePageTitle(status, overallProgress)

  const hasPending = Object.keys(pendingFiles).length > 0
  const completedCount = Object.keys(completedFiles).length
  const isDead = status === 'closed' || status === 'error' || status === 'rejected'
  const isConnecting = status === 'connecting' || status === 'retrying' || status === 'reconnecting'
  const showManifest = status === 'manifest-received' || (manifest && !isDead)
  const allDone = manifest && completedCount === manifest.files.length
  const elapsed = useElapsedTime(hasPending)

  const currentFileIndex = manifest ? manifest.files.findIndex(f => {
    const pct = progress?.[f.name]
    return pct != null && pct > 0 && pct < 100
  }) : -1

  const totalReceived = manifest ? manifest.files.reduce((sum, f) => {
    const pct = progress?.[f.name] || 0
    return sum + Math.round((f.size * pct) / 100)
  }, 0) : 0

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">

      {/* Header */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sticky top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-accent transition-colors mb-3 w-fit group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-mono text-[11px]">Send your own files</span>
          </Link>
          <div className="flex items-center justify-between">
            <Link to="/" className="group">
              <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                The Manifest
              </h1>
              <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide flex items-center gap-1.5">
                <Download className="w-3 h-3" /> Incoming file portal
              </p>
            </Link>
            <div className="flex items-center gap-2">
              {showManifest && (
                <div className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 border ${useRelay ? 'bg-warning/5 border-warning/20' : 'bg-accent/5 border-accent/20'}`}>
                  <Wifi className={`w-3 h-3 ${useRelay ? 'text-warning' : 'text-accent'}`} />
                  <span className={`font-mono text-[9px] ${useRelay ? 'text-warning' : 'text-accent'}`}>{useRelay ? 'Relay' : 'Direct P2P'}</span>
                </div>
              )}
              <div className="flex items-center gap-1.5 bg-surface border border-border rounded-full px-3 py-1.5" title={fingerprint ? `Key: ${fingerprint}` : ''}>
                <Shield className="w-3 h-3 text-accent" />
                <span className="font-mono text-[10px] text-muted-light">E2E Encrypted</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        <StatusIndicator status={status} />
        <ConnectionViz status={hasPending ? 'transferring' : allDone ? 'done' : status} useRelay={useRelay} />

        {/* Dead states */}
        {status === 'closed' && !manifest && (
          <ErrorBlock title="This portal no longer exists." desc="The sender has closed their tab or the connection timed out. Ask them to open a new portal." />
        )}
        {status === 'closed' && manifest && (
          <ErrorBlock title="Portal closed." desc="The sender disconnected. Files already downloaded are saved." />
        )}
        {status === 'rejected' && (
          <ErrorBlock title="Portal is already in use." desc="Another recipient is currently connected. Ask the sender to open a new portal for you." />
        )}
        {status === 'error' && (
          <ErrorBlock title="Connection error." desc="Could not establish a connection. Check your internet and try refreshing the page." />
        )}

        {/* Connecting */}
        {isConnecting && (
          <div className="text-center py-14 animate-fade-in-up">
            <div className="w-16 h-16 rounded-2xl border-2 border-accent/30 flex items-center justify-center mx-auto mb-5">
              <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin-slow" />
            </div>
            <p className="font-mono text-sm text-text mb-2">
              {status === 'reconnecting' ? 'Reconnecting...' : status === 'retrying' ? `Retrying... (attempt ${retryCount + 1}/2)` : 'Connecting to portal...'}
            </p>
            <p className="text-xs text-muted max-w-xs mx-auto leading-relaxed">
              {status === 'reconnecting' ? 'Connection dropped. Resuming where it left off.' : 'Establishing a secure peer-to-peer connection.'}
            </p>
          </div>
        )}

        {/* Direct failed — relay option */}
        {status === 'direct-failed' && (
          <div className="text-center py-10 animate-fade-in-up space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-warning/10 flex items-center justify-center mx-auto">
              <Radio className="w-8 h-8 text-warning" strokeWidth={1.5} />
            </div>
            <div>
              <p className="font-mono text-sm text-text mb-2">Direct connection failed</p>
              <p className="text-xs text-muted max-w-sm mx-auto leading-relaxed">Your network doesn't allow a direct connection. You can try using an encrypted relay.</p>
            </div>
            <div className="glow-card p-5 text-left max-w-sm mx-auto space-y-3">
              <p className="font-mono text-xs text-accent uppercase tracking-widest">What does this mean?</p>
              <ul className="space-y-2 text-xs text-muted leading-relaxed">
                <li className="flex gap-2"><span className="text-accent mt-0.5 shrink-0">&bull;</span>Files pass through a relay instead of directly browser-to-browser.</li>
                <li className="flex gap-2"><span className="text-accent mt-0.5 shrink-0">&bull;</span>All data is still encrypted. The relay cannot read your files.</li>
                <li className="flex gap-2"><span className="text-accent mt-0.5 shrink-0">&bull;</span>Speed may be slightly slower than a direct connection.</li>
              </ul>
            </div>
            <button onClick={enableRelay} className="inline-flex items-center gap-2.5 px-6 py-3 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim transition-colors">
              <Radio className="w-4 h-4" /> Connect via Relay
            </button>
          </div>
        )}

        {/* Connected waiting for manifest */}
        {status === 'connected' && !manifest && (
          <div className="text-center py-10 animate-fade-in-up">
            <p className="font-mono text-sm text-text mb-2">Connected. Waiting for file list...</p>
          </div>
        )}

        {/* Manifest + file list */}
        {showManifest && manifest && (
          <div className="space-y-4 animate-fade-in-up">
            <div className="glow-card p-5">
              <div className="flex items-center gap-2 mb-3">
                <Download className="w-3.5 h-3.5 text-accent" />
                <span className="font-mono text-xs text-accent uppercase tracking-widest">Incoming Files</span>
              </div>
              <div className="flex items-baseline gap-3">
                <p className="font-mono text-lg text-text-bright font-bold">{manifest.files.length}</p>
                <p className="text-xs text-muted">
                  file{manifest.files.length !== 1 ? 's' : ''} &middot; {formatBytes(manifest.totalSize)} total
                  {completedCount > 0 && ` &middot; ${completedCount} saved`}
                </p>
              </div>
              {fingerprint && (
                <div className="flex items-center gap-2 mt-3 pt-3 border-t border-border">
                  <Shield className="w-3 h-3 text-accent shrink-0" />
                  <span className="font-mono text-[10px] text-muted">Key fingerprint:</span>
                  <code className="font-mono text-[10px] text-accent">{fingerprint}</code>
                </div>
              )}
            </div>

            {/* Bulk actions */}
            {!allDone && !isDead && manifest.files.length > 1 && (
              <div className="flex items-center gap-3 flex-wrap">
                <button
                  onClick={requestAllAsZip}
                  disabled={hasPending}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs
                    bg-accent text-bg font-medium hover:bg-accent-dim transition-colors
                    disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Archive className="w-3.5 h-3.5" />
                  Download All as Zip
                </button>
                <p className="font-mono text-[10px] text-muted">
                  or download individual files below
                </p>
              </div>
            )}

            {/* Single file — just show download button, no bulk */}
            {!allDone && !isDead && manifest.files.length === 1 && !completedFiles[0] && !pendingFiles[0] && (
              <div className="flex items-center gap-3">
                <button
                  onClick={() => requestFile(0)}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs bg-accent text-bg font-medium hover:bg-accent-dim transition-colors"
                >
                  <Download className="w-3.5 h-3.5" />
                  Download File
                </button>
              </div>
            )}

            {/* Transfer info */}
            {hasPending && (
              <div className="flex items-start gap-3 bg-info/5 border border-info/15 rounded-xl px-4 py-3">
                <Info className="w-4 h-4 text-info shrink-0 mt-0.5" />
                <p className="font-mono text-[10px] text-info/80 leading-relaxed">
                  {zipMode
                    ? 'Downloading all files. A zip will be saved when complete.'
                    : 'File is downloading directly to your device. Keep this tab open.'}
                </p>
              </div>
            )}

            <FileList
              files={manifest.files}
              progress={progress}
              pendingFiles={pendingFiles}
              onRequest={isDead || hasPending ? null : requestFile}
              currentFileIndex={currentFileIndex}
            />
          </div>
        )}

        {/* Progress bar */}
        {(hasPending || completedCount > 0) && manifest && (
          <div className="glow-card p-5 space-y-4 animate-fade-in-up">
            <ProgressBar percent={overallProgress} label="Overall progress" />
            <div className="flex justify-between font-mono text-xs text-muted">
              <span>{formatSpeed(speed)}</span>
              <span>{allDone ? `${formatBytes(totalReceived)} in ${formatElapsed(elapsed)}` : `ETA: ${formatTime(eta)}`}</span>
            </div>
            {hasPending && (
              <div className="flex justify-between font-mono text-[10px] text-muted/60">
                <span>{formatBytes(totalReceived)} received</span>
                <span>Elapsed: {formatElapsed(elapsed)}</span>
              </div>
            )}
          </div>
        )}

        {/* All done */}
        {allDone && (
          <div className="text-center py-8 animate-fade-in-up space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-accent/15 flex items-center justify-center mx-auto">
              <svg className="w-7 h-7 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-mono text-sm text-accent text-glow">All files downloaded</p>
            <p className="font-mono text-xs text-muted">Files have been saved to your device.</p>
            <Link to="/" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-text hover:border-accent/40 hover:text-accent transition-colors">
              <Plus className="w-4 h-4" /> Send Your Own Files
            </Link>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between flex-wrap gap-2">
          <p className="font-mono text-xs text-muted">No servers. No storage. No tracking.</p>
          <p className="font-mono text-xs text-muted">
            by <a href="https://github.com/iTroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">iTroy0</a> &middot; <a href="https://buymeacoffee.com/itroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">☕ buy me a coffee</a>
          </p>
        </div>
      </footer>
    </div>
  )
}

function ErrorBlock({ title, desc }) {
  return (
    <div className="text-center py-14 animate-fade-in-up">
      <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-5">
        <AlertCircle className="w-8 h-8 text-danger" strokeWidth={1.5} />
      </div>
      <p className="font-mono text-sm text-text mb-2">{title}</p>
      <p className="text-xs text-muted max-w-xs mx-auto leading-relaxed">{desc}</p>
    </div>
  )
}
