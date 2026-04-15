import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, getKeyFingerprint, uint8ToBase64, base64ToUint8 } from '../utils/crypto'
import { STUN_ONLY } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { chunkFileAdaptive, buildChunkPacket, parseChunkPacket, waitForBufferDrain, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { createFileStream } from '../utils/streamWriter'
import { generateThumbnailAsync, generateVideoThumbnail, generateTextPreview } from '../utils/thumbnailWorker'
import { ChatMessage, FileEntry } from '../types'
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
} from './state/collabState'

// ── Types ────────────────────────────────────────────────────────────────

interface ActiveTransfer {
  fileId: string
  aborted: boolean
  paused: boolean
  pauseResolver?: () => void
}

interface GuestConnection {
  conn: DataConnection
  peerId: string
  name: string
  encryptKey: CryptoKey | null
  keyPair: CryptoKeyPair | null
  heartbeat?: ReturnType<typeof setupHeartbeat>
  rttPoller?: ReturnType<typeof setupRTTPolling>
  disconnectHandled?: boolean
  pendingRemoteKey?: Uint8Array | null
  keyExchangeTimeout?: ReturnType<typeof setTimeout>
  fingerprint?: string
  passwordVerified: boolean
  chunker?: InstanceType<typeof AdaptiveChunker>
  progressThrottler?: InstanceType<typeof ProgressThrottler>
  // Active file transfers TO this guest (supports concurrent)
  activeTransfers: Map<string, ActiveTransfer>
  // For file receiving from this guest
  inProgressFile?: {
    id: string
    name: string
    size: number
    totalChunks: number
    chunks: Uint8Array[]
    receivedBytes: number
    ownerName: string
  }
  // For chat image receiving
  inProgressImage?: {
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
  chunkQueue: Promise<void>
  imageSendQueue: Promise<void>
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useCollabHost() {
  const [room, dispatchRoom] = useReducer(roomReducer, { ...initialRoomState, isHost: true })
  const [participants, dispatchParticipants] = useReducer(participantsReducer, initialParticipantsState)
  const [files, dispatchFiles] = useReducer(filesReducer, initialFilesState)
  const [transfer, dispatchTransfer] = useReducer(transferReducer, initialTransferState)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [rtt, setRtt] = useState<number | null>(null)
  const [typingUsers, setTypingUsers] = useState<string[]>([])

  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastMsgTime = useRef<number>(0)
  const peerRef = useRef<InstanceType<typeof Peer> | null>(null)
  const connectionsRef = useRef<Map<string, GuestConnection>>(new Map())
  const passwordRef = useRef<string | null>(null)
  const myFilesRef = useRef<Map<string, File>>(new Map()) // fileId -> File object
  const imageBlobUrlsRef = useRef<string[]>([])
  const sessionKeyRef = useRef<number>(0)
  const filesRef = useRef(files) // Keep fresh reference to files state
  filesRef.current = files
  
  // For receiving files from guests
  const inProgressFileRef = useRef<{
    fileId: string
    name: string
    size: number
    totalChunks: number
    chunks: Uint8Array[]
    receivedBytes: number
    stream: ReturnType<typeof createFileStream> | null
    startTime: number
    fromPeerId: string
  } | null>(null)
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  
  // For calls
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const [participantsList, setParticipantsList] = useState<Array<{ peerId: string; name: string }>>([])
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const setPassword = useCallback((pwd: string): void => {
    passwordRef.current = pwd || null
  }, [])

  const refreshParticipantsList = useCallback((): void => {
    const list: Array<{ peerId: string; name: string }> = []
    connectionsRef.current.forEach(gs => {
      if (gs.passwordVerified || !passwordRef.current) {
        list.push({ peerId: gs.peerId, name: gs.name || 'Anon' })
      }
    })
    setParticipantsList(list)
    
    // Update participants state
    const collabParticipants: CollabParticipant[] = list.map(p => ({
      peerId: p.peerId,
      name: p.name,
      isHost: false,
      connectionStatus: 'connected',
      directConnection: true,
    }))
    dispatchParticipants({ type: 'SET_PARTICIPANTS', payload: collabParticipants })
  }, [])

  // Broadcast a message to all connected guests
  const broadcast = useCallback((msg: Record<string, unknown>, exceptPeerId?: string): void => {
    connectionsRef.current.forEach(gs => {
      if (exceptPeerId && gs.peerId === exceptPeerId) return
      if (!gs.passwordVerified && passwordRef.current) return
      try { gs.conn.send(msg) } catch {}
    })
  }, [])

  // Send to specific peer
  const sendToPeer = useCallback((peerId: string, msg: Record<string, unknown>): void => {
    const gs = Array.from(connectionsRef.current.values()).find(g => g.peerId === peerId)
    if (gs) {
      try { gs.conn.send(msg) } catch {}
    }
  }, [])

  // Relay signaling between guests for mesh P2P
  const relaySignal = useCallback((fromPeerId: string, targetPeerId: string, signal: unknown): void => {
    const targetGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === targetPeerId)
    if (targetGs) {
      try {
        targetGs.conn.send({ type: 'collab-signal', from: fromPeerId, signal })
      } catch {}
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

  // Kick a user from the room
  const kickUser = useCallback((peerId: string): void => {
    const gs = Array.from(connectionsRef.current.values()).find(g => g.peerId === peerId)
    if (gs) {
      try { gs.conn.send({ type: 'kicked' }) } catch {}
      setTimeout(() => {
        try { gs.conn.close() } catch {}
      }, 100)
    }
  }, [])

  // Remove a shared file (only owner can remove)
  const removeFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return
    
    // Only owner can remove their own files
    if (file.owner !== room.myPeerId) return
    
    // Remove from local state
    myFilesRef.current.delete(fileId)
    dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })
    
    // Broadcast removal to all guests
    for (const gs of connectionsRef.current.values()) {
      if (!gs.encryptKey || (!gs.passwordVerified && passwordRef.current)) continue
      try {
        const encrypted = await encryptJSON(gs.encryptKey, { type: 'collab-file-removed', fileId })
        gs.conn.send({ type: 'collab-msg-enc', data: encrypted })
      } catch {}
    }
  }, [room.myPeerId])

  // Request a file from a guest
  const requestFile = useCallback(async (fileId: string, ownerId: string): Promise<void> => {
    const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === ownerId)
    if (!ownerGs?.encryptKey) return
    
    dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'requesting', progress: 0, speed: 0 } })
    
    try {
      const encrypted = await encryptJSON(ownerGs.encryptKey, { type: 'collab-request-file', fileId })
      ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
    } catch {}
  }, [])

  // Pause file download
  const pauseFile = useCallback(async (fileId: string): Promise<void> => {
    // Find the owner of the file
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return
    
    const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === file.owner)
    if (!ownerGs?.encryptKey) return
    
    try {
      const encrypted = await encryptJSON(ownerGs.encryptKey, { type: 'collab-pause-file', fileId })
      ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'paused' } })
    } catch {}
  }, [])

  // Resume file download
  const resumeFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return
    
    const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === file.owner)
    if (!ownerGs?.encryptKey) return
    
    try {
      const encrypted = await encryptJSON(ownerGs.encryptKey, { type: 'collab-resume-file', fileId })
      ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId, payload: { status: 'downloading' } })
    } catch {}
  }, [])

  // Cancel file download
  const cancelFile = useCallback(async (fileId: string): Promise<void> => {
    const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
    if (!file) return
    
    const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === file.owner)
    if (ownerGs?.encryptKey) {
      try {
        const encrypted = await encryptJSON(ownerGs.encryptKey, { type: 'collab-cancel-file', fileId })
        ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
      } catch {}
    }
    
    // Clear download state
    if (inProgressFileRef.current?.fileId === fileId) {
      inProgressFileRef.current = null
    }
  }, [])

  // Close the room
  const closeRoom = useCallback((): void => {
    broadcast({ type: 'room-closed' })
    setTimeout(() => {
      connectionsRef.current.forEach(gs => {
        try { gs.conn.close() } catch {}
      })
      if (peerRef.current) {
        peerRef.current.destroy()
      }
      dispatchRoom({ type: 'SET_STATUS', payload: 'closed' })
    }, 200)
  }, [broadcast])

  // Share a file to all guests
  const shareFile = useCallback(async (file: File): Promise<void> => {
    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    myFilesRef.current.set(fileId, file)
    
    // Generate thumbnail/preview using thumbnailWorker (same as Portal)
    let thumbnail: string | undefined
    let textPreview: string | undefined
    
    if (file.type.startsWith('image/') && file.size < 10 * 1024 * 1024) {
      try {
        thumbnail = await generateThumbnailAsync(file, 80)
      } catch {}
    } else if (file.type.startsWith('video/') && file.size < 50 * 1024 * 1024) {
      try {
        thumbnail = await generateVideoThumbnail(file, 80)
      } catch {}
    } else if (file.type === 'text/plain' || file.name.endsWith('.txt') || file.name.endsWith('.md')) {
      try {
        textPreview = await generateTextPreview(file)
      } catch {}
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
      file: {
        id: fileId,
        name: file.name,
        size: file.size,
        type: file.type,
        owner: room.myPeerId,
        ownerName: room.myName,
        addedAt: Date.now(),
      },
    }
    
    for (const gs of connectionsRef.current.values()) {
      if (!gs.encryptKey || (!gs.passwordVerified && passwordRef.current)) continue
      try {
        const encrypted = await encryptJSON(gs.encryptKey, msg)
        gs.conn.send({ type: 'collab-msg-enc', data: encrypted })
      } catch {}
    }
  }, [room.myPeerId, room.myName])

  // Send file to a specific requester - supports pause/resume/cancel and concurrent transfers
  const sendFileToRequester = useCallback(async (gs: GuestConnection, fileId: string): Promise<void> => {
    const file = myFilesRef.current.get(fileId)
    if (!file || !gs.encryptKey) return
    
    // Create transfer state for this specific file+requester combo
    const transfer: ActiveTransfer = { fileId, aborted: false, paused: false }
    gs.activeTransfers.set(fileId, transfer)
    
    if (!gs.chunker) gs.chunker = new AdaptiveChunker()
    if (!gs.progressThrottler) gs.progressThrottler = new ProgressThrottler(80)
    
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
    
    // Send file start
    try {
      const startMsg = await encryptJSON(gs.encryptKey, {
        type: 'collab-file-start',
        fileId,
        name: file.name,
        size: file.size,
        totalChunks,
      })
      gs.conn.send({ type: 'collab-msg-enc', data: startMsg })
    } catch { 
      gs.activeTransfers.delete(fileId)
      return 
    }
    
    let chunkIndex = 0
    let fileSent = 0
    const startTime = Date.now()
    
    for await (const { buffer: chunkData } of chunkFileAdaptive(file, gs.chunker)) {
      // Check if transfer was cancelled
      if (transfer.aborted) {
        gs.activeTransfers.delete(fileId)
        return
      }
      
      // Handle pause
      while (transfer.paused && !transfer.aborted) {
        await new Promise<void>(resolve => {
          transfer.pauseResolver = resolve
        })
      }
      if (transfer.aborted) {
        gs.activeTransfers.delete(fileId)
        return
      }
      
      const dataToSend = await encryptChunk(gs.encryptKey!, new Uint8Array(chunkData))
      const packet = buildChunkPacket(0xFFFE, chunkIndex, dataToSend) // 0xFFFE for collab file
      gs.conn.send(packet)
      await waitForBufferDrain(gs.conn)
      
      chunkIndex++
      fileSent += chunkData.byteLength
      
      if (gs.progressThrottler!.shouldUpdate()) {
        const elapsed = (Date.now() - startTime) / 1000
        const speed = elapsed > 0.5 ? fileSent / elapsed : 0
        dispatchTransfer({ type: 'UPDATE_UPLOAD', progress: Math.round((fileSent / file.size) * 100), speed })
      }
    }
    
    // Send file end
    if (!transfer.aborted) {
      try {
        const endMsg = await encryptJSON(gs.encryptKey, { type: 'collab-file-end', fileId })
        gs.conn.send({ type: 'collab-msg-enc', data: endMsg })
      } catch {}
    }
    
    gs.activeTransfers.delete(fileId)
    dispatchTransfer({ type: 'END_UPLOAD' })
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
      
      const MAX_CONNECTIONS = 20
      if (connectionsRef.current.size >= MAX_CONNECTIONS) {
        conn.close()
        return
      }
      
      const connId = conn.peer + '-' + Date.now()
      const gs: GuestConnection = {
        conn,
        peerId: conn.peer,
        name: 'Anon',
        encryptKey: null,
        keyPair: null,
        passwordVerified: false,
        activeTransfers: new Map(),
        chunkQueue: Promise.resolve(),
        imageSendQueue: Promise.resolve(),
      }
      connectionsRef.current.set(connId, gs)
      
      function announceJoin(): void {
        dispatchRoom({ type: 'SET_STATUS', payload: 'connected' })
        refreshParticipantsList()
        setMessages(prev => [...prev, { text: `${gs.name} joined the room`, from: 'system', time: Date.now(), self: false }].slice(-500))
        
        // Notify all other guests
        const count = connectionsRef.current.size + 1
        broadcast({ type: 'online-count', count }, gs.peerId)
        broadcast({ type: 'collab-peer-joined', peerId: gs.peerId, name: gs.name }, gs.peerId)
        
        // Send current file list to new guest
        sendFileListToGuest(gs)
        
        // Send participant list to new guest
        sendParticipantListToGuest(gs)
      }
      
      async function sendFileListToGuest(guest: GuestConnection): Promise<void> {
        if (!guest.encryptKey) return
        // Use ref to get current files state (not stale closure)
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
          const encrypted = await encryptJSON(guest.encryptKey, { type: 'collab-file-list', files: fileList })
          guest.conn.send({ type: 'collab-msg-enc', data: encrypted })
        } catch {}
      }
      
      async function sendParticipantListToGuest(guest: GuestConnection): Promise<void> {
        if (!guest.encryptKey) return
        const pList = [
          { peerId: room.myPeerId, name: room.myName, isHost: true },
          ...Array.from(connectionsRef.current.values())
            .filter(g => g.peerId !== guest.peerId && (g.passwordVerified || !passwordRef.current))
            .map(g => ({ peerId: g.peerId, name: g.name, isHost: false })),
        ]
        try {
          const encrypted = await encryptJSON(guest.encryptKey, { type: 'collab-participant-list', participants: pList })
          guest.conn.send({ type: 'collab-msg-enc', data: encrypted })
        } catch {}
      }
      
      conn.on('open', async () => {
        if (destroyed) return
        
        gs.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)
        
        function handleDisconnect(reason: string): void {
          if (gs.disconnectHandled || destroyed) return
          gs.disconnectHandled = true
          if (gs.heartbeat) gs.heartbeat.cleanup()
          if (gs.rttPoller) gs.rttPoller.cleanup()
          if (gs.keyExchangeTimeout) clearTimeout(gs.keyExchangeTimeout)
          try { conn.removeAllListeners() } catch {}
          
          const name = gs.name || 'A guest'
          connectionsRef.current.delete(connId)
          refreshParticipantsList()
          setMessages(prev => [...prev, { text: `${name} ${reason}`, from: 'system', time: Date.now(), self: false }].slice(-500))
          
          const count = connectionsRef.current.size + 1
          broadcast({ type: 'online-count', count })
          broadcast({ type: 'collab-peer-left', peerId: gs.peerId, name })
          
          if (connectionsRef.current.size === 0) {
            setRtt(null)
            dispatchRoom({ type: 'SET_STATUS', payload: 'waiting' })
          }
        }
        
        gs.heartbeat = setupHeartbeat(conn, {
          onDead: () => handleDisconnect('connection lost'),
        })
        
        const pc = conn.peerConnection
        if (pc) {
          pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState
            if (s === 'disconnected' || s === 'failed' || s === 'closed') {
              handleDisconnect('left')
            }
          }
        }
        
        // Start key exchange
        gs.keyPair = await generateKeyPair()
        const pubKeyBytes = await exportPublicKey(gs.keyPair.publicKey)
        conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) })
        
        gs.keyExchangeTimeout = setTimeout(() => {
          if (!gs.encryptKey) {
            console.warn('Key exchange timed out for', connId)
            conn.close()
          }
        }, 10_000)
        
        // Handle deferred key
        if (gs.pendingRemoteKey) {
          try {
            const remotePubKey = await importPublicKey(gs.pendingRemoteKey)
            gs.encryptKey = await deriveSharedKey(gs.keyPair.privateKey, remotePubKey)
            if (gs.keyExchangeTimeout) { clearTimeout(gs.keyExchangeTimeout); gs.keyExchangeTimeout = undefined }
            const fp = await getKeyFingerprint(pubKeyBytes, gs.pendingRemoteKey)
            gs.fingerprint = fp
            gs.pendingRemoteKey = null
            if (passwordRef.current) {
              conn.send({ type: 'password-required' })
            } else {
              gs.passwordVerified = true
              announceJoin()
            }
          } catch {
            conn.close()
          }
        }
      })
      
      conn.on('data', async (data: unknown) => {
        if (destroyed) return
        if (gs.heartbeat) gs.heartbeat.markAlive()
        
        const msg = data as Record<string, unknown>
        
        // Handle binary chunks (file data)
        if (data instanceof ArrayBuffer || (data && (data as ArrayBuffer).byteLength !== undefined && !(typeof data === 'object' && msg.type))) {
          gs.chunkQueue = gs.chunkQueue
            .then(() => handleGuestChunk(gs, data as ArrayBuffer))
            .catch(() => {})
          return
        }
        
        if (msg.type === 'pong') return
        if (msg.type === 'ping') {
          try { conn.send({ type: 'pong', ts: msg.ts }) } catch {}
          return
        }
        
        // Call messages
        if (typeof msg.type === 'string' && (msg.type as string).startsWith('call-')) {
          if (callMessageHandlerRef.current) {
            try { callMessageHandlerRef.current(conn.peer, msg) } catch {}
          }
          return
        }
        
        // Public key exchange
        if (msg.type === 'public-key') {
          const remoteKeyRaw = new Uint8Array(msg.key as number[])
          if (!gs.keyPair) {
            gs.pendingRemoteKey = remoteKeyRaw
            return
          }
          try {
            const remotePubKey = await importPublicKey(remoteKeyRaw)
            gs.encryptKey = await deriveSharedKey(gs.keyPair.privateKey, remotePubKey)
            if (gs.keyExchangeTimeout) { clearTimeout(gs.keyExchangeTimeout); gs.keyExchangeTimeout = undefined }
            const localPubBytes = await exportPublicKey(gs.keyPair.publicKey)
            const fp = await getKeyFingerprint(localPubBytes, remoteKeyRaw)
            gs.fingerprint = fp
            
            if (passwordRef.current) {
              conn.send({ type: 'password-required' })
            } else {
              gs.passwordVerified = true
              announceJoin()
            }
          } catch {
            conn.close()
          }
          return
        }
        
        // Password verification
        if (msg.type === 'password-encrypted') {
          if (!gs.encryptKey || !msg.data) return
          let password = ''
          try {
            const decrypted = await decryptChunk(gs.encryptKey, base64ToUint8(msg.data as string))
            password = new TextDecoder().decode(decrypted)
          } catch { conn.send({ type: 'password-wrong' }); return }
          
          if (password === passwordRef.current) {
            conn.send({ type: 'password-accepted' })
            gs.passwordVerified = true
            announceJoin()
          } else {
            conn.send({ type: 'password-wrong' })
          }
          return
        }
        
        // Join message
        if (msg.type === 'join') {
          gs.name = ((msg.nickname as string) || 'Anon').slice(0, 32)
          if (!passwordRef.current && gs.encryptKey) {
            announceJoin()
          }
          return
        }
        
        // Typing indicator
        if (msg.type === 'typing') {
          handleTypingMessage(msg.nickname as string, setTypingUsers, typingTimeouts.current)
          broadcast({ type: 'typing', nickname: msg.nickname }, gs.peerId)
          return
        }
        
        // Reaction
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
          broadcast(data as Record<string, unknown>, gs.peerId)
          return
        }
        
        // Encrypted chat message
        if (msg.type === 'chat-encrypted') {
          if (!gs.encryptKey || !msg.data) return
          let payload: Record<string, unknown> = {}
          try { payload = await decryptJSON(gs.encryptKey, msg.data as string) }
          catch { return }
          
          const chatMsg: ChatMessage = {
            text: payload.text as string || '',
            image: payload.image as string | undefined,
            mime: payload.mime as string | undefined,
            replyTo: payload.replyTo as ChatMessage['replyTo'],
            from: gs.name,
            time: msg.time as number || Date.now(),
            self: false,
          }
          setMessages(prev => [...prev, chatMsg].slice(-500))
          
          // Relay to other guests
          const relayPayload = JSON.stringify(payload)
          for (const [otherId, otherGs] of connectionsRef.current) {
            if (otherId === connId || !otherGs.encryptKey) continue
            if (!otherGs.passwordVerified && passwordRef.current) continue
            try {
              const encrypted = await encryptChunk(otherGs.encryptKey, new TextEncoder().encode(relayPayload))
              otherGs.conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: gs.name, time: msg.time })
            } catch {}
          }
          return
        }
        
        // Encrypted collab messages
        if (msg.type === 'collab-msg-enc') {
          if (!gs.encryptKey || !msg.data) return
          let payload: Record<string, unknown> = {}
          try { payload = await decryptJSON(gs.encryptKey, msg.data as string) }
          catch { return }
          
          // Handle collab-specific messages
          if (payload.type === 'collab-request-file') {
            const fileId = payload.fileId as string
            const ownerId = payload.owner as string | undefined
            
            // Check if host owns this file
            if (myFilesRef.current.has(fileId)) {
              dispatchTransfer({ type: 'START_UPLOAD', fileId, fileName: myFilesRef.current.get(fileId)?.name || fileId })
              await sendFileToRequester(gs, fileId)
              return
            }
            
            // Otherwise relay the request to the file owner (another guest)
            const sharedFile = files.sharedFiles.find(f => f.id === fileId)
            const ownerPeerId = ownerId || sharedFile?.owner
            if (ownerPeerId) {
              const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === ownerPeerId)
              if (ownerGs?.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerGs.encryptKey, {
                    type: 'collab-request-file',
                    fileId,
                    requesterPeerId: gs.peerId,
                  })
                  ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
                } catch {}
              }
            }
            return
          }
          
          if (payload.type === 'collab-file-shared') {
            // Guest shared a file - broadcast to others
            const fileData = payload.file as SharedFile
            dispatchFiles({ type: 'ADD_SHARED_FILE', payload: { ...fileData, owner: gs.peerId, ownerName: gs.name } })
            
            // Relay to other guests
            for (const [otherId, otherGs] of connectionsRef.current) {
              if (otherId === connId || !otherGs.encryptKey) continue
              if (!otherGs.passwordVerified && passwordRef.current) continue
              try {
                const encrypted = await encryptJSON(otherGs.encryptKey, { 
                  type: 'collab-file-shared', 
                  file: { ...fileData, owner: gs.peerId, ownerName: gs.name } 
                })
                otherGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
              } catch {}
            }
            return
          }
          
          // Guest removed their file
          if (payload.type === 'collab-file-removed') {
            const fileId = payload.fileId as string
            const file = filesRef.current.sharedFiles.find(f => f.id === fileId)
            // Only allow owner to remove their files
            if (file && file.owner === gs.peerId) {
              dispatchFiles({ type: 'REMOVE_SHARED_FILE', fileId })
              // Relay to other guests
              for (const [otherId, otherGs] of connectionsRef.current) {
                if (otherId === connId || !otherGs.encryptKey) continue
                if (!otherGs.passwordVerified && passwordRef.current) continue
                try {
                  const encrypted = await encryptJSON(otherGs.encryptKey, { type: 'collab-file-removed', fileId })
                  otherGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
                } catch {}
              }
            }
            return
          }
          
          // Pause file transfer from guest
          if (payload.type === 'collab-pause-file') {
            const fileId = payload.fileId as string
            // If host is sending this file to the guest, pause it
            const transfer = gs.activeTransfers.get(fileId)
            if (transfer) {
              transfer.paused = true
            }
            // Otherwise relay to file owner
            const sharedFile = files.sharedFiles.find(f => f.id === fileId)
            if (sharedFile && sharedFile.owner !== room.myPeerId) {
              const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === sharedFile.owner)
              if (ownerGs?.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerGs.encryptKey, {
                    type: 'collab-pause-file',
                    fileId,
                    requesterPeerId: gs.peerId,
                  })
                  ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
                } catch {}
              }
            }
            return
          }
          
          // Resume file transfer from guest
          if (payload.type === 'collab-resume-file') {
            const fileId = payload.fileId as string
            const transfer = gs.activeTransfers.get(fileId)
            if (transfer) {
              transfer.paused = false
              if (transfer.pauseResolver) {
                transfer.pauseResolver()
                transfer.pauseResolver = undefined
              }
            }
            // Otherwise relay to file owner
            const sharedFile = files.sharedFiles.find(f => f.id === fileId)
            if (sharedFile && sharedFile.owner !== room.myPeerId) {
              const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === sharedFile.owner)
              if (ownerGs?.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerGs.encryptKey, {
                    type: 'collab-resume-file',
                    fileId,
                    requesterPeerId: gs.peerId,
                  })
                  ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
                } catch {}
              }
            }
            return
          }
          
          // Cancel file transfer from guest
          if (payload.type === 'collab-cancel-file') {
            const fileId = payload.fileId as string
            const transfer = gs.activeTransfers.get(fileId)
            if (transfer) {
              transfer.aborted = true
              transfer.paused = false
              if (transfer.pauseResolver) {
                transfer.pauseResolver()
                transfer.pauseResolver = undefined
              }
            }
            // Relay to file owner
            const sharedFile = files.sharedFiles.find(f => f.id === fileId)
            if (sharedFile && sharedFile.owner !== room.myPeerId) {
              const ownerGs = Array.from(connectionsRef.current.values()).find(g => g.peerId === sharedFile.owner)
              if (ownerGs?.encryptKey) {
                try {
                  const encrypted = await encryptJSON(ownerGs.encryptKey, {
                    type: 'collab-cancel-file',
                    fileId,
                    requesterPeerId: gs.peerId,
                  })
                  ownerGs.conn.send({ type: 'collab-msg-enc', data: encrypted })
                } catch {}
              }
            }
            return
          }
          
          // Cancel all transfers
          if (payload.type === 'collab-cancel-all') {
            // Cancel all active transfers to this guest
            for (const transfer of gs.activeTransfers.values()) {
              transfer.aborted = true
              transfer.paused = false
              if (transfer.pauseResolver) {
                transfer.pauseResolver()
                transfer.pauseResolver = undefined
              }
            }
            return
          }
          
          // File transfer start (host receiving file from guest)
          if (payload.type === 'collab-file-start') {
            const fileId = payload.fileId as string
            const fileName = payload.name as string
            const fileSize = payload.size as number
            
            const stream = createFileStream(fileName, fileSize)
            
            inProgressFileRef.current = {
              fileId,
              name: fileName,
              size: fileSize,
              totalChunks: payload.totalChunks as number,
              chunks: [],
              receivedBytes: 0,
              stream,
              startTime: Date.now(),
              fromPeerId: gs.peerId,
            }
            dispatchFiles({ type: 'SET_DOWNLOAD', fileId, download: { status: 'downloading', progress: 0, speed: 0 } })
            return
          }
          
          // File transfer end (host receiving file from guest)
          if (payload.type === 'collab-file-end') {
            await chunkQueueRef.current
            const inFlight = inProgressFileRef.current
            inProgressFileRef.current = null
            if (!inFlight) return
            
            if (inFlight.stream) {
              try { await inFlight.stream.close() } catch {}
            } else {
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
          
          return
        }
        
        // P2P signaling relay between guests
        if (msg.type === 'collab-signal') {
          const target = msg.target as string
          relaySignal(gs.peerId, target, msg.signal)
          return
        }
        
        // Chat image handling (same as sender)
        if (msg.type === 'chat-image-start-enc') {
          if (!gs.encryptKey || !msg.data) return
          let meta: Record<string, unknown>
          try { meta = await decryptJSON(gs.encryptKey, msg.data as string) }
          catch { return }
          gs.inProgressImage = {
            mime: meta.mime as string || 'application/octet-stream',
            size: meta.size as number || 0,
            text: meta.text as string || '',
            replyTo: meta.replyTo as { text: string; from: string; time: number } | null,
            time: meta.time as number || Date.now(),
            from: gs.name,
            duration: meta.duration as number | undefined,
            chunks: [],
            receivedBytes: 0,
          }
          return
        }
        
        if (msg.type === 'chat-image-end-enc') {
          await gs.chunkQueue
          const inFlight = gs.inProgressImage
          gs.inProgressImage = undefined
          if (!inFlight) return
          
          const totalLen = inFlight.chunks.reduce((s, c) => s + c.byteLength, 0)
          const fullBytes = new Uint8Array(totalLen)
          let off = 0
          for (const c of inFlight.chunks) { fullBytes.set(c, off); off += c.byteLength }
          
          const blob = new Blob([fullBytes], { type: inFlight.mime })
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
          }].slice(-500))
          
          // Relay to other guests
          for (const [otherId, otherGs] of connectionsRef.current) {
            if (otherId === connId || !otherGs.encryptKey) continue
            if (!otherGs.passwordVerified && passwordRef.current) continue
            otherGs.imageSendQueue = otherGs.imageSendQueue
              .then(() => streamImageToConn(otherGs.conn, otherGs.encryptKey!, fullBytes, inFlight.mime, inFlight.text, inFlight.replyTo, gs.name, inFlight.time, inFlight.duration))
              .catch(() => {})
          }
          return
        }
      })
      
      conn.on('close', () => {
        if (destroyed || gs.disconnectHandled) return
        gs.disconnectHandled = true
        try { conn.removeAllListeners() } catch {}
        if (gs.heartbeat) gs.heartbeat.cleanup()
        if (gs.rttPoller) gs.rttPoller.cleanup()
        
        const name = gs.name || 'A guest'
        connectionsRef.current.delete(connId)
        refreshParticipantsList()
        setMessages(prev => [...prev, { text: `${name} left`, from: 'system', time: Date.now(), self: false }].slice(-500))
        
        broadcast({ type: 'online-count', count: connectionsRef.current.size + 1 })
        broadcast({ type: 'collab-peer-left', peerId: gs.peerId, name })
        
        if (connectionsRef.current.size === 0) {
          setRtt(null)
          dispatchRoom({ type: 'SET_STATUS', payload: 'waiting' })
        }
      })
      
      conn.on('error', () => {
        if (destroyed) return
        connectionsRef.current.delete(connId)
        refreshParticipantsList()
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
      }
      if (connectionsRef.current.size === 0) {
        dispatchRoom({ type: 'SET_STATUS', payload: 'error' })
      }
    })
    
    function handleVisibility(): void {
      if (document.visibilityState === 'visible' && !destroyed && peer.disconnected && !peer.destroyed) {
        peer.reconnect()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    
    function handleBeforeUnload(): void {
      broadcast({ type: 'room-closed' })
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
      connectionsRef.current.forEach(gs => {
        if (gs.heartbeat) gs.heartbeat.cleanup()
        if (gs.rttPoller) gs.rttPoller.cleanup()
        try { gs.conn.removeAllListeners() } catch {}
      })
      connectionsRef.current.clear()
      setPeerInstance(null)
      setParticipantsList([])
      peer.destroy()
    }
  }, [sessionKeyRef.current])

  // Handle chunk from guest (for files they're sharing)
  async function handleGuestChunk(gs: GuestConnection, rawData: ArrayBuffer): Promise<void> {
    if (!gs.encryptKey) return
    const buffer = rawData instanceof ArrayBuffer ? rawData : (rawData as ArrayBufferView).buffer as ArrayBuffer
    
    let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
    try {
      parsed = parseChunkPacket(buffer)
    } catch { return }
    
    // Chat image chunk
    if (parsed.fileIndex === CHAT_IMAGE_FILE_INDEX) {
      if (!gs.inProgressImage) return
      try {
        const decrypted = await decryptChunk(gs.encryptKey, new Uint8Array(parsed.data))
        gs.inProgressImage.chunks.push(new Uint8Array(decrypted))
        gs.inProgressImage.receivedBytes += decrypted.byteLength
      } catch {}
      return
    }
    
  // Collab file chunk (0xFFFE)
  if (parsed.fileIndex === 0xFFFE) {
  // Could be for guest-to-guest transfer (gs.inProgressFile) or host downloading from guest (inProgressFileRef)
  if (gs.inProgressFile) {
    try {
      const decrypted = await decryptChunk(gs.encryptKey, new Uint8Array(parsed.data))
      gs.inProgressFile.chunks.push(new Uint8Array(decrypted))
      gs.inProgressFile.receivedBytes += decrypted.byteLength
    } catch {}
    return
  }
  
  // Host receiving a file from this guest
  if (inProgressFileRef.current && inProgressFileRef.current.fromPeerId === gs.peerId) {
    const inFlight = inProgressFileRef.current
    try {
      const decrypted = await decryptChunk(gs.encryptKey, new Uint8Array(parsed.data))
      
      if (inFlight.stream) {
        try { await inFlight.stream.write(new Uint8Array(decrypted)) } catch {}
      } else {
        inFlight.chunks.push(new Uint8Array(decrypted))
      }
      inFlight.receivedBytes += decrypted.byteLength
      
      const progress = Math.round((inFlight.receivedBytes / inFlight.size) * 100)
      const elapsed = (Date.now() - inFlight.startTime) / 1000
      const speed = elapsed > 0.5 ? inFlight.receivedBytes / elapsed : 0
      dispatchFiles({ type: 'UPDATE_DOWNLOAD', fileId: inFlight.fileId, payload: { progress, speed } })
    } catch {}
    return
  }
  return
  }
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
      const localBlob = new Blob([bytes as unknown as BlobPart], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { text: text || '', image: localUrl, mime, duration, replyTo, from: 'You', time, self: true }].slice(-500))
      
      for (const gs of connectionsRef.current.values()) {
        if (!gs.encryptKey) continue
        if (!gs.passwordVerified && passwordRef.current) continue
        gs.imageSendQueue = gs.imageSendQueue
          .then(() => streamImageToConn(gs.conn, gs.encryptKey!, bytes, mime, text || '', replyTo ?? null, room.myName, time, duration))
          .catch(() => {})
      }
      return
    }
    
    const imgStr = image as string | undefined
    setMessages(prev => [...prev, { text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ text, image: imgStr, replyTo })
    for (const gs of connectionsRef.current.values()) {
      if (!gs.encryptKey) continue
      if (!gs.passwordVerified && passwordRef.current) continue
      try {
        const encrypted = await encryptChunk(gs.encryptKey, new TextEncoder().encode(payload))
        gs.conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: room.myName, time })
      } catch {}
    }
  }, [room.myName])

  const sendTyping = useCallback((): void => {
    broadcast({ type: 'typing', nickname: room.myName })
  }, [broadcast, room.myName])

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
    broadcast({ type: 'reaction', msgId, emoji, nickname: room.myName })
  }, [broadcast, room.myName])

  const setMyName = useCallback((name: string): void => {
    dispatchRoom({ type: 'SET', payload: { myName: name.trim() || 'Host' } })
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
    imageBlobUrlsRef.current = []
  }, [])

  const reset = useCallback((): void => {
    Object.values(typingTimeouts.current).forEach(clearTimeout)
    typingTimeouts.current = {}
    connectionsRef.current.forEach(gs => {
      if (gs.heartbeat) gs.heartbeat.cleanup()
      if (gs.rttPoller) gs.rttPoller.cleanup()
      try { gs.conn.removeAllListeners() } catch {}
    })
    connectionsRef.current.clear()
    if (peerRef.current) peerRef.current.destroy()
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
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
    sessionKeyRef.current += 1
  }, [])

  return {
    // Room state
    roomId: room.roomId,
    status: room.status,
    myPeerId: room.myPeerId,
    myName: room.myName,
    isHost: true,
    fingerprint: room.fingerprint,
    
    // Participants
    participants: participants.participants,
    onlineCount: participants.onlineCount,
    
    // Files
    sharedFiles: files.sharedFiles,
    downloads: files.downloads,
    mySharedFiles: files.mySharedFiles,
    
    // FileList-compatible state
    progress: files.progress,
    pendingFiles: files.pendingFiles,
    pausedFiles: files.pausedFiles,
    completedFiles: files.completedFiles,
    currentFileIndex: files.currentFileIndex,
    
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
