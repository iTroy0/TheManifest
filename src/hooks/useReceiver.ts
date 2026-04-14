import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { parseChunkPacket, buildChunkPacket, waitForBufferDrain, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, decryptJSON, getKeyFingerprint, uint8ToBase64 } from '../utils/crypto'
import { createFileStream } from '../utils/streamWriter'
import { createStreamingZip } from '../utils/zipBuilder'
import { STUN_ONLY, getWithTurn } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { ChatMessage, ManifestData } from '../types'
import { sanitizeFileName } from '../utils/filename'
import { generateNickname } from '../utils/nickname'

// ── Constants ────────────────────────────────────────────────────────────

const MAX_RETRIES = 2
const TIMEOUT_MS = 10000
const RECONNECT_DELAY = 2000
const MAX_RECONNECTS = 3
const MAX_CHAT_IMAGE_SIZE = 10 * 1024 * 1024

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

interface FileMeta {
  name: string
  size: number
  totalChunks: number
  received: number
}

// ── Transfer reducer ─────────────────────────────────────────────────────

interface TransferState {
  progress: Record<string, number>
  overallProgress: number
  speed: number
  eta: number | null
  pendingFiles: Record<number, boolean>
  completedFiles: Record<number, boolean>
  pausedFiles: Record<number, boolean>
}

type TransferAction =
  | { type: 'SET'; payload: Partial<TransferState> }
  | { type: 'FILE_PROGRESS'; name: string; value: number }
  | { type: 'COMPLETE_FILE'; index: number; name: string }
  | { type: 'CANCEL_FILE'; index: number; name?: string }
  | { type: 'REMOVE_PENDING'; index: number }
  | { type: 'ADD_PENDING'; index: number }
  | { type: 'PAUSE_FILE'; index: number }
  | { type: 'RESUME_FILE'; index: number }
  | { type: 'RESET' }

const initialTransfer: TransferState = {
  progress: {},
  overallProgress: 0,
  speed: 0,
  eta: null,
  pendingFiles: {},
  completedFiles: {},
  pausedFiles: {},
}

function transferReducer(state: TransferState, action: TransferAction): TransferState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'FILE_PROGRESS':
      return { ...state, progress: { ...state.progress, [action.name]: action.value } }
    case 'COMPLETE_FILE': {
      const p = { ...state.pendingFiles }; delete p[action.index]
      return { ...state, progress: { ...state.progress, [action.name]: 100 }, completedFiles: { ...state.completedFiles, [action.index]: true }, pendingFiles: p }
    }
    case 'CANCEL_FILE': {
      const pending = { ...state.pendingFiles }; delete pending[action.index]
      const paused = { ...state.pausedFiles }; delete paused[action.index]
      const progress = { ...state.progress }; if (action.name) delete progress[action.name]
      return { ...state, pendingFiles: pending, pausedFiles: paused, progress }
    }
    case 'REMOVE_PENDING': {
      const p = { ...state.pendingFiles }; delete p[action.index]; return { ...state, pendingFiles: p }
    }
    case 'ADD_PENDING':
      return { ...state, pendingFiles: { ...state.pendingFiles, [action.index]: true } }
    case 'PAUSE_FILE':
      return { ...state, pausedFiles: { ...state.pausedFiles, [action.index]: true } }
    case 'RESUME_FILE': {
      const p = { ...state.pausedFiles }; delete p[action.index]; return { ...state, pausedFiles: p }
    }
    case 'RESET': return initialTransfer
    default: return state
  }
}

// ── Connection reducer ───────────────────────────────────────────────────

interface ConnectionState {
  status: string
  manifest: ManifestData | null
  fingerprint: string | null
  retryCount: number
  useRelay: boolean
  zipMode: boolean
  onlineCount: number
  passwordRequired: boolean
  passwordError: boolean
}

type ConnectionAction =
  | { type: 'SET'; payload: Partial<ConnectionState> }
  | { type: 'SET_STATUS'; payload: string | ((prev: string) => string) }
  | { type: 'RESET' }

const initialConnection: ConnectionState = {
  status: 'connecting',
  manifest: null,
  fingerprint: null,
  retryCount: 0,
  useRelay: false,
  zipMode: false,
  onlineCount: 0,
  passwordRequired: false,
  passwordError: false,
}

function connectionReducer(state: ConnectionState, action: ConnectionAction): ConnectionState {
  switch (action.type) {
    case 'SET': return { ...state, ...action.payload }
    case 'SET_STATUS': {
      const next = typeof action.payload === 'function' ? action.payload(state.status) : action.payload
      return next === state.status ? state : { ...state, status: next }
    }
    case 'RESET': return initialConnection
    default: return state
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────

export function useReceiver(peerId: string) {
  const [transfer, dispatchTransfer] = useReducer(transferReducer, initialTransfer)
  const [conn, dispatchConn] = useReducer(connectionReducer, initialConnection)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [rtt, setRtt] = useState<number | null>(null)
  const [nickname, setNickname] = useState<string>(() => generateNickname())
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastMsgTime = useRef<number>(0)

  const streamsRef = useRef<Record<number, ReturnType<typeof createFileStream> | null>>({})
  const chunksRef = useRef<Record<number, Uint8Array[] | null>>({})
  const zipWriterRef = useRef<ReturnType<typeof createStreamingZip> | null>(null)
  const fileMetaRef = useRef<Record<number, FileMeta>>({})
  const decryptKeyRef = useRef<CryptoKey | null>(null)
  const keyPairRef = useRef<CryptoKeyPair | null>(null)
  const totalReceivedRef = useRef<number>(0)
  const startTimeRef = useRef<number | null>(null)
  const manifestRef = useRef<ManifestData | null>(null)
  const connRef = useRef<DataConnection | null>(null)
  const peerRef = useRef<InstanceType<typeof Peer> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const destroyedRef = useRef<boolean>(false)
  const attemptRef = useRef<number>(0)
  const zipModeRef = useRef<boolean>(false)

  const transferTotalRef = useRef<number>(0)
  const lastFileIndexRef = useRef<number>(0)
  const lastChunkIndexRef = useRef<number>(0)
  const wasTransferringRef = useRef<boolean>(false)
  const reconnectCountRef = useRef<number>(0)
  const useTurnRef = useRef<boolean>(false)
  const chunkQueueRef = useRef<Promise<void>>(Promise.resolve())
  const inProgressImageRef = useRef<InProgressImage | null>(null)
  const imageSendQueueRef = useRef<Promise<void>>(Promise.resolve())
  const imageBlobUrlsRef = useRef<string[]>([])
  const lastChunkUIUpdateRef = useRef<number>(0)
  const heartbeatRef = useRef<ReturnType<typeof setupHeartbeat> | null>(null)
  const rttPollerRef = useRef<ReturnType<typeof setupRTTPolling> | null>(null)
  const manifestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingResumeRef = useRef<{ index: number; resumeChunk: number } | null>(null)
  const keyExchangeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const originalFingerprintRef = useRef<string | null>(null)
  const isMountedRef = useRef<boolean>(true)
  const reconnectTokenRef = useRef<symbol>(Symbol('reconnect'))
  // Buffers a manifest-enc message that arrives before key exchange completes.
  // This race is real: the sender sends manifest-enc the moment it derives
  // encryptKey after receiving the receiver's public-key, but the receiver is
  // still awaiting its own deriveSharedKey when the message arrives.
  const pendingManifestRef = useRef<string | null>(null)

  // Call plumbing (single-consumer — useCall owns the handler slot).
  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((msg: Record<string, unknown>): void => {
    const c = connRef.current
    if (c && c.open) { try { c.send(msg) } catch {} }
  }, [])

  const startConnection = useCallback((withTurn: boolean, isReconnect: boolean = false): void => {
    if (!window.crypto?.subtle) { dispatchConn({ type: 'SET_STATUS', payload: 'error' }); return }
    // Don't restart after unmount — guards against setTimeout-queued reconnects
    // racing the useEffect cleanup. `destroyedRef` alone is not enough because
    // startConnection used to clobber it back to false.
    if (!isMountedRef.current) return
    destroyedRef.current = false
    attemptRef.current = 0
    // Rotate reconnect token — queued reconnects from older sessions will see
    // a different token and abort before touching a dead component.
    reconnectTokenRef.current = Symbol('reconnect')
    dispatchConn({ type: 'SET', payload: { retryCount: 0 } })
    if (!isReconnect) {
      dispatchConn({ type: 'SET', payload: { useRelay: withTurn } })
      useTurnRef.current = withTurn
    }

    async function connect(): Promise<void> {
      if (destroyedRef.current) return
      attemptRef.current++
      dispatchConn({ type: 'SET', payload: { retryCount: attemptRef.current - 1, status: isReconnect ? 'reconnecting' : attemptRef.current > 1 ? 'retrying' : 'connecting' } })

      const config = useTurnRef.current ? await getWithTurn() : STUN_ONLY
      const peer = new Peer(config)
      peerRef.current = peer

      timeoutRef.current = setTimeout(() => {
        if (destroyedRef.current) return
        peer.destroy()
        if (attemptRef.current < MAX_RETRIES) connect()
        else if (isReconnect) dispatchConn({ type: 'SET_STATUS', payload: 'closed' })
        else dispatchConn({ type: 'SET_STATUS', payload: withTurn ? 'closed' : 'direct-failed' })
      }, TIMEOUT_MS)

      peer.on('open', () => {
        if (destroyedRef.current) return
        const conn = peer.connect(peerId, { reliable: true })
        connRef.current = conn
        setPeerInstance(peer)
        let disconnectHandled = false

        conn.on('open', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current!)
          reconnectCountRef.current = 0

          if (rttPollerRef.current) {
            rttPollerRef.current.cleanup()
          }
          rttPollerRef.current = setupRTTPolling(conn.peerConnection, setRtt)

          function handleDisconnect(reason: string): void {
            if (disconnectHandled || destroyedRef.current) return
            disconnectHandled = true
            if (heartbeatRef.current) heartbeatRef.current.cleanup()
            if (rttPollerRef.current) { rttPollerRef.current.cleanup(); rttPollerRef.current = null }
            if (keyExchangeTimeoutRef.current) { clearTimeout(keyExchangeTimeoutRef.current); keyExchangeTimeoutRef.current = null }
            try { conn.removeAllListeners() } catch {}
            // Null the ICE handler to release the closure
            if (conn.peerConnection) {
              try { conn.peerConnection.oniceconnectionstatechange = null } catch {}
            }
            // Clear stale pendingResume if the transfer completed between disconnects
            if (!wasTransferringRef.current) pendingResumeRef.current = null
            setRtt(null)
            setMessages(prev => [...prev, { text: reason, from: 'system', time: Date.now(), self: false }])
            if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
              chunkQueueRef.current = Promise.resolve()
              imageSendQueueRef.current = Promise.resolve()
              inProgressImageRef.current = null
              decryptKeyRef.current = null
              keyPairRef.current = null
              Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
              streamsRef.current = {}
              chunksRef.current = {}
              reconnectCountRef.current++
              peer.destroy()
              const token = reconnectTokenRef.current
              setTimeout(() => {
                // Verify the reconnect is still valid — unmount or newer reconnect invalidates it
                if (!isMountedRef.current || destroyedRef.current || reconnectTokenRef.current !== token) return
                startConnection(useTurnRef.current, true)
              }, RECONNECT_DELAY)
            } else {
              Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
              dispatchConn({ type: 'SET_STATUS', payload: 'closed' })
            }
          }

          heartbeatRef.current = setupHeartbeat(conn, {
            onDead: () => handleDisconnect('Connection lost'),
          })

          // ECDH key exchange timeout
          keyExchangeTimeoutRef.current = setTimeout(() => {
            if (!decryptKeyRef.current && !destroyedRef.current) {
              console.warn('Key exchange timed out')
              conn.close()
            }
          }, 10_000)

          const pc = conn.peerConnection
          if (pc) {
            const prevHandler = pc.oniceconnectionstatechange
            pc.oniceconnectionstatechange = () => {
              if (prevHandler) (prevHandler as () => void)()
              const s = pc.iceConnectionState
              if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                handleDisconnect('Sender disconnected')
              }
            }
          }

          if (isReconnect && wasTransferringRef.current) {
            dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
            // Defer file request until new key exchange completes
            pendingResumeRef.current = { index: lastFileIndexRef.current, resumeChunk: lastChunkIndexRef.current }
            dispatchTransfer({ type: 'ADD_PENDING', index: lastFileIndexRef.current })
          } else {
            dispatchConn({ type: 'SET_STATUS', payload: 'connected' })
            manifestTimeoutRef.current = setTimeout(() => {
              if (!manifestRef.current && !destroyedRef.current) dispatchConn({ type: 'SET_STATUS', payload: 'closed' })
            }, 15000)
            const origManifestHandler = (d: unknown) => {
              const msg = d as { type?: string }
              if (msg.type === 'manifest' || msg.type === 'password-required') clearTimeout(manifestTimeoutRef.current!)
            }
            conn.on('data', origManifestHandler)
          }
          conn.send({ type: 'join', nickname })
        })

        conn.on('data', async (data: unknown) => {
          if (destroyedRef.current) return
          if (heartbeatRef.current) heartbeatRef.current.markAlive()

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

          if (typeof msg.type === 'string' && (msg.type as string).startsWith('call-')) {
            if (callMessageHandlerRef.current) {
              const from = (msg.from as string) || conn.peer
              try { callMessageHandlerRef.current(from, msg) } catch {}
            }
            return
          }

          if (msg.type === 'closing') {
            conn.close()
            return
          }

          if (msg.type === 'public-key') {
            // Guard against unsolicited mid-session key rotation from a malicious peer.
            // Allow ONLY if no shared key exists yet (first handshake or post-reconnect
            // when handleDisconnect has cleared decryptKeyRef).
            if (decryptKeyRef.current) {
              console.warn('Ignoring unsolicited public-key message after key established')
              return
            }
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
              dispatchConn({ type: 'SET', payload: { fingerprint: fp } })

              // Fingerprint rotation warning — surface any change to the user so
              // a silent mid-session MitM swap is visible. On a legit reconnect this
              // is informative; on a MitM takeover it is critical.
              if (originalFingerprintRef.current && originalFingerprintRef.current !== fp) {
                setMessages(prev => [...prev, {
                  text: `Encryption re-established with new fingerprint: ${fp}. Verify with the sender if unexpected.`,
                  from: 'system',
                  time: Date.now(),
                  self: false,
                }])
              }
              originalFingerprintRef.current = fp

              // Process any manifest that arrived before the key was ready
              if (pendingManifestRef.current) {
                const data = pendingManifestRef.current
                pendingManifestRef.current = null
                try {
                  const manifest = await decryptJSON<ManifestData>(decryptKeyRef.current, data)
                  dispatchConn({ type: 'SET', payload: { manifest } })
                  manifestRef.current = manifest
                  dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'receiving' ? prev : 'manifest-received' })
                } catch (e) {
                  console.warn('Failed to decrypt deferred manifest:', e)
                }
              }

              // Resume deferred transfer now that we have the new decryption key
              if (pendingResumeRef.current) {
                const { index, resumeChunk } = pendingResumeRef.current
                pendingResumeRef.current = null
                conn.send({ type: 'request-file', index, resumeChunk })
              }
            } catch {
              dispatchConn({ type: 'SET_STATUS', payload: 'error' })
            }
            return
          }

          if (msg.type === 'password-required') {
            dispatchConn({ type: 'SET', payload: { passwordRequired: true, status: 'password-required' } })
            return
          }

          if (msg.type === 'password-accepted') {
            dispatchConn({ type: 'SET', payload: { passwordRequired: false, passwordError: false } })
            return
          }

          if (msg.type === 'password-wrong') {
            dispatchConn({ type: 'SET', payload: { passwordError: true } })
            return
          }

          if (msg.type === 'online-count') {
            dispatchConn({ type: 'SET', payload: { onlineCount: msg.count as number } })
            return
          }

          if (msg.type === 'typing') {
            handleTypingMessage(msg.nickname as string, setTypingUsers, typingTimeouts.current)
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
            return
          }

          if (msg.type === 'system-msg') {
            setMessages(prev => [...prev, { text: msg.text as string, from: 'system', time: msg.time as number, self: false }])
            return
          }

          if (msg.type === 'chat-encrypted') {
            let payload: Record<string, unknown> = {}
            if (decryptKeyRef.current && msg.data) {
              try { payload = await decryptJSON(decryptKeyRef.current, msg.data as string) }
              catch { return }
            }
            setMessages(prev => [...prev, { text: payload.text as string || '', image: payload.image as string | undefined, mime: payload.mime as string | undefined, replyTo: payload.replyTo as ChatMessage['replyTo'], from: msg.from as string || 'Sender', time: msg.time as number, self: false }])
            return
          }

          if (msg.type === 'chat-image-start-enc') {
            if (!decryptKeyRef.current || !msg.data) return
            let meta: Record<string, unknown>
            try { meta = await decryptJSON(decryptKeyRef.current, msg.data as string) }
            catch { return }
            inProgressImageRef.current = {
              mime: meta.mime as string || 'application/octet-stream',
              size: meta.size as number || 0,
              text: meta.text as string || '',
              replyTo: meta.replyTo as InProgressImage['replyTo'] || null,
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

          // Reject any unencrypted manifest to prevent MITM injection. Only
          // 'manifest-enc' is trusted — it proves the sender holds the shared
          // ECDH-derived AES key.
          if (msg.type === 'manifest') {
            console.warn('Rejected unencrypted manifest — possible MITM attempt')
            return
          }

          if (msg.type === 'manifest-enc') {
            if (!msg.data) return
            // If the key is still being derived, buffer the message; the
            // public-key handler will process it once decryptKeyRef is set.
            if (!decryptKeyRef.current) {
              pendingManifestRef.current = msg.data as string
              return
            }
            try {
              const manifest = await decryptJSON<ManifestData>(decryptKeyRef.current, msg.data as string)
              dispatchConn({ type: 'SET', payload: { manifest } })
              manifestRef.current = manifest
              dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'receiving' ? prev : 'manifest-received' })
            } catch (e) {
              console.warn('Failed to decrypt manifest:', e)
              dispatchConn({ type: 'SET_STATUS', payload: 'error' })
            }
            return
          }

          if (msg.type === 'file-cancelled') {
            const idx = msg.index as number
            if (streamsRef.current[idx]) {
              streamsRef.current[idx]!.abort()
              streamsRef.current[idx] = null
            }
            dispatchTransfer({ type: 'REMOVE_PENDING', index: idx })
            wasTransferringRef.current = false
            dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
            return
          }

          if (msg.type === 'rejected') dispatchConn({ type: 'SET_STATUS', payload: 'rejected' })

          if (msg.type === 'file-start') {
            const idx = msg.index as number
            const resumeFrom = (msg.resumeFrom as number) || 0
            const prevMeta = fileMetaRef.current[idx]
            const priorReceived = (resumeFrom > 0 && prevMeta) ? (prevMeta.received || 0) : 0
            fileMetaRef.current[idx] = { name: msg.name as string, size: msg.size as number, totalChunks: msg.totalChunks as number, received: priorReceived }
            lastFileIndexRef.current = idx
            if (!startTimeRef.current) startTimeRef.current = Date.now()

            if (!zipModeRef.current || !zipWriterRef.current) {
              const stream = createFileStream(sanitizeFileName(msg.name as string), msg.size as number)
              if (stream) {
                streamsRef.current[idx] = stream
              } else {
                chunksRef.current[idx] = []
              }
            } else if (resumeFrom === 0) {
              zipWriterRef.current.startFile(msg.name as string, msg.size as number)
            } else {
              chunksRef.current[idx] = []
            }
          }

          if (msg.type === 'file-end') {
            const idx = msg.index as number
            const meta = fileMetaRef.current[idx]
            if (!meta) return

            await chunkQueueRef.current

            if (zipModeRef.current && zipWriterRef.current) {
              zipWriterRef.current.endFile()
            } else if (streamsRef.current[idx]) {
              streamsRef.current[idx]!.close()
              streamsRef.current[idx] = null
            } else if (chunksRef.current[idx]) {
              const mimeType = manifestRef.current?.files?.[idx]?.type || 'application/octet-stream'
              const blob = new Blob(chunksRef.current[idx] as unknown as BlobPart[], { type: mimeType })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = sanitizeFileName(meta.name)
              a.click()
              URL.revokeObjectURL(url)
              chunksRef.current[idx] = null
            }

            dispatchTransfer({ type: 'COMPLETE_FILE', index: idx, name: meta.name })
            wasTransferringRef.current = false

            if (!zipModeRef.current) {
              dispatchTransfer({ type: 'SET', payload: { overallProgress: 100 } })
              totalReceivedRef.current = transferTotalRef.current
              dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
            }
          }

          if (msg.type === 'done' || msg.type === 'batch-done') {
            await chunkQueueRef.current

            wasTransferringRef.current = false
            pendingResumeRef.current = null
            // Reset reconnect budget — a successful transfer restores the full retry count
            reconnectCountRef.current = 0
            dispatchTransfer({ type: 'SET', payload: { pendingFiles: {}, overallProgress: 100, speed: 0, eta: null } })
            dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })

            if (zipModeRef.current && zipWriterRef.current) {
              zipWriterRef.current.finish()
              zipWriterRef.current = null
              zipModeRef.current = false
              dispatchConn({ type: 'SET', payload: { zipMode: false } })
            }
          }
        })

        conn.on('close', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current!)
          if (disconnectHandled) return
          disconnectHandled = true
          try { conn.removeAllListeners() } catch {}
          if (conn.peerConnection) {
            try { conn.peerConnection.oniceconnectionstatechange = null } catch {}
          }
          if (heartbeatRef.current) heartbeatRef.current.cleanup()
          if (rttPollerRef.current) { rttPollerRef.current.cleanup(); rttPollerRef.current = null }
          if (keyExchangeTimeoutRef.current) { clearTimeout(keyExchangeTimeoutRef.current); keyExchangeTimeoutRef.current = null }
          // Clear stale pendingResume if the transfer had completed
          if (!wasTransferringRef.current) pendingResumeRef.current = null
          chunkQueueRef.current = Promise.resolve()
          imageSendQueueRef.current = Promise.resolve()
          inProgressImageRef.current = null
          if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
            decryptKeyRef.current = null
            keyPairRef.current = null
            Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
            streamsRef.current = {}
            chunksRef.current = {}
            reconnectCountRef.current++
            peer.destroy()
            const token = reconnectTokenRef.current
            setTimeout(() => {
              if (!isMountedRef.current || destroyedRef.current || reconnectTokenRef.current !== token) return
              startConnection(useTurnRef.current, true)
            }, RECONNECT_DELAY)
            return
          }
          Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
          setRtt(null)
          setMessages(prev => [...prev, { text: 'Sender disconnected', from: 'system', time: Date.now(), self: false }])
          dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => (prev === 'done' || prev === 'rejected') ? prev : 'closed' })
        })

        conn.on('error', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current!)
          peer.destroy()
          if (attemptRef.current < MAX_RETRIES) connect()
          else dispatchConn({ type: 'SET_STATUS', payload: withTurn ? 'error' : 'direct-failed' })
        })
      })

      peer.on('error', (err: { type: string }) => {
        if (destroyedRef.current) return
        clearTimeout(timeoutRef.current!)
        if (err.type === 'peer-unavailable') {
          peer.destroy()
          if (attemptRef.current < MAX_RETRIES) setTimeout(() => { if (!destroyedRef.current) connect() }, 2000)
          else dispatchConn({ type: 'SET_STATUS', payload: 'closed' })
        } else {
          peer.destroy()
          if (attemptRef.current < MAX_RETRIES) connect()
          else dispatchConn({ type: 'SET_STATUS', payload: withTurn ? 'error' : 'direct-failed' })
        }
      })

      peer.on('disconnected', () => {
        if (destroyedRef.current) return
        if (!peer.destroyed) peer.reconnect()
      })
    }

    connect()
  }, [peerId])

  useEffect(() => {
    if (!peerId) return
    // Reset mount flag on (re-)mount — cleanup from a prior run may have set
    // it to false, which would make startConnection's mounted-guard bail.
    isMountedRef.current = true
    reconnectTokenRef.current = Symbol('reconnect')

    const handleBeforeUnload = (): void => {
      try { connRef.current?.send({ type: 'closing' }) } catch {}
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    // iOS Safari does not reliably fire beforeunload — pagehide is the correct event
    window.addEventListener('pagehide', handleBeforeUnload)

    const handleOnline = (): void => {
      if (!isMountedRef.current) return
      if (connRef.current && !connRef.current.open && reconnectCountRef.current < MAX_RECONNECTS) {
        startConnection(useTurnRef.current, true)
      }
    }
    window.addEventListener('online', handleOnline)

    startConnection(false)
    return () => {
      // Mark unmounted BEFORE other cleanup to short-circuit any racing reconnects
      isMountedRef.current = false
      reconnectTokenRef.current = Symbol('unmounted')
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
      window.removeEventListener('online', handleOnline)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      if (keyExchangeTimeoutRef.current) clearTimeout(keyExchangeTimeoutRef.current)
      if (connRef.current) try { connRef.current.removeAllListeners() } catch {}
      destroyedRef.current = true
      clearTimeout(timeoutRef.current!)
      clearTimeout(manifestTimeoutRef.current!)
      if (heartbeatRef.current) { heartbeatRef.current.cleanup(); heartbeatRef.current = null }
      if (rttPollerRef.current) { rttPollerRef.current.cleanup(); rttPollerRef.current = null }
      decryptKeyRef.current = null
      keyPairRef.current = null
      chunkQueueRef.current = Promise.resolve()
      imageSendQueueRef.current = Promise.resolve()
      inProgressImageRef.current = null
      imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
      imageBlobUrlsRef.current = []
      Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
      if (zipWriterRef.current) { zipWriterRef.current.abort(); zipWriterRef.current = null }
      if (peerRef.current) peerRef.current.destroy()
      setPeerInstance(null)
    }
  }, [peerId, startConnection])

  const enableRelay = useCallback((): void => {
    destroyedRef.current = true
    clearTimeout(timeoutRef.current!)
    chunkQueueRef.current = Promise.resolve()
    reconnectCountRef.current = 0
    if (peerRef.current) peerRef.current.destroy()
    useTurnRef.current = true
    dispatchConn({ type: 'SET', payload: { useRelay: true } })
    const token = reconnectTokenRef.current
    setTimeout(() => {
      if (!isMountedRef.current || reconnectTokenRef.current !== token) return
      startConnection(true)
    }, 500)
  }, [startConnection])

  const cancelFile = useCallback((index: number): void => {
    const conn = connRef.current
    if (!conn) return
    conn.send({ type: 'cancel-file', index })
    if (streamsRef.current[index]) {
      streamsRef.current[index]!.abort()
      streamsRef.current[index] = null
    }
    if (chunksRef.current[index]) chunksRef.current[index] = null
    delete fileMetaRef.current[index]
    const name = manifestRef.current?.files[index]?.name
    dispatchTransfer({ type: 'CANCEL_FILE', index, name })
    wasTransferringRef.current = false
    dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
  }, [])

  const cancelAll = useCallback((): void => {
    const conn = connRef.current
    if (conn) try { conn.send({ type: 'cancel-all' }) } catch {}
    if (zipWriterRef.current) {
      zipWriterRef.current.abort()
      zipWriterRef.current = null
      zipModeRef.current = false
      dispatchConn({ type: 'SET', payload: { zipMode: false } })
    }
    Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
    streamsRef.current = {}
    fileMetaRef.current = {}
    dispatchTransfer({ type: 'RESET' })
    wasTransferringRef.current = false
    dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
  }, [])

  const pauseFile = useCallback((index: number): void => {
    const conn = connRef.current
    if (!conn) return
    conn.send({ type: 'pause-file', index })
    dispatchTransfer({ type: 'PAUSE_FILE', index })
  }, [])

  const resumeFile = useCallback((index: number): void => {
    const conn = connRef.current
    if (!conn) return
    conn.send({ type: 'resume-file', index })
    dispatchTransfer({ type: 'RESUME_FILE', index })
  }, [])

  const sendTyping = useCallback((): void => {
    const conn = connRef.current
    if (conn) try { conn.send({ type: 'typing', nickname }) } catch {}
  }, [nickname])

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
    const conn = connRef.current
    if (conn) try { conn.send({ type: 'reaction', msgId, emoji, nickname }) } catch {}
  }, [nickname])

  const changeNickname = useCallback((newName: string): void => {
    const conn = connRef.current
    if (!conn || !newName.trim()) return
    const oldName = nickname
    setNickname(newName.trim())
    try { conn.send({ type: 'nickname-change', oldName, newName: newName.trim() }) } catch {}
  }, [nickname])

  const sendMessage = useCallback(async (text: string, image?: { bytes: Uint8Array; mime: string } | string, replyTo?: ChatMessage['replyTo']): Promise<void> => {
    if (!text && !image) return
    const now = Date.now()
    if (now - lastMsgTime.current < 100) return
    lastMsgTime.current = now
    const conn = connRef.current
    if (!conn || !decryptKeyRef.current) return
    const time = Date.now()
    const key = decryptKeyRef.current

    if (image && typeof image === 'object' && (image as { bytes: Uint8Array; mime: string }).bytes) {
      const imgObj = image as { bytes: Uint8Array; mime: string; duration?: number }
      const bytes = imgObj.bytes instanceof Uint8Array ? imgObj.bytes : new Uint8Array(imgObj.bytes)
      const mime = imgObj.mime || 'application/octet-stream'
      const duration = imgObj.duration
      const localBlob = new Blob([bytes as unknown as BlobPart], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { text: text || '', image: localUrl, mime, duration, replyTo, from: 'You', time, self: true }])

      imageSendQueueRef.current = imageSendQueueRef.current
        .then(() => streamImageToHost(conn, key, bytes, mime, text || '', replyTo ?? null, time, nickname, destroyedRef, duration))
        .catch(() => {})
      return
    }

    const imgStr = image as string | undefined
    setMessages(prev => [...prev, { text, image: imgStr, replyTo, from: 'You', time, self: true }])
    try {
      const payload = JSON.stringify({ text, image: imgStr, replyTo })
      const encrypted = await encryptChunk(key, new TextEncoder().encode(payload))
      conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), nickname, time })
    } catch (e) { console.warn('Failed to send chat message:', e) }
  }, [nickname])

  async function handleChunk(rawData: ArrayBuffer | ArrayBufferView): Promise<void> {
    const buffer = rawData instanceof ArrayBuffer ? rawData : ((rawData as ArrayBufferView).buffer as ArrayBuffer)
    const { fileIndex, chunkIndex, data } = parseChunkPacket(buffer)

    let plainData: ArrayBuffer | Uint8Array
    try {
      plainData = decryptKeyRef.current
        ? await decryptChunk(decryptKeyRef.current, data)
        : data
    } catch (decryptErr) {
      console.error('Chunk decryption failed for file', fileIndex, 'chunk', chunkIndex, decryptErr)
      if (streamsRef.current[fileIndex]) {
        try { streamsRef.current[fileIndex]!.abort() } catch {}
        streamsRef.current[fileIndex] = null
      }
      if (chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = null
      const fileName = manifestRef.current?.files?.[fileIndex]?.name || `file ${fileIndex}`
      dispatchTransfer({ type: 'CANCEL_FILE', index: fileIndex, name: fileName })
      wasTransferringRef.current = false
      return
    }

    if (fileIndex === CHAT_IMAGE_FILE_INDEX) {
      const inFlight = inProgressImageRef.current
      if (inFlight) {
        const bytes = plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData)
        if (inFlight.receivedBytes + bytes.byteLength > MAX_CHAT_IMAGE_SIZE) {
          inProgressImageRef.current = null
          return
        }
        inFlight.chunks.push(bytes)
        inFlight.receivedBytes += bytes.byteLength
      }
      return
    }

    const manifestFiles = manifestRef.current?.files
    if (!manifestFiles || fileIndex >= manifestFiles.length) return

    lastFileIndexRef.current = fileIndex
    lastChunkIndexRef.current = chunkIndex + 1
    totalReceivedRef.current += (plainData as { byteLength: number }).byteLength
    const metaForBytes = fileMetaRef.current[fileIndex]
    if (metaForBytes) metaForBytes.received = (metaForBytes.received || 0) + (plainData as { byteLength: number }).byteLength

    try {
      const plainBytes = plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData)
      if (zipModeRef.current && zipWriterRef.current) {
        zipWriterRef.current.writeChunk(plainBytes)
      } else if (streamsRef.current[fileIndex]) {
        await streamsRef.current[fileIndex]!.write(plainBytes)
      } else {
        if (!chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = []
        chunksRef.current[fileIndex]!.push(plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData))
      }
    } catch {
      // Write failed (disk full, stream error) — skip chunk
    }

    const now = Date.now()
    if (now - lastChunkUIUpdateRef.current >= 100) {
      lastChunkUIUpdateRef.current = now
      const meta = fileMetaRef.current[fileIndex]
      if (meta && meta.size > 0) {
        const pct = Math.min(100, Math.round((meta.received / meta.size) * 100))
        dispatchTransfer({ type: 'FILE_PROGRESS', name: meta.name, value: pct })
      }
      const totalSize = transferTotalRef.current || manifestRef.current?.totalSize || 0
      if (totalSize > 0) {
        const overall = Math.min(100, Math.round((totalReceivedRef.current / totalSize) * 100))
        const elapsed = (now - startTimeRef.current!) / 1000
        if (elapsed > 0.5) {
          const currentSpeed = totalReceivedRef.current / elapsed
          dispatchTransfer({ type: 'SET', payload: { overallProgress: overall, speed: currentSpeed, eta: Math.max(0, (totalSize - totalReceivedRef.current) / currentSpeed) } })
        } else {
          dispatchTransfer({ type: 'SET', payload: { overallProgress: overall } })
        }
      }
    }
  }

  const requestFile = useCallback((index: number): void => {
    const conn = connRef.current
    if (!conn || !manifestRef.current) return
    wasTransferringRef.current = true
    zipModeRef.current = false
    totalReceivedRef.current = 0
    startTimeRef.current = Date.now()
    transferTotalRef.current = manifestRef.current.files[index]?.size || 0
    dispatchConn({ type: 'SET_STATUS', payload: 'receiving' })
    dispatchTransfer({ type: 'SET', payload: { progress: {}, overallProgress: 0, speed: 0, eta: null } })
    conn.send({ type: 'request-file', index })
    dispatchTransfer({ type: 'ADD_PENDING', index })
  }, [])

  const requestAllAsZip = useCallback((): void => {
    const conn = connRef.current
    if (!conn || !manifestRef.current) return

    const zipWriter = createStreamingZip('manifest-files.zip')
    if (!zipWriter) return

    zipWriterRef.current = zipWriter
    wasTransferringRef.current = true
    zipModeRef.current = true
    dispatchConn({ type: 'SET', payload: { zipMode: true, status: 'receiving' } })
    totalReceivedRef.current = 0
    startTimeRef.current = Date.now()
    const indices = manifestRef.current.files.map((_, i) => i).filter(i => !transfer.completedFiles[i])
    transferTotalRef.current = indices.reduce((sum, i) => sum + (manifestRef.current!.files[i]?.size || 0), 0)
    dispatchTransfer({ type: 'SET', payload: { progress: {}, overallProgress: 0, speed: 0, eta: null } })
    conn.send({ type: 'request-all', indices })
    const pending: Record<number, boolean> = {}
    indices.forEach(i => { pending[i] = true })
    dispatchTransfer({ type: 'SET', payload: { pendingFiles: pending } })
  }, [transfer.completedFiles])

  const submitPassword = useCallback(async (password: string): Promise<void> => {
    const conn = connRef.current
    if (!conn || !decryptKeyRef.current) return
    dispatchConn({ type: 'SET', payload: { passwordError: false } })
    try {
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(password))
      conn.send({ type: 'password-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)) })
    } catch (e) { console.warn('Failed to submit password:', e) }
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
    imageBlobUrlsRef.current = []
  }, [])

  return {
    manifest: conn.manifest, status: conn.status, progress: transfer.progress, overallProgress: transfer.overallProgress, speed: transfer.speed, eta: transfer.eta,
    pendingFiles: transfer.pendingFiles, completedFiles: transfer.completedFiles, requestFile, requestAllAsZip,
    retryCount: conn.retryCount, useRelay: conn.useRelay, enableRelay, zipMode: conn.zipMode, fingerprint: conn.fingerprint,
    passwordRequired: conn.passwordRequired, passwordError: conn.passwordError, submitPassword,
    messages, sendMessage, clearMessages, rtt, nickname, changeNickname, onlineCount: conn.onlineCount,
    typingUsers, sendTyping, sendReaction, cancelFile, cancelAll, pauseFile, resumeFile, pausedFiles: transfer.pausedFiles,
    peer: peerInstance, hostPeerId: peerId, sendCallMessage, setCallMessageHandler,
  }
}

// ── streamImageToHost ────────────────────────────────────────────────────

async function streamImageToHost(
  conn: DataConnection,
  key: CryptoKey,
  bytes: Uint8Array,
  mime: string,
  text: string,
  replyTo: { text: string; from: string; time: number } | null,
  time: number,
  nickname: string,
  destroyedRef: { current: boolean },
  duration?: number
): Promise<void> {
  if (!conn || conn.open === false || !key) return
  try {
    const startPayload = JSON.stringify({ mime, size: bytes.byteLength, text, replyTo, time, duration })
    const encStart = await encryptChunk(key, new TextEncoder().encode(startPayload))
    conn.send({ type: 'chat-image-start-enc', data: uint8ToBase64(new Uint8Array(encStart)), from: nickname, time })
  } catch { return }

  const chunker = new AdaptiveChunker()
  let offset = 0
  let chunkIndex = 0
  while (offset < bytes.byteLength) {
    if (destroyedRef.current || !conn.open) return
    const chunkSize = Math.min(chunker.getChunkSize(), bytes.byteLength - offset)
    const slice = bytes.subarray(offset, offset + chunkSize)
    const tStart = Date.now()
    let encChunk: ArrayBuffer
    try {
      encChunk = await encryptChunk(key, slice)
    } catch { return }
    const packet = buildChunkPacket(CHAT_IMAGE_FILE_INDEX, chunkIndex, encChunk)
    try { conn.send(packet) } catch { return }
    try { await waitForBufferDrain(conn) } catch { return }
    chunker.recordTransfer(slice.byteLength, Date.now() - tStart)
    offset += chunkSize
    chunkIndex++
  }

  try {
    const endPayload = JSON.stringify({})
    const encEnd = await encryptChunk(key, new TextEncoder().encode(endPayload))
    conn.send({ type: 'chat-image-end-enc', data: uint8ToBase64(new Uint8Array(encEnd)) })
  } catch { /* swallow — receiver will time out the in-flight image */ }
}
