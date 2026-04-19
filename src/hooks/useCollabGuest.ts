import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, uint8ToBase64 } from '../utils/crypto'
import { finalizeKeyExchange } from '../net/keyExchange'
import { createSession, type Session } from '../net/session'
import { STUN_ONLY, getWithTurn } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { parseChunkPacket, buildChunkPacket, waitForBufferDrain, CHAT_IMAGE_FILE_INDEX } from '../utils/fileChunker'
import { createFileStream, type FileStreamHandle } from '../utils/streamWriter'
import { sendFile, createFileReceiver, createCollabWire, type CollabWire, type FileReceiver } from '../net/transferEngine'
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
  DOWNLOAD_REQUEST_TIMEOUT_MS,
} from '../net/config'
import type { CollabInnerMsg, CollabUnencryptedMsg } from '../net/protocol'
import { log } from '../utils/logger'

// ── Constants ────────────────────────────────────────────────────────────

// P1 — if direct P2P hasn't reached 'connected' within this window, surface
// a direct-failed status so the user can opt into relay.
const DIRECT_FAIL_WINDOW_MS = 10_000

// ── Types ────────────────────────────────────────────────────────────────

// Per-mesh-peer accounting that doesn't belong on Session. Everything else
// (handshake, liveness, lanes, fingerprint) is on `session`.
interface MeshMeta {
  wire: CollabWire
  receiver: FileReceiver
}

interface MeshEntry {
  session: Session
  meta: MeshMeta
}

// Host-conn inbound transfer tracking.
interface GuestHostMeta {
  wire: CollabWire
  receiver: FileReceiver
}

// Hook-level router for outbound transfers: fileId -> the session that holds
// the actual TransferHandle. `targetPeerId === null` means the transfer
// flows through the host relay; any other value is a direct mesh transfer
// to that specific guest. The handle lives in session.activeTransfers; this
// map just tells us WHICH session to dispatch pause/resume/cancel on when
// a control message arrives over the host conn.
interface ActiveTransferRoute {
  targetPeerId: string | null
  session: Session
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
  // Host connection — a single Session that replaces hostConnRef,
  // decryptKeyRef, keyPairRef, heartbeatRef, rttPollerRef,
  // keyExchangeTimeoutRef, chunkQueueRef, imageSendQueueRef,
  // inProgressImageRef, and hostUploadQueueRef.
  const hostSessionRef = useRef<Session | null>(null)
  const hostMetaRef = useRef<GuestHostMeta | null>(null)
  const destroyedRef = useRef<boolean>(false)
  const attemptRef = useRef<number>(0)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const useTurnRef = useRef<boolean>(false)
  const reconnectCountRef = useRef<number>(0)
  const imageBlobUrlsRef = useRef<string[]>([])
  const myFilesRef = useRef<Map<string, File>>(new Map())
  const isMountedRef = useRef<boolean>(true)
  const reconnectTokenRef = useRef<symbol>(Symbol('reconnect'))
  // P1 — track whether we've reached ICE 'connected' so we can detect
  // direct-failed after DIRECT_FAIL_WINDOW_MS.
  const iceConnectedRef = useRef<boolean>(false)
  const directFailTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // M2 — request-timeout timers keyed by fileId.
  const downloadTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  // Outbound transfer router — fileId -> { targetPeerId, session-that-owns-the-handle }.
  // Plain TransferHandle lives inside session.activeTransfers; this map
  // lets a host-relayed control message find the right session without
  // walking every mesh entry.
  const activeTransferRoutesRef = useRef<Map<string, ActiveTransferRoute>>(new Map())

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
  const peerConnectionsRef = useRef<Map<string, MeshEntry>>(new Map())

  // For calls
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((msg: Record<string, unknown>): void => {
    const sess = hostSessionRef.current
    if (sess && sess.conn.open) { try { sess.send(msg) } catch (e) { log.warn('useCollabGuest.sendCallMessage', e) } }
  }, [])

  // Send to host (for relaying or direct communication)
  const sendToHost = useCallback((msg: Record<string, unknown>): void => {
    const sess = hostSessionRef.current
    if (sess && sess.conn.open) { try { sess.send(msg) } catch (e) { log.warn('useCollabGuest.sendToHost', e) } }
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
    const hostSess = hostSessionRef.current
    if (!hostSess?.encryptKey) return

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
    const meshEntry = peerConnectionsRef.current.get(ownerId)
    if (meshEntry?.session.conn && meshEntry.session.encryptKey) {
      try {
        const encrypted = await encryptJSON(meshEntry.session.encryptKey, { type: 'collab-request-file', fileId } satisfies CollabInnerMsg)
        meshEntry.session.send({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
        return
      } catch (e) { log.warn('useCollabGuest.requestFile.mesh', e) }
    }

    // Fall back to host relay — include owner so host can relay to correct peer.
    try {
      const encrypted = await encryptJSON(hostSess.encryptKey, { type: 'collab-request-file', fileId, owner: ownerId } satisfies CollabInnerMsg)
      sendToHost({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.requestFile.viaHost', e) }
  }, [sendToHost, scheduleDownloadTimeout])

  // Share a file
  const shareFile = useCallback(async (file: File): Promise<void> => {
    const hostSess = hostSessionRef.current
    if (!hostSess?.encryptKey || !room.myPeerId) return

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
      const encrypted = await encryptJSON(hostSess.encryptKey, {
        type: 'collab-file-shared',
        file: sharedFile,
      } satisfies CollabInnerMsg)
      sendToHost({ type: 'collab-msg-enc', data: encrypted } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.shareFile.announce', e) }
  }, [sendToHost, room.myPeerId])

  // Remove a file that I shared
  const removeFile = useCallback(async (fileId: string): Promise<void> => {
    const hostSess = hostSessionRef.current
    if (!hostSess?.encryptKey || !room.myPeerId) return

    // Only remove if I own this file
    if (!filesRef.current.mySharedFiles.has(fileId)) return

    // Remove locally
    myFilesRef.current.delete(fileId)
    dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })

    // Notify host (who will broadcast to others). Include `from` for C3.
    try {
      const encrypted = await encryptJSON(hostSess.encryptKey, {
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
    let targetSession: Session | null = null
    let targetPeerId: string | null = null
    let wire: CollabWire | null = null

    if (requesterPeerId) {
      const mesh = peerConnectionsRef.current.get(requesterPeerId)
      if (mesh?.session.conn?.open && mesh.session.encryptKey) {
        targetSession = mesh.session
        targetPeerId = requesterPeerId
        wire = mesh.meta.wire
      } else {
        // H7 — no direct mesh. Tell the requester we can't send (through host).
        const hostSess = hostSessionRef.current
        if (hostSess?.encryptKey) {
          try {
            const enc = await encryptJSON(hostSess.encryptKey, {
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
      const hostSess = hostSessionRef.current
      if (!hostSess?.encryptKey) return
      targetSession = hostSess
      targetPeerId = null
      wire = hostMetaRef.current?.wire ?? null
    }

    if (!targetSession || !targetSession.encryptKey || !wire) return

    const sendSession = targetSession
    const sendWire = wire

    // Drop a route entry so host-relayed control messages can find the right session.
    activeTransferRoutesRef.current.set(fileId, { targetPeerId, session: sendSession })

    // Runs inside an uploadQueue so concurrent requests on the same data
    // channel can't interleave packets.
    const runTransfer = async (): Promise<void> => {
      dispatchTransfer({ type: 'START_UPLOAD', fileId, fileName: file.name })
      try {
        await sendFile(sendSession, file, sendWire, {
          fileId,
          onProgress: (bytesSent, totalBytes) => {
            const elapsed = 0  // sendFile doesn't provide elapsed; derive from ratio
            void elapsed
            const progress = totalBytes > 0 ? Math.min(100, Math.round((bytesSent / totalBytes) * 100)) : 0
            const speed = 0  // speed tracking removed; sendFile progress gives bytes
            dispatchTransfer({ type: 'UPDATE_UPLOAD', fileId, progress, speed })
          },
        })
      } finally {
        activeTransferRoutesRef.current.delete(fileId)
        dispatchTransfer({ type: 'END_UPLOAD', fileId })
      }
    }

    const next = sendSession.uploadQueue
      .then(runTransfer)
      .catch(e => log.warn('useCollabGuest.sendFileToRequester.queue', e))
    sendSession.uploadQueue = next
    await next
  }, [sendToHost])

  // ── Mesh (guest ↔ guest) ─────────────────────────────────────────────
  // Tear down a single mesh Session, abort any outbound transfers routed
  // through it, and mark the participant as no-longer-directly-connected.
  const teardownMesh = useCallback((peerId: string, _reason: string): void => {
    const entry = peerConnectionsRef.current.get(peerId)
    if (!entry) return
    peerConnectionsRef.current.delete(peerId)
    // Session-level cleanup — heartbeat, rttPoller, keyExchangeTimeout,
    // active transfers (per-mesh-peer outbound uploads) all unblocked
    // via close(). Idempotent.
    entry.session.close('peer-disconnect')
    // Clear router entries that pointed at this now-dead session.
    for (const [fid, route] of activeTransferRoutesRef.current) {
      if (route.session === entry.session) activeTransferRoutesRef.current.delete(fid)
    }
    try { entry.session.conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.mesh.teardown.removeListeners', e) }
    try { entry.session.conn.close() } catch (e) { log.warn('useCollabGuest.mesh.teardown.close', e) }
    dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { fingerprint: undefined, directConnection: false } })
  }, [])

  // Wire up a mesh DataConnection (either outgoing initiator or incoming
  // responder). Mirrors the host-guest handshake: ECDH via 'public-key',
  // then expects 'collab-msg-enc' / chunk packets over the same conn.
  const setupMeshConnection = useCallback((conn: DataConnection, peerId: string, _isInitiator: boolean): void => {
    if (destroyedRef.current) { try { conn.close() } catch (e) { log.warn('useCollabGuest.mesh.setup.closeDestroyed', e) }; return }
    // M-l — peerId rejoin. If we already have an entry for this peerId we
    // always tear it down before seeding a fresh one, regardless of
    // `conn.open`. The old behaviour dropped the new conn when the old
    // socket still showed `open === true`, and overwrote the entry when
    // `open === false` without first cleaning up heartbeat/session refs —
    // both produced orphaned Session objects that outlived the mesh peer.
    const existing = peerConnectionsRef.current.get(peerId)
    if (existing) {
      teardownMesh(peerId, 'rejoined')
    }

    // Seed a fresh entry.
    const session = createSession({ conn, role: 'collab-guest-mesh' })
    session.dispatch({ type: 'connect-start' })
    const meshWire = createCollabWire()
    const entry: MeshEntry = {
      session,
      meta: {
        wire: meshWire,
        receiver: createFileReceiver(session, meshWire),
      },
    }
    peerConnectionsRef.current.set(peerId, entry)

    conn.on('open', async () => {
      if (destroyedRef.current) { try { conn.close() } catch (e) { log.warn('useCollabGuest.mesh.open.closeDestroyed', e) }; return }
      session.dispatch({ type: 'conn-open' })
      // Heartbeat for dead-mesh detection.
      session.heartbeat = setupHeartbeat(conn, {
        onDead: () => teardownMesh(peerId, 'mesh connection lost'),
      })

      try {
        session.setKeyPair(await generateKeyPair())
        const pubKeyBytes = await exportPublicKey(session.keyPair!.publicKey)
        try { session.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.mesh.sendPublicKey', e) }

        session.keyExchangeTimeout = setTimeout(() => {
          if (!session.encryptKey) {
            console.warn('mesh key exchange timed out for', peerId)
            teardownMesh(peerId, 'mesh key exchange timed out')
          }
        }, 10_000)

        // If we received the remote key before our keyPair was ready, finish
        // the handshake here. We also re-check at the end to cover the narrow
        // window where the remote public-key lands between this check and the
        // data handler's own derive path (can't actually happen today because
        // session.keyPair is set before this point and the data handler will
        // derive directly, but the re-check costs nothing and prevents a
        // silent 10 s stall if a future refactor introduces the race).
        async function drainPendingRemoteKey(): Promise<void> {
          if (!session.keyPair || !session.pendingRemoteKey || session.encryptKey) return
          try {
            const { encryptKey, fingerprint: fp } = await finalizeKeyExchange({
              localPrivate: session.keyPair.privateKey,
              localPublic: pubKeyBytes,
              remotePublic: session.pendingRemoteKey,
            })
            session.dispatch({ type: 'keys-derived', encryptKey, fingerprint: fp })
            session.pendingRemoteKey = null
            dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { fingerprint: fp, directConnection: true } })
          } catch {
            teardownMesh(peerId, 'mesh key derivation failed')
          }
        }

        if (session.pendingRemoteKey) await drainPendingRemoteKey()
        // Re-check after any microtask gap above.
        if (session.pendingRemoteKey && !session.encryptKey) await drainPendingRemoteKey()
      } catch (err) {
        console.warn('mesh handshake setup failed:', err)
        teardownMesh(peerId, 'mesh handshake failed')
      }
    })

    conn.on('data', async (data: unknown) => {
      if (destroyedRef.current) return
      const current = peerConnectionsRef.current.get(peerId)
      if (!current || current.session !== session) return
      if (session.heartbeat) session.heartbeat.markAlive()

      // Binary chunk packets
      if (
        data instanceof ArrayBuffer ||
        data instanceof Uint8Array ||
        (data && typeof data === 'object' && typeof (data as { byteLength?: unknown }).byteLength === 'number' && !(data as { type?: unknown }).type)
      ) {
        const raw = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer as ArrayBuffer
        let packet: ReturnType<typeof parseChunkPacket>
        try { packet = parseChunkPacket(raw) } catch (e) { log.warn('useCollabGuest.mesh.chunkQueue.parse', e); return }
        session.chunkQueue = session.chunkQueue
          .then(() => current.meta.receiver.onChunk(packet))
          .catch(e => log.warn('useCollabGuest.mesh.chunkQueue', e))
        return
      }

      // Trust boundary on mesh link — typed against the collab outer
      // union. The mesh wire doesn't carry call-* messages (the host
      // relays those), so no call-* hoist is needed here.
      const msg = data as CollabUnencryptedMsg
      if (msg.type === 'pong') return
      if (msg.type === 'ping') {
        try { session.send({ type: 'pong', ts: msg.ts } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.mesh.sendPong', e) }
        return
      }

      // Mesh ECDH key exchange.
      if (msg.type === 'public-key') {
        const remoteKeyRaw = new Uint8Array(msg.key as number[])
        if (!session.keyPair) {
          // Buffer until our keyPair is ready (initiator side may race here).
          session.pendingRemoteKey = remoteKeyRaw
          return
        }
        if (session.encryptKey) return
        try {
          const localPubBytes = await exportPublicKey(session.keyPair.publicKey)
          const { encryptKey, fingerprint: fp } = await finalizeKeyExchange({
            localPrivate: session.keyPair.privateKey,
            localPublic: localPubBytes,
            remotePublic: remoteKeyRaw,
          })
          session.dispatch({ type: 'keys-derived', encryptKey, fingerprint: fp })
          dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { fingerprint: fp, directConnection: true } })
        } catch {
          teardownMesh(peerId, 'mesh key derivation failed')
        }
        return
      }

      // Encrypted collab messages over mesh.
      if (msg.type === 'collab-msg-enc') {
        if (!session.encryptKey || !msg.data) return
        let payload: CollabInnerMsg
        try { payload = await decryptJSON<CollabInnerMsg>(session.encryptKey, msg.data as string) }
        catch (e) {
          session.decryptFailures++
          log.warn('useCollabGuest.mesh.decrypt', e)
          if (session.decryptFailures >= 10) {
            log.warn('useCollabGuest.mesh.tooManyFailures', session.peerId)
            session.close('error')
          }
          return
        }
        session.decryptFailures = 0

        // collab-file-start (inbound download from mesh peer)
        if (payload.type === 'collab-file-start') {
          const fileId = payload.fileId as string
          const fileName = payload.name as string
          const fileSize = payload.size as number
          const totalChunks = payload.totalChunks as number
          const packetIndex = payload.packetIndex as number
          clearDownloadTimeout(fileId)
          current.meta.wire.seedFromInbound(fileId, packetIndex)
          const sink = makeFileSink(createFileStream(fileName, fileSize))
          await current.meta.receiver.onFileStart({
            fileId,
            totalBytes: fileSize,
            totalChunks,
            sink,
            onProgress: (written, total) => {
              const progress = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0
              dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { progress } })
            },
          })
          dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
          return
        }

        if (payload.type === 'collab-file-end') {
          await session.chunkQueue
          const fileId = payload.fileId as string
          await current.meta.receiver.onFileEnd(fileId)
          dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'complete', progress: 100 } })
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
              const enc = await encryptJSON(session.encryptKey, {
                type: 'collab-file-unavailable', fileId, reason: 'unknown-file',
              } satisfies CollabInnerMsg)
              session.send({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
            } catch (e) { log.warn('useCollabGuest.mesh.requestRelay', e) }
          }
          return
        }

        if (payload.type === 'collab-pause-file') {
          // Mesh pauses only affect transfers living on THIS session (outbound
          // uploads routed directly). No origin check needed — mesh conn is
          // already authenticated end-to-end via ECDH.
          session.pauseTransfer(payload.fileId as string)
          return
        }
        if (payload.type === 'collab-resume-file') {
          session.resumeTransfer(payload.fileId as string)
          return
        }
        if (payload.type === 'collab-cancel-file') {
          session.cancelTransfer(payload.fileId as string)
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
          // cancel-all from mesh peer — nothing to do on receiver side (no per-file tracking here)
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
        // Allocate the host session up front. It sits in 'connecting'
        // until conn.on('open') ticks the transition.
        const hostSess = createSession({
          conn,
          role: 'collab-guest-host',
          generation: attemptRef.current,
        })
        hostSessionRef.current = hostSess
        hostSess.dispatch({ type: 'connect-start' })
        setPeerInstance(peer)

        conn.on('open', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current!)
          reconnectCountRef.current = 0
          hostSess.dispatch({ type: 'conn-open' })

          hostSess.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

          function handleDisconnect(reason: string): void {
            if (destroyedRef.current) return
            if (hostSessionRef.current !== hostSess) return
            if (hostSess.state === 'closed' || hostSess.state === 'error' || hostSess.state === 'kicked') return
            if (directFailTimerRef.current) { clearTimeout(directFailTimerRef.current); directFailTimerRef.current = null }
            try { conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.handleDisconnect.removeListeners', e) }

            // Session-level close: heartbeat, rttPoller, keyExchangeTimeout,
            // every active outbound transfer on this session aborted +
            // pauseResolved.
            hostSess.close('peer-disconnect')
            // Drop routes that pointed at the host session.
            for (const [fid, route] of activeTransferRoutesRef.current) {
              if (route.session === hostSess) activeTransferRoutesRef.current.delete(fid)
            }

            // Close every mesh connection on host disconnect.
            for (const mpid of Array.from(peerConnectionsRef.current.keys())) {
              teardownMesh(mpid, 'host disconnected')
            }

            setRtt(null)
            setMessages(prev => [...prev, { text: reason, from: 'system', time: Date.now(), self: false }].slice(-500))

            if (reconnectCountRef.current < MAX_RECONNECTS) {
              hostMetaRef.current = null
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

          hostSess.heartbeat = setupHeartbeat(conn, {
            onDead: () => handleDisconnect('Connection lost'),
          })

          hostSess.keyExchangeTimeout = setTimeout(() => {
            if (hostSessionRef.current !== hostSess) return
            if (!hostSess.encryptKey && !destroyedRef.current) {
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
          try { hostSess.send({ type: 'join', nickname: myNameRef.current } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.sendJoin', e) }
        })

        conn.on('data', async (data: unknown) => {
          if (destroyedRef.current) return
          if (hostSess.heartbeat) hostSess.heartbeat.markAlive()

          // Binary chunk detection.
          if (
            data instanceof ArrayBuffer ||
            data instanceof Uint8Array ||
            (data && typeof data === 'object' && typeof (data as { byteLength?: unknown }).byteLength === 'number' && !(data as { type?: unknown }).type)
          ) {
            const raw = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer as ArrayBuffer
            let packet: ReturnType<typeof parseChunkPacket>
            try { packet = parseChunkPacket(raw) } catch (e) { log.warn('useCollabGuest.chunkQueue.parse', e); return }
            // Chat image chunks still go through handleChunk's special path.
            if (packet.fileIndex === CHAT_IMAGE_FILE_INDEX) {
              hostSess.chunkQueue = hostSess.chunkQueue
                .then(() => handleChunk(hostSess, raw))
                .catch(e => log.warn('useCollabGuest.chunkQueue', e))
              return
            }
            // Collab file chunks — route through engine receiver.
            const hm = hostMetaRef.current
            if (hm) {
              hostSess.chunkQueue = hostSess.chunkQueue
                .then(() => hm.receiver.onChunk(packet))
                .catch(e => log.warn('useCollabGuest.chunkQueue.recv', e))
            }
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
            try { hostSess.send({ type: 'pong', ts: msg.ts } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.sendPong', e) }
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
            if (hostSess.encryptKey) return
            try {
              if (!hostSess.keyPair) {
                hostSess.setKeyPair(await generateKeyPair())
              }
              const pubKeyBytes = await exportPublicKey(hostSess.keyPair!.publicKey)
              try { hostSess.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies CollabUnencryptedMsg) } catch (e) { log.warn('useCollabGuest.sendPublicKey', e) }
              const remoteKeyBytes = new Uint8Array(msg.key as number[])
              const { encryptKey, fingerprint } = await finalizeKeyExchange({
                localPrivate: hostSess.keyPair!.privateKey,
                localPublic: pubKeyBytes,
                remotePublic: remoteKeyBytes,
              })
              hostSess.dispatch({ type: 'keys-derived', encryptKey, fingerprint })
              dispatchRoom({ type: 'SET', payload: { fingerprint } })
              // Initialize host-conn wire + receiver now that key is ready.
              const hw = createCollabWire()
              hostMetaRef.current = { wire: hw, receiver: createFileReceiver(hostSess, hw) }
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

          // H7: online-count is now derived from `participants.length` in
          // the reducer (every ADD/REMOVE/SET_PARTICIPANTS action recomputes
          // it). The host still broadcasts the count for protocol
          // back-compat; we accept and ignore so the two sources can never
          // drift.
          if (msg.type === 'online-count') {
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
            if (!hostSess.encryptKey || !msg.data) return
            let payload: Record<string, unknown> = {}
            try { payload = await decryptJSON(hostSess.encryptKey, msg.data as string) }
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
            if (!hostSess.encryptKey || !msg.data) return
            let payload: CollabInnerMsg
            try { payload = await decryptJSON<CollabInnerMsg>(hostSess.encryptKey, msg.data as string) }
            catch (e) {
              hostSess.decryptFailures++
              log.warn('useCollabGuest.collabMsgEnc.decrypt', e)
              if (hostSess.decryptFailures >= 10) {
                log.warn('useCollabGuest.collabMsgEnc.tooManyFailures', hostSess.peerId)
                hostSess.close('error')
              }
              return
            }
            hostSess.decryptFailures = 0

            // File list from host — C2 validation.
            if (payload.type === 'collab-file-list') {
              const rawFiles = payload.files
              if (!Array.isArray(rawFiles)) {
                console.warn('dropped invalid collab-file-list: not an array')
                return
              }
              const validated: SharedFile[] = []
              for (const f of rawFiles) {
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
              const oldName = String(payload.oldName || '').slice(0, 32)
              if (!peerId || !newName) return
              dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { name: newName } })
              // M5 — update any shared files owned by that peer.
              dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: peerId, newName })
              if (oldName && oldName !== newName) {
                setMessages(prev => [...prev, { text: `${oldName} renamed to ${newName}`, from: 'system', time: Date.now(), self: false }].slice(-500))
              }
              return
            }

            // File transfer start — H2 per-fileId.
            if (payload.type === 'collab-file-start') {
              const fileId = payload.fileId as string
              const fileName = payload.name as string
              const fileSize = payload.size as number
              const totalChunks = payload.totalChunks as number
              const packetIndex = payload.packetIndex as number

              clearDownloadTimeout(fileId)

              const hm = hostMetaRef.current
              if (hm) {
                hm.wire.seedFromInbound(fileId, packetIndex)
                const sink = makeFileSink(createFileStream(fileName, fileSize))
                await hm.receiver.onFileStart({
                  fileId,
                  totalBytes: fileSize,
                  totalChunks,
                  sink,
                  onProgress: (written, total) => {
                    const progress = total > 0 ? Math.min(100, Math.round((written / total) * 100)) : 0
                    dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { progress } })
                  },
                })
              }
              dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
              return
            }

            // File transfer end — H2.
            if (payload.type === 'collab-file-end') {
              await hostSess.chunkQueue
              const fileId = payload.fileId as string
              const hm = hostMetaRef.current
              if (hm) {
                await hm.receiver.onFileEnd(fileId)
              }
              dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'complete', progress: 100 } })
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
            // shared file list broadcast). `route.targetPeerId` is null
            // when the host itself is the requester, which matches a
            // missing requesterPeerId on host-originated control messages.
            if (
              payload.type === 'collab-pause-file' ||
              payload.type === 'collab-resume-file' ||
              payload.type === 'collab-cancel-file'
            ) {
              const fileId = payload.fileId as string
              const requesterPeerId = (payload.requesterPeerId as string | undefined) ?? null
              const route = activeTransferRoutesRef.current.get(fileId)
              if (!route || route.targetPeerId !== requesterPeerId) return

              if (payload.type === 'collab-pause-file') {
                route.session.pauseTransfer(fileId)
              } else if (payload.type === 'collab-resume-file') {
                route.session.resumeTransfer(fileId)
              } else {
                route.session.cancelTransfer(fileId)
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
            const oldName = String(msg.oldName || '').slice(0, 32)
            if (!peerId || !newName) return
            dispatchParticipants({ type: 'UPDATE_PARTICIPANT', peerId, payload: { name: newName } })
            dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: peerId, newName })
            if (oldName && oldName !== newName) {
              setMessages(prev => [...prev, { text: `${oldName} renamed to ${newName}`, from: 'system', time: Date.now(), self: false }].slice(-500))
            }
            return
          }

          // Mid-stream abort — clear the in-progress image slot so a new
          // start message doesn't see leftover bytes from the stalled one.
          if (msg.type === 'chat-image-abort') {
            hostSess.inProgressImage = null
            return
          }

          // Chat image handling
          if (msg.type === 'chat-image-start-enc') {
            if (!hostSess.encryptKey || !msg.data) return
            let metaPayload: Record<string, unknown>
            try { metaPayload = await decryptJSON(hostSess.encryptKey, msg.data as string) }
            catch (e) { log.warn('useCollabGuest.chatImageStart.decrypt', e); return }
            hostSess.inProgressImage = {
              id: metaPayload.id as string | undefined,
              mime: metaPayload.mime as string || 'application/octet-stream',
              size: metaPayload.size as number || 0,
              text: metaPayload.text as string || '',
              replyTo: metaPayload.replyTo as { text: string; from: string; time: number } | null,
              time: metaPayload.time as number || Date.now(),
              from: msg.from as string || 'Sender',
              duration: metaPayload.duration as number | undefined,
              chunks: [],
              receivedBytes: 0,
            }
            return
          }

          if (msg.type === 'chat-image-end-enc') {
            await hostSess.chunkQueue
            const inFlight = hostSess.inProgressImage
            hostSess.inProgressImage = null
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
          if (destroyedRef.current) return
          if (hostSessionRef.current !== hostSess) return
          if (hostSess.state === 'closed' || hostSess.state === 'error' || hostSess.state === 'kicked') return
          try { conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.close.removeListeners', e) }
          hostSess.close('peer-disconnect')
          for (const [fid, route] of activeTransferRoutesRef.current) {
            if (route.session === hostSess) activeTransferRoutesRef.current.delete(fid)
          }

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

  // Handle incoming chat-image chunks on the host connection.
  // Collab file chunks are now routed through hostMetaRef.receiver.onChunk.
  async function handleChunk(hostSess: Session, rawData: ArrayBuffer): Promise<void> {
    if (!hostSess.encryptKey) return
    const buffer = rawData instanceof ArrayBuffer ? rawData : (rawData as ArrayBufferView).buffer as ArrayBuffer

    let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
    try {
      parsed = parseChunkPacket(buffer)
    } catch (e) { log.warn('useCollabGuest.handleChunk.parse', e); return }

    // Chat image chunk
    if (parsed.fileIndex === CHAT_IMAGE_FILE_INDEX) {
      if (!hostSess.inProgressImage) return
      try {
        const decrypted = await decryptChunk(hostSess.encryptKey, new Uint8Array(parsed.data))
        hostSess.inProgressImage.chunks.push(new Uint8Array(decrypted))
        hostSess.inProgressImage.receivedBytes += decrypted.byteLength
      } catch (e) { log.warn('useCollabGuest.handleChunk.chatImageDecrypt', e) }
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
      const sess = hostSessionRef.current
      if (sess && !sess.conn.open && !destroyedRef.current) {
        startConnection(useTurnRef.current, true)
      }
    }
    window.addEventListener('online', handleOnline)

    const handleVisibility = (): void => {
      if (!isMountedRef.current || destroyedRef.current) return
      if (typeof document === 'undefined') return
      if (document.visibilityState !== 'visible') return
      const hb = hostSessionRef.current?.heartbeat
      if (hb) hb.markAlive()
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
      if (directFailTimerRef.current) clearTimeout(directFailTimerRef.current)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      downloadTimeoutsRef.current.forEach(t => clearTimeout(t))
      downloadTimeoutsRef.current.clear()
      // Host session — idempotent close runs heartbeat/rttPoller/timer/
      // active-transfer cleanup.
      const hostSess = hostSessionRef.current
      if (hostSess) {
        try { hostSess.conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.unmount.hostRemoveListeners', e) }
        hostSess.close('session-abort')
        try { hostSess.conn.close() } catch (e) { log.warn('useCollabGuest.unmount.hostClose', e) }
        hostSessionRef.current = null
      }
      hostMetaRef.current = null
      // Close every mesh session on unmount.
      for (const entry of peerConnectionsRef.current.values()) {
        entry.session.close('session-abort')
        try { entry.session.conn.removeAllListeners() } catch (e) { log.warn('useCollabGuest.unmount.meshRemoveListeners', e) }
        try { entry.session.conn.close() } catch (e) { log.warn('useCollabGuest.unmount.meshClose', e) }
      }
      peerConnectionsRef.current.clear()
      activeTransferRoutesRef.current.clear()
      if (peerRef.current) peerRef.current.destroy()
      imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useCollabGuest.unmount.revokeBlob', e) } })
      setPeerInstance(null)
    }
  }, [startConnection])

  // Submit password — H12: clear passwordError on new attempt.
  const submitPassword = useCallback(async (password: string): Promise<void> => {
    const hostSess = hostSessionRef.current
    if (!hostSess?.encryptKey) return
    dispatchRoom({ type: 'SET', payload: { passwordError: false } })
    try {
      const encrypted = await encryptChunk(hostSess.encryptKey, new TextEncoder().encode(password))
      sendToHost({ type: 'password-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)) } satisfies CollabUnencryptedMsg)
    } catch (e) { log.warn('useCollabGuest.submitPassword', e) }
  }, [sendToHost])

  // Send message
  const sendMessage = useCallback(async (text: string, image?: { bytes: Uint8Array; mime: string; duration?: number } | string, replyTo?: ChatMessage['replyTo']): Promise<void> => {
    if (!text && !image) return
    const hostSess = hostSessionRef.current
    if (!hostSess?.encryptKey) return
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

      hostSess.imageSendQueue = hostSess.imageSendQueue
        .then(() => {
          const sess = hostSessionRef.current
          if (!sess || !sess.encryptKey) return
          return streamImageToHost(sess.conn, sess.encryptKey, bytes, mime, text || '', replyTo ?? null, nickname, time, duration, id)
        })
        .catch(err => { console.warn('image send failed:', err) })
      return
    }

    const imgStr = image as string | undefined
    const id = crypto.randomUUID()
    setMessages(prev => [...prev, { id, text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ id, text, image: imgStr, replyTo })
    try {
      const encrypted = await encryptChunk(hostSess.encryptKey, new TextEncoder().encode(payload))
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
    if (oldName === newName) return
    setNickname(newName)
    dispatchRoom({ type: 'SET', payload: { myName: newName } })
    // Also update locally shown ownerName for my own files.
    if (room.myPeerId) {
      dispatchFiles({ type: 'UPDATE_SHARED_FILE_OWNER_NAME', ownerId: room.myPeerId, newName })
    }
    // Announce locally — other participants get the system msg via the
    // host's `collab-peer-renamed` re-broadcast (handled above). The
    // renamer appends optimistically so their own chat matches.
    setMessages(prev => [...prev, { text: `${oldName} renamed to ${newName}`, from: 'system', time: Date.now(), self: false }].slice(-500))
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
    const hostSess = hostSessionRef.current
    if (hostSess) {
      hostSess.close('session-abort')
      hostSessionRef.current = null
    }
    if (peerRef.current) peerRef.current.destroy()
    setTimeout(() => startConnection(true), 100)
  }, [startConnection])

  const leave = useCallback((): void => {
    destroyedRef.current = true
    downloadTimeoutsRef.current.forEach(t => clearTimeout(t))
    downloadTimeoutsRef.current.clear()
    // Close every mesh session on leave.
    for (const entry of peerConnectionsRef.current.values()) {
      entry.session.close('session-abort')
    }
    const hostSess = hostSessionRef.current
    if (hostSess) {
      hostSess.close('session-abort')
      try { hostSess.conn.close() } catch (e) { log.warn('useCollabGuest.leave.hostClose', e) }
      hostSessionRef.current = null
    }
    hostMetaRef.current = null
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
    if (meshConn?.session.conn && meshConn.session.encryptKey) {
      try {
        const enc = await encryptJSON(meshConn.session.encryptKey, { type, fileId } satisfies CollabInnerMsg)
        meshConn.session.send({ type: 'collab-msg-enc', data: enc } satisfies CollabUnencryptedMsg)
        return
      } catch (e) { log.warn(`useCollabGuest.${type}.mesh`, e) }
    }
    const hostSess = hostSessionRef.current
    if (!hostSess?.encryptKey) return
    try {
      const enc = await encryptJSON(hostSess.encryptKey, { type, fileId } satisfies CollabInnerMsg)
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

    // Abort host-path inbound receiver if active.
    const hm = hostMetaRef.current
    if (hm?.receiver.has(fileId)) {
      void hm.receiver.abort(fileId, 'cancelled')
    }

    // Abort mesh-path inbound receiver if active.
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    const meshEntry = file?.owner ? peerConnectionsRef.current.get(file.owner) : undefined
    if (meshEntry?.meta.receiver.has(fileId)) {
      void meshEntry.meta.receiver.abort(fileId, 'cancelled')
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

      // Abort the local receiver writer on whichever path owns this fileId.
      // Without this the StreamSaver service worker keeps the browser's
      // partial download alive even after our UI clears the download chip.
      // Per-file cancelFile does the same — cancelAll has to mirror it.
      const hm = hostMetaRef.current
      if (hm?.receiver.has(fileId)) {
        void hm.receiver.abort(fileId, 'cancelled')
      }
      const file = snap.sharedFiles.find(f => f.id === fileId)
      const meshEntry = file?.owner ? peerConnectionsRef.current.get(file.owner) : undefined
      if (meshEntry?.meta.receiver.has(fileId)) {
        void meshEntry.meta.receiver.abort(fileId, 'cancelled')
      }
    }

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

// Wrap a FileStreamHandle (or null for in-memory fallback) into a
// WritableStream<Uint8Array> as expected by createFileReceiver.
function makeFileSink(handle: FileStreamHandle | null): WritableStream<Uint8Array> {
  if (handle) {
    return new WritableStream<Uint8Array>({
      write(chunk) { return handle.write(chunk) },
      close() { return handle.close() },
      abort(_reason) { return handle.abort() },
    })
  }
  // In-memory fallback: collect chunks, trigger download on close.
  const chunks: Uint8Array[] = []
  return new WritableStream<Uint8Array>({
    write(chunk) { chunks.push(chunk); return Promise.resolve() },
    close() {
      const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0)
      const full = new Uint8Array(totalLen)
      let off = 0
      for (const c of chunks) { full.set(c, off); off += c.byteLength }
      const blob = new Blob([full])
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'download'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return Promise.resolve()
    },
    abort() { chunks.length = 0; return Promise.resolve() },
  })
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
