import { useParams, Link, useNavigate } from 'react-router-dom'
import { useCollabHost } from '../hooks/useCollabHost'
import { useCollabGuest } from '../hooks/useCollabGuest'
import { useLocalMedia } from '../hooks/useLocalMedia'
import { useCall } from '../hooks/useCall'
import { formatBytes, formatSpeed, formatTime } from '../utils/formatBytes'
import { useElapsedTime, formatElapsed } from '../hooks/useElapsedTime'
import StatusIndicator from '../components/StatusIndicator'
import CollabFileList from '../components/CollabFileList'
import ProgressBar from '../components/ProgressBar'
import ChatPanel from '../components/ChatPanel'
import CallPanel from '../components/CallPanel'
import { ComponentErrorBoundary } from '../components/ErrorBoundary'
import { useState, useRef, useCallback, useMemo, useEffect, type ChangeEvent, type DragEvent } from 'react'
import {
  ArrowLeft,
  AlertCircle,
  Shield,
  Wifi,
  Lock,
  Loader2,
  Users,
  Share2,
  Copy,
  Check,
  Upload,
  Download,
  Crown,
  UserMinus,
  DoorOpen,
  ChevronDown,
  Info,
} from 'lucide-react'

// ── Host View ────────────────────────────────────────────────────────────

function CollabHostView() {
  const host = useCollabHost()
  const localMedia = useLocalMedia()
  const call = useCall({
    peer: host.peer,
    myPeerId: host.myPeerId,
    myName: host.myName,
    isHost: true,
    hostPeerId: host.myPeerId,
    participants: host.participantsList,
    broadcast: host.broadcastCallMessage,
    sendToPeer: host.sendCallMessage,
    setMessageHandler: host.setCallMessageHandler,
    localMedia,
  })

  const [copied, setCopied] = useState(false)
  const [passwordInput, setPasswordInput] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [roomExpanded, setRoomExpanded] = useState(true)
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
    if (passwordInput.trim()) {
      host.setPassword(passwordInput.trim())
      setShowPassword(true)
    }
  }, [passwordInput, host])

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

  // Create a Set of own file IDs for quick lookup
  const mySharedFiles = useMemo(() => {
    const set = new Set<string>()
    for (const f of host.sharedFiles) {
      if (f.owner === host.myPeerId) set.add(f.id)
    }
    return set
  }, [host.sharedFiles, host.myPeerId])

  // Check if any download is in progress
  const hasPending = Object.keys(host.pendingFiles).length > 0
  const elapsed = useElapsedTime(hasPending)

  const isWaiting = host.status === 'waiting'
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
        {/* Initializing */}
        {host.status === 'initializing' && (
          <div className="text-center py-16 animate-fade-in-up">
            <Loader2 className="w-8 h-8 animate-spin text-accent mx-auto mb-4" />
            <p className="font-mono text-sm text-text">Creating room...</p>
          </div>
        )}

        {/* Error */}
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

        {/* Nickname Bar */}
        {isConnected && (
          <div className="glow-card px-4 py-3 animate-fade-in-up">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Users className="w-4 h-4 text-accent shrink-0" />
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
                    className="flex-1 min-w-0 bg-bg border border-accent/30 rounded-lg px-2 py-1 font-mono text-sm text-text focus:outline-none focus:border-accent"
                    autoFocus
                  />
                ) : (
                  <button
                    onClick={() => { setNameInput(host.myName); setEditingName(true) }}
                    className="flex items-center gap-1.5 font-mono text-sm text-text hover:text-accent transition-colors truncate"
                  >
                    <span className="truncate">{host.myName}</span>
                    <span className="text-[10px] text-muted">(click to edit)</span>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                  <Crown className="w-3 h-3 text-accent" />
                  <span className="font-mono text-[10px] text-accent">Host</span>
                </div>
                <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                  <Users className="w-3 h-3 text-accent" />
                  <span className="font-mono text-[10px] text-accent">{host.onlineCount + 1}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Room Active - Collapsible Card */}
        {isConnected && (
          <div className="glow-card overflow-hidden animate-fade-in-up">
            {/* Collapsible Header */}
            <button
              onClick={() => setRoomExpanded(o => !o)}
              aria-expanded={roomExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                <span className="font-mono text-sm text-accent font-medium">Room Active</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Shield className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">E2E</span>
                  </div>
                </div>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${roomExpanded ? 'rotate-180' : ''}`} />
            </button>

            {/* Collapsible Body */}
            <div className={`grid transition-all duration-400 ease-in-out ${roomExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                {/* Share Link */}
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
                  </div>

                  {/* Password (optional) */}
                  {!showPassword && (
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        type="password"
                        placeholder="Set password (optional)"
                        value={passwordInput}
                        onChange={e => setPasswordInput(e.target.value)}
                        className="flex-1 bg-bg border border-border rounded-lg px-3 py-2 font-mono text-xs text-text placeholder:text-muted/40 focus:outline-none focus:border-accent/50"
                      />
                      <button
                        onClick={handlePasswordSet}
                        disabled={!passwordInput.trim()}
                        className="px-3 py-2 rounded-lg font-mono text-xs border border-border text-muted hover:border-accent/40 hover:text-accent transition-colors disabled:opacity-40"
                      >
                        <Lock className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {showPassword && (
                    <div className="mt-3 flex items-center gap-2 text-accent">
                      <Lock className="w-3.5 h-3.5" />
                      <span className="font-mono text-xs">Password protected</span>
                    </div>
                  )}
                </div>

                {/* Participants */}
                <div className="px-5 py-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-muted uppercase tracking-wide">Participants</span>
                    <span className="font-mono text-xs text-accent">{host.onlineCount + 1}</span>
                  </div>
                  <div className="space-y-2">
                    {/* Host (You) */}
                    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-accent/5 border border-accent/20">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                          <Crown className="w-3 h-3 text-accent" />
                        </div>
                        <span className="font-mono text-sm text-text">{host.myName}</span>
                        <span className="font-mono text-[10px] text-muted">(You)</span>
                      </div>
                      <div className="flex items-center gap-1 text-accent">
                        <Wifi className="w-3 h-3" />
                        <span className="font-mono text-[10px]">Host</span>
                      </div>
                    </div>
                    {/* Guests */}
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

                {/* Close Room */}
                <div className="px-5 py-3 border-t border-border">
                  <button
                    onClick={host.closeRoom}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg font-mono text-xs text-danger hover:bg-danger/10 transition-colors"
                  >
                    <DoorOpen className="w-3.5 h-3.5" />
                    Close Room
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Shared Files - Collapsible */}
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
                {/* Drop Zone */}
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

                {/* File List */}
                {host.sharedFiles.length > 0 && (
                  <div className="px-4 pb-4 border-t border-border pt-4">
                    <ComponentErrorBoundary name="Files">
                      <CollabFileList
                        files={host.sharedFiles}
                        downloads={host.downloads}
                        myPeerId={host.myPeerId}
                        mySharedFiles={mySharedFiles}
                        myName={host.myName}
                        onDownload={(fileId, ownerId) => host.requestFile(fileId, ownerId)}
                        onRemove={(fileId) => host.removeFile(fileId)}
                        onPause={(fileId) => host.pauseFile?.(fileId)}
                        onResume={(fileId) => host.resumeFile?.(fileId)}
                        onCancel={(fileId) => host.cancelFile?.(fileId)}
                      />
                    </ComponentErrorBoundary>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Chat & Call Panels */}
        {isConnected && (
          <>
            <ComponentErrorBoundary name="Call">
              <CallPanel
                call={call}
                myName={host.myName}
                myPeerId={host.myPeerId}
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

      {/* Footer */}
      <footer className="border-t border-border/40 py-6 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <p className="font-mono text-[10px] text-muted">
            E2E encrypted &middot; No server storage &middot; Direct P2P
          </p>
          <div className="flex items-center gap-4 font-mono text-[10px]">
            <Link to="/faq" className="text-muted hover:text-accent transition-colors">FAQ</Link>
            <Link to="/privacy" className="text-muted hover:text-accent transition-colors">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

// ── Guest View ───────────────────────────────────────────────────────────

function CollabGuestView({ roomId }: { roomId: string }) {
  const navigate = useNavigate()
  const guest = useCollabGuest(roomId)
  const localMedia = useLocalMedia()
  const call = useCall({
    peer: guest.peer,
    myPeerId: guest.myPeerId,
    myName: guest.myName,
    isHost: false,
    hostPeerId: guest.hostPeerId,
    participants: guest.participantsList,
    sendToHost: guest.sendCallMessage,
    setMessageHandler: guest.setCallMessageHandler,
    localMedia,
  })

  const [passwordInput, setPasswordInput] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [roomExpanded, setRoomExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const [isDragging, setIsDragging] = useState(false)
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput] = useState(guest.myName)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Check if any download is in progress
  const hasPending = Object.values(guest.downloads).some(d => d.status === 'downloading' || d.status === 'requesting')
  const elapsed = useElapsedTime(hasPending)

  // For download button - filter out my files and completed files
  const downloadableIndices = useMemo(() => 
    guest.sharedFiles
      .map((f, i) => ({ f, i }))
      .filter(({ f, i }) => !guest.mySharedFiles.has(f.id) && !guest.completedFiles[i])
      .map(({ i }) => i),
  [guest.sharedFiles, guest.mySharedFiles, guest.completedFiles])

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

  const handlePasswordSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setPasswordLoading(true)
    guest.submitPassword(passwordInput)
  }, [passwordInput, guest])

  const isPasswordRequired = guest.status === 'password-required'
  const isConnecting = guest.status === 'joining' || guest.status === 'reconnecting'
  const isConnected = guest.status === 'connected'
  const isDead = guest.status === 'closed' || guest.status === 'error' || guest.status === 'kicked'

  // Reset password loading on error or when password is accepted
  useEffect(() => {
    if (!isPasswordRequired || guest.passwordError) setPasswordLoading(false)
  }, [isPasswordRequired, guest.passwordError])

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
              {guest.status === 'reconnecting' ? 'Reconnecting...' : 'Joining room...'}
            </p>
            <p className="text-sm text-muted max-w-sm mx-auto leading-relaxed">
              Establishing a secure peer-to-peer connection.
            </p>
          </div>
        )}

        {/* Password required */}
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
                <input
                  type="password"
                  value={passwordInput}
                  onChange={e => { setPasswordInput(e.target.value); setPasswordLoading(false) }}
                  placeholder="Enter password"
                  disabled={passwordLoading}
                  className="w-full bg-bg border border-border rounded-xl px-4 py-3.5 font-mono text-sm text-text text-center placeholder:text-muted/40 focus:outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/10 transition-all disabled:opacity-40"
                  autoFocus
                />
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

        {/* Error States */}
        {guest.status === 'error' && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-6 ring-4 ring-danger/5">
              <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
            </div>
            <p className="font-mono text-lg text-text font-medium mb-2">Connection Failed</p>
            <p className="text-sm text-muted mb-6">Could not connect to the room. It may no longer exist.</p>
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

        {/* Nickname Bar */}
        {isConnected && (
          <div className="glow-card px-4 py-3 animate-fade-in-up">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <Users className="w-4 h-4 text-accent shrink-0" />
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
                    className="flex-1 min-w-0 bg-bg border border-accent/30 rounded-lg px-2 py-1 font-mono text-sm text-text focus:outline-none focus:border-accent"
                    autoFocus
                  />
                ) : (
                  <button
                    onClick={() => { setNameInput(guest.myName); setEditingName(true) }}
                    className="flex items-center gap-1.5 font-mono text-sm text-text hover:text-accent transition-colors truncate"
                  >
                    <span className="truncate">{guest.myName}</span>
                    <span className="text-[10px] text-muted">(click to edit)</span>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                  <Wifi className="w-3 h-3 text-accent" />
                  <span className="font-mono text-[10px] text-accent">P2P</span>
                </div>
                <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                  <Users className="w-3 h-3 text-accent" />
                  <span className="font-mono text-[10px] text-accent">{guest.onlineCount}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Connected - Room Info */}
        {isConnected && (
          <div className="glow-card overflow-hidden animate-fade-in-up">
            {/* Header */}
            <button
              onClick={() => setRoomExpanded(o => !o)}
              aria-expanded={roomExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <StatusIndicator status="connected" embedded>
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Shield className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">E2E</span>
                  </div>
                </StatusIndicator>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${roomExpanded ? 'rotate-180' : ''}`} />
            </button>

            {/* Body */}
            <div className={`grid transition-all duration-400 ease-in-out ${roomExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                <div className="px-5 py-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-muted uppercase tracking-wide">Participants</span>
                    <span className="font-mono text-xs text-accent">{guest.onlineCount}</span>
                  </div>
                  <div className="space-y-2">
                    {/* Show yourself */}
                    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-accent/5 border border-accent/20">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                          <Users className="w-3 h-3 text-accent" />
                        </div>
                        <span className="font-mono text-sm text-text">{guest.myName}</span>
                        <span className="font-mono text-[10px] text-muted">(You)</span>
                      </div>
                    </div>
                    {/* Other participants */}
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
              </div>
            </div>
          </div>
        )}

        {/* Shared Files */}
        {isConnected && (
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
                  {Object.keys(guest.completedFiles).length > 0 && <> &middot; {Object.keys(guest.completedFiles).length} saved</>}
                </span>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${filesExpanded ? 'rotate-180' : ''}`} />
            </button>

            <div className={`grid transition-all duration-400 ease-in-out ${filesExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                {/* Upload zone for guests too */}
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

                {/* Download info banner */}
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

                {/* File List */}
                <div className="px-4 pb-4 border-t border-border pt-4">
                  <ComponentErrorBoundary name="Files">
                    <CollabFileList
                      files={guest.sharedFiles}
                      downloads={guest.downloads}
                      myPeerId={guest.myPeerId}
                      mySharedFiles={guest.mySharedFiles}
                      myName={guest.myName}
                      onDownload={(fileId, ownerId) => guest.requestFile(fileId, ownerId)}
                      onRemove={(fileId) => guest.removeFile(fileId)}
                      onPause={(fileId) => guest.pauseFile?.(fileId)}
                      onResume={(fileId) => guest.resumeFile?.(fileId)}
                      onCancel={(fileId) => guest.cancelFile?.(fileId)}
                    />
                  </ComponentErrorBoundary>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Chat & Call Panels */}
        {isConnected && (
          <>
            <ComponentErrorBoundary name="Call">
              <CallPanel
                call={call}
                myName={guest.myName}
                myPeerId={guest.myPeerId}
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
          </>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 py-6 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4 text-center sm:text-left">
          <p className="font-mono text-[10px] text-muted">
            E2E encrypted &middot; No server storage &middot; Direct P2P
          </p>
          <div className="flex items-center gap-4 font-mono text-[10px]">
            <Link to="/faq" className="text-muted hover:text-accent transition-colors">FAQ</Link>
            <Link to="/privacy" className="text-muted hover:text-accent transition-colors">Privacy</Link>
          </div>
        </div>
      </footer>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────

export default function CollabPortal() {
  const { roomId } = useParams<{ roomId: string }>()

  // If no roomId, create a new room as host
  if (!roomId) {
    return <CollabHostView />
  }

  // Otherwise join as guest
  return <CollabGuestView roomId={roomId} />
}
