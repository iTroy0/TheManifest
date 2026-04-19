import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { parseChunkPacket, buildChunkPacket, waitForBufferDrain, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { sendFile, portalWire } from '../net/transferEngine'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, uint8ToBase64, base64ToUint8, timingSafeEqual } from '../utils/crypto'
import { finalizeKeyExchange } from '../net/keyExchange'
import { createSession, type Session } from '../net/session'
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

// UI + adaptive-chunker accounting that doesn't belong on Session. Keyed
// by connId alongside the Session map; the pair makes up a `ConnEntry`.
interface SenderMeta {
  progress: Record<string, number>
  totalSent: number
  startTime: number | null
  transferTotalSize: number
  speed: number
  currentFileIndex: number
  transferring: boolean
  // Whole-connection abort flag — flipped on cancel-all, peer disconnect,
  // or unmount so both the inner chunk loop and the outer file loop exit.
  // Separate from `TransferHandle.aborted` (per-file cancel). Keeps the
  // pre-session semantics of a fresh `{aborted:false}` object per transfer.
  abort: { aborted: boolean }
  chunker?: InstanceType<typeof AdaptiveChunker>
  progressThrottler?: InstanceType<typeof ProgressThrottler>
  pendingJoinAnnounce?: boolean
  // M-d — per-connection backoff timestamp. Replaces the old hook-global
  // `lastPasswordAttemptTime` so one attacker can no longer stall every
  // legitimate receiver by burning the shared timer.
  lastPasswordAttempt?: number
}

interface ConnEntry {
  session: Session
  meta: SenderMeta
}

function createSenderMeta(): SenderMeta {
  return {
    progress: {},
    totalSent: 0,
    startTime: null,
    transferTotalSize: 0,
    speed: 0,
    currentFileIndex: -1,
    transferring: false,
    abort: { aborted: false },
  }
}

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
  const connectionsRef = useRef<Map<string, ConnEntry>>(new Map())
  const passwordRef = useRef<string | null>(null)
  const chatOnlyRef = useRef<boolean>(false)
  const imageBlobUrlsRef = useRef<string[]>([])

  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const [participants, setParticipants] = useState<Array<{ peerId: string; name: string }>>([])
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const refreshParticipants = useCallback((): void => {
    const list: Array<{ peerId: string; name: string }> = []
    connectionsRef.current.forEach(entry => {
      list.push({ peerId: entry.session.conn.peer, name: entry.session.nickname || 'Anon' })
    })
    setParticipants(list)
  }, [])

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((peerId: string, msg: Record<string, unknown>): void => {
    connectionsRef.current.forEach(entry => {
      if (entry.session.conn.peer === peerId) {
        try { entry.session.send(msg) } catch (e) { log.warn('useSender.sendCallMessage', e) }
      }
    })
  }, [])

  const broadcastCallMessage = useCallback((msg: Record<string, unknown>, exceptPeerId?: string): void => {
    connectionsRef.current.forEach(entry => {
      if (exceptPeerId && entry.session.conn.peer === exceptPeerId) return
      try { entry.session.send(msg) } catch (e) { log.warn('useSender.broadcastCallMessage', e) }
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
      const session = createSession({ conn, role: 'portal-sender' })
      session.dispatch({ type: 'connect-start' })
      const meta = createSenderMeta()
      const entry: ConnEntry = { session, meta }
      connectionsRef.current.set(connId, entry)

      function announceJoin(e: ConnEntry, cId: string): void {
        dispatchConn({ type: 'SET', payload: { status: 'connected', recipientCount: connectionsRef.current.size } })
        refreshParticipants()
        const name = e.session.nickname || 'Anon'
        setMessages(prev => [...prev, { text: `${name} joined`, from: 'system', time: Date.now(), self: false }].slice(-500))
        const count = connectionsRef.current.size + 1
        connectionsRef.current.forEach((other, id) => {
          const s = other.session.state
          if (s === 'closed' || s === 'error' || s === 'kicked') return
          try { other.session.send({ type: 'online-count', count } satisfies PortalMsg) } catch (e) { log.warn('useSender.announceJoin.onlineCount', e) }
          if (id !== cId) {
            try { other.session.send({ type: 'system-msg', text: `${name} joined`, time: Date.now() } satisfies PortalMsg) } catch (e) { log.warn('useSender.announceJoin.systemMsg', e) }
          }
        })
      }

      let lastAggregateAt = 0
      function aggregateUI(force = false): void {
        const now = Date.now()
        if (!force && now - lastAggregateAt < 100) return
        lastAggregateAt = now

        const entries = Array.from(connectionsRef.current.values())
        const active = entries.filter(e => e.meta.transferring)

        const merged: Record<string, number> = {}
        for (const e of active) {
          for (const [name, pct] of Object.entries(e.meta.progress || {})) {
            if (merged[name] === undefined) merged[name] = pct
            else merged[name] = Math.max(merged[name], pct)
          }
        }

        const activeWithFile = active.find(e => e.meta.currentFileIndex >= 0)

        if (active.length === 0) {
          dispatchTransfer({ type: 'SET', payload: { progress: merged, currentFileIndex: -1, totalSent: 0, overallProgress: 0, speed: 0, eta: null } })
          return
        }

        const sent = active.reduce((s, e) => s + e.meta.totalSent, 0)
        const total = active.reduce((s, e) => s + e.meta.transferTotalSize, 0)
        const spd = active.reduce((s, e) => s + e.meta.speed, 0)
        dispatchTransfer({ type: 'SET', payload: {
          progress: merged,
          currentFileIndex: activeWithFile ? activeWithFile.meta.currentFileIndex : -1,
          totalSent: sent,
          overallProgress: total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0,
          speed: spd,
          eta: spd > 0 ? Math.max(0, (total - sent) / spd) : null,
        }})
      }

      function startTransfer(transferSize: number): void {
        meta.abort = { aborted: false }
        meta.totalSent = 0
        meta.startTime = Date.now()
        meta.progress = {}
        meta.speed = 0
        meta.transferTotalSize = transferSize
        meta.transferring = true
        dispatchConn({ type: 'SET_STATUS', payload: 'transferring' })
      }

      function endTransfer(): void {
        meta.transferring = false
        meta.currentFileIndex = -1
        aggregateUI(true)
        const anyActive = Array.from(connectionsRef.current.values()).some(e => e.meta.transferring)
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
        session.dispatch({ type: 'conn-open' })

        session.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

        function handlePeerDisconnect(reason: string): void {
          if (destroyed) return
          if (session.state === 'closed' || session.state === 'error' || session.state === 'kicked') return
          meta.abort.aborted = true
          try { conn.removeAllListeners() } catch (e) { log.warn('useSender.handlePeerDisconnect.removeListeners', e) }
            if (conn.peerConnection) {
            try { conn.peerConnection.oniceconnectionstatechange = null } catch (e) { log.warn('useSender.handlePeerDisconnect.clearIce', e) }
          }
          session.close('peer-disconnect')
          const name = session.nickname || 'A recipient'
          connectionsRef.current.delete(connId)
          dispatchConn({ type: 'SET', payload: { recipientCount: connectionsRef.current.size } })
          refreshParticipants()
          setMessages(prev => [...prev, { text: `${name} ${reason}`, from: 'system', time: Date.now(), self: false }].slice(-500))
          const newCount = connectionsRef.current.size + 1
          connectionsRef.current.forEach(other => {
            try {
              other.session.send({ type: 'online-count', count: newCount } satisfies PortalMsg)
              other.session.send({ type: 'system-msg', text: `${name} ${reason}`, time: Date.now() } satisfies PortalMsg)
            } catch (e) { log.warn('useSender.handlePeerDisconnect.broadcast', e) }
          })
          if (connectionsRef.current.size === 0) {
            setRtt(null)
            dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'done' ? prev : 'waiting' })
          }
        }

        session.heartbeat = setupHeartbeat(conn, {
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

        session.setKeyPair(await generateKeyPair())
        const pubKeyBytes = await exportPublicKey(session.keyPair!.publicKey)
        try { session.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendPublicKey', e) }

        session.keyExchangeTimeout = setTimeout(() => {
          if (!session.encryptKey && !destroyed) {
            console.warn('Key exchange timed out for', connId)
            conn.close()
          }
        }, 10_000)

        if (session.pendingRemoteKey) {
          try {
            const { encryptKey, fingerprint } = await finalizeKeyExchange({
              localPrivate: session.keyPair!.privateKey,
              localPublic: pubKeyBytes,
              remotePublic: session.pendingRemoteKey,
            })
            session.dispatch({ type: 'keys-derived', encryptKey, fingerprint })
            dispatchConn({ type: 'SET', payload: { fingerprint } })
            session.pendingRemoteKey = null
            if (passwordRef.current) {
              try { session.send({ type: 'password-required' } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendPasswordRequired', e) }
            } else {
              await sendManifest(conn, encryptKey)
            }
          } catch (e) {
            log.warn('useSender.pendingRemoteKey.derive', e)
            conn.close()
          }
        }
      })

      conn.on('data', async (data: unknown) => {
        if (destroyed) return
        if (session.heartbeat) session.heartbeat.markAlive()

        if (data instanceof ArrayBuffer || (data && (data as ArrayBuffer).byteLength !== undefined && !(typeof data === 'object' && (data as { type?: unknown }).type))) {
          session.chunkQueue = session.chunkQueue
            .then(() => handleHostChunk(entry, data as ArrayBuffer))
            .catch(e => log.warn('useSender.chunkQueue', e))
          return
        }

        const raw = data as { type?: unknown }
        if (typeof raw.type === 'string' && raw.type.startsWith('call-')) {
          if (callMessageHandlerRef.current) {
            try { callMessageHandlerRef.current(conn.peer, raw as Record<string, unknown>) }
            catch (e) { log.warn('useSender.callMessageHandler', e) }
          }
          return
        }

        const msg = data as PortalMsg

        if (msg.type === 'pong') return
        if (msg.type === 'ping') {
          try { session.send({ type: 'pong', ts: msg.ts } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendPong', e) }
          return
        }

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
            session.dispatch({ type: 'keys-derived', encryptKey, fingerprint })
            dispatchConn({ type: 'SET', payload: { fingerprint } })

            if (passwordRef.current) {
              try { session.send({ type: 'password-required' } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendPasswordRequired', e) }
            } else {
              await sendManifest(conn, encryptKey)
            }
          } catch (e) {
            log.warn('useSender.publicKey.derive', e)
            conn.close()
          }
          return
        }

        if (msg.type === 'password-encrypted') {
          const now = Date.now()
          // M-d — per-connection backoff keyed off this session's own
          // attempt count, not a hook-global counter.
          const attempts = session.passwordAttempts
          const backoffMs = Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempts - 1)))
          if (now - (meta.lastPasswordAttempt ?? 0) < backoffMs) {
            try { session.send({ type: 'password-rate-limited' } satisfies PortalMsg) } catch (e) { log.warn('useSender.passwordRateLimited.send', e) }
            return
          }
          meta.lastPasswordAttempt = now
          const next = session.incrementPasswordAttempts()
          if (next > 5) {
            try { session.send({ type: 'password-locked' } satisfies PortalMsg) } catch (e) { log.warn('useSender.passwordLocked.send', e) }
            conn.close()
            return
          }

          // M-c — unified timing. Always run the decrypt + the
          // timingSafeEqual, even on decrypt failure (empty password falls
          // through). Distinguishing "wrong key" from "right key, wrong
          // password" was previously possible from network-layer timing.
          let password = ''
          if (session.encryptKey && msg.data) {
            try {
              const decrypted = await decryptChunk(session.encryptKey, base64ToUint8(msg.data as string))
              password = new TextDecoder().decode(decrypted)
            } catch (e) {
              log.warn('useSender.passwordDecrypt', e)
              // Fall through to compare against an empty string so the
              // branch latency matches the "wrong password" path.
            }
          }
          const expected = passwordRef.current || ''
          const matched = password.length > 0 && timingSafeEqual(password, expected)

          if (matched) {
            session.passwordAttempts = 0
            meta.lastPasswordAttempt = 0
            session.setPasswordVerified()
            try { session.send({ type: 'password-accepted' } satisfies PortalMsg) } catch (e) { log.warn('useSender.passwordAccepted.send', e) }
            if (meta.pendingJoinAnnounce) {
              meta.pendingJoinAnnounce = false
              announceJoin(entry, connId)
            }
            if (session.encryptKey) await sendManifest(conn, session.encryptKey)
          } else {
            try { session.send({ type: 'password-wrong' } satisfies PortalMsg) } catch (e) { log.warn('useSender.passwordWrong.send', e) }
          }
          return
        }

        if (msg.type === 'typing') {
          handleTypingMessage(msg.nickname as string, setTypingUsers, typingTimeouts.current)
          connectionsRef.current.forEach((other, id) => {
            if (id !== connId) { try { other.session.send({ type: 'typing', nickname: msg.nickname } satisfies PortalMsg) } catch (e) { log.warn('useSender.relayTyping', e) } }
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
          connectionsRef.current.forEach((other, id) => {
            if (id !== connId) { try { other.session.send(data as Record<string, unknown>) } catch (e) { log.warn('useSender.relayReaction', e) } }
          })
          return
        }

        if (msg.type === 'chat-encrypted') {
          let payload: Record<string, unknown> = {}
          if (session.encryptKey && msg.data) {
            try { payload = await decryptJSON(session.encryptKey, msg.data as string) }
            catch (e) { log.warn('useSender.chatEncrypted.decrypt', e); return }
          }
          const chatMsg: ChatMessage = { text: payload.text as string || '', image: payload.image as string | undefined, mime: payload.mime as string | undefined, replyTo: payload.replyTo as ChatMessage['replyTo'], from: msg.nickname as string || 'Anon', time: msg.time as number, self: false }
          setMessages(prev => [...prev, chatMsg].slice(-500))
          const relayPayload = JSON.stringify(payload)
          for (const [id, other] of connectionsRef.current) {
            if (id !== connId && other.session.encryptKey) {
              try {
                const encrypted = await encryptChunk(other.session.encryptKey, new TextEncoder().encode(relayPayload))
                other.session.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: msg.nickname || 'Anon', time: msg.time } satisfies PortalMsg)
              } catch (e) { log.warn('useSender.chatEncrypted.relay', e) }
            }
          }
          return
        }

        // Mid-stream abort from peer — clear the in-progress image slot so
        // accumulated bytes don't linger until the next start message.
        if (msg.type === 'chat-image-abort') {
          session.inProgressImage = null
          return
        }

        if (msg.type === 'chat-image-start-enc') {
          if (!session.encryptKey || !msg.data) return
          let metaPayload: Record<string, unknown>
          try { metaPayload = await decryptJSON(session.encryptKey, msg.data as string) }
          catch (e) { log.warn('useSender.chatImageStart.decrypt', e); return }
          session.inProgressImage = {
            mime: metaPayload.mime as string || 'application/octet-stream',
            size: metaPayload.size as number || 0,
            text: metaPayload.text as string || '',
            replyTo: metaPayload.replyTo as InProgressImage['replyTo'] || null,
            time: metaPayload.time as number || Date.now(),
            from: msg.from as string || session.nickname || 'Anon',
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
            text: inFlight.text,
            image: url,
            mime: inFlight.mime,
            duration: inFlight.duration,
            replyTo: inFlight.replyTo,
            from: inFlight.from,
            time: inFlight.time,
            self: false,
          }].slice(-500))

          for (const [otherId, other] of connectionsRef.current) {
            if (otherId === connId || !other.session.encryptKey) continue
            const key = other.session.encryptKey
            other.session.imageSendQueue = other.session.imageSendQueue
              .then(() => streamImageToConn(
                other.session.conn, key, fullBytes,
                inFlight.mime, inFlight.text, inFlight.replyTo,
                inFlight.from, inFlight.time, inFlight.duration
              ))
              .catch(e => log.warn('useSender.chatImage.relay', e))
          }
          return
        }

        if (msg.type === 'join') {
          session.setNickname((msg.nickname as string || '').slice(0, 32))
          const now = Date.now()
          for (const [otherId, other] of connectionsRef.current) {
            if (otherId === connId) continue
            if (other.session.nickname !== msg.nickname) continue
            const lastSeen = other.session.heartbeat ? other.session.heartbeat.getLastSeen() : 0
            if (now - lastSeen < 10000) continue
            other.meta.abort.aborted = true
            other.session.close('session-abort')
            try { other.session.conn.close() } catch (e) { log.warn('useSender.join.closeDup', e) }
            connectionsRef.current.delete(otherId)
          }

          if (passwordRef.current) {
            meta.pendingJoinAnnounce = true
          } else {
            announceJoin(entry, connId)
          }
          return
        }

        if (msg.type === 'nickname-change') {
          const oldName = session.nickname || msg.oldName as string
          session.setNickname((msg.newName as string || '').slice(0, 32))
          refreshParticipants()
          const changeMsg = `${oldName} is now ${msg.newName}`
          setMessages(prev => [...prev, { text: changeMsg, from: 'system', time: Date.now(), self: false }].slice(-500))
          connectionsRef.current.forEach((other, id) => {
            if (id !== connId) {
              try { other.session.send({ type: 'system-msg', text: changeMsg, time: Date.now() } satisfies PortalMsg) } catch (e) { log.warn('useSender.nicknameChange.broadcast', e) }
            }
          })
          return
        }

        if (msg.type === 'cancel-all') {
          meta.abort = { aborted: true }
          meta.transferring = false
          meta.progress = {}
          meta.totalSent = 0
          meta.speed = 0
          session.cancelAllTransfers()
          aggregateUI(true)
          const anyActive = Array.from(connectionsRef.current.values()).some(e => e.meta.transferring)
          if (!anyActive) dispatchConn({ type: 'SET_STATUS', payload: 'connected' })
          return
        }

        if (msg.type === 'cancel-file') {
          session.cancelTransfer(`file-${msg.index}`)
          return
        }

        if (msg.type === 'pause-file') {
          session.pauseTransfer(`file-${msg.index}`)
          return
        }

        if (msg.type === 'resume-file') {
          session.resumeTransfer(`file-${msg.index}`)
          return
        }

        if (msg.type === 'request-file') {
          const file = filesRef.current[msg.index as number]
          if (!file) return
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
          // Clamp to totalChunks - 1 so request for the last chunk still sends it.
          // A resumeChunk === totalChunks would skip the whole file but still send file-end.
          // Clamp to totalChunks - 1 so request for the last chunk still sends it.
          // A resumeChunk === totalChunks would skip the whole file but still send file-end.
          const resumeChunk = Math.min(Math.max(0, (msg.resumeChunk as number) || 0), Math.max(0, totalChunks - 1))
          startTransfer(file.size)
          try {
            const fileIndex = msg.index as number
            const fileToSend = filesRef.current[fileIndex]
            if (!fileToSend) {
              log.warn('useSender.sendFile.missingFile', { index: fileIndex })
            } else {
              if (!meta.chunker) meta.chunker = new AdaptiveChunker()
              const result = await sendFile(entry.session, fileToSend, portalWire, {
                fileId: `file-${fileIndex}`,
                startChunk: resumeChunk,
                chunker: meta.chunker,
                signal: undefined,
                onProgress: (sent, total) => {
                  meta.totalSent = sent
                  meta.progress[fileToSend.name] = total > 0 ? Math.round(sent / total * 100) : 0
                  meta.currentFileIndex = fileIndex
                  const elapsed = (Date.now() - (meta.startTime ?? Date.now())) / 1000
                  meta.speed = elapsed > 0.5 ? meta.totalSent / elapsed : 0
                  aggregateUI()
                },
              })
              if (result !== 'complete') {
                log.warn('useSender.sendFile.result', { result, index: fileIndex })
              }
            }
            if (!meta.abort.aborted) endTransfer()
          } catch (e) {
            log.warn('useSender.requestFile.failed', e)
            meta.abort.aborted = true
            endTransfer()
            try { conn.close() } catch (err) { log.warn('useSender.requestFile.closeAfterFail', err) }
          }
        }

        if (msg.type === 'request-all') {
          const indices: number[] = (msg.indices as number[]) || filesRef.current.map((_, i) => i)
          const transferSize = indices.reduce((sum, i) => sum + (filesRef.current[i]?.size || 0), 0)
          startTransfer(transferSize)
          let batchBytes = 0
          for (const idx of indices) {
            if (meta.abort.aborted) break
            const idxFile = filesRef.current[idx]
            if (!idxFile) {
              log.warn('useSender.sendFile.missingFile', { index: idx })
              try { session.send({ type: 'file-skipped', index: idx, reason: 'missing-file' } satisfies PortalMsg) }
              catch (sendErr) { log.warn('useSender.requestAll.skipNotify', sendErr) }
              continue
            }
            try {
              if (!meta.chunker) meta.chunker = new AdaptiveChunker()
              const result = await sendFile(entry.session, idxFile, portalWire, {
                fileId: `file-${idx}`,
                startChunk: 0,
                chunker: meta.chunker,
                signal: undefined,
                onProgress: (sent, total) => {
                  meta.totalSent = batchBytes + sent
                  meta.progress[idxFile.name] = total > 0 ? Math.round(sent / total * 100) : 0
                  meta.currentFileIndex = idx
                  const elapsed = (Date.now() - (meta.startTime ?? Date.now())) / 1000
                  meta.speed = elapsed > 0.5 ? meta.totalSent / elapsed : 0
                  aggregateUI()
                },
              })
              if (result !== 'complete') {
                log.warn('useSender.sendFile.result', { result, index: idx })
              }
              batchBytes += idxFile.size
            } catch (e) {
              log.warn('useSender.requestAll.skip', e)
              try { session.send({ type: 'file-skipped', index: idx, reason: (e as Error)?.message || 'send-failed' } satisfies PortalMsg) }
              catch (sendErr) { log.warn('useSender.requestAll.skipNotify', sendErr) }
            }
          }
          if (!meta.abort.aborted) {
            try { session.send({ type: 'batch-done' } satisfies PortalMsg) } catch (e) { log.warn('useSender.batchDone.send', e) }
            endTransfer()
          }
        }

        if (msg.type === 'ready') {
          const transferSize = filesRef.current.reduce((sum, f) => sum + f.size, 0)
          startTransfer(transferSize)
          let batchBytes = 0
          for (let i = 0; i < filesRef.current.length; i++) {
            if (meta.abort.aborted) break
            const readyFile = filesRef.current[i]
            if (!readyFile) {
              log.warn('useSender.sendFile.missingFile', { index: i })
              try { session.send({ type: 'file-skipped', index: i, reason: 'missing-file' } satisfies PortalMsg) }
              catch (sendErr) { log.warn('useSender.ready.skipNotify', sendErr) }
              continue
            }
            try {
              if (!meta.chunker) meta.chunker = new AdaptiveChunker()
              const result = await sendFile(entry.session, readyFile, portalWire, {
                fileId: `file-${i}`,
                startChunk: 0,
                chunker: meta.chunker,
                signal: undefined,
                onProgress: (sent, total) => {
                  meta.totalSent = batchBytes + sent
                  meta.progress[readyFile.name] = total > 0 ? Math.round(sent / total * 100) : 0
                  meta.currentFileIndex = i
                  const elapsed = (Date.now() - (meta.startTime ?? Date.now())) / 1000
                  meta.speed = elapsed > 0.5 ? meta.totalSent / elapsed : 0
                  aggregateUI()
                },
              })
              if (result !== 'complete') {
                log.warn('useSender.sendFile.result', { result, index: i })
              }
              batchBytes += readyFile.size
            } catch (e) {
              log.warn('useSender.ready.skip', e)
              try { session.send({ type: 'file-skipped', index: i, reason: (e as Error)?.message || 'send-failed' } satisfies PortalMsg) }
              catch (sendErr) { log.warn('useSender.ready.skipNotify', sendErr) }
            }
          }
          if (!meta.abort.aborted) {
            try { session.send({ type: 'done' } satisfies PortalMsg) } catch (e) { log.warn('useSender.done.send', e) }
            endTransfer()
            dispatchConn({ type: 'SET_STATUS', payload: 'done' })
          }
        }

        if (msg.type === 'resume') {
          const resumeIndex = msg.fileIndex as number
          const resumeFile = filesRef.current[resumeIndex]
          const transferSize = resumeFile?.size || 0
          startTransfer(transferSize)
          if (!resumeFile) {
            log.warn('useSender.sendFile.missingFile', { index: resumeIndex })
          } else {
            if (!meta.chunker) meta.chunker = new AdaptiveChunker()
            const result = await sendFile(entry.session, resumeFile, portalWire, {
              fileId: `file-${resumeIndex}`,
              startChunk: msg.chunkIndex as number,
              chunker: meta.chunker,
              signal: undefined,
              onProgress: (sent, total) => {
                meta.totalSent = sent
                meta.progress[resumeFile.name] = total > 0 ? Math.round(sent / total * 100) : 0
                meta.currentFileIndex = resumeIndex
                const elapsed = (Date.now() - (meta.startTime ?? Date.now())) / 1000
                meta.speed = elapsed > 0.5 ? meta.totalSent / elapsed : 0
                aggregateUI()
              },
            })
            if (result !== 'complete') {
              log.warn('useSender.sendFile.result', { result, index: resumeIndex })
            }
          }
          if (!meta.abort.aborted) endTransfer()
        }
      })

      conn.on('close', () => {
        if (destroyed) return
        if (session.state === 'closed' || session.state === 'error' || session.state === 'kicked') return
        try { conn.removeAllListeners() } catch (e) { log.warn('useSender.close.removeListeners', e) }
        if (conn.peerConnection) {
          try { conn.peerConnection.oniceconnectionstatechange = null } catch (e) { log.warn('useSender.close.clearIce', e) }
        }
        meta.abort.aborted = true
        session.close('peer-disconnect')
        const name = session.nickname || 'A recipient'
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
        connectionsRef.current.forEach(other => {
          try {
            other.session.send({ type: 'online-count', count } satisfies PortalMsg)
            other.session.send({ type: 'system-msg', text: `${name} left`, time: Date.now() } satisfies PortalMsg)
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
        meta.abort.aborted = true
        session.close('error')
        connectionsRef.current.delete(connId)
        dispatchConn({ type: 'SET', payload: { recipientCount: connectionsRef.current.size } })
        refreshParticipants()
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
        if (connectionsRef.current.size > 0) return
      }
      if (connectionsRef.current.size === 0) {
        dispatchConn({ type: 'SET_STATUS', payload: 'error' })
      }
    })

    function handleVisibility(): void {
      if (document.visibilityState !== 'visible' || destroyed) return
      if (peer.disconnected && !peer.destroyed) peer.reconnect()
      connectionsRef.current.forEach(entry => { if (entry.session.heartbeat) entry.session.heartbeat.markAlive() })
    }
    document.addEventListener('visibilitychange', handleVisibility)

    function handleBeforeUnload(): void {
      connectionsRef.current.forEach(entry => {
        try { entry.session.send({ type: 'closing' } satisfies PortalMsg) } catch (e) { log.warn('useSender.beforeUnload.sendClosing', e) }
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
      connectionsRef.current.forEach(entry => {
        entry.meta.abort.aborted = true
        try { entry.session.conn.removeAllListeners() } catch (e) { log.warn('useSender.unmount.removeListeners', e) }
        entry.session.close('session-abort')
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

      for (const entry of connectionsRef.current.values()) {
        if (!entry.session.encryptKey) continue
        const key = entry.session.encryptKey
        entry.session.imageSendQueue = entry.session.imageSendQueue
          .then(() => streamImageToConn(entry.session.conn, key, bytes, mime, text || '', replyTo ?? null, senderName, time, duration))
          .catch(e => log.warn('useSender.sendMessage.imageQueue', e))
      }
      return
    }

    const imgStr = image as string | undefined
    setMessages(prev => [...prev, { text, image: imgStr, replyTo, from: 'You', time, self: true }].slice(-500))
    const payload = JSON.stringify({ text, image: imgStr, replyTo })
    for (const entry of connectionsRef.current.values()) {
      try {
        if (entry.session.encryptKey) {
          const encrypted = await encryptChunk(entry.session.encryptKey, new TextEncoder().encode(payload))
          entry.session.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: senderName, time } satisfies PortalMsg)
        }
      } catch (e) { log.warn('useSender.sendMessage.chatEncrypt', e) }
    }
  }, [senderName])

  const sendTyping = useCallback((): void => {
    connectionsRef.current.forEach(entry => {
      try { entry.session.send({ type: 'typing', nickname: senderName } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendTyping', e) }
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
    connectionsRef.current.forEach(entry => {
      try { entry.session.send({ type: 'reaction', msgId, emoji, nickname: senderName } satisfies PortalMsg) } catch (e) { log.warn('useSender.sendReaction', e) }
    })
  }, [senderName])

  const changeSenderName = useCallback((newName: string): void => {
    if (!newName.trim()) return
    const oldName = senderName
    setSenderName(newName.trim())
    const msg = `${oldName} is now ${newName.trim()}`
    setMessages(prev => [...prev, { text: msg, from: 'system', time: Date.now(), self: false }].slice(-500))
    connectionsRef.current.forEach(entry => {
      try { entry.session.send({ type: 'system-msg', text: msg, time: Date.now() } satisfies PortalMsg) } catch (e) { log.warn('useSender.changeSenderName.broadcast', e) }
    })
  }, [senderName])

  const broadcastManifest = useCallback(async (): Promise<void> => {
    if (connectionsRef.current.size === 0) return
    const manifest = await buildManifestData(filesRef.current, chatOnlyRef.current)
    for (const entry of connectionsRef.current.values()) {
      if (!entry.session.encryptKey) continue
      try {
        const encrypted = await encryptJSON(entry.session.encryptKey, manifest)
        entry.session.send({ type: 'manifest-enc', data: encrypted } satisfies PortalMsg)
      } catch (e) { console.warn('Failed to broadcast manifest:', e) }
    }
  }, [])

  const reset = useCallback((): void => {
    Object.values(typingTimeouts.current).forEach(clearTimeout)
    typingTimeouts.current = {}
    connectionsRef.current.forEach(entry => {
      entry.meta.abort.aborted = true
      try { entry.session.conn.removeAllListeners() } catch (e) { log.warn('useSender.reset.removeListeners', e) }
      entry.session.close('session-abort')
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


async function handleHostChunk(entry: ConnEntry, rawData: ArrayBuffer | ArrayBufferView): Promise<void> {
  const { session } = entry
  if (!session.encryptKey) return
  const buffer = rawData instanceof ArrayBuffer
    ? rawData
    : ((rawData as ArrayBufferView).buffer as ArrayBuffer)
  let parsed: { fileIndex: number; chunkIndex: number; data: ArrayBuffer }
  try { parsed = parseChunkPacket(buffer) } catch (e) { log.warn('handleHostChunk.parse', e); return }
  if (parsed.fileIndex !== CHAT_IMAGE_FILE_INDEX) return
  if (!session.inProgressImage) return
  let plain: ArrayBuffer | Uint8Array
  try { plain = await decryptChunk(session.encryptKey, parsed.data) }
  catch (e) {
    console.warn('handleHostChunk decrypt failed:', e)
    session.inProgressImage = null
    return
  }
  // Re-read after the awaited decrypt — another message could have cleared
  // it (chat-image-end-enc, size-cap abort, etc.) while we were decrypting.
  const inFlight = session.inProgressImage
  if (!inFlight) return
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain)
  if (inFlight.receivedBytes + bytes.byteLength > MAX_CHAT_IMAGE_SIZE) {
    console.warn('handleHostChunk: chat image exceeds size cap, dropping')
    session.inProgressImage = null
    return
  }
  inFlight.chunks.push(bytes)
  inFlight.receivedBytes += bytes.byteLength
}

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
    log.warn('streamImageToConn.end', e)
  }
}
