import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, getKeyFingerprint, uint8ToBase64, base64ToUint8 } from '../utils/crypto'
import { STUN_ONLY, getWithTurn } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { chunkFileAdaptive, buildChunkPacket, parseChunkPacket, waitForBufferDrain, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { createFileStream } from '../utils/streamWriter'
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
} from './state/collabState'

// ── Constants ────────────────────────────────────────────────────────────

const MAX_RETRIES = 2
const TIMEOUT_MS = 10000
const RECONNECT_DELAY = 2000
const MAX_RECONNECTS = 3

// ── Types ────────────────────────────────────────────────────────────────

interface PeerConnection {
  peerId: string
  name: string
  conn: DataConnection | null
  encryptKey: CryptoKey | null
  keyPair: CryptoKeyPair | null
  directConnection: boolean
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
  const inProgressFileRef = useRef<InProgressFile | null>(null)
  const myFilesRef = useRef<Map<string, File>>(new Map())
  const isMountedRef = useRef<boolean>(true)
  const reconnectTokenRef = useRef<symbol>(Symbol('reconnect'))
  const pendingManifestRef = useRef<string | null>(null)
  
  // P2P connections to other guests (mesh)
  const peerConnectionsRef = useRef<Map<string, PeerConnection>>(new Map())
  
  // For calls
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((msg: Record<string, unknown>): void => {
    const c = hostConnRef.current
    if (c && c.open) { try { c.send(msg) } catch {} }
  }, [])

  // Send to host (for relaying or direct communication)
  const sendToHost = useCallback((msg: Record<string, unknown>): void => {
    const c = hostConnRef.current
    if (c && c.open) { try { c.send(msg) } catch {} }
  }, [])

  // Request file from owner (through host relay or direct P2P)
  const requestFile = useCallback(async (fileId: string, ownerId: string): Promise<void> => {
    if (!decryptKeyRef.current) return
    
    dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'requesting', progress: 0, speed: 0 } })
    
    // Try direct P2P first if we have a connection to the owner
    const peerConn = peerConnectionsRef.current.get(ownerId)
    if (peerConn?.conn && peerConn.encryptKey) {
      try {
        const encrypted = await encryptJSON(peerConn.encryptKey, { type: 'collab-request-file', fileId })
        peerConn.conn.send({ type: 'collab-msg-enc', data: encrypted })
        return
      } catch {}
    }
    
  // Fall back to host relay - include owner so host can relay to correct peer
  try {
  const encrypted = await encryptJSON(decryptKeyRef.current, { type: 'collab-request-file', fileId, owner: ownerId })
  sendToHost({ type: 'collab-msg-enc', data: encrypted })
  } catch {}
  }, [sendToHost])

  // Share a file
  const shareFile = useCallback(async (file: File): Promise<void> => {
    if (!decryptKeyRef.current || !room.myPeerId) return
    
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    myFilesRef.current.set(fileId, file)
    
    const sharedFile: SharedFile = {
      id: fileId,
      name: file.name,
      size: file.size,
      type: file.type,
      owner: room.myPeerId,
      ownerName: nickname,
      addedAt: Date.now(),
    }
    
    dispatchFiles({ type: 'ADD_SHARED_FILE', payload: sharedFile })
    dispatchFiles({ type: 'ADD_MY_SHARED_FILE', fileId })
    
    // Notify host (who will broadcast to others)
    try {
      const encrypted = await encryptJSON(decryptKeyRef.current, {
        type: 'collab-file-shared',
        file: sharedFile,
      })
      sendToHost({ type: 'collab-msg-enc', data: encrypted })
    } catch {}
  }, [sendToHost, room.myPeerId, nickname])

  // Send file to requester
  const sendFileToRequester = useCallback(async (conn: DataConnection, key: CryptoKey, fileId: string): Promise<void> => {
    const file = myFilesRef.current.get(fileId)
    if (!file) return
    
    const chunker = new AdaptiveChunker()
    const throttler = new ProgressThrottler(80)
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    
    // Send file start
    try {
      const startMsg = await encryptJSON(key, {
        type: 'collab-file-start',
        fileId,
        name: file.name,
        size: file.size,
        totalChunks,
      })
      conn.send({ type: 'collab-msg-enc', data: startMsg })
    } catch { return }
    
    let chunkIndex = 0
    let fileSent = 0
    const startTime = Date.now()
    
    dispatchTransfer({ type: 'START_UPLOAD', fileId, fileName: file.name })
    
    for await (const { buffer: chunkData } of chunkFileAdaptive(file, chunker)) {
      const dataToSend = await encryptChunk(key, new Uint8Array(chunkData))
      const packet = buildChunkPacket(0xFFFE, chunkIndex, dataToSend)
      conn.send(packet)
      await waitForBufferDrain(conn)
      
      chunkIndex++
      fileSent += chunkData.byteLength
      
      if (throttler.shouldUpdate()) {
        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0.5 ? fileSent / elapsed : 0
        dispatchTransfer({ type: 'UPDATE_UPLOAD', progress: Math.round((fileSent / file.size) * 100), speed })
      }
    }
    
    // Send file end
    try {
      const endMsg = await encryptJSON(key, { type: 'collab-file-end', fileId })
      conn.send({ type: 'collab-msg-enc', data: endMsg })
    } catch {}
    
    dispatchTransfer({ type: 'END_UPLOAD' })
  }, [])

  const startConnection = useCallback((withTurn: boolean, isReconnect: boolean = false): void => {
    if (!window.crypto?.subtle) { dispatchRoom({ type: 'SET_STATUS', payload: 'error' }); return }
    if (!isMountedRef.current) return
    destroyedRef.current = false
    attemptRef.current = 0
    reconnectTokenRef.current = Symbol('reconnect')
    
    if (!isReconnect) {
      useTurnRef.current = withTurn
    }

    async function connect(): Promise<void> {
      if (destroyedRef.current) return
      attemptRef.current++
      dispatchRoom({ type: 'SET_STATUS', payload: isReconnect ? 'reconnecting' : attemptRef.current > 1 ? 'joining' : 'joining' })

      const config = useTurnRef.current ? await getWithTurn() : STUN_ONLY
      const peer = new Peer(config)
      peerRef.current = peer

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
            try { conn.removeAllListeners() } catch {}
            
            setRtt(null)
            setMessages(prev => [...prev, { text: reason, from: 'system', time: Date.now(), self: false }])
            
            if (reconnectCountRef.current < MAX_RECONNECTS) {
              chunkQueueRef.current = Promise.resolve()
              imageSendQueueRef.current = Promise.resolve()
              inProgressImageRef.current = null
              inProgressFileRef.current = null
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
            pc.oniceconnectionstatechange = () => {
              const s = pc.iceConnectionState
              if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                handleDisconnect('Host disconnected')
              }
            }
          }

          dispatchRoom({ type: 'SET_STATUS', payload: 'connected' })
          conn.send({ type: 'join', nickname })
        })

        conn.on('data', async (data: unknown) => {
          if (destroyedRef.current) return
          if (heartbeatRef.current) heartbeatRef.current.markAlive()

          // Binary data (chunks)
          if (data instanceof ArrayBuffer || (data && (data as ArrayBuffer).byteLength !== undefined && !(typeof data === 'object' && (data as Record<string, unknown>).type))) {
            chunkQueueRef.current = chunkQueueRef.current.then(() => handleChunk(data as ArrayBuffer)).catch(() => {})
            return
          }

          const msg = data as Record<string, unknown>

          if (msg.type === 'pong') return
          if (msg.type === 'ping') {
            try { conn.send({ type: 'pong', ts: msg.ts }) } catch {}
            return
          }

          // Call messages
          if (typeof msg.type === 'string' && (msg.type as string).startsWith('call-')) {
            if (callMessageHandlerRef.current) {
              const from = (msg.from as string) || conn.peer
              try { callMessageHandlerRef.current(from, msg) } catch {}
            }
            return
          }

          if (msg.type === 'closing' || msg.type === 'room-closed') {
            setMessages(prev => [...prev, { text: 'Room was closed by host', from: 'system', time: Date.now(), self: false }])
            dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
            conn.close()
            return
          }

  if (msg.type === 'kicked') {
  setMessages(prev => [...prev, { text: 'You were removed from the room', from: 'system', time: Date.now(), self: false }])
  dispatchRoom({ type: 'SET_STATUS', payload: 'kicked' })
            conn.close()
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
              conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) })
              const remotePubKey = await importPublicKey(new Uint8Array(msg.key as number[]))
              decryptKeyRef.current = await deriveSharedKey(keyPairRef.current.privateKey, remotePubKey)
              if (keyExchangeTimeoutRef.current) { clearTimeout(keyExchangeTimeoutRef.current); keyExchangeTimeoutRef.current = null }
              const fp = await getKeyFingerprint(pubKeyBytes, new Uint8Array(msg.key as number[]))
              dispatchRoom({ type: 'SET', payload: { fingerprint: fp } })

              // Process pending manifest
              if (pendingManifestRef.current) {
                const pending = pendingManifestRef.current
                pendingManifestRef.current = null
                try {
                  const manifest = await decryptJSON(decryptKeyRef.current, pending)
                  // Handle manifest if needed
                } catch {}
              }
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
              if (`${m.time}` === msg.msgId) {
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
            setMessages(prev => [...prev, { text: msg.text as string, from: 'system', time: msg.time as number, self: false }])
            return
          }

          // Encrypted chat
          if (msg.type === 'chat-encrypted') {
            if (!decryptKeyRef.current || !msg.data) return
            let payload: Record<string, unknown> = {}
            try { payload = await decryptJSON(decryptKeyRef.current, msg.data as string) }
            catch { return }
            setMessages(prev => [...prev, {
              text: payload.text as string || '',
              image: payload.image as string | undefined,
              mime: payload.mime as string | undefined,
              replyTo: payload.replyTo as ChatMessage['replyTo'],
              from: msg.from as string || 'Sender',
              time: msg.time as number,
              self: false,
            }])
            return
          }

          // Collab encrypted messages
          if (msg.type === 'collab-msg-enc') {
            if (!decryptKeyRef.current || !msg.data) return
            let payload: Record<string, unknown> = {}
            try { payload = await decryptJSON(decryptKeyRef.current, msg.data as string) }
            catch { return }

            // File list from host
            if (payload.type === 'collab-file-list') {
              const fileList = payload.files as SharedFile[]
              dispatchFiles({ type: 'SET_SHARED_FILES', payload: fileList })
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
              return
            }

            // New file shared
            if (payload.type === 'collab-file-shared') {
              const fileData = payload.file as SharedFile
              dispatchFiles({ type: 'ADD_SHARED_FILE', payload: fileData })
              return
            }

            // File transfer start - use StreamWriter pattern from useReceiver
            if (payload.type === 'collab-file-start') {
              const fileId = payload.fileId as string
              const fileName = payload.name as string
              const fileSize = payload.size as number
              
              // Try to create a stream for direct-to-disk download (like useReceiver)
              const stream = createFileStream(fileName, fileSize)
              
              inProgressFileRef.current = {
                fileId,
                name: fileName,
                size: fileSize,
                totalChunks: payload.totalChunks as number,
                chunks: [], // Fallback buffer if stream not supported
                receivedBytes: 0,
                stream,
                startTime: Date.now(),
              }
              dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
              return
            }

            // File transfer end - use StreamWriter pattern from useReceiver
            if (payload.type === 'collab-file-end') {
              await chunkQueueRef.current
              const inFlight = inProgressFileRef.current
              inProgressFileRef.current = null
              if (!inFlight) return

              // If we used streaming, just close it (file already saved)
              if (inFlight.stream) {
                try {
                  await inFlight.stream.close()
                } catch {}
              } else {
                // Fallback: assemble from memory chunks
                const totalLen = inFlight.chunks.reduce((s, c) => s + c.byteLength, 0)
                const fullBytes = new Uint8Array(totalLen)
                let off = 0
                for (const c of inFlight.chunks) { fullBytes.set(c, off); off += c.byteLength }

                const mimeType = files.sharedFiles.find(f => f.id === inFlight.fileId)?.type || 'application/octet-stream'
                const blob = new Blob([fullBytes], { type: mimeType })
                const url = URL.createObjectURL(blob)
                
                // Trigger download
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

            // File request from another peer (via host relay)
            if (payload.type === 'collab-request-file') {
              const fileId = payload.fileId as string
              if (myFilesRef.current.has(fileId) && decryptKeyRef.current) {
                await sendFileToRequester(conn, decryptKeyRef.current, fileId)
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
            setMessages(prev => [...prev, { text: `${msg.name} joined the room`, from: 'system', time: Date.now(), self: false }])
            return
          }

          // Peer left
          if (msg.type === 'collab-peer-left') {
            dispatchParticipants({ type: 'REMOVE_PARTICIPANT', peerId: msg.peerId as string })
            setMessages(prev => [...prev, { text: `${msg.name} left the room`, from: 'system', time: Date.now(), self: false }])
            return
          }

          // Chat image handling
          if (msg.type === 'chat-image-start-enc') {
            if (!decryptKeyRef.current || !msg.data) return
            let meta: Record<string, unknown>
            try { meta = await decryptJSON(decryptKeyRef.current, msg.data as string) }
            catch { return }
            inProgressImageRef.current = {
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
              text: inFlight.text,
              image: url,
              mime: inFlight.mime,
              duration: inFlight.duration,
              replyTo: inFlight.replyTo,
              from: inFlight.from,
              time: inFlight.time,
              self: false,
            }])
            return
          }
        })

        conn.on('close', () => {
          if (destroyedRef.current || disconnectHandled) return
          disconnectHandled = true
          try { conn.removeAllListeners() } catch {}
          if (heartbeatRef.current) heartbeatRef.current.cleanup()
          if (rttPollerRef.current) { rttPollerRef.current.cleanup(); rttPollerRef.current = null }
          setRtt(null)
          setMessages(prev => [...prev, { text: 'Disconnected from room', from: 'system', time: Date.now(), self: false }])
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
          setMessages(prev => [...prev, { text: 'Room not found', from: 'system', time: Date.now(), self: false }])
        } else if (err.type === 'disconnected' || err.type === 'network') {
          return
        }
      })
    }

    connect()
  }, [roomId, nickname, sendFileToRequester])

  // Handle incoming chunks
  async function handleChunk(rawData: ArrayBuffer): Promise<void> {
    if (!decryptKeyRef.current) return
    const buffer = rawData instanceof ArrayBuffer ? rawData : (rawData as ArrayBufferView).buffer as ArrayBuffer

    let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
    try {
      parsed = parseChunkPacket(buffer)
    } catch { return }

    // Chat image chunk
    if (parsed.fileIndex === CHAT_IMAGE_FILE_INDEX) {
      if (!inProgressImageRef.current) return
      try {
        const decrypted = await decryptChunk(decryptKeyRef.current, new Uint8Array(parsed.data))
        inProgressImageRef.current.chunks.push(new Uint8Array(decrypted))
        inProgressImageRef.current.receivedBytes += decrypted.byteLength
      } catch {}
      return
    }

    // Collab file chunk - use StreamWriter pattern like useReceiver
    if (parsed.fileIndex === 0xFFFE) {
      const inFlight = inProgressFileRef.current
      if (!inFlight) return
      try {
        const decrypted = await decryptChunk(decryptKeyRef.current, new Uint8Array(parsed.data))
        const bytes = new Uint8Array(decrypted)
        
        // Write to stream if available, otherwise buffer in memory
        if (inFlight.stream) {
          await inFlight.stream.write(bytes)
        } else {
          inFlight.chunks.push(bytes)
        }
        
        inFlight.receivedBytes += bytes.byteLength
        
        // Calculate progress and speed (throttled like useReceiver)
        const progress = Math.min(100, Math.round((inFlight.receivedBytes / inFlight.size) * 100))
        const elapsed = (Date.now() - inFlight.startTime) / 1000
        const speed = elapsed > 0.5 ? inFlight.receivedBytes / elapsed : 0
        
        dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { progress, speed } })
      } catch (e) {
        // Chunk decryption or write failed - abort stream and cancel
        if (inFlight.stream) {
          try { await inFlight.stream.abort() } catch {}
        }
        inProgressFileRef.current = null
        dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { status: 'error', progress: 0 } })
      }
      return
    }
  }

  // Start connection on mount
  useEffect(() => {
    isMountedRef.current = true
    startConnection(false)

    return () => {
      isMountedRef.current = false
      destroyedRef.current = true
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      if (heartbeatRef.current) heartbeatRef.current.cleanup()
      if (rttPollerRef.current) rttPollerRef.current.cleanup()
      if (keyExchangeTimeoutRef.current) clearTimeout(keyExchangeTimeoutRef.current)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      // Abort any in-progress file stream
      if (inProgressFileRef.current?.stream) {
        try { inProgressFileRef.current.stream.abort() } catch {}
      }
      inProgressFileRef.current = null
      if (hostConnRef.current) {
        try { hostConnRef.current.removeAllListeners() } catch {}
        try { hostConnRef.current.close() } catch {}
      }
      if (peerRef.current) peerRef.current.destroy()
      imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
      setPeerInstance(null)
    }
  }, [startConnection])

  // Submit password
  const submitPassword = useCallback(async (password: string): Promise<void> => {
    if (!decryptKeyRef.current) return
    try {
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(password))
      sendToHost({ type: 'password-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)) })
    } catch {}
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
      const localBlob = new Blob([bytes as unknown as BlobPart], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { text: text || '', image: localUrl, mime, duration, replyTo, from: 'You', time, self: true }].slice(-500))

      imageSendQueueRef.current = imageSendQueueRef.current
        .then(() => streamImageToHost(hostConnRef.current!, decryptKeyRef.current!, bytes, mime, text || '', replyTo ?? null, nickname, time, duration))
        .catch(() => {})
      return
    }

    const imgStr = image as string | undefined
    setMessages(prev => [...prev, { text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ text, image: imgStr, replyTo })
    try {
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(payload))
      sendToHost({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), nickname, time })
    } catch {}
  }, [sendToHost, nickname])

  const sendTyping = useCallback((): void => {
    sendToHost({ type: 'typing', nickname })
  }, [sendToHost, nickname])

  const sendReaction = useCallback((msgId: string, emoji: string): void => {
    setMessages(prev => prev.map(m => {
      if (`${m.time}` === msgId) {
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
    sendToHost({ type: 'reaction', msgId, emoji, nickname })
  }, [sendToHost, nickname])

  const setMyName = useCallback((name: string): void => {
    const newName = name.trim() || generateNickname()
    setNickname(newName)
    dispatchRoom({ type: 'SET', payload: { myName: newName } })
    sendToHost({ type: 'nickname-change', oldName: nickname, newName })
  }, [sendToHost, nickname])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
    imageBlobUrlsRef.current = []
  }, [])

  const retryWithRelay = useCallback((): void => {
    destroyedRef.current = true
    if (peerRef.current) peerRef.current.destroy()
    setTimeout(() => startConnection(true), 100)
  }, [startConnection])

  const leave = useCallback((): void => {
  destroyedRef.current = true
  if (hostConnRef.current) {
  try { hostConnRef.current.close() } catch {}
  }
  if (peerRef.current) peerRef.current.destroy()
  dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
  }, [])

  // Pause/Resume/Cancel functions for FileList compatibility
  const pauseFile = useCallback((index: number): void => {
    const conn = hostConnRef.current
    if (!conn) return
    const file = files.sharedFiles[index]
    if (file) {
      sendToHost({ type: 'collab-pause-file', fileId: file.id })
      dispatchFiles({ type: 'PAUSE_FILE', index })
    }
  }, [files.sharedFiles, sendToHost])

  const resumeFile = useCallback((index: number): void => {
    const conn = hostConnRef.current
    if (!conn) return
    const file = files.sharedFiles[index]
    if (file) {
      sendToHost({ type: 'collab-resume-file', fileId: file.id })
      dispatchFiles({ type: 'RESUME_FILE', index })
    }
  }, [files.sharedFiles, sendToHost])

  const cancelFile = useCallback((index: number): void => {
    const file = files.sharedFiles[index]
    if (file) {
      sendToHost({ type: 'collab-cancel-file', fileId: file.id })
      // Abort any in-progress stream
      if (inProgressFileRef.current?.fileId === file.id && inProgressFileRef.current.stream) {
        try { inProgressFileRef.current.stream.abort() } catch {}
        inProgressFileRef.current = null
      }
      dispatchFiles({ type: 'CANCEL_FILE', index, name: file.name })
    }
  }, [files.sharedFiles, sendToHost])

  const cancelAll = useCallback((): void => {
    sendToHost({ type: 'collab-cancel-all' })
    // Abort in-progress stream
    if (inProgressFileRef.current?.stream) {
      try { inProgressFileRef.current.stream.abort() } catch {}
      inProgressFileRef.current = null
    }
    // Reset all pending/paused
    dispatchFiles({ type: 'RESET' })
  }, [sendToHost])

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

    // Participants
    participants: participants.participants,
    onlineCount: participants.onlineCount,

    // Files
    sharedFiles: files.sharedFiles,
    downloads: files.downloads,
    mySharedFiles: files.mySharedFiles,

    // Transfer
    uploading: transfer.uploading,
    uploadProgress: transfer.uploadProgress,
    uploadSpeed: transfer.uploadSpeed,

    // Chat
    messages,
    typingUsers,
    rtt,

    // For useCall
    peer: peerInstance,
    hostPeerId: roomId,
    setCallMessageHandler,
    sendCallMessage,
    sendToHost,

    // Actions
    submitPassword,
    setMyName,
    shareFile,
    requestFile,
    sendMessage,
    sendTyping,
    sendReaction,
    clearMessages,
    retryWithRelay,
    leave,

    // FileList-compatible state
    progress: files.progress,
    pendingFiles: files.pendingFiles,
    pausedFiles: files.pausedFiles,
    completedFiles: files.completedFiles,
    currentFileIndex: files.currentFileIndex,

    // FileList-compatible actions
    pauseFile,
    resumeFile,
    cancelFile,
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
  duration?: number
): Promise<void> {
  const meta = { mime, size: bytes.byteLength, text, replyTo, time, duration }
  const encMeta = await encryptJSON(key, meta)
  conn.send({ type: 'chat-image-start-enc', data: encMeta, from })

  const CHUNK_SIZE = 64 * 1024
  for (let i = 0; i < bytes.byteLength; i += CHUNK_SIZE) {
    const chunk = bytes.slice(i, i + CHUNK_SIZE)
    const encChunk = await encryptChunk(key, chunk)
    const packet = buildChunkPacket(CHAT_IMAGE_FILE_INDEX, Math.floor(i / CHUNK_SIZE), encChunk)
    conn.send(packet)
    await waitForBufferDrain(conn)
  }

  conn.send({ type: 'chat-image-end-enc' })
}
