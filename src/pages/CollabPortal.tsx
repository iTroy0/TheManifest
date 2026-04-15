import { useParams, Link, useNavigate } from 'react-router-dom'
import { useCollabHost } from '../hooks/useCollabHost'
import { useCollabGuest } from '../hooks/useCollabGuest'
import { useLocalMedia } from '../hooks/useLocalMedia'
import { useCall } from '../hooks/useCall'
import { formatBytes, formatSpeed } from '../utils/formatBytes'
import StatusIndicator from '../components/StatusIndicator'
import ChatPanel from '../components/ChatPanel'
import CallPanel from '../components/CallPanel'
import { ComponentErrorBoundary } from '../components/ErrorBoundary'
import { useState, useRef, useCallback, type ChangeEvent, type DragEvent } from 'react'
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
  FileIcon,
  Crown,
  UserMinus,
  DoorOpen,
  Plus,
  ChevronDown,
  Image as ImageIcon,
  FileText,
  Archive,
  Film,
  Music,
} from 'lucide-react'

// ── Shared File Item Component ───────────────────────────────────────────

function SharedFileItem({
  file,
  isOwner,
  download,
  onDownload,
}: {
  file: { id: string; name: string; size: number; type: string; ownerName: string }
  isOwner: boolean
  download?: { status: string; progress: number; speed: number }
  onDownload: () => void
}) {
  const getFileIcon = () => {
    if (file.type.startsWith('image/')) return <ImageIcon className="w-4 h-4" />
    if (file.type.startsWith('video/')) return <Film className="w-4 h-4" />
    if (file.type.startsWith('audio/')) return <Music className="w-4 h-4" />
    if (file.type.includes('zip') || file.type.includes('tar') || file.type.includes('rar')) return <Archive className="w-4 h-4" />
    if (file.type.includes('pdf') || file.type.includes('doc') || file.type.includes('text')) return <FileText className="w-4 h-4" />
    return <FileIcon className="w-4 h-4" />
  }

  const isDownloading = download?.status === 'downloading' || download?.status === 'requesting'
  const isComplete = download?.status === 'complete'

  return (
    <div className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2/30 transition-colors">
      <div className="w-8 h-8 rounded-lg bg-surface-2 border border-border flex items-center justify-center text-muted">
        {getFileIcon()}
      </div>
      <div className="flex-1 min-w-0">
        <p className="font-mono text-sm text-text truncate">{file.name}</p>
        <p className="font-mono text-[10px] text-muted">
          {formatBytes(file.size)} {isOwner ? '(You)' : `by ${file.ownerName}`}
        </p>
        {isDownloading && download && (
          <div className="mt-1">
            <div className="h-1 bg-border rounded-full overflow-hidden">
              <div className="h-full bg-accent transition-all duration-300" style={{ width: `${download.progress}%` }} />
            </div>
            {download.speed > 0 && (
              <p className="font-mono text-[9px] text-muted mt-0.5">{formatSpeed(download.speed)}</p>
            )}
          </div>
        )}
      </div>
      {!isOwner && !isComplete && (
        <button
          onClick={onDownload}
          disabled={isDownloading}
          className="p-2 rounded-lg hover:bg-accent/10 text-muted hover:text-accent transition-colors disabled:opacity-40"
          title="Download"
        >
          {isDownloading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Download className="w-4 h-4" />
          )}
        </button>
      )}
      {isComplete && (
        <div className="p-2 text-accent">
          <Check className="w-4 h-4" />
        </div>
      )}
    </div>
  )
}

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
                    <Crown className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">Host</span>
                  </div>
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Shield className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">E2E</span>
                  </div>
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Users className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">{host.onlineCount + 1}</span>
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
                <Share2 className="w-4 h-4 text-accent" />
                <span className="font-mono text-sm text-text font-medium">Shared Files</span>
                <span className="font-mono text-xs text-muted">{host.sharedFiles.length} files</span>
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
                  className={`px-5 py-6 border-t border-border transition-colors ${isDragging ? 'bg-accent/5 border-accent/30' : ''}`}
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
                    className="w-full py-8 border-2 border-dashed border-border rounded-xl hover:border-accent/40 transition-colors group"
                  >
                    <Upload className="w-8 h-8 text-muted group-hover:text-accent mx-auto mb-2 transition-colors" />
                    <p className="font-mono text-sm text-muted group-hover:text-text transition-colors">
                      Drop files here or click to upload
                    </p>
                    <p className="font-mono text-[10px] text-muted/60 mt-1">
                      Files will be shared with all participants
                    </p>
                  </button>
                </div>

                {/* File List */}
                <div className="max-h-[300px] overflow-y-auto scrollbar-thin border-t border-border">
                  {host.sharedFiles.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="font-mono text-xs text-muted">No files shared yet</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {host.sharedFiles.map(file => (
                        <SharedFileItem
                          key={file.id}
                          file={file}
                          isOwner={host.mySharedFiles.has(file.id)}
                          download={host.downloads[file.id]}
                          onDownload={() => {}}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Upload Progress */}
                {host.uploading && (
                  <div className="px-5 py-3 border-t border-border bg-surface-2/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-xs text-text">Uploading...</span>
                      <span className="font-mono text-xs text-accent">{host.uploadProgress}%</span>
                    </div>
                    <div className="h-1 bg-border rounded-full overflow-hidden">
                      <div
                        className="h-full bg-accent transition-all duration-300"
                        style={{ width: `${host.uploadProgress}%` }}
                      />
                    </div>
                    {host.uploadSpeed > 0 && (
                      <p className="font-mono text-[10px] text-muted mt-1">{formatSpeed(host.uploadSpeed)}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Call Panel - same pattern as Portal.tsx */}
        {isConnected && !isDead && (
          <ComponentErrorBoundary name="Call">
            <CallPanel
              call={call}
              myName={host.myName}
              myPeerId={host.myPeerId}
              disabled={isDead}
              connectionStatus={connectionStatus}
            />
          </ComponentErrorBoundary>
        )}

        {/* Chat Panel - same pattern as Portal.tsx */}
        {isConnected && (
          <ComponentErrorBoundary name="Chat">
            <ChatPanel
              messages={host.messages}
              onSend={host.sendMessage}
              onClearMessages={host.clearMessages}
              disabled={isDead}
              nickname={host.myName}
              onNicknameChange={host.setMyName}
              onlineCount={host.onlineCount + 1}
              typingUsers={host.typingUsers}
              onTyping={host.sendTyping}
              onReaction={host.sendReaction}
            />
          </ComponentErrorBoundary>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between flex-wrap gap-2">
          <p className="font-mono text-xs text-muted">No servers. No storage. No tracking.</p>
          <p className="font-mono text-xs text-muted">
            <Link to="/faq" className="text-muted-light hover:text-accent transition-colors">FAQ</Link> &middot; <Link to="/privacy" className="text-muted-light hover:text-accent transition-colors">Privacy</Link> &middot; by <a href="https://github.com/iTroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">iTroy0</a>
          </p>
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
    participants: guest.participants.map(p => ({ peerId: p.peerId, name: p.name })),
    sendToHost: guest.sendCallMessage,
    setMessageHandler: guest.setCallMessageHandler,
    localMedia,
  })

  const [passwordInput, setPasswordInput] = useState('')
  const [passwordLoading, setPasswordLoading] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [roomExpanded, setRoomExpanded] = useState(true)
  const [filesExpanded, setFilesExpanded] = useState(true)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handlePasswordSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    setPasswordLoading(true)
    guest.submitPassword(passwordInput)
  }, [passwordInput, guest])

  // Reset loading state when password result comes back
  const prevPasswordError = useRef(guest.passwordError)
  if (guest.passwordError !== prevPasswordError.current) {
    prevPasswordError.current = guest.passwordError
    if (guest.passwordError) setPasswordLoading(false)
  }

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

  const isConnecting = guest.status === 'joining' || guest.status === 'reconnecting'
  const isConnected = guest.status === 'connected'
  const isDead = guest.status === 'closed' || guest.status === 'error' || guest.status === 'kicked'
  const connectionStatus = guest.status

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
              {guest.status === 'reconnecting' ? 'Reconnecting...' : 'Joining room'}
            </p>
            <p className="text-sm text-muted">Establishing secure connection...</p>
          </div>
        )}

        {/* Password Required */}
        {guest.status === 'password-required' && (
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
                  className="w-full px-5 py-3.5 rounded-xl font-mono text-sm bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-all disabled:opacity-40"
                >
                  {passwordLoading ? <><Loader2 className="w-3.5 h-3.5 animate-spin inline mr-1.5" />Verifying...</> : 'Join Room'}
                </button>
              </form>
            </div>
          </div>
        )}

        {/* Error / Closed / Kicked */}
        {isDead && (
          <div className="text-center py-16 animate-fade-in-up">
            <div className="w-18 h-18 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto mb-6 ring-4 ring-danger/5">
              <AlertCircle className="w-9 h-9 text-danger" strokeWidth={1.5} />
            </div>
            <p className="font-mono text-lg text-text font-medium mb-2">
              {guest.status === 'closed' ? 'Room Closed' : guest.status === 'kicked' ? 'Removed from Room' : 'Connection Error'}
            </p>
            <p className="text-sm text-muted mb-6">
              {guest.status === 'closed'
                ? 'The host closed the room or the connection was lost.'
                : guest.status === 'kicked'
                ? 'You were removed from the room by the host.'
                : 'Could not connect to the room. Check the link and try again.'}
            </p>
            <Link
              to="/"
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted-light hover:border-accent/40 hover:text-accent transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Go Home
            </Link>
          </div>
        )}

        {/* Connected - Collapsible Room Card */}
        {isConnected && (
          <div className="glow-card overflow-hidden animate-fade-in-up">
            <button
              onClick={() => setRoomExpanded(o => !o)}
              aria-expanded={roomExpanded}
              className="w-full flex items-center justify-between px-5 py-4 text-left group"
            >
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-accent animate-pulse" />
                <span className="font-mono text-sm text-accent font-medium">Connected</span>
                <div className="flex items-center gap-2">
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Wifi className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">P2P</span>
                  </div>
                  {guest.rtt !== null && (
                    <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border ${guest.rtt < 100 ? 'bg-accent/5 border-accent/20' : guest.rtt < 300 ? 'bg-yellow-400/5 border-yellow-400/20' : 'bg-danger/5 border-danger/20'}`}>
                      <span className={`font-mono text-[10px] ${guest.rtt < 100 ? 'text-accent' : guest.rtt < 300 ? 'text-yellow-400' : 'text-danger'}`}>{guest.rtt}ms</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Shield className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">E2E</span>
                  </div>
                  <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5">
                    <Users className="w-3 h-3 text-accent" />
                    <span className="font-mono text-[10px] text-accent">{guest.onlineCount}</span>
                  </div>
                </div>
              </div>
              <ChevronDown className={`w-4 h-4 text-muted group-hover:text-accent transition-all duration-300 ${roomExpanded ? 'rotate-180' : ''}`} />
            </button>

            <div className={`grid transition-all duration-400 ease-in-out ${roomExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
              <div className="overflow-hidden">
                {/* Participants */}
                <div className="px-5 py-4 border-t border-border">
                  <div className="flex items-center justify-between mb-3">
                    <span className="font-mono text-xs text-muted uppercase tracking-wide">Participants</span>
                    <span className="font-mono text-xs text-accent">{guest.onlineCount}</span>
                  </div>
                  <div className="space-y-2">
                    {/* You */}
                    <div className="flex items-center justify-between py-2 px-3 rounded-lg bg-accent/5 border border-accent/20">
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-accent/20 flex items-center justify-center">
                          <Users className="w-3 h-3 text-accent" />
                        </div>
                        <span className="font-mono text-sm text-text">{guest.myName}</span>
                        <span className="font-mono text-[10px] text-muted">(You)</span>
                      </div>
                    </div>
                    {/* Others */}
                    {guest.participants.map(p => (
                      <div key={p.peerId} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-2/50 border border-border">
                        <div className="flex items-center gap-2">
                          <div className="w-6 h-6 rounded-full bg-surface flex items-center justify-center">
                            {p.isHost ? <Crown className="w-3 h-3 text-accent" /> : <Users className="w-3 h-3 text-muted" />}
                          </div>
                          <span className="font-mono text-sm text-text">{p.name}</span>
                          {p.isHost && <span className="font-mono text-[10px] text-accent">(Host)</span>}
                        </div>
                        <div className="flex items-center gap-1 text-accent">
                          <Wifi className="w-3 h-3" />
                          <span className="font-mono text-[10px]">{p.directConnection ? 'P2P' : 'Relay'}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Leave Room */}
                <div className="px-5 py-3 border-t border-border">
                  <button
                    onClick={() => { guest.leave(); navigate('/') }}
                    className="flex items-center gap-2 px-3 py-2 rounded-lg font-mono text-xs text-danger hover:bg-danger/10 transition-colors"
                  >
                    <DoorOpen className="w-3.5 h-3.5" />
                    Leave Room
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
                <Share2 className="w-4 h-4 text-accent" />
                <span className="font-mono text-sm text-text font-medium">Shared Files</span>
                <span className="font-mono text-xs text-muted">{guest.sharedFiles.length} files</span>
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
                  className={`px-5 py-6 border-t border-border transition-colors ${isDragging ? 'bg-accent/5' : ''}`}
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
                    <Plus className="w-6 h-6 text-muted group-hover:text-accent mx-auto mb-1 transition-colors" />
                    <p className="font-mono text-xs text-muted group-hover:text-text transition-colors">
                      Share files with the room
                    </p>
                  </button>
                </div>

                {/* File List */}
                <div className="max-h-[300px] overflow-y-auto scrollbar-thin border-t border-border">
                  {guest.sharedFiles.length === 0 ? (
                    <div className="py-8 text-center">
                      <p className="font-mono text-xs text-muted">No files shared yet</p>
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {guest.sharedFiles.map(file => (
                        <SharedFileItem
                          key={file.id}
                          file={file}
                          isOwner={guest.mySharedFiles.has(file.id)}
                          download={guest.downloads[file.id]}
                          onDownload={() => guest.requestFile(file.id, file.owner)}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Upload Progress */}
                {guest.uploading && (
                  <div className="px-5 py-3 border-t border-border bg-surface-2/50">
                    <div className="flex items-center justify-between mb-2">
                      <span className="font-mono text-xs text-text">Uploading...</span>
                      <span className="font-mono text-xs text-accent">{guest.uploadProgress}%</span>
                    </div>
                    <div className="h-1 bg-border rounded-full overflow-hidden">
                      <div className="h-full bg-accent transition-all duration-300" style={{ width: `${guest.uploadProgress}%` }} />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Call Panel - same pattern as Portal.tsx */}
        {isConnected && !isDead && (
          <ComponentErrorBoundary name="Call">
            <CallPanel
              call={call}
              myName={guest.myName}
              myPeerId={guest.myPeerId}
              disabled={isDead}
              connectionStatus={connectionStatus}
            />
          </ComponentErrorBoundary>
        )}

        {/* Chat Panel - same pattern as Portal.tsx */}
        {isConnected && (
          <ComponentErrorBoundary name="Chat">
            <ChatPanel
              messages={guest.messages}
              onSend={guest.sendMessage}
              onClearMessages={guest.clearMessages}
              disabled={isDead}
              nickname={guest.myName}
              onNicknameChange={guest.setMyName}
              onlineCount={guest.onlineCount}
              typingUsers={guest.typingUsers}
              onTyping={guest.sendTyping}
              onReaction={guest.sendReaction}
            />
          </ComponentErrorBoundary>
        )}
      </main>

      {/* Footer */}
      <footer className="border-t border-border/40 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 py-5 flex items-center justify-between flex-wrap gap-2">
          <p className="font-mono text-xs text-muted">No servers. No storage. No tracking.</p>
          <p className="font-mono text-xs text-muted">
            <Link to="/faq" className="text-muted-light hover:text-accent transition-colors">FAQ</Link> &middot; <Link to="/privacy" className="text-muted-light hover:text-accent transition-colors">Privacy</Link> &middot; by <a href="https://github.com/iTroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">iTroy0</a>
          </p>
        </div>
      </footer>
    </div>
  )
}

// ── Main Component ───────────────────────────────────────────────────────

export default function CollabPortal() {
  const { roomId } = useParams<{ roomId: string }>()

  // If no roomId, we're creating a new room (host)
  if (!roomId) {
    return <CollabHostView />
  }

  // Otherwise, we're joining an existing room (guest)
  return <CollabGuestView roomId={roomId} />
}
