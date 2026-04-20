import { useParams, Link } from 'react-router-dom'
import { useReceiver } from '../hooks/useReceiver'
import { formatBytes, formatSpeed, formatTime } from '../utils/formatBytes'
import { usePageTitle } from '../hooks/usePageTitle'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import FileList from '../components/FileList'
import ProgressBar from '../components/ProgressBar'
import StatusIndicator from '../components/StatusIndicator'
import ChatPanel from '../components/ChatPanel'
import CallPanelLazy from '../components/CallPanelLazy'
import AppFooter from '../components/AppFooter'
import { ComponentErrorBoundary } from '../components/ErrorBoundary'
import { useState, useEffect, type ChangeEvent } from 'react'
import { ArrowLeft, AlertCircle, Download, Shield, Info, Radio, Wifi, Archive, Lock, ChevronDown, MessagesSquare, Loader2, Eye, EyeOff } from 'lucide-react'
import Logo from '../components/Logo'

export default function Portal() {
  const { peerId } = useParams<{ peerId: string }>()
  const {
    manifest, status, progress, overallProgress, speed, eta,
    pendingFiles, completedFiles, requestFile, requestAllAsZip,
    retryCount, useRelay, enableRelay, zipMode, fingerprint,
    passwordRequired, passwordError, submitPassword,
    messages, sendMessage, clearMessages, rtt, nickname, changeNickname, onlineCount,
    typingUsers, sendTyping, sendReaction, cancelFile, cancelAll, pauseFile, resumeFile, pausedFiles,
    peer: receiverPeer, hostPeerId, sendCallMessage, setCallMessageHandler,
  } = useReceiver(peerId ?? '')
  const [passwordInput, setPasswordInput] = useState<string>('')
  const [passwordLoading, setPasswordLoading] = useState<boolean>(false)
  const [showPassword, setShowPassword] = useState<boolean>(false)
  const [manifestSlow, setManifestSlow] = useState(false)

  // Surface an escape hatch if the sender's manifest hasn't arrived after 15s.
  useEffect(() => {
    setManifestSlow(false)
    if (status !== 'connected' || manifest) return
    const t = setTimeout(() => setManifestSlow(true), 15_000)
    return () => clearTimeout(t)
  }, [status, manifest])
  const [filesOpen, setFilesOpen] = useState<boolean>(true)
  usePageTitle(status, overallProgress)

  useEffect(() => {
    if (!passwordRequired || passwordError) setPasswordLoading(false)
  }, [passwordRequired, passwordError])

  const hasPending: boolean = Object.keys(pendingFiles).length > 0
  const completedCount: number = Object.keys(completedFiles).length
  const isDead: boolean = status === 'closed' || status === 'error' || status === 'rejected' || status === 'direct-failed'
  const isConnecting: boolean = status === 'connecting' || status === 'retrying' || status === 'reconnecting'
  const showManifest: boolean = status === 'manifest-received' || (manifest !== null && !isDead && status !== 'password-required')
  const isChatOnly: boolean | undefined = manifest?.chatOnly
  const allDone: boolean = manifest !== null && !manifest.chatOnly && completedCount === manifest.files.length
  const elapsed: number = useElapsedTime(hasPending)

  const currentFileIndex: number = manifest ? manifest.files.findIndex(f => {
    const pct: number | undefined = progress?.[f.name]
    return pct != null && pct > 0 && pct < 100
  }) : -1

  const totalReceived: number = manifest ? manifest.files.reduce((sum, f) => {
    const pct: number = progress?.[f.name] || 0
    return sum + Math.round((f.size * pct) / 100)
  }, 0) : 0

  if (!peerId || peerId.trim().length === 0) {
    return (
      <div className="min-h-screen flex flex-col bg-grid items-center justify-center px-6">
        <div className="text-center space-y-5 animate-fade-in-up glass-strong rounded-3xl px-10 py-12 max-w-md">
          <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto ring-4 ring-danger/5">
            <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
          </div>
          <div>
            <p className="font-mono text-lg text-text-bright font-medium mb-2">Invalid Portal Link</p>
            <p className="text-sm text-muted-light leading-relaxed">This link appears to be incomplete or invalid.</p>
          </div>
          <Link to="/" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm glass-accent text-accent hover:text-accent-bright hover:border-accent/50 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Go Home
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-grid">

      <header className="border-b border-border/60 glass">
        <div className="max-w-5xl mx-auto px-6 py-5">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-accent transition-colors mb-3 w-fit group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-mono text-[11px]">Create your own portal</span>
          </Link>
          <div className="flex items-center justify-between">
            <Link to="/" className="group flex items-center gap-3">
              <span className="relative inline-flex w-9 h-9 rounded-xl items-center justify-center glass-accent shrink-0">
                <Logo className="w-5 h-5" />
                <span className="absolute inset-0 rounded-xl bg-accent/10 blur-md -z-10" />
              </span>
              <span>
                <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                  The Manifest
                </h1>
                <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide flex items-center gap-1.5">
                  {isChatOnly
                    ? <><MessagesSquare className="w-3 h-3" /> Chat room</>
                    : <><Download className="w-3 h-3" /> Incoming file portal</>
                  }
                </p>
              </span>
            </Link>
            <Link
              to="/faq"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs
                glass text-muted-light hover:text-accent hover:border-accent/40 transition-colors"
            >
              <span>FAQ</span>
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-8 space-y-6">

        {!showManifest && (
          <StatusIndicator status={status} />
        )}

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

        {isConnecting && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="relative w-20 h-20 mx-auto mb-6">
              <div className="absolute inset-0 rounded-2xl bg-accent/10 animate-pulse" />
              <div className="absolute inset-2 rounded-xl border-2 border-accent/30 flex items-center justify-center">
                <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin-slow" />
              </div>
            </div>
            <p className="font-mono text-base text-text font-medium mb-2">
              {status === 'reconnecting' ? 'Reconnecting...' : status === 'retrying' ? `Retrying connection (${retryCount + 1}/2)` : 'Connecting to portal'}
            </p>
            <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed">
              {status === 'reconnecting' ? 'Connection dropped. Resuming where we left off.' : 'Establishing a secure peer-to-peer connection with the sender.'}
            </p>
          </div>
        )}

        {status === 'password-required' && (
          <div className="text-center py-12 animate-fade-in-up">
            <div className="max-w-sm mx-auto space-y-6 glass-strong rounded-3xl px-8 py-10">
              <div className="w-18 h-18 rounded-2xl glass-accent flex items-center justify-center mx-auto">
                <Lock className="w-9 h-9 text-accent" strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-mono text-lg text-text-bright font-medium mb-2">Password Protected</p>
                <p className="text-sm text-muted-light">Enter the password to access this portal.</p>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  setPasswordLoading(true)
                  submitPassword(passwordInput)
                }}
                className="space-y-4"
              >
                <div className="relative">
                  <label htmlFor="portal-unlock-password" className="sr-only">Portal password</label>
                  <input
                    id="portal-unlock-password"
                    type={showPassword ? 'text' : 'password'}
                    aria-label="Portal password"
                    value={passwordInput}
                    onChange={(e: ChangeEvent<HTMLInputElement>) => { setPasswordInput(e.target.value); setPasswordLoading(false) }}
                    placeholder="Enter password"
                    disabled={passwordLoading}
                    className="w-full bg-bg border border-border rounded-xl px-4 py-3.5 pr-11 font-mono text-sm text-text text-center placeholder:text-muted/40 focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10 transition-all disabled:opacity-40"
                    autoFocus
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
                {passwordError && !passwordLoading && (
                  <div className="flex items-center justify-center gap-2 text-danger">
                    <AlertCircle className="w-4 h-4" />
                    <p className="font-mono text-sm">Wrong password. Try again.</p>
                  </div>
                )}
                <button type="submit" data-testid="portal-password-submit" disabled={passwordLoading || !passwordInput} className="w-full px-5 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-bright active:scale-[0.98] shadow-[0_0_24px_var(--color-accent-glow)] transition-all disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none">
                  {passwordLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Verifying...</> : 'Unlock Portal'}
                </button>
              </form>
            </div>
          </div>
        )}

        {status === 'direct-failed' && (
          <div className="text-center py-12 animate-fade-in-up">
            <div className="max-w-sm mx-auto space-y-6 glass-strong rounded-3xl px-8 py-10">
              <div className="w-18 h-18 rounded-2xl bg-warning/10 flex items-center justify-center mx-auto ring-4 ring-warning/5">
                <Radio className="w-9 h-9 text-warning" strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-mono text-lg text-text-bright font-medium mb-2">Direct connection failed</p>
                <p className="text-sm text-muted-light leading-relaxed">Your network doesn&apos;t allow a direct connection. You can use an encrypted relay instead.</p>
              </div>
              <div className="glass rounded-xl p-4 text-left space-y-3">
                <p className="font-mono text-xs text-accent font-medium">What does this mean?</p>
                <ul className="space-y-2 text-sm text-muted-light leading-relaxed">
                  <li className="flex gap-2"><span className="text-accent shrink-0">1.</span>Files pass through a relay server</li>
                  <li className="flex gap-2"><span className="text-accent shrink-0">2.</span>All data is still end-to-end encrypted</li>
                  <li className="flex gap-2"><span className="text-accent shrink-0">3.</span>Speed may be slightly slower</li>
                </ul>
              </div>
              <button onClick={enableRelay} className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-bright active:scale-[0.98] shadow-[0_0_24px_var(--color-accent-glow)] transition-all">
                <Radio className="w-4 h-4" /> Connect via Relay
              </button>
            </div>
          </div>
        )}

        {status === 'connected' && !manifest && (
          <div className="text-center py-10 animate-fade-in-up">
            <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto mb-3" />
            <p className="font-mono text-sm text-text mb-2">Connected. Setting up...</p>
            <p className="text-xs text-muted">Waiting for the sender to share their manifest.</p>
            {manifestSlow && (
              <div className="mt-4 space-y-3">
                <p className="text-xs text-warning">Taking longer than expected. Ask the sender to re-share the link.</p>
                <button
                  onClick={() => window.location.reload()}
                  className="px-4 py-2 rounded-xl font-mono text-xs bg-surface-2 border border-border hover:border-accent/30 text-muted-light hover:text-accent transition-colors"
                >
                  Reload
                </button>
              </div>
            )}
          </div>
        )}

        {showManifest && (
          <div className={isChatOnly ? 'max-w-[720px] mx-auto space-y-6' : 'grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] items-start'}>
            <div className="space-y-6 min-w-0">
              <div className="glow-card overflow-hidden animate-fade-in-up">
            <div className="px-4 py-3 space-y-2">
              {isChatOnly && (
                <div className="flex items-center gap-2">
                  <MessagesSquare className="w-4 h-4 text-accent" />
                  <span className="font-mono text-sm text-accent font-medium">Chat Room</span>
                </div>
              )}
              <StatusIndicator status={isChatOnly && status === 'manifest-received' ? 'connected' : status} embedded>
                <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${useRelay ? 'bg-warning/5 border-warning/20' : 'bg-accent/5 border-accent/20'}`} title={useRelay ? 'Files pass through an encrypted relay server' : 'Files transfer directly between browsers'}>
                  <Wifi className={`w-3 h-3 ${useRelay ? 'text-warning' : 'text-accent'}`} />
                  <span className={`font-mono text-[10px] ${useRelay ? 'text-warning' : 'text-accent'}`}>{useRelay ? 'Relay' : 'P2P'}</span>
                </div>
                {rtt !== null && (
                  <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${rtt < 100 ? 'bg-accent/5 border-accent/20' : rtt < 300 ? 'bg-warning-mid/5 border-warning-mid/20' : 'bg-danger/5 border-danger/20'}`} title={`Round-trip latency: ${rtt}ms${rtt < 100 ? ' (excellent)' : rtt < 300 ? ' (good)' : ' (slow)'}`}>
                    <span className={`font-mono text-[10px] ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-warning-mid' : 'text-danger'}`}>{rtt}ms</span>
                  </div>
                )}
                <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={fingerprint ? `Verify fingerprint: ${fingerprint}` : 'E2E encrypted'}>
                  <Shield className="w-3 h-3 text-accent" />
                  <span className="font-mono text-[10px] text-accent">E2E</span>
                  {fingerprint && <code className="font-mono text-[9px] text-accent/50 hidden sm:inline">{fingerprint}</code>}
                </div>
              </StatusIndicator>
            </div>

            {/* Empty manifest state — sender has no files queued */}
            {!isChatOnly && manifest && (!manifest.files || manifest.files.length === 0) && (
              <div className="border-t border-border px-4 py-6 text-center">
                <p className="font-mono text-xs text-muted">Waiting for sender to queue files...</p>
              </div>
            )}

            {/* File list */}
            {!isChatOnly && manifest && manifest.files?.length > 0 && (
              <div className="border-t border-border">
                {/* Collapsible header */}
                <button
                  onClick={() => setFilesOpen(o => !o)}
                  aria-expanded={filesOpen}
                  aria-controls="portal-files-panel"
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
                <div id="portal-files-panel" className={`grid transition-all duration-400 ease-in-out ${filesOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                  <div className="overflow-hidden">
                    <div className="px-4 pb-4 space-y-3">
                      {(() => {
                        if (allDone || isDead || hasPending) return null
                        const remainingIndices = manifest.files.map((_, i) => i).filter(i => !completedFiles[i])
                        if (remainingIndices.length === 0) return null
                        const singleRemaining = remainingIndices.length === 1
                        const onlyIdx = remainingIndices[0]
                        return (
                          <div className="flex items-center gap-3">
                            <button
                              onClick={singleRemaining ? () => requestFile(onlyIdx) : requestAllAsZip}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs bg-accent text-bg font-medium hover:bg-accent-bright active:scale-[0.98] shadow-[0_0_18px_var(--color-accent-glow)] transition-colors"
                            >
                              {singleRemaining
                                ? <><Download className="w-3.5 h-3.5" /> Download</>
                                : <><Archive className="w-3.5 h-3.5" /> Download {remainingIndices.length} Files as Zip</>
                              }
                            </button>
                            {completedCount > 0 && (
                              <span className="font-mono text-[10px] text-muted">{completedCount}/{manifest.files.length} saved</span>
                            )}
                          </div>
                        )
                      })()}

                      {hasPending && (
                        <div className="flex items-center gap-2 bg-info/5 border border-info/15 rounded-lg px-3 py-2">
                          <Info className="w-3.5 h-3.5 text-info shrink-0" />
                          <p className="flex-1 font-mono text-[10px] text-info/80 leading-relaxed">
                            {zipMode
                              ? 'Downloading all files as zip.'
                              : 'Downloading to your device.'}
                          </p>
                          <button
                            onClick={cancelAll}
                            className="shrink-0 px-2 py-1 rounded-lg font-mono text-[10px] bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      <ComponentErrorBoundary name="Files">
                        <FileList
                          files={manifest.files}
                          progress={progress}
                          pendingFiles={pendingFiles}
                          pausedFiles={pausedFiles}
                          onRequest={isDead || hasPending ? null : requestFile}
                          onCancel={hasPending ? cancelFile : null}
                          onPause={hasPending ? pauseFile : null}
                          onResume={resumeFile}
                          currentFileIndex={currentFileIndex}
                        />
                      </ComponentErrorBoundary>
                    </div>
                  </div>
                </div>
                {(hasPending || completedCount > 0) && (
                  <div className="px-4 pb-3 space-y-2 border-t border-border">
                    <div className="pt-3">
                      <ProgressBar percent={overallProgress} label="Overall progress" />
                    </div>
                    <div className="flex justify-between font-mono text-[10px] text-muted">
                      <span>{formatSpeed(speed)}</span>
                      <span>{allDone ? `${formatBytes(totalReceived)} in ${formatElapsed(elapsed)}` : `ETA: ${formatTime(eta ?? 0)}`}</span>
                    </div>
                    {hasPending && (
                      <div className="flex justify-between font-mono text-[10px] text-muted/60">
                        <span>{formatBytes(totalReceived)} received</span>
                        <span>Elapsed: {formatElapsed(elapsed)}</span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
              </div>
            </div>

            <div className={isChatOnly ? 'space-y-6' : 'space-y-6 lg:sticky lg:top-6'}>
              {!isDead && (
                <ComponentErrorBoundary name="Call">
                  <CallPanelLazy
                    callOptions={{
                      peer: receiverPeer,
                      myPeerId: receiverPeer?.id ?? null,
                      myName: nickname,
                      isHost: false,
                      hostPeerId,
                      participants: [],
                      sendToHost: sendCallMessage,
                      setMessageHandler: setCallMessageHandler,
                    }}
                    myName={nickname}
                    disabled={isDead}
                    connectionStatus={status}
                  />
                </ComponentErrorBoundary>
              )}
              <ComponentErrorBoundary name="Chat">
                <ChatPanel messages={messages} onSend={sendMessage} onClearMessages={clearMessages} disabled={isDead} nickname={nickname} onNicknameChange={changeNickname} onlineCount={onlineCount} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
              </ComponentErrorBoundary>
            </div>
          </div>
        )}

        {/* Chat-only after disconnect when the manifest has already
            loaded — keep history visible but without the grid layout. */}
        {!showManifest && manifest && isDead && (
          <div className="max-w-[720px] mx-auto">
            <ComponentErrorBoundary name="Chat">
              <ChatPanel messages={messages} onSend={sendMessage} onClearMessages={clearMessages} disabled={isDead} nickname={nickname} onNicknameChange={changeNickname} onlineCount={onlineCount} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
            </ComponentErrorBoundary>
          </div>
        )}

      </main>

      <AppFooter />
    </div>
  )
}

interface ErrorBlockProps {
  title: string
  desc: string
}

function ErrorBlock({ title, desc }: ErrorBlockProps) {
  return (
    <div className="text-center py-16 animate-fade-in-up">
      <div className="max-w-sm mx-auto space-y-5 glass-strong rounded-3xl px-8 py-10">
        <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto ring-4 ring-danger/5">
          <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
        </div>
        <div>
          <p className="font-mono text-lg text-text-bright font-medium mb-2">{title}</p>
          <p className="text-sm text-muted-light leading-relaxed">{desc}</p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm glass-accent text-accent hover:text-accent-bright hover:border-accent/50 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Go to Home
        </Link>
      </div>
    </div>
  )
}
