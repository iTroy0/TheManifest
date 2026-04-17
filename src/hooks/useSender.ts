import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { chunkFileAdaptive, buildChunkPacket, parseChunkPacket, waitForBufferDrain, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, uint8ToBase64, base64ToUint8, timingSafeEqual } from '../utils/crypto'
import { finalizeKeyExchange } from '../net/keyExchange'
import { STUN_ONLY } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { buildManifestData } from '../utils/manifest'
import {
  transferReducer,
  connectionReducer,
  initialTransfer,
  initialConnection,
} from './state/senderState'
import { ChatMessage } from '../types'
import { MAX_CONNECTIONS, MAX_CHAT_IMAGE_SIZE } from '../net/config'
import type { PortalMsg } from '../net/protocol'
import { log } from '../utils/logger'

// ── Types ────────────────────────────────────────────────────────────────

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

interface ConnState {
  conn: DataConnection
  encryptKey: CryptoKey | null
  keyPair: CryptoKeyPair | null
  abort: { aborted: boolean }
  progress: Record<string, number>
  totalSent: number
  startTime: number | null
  transferTotalSize: number
  speed: number
  currentFileIndex: number
  transferring: boolean
  inProgressImage: InProgressImage | null
  chunkQueue: Promise<void>
  imageSendQueue: Promise<void>
  nickname?: string
  heartbeat?: ReturnType<typeof setupHeartbeat>
  rttPoller?: ReturnType<typeof setupRTTPolling>
  disconnectHandled?: boolean
  pendingJoinAnnounce?: boolean
  passwordAttempts?: number
  pauseResolvers?: Record<number, () => void>
  cancelledFiles?: Set<number>
  pausedFiles?: Set<number>
  chunker?: InstanceType<typeof AdaptiveChunker>
  progressThrottler?: InstanceType<typeof ProgressThrottler>
  pendingRemoteKey?: Uint8Array | null
  keyExchangeTimeout?: ReturnType<typeof setTimeout>
  fingerprint?: string
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useSender() {
  const [transfer, dispatchTransfer] = useReducer(transferReducer, initialTransfer)
  const [conn, dispatchConn] = useReducer(connectionReducer, initialConnection)
  const [sessionKey, setSessionKey] = useState<number>(0)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [rtt, setRtt] = useState<number | null>(null)
  const [senderName, setSenderName] = useState<string>('Host')
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastMsgTime = useRef<number>(0)
  const peerRef = useRef<InstanceType<typeof Peer> | null>(null)
  const filesRef = useRef<File[]>([])
  const connectionsRef = useRef<Map<string, ConnState>>(new Map())
  const passwordRef = useRef<string | null>(null)
  const chatOnlyRef = useRef<boolean>(false)
  const imageBlobUrlsRef = useRef<string[]>([])
  const globalPasswordAttempts = useRef<number>(0)
  const lastPasswordAttemptTime = useRef<number>(0)

  // Call plumbing — exposed to useCall as a lightweight bus. useCall is the
  // only consumer; we keep a single handler slot rather than a pub/sub list.
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const [participants, setParticipants] = useState<Array<{ peerId: string; name: string }>>([])
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const refreshParticipants = useCallback((): void => {
    const list: Array<{ peerId: string; name: string }> = []
    connectionsRef.current.forEach(cs => {
      list.push({ peerId: cs.conn.peer, name: cs.nickname || 'Anon' })
    })
    setParticipants(list)
  }, [])

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((peerId: string, msg: Record<string, unknown>): void => {
    connectionsRef.current.forEach(cs => {
      if (cs.conn.peer === peerId) {
        try { cs.conn.send(msg) } catch (e) { log.warn('useSender.sendCallMessage', e) }
      }
    })
  }, [])

  const broadcastCallMessage = useCallback((msg: Record<string, unknown>, exceptPeerId?: string): void => {
    connectionsRef.current.forEach(cs => {
      if (exceptPeerId && cs.conn.peer === exceptPeerId) return
      try { cs.conn.send(msg) } catch (e) { log.warn('useSender.broadcastCallMessage', e) }
    })
  }, [])

  const setFiles = useCallback((files: File[]): void => {
    filesRef.current = files
  }, [])

  const setPassword = useCallback((pwd: string): void => {
    passwordRef.current = pwd || null
  }, [])

  const setChatOnly = useCallback((val: boolean): void => {
    chatOnlyRef.current = val
  }, [])

  useEffect(() => {
    if (!window.crypto?.subtle) { dispatchConn({ type: 'SET_STATUS', payload: 'error' }); return }
    let destroyed = false
    const peer = new Peer(STUN_ONLY)
    peerRef.current = peer

    peer.on('open', (id: string) => {
      if (destroyed) return
      dispatchConn({ type: 'SET', payload: { peerId: id, status: 'waiting' } })
      setPeerInstance(peer)
    })

    peer.on('connection', (conn: DataConnection) => {
      if (destroyed) return

      if (connectionsRef.current.size >= MAX_CONNECTIONS) {
        conn.close()
        return
      }

      const connId = conn.peer + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6)
      const connState: ConnState = {
        conn, encryptKey: null, keyPair: null, abort: { aborted: false },
        progress: {}, totalSent: 0, startTime: null, transferTotalSize: 0,
        speed: 0, currentFileIndex: -1, transferring: false,
        inProgressImage: null,
        chunkQueue: Promise.resolve(),
        imageSendQueue: Promise.resolve(),
      }
      connectionsRef.current.set(connId, connState)

      function announceJoin(cs: ConnState, cId: string): void {
        dispatchConn({ type: 'SET', payload: { status: 'connected', recipientCount: connectionsRef.current.size } })
        refreshParticipants()
        // Fall back to 'Anon' when the peer hasn't sent a `nickname` yet —
        // reconnect / password-gate paths can announce before the join
        // message lands, which used to render as "  joined".
        const name = cs.nickname || 'Anon'
        setMessages(prev => [...prev, { text: `${name} joined`, from: 'system', time: Date.now(), self: false }].slice(-500))
        const count = connectionsRef.current.size + 1
        connectionsRef.current.forEach((other, id) => {
          try { other.conn.send({ type: 'online-count', count } satisfies PortalMsg) } catch (e) { log.warn('useSender.announceJoin.onlineCount', e) }
          if (id !== cId) {
            try { other.conn.send({ type: 'system-msg', text: `${name} joined`, time: Date.now() } satisfies PortalMsg) } catch (e) { log.warn('useSender.announceJoin.systemMsg', e) }
          }
        })
      }

      function aggregateUI(): void {
        const conns = Array.from(connectionsRef.current.values())
        const active = conns.filter(cs => cs.transferring)

        const merged: Record<string, number> = {}
        for (const cs of active) {
          for (const [name, pct] of Object.entries(cs.progress || {})) {
            if (merged[name] === undefined) merged[name] = pct
            else merged[name] = Math.max(merged[name], pct)
          }
        }

        const activeWithFile = active.find(cs => cs.currentFileIndex >= 0)

        if (active.length === 0) {
          dispatchTransfer({ type: 'SET', payload: { progress: merged, currentFileIndex: -1, totalSent: 0, overallProgress: 0, speed: 0, eta: null } })
          return
        }

        const sent = active.reduce((s, cs) => s + cs.totalSent, 0)
        const total = active.reduce((s, cs) => s + cs.transferTotalSize, 0)
        const spd = active.reduce((s, cs) => s + cs.speed, 0)
        dispatchTransfer({ type: 'SET', payload: {
          progress: merged,
          currentFileIndex: activeWithFile ? activeWithFile.currentFileIndex : -1,
          totalSent: sent,
          overallProgress: total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0,
          speed: spd,
          eta: spd > 0 ? Math.max(0, (total - sent) / spd) : null,
        }})
      }

      // Hoisted out of `conn.on('data')` so we don't allocate two new
      // closures on every inbound message. Same lifetime as connState.
      function startTransfer(transferSize: number): void {
        connState.abort = { aborted: false }
        connState.totalSent = 0
        connState.startTime = Date.now()
        connState.progress = {}
        connState.speed = 0
        connState.transferTotalSize = transferSize
        connState.transferring = true
        dispatchConn({ type: 'SET_STATUS', payload: 'transferring' })
      }

      function endTransfer(): void {
        connState.transferring = false
        connState.currentFileIndex = -1
        aggregateUI()
        const anyActive = Array.from(connectionsRef.current.values()).some(cs => cs.transferring)
        if (!anyActive) dispatchConn({ type: 'SET_STATUS', payload: 'connected' })
      }

      async function sendManifest(c: DataConnection, key: CryptoKey): Promise<void> {
        const manifest = await buildManifestData(filesRef.current, chatOnlyRef.current)
        // Encrypt the manifest with the ECDH-derived shared key so a MITM cannot
        // inject attacker-controlled filenames/sizes before trust is established.
        try {
          const encrypted = await encryptJSON(key, manifest)
          c.send({ type: 'manifest-enc', data: encrypted } satisfies PortalMsg)
        } catch (e) {
          console.warn('Failed to encrypt manifest:', e)
        }
      }

      conn.on('open', async () => {
        if (destroyed) return
        if (!passwordRef.current) dispatchConn({ type: 'SET_STATUS', payload: 'connected' })

        connState.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

        function handlePeerDisconnect(reason: string): void {
          if (connState.disconnectHandled || destroyed) return
          connState.disconnectHandled = true
          connState.abort.aborted = true
          if (connState.heartbeat) connState.heartbeat.cleanup()
          if (connState.rttPoller) connState.rttPoller.cleanup()
          if (connState.keyExchangeTimeout) clearTimeout(connState.keyExchangeTimeout)
          if (connState.pauseResolvers) {
            Object.values(connState.pauseResolvers).forEach(r => r())
            connState.pauseResolvers = {}
          }
          try { conn.removeAllListeners() } catch (e) { log.warn('useSender.handlePeerDisconnect.removeListeners', e) }
          // Null ICE handler to release the closure holding connState
          if (conn.peerConnection) {
            try { conn.peerConnection.oniceconnectionstatechange = null } catch (e) { log.warn('useSender.handlePeerDisconnect.clearIce', e) }
          }
          const name = connState.nickname || 'A recipient'
          connectionsRef.current.delete(connId)
          dispatchConn({ type: 'SET', payload: { recipientCount: connectionsRef.current.size } })
          refreshParticipants()
          setMessages(prev => [...prev, { text: `${name} ${reason}`, from: 'system', time: Date.now(), self: false }].slice(-500))
          const newCount = connectionsRef.current.size + 1
          connectionsRef.current.forEach(cs => {
            try {
              cs.conn.send({ type: 'online-count', count: newCount } satisfies PortalMsg)
              cs.conn.send({ type: 'system-msg', text: `${name} ${reason}`, time: Date.now() } satisfies PortalMsg)
            } catch (e) { log.warn('useSender.handlePeerDisconnect.broadcast', e) }
          })
          if (connectionsRef.current.size === 0) {
            setRtt(null)
            dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'done' ? prev : 'waiting' })
          }
        }

        connState.heartbeat = setupHeartbeat(conn, {
          onDead: () => handlePeerDisconnect('connection lost'),
        })

        const pc = conn.peerConnection
        if (pc) {
          const prevIceHandler = pc.oniceconnectionstatechange
          pc.oniceconnectionstatechange = (ev) => {
            if (typeof prevIceHandler === 'function') prevIceHandler.call(pc, ev)
            const s = pc.iceConnectionState
            if (s === 'disconnected' || s === 'failed' || s === 'closed') {
              handlePeerDisconnect('left')
            }
          }
        }

        connState.keyPair = await generateKeyPair()
        const pubKeyBytes = await exportPublicKey(connState.keyPair.publicKey)
        conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies PortalMsg)

        // ECDH key exchange timeout
        connState.keyExchangeTimeout = setTimeout(() => {
          if (!connState.encryptKey) {
            console.warn('Key exchange timed out for', connId)
            conn.close()
          }
        }, 10_000)

        // Handle deferred public key if receiver responded before our key was ready
        if (connState.pendingRemoteKey) {
          try {
            const { encryptKey, fingerprint } = await finalizeKeyExchange({
              localPrivate: connState.keyPair.privateKey,
              localPublic: pubKeyBytes,
              remotePublic: connState.pendingRemoteKey,
            })
            connState.encryptKey = encryptKey
            if (connState.keyExchangeTimeout) { clearTimeout(connState.keyExchangeTimeout); connState.keyExchangeTimeout = undefined }
            connState.fingerprint = fingerprint
            dispatchConn({ type: 'SET', payload: { fingerprint } })
            connState.pendingRemoteKey = null
            if (passwordRef.current) {
              conn.send({ type: 'password-required' } satisfies PortalMsg)
            } else {
              await sendManifest(conn, connState.encryptKey)
            }
          } catch (e) {
            log.warn('useSender.pendingRemoteKey.derive', e)
            conn.close()
          }
        }
      })

      conn.on('data', async (data: unknown) => {
        if (destroyed) return
        if (connState.heartbeat) connState.heartbeat.markAlive()

        // Binary chunk packet — routed through the chunk queue. Must come
        // before the PortalMsg cast: ArrayBuffers don't have a `type` field
        // and shouldn't be treated as JSON messages.
        if (data instanceof ArrayBuffer || (data && (data as ArrayBuffer).byteLength !== undefined && !(typeof data === 'object' && (data as { type?: unknown }).type))) {
          connState.chunkQueue = connState.chunkQueue
            .then(() => handleHostChunk(connState, data as ArrayBuffer))
            .catch(e => log.warn('useSender.chunkQueue', e))
          return
        }

        // Call messages (call-*) route through to useCall — they aren't
        // part of PortalMsg. Pull them off before the union cast so the
        // narrowing switch below isn't confused by call-* literals.
        const raw = data as { type?: unknown }
        if (typeof raw.type === 'string' && raw.type.startsWith('call-')) {
          if (callMessageHandlerRef.current) {
            try { callMessageHandlerRef.current(conn.peer, raw as Record<string, unknown>) }
            catch (e) { log.warn('useSender.callMessageHandler', e) }
          }
          return
        }

        // Trust boundary — a peer can send any JSON, but after the binary
        // check every valid payload should match PortalMsg. Each branch
        // below narrows the union via `msg.type === 'X'`. Fields that
        // aren't on the union (defensive reads of unknown shapes from
        // buggy or hostile peers) still compile via `as` casts.
        const msg = data as PortalMsg

        if (msg.type === 'pong') return
        if (msg.type === 'ping') {
          try { conn.send({ type: 'pong', ts: msg.ts } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendPong', e) }
          return
        }

        if (msg.type === 'public-key') {
          const remoteKeyRaw = new Uint8Array(msg.key as number[])
          if (!connState.keyPair) {
            // Key pair not ready yet — defer until generateKeyPair resolves
            connState.pendingRemoteKey = remoteKeyRaw
            return
          }
          try {
            const localPubBytes = await exportPublicKey(connState.keyPair.publicKey)
            const { encryptKey, fingerprint } = await finalizeKeyExchange({
              localPrivate: connState.keyPair.privateKey,
              localPublic: localPubBytes,
              remotePublic: remoteKeyRaw,
            })
            connState.encryptKey = encryptKey
            if (connState.keyExchangeTimeout) { clearTimeout(connState.keyExchangeTimeout); connState.keyExchangeTimeout = undefined }
            connState.fingerprint = fingerprint
            dispatchConn({ type: 'SET', payload: { fingerprint } })

            if (passwordRef.current) {
              conn.send({ type: 'password-required' } satisfies PortalMsg)
            } else {
              await sendManifest(conn, connState.encryptKey)
            }
          } catch (e) {
            log.warn('useSender.publicKey.derive', e)
            conn.close()
          }
          return
        }

        if (msg.type === 'password-encrypted') {
          const now = Date.now()
          // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at 30s
          const backoffMs = Math.min(30_000, 1000 * Math.pow(2, Math.max(0, globalPasswordAttempts.current - 1)))
          if (now - lastPasswordAttemptTime.current < backoffMs) {
            try { conn.send({ type: 'password-rate-limited' } satisfies PortalMsg) } catch (e) { log.warn('useSender.passwordRateLimited.send', e) }
            return
          }
          lastPasswordAttemptTime.current = now
          globalPasswordAttempts.current += 1
          connState.passwordAttempts = (connState.passwordAttempts || 0) + 1
          if (globalPasswordAttempts.current > 8 || connState.passwordAttempts > 5) {
            conn.send({ type: 'password-locked' } satisfies PortalMsg)
            conn.close()
            return
          }
          let password = ''
          if (connState.encryptKey && msg.data) {
            try {
              const decrypted = await decryptChunk(connState.encryptKey, base64ToUint8(msg.data as string))
              password = new TextDecoder().decode(decrypted)
            } catch (e) { log.warn('useSender.passwordDecrypt', e); conn.send({ type: 'password-wrong' } satisfies PortalMsg); return }
          }
          const expected = passwordRef.current || ''
          const matched = password.length > 0 && timingSafeEqual(password, expected)

          if (matched) {
            // Reset the global attempt counter on success so one legitimate
            // unlock clears any backoff accumulated from prior typos.
            // Without this, the global counter grew monotonically and any
            // room that hit 8 lifetime wrong guesses would reject every
            // future guest regardless of whether they had the password.
            globalPasswordAttempts.current = 0
            lastPasswordAttemptTime.current = 0
            connState.passwordAttempts = 0
            conn.send({ type: 'password-accepted' } satisfies PortalMsg)
            if (connState.pendingJoinAnnounce) {
              connState.pendingJoinAnnounce = false
              announceJoin(connState, connId)
            }
            if (connState.encryptKey) await sendManifest(conn, connState.encryptKey)
          } else {
            conn.send({ type: 'password-wrong' } satisfies PortalMsg)
          }
          return
        }

        if (msg.type === 'typing') {
          handleTypingMessage(msg.nickname as string, setTypingUsers, typingTimeouts.current)
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) { try { cs.conn.send({ type: 'typing', nickname: msg.nickname } satisfies PortalMsg) } catch (e) { log.warn('useSender.relayTyping', e) } }
          })
          return
        }

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
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) { try { cs.conn.send(data) } catch (e) { log.warn('useSender.relayReaction', e) } }
          })
          return
        }

        if (msg.type === 'chat-encrypted') {
          let payload: Record<string, unknown> = {}
          if (connState.encryptKey && msg.data) {
            try { payload = await decryptJSON(connState.encryptKey, msg.data as string) }
            catch (e) { log.warn('useSender.chatEncrypted.decrypt', e); return }
          }
          const chatMsg: ChatMessage = { text: payload.text as string || '', image: payload.image as string | undefined, mime: payload.mime as string | undefined, replyTo: payload.replyTo as ChatMessage['replyTo'], from: msg.nickname as string || 'Anon', time: msg.time as number, self: false }
          setMessages(prev => [...prev, chatMsg].slice(-500))
          const relayPayload = JSON.stringify(payload)
          for (const [id, cs] of connectionsRef.current) {
            if (id !== connId && cs.encryptKey) {
              try {
                const encrypted = await encryptChunk(cs.encryptKey, new TextEncoder().encode(relayPayload))
                cs.conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: msg.nickname || 'Anon', time: msg.time } satisfies PortalMsg)
              } catch (e) { log.warn('useSender.chatEncrypted.relay', e) }
            }
          }
          return
        }

        // Mid-stream abort from peer — clear the in-progress image slot so
        // accumulated bytes don't linger until the next start message.
        if (msg.type === 'chat-image-abort') {
          connState.inProgressImage = null
          return
        }

        if (msg.type === 'chat-image-start-enc') {
          if (!connState.encryptKey || !msg.data) return
          let meta: Record<string, unknown>
          try { meta = await decryptJSON(connState.encryptKey, msg.data as string) }
          catch (e) { log.warn('useSender.chatImageStart.decrypt', e); return }
          connState.inProgressImage = {
            mime: meta.mime as string || 'application/octet-stream',
            size: meta.size as number || 0,
            text: meta.text as string || '',
            replyTo: meta.replyTo as InProgressImage['replyTo'] || null,
            time: meta.time as number || Date.now(),
            from: msg.from as string || connState.nickname || 'Anon',
            duration: meta.duration as number | undefined,
            chunks: [],
            receivedBytes: 0,
          }
          return
        }

        if (msg.type === 'chat-image-end-enc') {
          await connState.chunkQueue
          const inFlight = connState.inProgressImage
          connState.inProgressImage = null
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

          for (const [otherId, otherCs] of connectionsRef.current) {
            if (otherId === connId || !otherCs.encryptKey) continue
            otherCs.imageSendQueue = otherCs.imageSendQueue
              .then(() => streamImageToConn(
                otherCs.conn, otherCs.encryptKey!, fullBytes,
                inFlight.mime, inFlight.text, inFlight.replyTo,
                inFlight.from, inFlight.time, inFlight.duration
              ))
              .catch(e => log.warn('useSender.chatImage.relay', e))
          }
          return
        }

        if (msg.type === 'join') {
          connState.nickname = (msg.nickname as string || '').slice(0, 32)
          const now = Date.now()
          for (const [otherId, otherCs] of connectionsRef.current) {
            if (otherId === connId) continue
            if (otherCs.nickname !== msg.nickname) continue
            const lastSeen = otherCs.heartbeat ? otherCs.heartbeat.getLastSeen() : 0
            if (now - lastSeen < 10000) continue
            otherCs.abort.aborted = true
            if (otherCs.heartbeat) otherCs.heartbeat.cleanup()
            if (otherCs.rttPoller) otherCs.rttPoller.cleanup()
            try { otherCs.conn.close() } catch (e) { log.warn('useSender.join.closeDup', e) }
            connectionsRef.current.delete(otherId)
          }

          if (passwordRef.current) {
            connState.pendingJoinAnnounce = true
          } else {
            announceJoin(connState, connId)
          }
          return
        }

        if (msg.type === 'nickname-change') {
          const oldName = connState.nickname || msg.oldName as string
          connState.nickname = (msg.newName as string || '').slice(0, 32)
          refreshParticipants()
          const changeMsg = `${oldName} is now ${msg.newName}`
          setMessages(prev => [...prev, { text: changeMsg, from: 'system', time: Date.now(), self: false }].slice(-500))
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) {
              try { cs.conn.send({ type: 'system-msg', text: changeMsg, time: Date.now() } satisfies PortalMsg) } catch (e) { log.warn('useSender.nicknameChange.broadcast', e) }
            }
          })
          return
        }

        if (msg.type === 'cancel-all') {
          connState.abort = { aborted: true }
          connState.transferring = false
          connState.progress = {}
          connState.totalSent = 0
          connState.speed = 0
          if (connState.pauseResolvers) {
            Object.values(connState.pauseResolvers).forEach(r => r())
            connState.pauseResolvers = {}
          }
          aggregateUI()
          const anyActive = Array.from(connectionsRef.current.values()).some(cs => cs.transferring)
          if (!anyActive) dispatchConn({ type: 'SET_STATUS', payload: 'connected' })
          return
        }

        if (msg.type === 'cancel-file') {
          if (!connState.cancelledFiles) connState.cancelledFiles = new Set()
          connState.cancelledFiles.add(msg.index as number)
          connState.pausedFiles?.delete(msg.index as number)
          if (connState.pauseResolvers?.[msg.index as number]) {
            connState.pauseResolvers[msg.index as number]()
          }
          return
        }

        if (msg.type === 'pause-file') {
          if (!connState.pausedFiles) connState.pausedFiles = new Set()
          connState.pausedFiles.add(msg.index as number)
          return
        }

        if (msg.type === 'resume-file') {
          connState.pausedFiles?.delete(msg.index as number)
          if (connState.pauseResolvers?.[msg.index as number]) {
            connState.pauseResolvers[msg.index as number]()
          }
          return
        }

        if (msg.type === 'request-file') {
          const file = filesRef.current[msg.index as number]
          if (!file) return
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
          // Clamp to totalChunks - 1 so request for the last chunk still sends it.
          // A resumeChunk === totalChunks would skip the whole file but still send file-end.
          const resumeChunk = Math.min(Math.max(0, (msg.resumeChunk as number) || 0), Math.max(0, totalChunks - 1))
          startTransfer(file.size)
          try {
            await sendSingleFile(conn, filesRef.current, msg.index as number, resumeChunk, connState, connState.encryptKey, aggregateUI)
            if (!connState.abort.aborted) endTransfer()
          } catch (e) {
            console.warn('sendSingleFile failed:', e)
            connState.abort.aborted = true
            endTransfer()
            try { conn.close() } catch (e) { log.warn('useSender.requestFile.closeAfterFail', e) }
          }
        }

        if (msg.type === 'request-all') {
          const indices: number[] = (msg.indices as number[]) || filesRef.current.map((_, i) => i)
          const transferSize = indices.reduce((sum, i) => sum + (filesRef.current[i]?.size || 0), 0)
          startTransfer(transferSize)
          for (const idx of indices) {
            if (connState.abort.aborted) break
            try { await sendSingleFile(conn, filesRef.current, idx, 0, connState, connState.encryptKey, aggregateUI) }
            catch (e) {
              log.warn('useSender.requestAll.skip', e)
              // Tell the receiver why the file is missing from the batch so
              // it can surface the failure instead of silently completing
              // with fewer files than requested.
              try { conn.send({ type: 'file-skipped', index: idx, reason: (e as Error)?.message || 'send-failed' } satisfies PortalMsg) }
              catch (sendErr) { log.warn('useSender.requestAll.skipNotify', sendErr) }
            }
          }
          if (!connState.abort.aborted) {
            conn.send({ type: 'batch-done' } satisfies PortalMsg)
            endTransfer()
          }
        }

        if (msg.type === 'ready') {
          const transferSize = filesRef.current.reduce((sum, f) => sum + f.size, 0)
          startTransfer(transferSize)
          for (let i = 0; i < filesRef.current.length; i++) {
            if (connState.abort.aborted) break
            try { await sendSingleFile(conn, filesRef.current, i, 0, connState, connState.encryptKey, aggregateUI) }
            catch (e) {
              log.warn('useSender.ready.skip', e)
              try { conn.send({ type: 'file-skipped', index: i, reason: (e as Error)?.message || 'send-failed' } satisfies PortalMsg) }
              catch (sendErr) { log.warn('useSender.ready.skipNotify', sendErr) }
            }
          }
          if (!connState.abort.aborted) {
            conn.send({ type: 'done' } satisfies PortalMsg)
            connState.transferring = false
            dispatchConn({ type: 'SET_STATUS', payload: 'done' })
          }
        }

        if (msg.type === 'resume') {
          const transferSize = filesRef.current[msg.fileIndex as number]?.size || 0
          startTransfer(transferSize)
          await sendSingleFile(conn, filesRef.current, msg.fileIndex as number, msg.chunkIndex as number, connState, connState.encryptKey, aggregateUI)
          if (!connState.abort.aborted) endTransfer()
        }
      })

      conn.on('close', () => {
        if (destroyed || connState.disconnectHandled) return
        connState.disconnectHandled = true
        try { conn.removeAllListeners() } catch (e) { log.warn('useSender.close.removeListeners', e) }
        if (conn.peerConnection) {
          try { conn.peerConnection.oniceconnectionstatechange = null } catch (e) { log.warn('useSender.close.clearIce', e) }
        }
        connState.abort.aborted = true
        if (connState.heartbeat) connState.heartbeat.cleanup()
        if (connState.rttPoller) connState.rttPoller.cleanup()
        const name = connState.nickname || 'A recipient'
        if (name && typingTimeouts.current[name]) {
          clearTimeout(typingTimeouts.current[name])
          delete typingTimeouts.current[name]
        }
        setTypingUsers(prev => prev.filter(n => n !== name))
        connectionsRef.current.delete(connId)
        dispatchConn({ type: 'SET', payload: { recipientCount: connectionsRef.current.size } })
        refreshParticipants()
        setMessages(prev => [...prev, { text: `${name} left`, from: 'system', time: Date.now(), self: false }].slice(-500))
        const count = connectionsRef.current.size + 1
        connectionsRef.current.forEach(cs => {
          try {
            cs.conn.send({ type: 'online-count', count } satisfies PortalMsg)
            cs.conn.send({ type: 'system-msg', text: `${name} left`, time: Date.now() } satisfies PortalMsg)
          } catch (e) { log.warn('useSender.close.broadcastLeft', e) }
        })
        if (connectionsRef.current.size === 0) {
          setRtt(null)
          dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'done' ? prev : 'waiting' })
        }
      })

      conn.on('error', (err: unknown) => {
        if (destroyed) return
        console.warn('sender conn.on("error"):', err)
        connState.abort.aborted = true
        if (connState.heartbeat) connState.heartbeat.cleanup()
        if (connState.rttPoller) connState.rttPoller.cleanup()
        connectionsRef.current.delete(connId)
        dispatchConn({ type: 'SET', payload: { recipientCount: connectionsRef.current.size } })
        refreshParticipants()
        // If this was our only connection, surface a status so the UI doesn't
        // sit silently in 'waiting' with no indication that a channel died.
        if (connectionsRef.current.size === 0) {
          setRtt(null)
          dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'done' ? prev : 'waiting' })
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
        // A recipient tried to connect with a stale sender id, or the signaling
        // server couldn't find them. Not fatal to the session — just ignore
        // unless we have no live connections.
        if (connectionsRef.current.size > 0) return
      }
      if (connectionsRef.current.size === 0) {
        dispatchConn({ type: 'SET_STATUS', payload: 'error' })
      }
    })

    function handleVisibility(): void {
      if (document.visibilityState !== 'visible' || destroyed) return
      if (peer.disconnected && !peer.destroyed) peer.reconnect()
      // Reset heartbeat liveness on every live recipient so the 5s check-
      // timer that just un-paused can't false-positive on its first tick.
      connectionsRef.current.forEach(cs => { if (cs.heartbeat) cs.heartbeat.markAlive() })
    }
    document.addEventListener('visibilitychange', handleVisibility)

    function handleBeforeUnload(): void {
      connectionsRef.current.forEach(cs => {
        try { cs.conn.send({ type: 'closing' } satisfies PortalMsg) } catch (e) { log.warn('useSender.beforeUnload.sendClosing', e) }
      })
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    // iOS Safari does not reliably fire beforeunload — pagehide is the correct event
    window.addEventListener('pagehide', handleBeforeUnload)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      destroyed = true
      connectionsRef.current.forEach(cs => {
        cs.abort.aborted = true
        try { cs.conn.removeAllListeners() } catch (e) { log.warn('useSender.unmount.removeListeners', e) }
      })
      connectionsRef.current.clear()
      setPeerInstance(null)
      setParticipants([])
      peer.destroy()
    }
  }, [sessionKey])

  const sendMessage = useCallback(async (text: string, image?: { bytes: Uint8Array; mime: string } | string, replyTo?: ChatMessage['replyTo']): Promise<void> => {
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

      for (const cs of connectionsRef.current.values()) {
        if (!cs.encryptKey) continue
        const key = cs.encryptKey
        cs.imageSendQueue = cs.imageSendQueue
          .then(() => streamImageToConn(cs.conn, key, bytes, mime, text || '', replyTo ?? null, senderName, time, duration))
          .catch(e => log.warn('useSender.sendMessage.imageQueue', e))
      }
      return
    }

    const imgStr = image as string | undefined
    setMessages(prev => [...prev, { text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ text, image: imgStr, replyTo })
    for (const cs of connectionsRef.current.values()) {
      try {
        if (cs.encryptKey) {
          const encrypted = await encryptChunk(cs.encryptKey, new TextEncoder().encode(payload))
          cs.conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: senderName, time } satisfies PortalMsg)
        }
      } catch (e) { log.warn('useSender.sendMessage.chatEncrypt', e) }
    }
  }, [senderName])

  const sendTyping = useCallback((): void => {
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'typing', nickname: senderName } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendTyping', e) }
    })
  }, [senderName])

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
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'reaction', msgId, emoji, nickname: senderName } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendReaction', e) }
    })
  }, [senderName])

  const changeSenderName = useCallback((newName: string): void => {
    if (!newName.trim()) return
    const oldName = senderName
    setSenderName(newName.trim())
    const msg = `${oldName} is now ${newName.trim()}`
    setMessages(prev => [...prev, { text: msg, from: 'system', time: Date.now(), self: false }].slice(-500))
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'system-msg', text: msg, time: Date.now() } satisfies PortalMsg) } catch (e) { log.warn('useSender.changeSenderName.broadcast', e) }
    })
  }, [senderName])

  const broadcastManifest = useCallback(async (): Promise<void> => {
    if (connectionsRef.current.size === 0) return
    const manifest = await buildManifestData(filesRef.current, chatOnlyRef.current)
    for (const cs of connectionsRef.current.values()) {
      if (!cs.encryptKey) continue
      try {
        const encrypted = await encryptJSON(cs.encryptKey, manifest)
        cs.conn.send({ type: 'manifest-enc', data: encrypted } satisfies PortalMsg)
      } catch (e) { console.warn('Failed to broadcast manifest:', e) }
    }
  }, [])

  const reset = useCallback((): void => {
    Object.values(typingTimeouts.current).forEach(clearTimeout)
    typingTimeouts.current = {}
    connectionsRef.current.forEach(cs => {
      cs.abort.aborted = true
      try { cs.conn.removeAllListeners() } catch (e) { log.warn('useSender.reset.removeListeners', e) }
    })
    connectionsRef.current.clear()
    if (peerRef.current) peerRef.current.destroy()
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useSender.reset.revokeBlob', e) } })
    imageBlobUrlsRef.current = []
    filesRef.current = []
    passwordRef.current = null
    chatOnlyRef.current = false
    dispatchTransfer({ type: 'RESET' })
    dispatchConn({ type: 'RESET' })
    setMessages([])
    setRtt(null)
    setSenderName('Host')
    setTypingUsers([])
    setSessionKey(k => k + 1)
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useSender.clearMessages.revokeBlob', e) } })
    imageBlobUrlsRef.current = []
  }, [])

  return { peerId: conn.peerId, status: conn.status, progress: transfer.progress, overallProgress: transfer.overallProgress, speed: transfer.speed, eta: transfer.eta, setFiles, reset, currentFileIndex: transfer.currentFileIndex, totalSent: transfer.totalSent, fingerprint: conn.fingerprint, recipientCount: conn.recipientCount, setPassword, setChatOnly, peer: peerInstance, participants, sendCallMessage, broadcastCallMessage, setCallMessageHandler, broadcastManifest, messages, sendMessage, clearMessages, rtt, senderName, changeSenderName, typingUsers, sendTyping, sendReaction }
}

// ── sendSingleFile ────────────────────────────────────────────────────────

async function sendSingleFile(
  conn: DataConnection,
  files: File[],
  index: number,
  startChunk: number,
  connState: ConnState,
  encryptKey: CryptoKey | null,
  aggregateUI: () => void
): Promise<void> {
  const file = files[index]
  if (!file) return

  if (!connState.chunker) connState.chunker = new AdaptiveChunker()
  if (!connState.progressThrottler) connState.progressThrottler = new ProgressThrottler(80)

  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  connState.currentFileIndex = index
  conn.send({ type: 'file-start', name: file.name, size: file.size, index, totalChunks, resumeFrom: startChunk } satisfies PortalMsg)

  let chunkIndex = 0
  let fileSent = startChunk * CHUNK_SIZE
  let chunkStartTime = 0

  for await (const { buffer: chunkData } of chunkFileAdaptive(file, connState.chunker)) {
    if (connState.abort.aborted) return
    if (connState.cancelledFiles?.has(index)) {
      conn.send({ type: 'file-cancelled', index } satisfies PortalMsg)
      connState.cancelledFiles.delete(index)
      return
    }
    if (connState.pausedFiles?.has(index)) {
      if (!connState.pauseResolvers) connState.pauseResolvers = {}
      await new Promise<void>(r => { connState.pauseResolvers![index] = r })
      delete connState.pauseResolvers![index]
      if (connState.abort.aborted) return
      if (connState.cancelledFiles?.has(index)) {
        conn.send({ type: 'file-cancelled', index } satisfies PortalMsg)
        connState.cancelledFiles.delete(index)
        return
      }
    }

    if (chunkIndex < startChunk) {
      chunkIndex++
      continue
    }

    chunkStartTime = Date.now()

    const dataToSend: ArrayBuffer = encryptKey
      ? await encryptChunk(encryptKey, chunkData)
      : chunkData

    const packet = buildChunkPacket(index, chunkIndex, dataToSend)
    conn.send(packet)
    await waitForBufferDrain(conn)

    const transferTime = Date.now() - chunkStartTime
    connState.chunker.recordTransfer(chunkData.byteLength, transferTime)

    chunkIndex++
    fileSent += chunkData.byteLength
    connState.totalSent += chunkData.byteLength
    connState.progress[file.name] = Math.round((fileSent / file.size) * 100)

    if (connState.progressThrottler.shouldUpdate()) {
      const now = Date.now()
      const elapsed = (now - connState.startTime!) / 1000
      if (elapsed > 0.5) connState.speed = connState.totalSent / elapsed
      aggregateUI()
    }
  }

  if (!connState.abort.aborted) {
    conn.send({ type: 'file-end', index } satisfies PortalMsg)
    connState.progress[file.name] = 100
    connState.progressThrottler!.forceUpdate()
    aggregateUI()
  }
}

// ── handleHostChunk ───────────────────────────────────────────────────────

async function handleHostChunk(connState: ConnState, rawData: ArrayBuffer | ArrayBufferView): Promise<void> {
  if (!connState.encryptKey) return
  const buffer = rawData instanceof ArrayBuffer
    ? rawData
    : ((rawData as ArrayBufferView).buffer as ArrayBuffer)
  let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
  try { parsed = parseChunkPacket(buffer) } catch (e) { log.warn('handleHostChunk.parse', e); return }
  if (parsed.fileIndex !== CHAT_IMAGE_FILE_INDEX) return
  // Refuse to pay the decrypt cost if no image is in progress for this
  // connection. A peer spamming stray chat-image chunks without a matching
  // `chat-image-start-enc` used to make us do AES-GCM work per chunk only
  // to drop the plaintext on the floor. Cheap check first.
  if (!connState.inProgressImage) return
  let plain: ArrayBuffer | Uint8Array
  try { plain = await decryptChunk(connState.encryptKey, parsed.data) }
  catch (e) {
    // Decrypt failure — drop the in-flight image to prevent memory buildup
    console.warn('handleHostChunk decrypt failed:', e)
    connState.inProgressImage = null
    return
  }
  // Re-read after the awaited decrypt — another message could have cleared
  // it (chat-image-end-enc, size-cap abort, etc.) while we were decrypting.
  const inFlight = connState.inProgressImage
  if (!inFlight) return
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain)
  // Enforce size cap even on the relay path to prevent a malicious peer from exhausting host memory
  if (inFlight.receivedBytes + bytes.byteLength > MAX_CHAT_IMAGE_SIZE) {
    console.warn('handleHostChunk: chat image exceeds size cap, dropping')
    connState.inProgressImage = null
    return
  }
  inFlight.chunks.push(bytes)
  inFlight.receivedBytes += bytes.byteLength
}

// ── streamImageToConn ────────────────────────────────────────────────────

// Emit a best-effort abort so the receiver can clear its in-progress
// image slot. Without this, a mid-stream failure left `inProgressImage`
// holding accumulated bytes until the next chat-image-start cleared it.
function notifyAbort(conn: DataConnection): void {
  try { conn.send({ type: 'chat-image-abort' } satisfies PortalMsg) } catch (e) { log.warn('streamImageToConn.notifyAbort', e) }
}

async function streamImageToConn(
  conn: DataConnection,
  key: CryptoKey,
  bytes: Uint8Array,
  mime: string,
  text: string,
  replyTo: InProgressImage['replyTo'],
  from: string,
  time: number,
  duration?: number
): Promise<void> {
  if (!conn || conn.open === false || !key) return
  try {
    const startPayload = JSON.stringify({ mime, size: bytes.byteLength, text, replyTo, time, duration })
    const encStart = await encryptChunk(key, new TextEncoder().encode(startPayload))
    conn.send({ type: 'chat-image-start-enc', data: uint8ToBase64(new Uint8Array(encStart)), from, time } satisfies PortalMsg)
  } catch (e) { log.warn('streamImageToConn.start', e); return }

  const chunker = new AdaptiveChunker()
  let offset = 0
  let chunkIndex = 0
  while (offset < bytes.byteLength) {
    if (!conn.open) return
    const chunkSize = Math.min(chunker.getChunkSize(), bytes.byteLength - offset)
    const slice = bytes.subarray(offset, offset + chunkSize)
    const tStart = Date.now()
    let encChunk: ArrayBuffer
    try { encChunk = await encryptChunk(key, slice) } catch (e) { log.warn('streamImageToConn.encrypt', e); notifyAbort(conn); return }
    const packet = buildChunkPacket(CHAT_IMAGE_FILE_INDEX, chunkIndex, encChunk)
    try { conn.send(packet) } catch (e) { log.warn('streamImageToConn.sendPacket', e); notifyAbort(conn); return }
    try { await waitForBufferDrain(conn) } catch (e) { log.warn('streamImageToConn.drain', e); notifyAbort(conn); return }
    chunker.recordTransfer(slice.byteLength, Date.now() - tStart)
    offset += chunkSize
    chunkIndex++
  }

  try {
    const encEnd = await encryptChunk(key, new TextEncoder().encode('{}'))
    conn.send({ type: 'chat-image-end-enc', data: uint8ToBase64(new Uint8Array(encEnd)) } satisfies PortalMsg)
  } catch (e) {
    // Receiver will see incomplete image; the next start clears it
    log.warn('streamImageToConn.end', e)
  }
}
