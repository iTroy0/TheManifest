import { useParams, Link } from 'react-router-dom'
import { useReceiver } from '../hooks/useReceiver'
import { formatBytes, formatSpeed, formatTime } from '../utils/formatBytes'
import { usePageTitle } from '../hooks/usePageTitle'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import FileList from '../components/FileList'
import ProgressBar from '../components/ProgressBar'
import StatusIndicator from '../components/StatusIndicator'
import ChatPanel from '../components/ChatPanel'
import { useState } from 'react'
import { ArrowLeft, AlertCircle, Download, Shield, Info, Radio, Wifi, Archive, Lock, ChevronDown, MessagesSquare } from 'lucide-react'

export default function Portal() {
  const { peerId } = useParams()
  const {
    manifest, status, progress, overallProgress, speed, eta,
    pendingFiles, completedFiles, requestFile, requestAllAsZip,
    retryCount, useRelay, enableRelay, zipMode, fingerprint,
    passwordRequired, passwordError, submitPassword,
    messages, sendMessage, rtt, nickname, changeNickname, onlineCount,
    typingUsers, sendTyping, sendReaction,
  } = useReceiver(peerId)
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [filesOpen, setFilesOpen] = useState(true)
  usePageTitle(status, overallProgress)

  const hasPending = Object.keys(pendingFiles).length > 0
  const completedCount = Object.keys(completedFiles).length
  const isDead = status === 'closed' || status === 'error' || status === 'rejected'
  const isConnecting = status === 'connecting' || status === 'retrying' || status === 'reconnecting'
  const showManifest = status === 'manifest-received' || (manifest && !isDead && status !== 'password-required')
  const isChatOnly = manifest?.chatOnly
  const allDone = manifest && !manifest.chatOnly && completedCount === manifest.files.length
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
                {isChatOnly
                  ? <><MessagesSquare className="w-3 h-3" /> Chat room</>
                  : <><Download className="w-3 h-3" /> Incoming file portal</>
                }
              </p>
            </Link>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        <StatusIndicator status={isChatOnly && status === 'manifest-received' ? 'connected' : status}>
          {showManifest && (
            <>
              <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${useRelay ? 'bg-warning/5 border-warning/20' : 'bg-accent/5 border-accent/20'}`} title={useRelay ? 'Files pass through an encrypted relay server' : 'Files transfer directly between browsers'}>
                <Wifi className={`w-3 h-3 ${useRelay ? 'text-warning' : 'text-accent'}`} />
                <span className={`font-mono text-[10px] ${useRelay ? 'text-warning' : 'text-accent'}`}>{useRelay ? 'Relay' : 'P2P'}</span>
              </div>
              {rtt !== null && (
                <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${rtt < 100 ? 'bg-accent/5 border-accent/20' : rtt < 300 ? 'bg-yellow-400/5 border-yellow-400/20' : 'bg-danger/5 border-danger/20'}`} title={`Round-trip latency: ${rtt}ms${rtt < 100 ? ' (excellent)' : rtt < 300 ? ' (good)' : ' (slow)'}`}>
                  <span className={`font-mono text-[10px] ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-yellow-400' : 'text-danger'}`}>{rtt}ms</span>
                </div>
              )}
              <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={fingerprint ? `Verify fingerprint: ${fingerprint}` : 'E2E encrypted'}>
                <Shield className="w-3 h-3 text-accent" />
                <span className="font-mono text-[10px] text-accent">E2E</span>
                {fingerprint && <code className="font-mono text-[9px] text-accent/50 hidden sm:inline">{fingerprint}</code>}
              </div>
            </>
          )}
        </StatusIndicator>

        {/* Dead states */}
        {status === 'closed' && !manifest && (
          <ErrorBlock title="This portal no longer exists." desc="The sender has closed their tab or the connection timed out. Ask them to open a new portal." />
        )}
        {status === 'closed' && manifest && (
          <ErrorBlock title="Portal closed." desc="The sender disconnected. Files already downloaded are saved." />
        )}
        {status === 'rejected' && (
          <ErrorBlock title="Connection rejected." desc="The sender rejected this connection. Ask them to share a new portal link." />
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

        {/* Password required */}
        {status === 'password-required' && (
          <div className="text-center py-10 animate-fade-in-up space-y-5">
            <div className="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto">
              <Lock className="w-8 h-8 text-accent" strokeWidth={1.5} />
            </div>
            <div>
              <p className="font-mono text-sm text-text mb-2">This portal is password protected</p>
              <p className="text-xs text-muted max-w-sm mx-auto">Enter the password to access the files.</p>
            </div>
            <form onSubmit={(e) => { e.preventDefault(); setPasswordLoading(true); submitPassword(passwordInput); setTimeout(() => setPasswordLoading(false), 2000) }} className="max-w-xs mx-auto space-y-3">
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => { setPasswordInput(e.target.value); setPasswordLoading(false) }}
                placeholder="Enter password"
                disabled={passwordLoading}
                className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 font-mono text-sm text-text text-center placeholder:text-muted/40 focus:outline-none focus:border-accent/40 transition-colors min-h-[44px] disabled:opacity-40"
                autoFocus
              />
              {passwordError && !passwordLoading && (
                <p className="font-mono text-xs text-danger">Wrong password. Try again.</p>
              )}
              <button type="submit" disabled={passwordLoading || !passwordInput} className="w-full px-4 py-2.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim transition-colors disabled:opacity-40 disabled:cursor-not-allowed min-h-[44px]">
                {passwordLoading ? 'Verifying...' : 'Unlock Portal'}
              </button>
            </form>
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
            <p className="font-mono text-sm text-text mb-2">Connected. Setting up...</p>
          </div>
        )}

        {/* Chat room label */}
        {showManifest && isChatOnly && (
          <div className="flex items-center gap-2 bg-accent/5 border border-accent/20 rounded-xl px-4 py-3 animate-fade-in-up">
            <MessagesSquare className="w-4 h-4 text-accent" />
            <span className="font-mono text-sm text-accent font-medium">Chat Room</span>
          </div>
        )}

        {/* Manifest + file list — hidden in chat-only mode */}
        {showManifest && manifest && !isChatOnly && (
          <div className="space-y-4 animate-fade-in-up">
            <div className="glow-card overflow-hidden">
              {/* Collapsible header */}
              <button
                onClick={() => setFilesOpen(o => !o)}
                className="w-full flex items-center justify-between px-4 py-3 text-left group"
              >
                <div className="flex items-center gap-2">
                  <Download className="w-3.5 h-3.5 text-accent" />
                  <span className="font-mono text-sm text-text-bright font-bold">{manifest.files.length}</span>
                  <span className="text-xs text-muted">
                    file{manifest.files.length !== 1 ? 's' : ''} &middot; {formatBytes(manifest.totalSize)}
                    {completedCount > 0 && <> &middot; {completedCount} saved</>}
                  </span>
                </div>
                <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${filesOpen ? 'rotate-180' : ''}`} />
              </button>

              {/* Collapsible body */}
              <div className={`grid transition-all duration-400 ease-in-out ${filesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                <div className="overflow-hidden">
                  <div className="px-4 pb-4 space-y-3">
                    {/* Single file download */}
                    {!allDone && !isDead && manifest.files.length === 1 && !completedFiles[0] && !pendingFiles[0] && (
                      <button
                        onClick={() => requestFile(0)}
                        className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs bg-accent text-bg font-medium hover:bg-accent-dim transition-colors"
                      >
                        <Download className="w-3.5 h-3.5" />
                        Download File
                      </button>
                    )}

                    {/* Transfer info */}
                    {hasPending && (
                      <div className="flex items-start gap-2 bg-info/5 border border-info/15 rounded-lg px-3 py-2">
                        <Info className="w-3.5 h-3.5 text-info shrink-0 mt-0.5" />
                        <p className="font-mono text-[10px] text-info/80 leading-relaxed">
                          {zipMode
                            ? 'Downloading all files. A zip will be saved when complete.'
                            : 'Downloading to your device. Keep this tab open.'}
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
                </div>
              </div>
              {/* Progress bar — attached to file list */}
              {(hasPending || completedCount > 0) && (
                <div className="px-4 pb-3 space-y-2 border-t border-border">
                  <div className="pt-3">
                    <ProgressBar percent={overallProgress} label="Overall progress" />
                  </div>
                  <div className="flex justify-between font-mono text-[10px] text-muted">
                    <span>{formatSpeed(speed)}</span>
                    <span>{allDone ? `${formatBytes(totalReceived)} in ${formatElapsed(elapsed)}` : `ETA: ${formatTime(eta)}`}</span>
                  </div>
                  {hasPending && (
                    <div className="flex justify-between font-mono text-[9px] text-muted/60">
                      <span>{formatBytes(totalReceived)} received</span>
                      <span>Elapsed: {formatElapsed(elapsed)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Download all bar */}
            {!allDone && !isDead && !hasPending && manifest.files.length > 1 && (
              <div className="sticky bottom-4 z-10">
                <div className="flex items-center justify-center gap-3 bg-surface/95 backdrop-blur-sm border border-border rounded-xl px-4 py-2.5 shadow-lg shadow-black/30">
                  <button
                    onClick={requestAllAsZip}
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg font-mono text-xs bg-accent text-bg font-medium hover:bg-accent-dim transition-colors"
                  >
                    <Archive className="w-3.5 h-3.5" />
                    Download All as Zip
                  </button>
                  {completedCount > 0 && (
                    <span className="font-mono text-[10px] text-muted">
                      {completedCount}/{manifest.files.length} saved
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Chat */}
        {showManifest && !isDead && (
          <ChatPanel messages={messages} onSend={sendMessage} disabled={isDead} nickname={nickname} onNicknameChange={changeNickname} onlineCount={onlineCount} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
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
