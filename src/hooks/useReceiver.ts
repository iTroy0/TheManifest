import Peer, { DataConnection } from 'peerjs'
import { useState, useReducer, useEffect, useRef, useCallback } from 'react'
import { parseChunkPacket, buildChunkPacket, waitForBufferDrain, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk, decryptJSON, uint8ToBase64 } from '../utils/crypto'
import { finalizeKeyExchange } from '../net/keyExchange'
import { createSession, type Session } from '../net/session'
import { createFileWritableStream } from '../utils/streamWriter'
import { createStreamingZip } from '../utils/zipBuilder'
import { createFileReceiver, portalWire, IntegrityError } from '../net/transferEngine'
import type { FileReceiver } from '../net/transferEngine'
import { STUN_ONLY, getWithTurn } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { ChatMessage, ManifestData } from '../types'
import { sanitizeFileName } from '../utils/filename'
import { generateNickname } from '../utils/nickname'
import { log } from '../utils/logger'
import type { PortalMsg } from '../net/protocol'
import {
  transferReducer,
  connectionReducer,
  initialTransfer,
  initialConnection,
} from './state/receiverState'

import {
  MAX_RETRIES,
  TIMEOUT_MS,
  RECONNECT_DELAY,
  MAX_RECONNECTS,
  MAX_CHAT_IMAGE_SIZE,
} from '../net/config'

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

export function useReceiver(peerId: string) {
  const [transfer, dispatchTransfer] = useReducer(transferReducer, initialTransfer)
  const [conn, dispatchConn] = useReducer(connectionReducer, initialConnection)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [rtt, setRtt] = useState<number | null>(null)
  const [nickname, setNickname] = useState<string>(() => generateNickname())
  const [typingUsers, setTypingUsers] = useState<string[]>([])
  const typingTimeouts = useRef<Record<string, ReturnType<typeof setTimeout>>>({})
  const lastMsgTime = useRef<number>(0)

  const receiverRef = useRef<FileReceiver | null>(null)
  const chunksRef = useRef<Record<number, Uint8Array[] | null>>({})
  const zipWriterRef = useRef<ReturnType<typeof createStreamingZip> | null>(null)
  const fileMetaRef = useRef<Record<number, FileMeta>>({})
  const totalReceivedRef = useRef<number>(0)
  const startTimeRef = useRef<number | null>(null)
  const manifestRef = useRef<ManifestData | null>(null)

  const sessionRef = useRef<Session | null>(null)

  const peerRef = useRef<InstanceType<typeof Peer> | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const destroyedRef = useRef<boolean>(false)
  const attemptRef = useRef<number>(0)
  const zipModeRef = useRef<boolean>(false)

  const transferTotalRef = useRef<number>(0)
  const lastFileIndexRef = useRef<number>(0)
  const wasTransferringRef = useRef<boolean>(false)
  const reconnectCountRef = useRef<number>(0)
  const useTurnRef = useRef<boolean>(false)
  const imageBlobUrlsRef = useRef<string[]>([])
  const lastChunkUIUpdateRef = useRef<number>(0)
  const manifestTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingResumeRef = useRef<{ index: number; resumeChunk: number } | null>(null)
  const originalFingerprintRef = useRef<string | null>(null)
  const isMountedRef = useRef<boolean>(true)
  // Hook-level reconnect-intent token — orthogonal to session identity.
  // Rotates on every reconnect intent, enableRelay flip, and unmount so
  // async orchestration setTimeouts can detect a newer intent and bail.
  const reconnectTokenRef = useRef<symbol>(Symbol('reconnect'))
  // Buffers a manifest-enc message that arrives before key exchange
  // completes — the sender emits manifest-enc the moment it derives its
  // encryptKey, but the receiver is still awaiting its own deriveSharedKey.
  const pendingManifestRef = useRef<string | null>(null)

  const [peerInstance, setPeerInstance] = useState<InstanceType<typeof Peer> | null>(null)
  const callMessageHandlerRef = useRef<((fromPeerId: string, msg: Record<string, unknown>) => void) | null>(null)

  const setCallMessageHandler = useCallback((h: ((fromPeerId: string, msg: Record<string, unknown>) => void) | null): void => {
    callMessageHandlerRef.current = h
  }, [])

  const sendCallMessage = useCallback((msg: Record<string, unknown>): void => {
    const sess = sessionRef.current
    if (sess && sess.conn.open) {
      try { sess.send(msg) } catch (e) { log.warn('useReceiver.sendCallMessage', e) }
    }
  }, [])

  const startConnection = useCallback((withTurn: boolean, isReconnect: boolean = false): void => {
    if (!window.crypto?.subtle) { dispatchConn({ type: 'SET_STATUS', payload: 'error' }); return }
    if (!isMountedRef.current) return
    destroyedRef.current = false
    attemptRef.current = 0
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

      const turn = useTurnRef.current ? await getWithTurn() : null
      const config = turn ?? STUN_ONLY
      // L-a: surface relay fallback in chat so the user knows their IP is
      // visible to peers even though they enabled the relay-only path.
      // Only fires once per (re)connect attempt; the message stream cap
      // handles dedupe in the worst case.
      if (turn?.relayFallback) {
        setMessages(prev => [...prev, {
          text: 'Relay (TURN) unavailable — using STUN only. Your public IP may be visible to peers.',
          from: 'system', time: Date.now(), self: false,
        }].slice(-500))
      }
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
        const sess = createSession({
          conn,
          role: 'portal-receiver',
          generation: attemptRef.current,
        })
        sessionRef.current = sess
        sess.dispatch({ type: 'connect-start' })
        setPeerInstance(peer)

        conn.on('open', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current!)
          reconnectCountRef.current = 0
          sess.dispatch({ type: 'conn-open' })

          sess.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

          function handleDisconnect(reason: string): void {
            if (sessionRef.current !== sess || destroyedRef.current) return
            if (sess.state === 'closed' || sess.state === 'error' || sess.state === 'kicked') return
            try { conn.removeAllListeners() } catch (e) { log.warn('useReceiver.handleDisconnect.removeListeners', e) }
            if (conn.peerConnection) {
              try { conn.peerConnection.oniceconnectionstatechange = null } catch (e) { log.warn('useReceiver.handleDisconnect.clearIce', e) }
            }
            if (!wasTransferringRef.current) pendingResumeRef.current = null
            setRtt(null)
            setMessages(prev => [...prev, { text: reason, from: 'system', time: Date.now(), self: false }])
            sess.close('peer-disconnect')
            if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
              if (receiverRef.current) {
                receiverRef.current = null
              }
              chunksRef.current = {}
              reconnectCountRef.current++
              peer.destroy()
              const token = reconnectTokenRef.current
              setTimeout(() => {
                if (!isMountedRef.current || destroyedRef.current || reconnectTokenRef.current !== token) return
                startConnection(useTurnRef.current, true)
              }, RECONNECT_DELAY)
            } else {
              receiverRef.current = null
              dispatchConn({ type: 'SET_STATUS', payload: 'closed' })
            }
          }

          sess.heartbeat = setupHeartbeat(conn, {
            onDead: () => handleDisconnect('Connection lost'),
          })

          sess.keyExchangeTimeout = setTimeout(() => {
            if (sessionRef.current !== sess) return
            if (!sess.encryptKey && !destroyedRef.current) {
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
            pendingResumeRef.current = {
              index: lastFileIndexRef.current,
              resumeChunk: receiverRef.current?.getResumeCursor(`file-${lastFileIndexRef.current}`) ?? 0,
            }
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
          try { sess.send({ type: 'join', nickname } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.sendJoin', e) }
        })

        conn.on('data', async (data: unknown) => {
          if (destroyedRef.current) return
          if (sess.heartbeat) sess.heartbeat.markAlive()

          if (data instanceof ArrayBuffer || (data && (data as ArrayBuffer).byteLength !== undefined && !(typeof data === 'object' && (data as { type?: unknown }).type))) {
            sess.chunkQueue = sess.chunkQueue.then(() => handleChunk(data as ArrayBuffer, sess)).catch(e => log.warn('useReceiver.chunkQueue', e))
            return
          }

          const raw = data as { type?: unknown; from?: unknown }
          if (typeof raw.type === 'string' && raw.type.startsWith('call-')) {
            if (callMessageHandlerRef.current) {
              const from = (typeof raw.from === 'string' && raw.from) || conn.peer
              try { callMessageHandlerRef.current(from, raw as Record<string, unknown>) }
              catch (e) { log.warn('useReceiver.callMessageHandler', e) }
            }
            return
          }

          const msg = data as PortalMsg

          if (msg.type === 'pong') return
          if (msg.type === 'ping') {
            try { sess.send({ type: 'pong', ts: msg.ts } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.sendPong', e) }
            return
          }

          if (msg.type === 'closing') {
            conn.close()
            return
          }

          if (msg.type === 'public-key') {
            // Guard against unsolicited mid-session key rotation from a
            // malicious peer. Allow ONLY if no shared key exists yet.
            if (sess.encryptKey) {
              console.warn('Ignoring unsolicited public-key message after key established')
              return
            }
            try {
              if (!sess.keyPair) {
                sess.setKeyPair(await generateKeyPair())
              }
              const pubKeyBytes = await exportPublicKey(sess.keyPair!.publicKey)
              sess.send({ type: 'public-key', key: Array.from(pubKeyBytes) } satisfies PortalMsg)
              const remoteKeyBytes = new Uint8Array(msg.key as number[])
              const { encryptKey, fingerprint: fp } = await finalizeKeyExchange({
                localPrivate: sess.keyPair!.privateKey,
                localPublic: pubKeyBytes,
                remotePublic: remoteKeyBytes,
              })
              sess.dispatch({ type: 'keys-derived', encryptKey, fingerprint: fp })
              dispatchConn({ type: 'SET', payload: { fingerprint: fp } })
              receiverRef.current = createFileReceiver(sess, portalWire)

              // Fingerprint rotation warning — surface any change to the user
              // so a silent mid-session MitM swap is visible.
              if (originalFingerprintRef.current && originalFingerprintRef.current !== fp) {
                setMessages(prev => [...prev, {
                  text: `Encryption re-established with new fingerprint: ${fp}. Verify with the sender if unexpected.`,
                  from: 'system',
                  time: Date.now(),
                  self: false,
                }])
              }
              originalFingerprintRef.current = fp

              if (pendingManifestRef.current) {
                const data = pendingManifestRef.current
                pendingManifestRef.current = null
                try {
                  const manifest = await decryptJSON<ManifestData>(encryptKey, data)
                  dispatchConn({ type: 'SET', payload: { manifest } })
                  manifestRef.current = manifest
                  dispatchConn({ type: 'SET_STATUS', payload: (prev: string) => prev === 'receiving' ? prev : 'manifest-received' })
                } catch (e) {
                  console.warn('Failed to decrypt deferred manifest:', e)
                }
              }

              if (pendingResumeRef.current) {
                const { index, resumeChunk } = pendingResumeRef.current
                pendingResumeRef.current = null
                try { sess.send({ type: 'request-file', index, resumeChunk } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.resumeRequest', e) }
              }
            } catch (e) {
              // M10 fix: don't leak the buffered manifest to a later connection
              pendingManifestRef.current = null
              log.warn('useReceiver.publicKey', e)
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
            if (sess.encryptKey && msg.data) {
              try { payload = await decryptJSON(sess.encryptKey, msg.data as string) }
              catch (e) { log.warn('useReceiver.chatEncrypted.decrypt', e); return }
            }
            setMessages(prev => [...prev, { text: payload.text as string || '', image: payload.image as string | undefined, mime: payload.mime as string | undefined, replyTo: payload.replyTo as ChatMessage['replyTo'], from: msg.from as string || 'Sender', time: msg.time as number, self: false }])
            return
          }

          if (msg.type === 'chat-image-abort') {
            sess.inProgressImage = null
            return
          }

          if (msg.type === 'chat-image-start-enc') {
            if (!sess.encryptKey || !msg.data) return
            let meta: Record<string, unknown>
            try { meta = await decryptJSON(sess.encryptKey, msg.data as string) }
            catch (e) { log.warn('useReceiver.chatImageStart.decrypt', e); return }
            sess.inProgressImage = {
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
            await sess.chunkQueue
            const inFlight = sess.inProgressImage
            sess.inProgressImage = null
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
            if (!sess.encryptKey) {
              pendingManifestRef.current = msg.data as string
              return
            }
            try {
              const manifest = await decryptJSON<ManifestData>(sess.encryptKey, msg.data as string)
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
            const fileId = portalWire.fileIdForPacketIndex(idx) ?? `file-${idx}`
            if (receiverRef.current?.has(fileId)) {
              await receiverRef.current.abort(fileId, 'cancelled')
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
              // Attempt StreamSaver path — createFileStream returns null when
              // the browser doesn't support WritableStream (mobile, Firefox).
              // On success, hand the StreamSaver WritableStream to the engine
              // so it owns decrypt + write.  On failure fall back to in-memory
              // buffer.  Pass the stream through directly (no wrapper) — an
              // extra WritableStream layer was swallowing the final flush and
              // the browser never produced a `download` event.
              const streamSink = createFileWritableStream(sanitizeFileName(msg.name as string), msg.size as number)
              if (streamSink && receiverRef.current) {
                await receiverRef.current.onFileStart({
                  fileId: `file-${idx}`,
                  totalBytes: msg.size as number,
                  totalChunks: msg.totalChunks as number,
                  sink: streamSink,
                  onProgress: (written, total) => {
                    const meta = fileMetaRef.current[idx]
                    if (meta) meta.received = written
                    const now = Date.now()
                    if (now - lastChunkUIUpdateRef.current < 100 || !meta || meta.size <= 0) return
                    lastChunkUIUpdateRef.current = now
                    const pct = Math.min(100, Math.round((written / total) * 100))
                    dispatchTransfer({ type: 'FILE_PROGRESS', name: meta.name, value: pct })
                    totalReceivedRef.current = Object.values(fileMetaRef.current)
                      .reduce((s, m) => s + (m?.received || 0), 0)
                    const totalSize = transferTotalRef.current || manifestRef.current?.totalSize || 0
                    if (totalSize > 0 && startTimeRef.current) {
                      const overall = Math.min(100, Math.round((totalReceivedRef.current / totalSize) * 100))
                      const elapsed = (now - startTimeRef.current) / 1000
                      if (elapsed > 0.5) {
                        const currentSpeed = totalReceivedRef.current / elapsed
                        dispatchTransfer({
                          type: 'SET',
                          payload: {
                            overallProgress: overall,
                            speed: currentSpeed,
                            eta: Math.max(0, (totalSize - totalReceivedRef.current) / currentSpeed),
                          },
                        })
                      } else {
                        dispatchTransfer({ type: 'SET', payload: { overallProgress: overall } })
                      }
                    }
                  },
                })
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

            await sess.chunkQueue

            if (zipModeRef.current && zipWriterRef.current) {
              zipWriterRef.current.endFile()
            } else if (receiverRef.current?.has(`file-${idx}`)) {
              try {
                // M-i: pass `integrity` so the receiver verifies before
                // closing the sink. Throws IntegrityError on truncation
                // or hash mismatch — surface as a UI cancel + system
                // message instead of letting the file silently truncate.
                await receiverRef.current.onFileEnd(`file-${idx}`, msg.integrity)
              } catch (err) {
                if (err instanceof IntegrityError) {
                  log.warn('useReceiver.integrityFail', { idx, kind: err.kind, message: err.message })
                  dispatchTransfer({ type: 'CANCEL_FILE', index: idx, name: meta.name })
                  setMessages(prev => [...prev, {
                    text: `${meta.name} integrity check failed (${err.kind}) — file discarded`,
                    from: 'system', time: Date.now(), self: false,
                  }].slice(-500))
                  wasTransferringRef.current = false
                  return
                }
                throw err
              }
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

          if (msg.type === 'file-skipped') {
            // Sender hit an error partway through `request-all` / `ready`
            // and gave up on this index. Before this message existed the
            // sender just swallowed the error and the receiver UI kept
            // showing the file as pending forever.
            const idx = msg.index as number
            const name = manifestRef.current?.files?.[idx]?.name
            const reason = (msg.reason as string) || 'send-failed'
            log.warn('useReceiver.fileSkipped', { idx, name, reason })
            dispatchTransfer({ type: 'CANCEL_FILE', index: idx, name })
            setMessages(prev => [...prev, {
              text: `${name || `File #${idx}`} skipped: ${reason}`,
              from: 'system', time: Date.now(), self: false,
            }].slice(-500))
          }

          if (msg.type === 'done' || msg.type === 'batch-done') {
            await sess.chunkQueue

            wasTransferringRef.current = false
            pendingResumeRef.current = null
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
          if (sessionRef.current !== sess) return
          if (sess.state === 'closed' || sess.state === 'error' || sess.state === 'kicked') return
          try { conn.removeAllListeners() } catch (e) { log.warn('useReceiver.close.removeListeners', e) }
          if (conn.peerConnection) {
            try { conn.peerConnection.oniceconnectionstatechange = null } catch (e) { log.warn('useReceiver.close.clearIce', e) }
          }
          if (!wasTransferringRef.current) pendingResumeRef.current = null
          sess.close('peer-disconnect')
          if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
            receiverRef.current = null
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
          receiverRef.current = null
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
          if (attemptRef.current < MAX_RETRIES) setTimeout(() => { if (!destroyedRef.current) connect() }, RECONNECT_DELAY)
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
    isMountedRef.current = true
    reconnectTokenRef.current = Symbol('reconnect')

    const handleBeforeUnload = (): void => {
      const sess = sessionRef.current
      if (!sess) return
      try { sess.send({ type: 'closing' } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.sendClosing', e) }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    // iOS Safari does not reliably fire beforeunload — pagehide is the correct event
    window.addEventListener('pagehide', handleBeforeUnload)

    const handleOnline = (): void => {
      if (!isMountedRef.current) return
      // Fresh network means a fresh chance — don't let a budget exhausted
      // during an outage lock us out once the network comes back.
      reconnectCountRef.current = 0
      const sess = sessionRef.current
      if (sess && !sess.conn.open) {
        startConnection(useTurnRef.current, true)
      }
    }
    window.addEventListener('online', handleOnline)

    const handleVisibility = (): void => {
      if (!isMountedRef.current) return
      if (typeof document === 'undefined') return
      if (document.visibilityState !== 'visible') return
      const hb = sessionRef.current?.heartbeat
      if (hb) hb.markAlive()
      if (peerRef.current && peerRef.current.disconnected && !peerRef.current.destroyed) {
        try { peerRef.current.reconnect() } catch (e) { log.warn('useReceiver.visibilityReconnect', e) }
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    startConnection(false)
    return () => {
      // Mark unmounted BEFORE other cleanup to short-circuit any racing reconnects
      isMountedRef.current = false
      reconnectTokenRef.current = Symbol('unmounted')
      window.removeEventListener('beforeunload', handleBeforeUnload)
      window.removeEventListener('pagehide', handleBeforeUnload)
      window.removeEventListener('online', handleOnline)
      document.removeEventListener('visibilitychange', handleVisibility)
      Object.values(typingTimeouts.current).forEach(clearTimeout)
      typingTimeouts.current = {}
      const sess = sessionRef.current
      if (sess) {
        try { sess.conn.removeAllListeners() } catch (e) { log.warn('useReceiver.unmount.removeListeners', e) }
        sess.close('session-abort')
        sessionRef.current = null
      }
      destroyedRef.current = true
      clearTimeout(timeoutRef.current!)
      clearTimeout(manifestTimeoutRef.current!)
      imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useReceiver.unmount.revokeBlob', e) } })
      imageBlobUrlsRef.current = []
      receiverRef.current = null
      if (zipWriterRef.current) { zipWriterRef.current.abort(); zipWriterRef.current = null }
      if (peerRef.current) peerRef.current.destroy()
      setPeerInstance(null)
    }
  }, [peerId, startConnection])

  const enableRelay = useCallback((): void => {
    // Bump the reconnect token FIRST so any in-flight async handlers that
    // captured the old token (e.g. a chunk decrypt still awaiting) detect
    // the switch and bail out of mutating state against the new connection.
    reconnectTokenRef.current = Symbol('enable-relay')
    const token = reconnectTokenRef.current
    destroyedRef.current = true
    clearTimeout(timeoutRef.current!)
    const sess = sessionRef.current
    if (sess) {
      sess.close('session-abort')
      sessionRef.current = null
    }
    reconnectCountRef.current = 0
    if (peerRef.current) peerRef.current.destroy()
    useTurnRef.current = true
    dispatchConn({ type: 'SET', payload: { useRelay: true } })
    setTimeout(() => {
      if (!isMountedRef.current || reconnectTokenRef.current !== token) return
      startConnection(true)
    }, 500)
  }, [startConnection])

  const cancelFile = useCallback((index: number): void => {
    const sess = sessionRef.current
    if (!sess) return
    try { sess.send({ type: 'cancel-file', index } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.cancelFile', e) }
    const cancelFileId = `file-${index}`
    if (receiverRef.current?.has(cancelFileId)) {
      void receiverRef.current.abort(cancelFileId, 'cancelled')
    }
    if (chunksRef.current[index]) chunksRef.current[index] = null
    delete fileMetaRef.current[index]
    const name = manifestRef.current?.files[index]?.name
    dispatchTransfer({ type: 'CANCEL_FILE', index, name })
    wasTransferringRef.current = false
    dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
  }, [])

  const cancelAll = useCallback((): void => {
    const sess = sessionRef.current
    if (sess) try { sess.send({ type: 'cancel-all' } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.cancelAll', e) }
    if (zipWriterRef.current) {
      zipWriterRef.current.abort()
      zipWriterRef.current = null
      zipModeRef.current = false
      dispatchConn({ type: 'SET', payload: { zipMode: false } })
    }
    // Abort every live engine sink BEFORE nulling receiverRef — without
    // this, StreamSaver's service worker keeps each browser-side partial
    // download alive after the UI reset. Walk the current manifest indices
    // that still have active engine state and issue abort() per fileId.
    const recv = receiverRef.current
    if (recv) {
      const total = manifestRef.current?.files.length ?? 0
      for (let i = 0; i < total; i++) {
        const fileId = `file-${i}`
        if (recv.has(fileId)) {
          void recv.abort(fileId, 'cancelled')
        }
      }
    }
    receiverRef.current = null
    fileMetaRef.current = {}
    dispatchTransfer({ type: 'RESET' })
    wasTransferringRef.current = false
    dispatchConn({ type: 'SET_STATUS', payload: 'manifest-received' })
  }, [])

  const pauseFile = useCallback((index: number): void => {
    const sess = sessionRef.current
    if (!sess) return
    try { sess.send({ type: 'pause-file', index } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.pauseFile', e) }
    dispatchTransfer({ type: 'PAUSE_FILE', index })
  }, [])

  const resumeFile = useCallback((index: number): void => {
    const sess = sessionRef.current
    if (!sess) return
    try { sess.send({ type: 'resume-file', index } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.resumeFile', e) }
    dispatchTransfer({ type: 'RESUME_FILE', index })
  }, [])

  const sendTyping = useCallback((): void => {
    const sess = sessionRef.current
    if (sess) try { sess.send({ type: 'typing', nickname } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.sendTyping', e) }
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
    const sess = sessionRef.current
    if (sess) try { sess.send({ type: 'reaction', msgId, emoji, nickname } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.sendReaction', e) }
  }, [nickname])

  const changeNickname = useCallback((newName: string): void => {
    const sess = sessionRef.current
    if (!sess || !newName.trim()) return
    const oldName = nickname
    setNickname(newName.trim())
    try { sess.send({ type: 'nickname-change', oldName, newName: newName.trim() } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.changeNickname', e) }
  }, [nickname])

  const sendMessage = useCallback(async (text: string, image?: { bytes: Uint8Array; mime: string } | string, replyTo?: ChatMessage['replyTo']): Promise<void> => {
    if (!text && !image) return
    const now = Date.now()
    if (now - lastMsgTime.current < 100) return
    lastMsgTime.current = now
    const sess = sessionRef.current
    if (!sess || !sess.encryptKey) return
    const time = Date.now()
    const key = sess.encryptKey

    if (image && typeof image === 'object' && (image as { bytes: Uint8Array; mime: string }).bytes) {
      const imgObj = image as { bytes: Uint8Array; mime: string; duration?: number }
      const bytes = imgObj.bytes instanceof Uint8Array ? imgObj.bytes : new Uint8Array(imgObj.bytes)
      const mime = imgObj.mime || 'application/octet-stream'
      const duration = imgObj.duration
      const localBlob = new Blob([bytes as unknown as BlobPart], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { text: text || '', image: localUrl, mime, duration, replyTo, from: 'You', time, self: true }])

      sess.imageSendQueue = sess.imageSendQueue
        .then(() => streamImageToHost(sess.conn, key, bytes, mime, text || '', replyTo ?? null, time, nickname, destroyedRef, duration))
        .catch(e => log.warn('useReceiver.imageSendQueue', e))
      return
    }

    const imgStr = image as string | undefined
    setMessages(prev => [...prev, { text, image: imgStr, replyTo, from: 'You', time, self: true }])
    try {
      const payload = JSON.stringify({ text, image: imgStr, replyTo })
      const encrypted = await encryptChunk(key, new TextEncoder().encode(payload))
      sess.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), nickname, time } satisfies PortalMsg)
    } catch (e) { console.warn('Failed to send chat message:', e) }
  }, [nickname])

  async function handleChunk(rawData: ArrayBuffer | ArrayBufferView, sess: Session): Promise<void> {
    const buffer = rawData instanceof ArrayBuffer ? rawData : ((rawData as ArrayBufferView).buffer as ArrayBuffer)
    const packet = parseChunkPacket(buffer)
    const { fileIndex, chunkIndex, data } = packet

    // Chat-image chunks need decrypt first (engine doesn't own image path).
    // Decrypt once here for chat-image and for zip/in-memory fallback paths.
    // For the StreamSaver path the engine decrypts internally via portalWire.
    const fileId = portalWire.fileIdForPacketIndex(fileIndex)
    if (fileIndex !== CHAT_IMAGE_FILE_INDEX && fileId && receiverRef.current?.has(fileId)) {
      // Engine-managed StreamSaver path: delegate raw packet (engine decrypts internally).
      // Per-file + overall progress are both emitted from the onProgress callback
      // wired in the file-start handler, in the same throttle window.
      lastFileIndexRef.current = fileIndex
      try {
        await receiverRef.current.onChunk(packet)
      } catch (e) {
        log.warn('useReceiver.handleChunk.engine', e)
      }
      return
    }

    // Non-engine paths: decrypt here (chat-image, zip, in-memory fallback).
    let plainData: ArrayBuffer | Uint8Array
    try {
      plainData = sess.encryptKey
        ? await decryptChunk(sess.encryptKey, data)
        : data
    } catch (decryptErr) {
      console.error('Chunk decryption failed for file', fileIndex, 'chunk', chunkIndex, decryptErr)
      if (chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = null
      const fileName = manifestRef.current?.files?.[fileIndex]?.name || `file ${fileIndex}`
      dispatchTransfer({ type: 'CANCEL_FILE', index: fileIndex, name: fileName })
      wasTransferringRef.current = false
      return
    }

    if (fileIndex === CHAT_IMAGE_FILE_INDEX) {
      const inFlight = sess.inProgressImage
      if (inFlight) {
        const bytes = plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData)
        if (inFlight.receivedBytes + bytes.byteLength > MAX_CHAT_IMAGE_SIZE) {
          sess.inProgressImage = null
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
    totalReceivedRef.current += (plainData as { byteLength: number }).byteLength
    const metaForBytes = fileMetaRef.current[fileIndex]
    if (metaForBytes) metaForBytes.received = (metaForBytes.received || 0) + (plainData as { byteLength: number }).byteLength

    try {
      const plainBytes = plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData)
      if (zipModeRef.current && zipWriterRef.current) {
        zipWriterRef.current.writeChunk(plainBytes)
      } else {
        if (!chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = []
        chunksRef.current[fileIndex]!.push(plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData))
      }
    } catch (e) {
      // Write failed (disk full, stream error) — skip chunk
      log.warn('useReceiver.handleChunk.write', e)
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
    const sess = sessionRef.current
    if (!sess || !manifestRef.current) return
    wasTransferringRef.current = true
    zipModeRef.current = false
    totalReceivedRef.current = 0
    startTimeRef.current = Date.now()
    transferTotalRef.current = manifestRef.current.files[index]?.size || 0
    dispatchConn({ type: 'SET_STATUS', payload: 'receiving' })
    dispatchTransfer({ type: 'SET', payload: { progress: {}, overallProgress: 0, speed: 0, eta: null } })
    try { sess.send({ type: 'request-file', index } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.requestFile', e) }
    dispatchTransfer({ type: 'ADD_PENDING', index })
  }, [])

  const requestAllAsZip = useCallback((): void => {
    const sess = sessionRef.current
    if (!sess || !manifestRef.current) return

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
    try { sess.send({ type: 'request-all', indices } satisfies PortalMsg) } catch (e) { log.warn('useReceiver.requestAllAsZip', e) }
    const pending: Record<number, boolean> = {}
    indices.forEach(i => { pending[i] = true })
    dispatchTransfer({ type: 'SET', payload: { pendingFiles: pending } })
  }, [transfer.completedFiles])

  const submitPassword = useCallback(async (password: string): Promise<void> => {
    const sess = sessionRef.current
    if (!sess || !sess.encryptKey) return
    dispatchConn({ type: 'SET', payload: { passwordError: false } })
    try {
      const encrypted = await encryptChunk(sess.encryptKey, new TextEncoder().encode(password))
      sess.send({ type: 'password-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)) } satisfies PortalMsg)
    } catch (e) { console.warn('Failed to submit password:', e) }
  }, [])

  const clearMessages = useCallback((): void => {
    setMessages([])
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch (e) { log.warn('useReceiver.clearMessages.revokeBlob', e) } })
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

// Module-level; parameterised by conn + key so it stays independent of
// Session. Callers schedule it onto `sess.imageSendQueue`.
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
    conn.send({ type: 'chat-image-start-enc', data: uint8ToBase64(new Uint8Array(encStart)), from: nickname, time } satisfies PortalMsg)
  } catch (e) { log.warn('streamImageToHost.start', e); return }

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
    } catch (e) { log.warn('streamImageToHost.encrypt', e); return }
    const packet = buildChunkPacket(CHAT_IMAGE_FILE_INDEX, chunkIndex, encChunk)
    try { conn.send(packet) } catch (e) { log.warn('streamImageToHost.sendPacket', e); return }
    try { await waitForBufferDrain(conn) } catch (e) { log.warn('streamImageToHost.drain', e); return }
    chunker.recordTransfer(slice.byteLength, Date.now() - tStart)
    offset += chunkSize
    chunkIndex++
  }

  try {
    const endPayload = JSON.stringify({})
    const encEnd = await encryptChunk(key, new TextEncoder().encode(endPayload))
    conn.send({ type: 'chat-image-end-enc', data: uint8ToBase64(new Uint8Array(encEnd)) } satisfies PortalMsg)
  } catch (e) {
    log.warn('streamImageToHost.end', e)
  }
}
