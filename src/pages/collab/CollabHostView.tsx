import { Link } from 'react-router-dom'
import { useState, useRef, useCallback, useMemo, type ChangeEvent, type DragEvent } from 'react'
import {
  ArrowLeft,
  AlertCircle,
  Wifi,
  Lock,
  Loader2,
  Users,
  Copy,
  Check,
  Upload,
  Download,
  Crown,
  UserMinus,
  DoorOpen,
  ChevronDown,
  Pencil,
  QrCode,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useCollabHost } from '../../hooks/useCollabHost'
import { formatBytes } from '../../utils/formatBytes'
import CollabFileList from '../../components/CollabFileList'
import ChatPanel from '../../components/ChatPanel'
import CallPanelLazy from '../../components/CallPanelLazy'
import AppFooter from '../../components/AppFooter'
import { ComponentErrorBoundary } from '../../components/ErrorBoundary'
import { ConnectionChips, UploadsSummary, VerifyConnectionsPanel, type FingerprintEntry } from './CollabShared'

export default function CollabHostView() {
  const host = useCollabHost()

  const [copied, setCopied] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [passwordLockNotice, setPasswordLockNotice] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [roomExpanded, setRoomExpanded] = useState(true)
  const [showQr, setShowQr] = useState(false)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(host.myName)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const shareLink = host.roomId ? `${window.location.origin}/collab/${host.roomId}` : ''

  const copyLink = useCallback(() => {
    navigator.clipboard.writeText(shareLink)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [shareLink])

  const handlePasswordSet = useCallback(() => {
    const pwd = passwordInput.trim()
    if (!pwd) return
    const ok = host.setPassword(pwd)
    if (!ok) {
      setPasswordLockNotice('Password can\'t be changed while guests are connected.')
      setTimeout(() => setPasswordLockNotice(null), 4000)
      return
    }
    setPasswordInput('')
    setPasswordLockNotice(null)
  }, [passwordInput, host])

  const handlePasswordUnset = useCallback(() => {
    const ok = host.setPassword('')
    if (!ok) {
      setPasswordLockNotice('Password can\'t be removed while guests are connected.')
      setTimeout(() => setPasswordLockNotice(null), 4000)
    }
  }, [host])

  const handleFileSelect = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files
    if (files) {
      Array.from(files).forEach(file => host.shareFile(file))
    }
    e.target.value = ''
  }, [host])

  const handleDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
    const files = e.dataTransfer.files
    if (files) {
      Array.from(files).forEach(file => host.shareFile(file))
    }
  }, [host])

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const mySharedFiles = useMemo(() => {
    const set = new Set<string>()
    for (const f of host.sharedFiles) {
      if (f.owner === host.myPeerId) set.add(f.id)
    }
    return set
  }, [host.sharedFiles, host.myPeerId])

  const fingerprintEntries = useMemo<FingerprintEntry[]>(
    () => host.participants.map(p => ({ peerId: p.peerId, name: p.name, fingerprint: p.fingerprint })),
    [host.participants]
  )

  const isConnected = host.status === 'connected' || host.status === 'waiting'
  const isDead = host.status === 'closed' || host.status === 'error'
  const connectionStatus = host.status === 'waiting' ? 'connected' : host.status

  return (
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">
      {/* Header */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sm:sticky sm:top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-accent transition-colors mb-3 w-fit group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-mono text-[11px]">Back to home</span>
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

      {/* Main */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">
        {host.status === 'initializing' && (
          <div className="text-center py-16 animate-fade-in-up">
            <Loader2 className="w-8 h-8 animate-spin text-accent mx-auto mb-4" />
            <p className="font-mono text-sm text-text">Creating room...</p>
          </div>
        )}

        {host.status === 'error' && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-6 ring-4 ring-danger/5">
              <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
            </div>
            <p className="font-mono text-lg text-text font-medium mb-2">Failed to create room</p>
            <p className="text-sm text-muted mb-6">Could not establish a connection. Check your internet and try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-5 py-2.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim transition-colors"
            >
              Try Again
            </button>
          </div>
        )}

        {isConnected && (
          <div className="glow-card overflow-hidden animate-fade-in-up">
            <button
              onClick={() => setRoomExpanded(o => !o)}
              aria-expanded={roomExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                <span className="font-mono text-sm text-accent font-medium">Room Active</span>
                <div className="flex items-center gap-2">
                  <ConnectionChips rtt={host.rtt} fingerprint={host.fingerprint} />
                </div>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${roomExpanded ? 'rotate-180' : ''}`} />
            </button>

            <div className={`grid transition-all duration-400 ease-in-out ${roomExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                <div className="px-5 pb-4 border-t border-border pt-4">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 font-mono text-xs text-muted truncate">
                      {shareLink}
                    </div>
                    <button
                      onClick={copyLink}
                      className="flex items-center gap-1.5 px-3 py-2 rounded-lg font-mono text-xs bg-accent text-bg font-medium hover:bg-accent-dim transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <button
                      onClick={() => setShowQr(q => !q)}
                      aria-label="QR code"
                      title="QR code"
                      className={`shrink-0 p-2 rounded-lg transition-all active:scale-95 ${showQr ? 'bg-accent/20 text-accent' : 'bg-surface text-muted-light hover:text-accent hover:bg-accent/10'}`}
                    >
                      <QrCode className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {/* QR — collapsible, mirrors PortalLink pattern */}
                  {shareLink && (
                    <div className={`grid transition-all duration-300 ease-in-out ${showQr ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
                      <div className="overflow-hidden">
                        <div className="flex flex-col items-center gap-2 pt-4 pb-2">
                          <div className="bg-white p-3 rounded-xl shadow-xl shadow-black/40 ring-1 ring-white/20">
                            <div role="img" aria-label={`QR code linking to ${shareLink}`}>
                              <QRCodeSVG value={shareLink} size={120} level="M" bgColor="#ffffff" fgColor="#050505" />
                            </div>
                          </div>
                          <p className="font-mono text-[10px] text-muted">Scan to join on mobile</p>
                        </div>
                      </div>
                    </div>
                  )}

                  {(() => {
                    const hasGuests = host.onlineCount > 0
                    const isSet = host.passwordRequired
                    return (
                      <>
                        {!isSet && (
                          <div className="mt-3 flex items-center gap-2">
                            <input
                              type="password"
                              aria-label="Set room password"
                              placeholder={hasGuests ? 'Password locked — guests connected' : 'Set password (optional)'}
                              value={passwordInput}
                              onChange={e => setPasswordInput(e.target.value)}
                              disabled={hasGuests}
                              className="flex-1 bg-bg border border-border rounded-xl px-4 py-3 font-mono text-sm text-text placeholder:text-muted/40 focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <button
                              onClick={handlePasswordSet}
                              disabled={!passwordInput.trim() || hasGuests}
                              title={hasGuests ? 'Cannot set a password while guests are in the room' : 'Set password'}
                              aria-label="Set password"
                              className="px-4 py-3 rounded-xl font-mono text-sm border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              <Lock className="w-4 h-4" />
                            </button>
                          </div>
                        )}
                        {isSet && (
                          <div className="mt-3 flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 text-accent">
                              <Lock className="w-3.5 h-3.5" />
                              <span className="font-mono text-xs">Password protected</span>
                            </div>
                            <button
                              onClick={handlePasswordUnset}
                              disabled={hasGuests}
                              title={hasGuests ? 'Cannot remove the password while guests are in the room' : 'Remove password'}
                              className="px-2.5 py-1.5 rounded-lg font-mono text-[11px] border border-border text-muted hover:border-danger/40 hover:text-danger transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                            >
                              Unset
                            </button>
                          </div>
                        )}
                        {passwordLockNotice && (
                          <p className="mt-2 font-mono text-[10px] text-danger/80">{passwordLockNotice}</p>
                        )}
                      </>
                    )
                  })()}
                </div>

                <div className="px-5 py-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-muted uppercase tracking-wide">Participants</span>
                    <span className="font-mono text-xs text-accent">{host.onlineCount + 1}</span>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-accent/5 border border-accent/20">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center shrink-0">
                          <Crown className="w-3 h-3 text-accent" />
                        </div>
                        {editingName ? (
                          <input
                            type="text"
                            value={nameInput}
                            onChange={e => setNameInput(e.target.value)}
                            onBlur={() => {
                              if (nameInput.trim() && nameInput.trim() !== host.myName) {
                                host.changeNickname(nameInput.trim())
                              }
                              setEditingName(false)
                            }}
                            onKeyDown={e => {
                              if (e.key === 'Enter') {
                                if (nameInput.trim() && nameInput.trim() !== host.myName) {
                                  host.changeNickname(nameInput.trim())
                                }
                                setEditingName(false)
                              } else if (e.key === 'Escape') {
                                setNameInput(host.myName)
                                setEditingName(false)
                              }
                            }}
                            className="flex-1 min-w-0 bg-bg border border-accent/30 rounded px-2 py-0.5 font-mono text-sm text-text focus:outline-none focus:border-accent"
                            autoFocus
                          />
                        ) : (
                          <>
                            <span className="font-mono text-sm text-text truncate">{host.myName}</span>
                            <span className="font-mono text-[10px] text-muted shrink-0">(You)</span>
                          </>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {!editingName && (
                          <button
                            onClick={() => { setNameInput(host.myName); setEditingName(true) }}
                            data-testid="collab-edit-name"
                            className="p-1 rounded hover:bg-accent/10 text-muted hover:text-accent transition-colors"
                            title="Edit nickname"
                          >
                            <Pencil className="w-3 h-3" />
                          </button>
                        )}
                        <div className="flex items-center gap-1 text-accent">
                          <Wifi className="w-3 h-3" />
                          <span className="font-mono text-[10px]">Host</span>
                        </div>
                      </div>
                    </div>
                    {host.participants.map(p => (
                      <div key={p.peerId} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-2/50 border border-border">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-surface flex items-center justify-center">
                            <Users className="w-3 h-3 text-muted" />
                          </div>
                          <span className="font-mono text-sm text-text">{p.name}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="flex items-center gap-1 text-accent">
                            <Wifi className="w-3 h-3" />
                            <span className="font-mono text-[10px]">P2P</span>
                          </div>
                          <button
                            onClick={() => host.kickUser(p.peerId)}
                            data-testid={`collab-kick-${p.peerId}`}
                            className="p-1 rounded hover:bg-danger/10 text-muted hover:text-danger transition-colors"
                            title="Remove from room"
                          >
                            <UserMinus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {host.participants.length === 0 && (
                      <p className="text-center py-4 font-mono text-xs text-muted">
                        Waiting for others to join...
                      </p>
                    )}
                  </div>
                </div>

                <VerifyConnectionsPanel entries={fingerprintEntries} />

                <div className="px-5 py-3 border-t border-border">
                  <button
                    onClick={host.closeRoom}
                    data-testid="collab-close-room"
                    className="inline-flex items-center gap-2 px-4 py-2 rounded-xl font-mono text-xs bg-danger/10 border border-danger/20 text-danger hover:bg-danger/20 hover:border-danger/30 transition-colors"
                  >
                    <DoorOpen className="w-3.5 h-3.5" />
                    Close Room
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {isConnected && (
          <div className="glow-card overflow-hidden animate-fade-in-up">
            <button
              onClick={() => setFilesExpanded(o => !o)}
              aria-expanded={filesExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-2">
                <Download className="w-4 h-4 text-accent" />
                <span className="font-mono text-sm text-text-bright font-bold">{host.sharedFiles.length}</span>
                <span className="text-xs text-muted">
                  file{host.sharedFiles.length !== 1 ? 's' : ''} &middot; {formatBytes(host.sharedFiles.reduce((s, f) => s + f.size, 0))}
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
                      Drop files here or click to upload
                    </p>
                  </button>
                </div>

                <UploadsSummary uploads={host.uploads} />

                {host.sharedFiles.length > 0 && (
                  <div className="px-4 pb-4 border-t border-border pt-4">
                    <ComponentErrorBoundary name="Files">
                      <CollabFileList
                        files={host.sharedFiles}
                        downloads={host.downloads}
                        myPeerId={host.myPeerId}
                        mySharedFiles={mySharedFiles}
                        onDownload={(fileId, ownerId) => host.requestFile(fileId, ownerId)}
                        onRemove={(fileId) => host.removeFile(fileId)}
                        onPause={(fileId) => host.pauseFile?.(fileId)}
                        onResume={(fileId) => host.resumeFile?.(fileId)}
                        onCancel={(fileId) => host.cancelFile?.(fileId)}
                        onDismissError={(fileId) => host.clearDownload?.(fileId)}
                        uploadsByFileId={host.uploads}
                      />
                    </ComponentErrorBoundary>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {isConnected && (
          <>
            <ComponentErrorBoundary name="Call">
              <CallPanelLazy
                callOptions={{
                  peer: host.peer,
                  myPeerId: host.myPeerId,
                  myName: host.myName,
                  isHost: true,
                  hostPeerId: host.myPeerId,
                  participants: host.participantsList,
                  broadcast: host.broadcastCallMessage,
                  sendToPeer: host.sendCallMessage,
                  setMessageHandler: host.setCallMessageHandler,
                }}
                myName={host.myName}
                disabled={isDead}
                connectionStatus={connectionStatus}
              />
            </ComponentErrorBoundary>

            <ComponentErrorBoundary name="Chat">
              <ChatPanel
                messages={host.messages}
                onSend={host.sendMessage}
                onClearMessages={host.clearMessages}
                disabled={isDead}
                nickname={host.myName}
                onNicknameChange={host.changeNickname}
                onlineCount={host.onlineCount + 1}
                typingUsers={host.typingUsers}
                onTyping={host.sendTyping}
                onReaction={host.sendReaction}
              />
            </ComponentErrorBoundary>
          </>
        )}
      </main>

      <AppFooter />
    </div>
  )
}
