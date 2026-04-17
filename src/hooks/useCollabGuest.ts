import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, uint8ToBase64 } from '../utils/crypto'
import { finalizeKeyExchange } from '../net/keyExchange'
import { STUN_ONLY, getWithTurn } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { chunkFileAdaptive, buildChunkPacket, parseChunkPacket, waitForBufferDrain, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { createFileStream } from '../utils/streamWriter'
import { generateThumbnailAsync, generateVideoThumbnail, generateTextPreview } from '../utils/thumbnailWorker'
import { ChatMessage } from '../types'
import { generateNickname } from '../utils/nickname'
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
  MAX_RETRIES,
  TIMEOUT_MS,
  RECONNECT_DELAY,
  MAX_RECONNECTS,
  FALLBACK_MAX_BYTES,
  FALLBACK_TOO_LARGE_MSG,
  DOWNLOAD_REQUEST_TIMEOUT_MS,
} from '../net/config'
import type { CollabInnerMsg, CollabUnencryptedMsg } from '../net/protocol'
import { log } from '../utils/logger'

// ── Constants ────────────────────────────────────────────────────────────

// P1 — if direct P2P hasn't reached 'connected' within this window, surface
// a direct-failed status so the user can opt into relay.
const DIRECT_FAIL_WINDOW_MS = 10_000

// ── Types ────────────────────────────────────────────────────────────────

interface PeerConnection {
  peerId: string
  name: string
  conn: DataConnection | null
  encryptKey: CryptoKey | null
  keyPair: CryptoKeyPair | null
  directConnection: boolean
  fingerprint?: string
  // Mesh handshake bookkeeping (mirrors GuestConnection in useCollabHost).
  pendingRemoteKey?: Uint8Array | null
  keyExchangeTimeout?: ReturnType<typeof setTimeout>
  heartbeat?: ReturnType<typeof setupHeartbeat> | null
  chunkQueue?: Promise<void>
  // Per-mesh-peer current file id for inbound chunk routing. We keep a
  // per-peer slot rather than a global one so concurrent mesh transfers
  // from different peers don't stomp on each other.
  currentDownloadFileId?: string | null
  // In-flight downloads arriving over this mesh connection.
  inProgressFiles?: Map<string, InProgressFile>
  // Serializes outbound file transfers on this conn so two concurrent
  // sendFileToRequester calls can't interleave packets. PeerJS's binary
  // chunked serializer reassembles by order on a single data channel,
  // and two simultaneous loops write overlapping sends that corrupt into
  // AES-GCM auth-tag failures on the receiver (seen as
  // `handleMeshChunk.decrypt` warns after "Download all").
  uploadQueue?: Promise<void>
}

interface InProgressFile {
  fileId: string
  name: string
  size: number
  totalChunks: number
  chunks: Uint8Array[]
  receivedBytes: number
  stream: ReturnType<typeof createFileStream> | null
  startTime: number
}

interface InProgressImage {
  id?: string
  mime: string
  size: number
  text: string
  replyTo: { text: string; from: string; time: number } | null
  time: number
  from: string
  duration?: number
  chunks: Uint8Array[]
  receivedBytes: number
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useCollabGuest(roomId: string) {
  const [room, dispatchRoom] = useReducer(roomReducer, { ...initialRoomState, isHost: false, roomId })
  const [participants, dispatchParticipants] = useReducer(participantsReducer, initialParticipantsState)
  const [files, dispatchFiles] = useReducer(filesReducer, initialFilesState)
  const [transfer, dispatchTransfer] = useReducer(transferReducer, initialTransferState)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [rtt, setRtt] = useState<number | null>(null)
  const [nickname, setNickname] = useState<string>(() => generateNickname())
  const [typingUsers, setTypingUsers] = useState<string[]>([])

  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastMsgTime = useRef<number>(0)
  const peerRef = useRef<InstanceType<typeof Peer> | null>(null)
  const hostConnRef = useRef<DataConnection | null>(null)
  const decryptKeyRef = useRef<CryptoKey | null>(null)
  const keyPairRef = useRef<CryptoKeyPair | null>(null)
  const destroyedRef = useRef<boolean>(false)
  const attemptRef = useRef<number>(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const useTurnRef = useRef<boolean>(false)
  const reconnectCountRef = useRef<number>(0)
  const heartbeatRef = useRef<ReturnType<typeof setupHeartbeat> | null>(null)
  const rttPollerRef = useRef<ReturnType<typeof setupRTTPolling> | null>(null)
  const keyExchangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  const imageSendQueueRef = useRef<Promise<void>>(Promise.resolve())
  const imageBlobUrlsRef = useRef<string[]>([])
  const inProgressImageRef = useRef<InProgressImage | null>(null)
  // H2 — per-fileId in-progress downloads.
  const inProgressFilesRef = useRef<Map<string, InProgressFile>>(new Map())
  // Which fileId the next chunk packet belongs to (serialized per sender).
  // Since guest only receives files through a single host conn in practice,
  // we can route by tracking the most recent collab-file-start.
  const currentDownloadFileIdRef = useRef<string | null>(null)
  const myFilesRef = useRef<Map<string, File>>(new Map())
  const isMountedRef = useRef<boolean>(true)
  const reconnectTokenRef = useRef<symbol>(Symbol('reconnect'))
  // P1 — track whether we've reached ICE 'connected' so we can detect
  // direct-failed after DIRECT_FAIL_WINDOW_MS.
  const iceConnectedRef = useRef<boolean>(false)
  const directFailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // M2 — request-timeout timers keyed by fileId.
  const downloadTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Active file transfers (when sending files to other peers)
  // targetPeerId === null means the transfer is going through the host relay;
  // any other value is a direct mesh transfer to that specific guest.
  const activeTransfersRef = useRef<Map<string, { fileId: string; targetPeerId: string | null; aborted: boolean; paused: boolean; pauseResolver?: () => void }>>(new Map())

  // Keep fresh reference to files state
  const filesRef = useRef(files)
  filesRef.current = files

  // Fresh participants list for closures (e.g. the mesh `connection`
  // handler set up inside connect()) so admission checks aren't running
  // against a stale snapshot from when the Peer was created.
  const participantsRef = useRef(participants)
  participantsRef.current = participants

  // H4 — keep fresh nickname in ref for closures inside startConnection.
  const myNameRef = useRef(nickname)
  useEffect(() => { myNameRef.current = nickname }, [nickname])

  // Fresh myPeerId ref so mesh callbacks don't re-create on every room change.
  const myPeerIdRef = useRef<string | null>(null)
  useEffect(() => { myPeerIdRef.current = room.myPeerId }, [room.myPeerId])

  // P2P connections to other guests (mesh). H7 uses these for guest→guest
  // uploads when a direct mesh connection exists.
  const peerConnectionsRef = useRef<Map<string, PeerConnection>>(new Map())

  // Serializes outbound file transfers routed through the host data channel
  // (mirror of PeerConnection.uploadQueue for the mesh path). When the user
  // hits "Download all", the host fan-outs N concurrent requests to this
  // guest, and this queue is what keeps their send loops from interleaving
  // on the single host data channel.
  const hostUploadQueueRef = useRef<Promise<void>>(Promise.resolve())

  // For calls
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((msg: Record<string, unknown>): void => {
    const c = hostConnRef.current
    if (c && c.open) { try { c.send(msg) } catch (e) { log.warn('useCollabGuest.sendCallMessage', e) } }
  }, [])

  // Send to host (for relaying or direct communication)
  const sendToHost = useCallback((msg: Record<string, unknown>): void => {
    const c = hostConnRef.current
    if (c && c.open) { try { c.send(msg) } catch (e) { log.warn('useCollabGuest.sendToHost', e) } }
  }, [])

  // M2 — request-timeout helpers.
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

  // Request file from owner (prefer mesh, fall back to host relay).
  const requestFile = useCallback(async (fileId: string, ownerId: string): Promise<void> => {
    if (!decryptKeyRef.current) return

    // If another download from the same owner is still in flight, mark this
    // one 'queued' instead of 'requesting' — per-conn uploadQueue on the
    // owner serializes, so the request really is queued until the prior
    // transfer ends. On collab-file-start we flip to 'downloading'.
    const snap = filesRef.current
    const ownerBusy = Object.entries(snap.downloads).some(([fid, dl]) => {
      if (fid === fileId) return false
      const f = snap.sharedFiles.find(x => x.id === fid)
      if (!f || f.owner !== ownerId) return false
      return dl.status === 'requesting' || dl.status === 'downloading' || dl.status === 'queued'
    })
    const initialStatus: FileDownload['status'] = ownerBusy ? 'queued' : 'requesting'
    const download: FileDownload = { status: initialStatus, progress: 0, speed: 0 }
    // Mirror the dispatch into filesRef immediately. A synchronous burst of
    // requestFile calls from "Download all" doesn't trigger re-renders
    // between iterations, so without this the second/third call would read
    // the stale `snap.downloads` and fall through to 'requesting' for
    // every file instead of queueing them behind the first.
    filesRef.current = {
      ...filesRef.current,
      downloads: { ...filesRef.current.downloads, [fileId]: download },
    }
    dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download })
    scheduleDownloadTimeout(fileId)

    // Try direct P2P first if we have a connection to the owner
    const peerConn = peerConnectionsRef.current.get(ownerId)
    if (peerConn?.conn && peerConn.encryptKey) {
      try {
        const encrypted = await encryptJSON(peerConn.encryptKey, { type: 'collab-request-file', fileId } satisfies CollabInnerMsg)
        peerConn.conn.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
        return
      } catch (e) { log.warn('useCollabGuest.requestFile.mesh', e) }
    }

    // Fall back to host relay — include owner so host can relay to correct peer.
    try {
      const encrypted = await encryptJSON(decryptKeyRef.current, { type: 'collab-request-file', fileId, owner: ownerId } satisfies CollabInnerMsg)
      sendToHost({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.requestFile.viaHost', e) }
  }, [sendToHost, scheduleDownloadTimeout])

  // Share a file
  const shareFile = useCallback(async (file: File): Promise<void> => {
    if (!decryptKeyRef.current || !room.myPeerId) return

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
      } catch (e) { log.warn('useCollabGuest.shareFile.imageThumb', e) }
    } else if (file.type.startsWith('video/') && file.size < 50 * 1024 * 1024) {
      try {
        thumbnail = await generateVideoThumbnail(file, 80)
      } catch (e) { log.warn('useCollabGuest.shareFile.videoThumb', e) }
    } else if (file.type === 'text/plain' || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
      try {
        textPreview = (await generateTextPreview(file)) ?? undefined
      } catch (e) { log.warn('useCollabGuest.shareFile.textPreview', e) }
    }

    const sharedFile: SharedFile = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      owner: room.myPeerId,
      ownerName: myNameRef.current,
      thumbnail,
      textPreview,
      addedAt: Date.now(),
    }

    dispatchFiles({ type: 'ADD_SHARED_FILE', payload: sharedFile })
    dispatchFiles({ type: 'ADD_MY_SHARED_FILE', fileId })

    // Notify host (who will broadcast to others)
    try {
      const encrypted = await encryptJSON(decryptKeyRef.current, {
        type: 'collab-file-shared',
        file: sharedFile,
      } satisfies CollabInnerMsg)
      sendToHost({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.shareFile.announce', e) }
  }, [sendToHost, room.myPeerId])

  // Remove a file that I shared
  const removeFile = useCallback(async (fileId: string): Promise<void> => {
    if (!decryptKeyRef.current || !room.myPeerId) return

    // Only remove if I own this file
    if (!filesRef.current.mySharedFiles.has(fileId)) return

    // Remove locally
    myFilesRef.current.delete(fileId)
    dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })

    // Notify host (who will broadcast to others). Include `from` for C3.
    try {
      const encrypted = await encryptJSON(decryptKeyRef.current, {
        type: 'collab-file-removed',
        fileId,
        from: room.myPeerId,
      } satisfies CollabInnerMsg)
      sendToHost({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.removeFile.announce', e) }
  }, [sendToHost, room.myPeerId])

  // H7 — Send file to requester. Uses mesh key if a direct mesh connection
  // exists to the requester, otherwise uses the host relay key. If the
  // requester is not the host and we have no mesh connection to them, we
  // refuse and send 'collab-file-unavailable' through the relay.
  const sendFileToRequester = useCallback(async (
    fileId: string,
    requesterPeerId: string | null,
  ): Promise<void> => {
    const file = myFilesRef.current.get(fileId)
    if (!file) return

    // Pick the transport: mesh first if we have one to the requester, else
    // host relay. If requester is another guest and mesh is missing, reject.
    let conn: DataConnection | null = null
    let key: CryptoKey | null = null
    let targetPeerId: string | null = null
    let meshEntry: PeerConnection | null = null

    if (requesterPeerId) {
      const mesh = peerConnectionsRef.current.get(requesterPeerId)
      if (mesh?.conn?.open && mesh.encryptKey) {
        conn = mesh.conn
        key = mesh.encryptKey
        targetPeerId = requesterPeerId
        meshEntry = mesh
      } else {
        // H7 — no direct mesh. Tell the requester we can't send (through host).
        if (decryptKeyRef.current && hostConnRef.current) {
          try {
            const enc = await encryptJSON(decryptKeyRef.current, {
              type: 'collab-file-unavailable',
              fileId,
              reason: 'no-direct-connection',
              requesterPeerId,
            } satisfies CollabInnerMsg)
            sendToHost({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
          } catch (e) { log.warn('useCollabGuest.cancelFile.viaHost', e) }
        }
        return
      }
    } else {
      // Requester is the host itself.
      conn = hostConnRef.current
      key = decryptKeyRef.current
    }

    if (!conn || !key) return

    // Hold locals in typed constants so the closure below doesn't need
    // non-null assertions every line.
    const sendConn = conn
    const sendKey = key

    // Create transfer state for this file, tagged with its target so
    // teardownMesh can abort only the uploads that were going to a dead conn.
    const transfer = { fileId, targetPeerId, aborted: false, paused: false, pauseResolver: undefined as (() => void) | undefined }
    activeTransfersRef.current.set(fileId, transfer)

    // Actual transfer loop. Runs inside an uploadQueue so concurrent
    // requests on the same data channel can't interleave packets — peerjs
    // reassembles by order on a single channel, and interleaved sends
    // corrupt into AES-GCM auth-tag failures on the receiver (the
    // `handleMeshChunk.decrypt` warn seen after "Download all").
    const runTransfer = async (): Promise<void> => {
      const chunker = new AdaptiveChunker()
      const throttler = new ProgressThrottler(80)
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

      dispatchTransfer({ type: 'START_UPLOAD', fileId, fileName: file.name })

      try {
        const startMsg = await encryptJSON(sendKey, {
          type: 'collab-file-start',
          fileId,
          name: file.name,
          size: file.size,
          totalChunks,
        } satisfies CollabInnerMsg)
        sendConn.send({ type: 'collab-msg-enc', data: startMsg } satisfies CollabUnencryptedMsg)
      } catch {
        activeTransfersRef.current.delete(fileId)
        dispatchTransfer({ type: 'END_UPLOAD', fileId })
        return
      }

      let chunkIndex = 0
      let fileSent = 0
      const startTime = Date.now()

      for await (const { buffer: chunkData } of chunkFileAdaptive(file, chunker)) {
        if (transfer.aborted) {
          activeTransfersRef.current.delete(fileId)
          dispatchTransfer({ type: 'END_UPLOAD', fileId })
          return
        }

        while (transfer.paused && !transfer.aborted) {
          await new Promise<void>(resolve => {
            transfer.pauseResolver = resolve
          })
        }
        if (transfer.aborted) {
          activeTransfersRef.current.delete(fileId)
          dispatchTransfer({ type: 'END_UPLOAD', fileId })
          return
        }

        const dataToSend = await encryptChunk(sendKey, new Uint8Array(chunkData))
        const packet = buildChunkPacket(0xFFFE, chunkIndex, dataToSend)
        sendConn.send(packet)
        await waitForBufferDrain(sendConn)

        chunkIndex++
        fileSent += chunkData.byteLength

        if (throttler.shouldUpdate()) {
          const elapsed = (Date.now() - startTime) / 1000
          const speed = elapsed > 0.5 ? fileSent / elapsed : 0
          const progress = file.size > 0 ? Math.min(100, Math.round((fileSent / file.size) * 100)) : 0
          dispatchTransfer({ type: 'UPDATE_UPLOAD', fileId, progress, speed })
        }
      }

      if (!transfer.aborted) {
        try {
          const endMsg = await encryptJSON(sendKey, { type: 'collab-file-end', fileId } satisfies CollabInnerMsg)
          sendConn.send({ type: 'collab-msg-enc', data: endMsg } satisfies CollabUnencryptedMsg)
        } catch (e) { log.warn('useCollabGuest.mesh.sendFileEnd', e) }
      }

      activeTransfersRef.current.delete(fileId)
      dispatchTransfer({ type: 'END_UPLOAD', fileId })
    }

    const prevQueue = meshEntry
      ? (meshEntry.uploadQueue ?? Promise.resolve())
      : hostUploadQueueRef.current
    const next = prevQueue
      .then(runTransfer)
      .catch(e => log.warn('useCollabGuest.sendFileToRequester.queue', e))
    if (meshEntry) meshEntry.uploadQueue = next
    else hostUploadQueueRef.current = next
    await next
  }, [sendToHost])

  // ── Mesh (guest ↔ guest) ─────────────────────────────────────────────
  // Tear down a single mesh PeerConnection entry, abort any active transfers
  // tied to it, and mark the participant as no-longer-directly-connected.
  const teardownMesh = useCallback((peerId: string, reason: string): void => {
    const entry = peerConnectionsRef.current.get(peerId)
    if (!entry) return
    peerConnectionsRef.current.delete(peerId)
    if (entry.keyExchangeTimeout) { clearTimeout(entry.keyExchangeTimeout); entry.keyExchangeTimeout = undefined }
    if (entry.heartbeat) { try { entry.heartbeat.cleanup() } catch (e) { log.warn('useCollabGuest.mesh.teardown.heartbeat', e) } }
    if (entry.inProgressFiles) {
      for (const f of entry.inProgressFiles.values()) {
        if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.mesh.teardown.streamAbort', e) } }
        dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: f.fileId, payload: { status: 'error', error: reason } })
      }
      entry.inProgressFiles.clear()
    }
    // H10 — selectively abort outbound transfers whose target was this mesh
    // peer. Transfers going through the host relay (targetPeerId === null) or
    // to a different mesh peer are untouched.
    activeTransfersRef.current.forEach(t => {
      if (t.targetPeerId !== peerId) return
      t.aborted = true
      if (t.pauseResolver) { t.pauseResolver(); t.pauseResolver = undefined }
    })
    if (entry.conn) {
      try { entry.conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.mesh.teardown.removeListeners', e) }
      try { entry.conn.close() } catch (e) { log.warn('useCollabGuest.mesh.teardown.close', e) }
    }
    dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { fingerprint: undefined, directConnection: false } })
  }, [])

  // Wire up a mesh DataConnection (either outgoing initiator or incoming
  // responder). Mirrors the host-guest handshake: ECDH via 'public-key',
  // then expects 'collab-msg-enc' / chunk packets over the same conn.
  const setupMeshConnection = useCallback((conn: DataConnection, peerId: string, _isInitiator: boolean): void => {
    if (destroyedRef.current) { try { conn.close() } catch (e) { log.warn('useCollabGuest.mesh.setup.closeDestroyed', e) }; return }
    // Double-connection prevention: if a live entry already exists, drop the new one.
    const existing = peerConnectionsRef.current.get(peerId)
    if (existing && existing.conn && existing.conn.open) {
      try { conn.close() } catch (e) { log.warn('useCollabGuest.mesh.setup.closeDup', e) }
      return
    }

    // Seed a fresh entry (wipes any stale non-open placeholder).
    const entry: PeerConnection = {
      peerId,
      name: '',
      conn,
      encryptKey: null,
      keyPair: null,
      directConnection: false,
      pendingRemoteKey: null,
      heartbeat: null,
      chunkQueue: Promise.resolve(),
      uploadQueue: Promise.resolve(),
      currentDownloadFileId: null,
      inProgressFiles: new Map(),
    }
    peerConnectionsRef.current.set(peerId, entry)

    conn.on('open', async () => {
      if (destroyedRef.current) { try { conn.close() } catch (e) { log.warn('useCollabGuest.mesh.open.closeDestroyed', e) }; return }
      // Heartbeat for dead-mesh detection.
      entry.heartbeat = setupHeartbeat(conn, {
        onDead: () => teardownMesh(peerId, 'mesh connection lost'),
      })

      try {
        entry.keyPair = await generateKeyPair()
        const pubKeyBytes = await exportPublicKey(entry.keyPair.publicKey)
        try { conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.mesh.sendPublicKey', e) }

        entry.keyExchangeTimeout = setTimeout(() => {
          if (!entry.encryptKey) {
            console.warn('mesh key exchange timed out for', peerId)
            teardownMesh(peerId, 'mesh key exchange timed out')
          }
        }, 10_000)

        // If we received the remote key before our keyPair was ready, finish
        // the handshake here. We also re-check at the end to cover the narrow
        // window where the remote public-key lands between this check and the
        // data handler's own derive path (can't actually happen today because
        // entry.keyPair is set before this point and the data handler will
        // derive directly, but the re-check costs nothing and prevents a
        // silent 10 s stall if a future refactor introduces the race).
        async function drainPendingRemoteKey(): Promise<void> {
          if (!entry.keyPair || !entry.pendingRemoteKey || entry.encryptKey) return
          try {
            const { encryptKey, fingerprint: fp } = await finalizeKeyExchange({
              localPrivate: entry.keyPair.privateKey,
              localPublic: pubKeyBytes,
              remotePublic: entry.pendingRemoteKey,
            })
            entry.encryptKey = encryptKey
            if (entry.keyExchangeTimeout) { clearTimeout(entry.keyExchangeTimeout); entry.keyExchangeTimeout = undefined }
            entry.fingerprint = fp
            entry.directConnection = true
            entry.pendingRemoteKey = null
            dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { fingerprint: fp, directConnection: true } })
          } catch {
            teardownMesh(peerId, 'mesh key derivation failed')
          }
        }

        if (entry.pendingRemoteKey) await drainPendingRemoteKey()
        // Re-check after any microtask gap above.
        if (entry.pendingRemoteKey && !entry.encryptKey) await drainPendingRemoteKey()
      } catch (err) {
        console.warn('mesh handshake setup failed:', err)
        teardownMesh(peerId, 'mesh handshake failed')
      }
    })

    conn.on('data', async (data: unknown) => {
      if (destroyedRef.current) return
      const current = peerConnectionsRef.current.get(peerId)
      if (!current || current.conn !== conn) return
      if (current.heartbeat) current.heartbeat.markAlive()

      // Binary chunk packets
      if (
        data instanceof ArrayBuffer ||
        data instanceof Uint8Array ||
        (data && typeof data === 'object' && typeof (data as { byteLength?: unknown }).byteLength === 'number' && !(data as { type?: unknown }).type)
      ) {
        current.chunkQueue = (current.chunkQueue ?? Promise.resolve())
          .then(() => handleMeshChunk(current, data as ArrayBuffer))
          .catch(e => log.warn('useCollabGuest.mesh.chunkQueue', e))
        return
      }

      // Trust boundary on mesh link — typed against the collab outer
      // union. The mesh wire doesn't carry call-* messages (the host
      // relays those), so no call-* hoist is needed here.
      const msg = data as CollabUnencryptedMsg
      if (msg.type === 'pong') return
      if (msg.type === 'ping') {
        try { conn.send({ type: 'pong', ts: msg.ts } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.mesh.sendPong', e) }
        return
      }

      // Mesh ECDH key exchange.
      if (msg.type === 'public-key') {
        const remoteKeyRaw = new Uint8Array(msg.key as number[])
        if (!current.keyPair) {
          // Buffer until our keyPair is ready (initiator side may race here).
          current.pendingRemoteKey = remoteKeyRaw
          return
        }
        if (current.encryptKey) return
        try {
          const localPubBytes = await exportPublicKey(current.keyPair.publicKey)
          const { encryptKey, fingerprint: fp } = await finalizeKeyExchange({
            localPrivate: current.keyPair.privateKey,
            localPublic: localPubBytes,
            remotePublic: remoteKeyRaw,
          })
          current.encryptKey = encryptKey
          if (current.keyExchangeTimeout) { clearTimeout(current.keyExchangeTimeout); current.keyExchangeTimeout = undefined }
          current.fingerprint = fp
          current.directConnection = true
          dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { fingerprint: fp, directConnection: true } })
        } catch {
          teardownMesh(peerId, 'mesh key derivation failed')
        }
        return
      }

      // Encrypted collab messages over mesh.
      if (msg.type === 'collab-msg-enc') {
        if (!current.encryptKey || !msg.data) return
        let payload: CollabInnerMsg
        try { payload = await decryptJSON<CollabInnerMsg>(current.encryptKey, msg.data as string) }
        catch (e) { log.warn('useCollabGuest.mesh.decrypt', e); return }

        // collab-file-start (inbound download from mesh peer)
        if (payload.type === 'collab-file-start') {
          const fileId = payload.fileId as string
          const fileName = payload.name as string
          const fileSize = payload.size as number
          clearDownloadTimeout(fileId)
          const stream = createFileStream(fileName, fileSize)
          current.inProgressFiles!.set(fileId, {
            fileId,
            name: fileName,
            size: fileSize,
            totalChunks: payload.totalChunks as number,
            chunks: [],
            receivedBytes: 0,
            stream,
            startTime: Date.now(),
          })
          current.currentDownloadFileId = fileId
          dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
          return
        }

        if (payload.type === 'collab-file-end') {
          await (current.chunkQueue ?? Promise.resolve())
          const fileId = payload.fileId as string
          const inFlight = current.inProgressFiles!.get(fileId)
          if (!inFlight) return
          current.inProgressFiles!.delete(fileId)
          if (current.currentDownloadFileId === fileId) current.currentDownloadFileId = null
          if (inFlight.stream) { try { await inFlight.stream.close() } catch (e) { log.warn('useCollabGuest.mesh.fileEnd.streamClose', e) } }
          else {
            const totalLen = inFlight.chunks.reduce((s, c) => s + c.byteLength, 0)
            const fullBytes = new Uint8Array(totalLen)
            let off = 0
            for (const c of inFlight.chunks) { fullBytes.set(c, off); off += c.byteLength }
            const mimeType = filesRef.current.sharedFiles.find(f => f.id === inFlight.fileId)?.type || 'application/octet-stream'
            const blob = new Blob([fullBytes], { type: mimeType })
            const url = URL.createObjectURL(blob)
            const a = document.createElement('a')
            a.href = url
            a.download = inFlight.name
            document.body.appendChild(a)
            a.click()
            document.body.removeChild(a)
            URL.revokeObjectURL(url)
          }
          dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { status: 'complete', progress: 100 } })
          return
        }

        // Incoming request over mesh — serve it.
        if (payload.type === 'collab-request-file') {
          const fileId = payload.fileId as string
          if (myFilesRef.current.has(fileId)) {
            await sendFileToRequester(fileId, peerId)
          } else {
            // Respond over mesh that we don't have it.
            try {
              const enc = await encryptJSON(current.encryptKey, {
                type: 'collab-file-unavailable', fileId, reason: 'unknown-file',
              } satisfies CollabInnerMsg)
              conn.send({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
            } catch (e) { log.warn('useCollabGuest.mesh.requestRelay', e) }
          }
          return
        }

        if (payload.type === 'collab-pause-file') {
          const fileId = payload.fileId as string
          const t = activeTransfersRef.current.get(fileId)
          if (t) t.paused = true
          return
        }
        if (payload.type === 'collab-resume-file') {
          const fileId = payload.fileId as string
          const t = activeTransfersRef.current.get(fileId)
          if (t) {
            t.paused = false
            if (t.pauseResolver) { t.pauseResolver(); t.pauseResolver = undefined }
          }
          return
        }
        if (payload.type === 'collab-cancel-file') {
          const fileId = payload.fileId as string
          const t = activeTransfersRef.current.get(fileId)
          if (t) {
            t.aborted = true
            t.paused = false
            if (t.pauseResolver) { t.pauseResolver(); t.pauseResolver = undefined }
          }
          return
        }
        if (payload.type === 'collab-file-unavailable') {
          const fileId = payload.fileId as string
          const reason = (payload.reason as string) || 'unavailable'
          dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'error', error: reason } })
          clearDownloadTimeout(fileId)
          return
        }
        if (payload.type === 'collab-cancel-all') {
          // Abort any inbound transfers from this mesh peer.
          for (const f of current.inProgressFiles!.values()) {
            if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.mesh.cancelAll.streamAbort', e) } }
            dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: f.fileId, payload: { status: 'error', error: 'cancelled' } })
          }
          current.inProgressFiles!.clear()
          current.currentDownloadFileId = null
          return
        }
        return
      }
    })

    conn.on('close', () => { teardownMesh(peerId, 'mesh connection closed') })
    conn.on('error', (err: unknown) => {
      console.warn('mesh connection error:', err)
      teardownMesh(peerId, 'mesh connection error')
    })
  }, [teardownMesh, sendFileToRequester, clearDownloadTimeout])

  // Handle an inbound chunk over a mesh connection (per-peer routing).
  async function handleMeshChunk(entry: PeerConnection, rawData: ArrayBuffer): Promise<void> {
    if (!entry.encryptKey) return
    const buffer = rawData instanceof ArrayBuffer ? rawData : (rawData as ArrayBufferView).buffer as ArrayBuffer
    let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
    try { parsed = parseChunkPacket(buffer) } catch (e) { log.warn('useCollabGuest.handleMeshChunk.parse', e); return }
    if (parsed.fileIndex !== 0xFFFE) return
    const currentFileId = entry.currentDownloadFileId
    if (!currentFileId) return
    const inFlight = entry.inProgressFiles!.get(currentFileId)
    if (!inFlight) return
    try {
      const decrypted = await decryptChunk(entry.encryptKey, new Uint8Array(parsed.data))
      const bytes = new Uint8Array(decrypted)

      if (inFlight.stream) {
        await inFlight.stream.write(bytes)
      } else {
        if (inFlight.receivedBytes + bytes.byteLength > FALLBACK_MAX_BYTES) {
          entry.inProgressFiles!.delete(currentFileId)
          if (entry.currentDownloadFileId === currentFileId) entry.currentDownloadFileId = null
          dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: currentFileId, payload: { status: 'error', error: FALLBACK_TOO_LARGE_MSG } })
          try {
            const enc = await encryptJSON(entry.encryptKey, { type: 'collab-cancel-file', fileId: currentFileId } satisfies CollabInnerMsg)
            entry.conn?.send({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
          } catch (e) { log.warn('useCollabGuest.handleMeshChunk.cancelTooLarge', e) }
          return
        }
        inFlight.chunks.push(bytes)
      }
      inFlight.receivedBytes += bytes.byteLength
      const progress = inFlight.size > 0 ? Math.min(100, Math.round((inFlight.receivedBytes / inFlight.size) * 100)) : 0
      const elapsed = (Date.now() - inFlight.startTime) / 1000
      const speed = elapsed > 0.5 ? inFlight.receivedBytes / elapsed : 0
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { progress, speed } })
    } catch (e) {
      log.warn('useCollabGuest.handleMeshChunk.decrypt', e)
      if (inFlight.stream) { try { await inFlight.stream.abort() } catch (e2) { log.warn('useCollabGuest.handleMeshChunk.streamAbort', e2) } }
      entry.inProgressFiles!.delete(currentFileId)
      if (entry.currentDownloadFileId === currentFileId) entry.currentDownloadFileId = null
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { status: 'error', progress: 0, error: 'decrypt failed' } })
      try {
        const enc = await encryptJSON(entry.encryptKey, { type: 'collab-cancel-file', fileId: inFlight.fileId } satisfies CollabInnerMsg)
        entry.conn?.send({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
      } catch (e) { log.warn('useCollabGuest.handleMeshChunk.cancelAfterFail', e) }
    }
  }

  // Start a mesh connection to the other peer (initiator side). Uses the
  // deterministic tie-breaker: only the lower peerId initiates.
  const initiateMeshIfNeeded = useCallback((otherPeerId: string): void => {
    if (destroyedRef.current) return
    const peer = peerRef.current
    const myId = myPeerIdRef.current
    if (!peer || !myId) return
    if (otherPeerId === myId) return // self
    if (peerConnectionsRef.current.has(otherPeerId)) return // double-init guard
    // Tie-break: lower id initiates, higher id waits for incoming.
    if (!(myId < otherPeerId)) return
    try {
      const conn = peer.connect(otherPeerId, { reliable: true })
      setupMeshConnection(conn, otherPeerId, true)
    } catch (err) {
      console.warn('mesh initiate failed for', otherPeerId, err)
    }
  }, [setupMeshConnection])

  const startConnection = useCallback((withTurn: boolean, isReconnect: boolean = false): void => {
    if (!window.crypto?.subtle) { dispatchRoom({ type: 'SET_STATUS', payload: 'error' }); return }
    if (!isMountedRef.current) return
    destroyedRef.current = false
    attemptRef.current = 0
    reconnectTokenRef.current = Symbol('reconnect')
    iceConnectedRef.current = false

    if (!isReconnect) {
      useTurnRef.current = withTurn
    }

    async function connect(): Promise<void> {
      if (destroyedRef.current) return
      attemptRef.current++
      // Nit — simplify ternary to just 'joining' outside of reconnect.
      dispatchRoom({ type: 'SET_STATUS', payload: isReconnect ? 'reconnecting' : 'joining' })

      const config = useTurnRef.current ? await getWithTurn() : STUN_ONLY
      const peer = new Peer(config)
      peerRef.current = peer

      // Listen for inbound mesh DataConnections from other guests. The host
      // never initiates to us, so any incoming conn here is a mesh connection
      // by construction. Still, guard against self and stale state.
      peer.on('connection', (incoming: DataConnection) => {
        if (destroyedRef.current) { try { incoming.close() } catch (e) { log.warn('useCollabGuest.peer.incomingDestroyed', e) }; return }
        const myId = peer.id ?? myPeerIdRef.current
        if (incoming.peer === myId) { try { incoming.close() } catch (e) { log.warn('useCollabGuest.peer.incomingSelf', e) }; return }
        // Admission gate: only accept mesh connections from peerIds that
        // the host has announced as participants. Without this check any
        // party who guesses a peerId can open a DataConnection, run the
        // full ECDH handshake, and sit in the connection map consuming
        // resources. Host isn't in participants list, but the host never
        // initiates to us anyway — `incoming.peer === hostPeerId` is a
        // separate concern handled by roomId routing.
        const known = participantsRef.current.participants.some(p => p.peerId === incoming.peer)
        if (!known) {
          try { incoming.close() } catch (e) { log.warn('useCollabGuest.peer.incomingUnknown', e) }
          return
        }
        // Tie-break: responder is the higher peerId. If we happen to be the
        // lower id, prefer our outgoing attempt instead — close this inbound.
        if (myId && myId < incoming.peer) {
          try { incoming.close() } catch (e) { log.warn('useCollabGuest.peer.incomingLowerId', e) }
          return
        }
        setupMeshConnection(incoming, incoming.peer, false)
      })

      timeoutRef.current = setTimeout(() => {
        if (destroyedRef.current) return
        peer.destroy()
        if (attemptRef.current < MAX_RETRIES) connect()
        else if (isReconnect) dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
        else dispatchRoom({ type: 'SET_STATUS', payload: withTurn ? 'closed' : 'error' })
      }, TIMEOUT_MS)

      peer.on('open', (myId: string) => {
        if (destroyedRef.current) return
        dispatchRoom({ type: 'SET', payload: { myPeerId: myId } })

        const conn = peer.connect(roomId, { reliable: true })
        hostConnRef.current = conn
        setPeerInstance(peer)
        let disconnectHandled = false

        conn.on('open', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current!)
          reconnectCountRef.current = 0

          if (rttPollerRef.current) rttPollerRef.current.cleanup()
          rttPollerRef.current = setupRTTPolling(conn.peerConnection, setRtt)

          function handleDisconnect(reason: string): void {
            if (disconnectHandled || destroyedRef.current) return
            disconnectHandled = true
            if (heartbeatRef.current) heartbeatRef.current.cleanup()
            if (rttPollerRef.current) { rttPollerRef.current.cleanup(); rttPollerRef.current = null }
            if (keyExchangeTimeoutRef.current) { clearTimeout(keyExchangeTimeoutRef.current); keyExchangeTimeoutRef.current = null }
            if (directFailTimerRef.current) { clearTimeout(directFailTimerRef.current); directFailTimerRef.current = null }
            try { conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.handleDisconnect.removeListeners', e) }

            // H10 — unblock any of our outgoing uploads so their pause
            // loop exits and the async iterator can return cleanly.
            activeTransfersRef.current.forEach(t => {
              t.aborted = true
              if (t.pauseResolver) { t.pauseResolver(); t.pauseResolver = undefined }
            })
            activeTransfersRef.current.clear()

            // Close every mesh connection on host disconnect.
            for (const mpid of Array.from(peerConnectionsRef.current.keys())) {
              teardownMesh(mpid, 'host disconnected')
            }

            setRtt(null)
            setMessages(prev => [...prev, { text: reason, from: 'system', time: Date.now(), self: false }].slice(-500))

            if (reconnectCountRef.current < MAX_RECONNECTS) {
              chunkQueueRef.current = Promise.resolve()
              imageSendQueueRef.current = Promise.resolve()
              inProgressImageRef.current = null
              inProgressFilesRef.current.clear()
              currentDownloadFileIdRef.current = null
              decryptKeyRef.current = null
              keyPairRef.current = null
              reconnectCountRef.current++
              peer.destroy()
              const token = reconnectTokenRef.current
              setTimeout(() => {
                if (!isMountedRef.current || destroyedRef.current || reconnectTokenRef.current !== token) return
                startConnection(useTurnRef.current, true)
              }, RECONNECT_DELAY)
            } else {
              dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
            }
          }

          heartbeatRef.current = setupHeartbeat(conn, {
            onDead: () => handleDisconnect('Connection lost'),
          })

          keyExchangeTimeoutRef.current = setTimeout(() => {
            if (!decryptKeyRef.current && !destroyedRef.current) {
              console.warn('Key exchange timed out')
              conn.close()
            }
          }, 10_000)

          const pc = conn.peerConnection
          if (pc) {
            // conn.on('open') fires after the DataChannel is open, which means ICE
            // has already reached 'connected'/'completed'. Seed the flag from the
            // current state so the direct-failed timer doesn't false-fire.
            const initial = pc.iceConnectionState
            if (initial === 'connected' || initial === 'completed') {
              iceConnectedRef.current = true
            }
            const prevIceHandler = pc.oniceconnectionstatechange
            pc.oniceconnectionstatechange = (ev) => {
              if (typeof prevIceHandler === 'function') prevIceHandler.call(pc, ev)
              const s = pc.iceConnectionState
              if (s === 'connected' || s === 'completed') {
                iceConnectedRef.current = true
                if (directFailTimerRef.current) { clearTimeout(directFailTimerRef.current); directFailTimerRef.current = null }
              }
              if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                handleDisconnect('Host disconnected')
              }
            }
          }

          // P1 — direct-failed detection window. Only arm if ICE isn't already connected.
          if (!useTurnRef.current && !isReconnect && !iceConnectedRef.current) {
            if (directFailTimerRef.current) clearTimeout(directFailTimerRef.current)
            directFailTimerRef.current = setTimeout(() => {
              directFailTimerRef.current = null
              if (!iceConnectedRef.current && !destroyedRef.current) {
                dispatchRoom({ type: 'SET_STATUS', payload: 'direct-failed' })
              }
            }, DIRECT_FAIL_WINDOW_MS)
          }

          dispatchRoom({ type: 'SET_STATUS', payload: 'connected' })
          conn.send({ type: 'join', nickname: myNameRef.current } satisfies CollabUnencryptedMsg)
        })

        conn.on('data', async (data: unknown) => {
          if (destroyedRef.current) return
          if (heartbeatRef.current) heartbeatRef.current.markAlive()

          // Nit — tighter binary detection.
          if (
            data instanceof ArrayBuffer ||
            data instanceof Uint8Array ||
            (data && typeof data === 'object' && typeof (data as { byteLength?: unknown }).byteLength === 'number' && !(data as { type?: unknown }).type)
          ) {
            chunkQueueRef.current = chunkQueueRef.current.then(() => handleChunk(data as ArrayBuffer)).catch(e => log.warn('useCollabGuest.chunkQueue', e))
            return
          }

          // Call messages (call-*) route through useCall — aren't in the
          // collab union. Pull them off before the typed cast so the
          // discriminated switch below isn't confused by call-* literals.
          const raw = data as { type?: unknown; from?: unknown }
          if (typeof raw.type === 'string' && raw.type.startsWith('call-')) {
            if (callMessageHandlerRef.current) {
              const from = (typeof raw.from === 'string' && raw.from) || conn.peer
              try { callMessageHandlerRef.current(from, raw as Record<string, unknown>) }
              catch (e) { log.warn('useCollabGuest.callMessageHandler', e) }
            }
            return
          }

          const msg = data as CollabUnencryptedMsg

          if (msg.type === 'pong') return
          if (msg.type === 'ping') {
            try { conn.send({ type: 'pong', ts: msg.ts } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.sendPong', e) }
            return
          }

          if (msg.type === 'closing' || msg.type === 'room-closed') {
            setMessages(prev => [...prev, { text: 'Room was closed by host', from: 'system', time: Date.now(), self: false }].slice(-500))
            dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
            conn.close()
            return
          }

          if (msg.type === 'kicked') {
            setMessages(prev => [...prev, { text: 'You were removed from the room', from: 'system', time: Date.now(), self: false }].slice(-500))
            dispatchRoom({ type: 'SET_STATUS', payload: 'kicked' })
            conn.close()
            return
          }

          // C4 — password rate limit reached.
          if (msg.type === 'password-rate-limited') {
            dispatchRoom({ type: 'SET', payload: { status: 'error', errorMessage: 'Too many password attempts. Reload to retry.', passwordError: true } })
            return
          }

          // Key exchange
          if (msg.type === 'public-key') {
            if (decryptKeyRef.current) return
            try {
              if (!keyPairRef.current) {
                keyPairRef.current = await generateKeyPair()
              }
              const pubKeyBytes = await exportPublicKey(keyPairRef.current.publicKey)
              conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies CollabUnencryptedMsg)
              const remoteKeyBytes = new Uint8Array(msg.key as number[])
              const { encryptKey, fingerprint } = await finalizeKeyExchange({
                localPrivate: keyPairRef.current.privateKey,
                localPublic: pubKeyBytes,
                remotePublic: remoteKeyBytes,
              })
              decryptKeyRef.current = encryptKey
              if (keyExchangeTimeoutRef.current) { clearTimeout(keyExchangeTimeoutRef.current); keyExchangeTimeoutRef.current = null }
              dispatchRoom({ type: 'SET', payload: { fingerprint } })
            } catch {
              dispatchRoom({ type: 'SET_STATUS', payload: 'error' })
            }
            return
          }

          // Password handling
          if (msg.type === 'password-required') {
            dispatchRoom({ type: 'SET', payload: { passwordRequired: true, status: 'password-required' } })
            return
          }

          if (msg.type === 'password-accepted') {
            dispatchRoom({ type: 'SET', payload: { passwordRequired: false, passwordError: false, status: 'connected' } })
            return
          }

          if (msg.type === 'password-wrong') {
            dispatchRoom({ type: 'SET', payload: { passwordError: true } })
            return
          }

          // Online count
          if (msg.type === 'online-count') {
            dispatchParticipants({ type: 'SET_ONLINE_COUNT', count: msg.count as number })
            return
          }

          // Typing
          if (msg.type === 'typing') {
            handleTypingMessage(msg.nickname as string, setTypingUsers, typingTimeouts.current)
            return
          }

          // Reactions
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
            return
          }

          // System messages
          if (msg.type === 'system-msg') {
            setMessages(prev => [...prev, { text: msg.text as string, from: 'system', time: msg.time as number, self: false }].slice(-500))
            return
          }

          // Encrypted chat
          if (msg.type === 'chat-encrypted') {
            if (!decryptKeyRef.current || !msg.data) return
            let payload: Record<string, unknown> = {}
            try { payload = await decryptJSON(decryptKeyRef.current, msg.data as string) }
            catch (e) { log.warn('useCollabGuest.chatEncrypted.decrypt', e); return }
            setMessages(prev => [...prev, {
              id: payload.id as string | undefined,
              text: payload.text as string || '',
              image: payload.image as string | undefined,
              mime: payload.mime as string | undefined,
              replyTo: payload.replyTo as ChatMessage['replyTo'],
              from: msg.from as string || 'Sender',
              time: msg.time as number,
              self: false,
            }].slice(-500))
            return
          }

          // Collab encrypted messages
          if (msg.type === 'collab-msg-enc') {
            if (!decryptKeyRef.current || !msg.data) return
            let payload: CollabInnerMsg
            try { payload = await decryptJSON<CollabInnerMsg>(decryptKeyRef.current, msg.data as string) }
            catch (e) { log.warn('useCollabGuest.collabMsgEnc.decrypt', e); return }

            // File list from host — C2 validation.
            if (payload.type === 'collab-file-list') {
              const raw = payload.files
              if (!Array.isArray(raw)) {
                console.warn('dropped invalid collab-file-list: not an array')
                return
              }
              const validated: SharedFile[] = []
              for (const f of raw) {
                const sanitized = sanitizeSharedFile(f)
                if (!sanitized) {
                  log.warn('useCollabGuest.collabFileList.invalid', validateSharedFile(f) ?? 'unknown')
                  continue
                }
                if (sanitized.droppedReasons.length > 0) {
                  log.info('useCollabGuest.collabFileList.sanitized', sanitized.droppedReasons.join(','))
                }
                validated.push(sanitized.file)
              }
              dispatchFiles({ type: 'SET_SHARED_FILES', payload: validated })
              return
            }

            // Participant list
            if (payload.type === 'collab-participant-list') {
              const pList = payload.participants as Array<{ peerId: string; name: string; isHost: boolean }>
              const collabParticipants: CollabParticipant[] = pList.map(p => ({
                peerId: p.peerId,
                name: p.name,
                isHost: p.isHost,
                connectionStatus: 'connected',
                directConnection: p.isHost, // Direct to host, others via relay initially
              }))
              dispatchParticipants({ type: 'SET_PARTICIPANTS', payload: collabParticipants })
              // Mesh: initiate to every non-host guest where myPeerId < otherPeerId.
              for (const p of pList) {
                if (p.isHost) continue
                initiateMeshIfNeeded(p.peerId)
              }
              return
            }

            // New file shared — C2 validate + C3 origin binding.
            if (payload.type === 'collab-file-shared') {
              const sanitized = sanitizeSharedFile(payload.file)
              if (!sanitized) {
                log.warn('useCollabGuest.collabFileShared.invalid', validateSharedFile(payload.file) ?? 'unknown')
                return
              }
              if (sanitized.droppedReasons.length > 0) {
                log.info('useCollabGuest.collabFileShared.sanitized', sanitized.droppedReasons.join(','))
              }
              const fileData = sanitized.file
              const fromField = payload.from as string | undefined
              const f = fileData as SharedFile
              // C3 — the relayer must include `from`, and owner must match.
              // TODO: full origin auth requires per-guest signing keys; host can still forge if determined
              if (fromField !== undefined && f.owner !== fromField) {
                console.warn('dropped collab-file-shared: owner/from mismatch')
                return
              }
              dispatchFiles({ type: 'ADD_SHARED_FILE', payload: f })
              return
            }

            // File removed by owner — C3 origin check.
            if (payload.type === 'collab-file-removed') {
              const fileId = payload.fileId as string
              const fromField = payload.from as string | undefined
              const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
              // TODO: full origin auth requires per-guest signing keys; host can still forge if determined
              if (file && fromField !== undefined && file.owner !== fromField) {
                console.warn('dropped collab-file-removed: owner/from mismatch')
                return
              }
              dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })
              return
            }

            // H6 — Peer renamed.
            if (payload.type === 'collab-peer-renamed') {
              const peerId = payload.peerId as string
              const newName = String(payload.newName || '').slice(0, 32)
              if (!peerId || !newName) return
              dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { name: newName } })
              // M5 — update any shared files owned by that peer.
              dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: peerId, newName })
              return
            }

            // File transfer start — H2 per-fileId.
            if (payload.type === 'collab-file-start') {
              const fileId = payload.fileId as string
              const fileName = payload.name as string
              const fileSize = payload.size as number

              clearDownloadTimeout(fileId)

              const stream = createFileStream(fileName, fileSize)

              inProgressFilesRef.current.set(fileId, {
                fileId,
                name: fileName,
                size: fileSize,
                totalChunks: payload.totalChunks as number,
                chunks: [],
                receivedBytes: 0,
                stream,
                startTime: Date.now(),
              })
              currentDownloadFileIdRef.current = fileId
              dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
              return
            }

            // File transfer end — H2.
            if (payload.type === 'collab-file-end') {
              await chunkQueueRef.current
              const fileId = payload.fileId as string
              const inFlight = inProgressFilesRef.current.get(fileId)
              if (!inFlight) return
              inProgressFilesRef.current.delete(fileId)
              if (currentDownloadFileIdRef.current === fileId) {
                currentDownloadFileIdRef.current = null
              }

              if (inFlight.stream) {
                try {
                  await inFlight.stream.close()
                } catch (e) { log.warn('useCollabGuest.fileEnd.streamClose', e) }
              } else {
                // Fallback: assemble from memory chunks
                const totalLen = inFlight.chunks.reduce((s, c) => s + c.byteLength, 0)
                const fullBytes = new Uint8Array(totalLen)
                let off = 0
                for (const c of inFlight.chunks) { fullBytes.set(c, off); off += c.byteLength }

                const mimeType = filesRef.current.sharedFiles.find(f => f.id === inFlight.fileId)?.type || 'application/octet-stream'
                const blob = new Blob([fullBytes], { type: mimeType })
                const url = URL.createObjectURL(blob)

                const a = document.createElement('a')
                a.href = url
                a.download = inFlight.name
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
                URL.revokeObjectURL(url)
              }

              dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { status: 'complete', progress: 100 } })
              return
            }

            // H7 — Peer reports the owner cannot send us the file.
            if (payload.type === 'collab-file-unavailable') {
              const fileId = payload.fileId as string
              const reason = (payload.reason as string) || 'unavailable'
              dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'error', error: reason } })
              clearDownloadTimeout(fileId)
              return
            }

            // File request from another peer (via host relay).
            if (payload.type === 'collab-request-file') {
              const fileId = payload.fileId as string
              // If the request carries a requesterPeerId, it's a guest-to-guest
              // request being relayed by the host. H7 — use mesh if available.
              const requesterPeerId = (payload.requesterPeerId as string | undefined) || null
              if (myFilesRef.current.has(fileId)) {
                await sendFileToRequester(fileId, requesterPeerId)
              }
              return
            }

            // Pause / resume / cancel from the requesting peer (via host
            // relay). The host tags every forwarded control message with
            // `requesterPeerId: gs.peerId` where gs is the sender. Without
            // the match-check below, ANY guest could cancel another guest's
            // in-flight download just by knowing the fileId (both are in the
            // shared file list broadcast). `transfer.targetPeerId` is null
            // when the host itself is the requester, which matches a
            // missing requesterPeerId on host-originated control messages.
            if (
              payload.type === 'collab-pause-file' ||
              payload.type === 'collab-resume-file' ||
              payload.type === 'collab-cancel-file'
            ) {
              const fileId = payload.fileId as string
              const requesterPeerId = (payload.requesterPeerId as string | undefined) ?? null
              const transfer = activeTransfersRef.current.get(fileId)
              if (!transfer || transfer.targetPeerId !== requesterPeerId) return

              if (payload.type === 'collab-pause-file') {
                transfer.paused = true
              } else if (payload.type === 'collab-resume-file') {
                transfer.paused = false
                if (transfer.pauseResolver) {
                  transfer.pauseResolver()
                  transfer.pauseResolver = undefined
                }
              } else {
                // collab-cancel-file
                transfer.aborted = true
                transfer.paused = false
                if (transfer.pauseResolver) {
                  transfer.pauseResolver()
                  transfer.pauseResolver = undefined
                }
              }
              return
            }

            return
          }

          // P2P signaling relay from another guest
          if (msg.type === 'collab-signal') {
            // Handle P2P signaling from another guest (future enhancement)
            return
          }

          // Peer joined
          if (msg.type === 'collab-peer-joined') {
            const newPeer: CollabParticipant = {
              peerId: msg.peerId as string,
              name: msg.name as string,
              isHost: false,
              connectionStatus: 'connected',
              directConnection: false,
            }
            dispatchParticipants({ type: 'ADD_PARTICIPANT', payload: newPeer })
            setMessages(prev => [...prev, { text: `${msg.name} joined the room`, from: 'system', time: Date.now(), self: false }].slice(-500))
            // Mesh: initiate if we're the lower id.
            initiateMeshIfNeeded(msg.peerId as string)
            return
          }

          // Peer left
          if (msg.type === 'collab-peer-left') {
            const peerId = msg.peerId as string
            // Mesh: close any mesh connection we had to them.
            teardownMesh(peerId, 'peer left room')
            dispatchParticipants({ type: 'REMOVE_PARTICIPANT', peerId })
            // M1 — drop files owned by the leaving peer.
            dispatchFiles({ type: 'REMOVE_FILES_BY_OWNER', ownerId: peerId })
            setMessages(prev => [...prev, { text: `${msg.name} left the room`, from: 'system', time: Date.now(), self: false }].slice(-500))
            return
          }

          // H6 — Peer renamed notification (unencrypted sibling to the encrypted one).
          if (msg.type === 'collab-peer-renamed') {
            const peerId = msg.peerId as string
            const newName = String(msg.newName || '').slice(0, 32)
            if (!peerId || !newName) return
            dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { name: newName } })
            dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: peerId, newName })
            return
          }

          // Mid-stream abort — clear the in-progress image slot so a new
          // start message doesn't see leftover bytes from the stalled one.
          if (msg.type === 'chat-image-abort') {
            inProgressImageRef.current = null
            return
          }

          // Chat image handling
          if (msg.type === 'chat-image-start-enc') {
            if (!decryptKeyRef.current || !msg.data) return
            let meta: Record<string, unknown>
            try { meta = await decryptJSON(decryptKeyRef.current, msg.data as string) }
            catch (e) { log.warn('useCollabGuest.chatImageStart.decrypt', e); return }
            inProgressImageRef.current = {
              id: meta.id as string | undefined,
              mime: meta.mime as string || 'application/octet-stream',
              size: meta.size as number || 0,
              text: meta.text as string || '',
              replyTo: meta.replyTo as { text: string; from: string; time: number } | null,
              time: meta.time as number || Date.now(),
              from: msg.from as string || 'Sender',
              duration: meta.duration as number | undefined,
              chunks: [],
              receivedBytes: 0,
            }
            return
          }

          if (msg.type === 'chat-image-end-enc') {
            await chunkQueueRef.current
            const inFlight = inProgressImageRef.current
            inProgressImageRef.current = null
            if (!inFlight) return
            const blob = new Blob(inFlight.chunks as unknown as BlobPart[], { type: inFlight.mime })
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
            return
          }
        })

        conn.on('close', () => {
          if (destroyedRef.current || disconnectHandled) return
          disconnectHandled = true
          try { conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.close.removeListeners', e) }
          if (heartbeatRef.current) heartbeatRef.current.cleanup()
          if (rttPollerRef.current) { rttPollerRef.current.cleanup(); rttPollerRef.current = null }

          // H10 — unblock paused transfers
          activeTransfersRef.current.forEach(t => {
            t.aborted = true
            if (t.pauseResolver) { t.pauseResolver(); t.pauseResolver = undefined }
          })
          activeTransfersRef.current.clear()

          setRtt(null)
          setMessages(prev => [...prev, { text: 'Disconnected from room', from: 'system', time: Date.now(), self: false }].slice(-500))
          dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
        })

        conn.on('error', () => {
          if (destroyedRef.current) return
          dispatchRoom({ type: 'SET_STATUS', payload: 'error' })
        })
      })

      peer.on('disconnected', () => {
        if (destroyedRef.current) return
        if (!peer.destroyed) peer.reconnect()
      })

      peer.on('error', (err: { type: string }) => {
        if (destroyedRef.current) return
        if (err.type === 'peer-unavailable') {
          dispatchRoom({ type: 'SET_STATUS', payload: 'error' })
          setMessages(prev => [...prev, { text: 'Room not found', from: 'system', time: Date.now(), self: false }].slice(-500))
        } else if (err.type === 'disconnected' || err.type === 'network') {
          return
        }
      })
    }

    connect()
  }, [roomId, sendFileToRequester, clearDownloadTimeout, setupMeshConnection, initiateMeshIfNeeded, teardownMesh])

  // Handle incoming chunks (H2 — per-fileId routing, H9 — fallback cap).
  async function handleChunk(rawData: ArrayBuffer): Promise<void> {
    if (!decryptKeyRef.current) return
    const buffer = rawData instanceof ArrayBuffer ? rawData : (rawData as ArrayBufferView).buffer as ArrayBuffer

    let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
    try {
      parsed = parseChunkPacket(buffer)
    } catch (e) { log.warn('useCollabGuest.handleChunk.parse', e); return }

    // Chat image chunk
    if (parsed.fileIndex === CHAT_IMAGE_FILE_INDEX) {
      if (!inProgressImageRef.current) return
      try {
        const decrypted = await decryptChunk(decryptKeyRef.current, new Uint8Array(parsed.data))
        inProgressImageRef.current.chunks.push(new Uint8Array(decrypted))
        inProgressImageRef.current.receivedBytes += decrypted.byteLength
      } catch (e) { log.warn('useCollabGuest.handleChunk.chatImageDecrypt', e) }
      return
    }

    // Collab file chunk — H2 route by current file id.
    if (parsed.fileIndex === 0xFFFE) {
      const currentFileId = currentDownloadFileIdRef.current
      if (!currentFileId) return
      const inFlight = inProgressFilesRef.current.get(currentFileId)
      if (!inFlight) return
      try {
        const decrypted = await decryptChunk(decryptKeyRef.current, new Uint8Array(parsed.data))
        const bytes = new Uint8Array(decrypted)

        if (inFlight.stream) {
          await inFlight.stream.write(bytes)
        } else {
          // H9 — fallback cap.
          if (inFlight.receivedBytes + bytes.byteLength > FALLBACK_MAX_BYTES) {
            inProgressFilesRef.current.delete(currentFileId)
            if (currentDownloadFileIdRef.current === currentFileId) currentDownloadFileIdRef.current = null
            dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: currentFileId, payload: { status: 'error', error: FALLBACK_TOO_LARGE_MSG } })
            // M7 — notify sender to stop.
            try {
              const enc = await encryptJSON(decryptKeyRef.current!, { type: 'collab-cancel-file', fileId: currentFileId } satisfies CollabInnerMsg)
              sendToHost({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
            } catch (e) { log.warn('useCollabGuest.handleChunk.cancelTooLarge', e) }
            return
          }
          inFlight.chunks.push(bytes)
        }

        inFlight.receivedBytes += bytes.byteLength

        // Throttled progress update.
        const progress = inFlight.size > 0 ? Math.min(100, Math.round((inFlight.receivedBytes / inFlight.size) * 100)) : 0
        const elapsed = (Date.now() - inFlight.startTime) / 1000
        const speed = elapsed > 0.5 ? inFlight.receivedBytes / elapsed : 0

        dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { progress, speed } })
      } catch {
        // Chunk decryption or write failed — abort stream and mark error.
        if (inFlight.stream) {
          try { await inFlight.stream.abort() } catch (e) { log.warn('useCollabGuest.handleChunk.streamAbort', e) }
        }
        inProgressFilesRef.current.delete(currentFileId)
        if (currentDownloadFileIdRef.current === currentFileId) currentDownloadFileIdRef.current = null
        dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { status: 'error', progress: 0, error: 'decrypt failed' } })
        // M7 — tell sender to stop streaming.
        try {
          const enc = await encryptJSON(decryptKeyRef.current!, { type: 'collab-cancel-file', fileId: inFlight.fileId } satisfies CollabInnerMsg)
          sendToHost({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
        } catch (e) { log.warn('useCollabGuest.handleChunk.cancelAfterFail', e) }
      }
      return
    }
  }

  // Start connection on mount
  useEffect(() => {
    isMountedRef.current = true
    startConnection(false)

    const handleOnline = (): void => {
      if (!isMountedRef.current) return
      // Fresh network → fresh reconnect budget.
      reconnectCountRef.current = 0
      if (hostConnRef.current && !hostConnRef.current.open && !destroyedRef.current) {
        startConnection(useTurnRef.current, true)
      }
    }
    window.addEventListener('online', handleOnline)

    const handleVisibility = (): void => {
      if (!isMountedRef.current || destroyedRef.current) return
      if (typeof document === 'undefined') return
      if (document.visibilityState !== 'visible') return
      if (heartbeatRef.current) heartbeatRef.current.markAlive()
      const p = peerRef.current
      if (p && p.disconnected && !p.destroyed) {
        try { p.reconnect() } catch (e) { log.warn('useCollabGuest.visibilityReconnect', e) }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)
      isMountedRef.current = false
      destroyedRef.current = true
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (heartbeatRef.current) heartbeatRef.current.cleanup()
      if (rttPollerRef.current) rttPollerRef.current.cleanup()
      if (keyExchangeTimeoutRef.current) clearTimeout(keyExchangeTimeoutRef.current)
      if (directFailTimerRef.current) clearTimeout(directFailTimerRef.current)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      // Abort any in-progress file streams
      inProgressFilesRef.current.forEach(f => {
        if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.unmount.streamAbort', e) } }
      })
      inProgressFilesRef.current.clear()
      currentDownloadFileIdRef.current = null
      downloadTimeoutsRef.current.forEach(t => clearTimeout(t))
      downloadTimeoutsRef.current.clear()
      if (hostConnRef.current) {
        try { hostConnRef.current.removeAllListeners() } catch (e) { log.warn('useCollabGuest.unmount.hostRemoveListeners', e) }
        try { hostConnRef.current.close() } catch (e) { log.warn('useCollabGuest.unmount.hostClose', e) }
      }
      // Close every mesh connection on unmount.
      for (const entry of peerConnectionsRef.current.values()) {
        if (entry.keyExchangeTimeout) clearTimeout(entry.keyExchangeTimeout)
        if (entry.heartbeat) { try { entry.heartbeat.cleanup() } catch (e) { log.warn('useCollabGuest.unmount.meshHeartbeat', e) } }
        if (entry.inProgressFiles) {
          for (const f of entry.inProgressFiles.values()) {
            if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.unmount.meshStreamAbort', e) } }
          }
        }
        if (entry.conn) {
          try { entry.conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.unmount.meshRemoveListeners', e) }
          try { entry.conn.close() } catch (e) { log.warn('useCollabGuest.unmount.meshClose', e) }
        }
      }
      peerConnectionsRef.current.clear()
      if (peerRef.current) peerRef.current.destroy()
      imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useCollabGuest.unmount.revokeBlob', e) } })
      setPeerInstance(null)
    }
  }, [startConnection])

  // Submit password — H12: clear passwordError on new attempt.
  const submitPassword = useCallback(async (password: string): Promise<void> => {
    if (!decryptKeyRef.current) return
    dispatchRoom({ type: 'SET', payload: { passwordError: false } })
    try {
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(password))
      sendToHost({ type: 'password-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)) } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.submitPassword', e) }
  }, [sendToHost])

  // Send message
  const sendMessage = useCallback(async (text: string, image?: { bytes: Uint8Array; mime: string; duration?: number } | string, replyTo?: ChatMessage['replyTo']): Promise<void> => {
    if (!text && !image) return
    if (!decryptKeyRef.current) return
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
      const localBlob = new Blob([bytes as unknown as BlobPart], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { id, text: text || '', image: localUrl, mime, duration, replyTo, from: 'You', time, self: true }].slice(-500))

      imageSendQueueRef.current = imageSendQueueRef.current
        .then(() => {
          const conn = hostConnRef.current
          const key = decryptKeyRef.current
          if (!conn || !key) return
          return streamImageToHost(conn, key, bytes, mime, text || '', replyTo ?? null, nickname, time, duration, id)
        })
        .catch(err => { console.warn('image send failed:', err) })
      return
    }

    const imgStr = image as string | undefined
    const id = crypto.randomUUID()
    setMessages(prev => [...prev, { id, text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ id, text, image: imgStr, replyTo })
    try {
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(payload))
      sendToHost({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), nickname, time } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.sendMessage.chatEncrypt', e) }
  }, [sendToHost, nickname])

  const sendTyping = useCallback((): void => {
    sendToHost({ type: 'typing', nickname } satisfies CollabUnencryptedMsg)
  }, [sendToHost, nickname])

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
    sendToHost({ type: 'reaction', msgId, emoji, nickname } satisfies CollabUnencryptedMsg)
  }, [sendToHost, nickname])

  const setMyName = useCallback((name: string): void => {
    const newName = (name.trim() || generateNickname()).slice(0, 32)
    const oldName = nickname
    setNickname(newName)
    dispatchRoom({ type: 'SET', payload: { myName: newName } })
    // Also update locally shown ownerName for my own files.
    if (room.myPeerId) {
      dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: room.myPeerId, newName })
    }
    sendToHost({ type: 'nickname-change', oldName, newName } satisfies CollabUnencryptedMsg)
  }, [sendToHost, nickname, room.myPeerId])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useCollabGuest.clearMessages.revokeBlob', e) } })
    imageBlobUrlsRef.current = []
  }, [])

  // Tear the peer down and reconnect with TURN-only policy. Called when the
  // UI offers a "Use relay" button after a direct connection has clearly
  // failed. No separate `retryWithRelay` export — the prior split was a
  // rename that never happened; one entry point is enough.
  const enableRelay = useCallback((): void => {
    destroyedRef.current = true
    if (peerRef.current) peerRef.current.destroy()
    setTimeout(() => startConnection(true), 100)
  }, [startConnection])

  const leave = useCallback((): void => {
    destroyedRef.current = true
    // Abort any StreamSaver writers before destroying the peer. Without
    // this, partial files keep bleeding to disk until GC runs.
    inProgressFilesRef.current.forEach(f => {
      if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.leave.streamAbort', e) } }
    })
    inProgressFilesRef.current.clear()
    currentDownloadFileIdRef.current = null
    downloadTimeoutsRef.current.forEach(t => clearTimeout(t))
    downloadTimeoutsRef.current.clear()
    // Same cleanup as unmount for mesh entries — any pending per-peer
    // StreamSaver writer would otherwise outlive the room.
    for (const entry of peerConnectionsRef.current.values()) {
      if (entry.keyExchangeTimeout) clearTimeout(entry.keyExchangeTimeout)
      if (entry.heartbeat) { try { entry.heartbeat.cleanup() } catch (e) { log.warn('useCollabGuest.leave.meshHeartbeat', e) } }
      if (entry.inProgressFiles) {
        for (const f of entry.inProgressFiles.values()) {
          if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.leave.meshStreamAbort', e) } }
        }
        entry.inProgressFiles.clear()
      }
    }
    if (hostConnRef.current) {
      try { hostConnRef.current.close() } catch (e) { log.warn('useCollabGuest.leave.hostClose', e) }
    }
    if (peerRef.current) peerRef.current.destroy()
    dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
  }, [])

  // Pause/Resume/Cancel functions
  // Send a control message (pause / resume / cancel) to the peer that is
  // actually serving this file. The earlier implementation sent plaintext
  // `{ type: 'collab-pause-file', fileId }` directly over the host data
  // channel, but the host only reads control messages inside the encrypted
  // `collab-msg-enc` envelope — the plain messages were silently dropped,
  // which is why the UI buttons did nothing.
  //
  // Route selection mirrors requestFile: prefer the mesh connection to the
  // file owner when available, otherwise relay through the host.
  const sendFileControl = useCallback(async (
    fileId: string,
    type: 'collab-pause-file' | 'collab-resume-file' | 'collab-cancel-file',
  ): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    const owner = file?.owner
    const meshConn = owner ? peerConnectionsRef.current.get(owner) : undefined
    if (meshConn?.conn && meshConn.encryptKey) {
      try {
        const enc = await encryptJSON(meshConn.encryptKey, { type, fileId } satisfies CollabInnerMsg)
        meshConn.conn.send({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
        return
      } catch (e) { log.warn(`useCollabGuest.${type}.mesh`, e) }
    }
    if (!decryptKeyRef.current) return
    try {
      const enc = await encryptJSON(decryptKeyRef.current, { type, fileId } satisfies CollabInnerMsg)
      sendToHost({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn(`useCollabGuest.${type}.viaHost`, e) }
  }, [sendToHost])

  const pauseFile = useCallback((fileId: string): void => {
    void sendFileControl(fileId, 'collab-pause-file')
    dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'paused' } })
  }, [sendFileControl])

  const resumeFile = useCallback((fileId: string): void => {
    void sendFileControl(fileId, 'collab-resume-file')
    dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'downloading' } })
  }, [sendFileControl])

  const cancelFile = useCallback((fileId: string): void => {
    void sendFileControl(fileId, 'collab-cancel-file')
    clearDownloadTimeout(fileId)

    // Abort a host-relayed download if that's the active path for this fileId.
    const cur = inProgressFilesRef.current.get(fileId)
    if (cur) {
      if (cur.stream) { try { cur.stream.abort() } catch (e) { log.warn('useCollabGuest.cancelFile.streamAbort', e) } }
      inProgressFilesRef.current.delete(fileId)
      if (currentDownloadFileIdRef.current === fileId) currentDownloadFileIdRef.current = null
    }

    // Abort a mesh download for the same fileId on the owner's mesh entry.
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    const meshEntry = file?.owner ? peerConnectionsRef.current.get(file.owner) : undefined
    const meshInFlight = meshEntry?.inProgressFiles?.get(fileId)
    if (meshEntry && meshInFlight) {
      if (meshInFlight.stream) { try { meshInFlight.stream.abort() } catch (e) { log.warn('useCollabGuest.cancelFile.meshStreamAbort', e) } }
      meshEntry.inProgressFiles!.delete(fileId)
      if (meshEntry.currentDownloadFileId === fileId) meshEntry.currentDownloadFileId = null
    }

    dispatchFiles({ type: 'REMOVE_DOWNLOAD', fileId })
  }, [sendFileControl, clearDownloadTimeout])

  // Clear a download entry (e.g. dismiss an error chip)
  const clearDownload = useCallback((fileId: string): void => {
    dispatchFiles({ type: 'REMOVE_DOWNLOAD', fileId })
  }, [])

  // M4 — don't wipe sharedFiles; only clear `downloads`.
  //
  // The earlier implementation fired a plaintext `collab-cancel-all` straight
  // over the host channel, but the host only handles control messages out of
  // the `collab-msg-enc` envelope — the message was dropped and the owner
  // kept streaming bytes even though the downloader side cleared its
  // progress chips. Route a per-file encrypted cancel through
  // sendFileControl so the owner actually stops (and so active mesh peers
  // also get notified).
  const cancelAll = useCallback((): void => {
    const snap = filesRef.current
    for (const [fileId, dl] of Object.entries(snap.downloads)) {
      if (dl.status === 'complete' || dl.status === 'error') continue
      void sendFileControl(fileId, 'collab-cancel-file')
    }

    // Abort every in-progress stream on the host-relay path.
    inProgressFilesRef.current.forEach(f => {
      if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.cancelAll.streamAbort', e) } }
    })
    inProgressFilesRef.current.clear()
    currentDownloadFileIdRef.current = null

    // Abort every in-progress stream on each mesh peer we were pulling from.
    peerConnectionsRef.current.forEach(entry => {
      if (!entry.inProgressFiles) return
      entry.inProgressFiles.forEach(f => {
        if (f.stream) { try { f.stream.abort() } catch (e) { log.warn('useCollabGuest.cancelAll.meshStreamAbort', e) } }
      })
      entry.inProgressFiles.clear()
      entry.currentDownloadFileId = null
    })

    downloadTimeoutsRef.current.forEach(t => clearTimeout(t))
    downloadTimeoutsRef.current.clear()
    dispatchFiles({ type: 'CANCEL_ALL_DOWNLOADS' })
  }, [sendFileControl])

  // H1 — derived uploading flag.
  const uploading = Object.keys(transfer.uploads).length > 0

  return {
    // Room state
    roomId: room.roomId,
    status: room.status,
    myPeerId: room.myPeerId,
    myName: nickname,
    isHost: false,
    fingerprint: room.fingerprint,
    passwordRequired: room.passwordRequired,
    passwordError: room.passwordError,
    errorMessage: room.errorMessage,

    // Participants
    participants: participants.participants,
    onlineCount: participants.onlineCount,

    // Files
    sharedFiles: files.sharedFiles,
    downloads: files.downloads,
    mySharedFiles: files.mySharedFiles,

    // Transfer (H1)
    uploading,
    uploads: transfer.uploads,

    // Chat
    messages,
    typingUsers,
    rtt,

    // For useCall
    peer: peerInstance,
    hostPeerId: roomId,
    participantsList: participants.participants.map(p => ({ peerId: p.peerId, name: p.name })),
    setCallMessageHandler,
    sendCallMessage,
    sendToHost,

    // Actions
    submitPassword,
    setMyName,
    shareFile,
    removeFile,
    requestFile,
    sendMessage,
    sendTyping,
    sendReaction,
    clearMessages,
    changeNickname: setMyName,
    enableRelay,
    leave,

    // FileList-compatible actions
    pauseFile,
    resumeFile,
    cancelFile,
    clearDownload,
    cancelAll,
  }
}

// Stream image to host
async function streamImageToHost(
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
    // Mid-stream failure — emit abort so the host/peer clears its slot
    // instead of holding partial bytes until the next start message.
    log.warn('useCollabGuest.streamImageToHost', e)
    try { conn.send({ type: 'chat-image-abort' } satisfies CollabUnencryptedMsg) } catch (ne) { log.warn('useCollabGuest.streamImageToHost.notifyAbort', ne) }
    throw e
  }
}
