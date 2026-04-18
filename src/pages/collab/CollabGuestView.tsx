import { Link } from 'react-router-dom'
import { useState, useRef, useCallback, useMemo, useEffect, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import {
  ArrowLeft,
  AlertCircle,
  Lock,
  Loader2,
  Users,
  User,
  Upload,
  Download,
  Crown,
  UserMinus,
  DoorOpen,
  ChevronDown,
  Info,
  Pencil,
  Radio,
  Eye,
  EyeOff,
} from 'lucide-react'
import { useCollabGuest } from '../../hooks/useCollabGuest'
import { formatBytes } from '../../utils/formatBytes'
import StatusIndicator from '../../components/StatusIndicator'
import CollabFileList from '../../components/CollabFileList'
import ChatPanel from '../../components/ChatPanel'
import CallPanelLazy from '../../components/CallPanelLazy'
import AppFooter from '../../components/AppFooter'
import { ComponentErrorBoundary } from '../../components/ErrorBoundary'
import { ConnectionChips, UploadsSummary, VerifyConnectionsPanel, type FingerprintEntry } from './CollabShared'

export default function CollabGuestView({ roomId }: { roomId: string }) {
  const guest = useCollabGuest(roomId)

  const [passwordInput, setPasswordInput] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [roomExpanded, setRoomExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const [isDragging, setIsDragging] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(guest.myName)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const hasPending = Object.values(guest.downloads).some(d => d.status === 'downloading' || d.status === 'requesting' || d.status === 'queued')

  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files) {
      Array.from(files).forEach(file => guest.shareFile(file))
    }
    e.target.value = ''
  }, [guest])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const files = e.dataTransfer.files
    if (files) {
      Array.from(files).forEach(file => guest.shareFile(file))
    }
  }, [guest])

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handlePasswordSubmit = useCallback((e: FormEvent) => {
    e.preventDefault()
    setPasswordLoading(true)
    guest.submitPassword(passwordInput)
  }, [passwordInput, guest])

  const fingerprintEntries = useMemo<FingerprintEntry[]>(() => {
    const out: FingerprintEntry[] = []
    const hostPart = guest.participants.find(p => p.isHost)
    if (hostPart) {
      out.push({ peerId: hostPart.peerId, name: `${hostPart.name} (Host)`, fingerprint: guest.fingerprint ?? undefined })
    }
    for (const p of guest.participants) {
      if (p.isHost) continue
      if (p.peerId === guest.myPeerId) continue
      out.push({ peerId: p.peerId, name: p.name, fingerprint: p.fingerprint })
    }
    return out
  }, [guest.participants, guest.fingerprint, guest.myPeerId])

  const isPasswordRequired = guest.status === 'password-required'
  const isConnecting = guest.status === 'joining' || guest.status === 'reconnecting'
  const isConnected = guest.status === 'connected'
  const isDirectFailed = guest.status === 'direct-failed'
  const isDead = guest.status === 'closed' || guest.status === 'error' || guest.status === 'kicked'

  useEffect(() => {
    if (!isPasswordRequired || guest.passwordError) setPasswordLoading(false)
  }, [isPasswordRequired, guest.passwordError])

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80">
        <div className="max-w-5xl mx-auto px-6 py-5">
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
                <Users className="w-3 h-3" /> Collaborative Portal
              </p>
            </Link>
            <Link
              to="/faq"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs bg-surface border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors"
            >
              FAQ
            </Link>
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-5xl mx-auto px-6 py-8 space-y-6">
        {isConnecting && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="relative w-20 h-20 mx-auto mb-6">
              <div className="absolute inset-0 rounded-2xl bg-accent/10 animate-pulse" />
              <div className="absolute inset-2 rounded-xl border-2 border-accent/30 flex items-center justify-center">
                <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin-slow" />
              </div>
            </div>
            <p className="font-mono text-base text-text font-medium mb-2">
              {guest.status === 'reconnecting' ? 'Reconnecting...' : 'Joining room...'}
            </p>
            <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed">
              Establishing a secure peer-to-peer connection.
            </p>
          </div>
        )}

        {isDirectFailed && (
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
              <button
                onClick={guest.enableRelay}
                className="inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-all"
              >
                <Radio className="w-4 h-4" /> Connect via Relay
              </button>
            </div>
          </div>
        )}

        {isPasswordRequired && (
          <div className="text-center py-12 animate-fade-in-up">
            <div className="max-w-sm mx-auto space-y-6">
              <div className="w-18 h-18 rounded-2xl bg-accent/10 flex items-center justify-center mx-auto ring-4 ring-accent/5">
                <Lock className="w-9 h-9 text-accent" strokeWidth={1.5} />
              </div>
              <div>
                <p className="font-mono text-lg text-text font-medium mb-2">Password Protected</p>
                <p className="text-sm text-muted">Enter the password to join this room.</p>
              </div>
              <form onSubmit={handlePasswordSubmit} className="space-y-4">
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    aria-label="Room password"
                    value={passwordInput}
                    onChange={e => { setPasswordInput(e.target.value); setPasswordLoading(false) }}
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
                {guest.passwordError && !passwordLoading && (
                  <div className="flex items-center justify-center gap-2 text-danger">
                    <AlertCircle className="w-4 h-4" />
                    <p className="font-mono text-sm">Wrong password. Try again.</p>
                  </div>
                )}
                <button
                  type="submit"
                  disabled={passwordLoading || !passwordInput}
                  className="w-full px-5 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {passwordLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Verifying...</> : 'Join Room'}
                </button>
              </form>
            </div>
          </div>
        )}

        {guest.status === 'error' && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-6 ring-4 ring-danger/5">
              <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
            </div>
            <p className="font-mono text-lg text-text font-medium mb-2">Connection Failed</p>
            <p className="text-sm text-muted mb-6">{guest.errorMessage || 'Could not connect to the room. It may no longer exist.'}</p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Home
            </Link>
          </div>
        )}

        {guest.status === 'closed' && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="w-18 h-18 rounded-2xl bg-warning/10 flex items-center justify-center mx-auto mb-6 ring-4 ring-warning/5">
              <DoorOpen className="w-9 h-9 text-warning" strokeWidth={1.5} />
            </div>
            <p className="font-mono text-lg text-text font-medium mb-2">Room Closed</p>
            <p className="text-sm text-muted mb-6">The host has closed this room.</p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Home
            </Link>
          </div>
        )}

        {guest.status === 'kicked' && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-6 ring-4 ring-danger/5">
              <UserMinus className="w-9 h-9 text-danger" strokeWidth={1.5} />
            </div>
            <p className="font-mono text-lg text-text font-medium mb-2">Removed from Room</p>
            <p className="text-sm text-muted mb-6">The host removed you from this room.</p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Home
            </Link>
          </div>
        )}

        {isConnected && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] items-start">
            <div className="space-y-6 min-w-0">
          <div className="glow-card overflow-hidden animate-fade-in-up">
            <button
              onClick={() => setRoomExpanded(o => !o)}
              aria-expanded={roomExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <StatusIndicator status="connected" embedded>
                  <ConnectionChips rtt={guest.rtt} fingerprint={guest.fingerprint} />
                </StatusIndicator>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${roomExpanded ? 'rotate-180' : ''}`} />
            </button>

            <div className={`grid transition-all duration-400 ease-in-out ${roomExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                <div className="px-5 py-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-muted uppercase tracking-wide">Participants</span>
                    <span className="font-mono text-xs text-accent">{guest.onlineCount}</span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-accent/5 border border-accent/20">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                          <User className="w-3 h-3 text-accent" />
                        </div>
                        {editingName ? (
                          <input
                            type="text"
                            value={nameInput}
                            onChange={e => setNameInput(e.target.value)}
                            onBlur={() => {
                              if (nameInput.trim() && nameInput.trim() !== guest.myName) {
                                guest.changeNickname(nameInput.trim())
                              }
                              setEditingName(false)
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                if (nameInput.trim() && nameInput.trim() !== guest.myName) {
                                  guest.changeNickname(nameInput.trim())
                                }
                                setEditingName(false)
                              } else if (e.key === 'Escape') {
                                setNameInput(guest.myName)
                                setEditingName(false)
                              }
                            }}
                            className="flex-1 min-w-0 bg-bg border border-accent/30 rounded px-2 py-0.5 font-mono text-sm text-text focus:outline-none focus:border-accent"
                            autoFocus
                          />
                        ) : (
                          <>
                            <span className="font-mono text-sm text-text truncate">{guest.myName}</span>
                            <span className="font-mono text-[10px] text-muted shrink-0">(You)</span>
                          </>
                        )}
                      </div>
                      {!editingName && (
                        <button
                          onClick={() => { setNameInput(guest.myName); setEditingName(true) }}
                          className="p-1 rounded hover:bg-accent/10 text-muted hover:text-accent transition-colors shrink-0"
                          title="Edit nickname"
                        >
                          <Pencil className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                    {guest.participants
                      .filter(p => p.peerId !== guest.myPeerId)
                      .map(p => (
                        <div key={p.peerId} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-2/50 border border-border">
                          <div className="flex items-center gap-2">
                            <div className="w-6 h-6 rounded-full bg-surface flex items-center justify-center">
                              {p.isHost ? <Crown className="w-3 h-3 text-accent" /> : <Users className="w-3 h-3 text-muted" />}
                            </div>
                            <span className="font-mono text-sm text-text">{p.name}</span>
                            {p.isHost && <span className="font-mono text-[10px] text-accent">(Host)</span>}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>

                <VerifyConnectionsPanel entries={fingerprintEntries} />
              </div>
            </div>
          </div>

          <div className="glow-card overflow-hidden animate-fade-in-up">
            <button
              onClick={() => setFilesExpanded(o => !o)}
              aria-expanded={filesExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 text-accent" />
                <span className="font-mono text-sm text-text-bright font-bold">{guest.sharedFiles.length}</span>
                <span className="text-xs text-muted">
                  file{guest.sharedFiles.length !== 1 ? 's' : ''} &middot; {formatBytes(guest.sharedFiles.reduce((s, f) => s + f.size, 0))}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${filesExpanded ? 'rotate-180' : ''}`} />
            </button>

            <div className={`grid transition-all duration-400 ease-in-out ${filesExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                <div
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`px-5 py-4 border-t border-border transition-colors ${isDragging ? 'bg-accent/5 border-accent/30' : ''}`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    aria-label="Share files with the room"
                    onChange={handleFileSelect}
                    className="hidden"
                  />
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="w-full py-6 border-2 border-dashed border-border rounded-xl hover:border-accent/40 transition-colors group"
                  >
                    <Upload className="w-6 h-6 text-muted group-hover:text-accent mx-auto mb-2 transition-colors" />
                    <p className="font-mono text-xs text-muted group-hover:text-text transition-colors">
                      Share files with the room
                    </p>
                  </button>
                </div>

                <UploadsSummary uploads={guest.uploads} />

                {hasPending && (
                  <div className="px-4 py-3 border-t border-border">
                    <div className="flex items-center gap-2 bg-info/5 border border-info/15 rounded-lg px-3 py-2">
                      <Info className="w-3.5 h-3.5 text-info shrink-0" />
                      <p className="flex-1 font-mono text-[10px] text-info/80 leading-relaxed">
                        Downloading files directly from peers
                      </p>
                      <button
                        onClick={guest.cancelAll}
                        className="shrink-0 px-2 py-1 rounded-lg font-mono text-[10px] bg-danger/10 text-danger hover:bg-danger/20 transition-colors"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}

                <div className="px-4 pb-4 border-t border-border pt-4">
                  <ComponentErrorBoundary name="Files">
                    <CollabFileList
                      files={guest.sharedFiles}
                      downloads={guest.downloads}
                      myPeerId={guest.myPeerId}
                      mySharedFiles={guest.mySharedFiles}
                      onDownload={(fileId, ownerId) => guest.requestFile(fileId, ownerId)}
                      onRemove={(fileId) => guest.removeFile(fileId)}
                      onPause={(fileId) => guest.pauseFile?.(fileId)}
                      onResume={(fileId) => guest.resumeFile?.(fileId)}
                      onCancel={(fileId) => guest.cancelFile?.(fileId)}
                      onDismissError={(fileId) => guest.clearDownload?.(fileId)}
                      uploadsByFileId={guest.uploads}
                    />
                  </ComponentErrorBoundary>
                </div>
              </div>
            </div>
          </div>

            </div>

            <aside className="space-y-6 lg:sticky lg:top-6">
              <ComponentErrorBoundary name="Call">
                <CallPanelLazy
                  callOptions={{
                    peer: guest.peer,
                    myPeerId: guest.myPeerId,
                    myName: guest.myName,
                    isHost: false,
                    hostPeerId: guest.hostPeerId,
                    participants: guest.participantsList,
                    sendToHost: guest.sendCallMessage,
                    setMessageHandler: guest.setCallMessageHandler,
                  }}
                  myName={guest.myName}
                  disabled={isDead}
                  connectionStatus={guest.status}
                />
              </ComponentErrorBoundary>

              <ComponentErrorBoundary name="Chat">
                <ChatPanel
                  messages={guest.messages}
                  onSend={guest.sendMessage}
                  onClearMessages={guest.clearMessages}
                  disabled={isDead}
                  nickname={guest.myName}
                  onNicknameChange={guest.changeNickname}
                  onlineCount={guest.onlineCount}
                  typingUsers={guest.typingUsers}
                  onTyping={guest.sendTyping}
                  onReaction={guest.sendReaction}
                />
              </ComponentErrorBoundary>
            </aside>
          </div>
        )}
      </main>

      <AppFooter />
    </div>
  )
}
