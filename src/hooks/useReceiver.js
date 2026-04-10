import Peer from 'peerjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import { parseChunkPacket, buildChunkPacket, waitForBufferDrain, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, decryptJSON, getKeyFingerprint, uint8ToBase64, base64ToUint8 } from '../utils/crypto'
import { createFileStream } from '../utils/streamWriter'
import { createStreamingZip } from '../utils/zipBuilder'
import { STUN_ONLY, WITH_TURN } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'

const ANIMALS = ['Fox', 'Wolf', 'Bear', 'Hawk', 'Lynx', 'Owl', 'Crow', 'Deer', 'Hare', 'Pike']
const ADJECTIVES = ['Swift', 'Bold', 'Calm', 'Keen', 'Wild', 'Wise', 'Dark', 'Bright']
function generateNickname() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${a}${b}${Math.floor(Math.random() * 10000)}`
}

const MAX_RETRIES = 2
const TIMEOUT_MS = 10000
const RECONNECT_DELAY = 2000
const MAX_RECONNECTS = 3

export function useReceiver(peerId) {
  const [manifest, setManifest] = useState(null)
  const [status, setStatus] = useState('connecting')
  const [progress, setProgress] = useState({})
  const [overallProgress, setOverallProgress] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [eta, setEta] = useState(null)
  const [pendingFiles, setPendingFiles] = useState({})
  const [completedFiles, setCompletedFiles] = useState({})
  const [retryCount, setRetryCount] = useState(0)
  const [useRelay, setUseRelay] = useState(false)
  const [zipMode, setZipMode] = useState(false)
  const [fingerprint, setFingerprint] = useState(null)
  const [passwordRequired, setPasswordRequired] = useState(false)
  const [passwordError, setPasswordError] = useState(false)
  const [messages, setMessages] = useState([])
  const [rtt, setRtt] = useState(null)
  const [nickname, setNickname] = useState(() => generateNickname())
  const [onlineCount, setOnlineCount] = useState(0)
  const [typingUsers, setTypingUsers] = useState([])
  const [pausedFiles, setPausedFiles] = useState({})
  const typingTimeouts = useRef({})
  const lastMsgTime = useRef(0)

  const streamsRef = useRef({})
  const chunksRef = useRef({}) // fallback only
  const zipWriterRef = useRef(null)
  const fileMetaRef = useRef({})
  const decryptKeyRef = useRef(null)
  const keyPairRef = useRef(null)
  const totalReceivedRef = useRef(0)
  const startTimeRef = useRef(null)
  const manifestRef = useRef(null)
  const connRef = useRef(null)
  const peerRef = useRef(null)
  const timeoutRef = useRef(null)
  const destroyedRef = useRef(false)
  const attemptRef = useRef(0)
  const zipModeRef = useRef(false)

  const transferTotalRef = useRef(0)
  const lastFileIndexRef = useRef(0)
  const lastChunkIndexRef = useRef(0)
  const wasTransferringRef = useRef(false)
  const reconnectCountRef = useRef(0)
  const useTurnRef = useRef(false)
  // Sequential chunk processing queue. Decrypt + stream-write must happen in
  // order, otherwise concurrent writes from multiple in-flight handleChunk
  // calls can interleave and corrupt the file.
  const chunkQueueRef = useRef(Promise.resolve())
  // Inline chat image being received from the host. One in flight at a time
  // per connection — the sender side serializes image transmission.
  const inProgressImageRef = useRef(null)
  // Serialize outgoing chat images so two GIFs from the user don't interleave
  // their chunks on the wire (we use fileIndex=0xFFFF as a sentinel, with no
  // imageId — so chunks always belong to the most recent open image).
  const imageSendQueueRef = useRef(Promise.resolve())
  // Blob URLs we created for incoming chat images — revoked on cleanup so
  // we don't leak memory across long sessions with lots of GIFs.
  const imageBlobUrlsRef = useRef([])

  const startConnection = useCallback((withTurn, isReconnect = false) => {
    if (!window.crypto?.subtle) { setStatus('error'); return }
    destroyedRef.current = false
    attemptRef.current = 0
    setRetryCount(0)
    if (!isReconnect) {
      setUseRelay(withTurn)
      useTurnRef.current = withTurn
    }

    function connect() {
      if (destroyedRef.current) return
      attemptRef.current++
      setRetryCount(attemptRef.current - 1)
      setStatus(isReconnect ? 'reconnecting' : attemptRef.current > 1 ? 'retrying' : 'connecting')

      const config = useTurnRef.current ? WITH_TURN : STUN_ONLY
      const peer = new Peer(config)
      peerRef.current = peer

      timeoutRef.current = setTimeout(() => {
        if (destroyedRef.current) return
        peer.destroy()
        if (attemptRef.current < MAX_RETRIES) connect()
        else if (isReconnect) setStatus('closed')
        else setStatus(withTurn ? 'closed' : 'direct-failed')
      }, TIMEOUT_MS)

      peer.on('open', () => {
        if (destroyedRef.current) return
        const conn = peer.connect(peerId, { reliable: true })
        connRef.current = conn

        conn.on('open', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current)
          reconnectCountRef.current = 0

          // Heartbeat + RTT (shared utilities)
          if (conn._rttPoller) conn._rttPoller.cleanup()
          conn._rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

          // Track whether disconnect was already handled (ICE or heartbeat)
          // to prevent duplicate messages when both fire for the same drop.
          let disconnectHandled = false
          function handleDisconnect(reason) {
            if (disconnectHandled || destroyedRef.current) return
            disconnectHandled = true
            if (conn._heartbeat) conn._heartbeat.cleanup()
            if (conn._rttPoller) { conn._rttPoller.cleanup(); conn._rttPoller = null }
            setRtt(null)
            setMessages(prev => [...prev, { text: reason, from: 'system', time: Date.now(), self: false }])

            if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
              // Initiate reconnect immediately instead of waiting for
              // conn.on('close') — PeerJS may never fire 'close' if ICE
              // stays in 'disconnected' limbo without reaching 'closed'.
              chunkQueueRef.current = Promise.resolve()
              imageSendQueueRef.current = Promise.resolve()
              inProgressImageRef.current = null
              Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
              streamsRef.current = {}
              reconnectCountRef.current++
              peer.destroy()
              setTimeout(() => { if (!destroyedRef.current) startConnection(useTurnRef.current, true) }, RECONNECT_DELAY)
            } else {
              Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
              setStatus('closed')
            }
          }

          const heartbeat = setupHeartbeat(conn, {
            onDead: () => handleDisconnect('Connection lost'),
          })
          conn._heartbeat = heartbeat

          // Fast disconnect detection via ICE state
          const pc = conn.peerConnection
          if (pc) {
            const prevHandler = pc.oniceconnectionstatechange
            pc.oniceconnectionstatechange = () => {
              if (prevHandler) prevHandler()
              const s = pc.iceConnectionState
              if (s === 'disconnected' || s === 'failed' || s === 'closed') {
                handleDisconnect('Sender disconnected')
              }
            }
          }

          if (isReconnect && wasTransferringRef.current) {
            setStatus('manifest-received')
            conn.send({ type: 'request-file', index: lastFileIndexRef.current, resumeChunk: lastChunkIndexRef.current })
            setPendingFiles(prev => ({ ...prev, [lastFileIndexRef.current]: true }))
          } else {
            setStatus('connected')
            // Timeout if manifest never arrives — but NOT if the portal is
            // password-protected (the manifest is intentionally withheld
            // until the password is accepted, which can take longer than 15s).
            const manifestTimeout = setTimeout(() => {
              if (!manifestRef.current && !destroyedRef.current && !passwordRequired) setStatus('closed')
            }, 15000)
            const origManifestHandler = (d) => {
              if (d.type === 'manifest' || d.type === 'password-required') clearTimeout(manifestTimeout)
            }
            conn.on('data', origManifestHandler)
          }
          conn.send({ type: 'join', nickname })
        })

        conn.on('data', async (data) => {
          if (destroyedRef.current) return
          // Any incoming traffic proves the sender is alive.
          if (conn._heartbeat) conn._heartbeat.markAlive()

          if (data instanceof ArrayBuffer || (data && data.byteLength !== undefined && !(typeof data === 'object' && data.type))) {
            // Chain onto the queue so chunks are decrypted + written strictly
            // in arrival order. PeerJS's EventEmitter does not await listeners,
            // so without this serialization concurrent handleChunk calls can
            // race and write chunks out of order, corrupting the file.
            chunkQueueRef.current = chunkQueueRef.current.then(() => handleChunk(data)).catch(() => {})
            return
          }

          // Heartbeat responses (already covered by _markAlive above, but
          // we still consume them so they don't fall through to other handlers)
          if (data.type === 'pong') return
          if (data.type === 'ping') {
            try { conn.send({ type: 'pong', ts: data.ts }) } catch {}
            return
          }

          // Key exchange: receive sender's public key, send ours back
          if (data.type === 'public-key') {
            try {
              if (!keyPairRef.current) {
                keyPairRef.current = await generateKeyPair()
              }
              const pubKeyBytes = await exportPublicKey(keyPairRef.current.publicKey)
              conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) })
              // importPublicKey + deriveSharedKey will throw if the remote
              // sends an invalid P-256 point, preventing weak/predictable
              // key derivation from crafted input.
              const remotePubKey = await importPublicKey(new Uint8Array(data.key))
              decryptKeyRef.current = await deriveSharedKey(keyPairRef.current.privateKey, remotePubKey)
              const fp = await getKeyFingerprint(pubKeyBytes, new Uint8Array(data.key))
              setFingerprint(fp)
            } catch {
              setStatus('error')
            }
            return
          }

          if (data.type === 'password-required') {
            setPasswordRequired(true)
            setStatus('password-required')
            return
          }

          if (data.type === 'password-accepted') {
            setPasswordRequired(false)
            setPasswordError(false)
            return
          }

          if (data.type === 'password-wrong') {
            setPasswordError(true)
            return
          }

          if (data.type === 'online-count') {
            setOnlineCount(data.count)
            return
          }

          if (data.type === 'typing') {
            handleTypingMessage(data.nickname, setTypingUsers, typingTimeouts.current)
            return
          }

          if (data.type === 'reaction') {
            setMessages(prev => prev.map(m => {
              if (`${m.time}` === data.msgId) {
                const reactions = { ...(m.reactions || {}) }
                if (!reactions[data.emoji]) reactions[data.emoji] = []
                if (!reactions[data.emoji].includes(data.nickname)) {
                  reactions[data.emoji] = [...reactions[data.emoji], data.nickname]
                }
                return { ...m, reactions }
              }
              return m
            }))
            return
          }

          if (data.type === 'system-msg') {
            setMessages(prev => [...prev, { text: data.text, from: 'system', time: data.time, self: false }])
            return
          }

          if (data.type === 'chat-encrypted') {
            let payload = {}
            if (decryptKeyRef.current && data.data) {
              try { payload = await decryptJSON(decryptKeyRef.current, data.data) }
              catch { return }
            }
            setMessages(prev => [...prev, { text: payload.text || '', image: payload.image, mime: payload.mime, replyTo: payload.replyTo, from: data.from || 'Sender', time: data.time, self: false }])
            return
          }

          // Inline chat image — START. The host has begun streaming an image
          // through the binary chunk pipeline. We allocate a buffer; chunks
          // arrive via handleChunk with fileIndex===CHAT_IMAGE_FILE_INDEX.
          if (data.type === 'chat-image-start-enc') {
            if (!decryptKeyRef.current || !data.data) return
            let meta
            try { meta = await decryptJSON(decryptKeyRef.current, data.data) }
            catch { return }
            // Discard any previous in-flight image (shouldn't happen in
            // practice — sender serializes — but be defensive against
            // a misbehaving / desynced peer).
            inProgressImageRef.current = {
              mime: meta.mime || 'application/octet-stream',
              size: meta.size || 0,
              text: meta.text || '',
              replyTo: meta.replyTo || null,
              time: meta.time || Date.now(),
              from: data.from || 'Sender',
              chunks: [],
              receivedBytes: 0,
            }
            return
          }

          // Inline chat image — END. Concat the buffered chunks, build a
          // blob URL, and append the message to the chat log.
          if (data.type === 'chat-image-end-enc') {
            // Drain any in-flight chunk processing first so all of this
            // image's bytes are in the buffer before we finalize.
            await chunkQueueRef.current
            const inFlight = inProgressImageRef.current
            inProgressImageRef.current = null
            if (!inFlight) return
            const blob = new Blob(inFlight.chunks, { type: inFlight.mime })
            const url = URL.createObjectURL(blob)
            imageBlobUrlsRef.current.push(url)
            setMessages(prev => [...prev, {
              text: inFlight.text,
              image: url,
              mime: inFlight.mime,
              replyTo: inFlight.replyTo,
              from: inFlight.from,
              time: inFlight.time,
              self: false,
            }])
            return
          }

          if (data.type === 'manifest') {
            setManifest(data)
            manifestRef.current = data
            setStatus(prev => (prev === 'receiving') ? prev : 'manifest-received')
          }

          if (data.type === 'file-cancelled') {
            if (streamsRef.current[data.index]) {
              streamsRef.current[data.index].abort()
              streamsRef.current[data.index] = null
            }
            setPendingFiles(prev => { const n = { ...prev }; delete n[data.index]; return n })
            wasTransferringRef.current = false
            setStatus('manifest-received')
            return
          }

          if (data.type === 'rejected') setStatus('rejected')

          if (data.type === 'file-start') {
            const resumeFrom = data.resumeFrom || 0
            // Track received bytes per file. We can't trust totalChunks for
            // progress because the sender uses adaptive chunk sizes (64KB–1MB)
            // while totalChunks is computed against the default 256KB size.
            // On resume, preserve the prior `received` count so progress
            // doesn't snap back to 0% when the connection drops mid-transfer.
            const prevMeta = fileMetaRef.current[data.index]
            const priorReceived = (resumeFrom > 0 && prevMeta) ? (prevMeta.received || 0) : 0
            fileMetaRef.current[data.index] = { name: data.name, size: data.size, totalChunks: data.totalChunks, received: priorReceived }
            lastFileIndexRef.current = data.index
            if (!startTimeRef.current) startTimeRef.current = Date.now()

            // Always create a fresh stream. On resume the old stream was
            // aborted in conn.on('close'), so we need a new one regardless.
            if (!zipModeRef.current || !zipWriterRef.current) {
              const stream = createFileStream(data.name, data.size)
              if (stream) {
                streamsRef.current[data.index] = stream
              } else {
                chunksRef.current[data.index] = []
              }
            } else if (resumeFrom === 0) {
              zipWriterRef.current.startFile(data.name, data.size)
            } else {
              // Zip mode resume — zip entries can't be reopened mid-stream,
              // so we fall back to memory for the resumed file.
              chunksRef.current[data.index] = []
            }
          }

          if (data.type === 'file-end') {
            const meta = fileMetaRef.current[data.index]
            if (!meta) return

            // Wait for any in-flight chunk writes to drain before closing
            // the stream — otherwise close() races the last few writes and
            // the saved file is truncated.
            await chunkQueueRef.current

            if (zipModeRef.current && zipWriterRef.current) {
              // End the current file in the streaming zip
              zipWriterRef.current.endFile()
            } else if (streamsRef.current[data.index]) {
              streamsRef.current[data.index].close()
              streamsRef.current[data.index] = null
            } else if (chunksRef.current[data.index]) {
              // Fallback: save blob
              const mimeType = manifestRef.current?.files?.[data.index]?.type || 'application/octet-stream'
              const blob = new Blob(chunksRef.current[data.index], { type: mimeType })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = meta.name
              a.click()
              URL.revokeObjectURL(url)
              chunksRef.current[data.index] = null
            }

            setProgress(prev => ({ ...prev, [meta.name]: 100 }))
            setCompletedFiles(prev => ({ ...prev, [data.index]: true }))
            setPendingFiles(prev => { const n = { ...prev }; delete n[data.index]; return n })
            wasTransferringRef.current = false

            // Single file download — set 100% and go back to ready
            if (!zipModeRef.current) {
              setOverallProgress(100)
              totalReceivedRef.current = transferTotalRef.current
              setStatus('manifest-received')
            }
          }

          if (data.type === 'done' || data.type === 'batch-done') {
            // Drain any in-flight chunk writes before finalizing the zip,
            // otherwise zip.end() runs while writes are still pending and
            // the resulting archive is truncated.
            await chunkQueueRef.current

            wasTransferringRef.current = false
            setPendingFiles({})
            setOverallProgress(100)
            setSpeed(0)
            setEta(null)
            setStatus('manifest-received')

            // Finalize the streaming zip
            if (zipModeRef.current && zipWriterRef.current) {
              zipWriterRef.current.finish()
              zipWriterRef.current = null
              zipModeRef.current = false
              setZipMode(false)
            }
          }
        })

        conn.on('close', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current)
          // If handleDisconnect already initiated a reconnect or close,
          // don't double-fire. Just clean up anything it might have missed.
          if (disconnectHandled) return
          if (conn._heartbeat) conn._heartbeat.cleanup()
          if (conn._rttPoller) { conn._rttPoller.cleanup(); conn._rttPoller = null }
          chunkQueueRef.current = Promise.resolve()
          imageSendQueueRef.current = Promise.resolve()
          inProgressImageRef.current = null
          if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
            Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
            streamsRef.current = {}
            reconnectCountRef.current++
            peer.destroy()
            setTimeout(() => { if (!destroyedRef.current) startConnection(useTurnRef.current, true) }, RECONNECT_DELAY)
            return
          }
          Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
          setRtt(null)
          setMessages(prev => [...prev, { text: 'Sender disconnected', from: 'system', time: Date.now(), self: false }])
          setStatus(prev => (prev === 'done' || prev === 'rejected') ? prev : 'closed')
        })

        conn.on('error', () => {
          if (destroyedRef.current) return
          clearTimeout(timeoutRef.current)
          peer.destroy()
          if (attemptRef.current < MAX_RETRIES) connect()
          else setStatus(withTurn ? 'error' : 'direct-failed')
        })
      })

      peer.on('error', (err) => {
        if (destroyedRef.current) return
        clearTimeout(timeoutRef.current)
        if (err.type === 'peer-unavailable') {
          peer.destroy()
          if (attemptRef.current < MAX_RETRIES) setTimeout(() => { if (!destroyedRef.current) connect() }, 2000)
          else setStatus('closed')
        } else {
          peer.destroy()
          if (attemptRef.current < MAX_RETRIES) connect()
          else setStatus(withTurn ? 'error' : 'direct-failed')
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
    startConnection(false)
    return () => {
      destroyedRef.current = true
      clearTimeout(timeoutRef.current)
      decryptKeyRef.current = null
      keyPairRef.current = null
      chunkQueueRef.current = Promise.resolve()
      imageSendQueueRef.current = Promise.resolve()
      inProgressImageRef.current = null
      // Revoke blob URLs we minted for chat images so they don't leak.
      imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
      imageBlobUrlsRef.current = []
      Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
      if (zipWriterRef.current) { zipWriterRef.current.abort(); zipWriterRef.current = null }
      if (peerRef.current) peerRef.current.destroy()
    }
  }, [peerId, startConnection])

  const enableRelay = useCallback(() => {
    destroyedRef.current = true
    clearTimeout(timeoutRef.current)
    // Clear any stalled queue from the failed direct attempt before
    // re-creating the peer with TURN.
    chunkQueueRef.current = Promise.resolve()
    if (peerRef.current) peerRef.current.destroy()
    useTurnRef.current = true
    setUseRelay(true)
    setTimeout(() => { startConnection(true) }, 500)
  }, [startConnection])

  const cancelFile = useCallback((index) => {
    const conn = connRef.current
    if (!conn) return
    conn.send({ type: 'cancel-file', index })
    if (streamsRef.current[index]) {
      streamsRef.current[index].abort()
      streamsRef.current[index] = null
    }
    if (chunksRef.current[index]) chunksRef.current[index] = null
    delete fileMetaRef.current[index]
    const name = manifestRef.current?.files[index]?.name
    if (name) setProgress(prev => { const n = { ...prev }; delete n[name]; return n })
    setPendingFiles(prev => { const n = { ...prev }; delete n[index]; return n })
    setPausedFiles(prev => { const n = { ...prev }; delete n[index]; return n })
    wasTransferringRef.current = false
    setStatus('manifest-received')
  }, [])

  const cancelAll = useCallback(() => {
    const conn = connRef.current
    if (conn) try { conn.send({ type: 'cancel-all' }) } catch {}
    if (zipWriterRef.current) {
      zipWriterRef.current.abort()
      zipWriterRef.current = null
      zipModeRef.current = false
      setZipMode(false)
    }
    Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
    streamsRef.current = {}
    fileMetaRef.current = {}
    setPendingFiles({})
    setPausedFiles({})
    setProgress({})
    setOverallProgress(0)
    setSpeed(0)
    setEta(null)
    wasTransferringRef.current = false
    setStatus('manifest-received')
  }, [])

  const pauseFile = useCallback((index) => {
    const conn = connRef.current
    if (!conn) return
    conn.send({ type: 'pause-file', index })
    setPausedFiles(prev => ({ ...prev, [index]: true }))
  }, [])

  const resumeFile = useCallback((index) => {
    const conn = connRef.current
    if (!conn) return
    conn.send({ type: 'resume-file', index })
    setPausedFiles(prev => { const n = { ...prev }; delete n[index]; return n })
  }, [])

  const sendTyping = useCallback(() => {
    const conn = connRef.current
    if (conn) try { conn.send({ type: 'typing', nickname }) } catch {}
  }, [nickname])

  const sendReaction = useCallback((msgId, emoji) => {
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

  const changeNickname = useCallback((newName) => {
    const conn = connRef.current
    if (!conn || !newName.trim()) return
    const oldName = nickname
    setNickname(newName.trim())
    try { conn.send({ type: 'nickname-change', oldName, newName: newName.trim() }) } catch {}
  }, [nickname])

  const sendMessage = useCallback(async (text, image, replyTo) => {
    if (!text && !image) return
    const now = Date.now()
    if (now - lastMsgTime.current < 100) return
    lastMsgTime.current = now
    const conn = connRef.current
    if (!conn || !decryptKeyRef.current) return
    const time = Date.now()
    const key = decryptKeyRef.current

    // Binary image: { bytes: Uint8Array, mime: string } — stream via the
    // chunk pipeline (binary-native, backpressure-aware). Local echo uses a
    // blob URL built from the same bytes so the user sees their image
    // instantly without waiting for any round-trip.
    if (image && typeof image === 'object' && image.bytes) {
      const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes)
      const mime = image.mime || 'application/octet-stream'
      const localBlob = new Blob([bytes], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { text: text || '', image: localUrl, mime, replyTo, from: 'You', time, self: true }])

      // Serialize image sends to this connection — fileIndex=0xFFFF has no
      // imageId, so chunks always belong to the most recent open image.
      imageSendQueueRef.current = imageSendQueueRef.current
        .then(() => streamImageToHost(conn, key, bytes, mime, text || '', replyTo, time))
        .catch(() => {})
      return
    }

    // Text-only (or legacy data-URI image) — go through the existing
    // chat-encrypted path.
    setMessages(prev => [...prev, { text, image, replyTo, from: 'You', time, self: true }])
    try {
      const payload = JSON.stringify({ text, image, replyTo })
      const encrypted = await encryptChunk(key, new TextEncoder().encode(payload))
      conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), nickname, time })
    } catch {}
  }, [nickname])

  // Stream a chat image to the host: announce, ship encrypted chunks via the
  // existing buildChunkPacket pipeline (with CHAT_IMAGE_FILE_INDEX as the
  // sentinel), then end. The host will receive this, buffer it, and relay
  // to other recipients with their own per-recipient encryption.
  async function streamImageToHost(conn, key, bytes, mime, text, replyTo, time) {
    if (!conn || conn.open === false || !key) return
    // 1. Announce the image with encrypted metadata.
    try {
      const startPayload = JSON.stringify({ mime, size: bytes.byteLength, text, replyTo, time })
      const encStart = await encryptChunk(key, new TextEncoder().encode(startPayload))
      conn.send({ type: 'chat-image-start-enc', data: uint8ToBase64(new Uint8Array(encStart)), from: nickname, time })
    } catch { return }

    // 2. Stream the body. Each chunk is encrypted independently — the
    // receiver's chunk queue will decrypt + buffer them in order.
    const chunker = new AdaptiveChunker()
    let offset = 0
    let chunkIndex = 0
    while (offset < bytes.byteLength) {
      if (destroyedRef.current || conn.open === false) return
      const chunkSize = Math.min(chunker.getChunkSize(), bytes.byteLength - offset)
      const slice = bytes.subarray(offset, offset + chunkSize)
      const tStart = Date.now()
      let encChunk
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

    // 3. End marker — encrypted but currently empty payload, mirroring
    // the start frame's shape so we can extend it later if needed.
    try {
      const endPayload = JSON.stringify({})
      const encEnd = await encryptChunk(key, new TextEncoder().encode(endPayload))
      conn.send({ type: 'chat-image-end-enc', data: uint8ToBase64(new Uint8Array(encEnd)) })
    } catch { /* swallow — receiver will time out the in-flight image */ }
  }

  const submitPassword = useCallback(async (password) => {
    const conn = connRef.current
    if (!conn || !decryptKeyRef.current) return
    setPasswordError(false)
    try {
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(password))
      conn.send({ type: 'password-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)) })
    } catch {}
  }, [])

  // Download a single file — streams directly to disk
  const requestFile = useCallback((index) => {
    const conn = connRef.current
    if (!conn || !manifestRef.current) return
    wasTransferringRef.current = true
    zipModeRef.current = false
    totalReceivedRef.current = 0
    startTimeRef.current = Date.now()
    transferTotalRef.current = manifestRef.current.files[index]?.size || 0
    setStatus('receiving')
    setProgress({}); setOverallProgress(0); setSpeed(0); setEta(null)
    conn.send({ type: 'request-file', index })
    setPendingFiles(prev => ({ ...prev, [index]: true }))
  }, [])

  // Download all as streaming zip — pipes directly to disk, zero RAM
  const requestAllAsZip = useCallback(() => {
    const conn = connRef.current
    if (!conn || !manifestRef.current) return

    const zipWriter = createStreamingZip('manifest-files.zip')
    if (!zipWriter) return

    zipWriterRef.current = zipWriter
    wasTransferringRef.current = true
    zipModeRef.current = true
    setZipMode(true)
    setStatus('receiving')
    totalReceivedRef.current = 0
    startTimeRef.current = Date.now()
    const indices = manifestRef.current.files.map((_, i) => i).filter(i => !completedFiles[i])
    transferTotalRef.current = indices.reduce((sum, i) => sum + (manifestRef.current.files[i]?.size || 0), 0)
    setProgress({}); setOverallProgress(0); setSpeed(0); setEta(null)
    conn.send({ type: 'request-all', indices })
    const pending = {}
    indices.forEach(i => { pending[i] = true })
    setPendingFiles(pending)
  }, [completedFiles])

  let lastChunkUIUpdate = 0

  async function handleChunk(rawData) {
    const buffer = rawData instanceof ArrayBuffer ? rawData : rawData.buffer || new Uint8Array(rawData).buffer
    const { fileIndex, chunkIndex, data } = parseChunkPacket(buffer)

    // Decrypt if we have a key
    let plainData
    try {
      plainData = decryptKeyRef.current
        ? await decryptChunk(decryptKeyRef.current, data)
        : data
    } catch {
      // Corrupted chunk — drop it. SCTP guarantees reliable+ordered delivery
      // so we should never see this in practice; if we do, the file will end
      // up incomplete and the user can re-request it.
      return
    }

    // Inline chat image chunk — append to the in-flight image buffer.
    if (fileIndex === CHAT_IMAGE_FILE_INDEX) {
      const inFlight = inProgressImageRef.current
      if (inFlight) {
        const bytes = plainData instanceof Uint8Array ? plainData : new Uint8Array(plainData)
        inFlight.chunks.push(bytes)
        inFlight.receivedBytes += bytes.byteLength
      }
      return
    }

    // Reject chunk indices outside the manifest range — a crafted
    // fileIndex could write to arbitrary streamsRef/chunksRef slots.
    const manifestFiles = manifestRef.current?.files
    if (!manifestFiles || fileIndex >= manifestFiles.length) return

    lastFileIndexRef.current = fileIndex
    lastChunkIndexRef.current = chunkIndex + 1
    totalReceivedRef.current += plainData.byteLength
    // Track per-file bytes so progress is correct under adaptive chunk sizes.
    const metaForBytes = fileMetaRef.current[fileIndex]
    if (metaForBytes) metaForBytes.received = (metaForBytes.received || 0) + plainData.byteLength

    // Write to zip stream, file stream, or memory fallback
    try {
      if (zipModeRef.current && zipWriterRef.current) {
        zipWriterRef.current.writeChunk(plainData)
      } else if (streamsRef.current[fileIndex]) {
        await streamsRef.current[fileIndex].write(plainData)
      } else {
        if (!chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = []
        chunksRef.current[fileIndex][chunkIndex] = plainData
      }
    } catch {
      // Write failed (disk full, stream error) — skip chunk
    }

    const now = Date.now()
    if (now - lastChunkUIUpdate >= 100) {
      lastChunkUIUpdate = now
      const meta = fileMetaRef.current[fileIndex]
      if (meta && meta.size > 0) {
        // Use byte-based progress, not chunk-based — adaptive chunking makes
        // chunkIndex/totalChunks unreliable.
        const pct = Math.min(100, Math.round((meta.received / meta.size) * 100))
        setProgress(prev => ({ ...prev, [meta.name]: pct }))
      }
      const totalSize = transferTotalRef.current || manifestRef.current?.totalSize || 0
      if (totalSize > 0) {
        setOverallProgress(Math.min(100, Math.round((totalReceivedRef.current / totalSize) * 100)))
        const elapsed = (now - startTimeRef.current) / 1000
        if (elapsed > 0.5) {
          const currentSpeed = totalReceivedRef.current / elapsed
          setSpeed(currentSpeed)
          setEta(Math.max(0, (totalSize - totalReceivedRef.current) / currentSpeed))
        }
      }
    }
  }

  return {
    manifest, status, progress, overallProgress, speed, eta,
    pendingFiles, completedFiles, requestFile, requestAllAsZip,
    retryCount, useRelay, enableRelay, zipMode, fingerprint,
    passwordRequired, passwordError, submitPassword,
    messages, sendMessage, rtt, nickname, changeNickname, onlineCount,
    typingUsers, sendTyping, sendReaction, cancelFile, cancelAll, pauseFile, resumeFile, pausedFiles,
  }
}
