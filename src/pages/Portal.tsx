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
      <div className="min-h-screen flex flex-col bg-grid bg-radial-glow items-center justify-center">
        <div className="text-center space-y-5 animate-fade-in-up">
          <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto ring-4 ring-danger/5">
            <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
          </div>
          <div>
            <p className="font-mono text-lg text-text font-medium mb-2">Invalid Portal Link</p>
            <p className="text-sm text-muted leading-relaxed">This link appears to be incomplete or invalid.</p>
          </div>
          <Link to="/" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted-light hover:border-accent/40 hover:text-accent transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Go Home
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">

      {/* Header */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sm:sticky sm:top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-accent transition-colors mb-3 w-fit group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-mono text-[11px]">Create your own portal</span>
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

      {/* Main */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        {!showManifest && (
          <StatusIndicator status={status} />
        )}

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

        {/* Password required */}
        {status === 'password-required' && (
          <div className="text-center py-12 animate-fade-in-up">
            <div className="max-w-sm mx-auto space-y-6">
              <div className="w-18 h-18 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto ring-4 ring-accent/5">
                <Lock className="w-9 h-9 text-accent" strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-mono text-lg text-text font-medium mb-2">Password Protected</p>
                <p className="text-sm text-muted">Enter the password to access this portal.</p>
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
                  <input
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
                <button type="submit" disabled={passwordLoading || !passwordInput} className="w-full px-5 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed">
                  {passwordLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Verifying...</> : 'Unlock Portal'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Direct failed — relay option */}
        {status === 'direct-failed' && (
          <div className="text-center py-12 animate-fade-in-up">
            <div className="max-w-sm mx-auto space-y-6">
              <div className="w-18 h-18 rounded-2xl bg-warning/10 flex items-center justify-center mx-auto ring-4 ring-warning/5">
                <Radio className="w-9 h-9 text-warning" strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-mono text-lg text-text font-medium mb-2">Direct connection failed</p>
                <p className="text-sm text-muted leading-relaxed">Your network doesn&apos;t allow a direct connection. You can use an encrypted relay instead.</p>
              </div>
              <div className="bg-surface-2/50 border border-border rounded-xl p-4 text-left space-y-3">
                <p className="font-mono text-xs text-accent font-medium">What does this mean?</p>
                <ul className="space-y-2 text-sm text-muted leading-relaxed">
                  <li className="flex gap-2"><span className="text-accent shrink-0">1.</span>Files pass through a relay server</li>
                  <li className="flex gap-2"><span className="text-accent shrink-0">2.</span>All data is still end-to-end encrypted</li>
                  <li className="flex gap-2"><span className="text-accent shrink-0">3.</span>Speed may be slightly slower</li>
                </ul>
              </div>
              <button onClick={enableRelay} className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-all">
                <Radio className="w-4 h-4" /> Connect via Relay
              </button>
            </div>
          </div>
        )}

        {/* Connected waiting for manifest */}
        {status === 'connected' && !manifest && (
          <div className="text-center py-10 animate-fade-in-up">
            <Loader2 className="w-6 h-6 animate-spin text-accent mx-auto mb-3" />
            <p className="font-mono text-sm text-text mb-2">Connected. Setting up...</p>
            <p className="text-xs text-muted">Waiting for the sender to share their manifest.</p>
          </div>
        )}

        {/* ── Session card: status + files or chat label ── */}
        {showManifest && (
          <div className="glow-card overflow-hidden animate-fade-in-up">
            {/* Header: status + badges */}
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
                      {(() => {
                        if (allDone || isDead || hasPending) return null
                        // Count what's actually left — a partial-completed manifest
                        // should drive the button based on remaining, not total.
                        const remainingIndices = manifest.files.map((_, i) => i).filter(i => !completedFiles[i])
                        if (remainingIndices.length === 0) return null
                        const singleRemaining = remainingIndices.length === 1
                        const onlyIdx = remainingIndices[0]
                        return (
                          <div className="flex items-center gap-3">
                            <button
                              onClick={singleRemaining ? () => requestFile(onlyIdx) : requestAllAsZip}
                              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-colors"
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
        )}


        {/* Call — only while live (no point showing after disconnect) */}
        {showManifest && !isDead && (
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

        {/* Chat — keep visible after disconnect so the user can still read history */}
        {(showManifest || (manifest && isDead)) && (
          <ComponentErrorBoundary name="Chat">
            <ChatPanel messages={messages} onSend={sendMessage} onClearMessages={clearMessages} disabled={isDead} nickname={nickname} onNicknameChange={changeNickname} onlineCount={onlineCount} typingUsers={typingUsers} onTyping={sendTyping} onReaction={sendReaction} />
          </ComponentErrorBoundary>
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
      <div className="max-w-sm mx-auto space-y-5">
        <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto ring-4 ring-danger/5">
          <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
        </div>
        <div>
          <p className="font-mono text-lg text-text font-medium mb-2">{title}</p>
          <p className="text-sm text-muted leading-relaxed">{desc}</p>
        </div>
        <Link
          to="/"
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted-light hover:border-accent/40 hover:text-accent transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Go to Home
        </Link>
      </div>
    </div>
  )
}
