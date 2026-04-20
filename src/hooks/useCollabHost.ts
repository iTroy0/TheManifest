import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, uint8ToBase64, base64ToUint8, timingSafeEqual } from '../utils/crypto'
import { finalizeKeyExchange } from '../net/keyExchange'
import { createSession, type Session } from '../net/session'
import { STUN_ONLY } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { buildChunkPacket, parseChunkPacket, waitForBufferDrain, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { createFileStream } from '../utils/streamWriter'
import { asBlobPart } from '../net/peerjsInternal'
import { generateThumbnailAsync, generateVideoThumbnail, generateTextPreview } from '../utils/thumbnailWorker'
import { generateNickname } from '../utils/nickname'
import { ChatMessage } from '../types'
import {
  roomReducer,
  participantsReducer,
  filesReducer,
  transferReducer,
  initialRoomState,
  initialParticipantsState,
  initialFilesState,
  initialTransferState,
  CollabParticipant,
  SharedFile,
  FileDownload,
  validateSharedFile,
  sanitizeSharedFile,
} from './state/collabState'
import {
  FALLBACK_MAX_BYTES,
  FALLBACK_TOO_LARGE_MSG,
  MAX_PASSWORD_ATTEMPTS,
  DOWNLOAD_REQUEST_TIMEOUT_MS,
  MAX_CONNECTIONS,
  TIMEOUT_MS,
  CONTROL_WINDOW_MS,
  FILE_SHARE_WINDOW_MS,
} from '../net/config'
import type { CollabInnerMsg, CollabUnencryptedMsg } from '../net/protocol'
import { log } from '../utils/logger'
import { sendFile, createFileReceiver, createCollabWire, IntegrityError, type FileReceiver, type CollabWire } from '../net/transferEngine'

// ── Types ────────────────────────────────────────────────────────────────

// Host-side per-guest accounting that doesn't belong on Session. Every
// other per-guest field (handshake, liveness, lanes, inProgressImage,
// passwordVerified/Attempts, activeTransfers, requestedFileIds,
// recentFileShares, nickname) lives on the Session.
interface GuestMeta {
  chunker?: InstanceType<typeof AdaptiveChunker>
  progressThrottler?: InstanceType<typeof ProgressThrottler>
  wire: CollabWire                // per-guest packet-index allocator / seed store
  uploadReceiver: FileReceiver    // inbound guest-upload ingestion
}

interface GuestEntry {
  session: Session
  meta: GuestMeta
}

// M-n — per-guest sliding-window rate limit on inbound control messages
// (request/pause/resume/cancel/file-removed/signal). Separate from M19's
// collab-file-shared broadcast limiter which already caps its own op.
const CONTROL_MAX = 20
// M-n — cap per-session requestedFileIds so a looping request→cancel sequence
// can't balloon the set and amplify forwards against the owner.
const REQUESTED_FILE_IDS_CAP = 64

function checkControlRate(session: Session): boolean {
  const now = Date.now()
  session.recentControlOps = session.recentControlOps.filter(t => now - t < CONTROL_WINDOW_MS)
  if (session.recentControlOps.length >= CONTROL_MAX) return false
  session.recentControlOps.push(now)
  return true
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useCollabHost() {
  const [room, dispatchRoom] = useReducer(roomReducer, { ...initialRoomState, isHost: true, myName: generateNickname() })
  const [participants, dispatchParticipants] = useReducer(participantsReducer, initialParticipantsState)
  const [files, dispatchFiles] = useReducer(filesReducer, initialFilesState)
  const [transfer, dispatchTransfer] = useReducer(transferReducer, initialTransferState)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [rtt, setRtt] = useState<number | null>(null)
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  // H3 — sessionKey as state so the init effect re-runs on reset().
  const [sessionKey, setSessionKey] = useState<number>(0)

  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastMsgTime = useRef<number>(0)
  const peerRef = useRef<InstanceType<typeof Peer> | null>(null)
  // M10 — keyed by peerId so reconnects cleanly overwrite the old entry.
  const connectionsRef = useRef<Map<string, GuestEntry>>(new Map())
  const passwordRef = useRef<string | null>(null)
  const myFilesRef = useRef<Map<string, File>>(new Map()) // fileId -> File object
  const imageBlobUrlsRef = useRef<string[]>([])
  const filesRef = useRef(files) // Keep fresh reference to files state
  filesRef.current = files

  // H4 — keep latest name readable inside long-lived closures.
  const myNameRef = useRef(room.myName)
  useEffect(() => { myNameRef.current = room.myName }, [room.myName])

  // M2 — timers for download request timeouts, keyed by fileId.
  const downloadTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // For calls
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const [participantsList, setParticipantsList] = useState<Array<{ peerId: string; name: string }>>([])
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  // Returns true if the password was applied, false if rejected because
  // guests are already connected (see CollabPortal UX: changing the
  // password mid-session is blocked to avoid confusing admitted guests).
  const setPassword = useCallback((pwd: string): boolean => {
    const next = pwd || null
    if (connectionsRef.current.size > 0 && (passwordRef.current || next)) {
      return false
    }
    passwordRef.current = next
    dispatchRoom({ type: 'SET', payload: { passwordRequired: !!next, password: next } })
    return true
  }, [])

  const refreshParticipantsList = useCallback((): void => {
    const list: Array<{ peerId: string; name: string }> = []
    connectionsRef.current.forEach(entry => {
      const { session } = entry
      if (session.passwordVerified || !passwordRef.current) {
        list.push({ peerId: session.peerId, name: session.nickname || 'Anon' })
      }
    })
    setParticipantsList(list)

    // Update participants state (include fingerprint for C1 verification panel).
    const collabParticipants: CollabParticipant[] = Array.from(connectionsRef.current.values())
      .filter(e => e.session.passwordVerified || !passwordRef.current)
      .map(e => ({
        peerId: e.session.peerId,
        name: e.session.nickname || 'Anon',
        isHost: false,
        connectionStatus: 'connected',
        directConnection: true,
        fingerprint: e.session.fingerprint ?? undefined,
      }))
    dispatchParticipants({ type: 'SET_PARTICIPANTS', payload: collabParticipants })
  }, [])

  // Broadcast a message to all connected guests
  const broadcast = useCallback((msg: Record<string, unknown>, exceptPeerId?: string): void => {
    connectionsRef.current.forEach(entry => {
      const { session } = entry
      if (exceptPeerId && session.peerId === exceptPeerId) return
      if (!session.passwordVerified && passwordRef.current) return
      try { session.send(msg) } catch (e) { log.warn('useCollabHost.broadcast', e) }
    })
  }, [])

  // Send to specific peer
  const sendToPeer = useCallback((peerId: string, msg: Record<string, unknown>): void => {
    const entry = connectionsRef.current.get(peerId)
    if (entry) {
      try { entry.session.send(msg) } catch (e) { log.warn('useCollabHost.sendToPeer', e) }
    }
  }, [])

  // Relay signaling between guests for mesh P2P
  const relaySignal = useCallback((fromPeerId: string, targetPeerId: string, signal: unknown): void => {
    const target = connectionsRef.current.get(targetPeerId)
    if (target) {
      try {
        target.session.send({ type: 'collab-signal', from: fromPeerId, signal } satisfies CollabUnencryptedMsg)
      } catch (e) { log.warn('useCollabHost.relaySignal', e) }
    }
  }, [])

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((peerId: string, msg: Record<string, unknown>): void => {
    sendToPeer(peerId, msg)
  }, [sendToPeer])

  const broadcastCallMessage = useCallback((msg: Record<string, unknown>, exceptPeerId?: string): void => {
    broadcast(msg, exceptPeerId)
  }, [broadcast])

  // Kick a user from the room (H13 — remove from list synchronously).
  const kickUser = useCallback((peerId: string): void => {
    const entry = connectionsRef.current.get(peerId)
    if (!entry) return
    // Remove from map immediately so it disappears from participant lists
    // during the 100ms grace period between notifying the peer and closing.
    connectionsRef.current.delete(peerId)
    refreshParticipantsList()
    try { entry.session.send({ type: 'kicked' } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.kickUser.send', e) }
    setTimeout(() => {
      entry.session.close('kicked')
      try { entry.session.conn.close() } catch (e) { log.warn('useCollabHost.kickUser.close', e) }
    }, 100)
  }, [refreshParticipantsList])

  // Remove a shared file (only owner can remove)
  const removeFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return

    // Only owner can remove their own files
    if (file.owner !== room.myPeerId) return

    // Remove from local state
    myFilesRef.current.delete(fileId)
    dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })

    // Broadcast removal to all guests (include `from` so peers can verify origin).
    for (const entry of connectionsRef.current.values()) {
      const { session } = entry
      if (!session.encryptKey || (!session.passwordVerified && passwordRef.current)) continue
      try {
        const encrypted = await encryptJSON(session.encryptKey, { type: 'collab-file-removed', fileId, from: room.myPeerId || '' } satisfies CollabInnerMsg)
        session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
      } catch (e) { log.warn('useCollabHost.removeFile.broadcast', e) }
    }
  }, [room.myPeerId])

  // M2 — schedule a 30s timeout, fire error if the request never transitions
  // into a live download.
  const scheduleDownloadTimeout = useCallback((fileId: string): void => {
    const existing = downloadTimeoutsRef.current.get(fileId)
    if (existing) clearTimeout(existing)
    const t = setTimeout(() => {
      downloadTimeoutsRef.current.delete(fileId)
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'error', error: 'request timed out' } })
    }, DOWNLOAD_REQUEST_TIMEOUT_MS)
    downloadTimeoutsRef.current.set(fileId, t)
  }, [])

  const clearDownloadTimeout = useCallback((fileId: string): void => {
    const existing = downloadTimeoutsRef.current.get(fileId)
    if (existing) {
      clearTimeout(existing)
      downloadTimeoutsRef.current.delete(fileId)
    }
  }, [])

  // Request a file from a guest
  const requestFile = useCallback(async (fileId: string, ownerId: string): Promise<void> => {
    const ownerEntry = connectionsRef.current.get(ownerId)
    if (!ownerEntry?.session.encryptKey) return

    // If another download from this same guest is still in flight, the
    // guest's uploadQueue will serve us sequentially — surface that as
    // 'queued' so the UI doesn't look stuck on "Requesting".
    const snap = filesRef.current
    const ownerBusy = Object.entries(snap.downloads).some(([fid, dl]) => {
      if (fid === fileId) return false
      const f = snap.sharedFiles.find(x => x.id === fid)
      if (!f || f.owner !== ownerId) return false
      return dl.status === 'requesting' || dl.status === 'downloading' || dl.status === 'queued'
    })
    const initialStatus: FileDownload['status'] = ownerBusy ? 'queued' : 'requesting'
    const download: FileDownload = { status: initialStatus, progress: 0, speed: 0 }
    // Mirror into filesRef immediately so a synchronous burst of
    // requestFile calls from "Download all" sees prior entries — React
    // doesn't re-render between for-loop iterations, so snap.downloads
    // would otherwise stay empty across the whole batch.
    filesRef.current = {
      ...filesRef.current,
      downloads: { ...filesRef.current.downloads, [fileId]: download },
    }
    dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download })
    scheduleDownloadTimeout(fileId)

    try {
      const encrypted = await encryptJSON(ownerEntry.session.encryptKey, { type: 'collab-request-file', fileId } satisfies CollabInnerMsg)
      ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabHost.requestFile', e) }
  }, [scheduleDownloadTimeout])

  // Pause file download
  const pauseFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return

    const ownerEntry = connectionsRef.current.get(file.owner)
    if (!ownerEntry?.session.encryptKey) return

    try {
      const encrypted = await encryptJSON(ownerEntry.session.encryptKey, { type: 'collab-pause-file', fileId } satisfies CollabInnerMsg)
      ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'paused' } })
    } catch (e) { log.warn('useCollabHost.pauseFile', e) }
  }, [])

  // Resume file download
  const resumeFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return

    const ownerEntry = connectionsRef.current.get(file.owner)
    if (!ownerEntry?.session.encryptKey) return

    try {
      const encrypted = await encryptJSON(ownerEntry.session.encryptKey, { type: 'collab-resume-file', fileId } satisfies CollabInnerMsg)
      ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'downloading' } })
    } catch (e) { log.warn('useCollabHost.resumeFile', e) }
  }, [])

  // Cancel file download
  const cancelFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return

    const ownerEntry = connectionsRef.current.get(file.owner)
    if (ownerEntry?.session.encryptKey) {
      try {
        const encrypted = await encryptJSON(ownerEntry.session.encryptKey, { type: 'collab-cancel-file', fileId } satisfies CollabInnerMsg)
        ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
      } catch (e) { log.warn('useCollabHost.cancelFile.send', e) }
    }

    clearDownloadTimeout(fileId)
    // Abort the uploadReceiver on the guest who owns the file, if in progress.
    if (ownerEntry) {
      try { await ownerEntry.meta.uploadReceiver.abort(fileId, 'cancelled') } catch (e) { log.warn('useCollabHost.cancelFile.receiverAbort', e) }
    }

    // Clear the host's local download entry so the UI chip disappears.
    // useCollabGuest.cancelFile does the analogous dispatch; the host path
    // was missing it, leaving the entry visible after the network-level
    // cancel succeeded.
    dispatchFiles({ type: 'REMOVE_DOWNLOAD', fileId })
  }, [clearDownloadTimeout])

  // Clear a download entry (e.g. dismiss an error chip)
  const clearDownload = useCallback((fileId: string): void => {
    dispatchFiles({ type: 'REMOVE_DOWNLOAD', fileId })
  }, [])

  // Close the room
  const closeRoom = useCallback((): void => {
    broadcast({ type: 'room-closed' } satisfies CollabUnencryptedMsg)
    setTimeout(() => {
      connectionsRef.current.forEach(entry => {
        entry.session.close('session-abort')
        try { entry.session.conn.close() } catch (e) { log.warn('useCollabHost.closeRoom.closeConn', e) }
      })
      if (peerRef.current) {
        peerRef.current.destroy()
      }
      dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
    }, 200)
  }, [broadcast])

  // Share a file to all guests
  const shareFile = useCallback(async (file: File): Promise<void> => {
    // M6 — crypto.randomUUID for fileIds.
    const fileId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    myFilesRef.current.set(fileId, file)

    // Generate thumbnail/preview using thumbnailWorker (same as Portal)
    let thumbnail: string | undefined
    let textPreview: string | undefined

    if (file.type.startsWith('image/') && file.size < 10 * 1024 * 1024) {
      try {
        thumbnail = await generateThumbnailAsync(file, 80)
      } catch (e) { log.warn('useCollabHost.shareFile.imageThumb', e) }
    } else if (file.type.startsWith('video/') && file.size < 50 * 1024 * 1024) {
      try {
        thumbnail = await generateVideoThumbnail(file, 80)
      } catch (e) { log.warn('useCollabHost.shareFile.videoThumb', e) }
    } else if (file.type === 'text/plain' || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
      try {
        textPreview = (await generateTextPreview(file)) ?? undefined
      } catch (e) { log.warn('useCollabHost.shareFile.textPreview', e) }
    }

    const sharedFile: SharedFile = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      owner: room.myPeerId || '',
      ownerName: room.myName,
      thumbnail,
      textPreview,
      addedAt: Date.now(),
    }

    dispatchFiles({ type: 'ADD_SHARED_FILE', payload: sharedFile })
    dispatchFiles({ type: 'ADD_MY_SHARED_FILE', fileId })

    // Broadcast to all guests
    const msg = {
      type: 'collab-file-shared',
      file: sharedFile,
    } satisfies CollabInnerMsg

    for (const entry of connectionsRef.current.values()) {
      const { session } = entry
      if (!session.encryptKey || (!session.passwordVerified && passwordRef.current)) continue
      try {
        const encrypted = await encryptJSON(session.encryptKey, msg)
        session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
      } catch (e) { log.warn('useCollabHost.shareFile.broadcast', e) }
    }
  }, [room.myPeerId, room.myName])

  // Send host-owned file to a specific requesting guest via transferEngine.
  // Pause/resume/cancel route through session.activeTransfers (handled inside sendFile).
  const sendFileToRequester = useCallback(async (entry: GuestEntry, fileId: string): Promise<void> => {
    const { session, meta } = entry
    const file = myFilesRef.current.get(fileId)
    if (!file || !session.encryptKey) return

    if (!meta.chunker) meta.chunker = new AdaptiveChunker()
    if (!meta.progressThrottler) meta.progressThrottler = new ProgressThrottler(80)

    const startTime = Date.now()

    const runTransfer = async (): Promise<void> => {
      dispatchTransfer({ type: 'START_UPLOAD', fileId, fileName: file.name })
      const result = await sendFile(session, file, meta.wire, {
        fileId,
        chunker: meta.chunker,
        onProgress: (bytesSent, totalBytes) => {
          // Force a dispatch on the final chunk (bytesSent === totalBytes) so
          // the UI reaches 100% before END_UPLOAD clears the entry. Otherwise
          // a throttled-out final update leaves the progress bar stalled at
          // the last sampled value until the reducer removes the entry.
          const done = bytesSent >= totalBytes && totalBytes > 0
          if (done || meta.progressThrottler!.shouldUpdate()) {
            const elapsed = (Date.now() - startTime) / 1000
            const speed = elapsed > 0.5 ? bytesSent / elapsed : 0
            const progress = totalBytes > 0 ? Math.min(100, Math.round((bytesSent / totalBytes) * 100)) : 0
            dispatchTransfer({ type: 'UPDATE_UPLOAD', fileId, progress, speed })
          }
        },
      })
      void result
      dispatchTransfer({ type: 'END_UPLOAD', fileId })
    }

    // Serialize concurrent transfers on this guest's conn. Without this,
    // peerjs's binary framing interleaves packets from parallel loops and
    // the downloader sees AES-GCM auth-tag failures — the trigger for the
    // "Download all" decrypt warns.
    const next = session.uploadQueue
      .then(runTransfer)
      .catch(e => log.warn('useCollabHost.sendFileToRequester.queue', e))
    session.uploadQueue = next
    await next
  }, [])

  // Initialize peer connection
  useEffect(() => {
    if (!window.crypto?.subtle) {
      dispatchRoom({ type: 'SET_STATUS', payload: 'error' })
      return
    }

    let destroyed = false
    const peer = new Peer(STUN_ONLY)
    peerRef.current = peer

    peer.on('open', (id: string) => {
      if (destroyed) return
      dispatchRoom({ type: 'SET', payload: { myPeerId: id, roomId: id, status: 'waiting' } })
      setPeerInstance(peer)
    })

    peer.on('connection', (conn: DataConnection) => {
      if (destroyed) return

      if (connectionsRef.current.size >= MAX_CONNECTIONS) {
        conn.close()
        return
      }

      // M10 — key by peerId. If a reconnect arrives for the same peerId,
      // replace the old entry (closing its conn first).
      const existing = connectionsRef.current.get(conn.peer)
      if (existing) {
        existing.session.close('session-abort')
        try { existing.session.conn.close() } catch (e) { log.warn('useCollabHost.connection.closeExisting', e) }
        connectionsRef.current.delete(conn.peer)
      }

      const session = createSession({
        conn,
        role: 'collab-host',
        passwordRequired: !!passwordRef.current,
      })
      session.setNickname('Anon')
      // Inbound peer connection — we didn't initiate, but the transition
      // table expects connect-start before conn-open.
      session.dispatch({ type: 'connect-start' })
      const guestWire = createCollabWire()
      const entry: GuestEntry = {
        session,
        meta: {
          wire: guestWire,
          uploadReceiver: createFileReceiver(session, guestWire),
        },
      }
      connectionsRef.current.set(session.peerId, entry)

      function announceJoin(): void {
        dispatchRoom({ type: 'SET_STATUS', payload: 'connected' })
        refreshParticipantsList()
        const name = session.nickname || 'Anon'
        setMessages(prev => [...prev, { text: `${name} joined the room`, from: 'system', time: Date.now(), self: false }].slice(-500))

        // Notify all other guests. Count + 1 to include host.
        const count = connectionsRef.current.size + 1
        broadcast({ type: 'online-count', count } satisfies CollabUnencryptedMsg, session.peerId)
        broadcast({ type: 'collab-peer-joined', peerId: session.peerId, name } satisfies CollabUnencryptedMsg, session.peerId)

        // Send current file list and participant list to new guest.
        sendFileListToGuest(entry)
        sendParticipantListToGuest(entry)
      }

      async function sendFileListToGuest(guest: GuestEntry): Promise<void> {
        const { session: gSess } = guest
        if (!gSess.encryptKey) return
        // H5 — always read through filesRef.current, never captured `files`.
        const fileList = filesRef.current.sharedFiles.map(f => ({
          id: f.id,
          name: f.name,
          size: f.size,
          type: f.type,
          owner: f.owner,
          ownerName: f.ownerName,
          thumbnail: f.thumbnail,
          textPreview: f.textPreview,
          addedAt: f.addedAt,
        }))
        try {
          const encrypted = await encryptJSON(gSess.encryptKey, { type: 'collab-file-list', files: fileList } satisfies CollabInnerMsg)
          gSess.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
        } catch (e) { log.warn('useCollabHost.sendFileListToGuest', e) }
      }

      async function sendParticipantListToGuest(guest: GuestEntry): Promise<void> {
        const { session: gSess } = guest
        if (!gSess.encryptKey) return
        // H4 — read peerId from peerRef (fresh) and name from myNameRef.
        const pList = [
          { peerId: peerRef.current?.id || '', name: myNameRef.current, isHost: true },
          ...Array.from(connectionsRef.current.values())
            .filter(e => e.session.peerId !== gSess.peerId && (e.session.passwordVerified || !passwordRef.current))
            .map(e => ({ peerId: e.session.peerId, name: e.session.nickname || 'Anon', isHost: false })),
        ]
        try {
          const encrypted = await encryptJSON(gSess.encryptKey, { type: 'collab-participant-list', participants: pList } satisfies CollabInnerMsg)
          gSess.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
        } catch (e) { log.warn('useCollabHost.sendParticipantListToGuest', e) }
      }

      conn.on('open', async () => {
        if (destroyed) return
        session.dispatch({ type: 'conn-open' })

        session.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

        function handleDisconnect(reason: string): void {
          if (destroyed) return
          if (session.state === 'closed' || session.state === 'error' || session.state === 'kicked') return
          try { conn.removeAllListeners() } catch (e) { log.warn('useCollabHost.handleDisconnect.removeListeners', e) }
          // Session-level cleanup — heartbeat, rttPoller, keyExchangeTimeout,
          // every active transfer aborted + pauseResolved.
          session.close('peer-disconnect')

          const name = session.nickname || 'A guest'
          connectionsRef.current.delete(session.peerId)

          // M1 — drop files owned by this guest.
          dispatchFiles({ type: 'REMOVE_FILES_BY_OWNER', ownerId: session.peerId })

          refreshParticipantsList()
          setMessages(prev => [...prev, { text: `${name} ${reason}`, from: 'system', time: Date.now(), self: false }].slice(-500))

          const count = connectionsRef.current.size + 1
          broadcast({ type: 'online-count', count } satisfies CollabUnencryptedMsg)
          broadcast({ type: 'collab-peer-left', peerId: session.peerId, name } satisfies CollabUnencryptedMsg)

          if (connectionsRef.current.size === 0) {
            setRtt(null)
            dispatchRoom({ type: 'SET_STATUS', payload: 'waiting' })
          }
        }

        session.heartbeat = setupHeartbeat(conn, {
          onDead: () => handleDisconnect('connection lost'),
        })

        const pc = conn.peerConnection
        if (pc) {
          const prevIceHandler = pc.oniceconnectionstatechange
          pc.oniceconnectionstatechange = (ev) => {
            if (typeof prevIceHandler === 'function') prevIceHandler.call(pc, ev)
            const s = pc.iceConnectionState
            if (s === 'disconnected' || s === 'failed' || s === 'closed') {
              handleDisconnect('left')
            }
          }
        }

        // Start key exchange
        session.setKeyPair(await generateKeyPair())
        const pubKeyBytes = await exportPublicKey(session.keyPair!.publicKey)
        try { session.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.sendPublicKey', e) }

        // Handshake watchdog. Session auto-clears on keys-derived and close.
        session.keyExchangeTimeout = setTimeout(() => {
          if (!session.encryptKey) {
            console.warn('Key exchange timed out for', session.peerId)
            conn.close()
          }
        }, TIMEOUT_MS)

        // Handle deferred key
        if (session.pendingRemoteKey) {
          try {
            const { encryptKey, fingerprint } = await finalizeKeyExchange({
              localPrivate: session.keyPair!.privateKey,
              localPublic: pubKeyBytes,
              remotePublic: session.pendingRemoteKey,
            })
            session.dispatch({ type: 'keys-derived', encryptKey, fingerprint, requiresPassword: session.passwordRequired })
            session.pendingRemoteKey = null
            // H8: branch on the session-latched `passwordRequired` (frozen at
            // createSession for this connection) rather than the live ref, so
            // a mid-handshake setPassword toggle cannot admit the guest
            // through the no-password branch after we already signalled
            // password-required to the peer (or vice versa).
            if (session.passwordRequired) {
              try { session.send({ type: 'password-required' } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.sendPasswordRequired', e) }
            } else {
              session.setPasswordVerified()
              announceJoin()
            }
          } catch (e) {
            log.warn('useCollabHost.pendingRemoteKey.derive', e)
            conn.close()
          }
        }
      })

      conn.on('data', async (data: unknown) => {
        if (destroyed) return
        if (session.heartbeat) session.heartbeat.markAlive()

        // Nit — tighter binary detection: an ArrayBuffer/Uint8Array, or a
        // plain object with a numeric byteLength and no `type` field.
        if (
          data instanceof ArrayBuffer ||
          data instanceof Uint8Array ||
          (data && typeof data === 'object' && typeof (data as { byteLength?: unknown }).byteLength === 'number' && !(data as { type?: unknown }).type)
        ) {
          session.chunkQueue = session.chunkQueue
            .then(() => handleGuestChunk(entry, data as ArrayBuffer))
            .catch(e => log.warn('useCollabHost.chunkQueue', e))
          return
        }

        // Call messages (call-*) ride the same DataConnection but aren't
        // in the collab union. Pull them off before the union cast so the
        // discriminated switch below stays clean.
        const raw = data as { type?: unknown }
        if (typeof raw.type === 'string' && raw.type.startsWith('call-')) {
          if (callMessageHandlerRef.current) {
            try { callMessageHandlerRef.current(conn.peer, raw as Record<string, unknown>) }
            catch (e) { log.warn('useCollabHost.callMessageHandler', e) }
          }
          return
        }

        // Trust boundary — after the binary and call-* checks every
        // valid payload should match the collab outer union.
        const msg = data as CollabUnencryptedMsg

        if (msg.type === 'pong') return
        if (msg.type === 'ping') {
          try { session.send({ type: 'pong', ts: msg.ts } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.sendPong', e) }
          return
        }

        // Public key exchange
        if (msg.type === 'public-key') {
          const remoteKeyRaw = new Uint8Array(msg.key as number[])
          if (!session.keyPair) {
            session.pendingRemoteKey = remoteKeyRaw
            return
          }
          try {
            const localPubBytes = await exportPublicKey(session.keyPair.publicKey)
            const { encryptKey, fingerprint } = await finalizeKeyExchange({
              localPrivate: session.keyPair.privateKey,
              localPublic: localPubBytes,
              remotePublic: remoteKeyRaw,
            })
            session.dispatch({ type: 'keys-derived', encryptKey, fingerprint, requiresPassword: session.passwordRequired })

            // H8: see comment on the other keys-derived branch — branch on
            // the session-latched flag, not the live ref.
            if (session.passwordRequired) {
              try { session.send({ type: 'password-required' } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.sendPasswordRequired', e) }
            } else {
              session.setPasswordVerified()
              announceJoin()
            }
          } catch (e) {
            log.warn('useCollabHost.publicKey.derive', e)
            conn.close()
          }
          return
        }

        // Password verification (C4 — rate limit after 5 wrong attempts).
        // M-c — always decrypt, always compare, single accept/reject
        // branch. Previously a decrypt failure short-circuited down a
        // different code path than a successful decrypt with a wrong
        // password, leaking the distinction via timing.
        if (msg.type === 'password-encrypted') {
          if (!session.encryptKey || !msg.data) return
          let password = ''
          try {
            const decrypted = await decryptChunk(session.encryptKey, base64ToUint8(msg.data as string))
            password = new TextDecoder().decode(decrypted)
          } catch (e) {
            log.warn('useCollabHost.password.decrypt', e)
            // Fall through with empty password so the compare runs either way.
          }

          const matched = password.length > 0 && timingSafeEqual(password, passwordRef.current ?? '')

          if (matched) {
            try { session.send({ type: 'password-accepted' } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.password.acceptedSend', e) }
            session.setPasswordVerified()
            session.passwordAttempts = 0
            session.dispatch({ type: 'password-accepted' })
            announceJoin()
          } else {
            const attempts = session.incrementPasswordAttempts()
            if (attempts >= MAX_PASSWORD_ATTEMPTS) {
              try { session.send({ type: 'password-rate-limited' } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.password.rateLimitSend', e) }
              setTimeout(() => { try { conn.close() } catch (e) { log.warn('useCollabHost.password.lockClose', e) } }, 1000)
              return
            }
            try { session.send({ type: 'password-wrong' } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabHost.password.wrongSend', e) }
          }
          return
        }

        // Join message
        if (msg.type === 'join') {
          session.setNickname(((msg.nickname as string) || 'Anon').slice(0, 32))
          // H8: branch on the session-latched flag. If this session was
          // created while the room required a password, announceJoin is
          // driven by the password-verify path, not the plain join.
          if (!session.passwordRequired && session.encryptKey) {
            announceJoin()
          }
          return
        }

        // M-m — guest requesting fresh participant + file lists. Gated on
        // the session being fully authenticated so an unverified peer
        // can't fish roster state. Rate-limited by the generic control
        // bucket to prevent abuse.
        if (msg.type === 'collab-resync-request') {
          if (!checkControlRate(session)) return
          if (session.passwordRequired && !session.passwordVerified) return
          if (!session.encryptKey) return
          sendParticipantListToGuest(entry)
          sendFileListToGuest(entry)
          return
        }

        // Typing indicator
        if (msg.type === 'typing') {
          handleTypingMessage(msg.nickname as string, setTypingUsers, typingTimeouts.current)
          broadcast({ type: 'typing', nickname: msg.nickname } satisfies CollabUnencryptedMsg, session.peerId)
          return
        }

        // Reaction
        if (msg.type === 'reaction') {
          setMessages(prev => prev.map(m => {
            if ((m.id ?? `${m.time}`) === msg.msgId) {
              const reactions = { ...(m.reactions || {}) }
              if (!reactions[msg.emoji as string]) reactions[msg.emoji as string] = []
              if (!reactions[msg.emoji as string].includes(msg.nickname as string)) {
                reactions[msg.emoji as string] = [...reactions[msg.emoji as string], msg.nickname as string]
              }
              return { ...m, reactions }
            }
            return m
          }))
          broadcast(data as Record<string, unknown>, session.peerId)
          return
        }

        // Encrypted chat message
        if (msg.type === 'chat-encrypted') {
          if (!session.encryptKey || !msg.data) return
          let payload: Record<string, unknown> = {}
          try { payload = await decryptJSON(session.encryptKey, msg.data as string) }
          catch (e) { log.warn('useCollabHost.chatEncrypted.decrypt', e); return }

          const chatMsg: ChatMessage = {
            id: payload.id as string | undefined,
            text: payload.text as string || '',
            image: payload.image as string | undefined,
            mime: payload.mime as string | undefined,
            replyTo: payload.replyTo as ChatMessage['replyTo'],
            from: session.nickname || 'Anon',
            time: msg.time as number || Date.now(),
            self: false,
          }
          setMessages(prev => [...prev, chatMsg].slice(-500))

          // Relay to other guests
          const relayPayload = JSON.stringify(payload)
          for (const [otherId, otherEntry] of connectionsRef.current) {
            if (otherId === session.peerId || !otherEntry.session.encryptKey) continue
            if (!otherEntry.session.passwordVerified && passwordRef.current) continue
            try {
              const encrypted = await encryptChunk(otherEntry.session.encryptKey, new TextEncoder().encode(relayPayload))
              otherEntry.session.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: session.nickname || 'Anon', time: msg.time } satisfies CollabUnencryptedMsg)
            } catch (e) { log.warn('useCollabHost.chatEncrypted.relay', e) }
          }
          return
        }

        // H6 — Nickname change from a guest.
        if (msg.type === 'nickname-change') {
          const newName = String(msg.newName || '').slice(0, 32)
          if (!newName) return
          const oldName = session.nickname || 'Anon'
          session.setNickname(newName)
          refreshParticipantsList()
          // Also update any files owned by this guest in our local file list.
          dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: session.peerId, newName })
          // Trust model: the broadcast uses `session.peerId`, NOT the
          // `peerId` in the inbound `nickname-change` payload. The host
          // rewrites the peer identity to the authenticated connection
          // owner so a guest cannot rename a different participant by
          // forging `peerId`. Do not change this to echo `msg.peerId`
          // without a new validation step — that would reopen the
          // impersonation path.
          broadcast({ type: 'collab-peer-renamed', peerId: session.peerId, oldName, newName } satisfies CollabUnencryptedMsg, session.peerId)
          setMessages(prev => [...prev, { text: `${oldName} renamed to ${newName}`, from: 'system', time: Date.now(), self: false }].slice(-500))
          return
        }

        // Encrypted collab messages
        if (msg.type === 'collab-msg-enc') {
          if (!session.encryptKey || !msg.data) return
          // Typed against CollabInnerMsg — each `payload.type === 'X'`
          // branch narrows to the matching variant.
          let payload: CollabInnerMsg
          try { payload = await decryptJSON<CollabInnerMsg>(session.encryptKey, msg.data as string) }
          catch (e) {
            // M-p: count consecutive GCM auth failures. A peer pumping
            // garbage at line rate would otherwise burn CPU forever on
            // silent log.warn calls.
            session.decryptFailures++
            log.warn('useCollabHost.collabMsgEnc.decrypt', e)
            if (session.decryptFailures >= 10) {
              log.warn('useCollabHost.collabMsgEnc.tooManyFailures', session.peerId)
              session.close('error')
            }
            return
          }
          session.decryptFailures = 0

          // Handle collab-specific messages
          if (payload.type === 'collab-request-file') {
            if (!checkControlRate(session)) return
            const fileId = payload.fileId as string
            const ownerId = payload.owner as string | undefined

            // M12 — record that this guest actually asked for the file,
            // so later pause/resume/cancel forwards can be checked against
            // the request set. Populated before the forwarding branch so
            // both host-served and guest-served downloads are covered.
            // M-n — cap set size so a loop of request→cancel can't grow it
            // unboundedly and amplify forwards.
            if (session.requestedFileIds.size >= REQUESTED_FILE_IDS_CAP &&
                !session.requestedFileIds.has(fileId)) {
              log.warn('useCollabHost.requestFile.capExceeded', session.peerId)
              return
            }
            session.requestedFileIds.add(fileId)

            // Check if host owns this file
            if (myFilesRef.current.has(fileId)) {
              await sendFileToRequester(entry, fileId)
              return
            }

            // Otherwise relay the request to the file owner (another guest).
            // H5 — read through filesRef.current.
            const sharedFile = filesRef.current.sharedFiles.find(f => f.id === fileId)
            const ownerPeerId = ownerId || sharedFile?.owner
            if (ownerPeerId) {
              const ownerEntry = connectionsRef.current.get(ownerPeerId)
              if (ownerEntry?.session.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerEntry.session.encryptKey, {
                    type: 'collab-request-file',
                    fileId,
                    requesterPeerId: session.peerId,
                  } satisfies CollabInnerMsg)
                  ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
                } catch (e) { log.warn('useCollabHost.relayRequestFile', e) }
              }
            }
            return
          }

          if (payload.type === 'collab-file-shared') {
            // C2/C3 — validate and bind the owner to the sending peer.
            const sanitized = sanitizeSharedFile(payload.file)
            if (!sanitized) {
              const reason = validateSharedFile(payload.file)
              log.warn('useCollabHost.collabFileShared.invalid', `${reason} from ${session.peerId}`)
              return
            }
            if (sanitized.droppedReasons.length > 0) {
              log.info('useCollabHost.collabFileShared.sanitized', sanitized.droppedReasons.join(','))
            }
            // M19 — per-guest rate-limit on collab-file-shared broadcasts.
            // A hostile guest can otherwise pump entries at line-rate, each
            // of which costs a dispatch + N-1 encrypted relays. Drop shares
            // beyond 10/s sliding window with a log line instead of turning
            // one peer's loop into a room-wide DoS.
            const FILE_SHARE_MAX = 10
            const now = Date.now()
            session.recentFileShares = session.recentFileShares.filter(t => now - t < FILE_SHARE_WINDOW_MS)
            if (session.recentFileShares.length >= FILE_SHARE_MAX) {
              log.warn('useCollabHost.collabFileShared.rateLimited', session.peerId)
              return
            }
            session.recentFileShares.push(now)
            // C3 — force owner to match the guest that sent it; host cannot forge.
            // TODO: full origin auth requires per-guest signing keys; host can still forge if determined
            const bound: SharedFile = { ...sanitized.file, owner: session.peerId, ownerName: session.nickname || 'Anon' }
            dispatchFiles({ type: 'ADD_SHARED_FILE', payload: bound })

            // Relay to other guests (with bound owner).
            for (const [otherId, otherEntry] of connectionsRef.current) {
              if (otherId === session.peerId || !otherEntry.session.encryptKey) continue
              if (!otherEntry.session.passwordVerified && passwordRef.current) continue
              try {
                const encrypted = await encryptJSON(otherEntry.session.encryptKey, {
                  type: 'collab-file-shared',
                  file: bound,
                  from: session.peerId,
                } satisfies CollabInnerMsg)
                otherEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
              } catch (e) { log.warn('useCollabHost.relayFileShared', e) }
            }
            return
          }

          // Guest removed their file (C3 — owner must match sender).
          if (payload.type === 'collab-file-removed') {
            if (!checkControlRate(session)) return
            const fileId = payload.fileId as string
            const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
            if (file && file.owner === session.peerId) {
              dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })
              // Relay to other guests, including `from` so they can verify origin.
              // TODO: full origin auth requires per-guest signing keys; host can still forge if determined
              for (const [otherId, otherEntry] of connectionsRef.current) {
                if (otherId === session.peerId || !otherEntry.session.encryptKey) continue
                if (!otherEntry.session.passwordVerified && passwordRef.current) continue
                try {
                  const encrypted = await encryptJSON(otherEntry.session.encryptKey, { type: 'collab-file-removed', fileId, from: session.peerId } satisfies CollabInnerMsg)
                  otherEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
                } catch (e) { log.warn('useCollabHost.relayFileRemoved', e) }
              }
            }
            return
          }

          // Pause file transfer from guest
          if (payload.type === 'collab-pause-file') {
            if (!checkControlRate(session)) return
            const fileId = payload.fileId as string
            // If the host is the file owner, toggle the local outbound
            // transfer's paused flag. The session routes pauseTransfer to
            // the handle; runTransfer's while-loop picks up the flag.
            session.pauseTransfer(fileId)
            // H5 — filesRef.current
            const sharedFile = filesRef.current.sharedFiles.find(f => f.id === fileId)
            if (sharedFile && sharedFile.owner !== room.myPeerId) {
              // M12 — defense-in-depth: the guest-side owner check rejects
              // forged requesterPeerId, but also refuse to forward from the
              // host if this guest never actually requested the file. Stops
              // a guest from replaying control messages for arbitrary
              // fileIds to amplify the DoS surface against the owner.
              if (!session.requestedFileIds.has(fileId)) {
                log.warn('useCollabHost.pauseFile.notRequested', `${session.peerId}:${fileId}`)
                return
              }
              const ownerEntry = connectionsRef.current.get(sharedFile.owner)
              if (ownerEntry?.session.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerEntry.session.encryptKey, {
                    type: 'collab-pause-file',
                    fileId,
                    requesterPeerId: session.peerId,
                  } satisfies CollabInnerMsg)
                  ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
                } catch (e) { log.warn('useCollabHost.relayPauseFile', e) }
              }
            }
            return
          }

          // Resume file transfer from guest
          if (payload.type === 'collab-resume-file') {
            if (!checkControlRate(session)) return
            const fileId = payload.fileId as string
            session.resumeTransfer(fileId)
            // H5 — filesRef.current
            const sharedFile = filesRef.current.sharedFiles.find(f => f.id === fileId)
            if (sharedFile && sharedFile.owner !== room.myPeerId) {
              if (!session.requestedFileIds.has(fileId)) {
                log.warn('useCollabHost.resumeFile.notRequested', `${session.peerId}:${fileId}`)
                return
              }
              const ownerEntry = connectionsRef.current.get(sharedFile.owner)
              if (ownerEntry?.session.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerEntry.session.encryptKey, {
                    type: 'collab-resume-file',
                    fileId,
                    requesterPeerId: session.peerId,
                  } satisfies CollabInnerMsg)
                  ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
                } catch (e) { log.warn('useCollabHost.relayResumeFile', e) }
              }
            }
            return
          }

          // Cancel file transfer from guest
          if (payload.type === 'collab-cancel-file') {
            if (!checkControlRate(session)) return
            const fileId = payload.fileId as string
            session.cancelTransfer(fileId)
            // M12 — clear the request tracker here (whether or not we
            // actually forward). The guest asked to cancel; future
            // pause/resume for the same fileId from this guest must come
            // through a new request-file first.
            session.requestedFileIds.delete(fileId)
            // Abort inbound upload receiver if this guest was sending us the file.
            await entry.meta.uploadReceiver.abort(fileId, 'cancelled')
            // H5 — filesRef.current
            const sharedFile = filesRef.current.sharedFiles.find(f => f.id === fileId)
            if (sharedFile && sharedFile.owner !== room.myPeerId) {
              const ownerEntry = connectionsRef.current.get(sharedFile.owner)
              if (ownerEntry?.session.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerEntry.session.encryptKey, {
                    type: 'collab-cancel-file',
                    fileId,
                    requesterPeerId: session.peerId,
                  } satisfies CollabInnerMsg)
                  ownerEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
                } catch (e) { log.warn('useCollabHost.relayCancelFile', e) }
              }
            }
            return
          }

          // Cancel all transfers
          if (payload.type === 'collab-cancel-all') {
            // Cancel all active transfers to this guest
            session.cancelAllTransfers()
            // M12 — every pending request is now cancelled.
            session.requestedFileIds.clear()
            return
          }

          // File transfer start (host receiving file from guest) — H2.
          if (payload.type === 'collab-file-start') {
            const fileId = payload.fileId as string
            const fileName = payload.name as string
            const fileSize = payload.size as number
            const totalChunks = payload.totalChunks as number
            const packetIndex = payload.packetIndex as number

            // Clear any pending request-timeout for this file.
            clearDownloadTimeout(fileId)

            // Seed the wire so onChunk can route by packet index.
            entry.meta.wire.seedFromInbound(fileId, packetIndex)

            const fileStreamHandle = createFileStream(fileName, fileSize)
            const startTime = Date.now()

            // Build a WritableStream<Uint8Array> backed by either the
            // streamsaver handle (streaming to disk) or an in-memory fallback
            // that triggers a download on close (same H9 cap as before).
            let sink: WritableStream<Uint8Array>
            if (fileStreamHandle) {
              // Streaming path — wrap FileStreamHandle in a WritableStream.
              sink = new WritableStream<Uint8Array>({
                async write(chunk) { await fileStreamHandle.write(chunk) },
                async close() { await fileStreamHandle.close() },
                async abort() { await fileStreamHandle.abort() },
              })
            } else {
              // In-memory fallback (H9 — cap at FALLBACK_MAX_BYTES).
              const chunks: BlobPart[] = []
              let receivedBytes = 0
              sink = new WritableStream<Uint8Array>({
                write(chunk) {
                  if (receivedBytes + chunk.byteLength > FALLBACK_MAX_BYTES) {
                    dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'error', error: FALLBACK_TOO_LARGE_MSG } })
                    throw new Error(FALLBACK_TOO_LARGE_MSG)
                  }
                  chunks.push(chunk.slice(0))
                  receivedBytes += chunk.byteLength
                },
                close() {
                  const mimeType = filesRef.current.sharedFiles.find(f => f.id === fileId)?.type || 'application/octet-stream'
                  const blob = new Blob(chunks, { type: mimeType })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = fileName
                  document.body.appendChild(a)
                  a.click()
                  document.body.removeChild(a)
                  URL.revokeObjectURL(url)
                },
              })
            }

            await entry.meta.uploadReceiver.onFileStart({
              fileId,
              totalBytes: fileSize,
              totalChunks,
              sink,
              onProgress: (written, total) => {
                const progress = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0
                const elapsed = (Date.now() - startTime) / 1000
                const speed = elapsed > 0.5 ? written / elapsed : 0
                dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { progress, speed } })
              },
            })
            dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
            return
          }

          // File transfer end (host receiving file from guest) — H2.
          if (payload.type === 'collab-file-end') {
            // Drain this guest's chunk queue so the last few chunks are
            // written before we close the stream. Using the hook-level
            // chunkQueueRef here was a dead await (nothing appended to it
            // after gs.chunkQueue landed) and let end-of-file processing
            // race against in-flight decrypts from OTHER guests' uploads.
            await session.chunkQueue
            const fileId = payload.fileId as string
            try {
              await entry.meta.uploadReceiver.onFileEnd(fileId, payload.integrity)
              dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'complete', progress: 100 } })
            } catch (err) {
              if (err instanceof IntegrityError) {
                log.warn('useCollabHost.upload.integrityFail', { fileId, kind: err.kind, message: err.message })
                dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'error', error: `integrity ${err.kind}` } })
              } else {
                throw err
              }
            }
            // M12 — request satisfied (or failed); future pause/resume needs a fresh request.
            session.requestedFileIds.delete(fileId)
            return
          }

          // Peer reports that chunk decrypt failed on its side — stop sending.
          if (payload.type === 'collab-file-unavailable') {
            const fileId = payload.fileId as string
            const reason = (payload.reason as string) || 'unavailable'
            dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'error', error: reason } })
            clearDownloadTimeout(fileId)
            // M12 — request failed; clear the tracker so the guest has to
            // ask again (and get re-authorized) before any further control.
            session.requestedFileIds.delete(fileId)
            return
          }

          return
        }

        // P2P signaling relay between guests.
        // H6: validate the sender is authenticated, the target is a current
        // participant, and the signal payload is shaped like a non-null
        // object (offer/answer/candidate envelope). Previously a guest
        // could spray arbitrary payloads to arbitrary peerIds with no gate.
        if (msg.type === 'collab-signal') {
          if (!session.passwordVerified && session.passwordRequired) {
            log.warn('useCollabHost.collabSignal.unverified', session.peerId)
            return
          }
          if (!checkControlRate(session)) return
          const target = typeof msg.target === 'string' ? msg.target : ''
          if (!target || !connectionsRef.current.has(target)) {
            log.warn('useCollabHost.collabSignal.unknownTarget', target)
            return
          }
          const signal = msg.signal
          if (!signal || typeof signal !== 'object') {
            log.warn('useCollabHost.collabSignal.badShape', session.peerId)
            return
          }
          relaySignal(session.peerId, target, signal)
          return
        }

        // Mid-stream abort from guest — clear inProgressImage so the
        // next start doesn't see leftover bytes from the stalled stream.
        if (msg.type === 'chat-image-abort') {
          session.inProgressImage = null
          return
        }

        // Chat image handling (same as sender)
        if (msg.type === 'chat-image-start-enc') {
          if (!session.encryptKey || !msg.data) return
          let metaPayload: Record<string, unknown>
          try { metaPayload = await decryptJSON(session.encryptKey, msg.data as string) }
          catch (e) { log.warn('useCollabHost.chatImageStart.decrypt', e); return }
          session.inProgressImage = {
            id: metaPayload.id as string | undefined,
            mime: metaPayload.mime as string || 'application/octet-stream',
            size: metaPayload.size as number || 0,
            text: metaPayload.text as string || '',
            replyTo: metaPayload.replyTo as { text: string; from: string; time: number } | null,
            time: metaPayload.time as number || Date.now(),
            from: session.nickname || 'Anon',
            duration: metaPayload.duration as number | undefined,
            chunks: [],
            receivedBytes: 0,
          }
          return
        }

        if (msg.type === 'chat-image-end-enc') {
          await session.chunkQueue
          const inFlight = session.inProgressImage
          session.inProgressImage = null
          if (!inFlight) return

          const totalLen = inFlight.chunks.reduce((s, c) => s + c.byteLength, 0)
          const fullBytes = new Uint8Array(totalLen)
          let off = 0
          for (const c of inFlight.chunks) { fullBytes.set(c, off); off += c.byteLength }

          const blob = new Blob([fullBytes], { type: inFlight.mime })
          const url = URL.createObjectURL(blob)
          imageBlobUrlsRef.current.push(url)
          setMessages(prev => [...prev, {
            id: inFlight.id,
            text: inFlight.text,
            image: url,
            mime: inFlight.mime,
            duration: inFlight.duration,
            replyTo: inFlight.replyTo,
            from: inFlight.from,
            time: inFlight.time,
            self: false,
          }].slice(-500))

          // Relay to other guests
          for (const [otherId, otherEntry] of connectionsRef.current) {
            if (otherId === session.peerId || !otherEntry.session.encryptKey) continue
            if (!otherEntry.session.passwordVerified && passwordRef.current) continue
            const otherKey = otherEntry.session.encryptKey
            otherEntry.session.imageSendQueue = otherEntry.session.imageSendQueue
              .then(() => streamImageToConn(otherEntry.session.conn, otherKey, fullBytes, inFlight.mime, inFlight.text, inFlight.replyTo, session.nickname || 'Anon', inFlight.time, inFlight.duration, inFlight.id))
              .catch(err => { console.warn('image relay failed:', err) })
          }
          return
        }
      })

      conn.on('close', () => {
        if (destroyed) return
        if (session.state === 'closed' || session.state === 'error' || session.state === 'kicked') return
        try { conn.removeAllListeners() } catch (e) { log.warn('useCollabHost.close.removeListeners', e) }
        session.close('peer-disconnect')

        const name = session.nickname || 'A guest'
        connectionsRef.current.delete(session.peerId)

        // M1 — drop files owned by this guest.
        dispatchFiles({ type: 'REMOVE_FILES_BY_OWNER', ownerId: session.peerId })

        refreshParticipantsList()
        setMessages(prev => [...prev, { text: `${name} left`, from: 'system', time: Date.now(), self: false }].slice(-500))

        broadcast({ type: 'online-count', count: connectionsRef.current.size + 1 } satisfies CollabUnencryptedMsg)
        broadcast({ type: 'collab-peer-left', peerId: session.peerId, name } satisfies CollabUnencryptedMsg)

        if (connectionsRef.current.size === 0) {
          setRtt(null)
          dispatchRoom({ type: 'SET_STATUS', payload: 'waiting' })
        }
      })

      conn.on('error', (err: unknown) => {
        if (destroyed) return
        console.warn('host conn.on("error"):', err)
        session.close('error')
        connectionsRef.current.delete(session.peerId)
        dispatchFiles({ type: 'REMOVE_FILES_BY_OWNER', ownerId: session.peerId })
        refreshParticipantsList()
        if (connectionsRef.current.size === 0) {
          setRtt(null)
          dispatchRoom({ type: 'SET_STATUS', payload: 'waiting' })
        }
      })
    })

    peer.on('disconnected', () => {
      if (destroyed) return
      if (!peer.destroyed) peer.reconnect()
    })

    peer.on('error', (err: { type: string }) => {
      if (destroyed) return
      if (err.type === 'unavailable-id') {
        peer.destroy()
      } else if (err.type === 'disconnected' || err.type === 'network') {
        return
      } else if (err.type === 'peer-unavailable') {
        // A transient signaling miss — we only care if we have no live guests.
        if (connectionsRef.current.size > 0) return
      }
      if (connectionsRef.current.size === 0) {
        dispatchRoom({ type: 'SET_STATUS', payload: 'error' })
      }
    })

    function handleVisibility(): void {
      if (document.visibilityState !== 'visible' || destroyed) return
      // Kick the signaling channel back up if it slept through background.
      if (peer.disconnected && !peer.destroyed) peer.reconnect()
      // Tell every live heartbeat we just woke up — without this, a false-
      // positive 'dead' can fire 5s after wake because setInterval caught up.
      connectionsRef.current.forEach(e => { if (e.session.heartbeat) e.session.heartbeat.markAlive() })
    }
    document.addEventListener('visibilitychange', handleVisibility)

    function handleBeforeUnload(): void {
      broadcast({ type: 'room-closed' } satisfies CollabUnencryptedMsg)
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    window.addEventListener('pagehide', handleBeforeUnload)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      destroyed = true
      connectionsRef.current.forEach(entry => {
        entry.session.close('session-abort')
        try { entry.session.conn.removeAllListeners() } catch (e) { log.warn('useCollabHost.unmount.removeListeners', e) }
      })
      connectionsRef.current.clear()
      downloadTimeoutsRef.current.forEach(t => clearTimeout(t))
      downloadTimeoutsRef.current.clear()
      setPeerInstance(null)
      setParticipantsList([])
      peer.destroy()
    }
  }, [sessionKey])

  // Handle chunk from guest (for files they're sharing)
  async function handleGuestChunk(entry: GuestEntry, rawData: ArrayBuffer): Promise<void> {
    const { session } = entry
    if (!session.encryptKey) return
    const buffer = rawData instanceof ArrayBuffer ? rawData : (rawData as ArrayBufferView).buffer as ArrayBuffer

    let parsed: ReturnType<typeof parseChunkPacket>
    try {
      parsed = parseChunkPacket(buffer)
    } catch (e) { log.warn('handleGuestChunk.parse', e); return }

    // Chat image chunk
    if (parsed.fileIndex === CHAT_IMAGE_FILE_INDEX) {
      if (!session.inProgressImage) return
      try {
        const decrypted = await decryptChunk(session.encryptKey, new Uint8Array(parsed.data))
        session.inProgressImage.chunks.push(new Uint8Array(decrypted))
        session.inProgressImage.receivedBytes += decrypted.byteLength
      } catch (e) { log.warn('handleGuestChunk.chatImageDecrypt', e) }
      return
    }

    // INTENTIONAL: host does not decrypt mesh-encrypted chunks on the relay
    // path. Pure bytes-forwarding between two authenticated guest peers. The
    // transferEngine is not used here — see plan-transferEngine.md (host-
    // relay out of scope).
    // Relay path: chunks whose fileIndex is not known to this guest's wire
    // (i.e. fileIdForPacketIndex returns null) are not for the host — they
    // were sent guest-A → host → guest-B via the mesh relay. Drop silently;
    // the mesh relay is handled at the signaling layer, not the chunk layer.

    // Collab file chunk for an upload directed at this host — route through
    // the per-guest uploadReceiver which decrypts and writes to the sink.
    await entry.meta.uploadReceiver.onChunk(parsed)
  }

  // Send message
  const sendMessage = useCallback(async (text: string, image?: { bytes: Uint8Array; mime: string; duration?: number } | string, replyTo?: ChatMessage['replyTo']): Promise<void> => {
    if (!text && !image) return
    const now = Date.now()
    if (now - lastMsgTime.current < 100) return
    lastMsgTime.current = now
    const time = Date.now()

    if (image && typeof image === 'object' && (image as { bytes: Uint8Array; mime: string }).bytes) {
      const imgObj = image as { bytes: Uint8Array; mime: string; duration?: number }
      const bytes = imgObj.bytes instanceof Uint8Array ? imgObj.bytes : new Uint8Array(imgObj.bytes)
      const mime = imgObj.mime || 'application/octet-stream'
      const duration = imgObj.duration
      const id = crypto.randomUUID()
      const localBlob = new Blob([asBlobPart(bytes)], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { id, text: text || '', image: localUrl, mime, duration, replyTo, from: 'You', time, self: true }].slice(-500))

      for (const entry of connectionsRef.current.values()) {
        const { session } = entry
        if (!session.encryptKey) continue
        if (!session.passwordVerified && passwordRef.current) continue
        const key = session.encryptKey
        session.imageSendQueue = session.imageSendQueue
          .then(() => streamImageToConn(session.conn, key, bytes, mime, text || '', replyTo ?? null, room.myName, time, duration, id))
          .catch(err => { console.warn('image send failed:', err) })
      }
      return
    }

    const imgStr = image as string | undefined
    const id = crypto.randomUUID()
    setMessages(prev => [...prev, { id, text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ id, text, image: imgStr, replyTo })
    for (const entry of connectionsRef.current.values()) {
      const { session } = entry
      if (!session.encryptKey) continue
      if (!session.passwordVerified && passwordRef.current) continue
      try {
        const encrypted = await encryptChunk(session.encryptKey, new TextEncoder().encode(payload))
        session.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: room.myName, time } satisfies CollabUnencryptedMsg)
      } catch (e) { log.warn('useCollabHost.sendMessage.chatEncrypt', e) }
    }
  }, [room.myName])

  const sendTyping = useCallback((): void => {
    broadcast({ type: 'typing', nickname: room.myName } satisfies CollabUnencryptedMsg)
  }, [broadcast, room.myName])

  const sendReaction = useCallback((msgId: string, emoji: string): void => {
    setMessages(prev => prev.map(m => {
      if ((m.id ?? `${m.time}`) === msgId) {
        const reactions = { ...(m.reactions || {}) }
        if (!reactions[emoji]) reactions[emoji] = []
        if (reactions[emoji].includes('You')) {
          reactions[emoji] = reactions[emoji].filter(n => n !== 'You')
          if (reactions[emoji].length === 0) delete reactions[emoji]
        } else {
          reactions[emoji] = [...reactions[emoji], 'You']
        }
        return { ...m, reactions }
      }
      return m
    }))
    broadcast({ type: 'reaction', msgId, emoji, nickname: room.myName } satisfies CollabUnencryptedMsg)
  }, [broadcast, room.myName])

  const setMyName = useCallback((name: string): void => {
    const newName = name.trim() || 'Host'
    const oldName = room.myName
    if (oldName === newName) return
    dispatchRoom({ type: 'SET', payload: { myName: newName } })
    // Also update the file entries owned by the host locally.
    const myId = peerRef.current?.id
    if (myId) {
      dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: myId, newName })
    }
    // Announce locally — mirrors the system-msg the host appends for a
    // guest's rename, so the host's own rename shows up in chat too.
    setMessages(prev => [...prev, { text: `${oldName} renamed to ${newName}`, from: 'system', time: Date.now(), self: false }].slice(-500))
    // Broadcast rename to all guests so they can update participant list
    // and append a matching system message in their own chat.
    broadcast({ type: 'collab-peer-renamed', peerId: myId || '', oldName, newName } satisfies CollabUnencryptedMsg)
  }, [broadcast, room.myName])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useCollabHost.clearMessages.revokeBlob', e) } })
    imageBlobUrlsRef.current = []
  }, [])

  const reset = useCallback((): void => {
    Object.values(typingTimeouts.current).forEach(clearTimeout)
    typingTimeouts.current = {}
    connectionsRef.current.forEach(entry => {
      entry.session.close('session-abort')
      try { entry.session.conn.removeAllListeners() } catch (e) { log.warn('useCollabHost.reset.removeListeners', e) }
    })
    connectionsRef.current.clear()
    if (peerRef.current) peerRef.current.destroy()
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useCollabHost.reset.revokeBlob', e) } })
    imageBlobUrlsRef.current = []
    myFilesRef.current.clear()
    passwordRef.current = null
    dispatchRoom({ type: 'RESET' })
    dispatchRoom({ type: 'SET', payload: { isHost: true } })
    dispatchParticipants({ type: 'RESET' })
    dispatchFiles({ type: 'RESET' })
    dispatchTransfer({ type: 'RESET' })
    setMessages([])
    setRtt(null)
    setTypingUsers([])
    // H3 — bump session key as state so the init effect re-runs.
    setSessionKey(k => k + 1)
  }, [])

  // H1 — derived flag for UI: any upload in flight?
  const uploading = Object.keys(transfer.uploads).length > 0

  return {
    // Room state
    roomId: room.roomId,
    status: room.status,
    myPeerId: room.myPeerId,
    myName: room.myName,
    isHost: true,
    fingerprint: room.fingerprint,
    errorMessage: room.errorMessage,
    passwordRequired: room.passwordRequired,

    // Participants
    participants: participants.participants,
    onlineCount: participants.onlineCount,

    // Files
    sharedFiles: files.sharedFiles,
    downloads: files.downloads,
    mySharedFiles: files.mySharedFiles,

    // Transfer (H1 — per-fileId uploads map)
    uploading,
    uploads: transfer.uploads,

    // Chat
    messages,
    typingUsers,
    rtt,

    // For useCall
    peer: peerInstance,
    participantsList,
    setCallMessageHandler,
    sendCallMessage,
    broadcastCallMessage,

    // Actions
    setPassword,
    setMyName,
    shareFile,
    removeFile,
    requestFile,
    pauseFile,
    resumeFile,
    cancelFile,
    clearDownload,
    kickUser,
    closeRoom,
    sendMessage,
    sendTyping,
    sendReaction,
    clearMessages,
    changeNickname: setMyName,
    reset,
  }
}

// Stream an image to a connection (same as in useSender)
async function streamImageToConn(
  conn: DataConnection,
  key: CryptoKey,
  bytes: Uint8Array,
  mime: string,
  text: string,
  replyTo: { text: string; from: string; time: number } | null,
  from: string,
  time: number,
  duration?: number,
  id?: string,
): Promise<void> {
  const meta = { id, mime, size: bytes.byteLength, text, replyTo, time, duration }
  const encMeta = await encryptJSON(key, meta)
  conn.send({ type: 'chat-image-start-enc', data: encMeta, from } satisfies CollabUnencryptedMsg)

  const CHUNK_SIZE = 64 * 1024
  try {
    for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
      const chunk = bytes.slice(i, i + CHUNK_SIZE)
      const encChunk = await encryptChunk(key, chunk)
      const packet = buildChunkPacket(CHAT_IMAGE_FILE_INDEX, Math.floor(i / CHUNK_SIZE), encChunk)
      conn.send(packet)
      await waitForBufferDrain(conn)
    }
    conn.send({ type: 'chat-image-end-enc' } satisfies CollabUnencryptedMsg)
  } catch (e) {
    // Emit abort so the receiver clears its session.inProgressImage slot;
    // without this, a mid-stream drain timeout left accumulated bytes
    // parked until the next start message.
    log.warn('useCollabHost.streamImageToConn', e)
    try { conn.send({ type: 'chat-image-abort' } satisfies CollabUnencryptedMsg) } catch (ne) { log.warn('useCollabHost.streamImageToConn.notifyAbort', ne) }
    throw e
  }
}
