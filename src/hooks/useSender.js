import Peer from 'peerjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import { chunkFileAdaptive, buildChunkPacket, parseChunkPacket, waitForBufferDrain, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, decryptJSON, encryptJSON, getKeyFingerprint, uint8ToBase64, base64ToUint8 } from '../utils/crypto'
import { STUN_ONLY } from '../utils/iceServers'
import { setupHeartbeat, setupRTTPolling, handleTypingMessage } from '../utils/connectionHelpers'
import { generateThumbnailAsync, generateVideoThumbnail, generateTextPreview, generateThumbnailsBatch } from '../utils/thumbnailWorker'

async function buildManifestData(files, chatOnly) {
  // Generate thumbnails in batch using web worker (non-blocking)
  const thumbnails = await generateThumbnailsBatch(files, 80, 3)
  
  const fileEntries = await Promise.all(files.map(async (f, i) => {
    const entry = { name: f.name, size: f.size, type: f.type }
    
    // Add image thumbnail
    if (thumbnails[i]) {
      entry.thumbnail = thumbnails[i]
    }
    // Add video thumbnail
    else if (f.type?.startsWith('video/') && f instanceof File) {
      try { entry.thumbnail = await generateVideoThumbnail(f, 80) } catch {}
    }
    // Add text preview
    else if (f.type?.startsWith('text/') || f.type === 'application/json') {
      try { entry.textPreview = await generateTextPreview(f, 150) } catch {}
    }
    
    return entry
  }))
  
  return {
    type: 'manifest',
    chatOnly,
    files: fileEntries,
    totalSize: files.reduce((sum, f) => sum + f.size, 0),
    sentAt: new Date().toISOString(),
  }
}

export function useSender() {
  const [peerId, setPeerId] = useState(null)
  const [status, setStatus] = useState('initializing')
  const [progress, setProgress] = useState({})
  const [overallProgress, setOverallProgress] = useState(0)
  const [speed, setSpeed] = useState(0)
  const [eta, setEta] = useState(null)
  const [currentFileIndex, setCurrentFileIndex] = useState(-1)
  const [totalSent, setTotalSent] = useState(0)
  const [sessionKey, setSessionKey] = useState(0)
  const [fingerprint, setFingerprint] = useState(null)
  const [recipientCount, setRecipientCount] = useState(0)
  const [messages, setMessages] = useState([])
  const [rtt, setRtt] = useState(null)
  const [senderName, setSenderName] = useState('Host')
  const [typingUsers, setTypingUsers] = useState([])
  const typingTimeouts = useRef({})
  const lastMsgTime = useRef(0)
  const peerRef = useRef(null)
  const filesRef = useRef([])
  const connectionsRef = useRef(new Map())
  const passwordRef = useRef(null)
  const chatOnlyRef = useRef(false)
  // Blob URLs minted for chat images (local echo + relayed images) so we
  // can revoke them on session reset and avoid leaking memory.
  const imageBlobUrlsRef = useRef([])

  const setFiles = useCallback((files) => {
    filesRef.current = files
  }, [])

  const setPassword = useCallback((pwd) => {
    passwordRef.current = pwd || null
  }, [])

  const setChatOnly = useCallback((val) => {
    chatOnlyRef.current = val
  }, [])

  useEffect(() => {
    if (!window.crypto?.subtle) { setStatus('error'); return }
    let destroyed = false
    const peer = new Peer(STUN_ONLY)
    peerRef.current = peer

    peer.on('open', (id) => {
      if (destroyed) return
      setPeerId(id)
      setStatus('waiting')
    })

    peer.on('connection', (conn) => {
      if (destroyed) return

      const connId = conn.peer + '-' + Date.now()
      const connState = {
        conn, encryptKey: null, keyPair: null, abort: { aborted: false },
        progress: {}, totalSent: 0, startTime: null, transferTotalSize: 0,
        speed: 0, currentFileIndex: -1, transferring: false,
        // Inline chat image bookkeeping (per-connection):
        // - inProgressImage: image being received from this recipient
        // - chunkQueue: serial decrypt+buffer queue for incoming binary
        //   chunks (mirrors the receiver's chunkQueueRef)
        // - imageSendQueue: serializes outgoing image streams to this
        //   connection so two images don't interleave their chunks on
        //   the wire (we use fileIndex=0xFFFF without an imageId)
        inProgressImage: null,
        chunkQueue: Promise.resolve(),
        imageSendQueue: Promise.resolve(),
      }
      connectionsRef.current.set(connId, connState)
      // Don't update recipientCount here — defer until the user is
      // authenticated (announceJoin). For password-protected portals
      // we don't want unauthenticated connections to appear in the UI.

      function announceJoin(cs, cId) {
        setStatus('connected')
        setRecipientCount(connectionsRef.current.size)
        setMessages(prev => [...prev, { text: `${cs.nickname} joined`, from: 'system', time: Date.now(), self: false }])
        const count = connectionsRef.current.size + 1
        connectionsRef.current.forEach((other, id) => {
          try { other.conn.send({ type: 'online-count', count }) } catch {}
          if (id !== cId) {
            try { other.conn.send({ type: 'system-msg', text: `${cs.nickname} joined`, time: Date.now() }) } catch {}
          }
        })
      }

      function aggregateUI() {
        const conns = Array.from(connectionsRef.current.values())
        const active = conns.filter(cs => cs.transferring)

        // Only merge progress from currently active transfers
        const merged = {}
        for (const cs of active) {
          for (const [name, pct] of Object.entries(cs.progress || {})) {
            // Multiple recipients downloading same file: show the one furthest behind
            if (merged[name] === undefined) merged[name] = pct
            else merged[name] = Math.min(merged[name], pct)
          }
        }
        setProgress(merged)

        const activeWithFile = active.find(cs => cs.currentFileIndex >= 0)
        setCurrentFileIndex(activeWithFile ? activeWithFile.currentFileIndex : -1)

        if (active.length === 0) {
          setTotalSent(0); setOverallProgress(0); setSpeed(0); setEta(null)
          return
        }

        const sent = active.reduce((s, cs) => s + cs.totalSent, 0)
        const total = active.reduce((s, cs) => s + cs.transferTotalSize, 0)
        const spd = active.reduce((s, cs) => s + cs.speed, 0)
        setTotalSent(sent)
        setOverallProgress(total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0)
        setSpeed(spd)
        setEta(spd > 0 ? Math.max(0, (total - sent) / spd) : null)
      }

      async function sendManifest(c) {
        const manifest = await buildManifestData(filesRef.current, chatOnlyRef.current)
        c.send(manifest)
      }

      conn.on('open', async () => {
        if (destroyed) return
        // Only show 'connected' immediately for non-password portals.
        // For password-protected portals, defer until announceJoin (after
        // authentication) so the UI doesn't flash "connected" for users
        // who haven't entered the password yet.
        if (!passwordRef.current) setStatus('connected')

        // RTT polling (one poller per connection — the first active one sets the UI)
        connState.rttPoller = setupRTTPolling(conn.peerConnection, setRtt)

        // Heartbeat — per-connection zombie detection
        connState.heartbeat = setupHeartbeat(conn, {
          onDead: () => {
            connState.abort.aborted = true
            const name = connState.nickname || 'A recipient'
            connectionsRef.current.delete(connId)
            setRecipientCount(connectionsRef.current.size)
            setMessages(prev => [...prev, { text: `${name} connection lost`, from: 'system', time: Date.now(), self: false }])
            const newCount = connectionsRef.current.size + 1
            connectionsRef.current.forEach(cs => {
              try { cs.conn.send({ type: 'online-count', count: newCount }) } catch {}
            })
            if (connectionsRef.current.size === 0) {
              setRtt(null)
              setStatus(prev => prev === 'done' ? prev : 'waiting')
            }
          },
        })

        // Fast disconnect detection via ICE state
        const pc = conn.peerConnection
        if (pc) {
          pc.oniceconnectionstatechange = () => {
            const s = pc.iceConnectionState
            if ((s === 'disconnected' || s === 'failed' || s === 'closed') && !destroyed) {
              connState.abort.aborted = true
              const name = connState.nickname || 'A recipient'
              connectionsRef.current.delete(connId)
              setRecipientCount(connectionsRef.current.size)
              setMessages(prev => [...prev, { text: `${name} left`, from: 'system', time: Date.now(), self: false }])
              const count = connectionsRef.current.size + 1
              connectionsRef.current.forEach(cs => {
                try {
                  cs.conn.send({ type: 'online-count', count })
                  cs.conn.send({ type: 'system-msg', text: `${name} left`, time: Date.now() })
                } catch {}
              })
              if (connectionsRef.current.size === 0) {
  
                setRtt(null)
                setStatus(prev => prev === 'done' ? prev : 'waiting')
              }
            }
          }
        }

        connState.keyPair = await generateKeyPair()
        const pubKeyBytes = await exportPublicKey(connState.keyPair.publicKey)
        conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) })
      })

      conn.on('data', async (data) => {
        if (destroyed) return
        // Any incoming traffic from this connection is proof it's alive.
        if (connState.heartbeat) connState.heartbeat.markAlive()

        // Binary chunk packet — currently only chat-image chunks (the host
        // doesn't accept arbitrary file uploads from recipients). Dispatch
        // through this connection's serial queue so chunks land in arrival
        // order, mirroring the receiver's chunkQueueRef pattern.
        if (data instanceof ArrayBuffer || (data && data.byteLength !== undefined && !(typeof data === 'object' && data.type))) {
          connState.chunkQueue = connState.chunkQueue
            .then(() => handleHostChunk(connState, data))
            .catch(() => {})
          return
        }

        // Heartbeat responses (already covered by lastSeen above)
        if (data.type === 'pong') return
        if (data.type === 'ping') {
          try { conn.send({ type: 'pong', ts: data.ts }) } catch {}
          return
        }

        if (data.type === 'public-key') {
          try {
            // importPublicKey + deriveSharedKey will throw if the remote
            // sends an invalid P-256 point, preventing weak/predictable
            // key derivation from crafted input.
            const remotePubKey = await importPublicKey(new Uint8Array(data.key))
            connState.encryptKey = await deriveSharedKey(connState.keyPair.privateKey, remotePubKey)
            const localPubBytes = await exportPublicKey(connState.keyPair.publicKey)
            const fp = await getKeyFingerprint(localPubBytes, new Uint8Array(data.key))
            setFingerprint(fp)

            if (passwordRef.current) {
              conn.send({ type: 'password-required' })
            } else {
              await sendManifest(conn)
            }
          } catch {
            conn.close()
          }
          return
        }

        if (data.type === 'password-encrypted') {
          let password = ''
          if (connState.encryptKey && data.data) {
            try {
              const decrypted = await decryptChunk(connState.encryptKey, base64ToUint8(data.data))
              password = new TextDecoder().decode(decrypted)
            } catch { conn.send({ type: 'password-wrong' }); return }
          }
          // Constant-time comparison: encode both strings and compare
          // byte-by-byte with XOR so timing doesn't leak password
          // length or prefix matches.
          const a = new TextEncoder().encode(password)
          const b = new TextEncoder().encode(passwordRef.current || '')
          let match = a.length === b.length ? 0 : 1
          for (let i = 0; i < a.length; i++) match |= a[i] ^ (b[i] || 0)
          if (match === 0 && a.length > 0) {
            conn.send({ type: 'password-accepted' })
            // Now that the user is authenticated, announce their join
            // (deferred from the earlier 'join' handler).
            if (connState.pendingJoinAnnounce) {
              connState.pendingJoinAnnounce = false
              announceJoin(connState, connId)
            }
            await sendManifest(conn)
          } else {
            conn.send({ type: 'password-wrong' })
          }
          return
        }

        if (data.type === 'typing') {
          handleTypingMessage(data.nickname, setTypingUsers, typingTimeouts.current)
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) { try { cs.conn.send({ type: 'typing', nickname: data.nickname }) } catch {} }
          })
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
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) { try { cs.conn.send(data) } catch {} }
          })
          return
        }

        if (data.type === 'chat-encrypted') {
          let payload = {}
          if (connState.encryptKey && data.data) {
            try { payload = await decryptJSON(connState.encryptKey, data.data) }
            catch { return }
          }
          const msg = { text: payload.text || '', image: payload.image, mime: payload.mime, replyTo: payload.replyTo, from: data.nickname || 'Anon', time: data.time, self: false }
          setMessages(prev => [...prev, msg])
          const relayPayload = JSON.stringify(payload)
          for (const [id, cs] of connectionsRef.current) {
            if (id !== connId && cs.encryptKey) {
              try {
                const encrypted = await encryptChunk(cs.encryptKey, new TextEncoder().encode(relayPayload))
                cs.conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: data.nickname || 'Anon', time: data.time })
              } catch {}
            }
          }
          return
        }

        // Inline chat image — START. The recipient is about to stream us
        // an image via the binary chunk pipeline. Open a buffer on this
        // connection's state; chunks will arrive via the binary handler
        // and append to it.
        if (data.type === 'chat-image-start-enc') {
          if (!connState.encryptKey || !data.data) return
          let meta
          try { meta = await decryptJSON(connState.encryptKey, data.data) }
          catch { return }
          connState.inProgressImage = {
            mime: meta.mime || 'application/octet-stream',
            size: meta.size || 0,
            text: meta.text || '',
            replyTo: meta.replyTo || null,
            time: meta.time || Date.now(),
            from: data.from || connState.nickname || 'Anon',
            chunks: [],
            receivedBytes: 0,
          }
          return
        }

        // Inline chat image — END. Drain any in-flight chunks for this
        // connection, then finalize: render locally, and re-broadcast the
        // plaintext bytes to every other recipient with their own
        // per-recipient encryption.
        if (data.type === 'chat-image-end-enc') {
          await connState.chunkQueue
          const inFlight = connState.inProgressImage
          connState.inProgressImage = null
          if (!inFlight) return

          // Concat into a single Uint8Array for the local blob URL and
          // for re-broadcasting. (5MB cap from ChatPanel — fine to keep
          // in memory.)
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
            replyTo: inFlight.replyTo,
            from: inFlight.from,
            time: inFlight.time,
            self: false,
          }])

          // Re-broadcast to every other connected recipient. Each gets
          // their own per-recipient encryption. Parallel, but serialized
          // per destination via cs.imageSendQueue.
          for (const [otherId, otherCs] of connectionsRef.current) {
            if (otherId === connId || !otherCs.encryptKey) continue
            otherCs.imageSendQueue = otherCs.imageSendQueue
              .then(() => streamImageToConn(
                otherCs.conn, otherCs.encryptKey, fullBytes,
                inFlight.mime, inFlight.text, inFlight.replyTo,
                inFlight.from, inFlight.time
              ))
              .catch(() => {})
          }
          return
        }

        if (data.type === 'join') {
          connState.nickname = data.nickname
          // Evict any older connection with the same nickname that hasn't
          // been seen recently — almost always the same user reconnecting
          // after a relay drop. Otherwise stale entries accumulate in
          // connectionsRef and inflate the online count broadcast.
          const now = Date.now()
          for (const [otherId, otherCs] of connectionsRef.current) {
            if (otherId === connId) continue
            if (otherCs.nickname !== data.nickname) continue
            const lastSeen = otherCs.heartbeat ? otherCs.heartbeat.getLastSeen() : 0
            if (now - lastSeen < 10000) continue
            otherCs.abort.aborted = true
            if (otherCs.heartbeat) otherCs.heartbeat.cleanup()
            if (otherCs.rttPoller) otherCs.rttPoller.cleanup()
            try { otherCs.conn.close() } catch {}
            connectionsRef.current.delete(otherId)
          }

          // If the portal is password-protected, defer the "joined"
          // announcement until after the password is accepted — otherwise
          // the sender sees "joined" + "connected" for an unauthenticated
          // user who may never get in.
          if (passwordRef.current) {
            connState.pendingJoinAnnounce = true
          } else {
            announceJoin(connState, connId)
          }
          return
        }

        if (data.type === 'nickname-change') {
          const oldName = connState.nickname || data.oldName
          connState.nickname = data.newName
          const msg = `${oldName} is now ${data.newName}`
          setMessages(prev => [...prev, { text: msg, from: 'system', time: Date.now(), self: false }])
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) {
              try { cs.conn.send({ type: 'system-msg', text: msg, time: Date.now() }) } catch {}
            }
          })
          return
        }

        if (data.type === 'cancel-all') {
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
          if (!anyActive) setStatus('connected')
          return
        }

        if (data.type === 'cancel-file') {
          if (!connState.cancelledFiles) connState.cancelledFiles = new Set()
          connState.cancelledFiles.add(data.index)
          connState.pausedFiles?.delete(data.index)
          if (connState.pauseResolvers?.[data.index]) {
            connState.pauseResolvers[data.index]()
          }
          return
        }

        if (data.type === 'pause-file') {
          if (!connState.pausedFiles) connState.pausedFiles = new Set()
          connState.pausedFiles.add(data.index)
          return
        }

        if (data.type === 'resume-file') {
          connState.pausedFiles?.delete(data.index)
          if (connState.pauseResolvers?.[data.index]) {
            connState.pauseResolvers[data.index]()
          }
          return
        }

        function startTransfer(transferSize) {
          connState.abort = { aborted: false }
          connState.totalSent = 0
          connState.startTime = Date.now()
          connState.progress = {}
          connState.speed = 0
          connState.transferTotalSize = transferSize
          connState.transferring = true
          setStatus('transferring')
        }

        function endTransfer() {
          connState.transferring = false
          connState.currentFileIndex = -1
          aggregateUI()
          const anyActive = Array.from(connectionsRef.current.values()).some(cs => cs.transferring)
          if (!anyActive) setStatus('connected')
        }

        if (data.type === 'request-file') {
          const file = filesRef.current[data.index]
          if (!file) return
          const totalChunks = Math.ceil(file.size / CHUNK_SIZE)
          const resumeChunk = Math.min(Math.max(0, data.resumeChunk || 0), totalChunks)
          startTransfer(file.size)
          await sendSingleFile(conn, filesRef.current, data.index, resumeChunk, connState, connState.encryptKey, aggregateUI)
          if (!connState.abort.aborted) endTransfer()
        }

        if (data.type === 'request-all') {
          const indices = data.indices || filesRef.current.map((_, i) => i)
          const transferSize = indices.reduce((sum, i) => sum + (filesRef.current[i]?.size || 0), 0)
          startTransfer(transferSize)
          for (const idx of indices) {
            if (connState.abort.aborted) break
            try { await sendSingleFile(conn, filesRef.current, idx, 0, connState, connState.encryptKey, aggregateUI) } catch { /* skip failed file, continue batch */ }
          }
          if (!connState.abort.aborted) {
            conn.send({ type: 'batch-done' })
            endTransfer()
          }
        }

        if (data.type === 'ready') {
          const transferSize = filesRef.current.reduce((sum, f) => sum + f.size, 0)
          startTransfer(transferSize)
          for (let i = 0; i < filesRef.current.length; i++) {
            if (connState.abort.aborted) break
            try { await sendSingleFile(conn, filesRef.current, i, 0, connState, connState.encryptKey, aggregateUI) } catch { /* skip failed file */ }
          }
          if (!connState.abort.aborted) {
            conn.send({ type: 'done' })
            connState.transferring = false
            setStatus('done')
          }
        }

        if (data.type === 'resume') {
          const transferSize = filesRef.current[data.fileIndex]?.size || 0
          startTransfer(transferSize)
          await sendSingleFile(conn, filesRef.current, data.fileIndex, data.chunkIndex, connState, connState.encryptKey, aggregateUI)
          if (!connState.abort.aborted) endTransfer()
        }
      })

      conn.on('close', () => {
        if (destroyed) return
        connState.abort.aborted = true
        // Clean up heartbeat intervals
        if (connState.heartbeat) connState.heartbeat.cleanup()
        if (connState.rttPoller) connState.rttPoller.cleanup()
        const name = connState.nickname || 'A recipient'
        if (name && typingTimeouts.current[name]) {
          clearTimeout(typingTimeouts.current[name])
          delete typingTimeouts.current[name]
        }
        setTypingUsers(prev => prev.filter(n => n !== name))
        connectionsRef.current.delete(connId)
        setRecipientCount(connectionsRef.current.size)
        setMessages(prev => [...prev, { text: `${name} left`, from: 'system', time: Date.now(), self: false }])
        // Notify other receivers + update online count
        const count = connectionsRef.current.size + 1
        connectionsRef.current.forEach(cs => {
          try {
            cs.conn.send({ type: 'online-count', count })
            cs.conn.send({ type: 'system-msg', text: `${name} left`, time: Date.now() })
          } catch {}
        })
        if (connectionsRef.current.size === 0) {
          setRtt(null)
          setStatus(prev => prev === 'done' ? prev : 'waiting')
        }
      })
      conn.on('error', () => {
        if (destroyed) return
        connState.abort.aborted = true
        connectionsRef.current.delete(connId)
        setRecipientCount(connectionsRef.current.size)
      })
    })

    peer.on('disconnected', () => {
      if (destroyed) return
      if (!peer.destroyed) peer.reconnect()
    })

    peer.on('error', (err) => {
      if (destroyed) return
      if (err.type === 'unavailable-id') {
        peer.destroy()
      } else if (err.type === 'disconnected' || err.type === 'network') {
        return
      }
      setStatus('error')
    })

    function handleVisibility() {
      if (document.visibilityState === 'visible' && !destroyed && peer.disconnected && !peer.destroyed) {
        peer.reconnect()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibility)
      destroyed = true
      // Per-connection cleanup (heartbeat, RTT poller) happens via
      // conn.on('close') when peer.destroy() fires below.
      connectionsRef.current.forEach(cs => { cs.abort.aborted = true })
      connectionsRef.current.clear()
      peer.destroy()
    }
  }, [sessionKey])

  const sendMessage = useCallback(async (text, image, replyTo) => {
    if (!text && !image) return
    const now = Date.now()
    if (now - lastMsgTime.current < 100) return
    lastMsgTime.current = now
    const time = Date.now()

    // Binary image: { bytes: Uint8Array, mime: string } — stream through
    // the chunk pipeline. Local echo uses a blob URL so the sender sees
    // the image instantly without any round-trip.
    if (image && typeof image === 'object' && image.bytes) {
      const bytes = image.bytes instanceof Uint8Array ? image.bytes : new Uint8Array(image.bytes)
      const mime = image.mime || 'application/octet-stream'
      const localBlob = new Blob([bytes], { type: mime })
      const localUrl = URL.createObjectURL(localBlob)
      imageBlobUrlsRef.current.push(localUrl)
      setMessages(prev => [...prev, { text: text || '', image: localUrl, mime, replyTo, from: 'You', time, self: true }])

      // Fan out to each connected recipient in parallel, but serialized
      // per-connection via cs.imageSendQueue so two images don't
      // interleave their chunks on the same wire.
      for (const cs of connectionsRef.current.values()) {
        if (!cs.encryptKey) continue
        cs.imageSendQueue = cs.imageSendQueue
          .then(() => streamImageToConn(cs.conn, cs.encryptKey, bytes, mime, text || '', replyTo, senderName, time))
          .catch(() => {})
      }
      return
    }

    // Text-only (or legacy data-URI image) — existing chat-encrypted path.
    setMessages(prev => [...prev, { text, image, replyTo, from: 'You', time, self: true }])
    const payload = JSON.stringify({ text, image, replyTo })
    for (const cs of connectionsRef.current.values()) {
      try {
        if (cs.encryptKey) {
          const encrypted = await encryptChunk(cs.encryptKey, new TextEncoder().encode(payload))
          cs.conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), from: senderName, time })
        }
      } catch {}
    }
  }, [senderName])

  const sendTyping = useCallback(() => {
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'typing', nickname: senderName }) } catch {}
    })
  }, [senderName])

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
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'reaction', msgId, emoji, nickname: senderName }) } catch {}
    })
  }, [senderName])

  const changeSenderName = useCallback((newName) => {
    if (!newName.trim()) return
    const oldName = senderName
    setSenderName(newName.trim())
    const msg = `${oldName} is now ${newName.trim()}`
    setMessages(prev => [...prev, { text: msg, from: 'system', time: Date.now(), self: false }])
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'system-msg', text: msg, time: Date.now() }) } catch {}
    })
  }, [senderName])

  const broadcastManifest = useCallback(async () => {
    if (filesRef.current.length === 0 || connectionsRef.current.size === 0) return
    const manifest = await buildManifestData(filesRef.current, chatOnlyRef.current)
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send(manifest) } catch {}
    })
  }, [])

  const reset = useCallback(() => {
    connectionsRef.current.forEach(cs => { cs.abort.aborted = true })
    connectionsRef.current.clear()
    if (peerRef.current) peerRef.current.destroy()
    // Revoke blob URLs minted for chat images to avoid memory leaks.
    imageBlobUrlsRef.current.forEach(u => { try { URL.revokeObjectURL(u) } catch {} })
    imageBlobUrlsRef.current = []
    filesRef.current = []
    passwordRef.current = null
    chatOnlyRef.current = false
    setPeerId(null)
    setStatus('initializing')
    setProgress({})
    setOverallProgress(0)
    setSpeed(0)
    setEta(null)
    setCurrentFileIndex(-1)
    setTotalSent(0)
    setFingerprint(null)
    setRecipientCount(0)
    setMessages([])
    setRtt(null)
    setSenderName('Host')
    setTypingUsers([])
    setSessionKey(k => k + 1)
  }, [])

  return { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint, recipientCount, setPassword, setChatOnly, broadcastManifest, messages, sendMessage, rtt, senderName, changeSenderName, typingUsers, sendTyping, sendReaction }
}

async function sendSingleFile(conn, files, index, startChunk, connState, encryptKey, aggregateUI) {
  const file = files[index]
  if (!file) return
  
  // Initialize adaptive chunker and progress throttler for this transfer
  if (!connState.chunker) connState.chunker = new AdaptiveChunker()
  if (!connState.progressThrottler) connState.progressThrottler = new ProgressThrottler(80) // ~12fps
  
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE) // Use default for total count estimation

  connState.currentFileIndex = index
  conn.send({ type: 'file-start', name: file.name, size: file.size, index, totalChunks, resumeFrom: startChunk })

  let chunkIndex = 0
  let fileSent = startChunk * CHUNK_SIZE
  let chunkStartTime = 0

  for await (const { buffer: chunkData, chunkSize } of chunkFileAdaptive(file, connState.chunker)) {
    if (connState.abort.aborted) return
    if (connState.cancelledFiles?.has(index)) {
      conn.send({ type: 'file-cancelled', index })
      connState.cancelledFiles.delete(index)
      return
    }
    // Pause — await until resumed or cancelled
    if (connState.pausedFiles?.has(index)) {
      if (!connState.pauseResolvers) connState.pauseResolvers = {}
      await new Promise(r => { connState.pauseResolvers[index] = r })
      delete connState.pauseResolvers[index]
      if (connState.abort.aborted) return
      if (connState.cancelledFiles?.has(index)) {
        conn.send({ type: 'file-cancelled', index })
        connState.cancelledFiles.delete(index)
        return
      }
    }

    if (chunkIndex < startChunk) {
      chunkIndex++
      continue
    }

    chunkStartTime = Date.now()

    const dataToSend = encryptKey
      ? await encryptChunk(encryptKey, chunkData)
      : chunkData

    const packet = buildChunkPacket(index, chunkIndex, dataToSend)
    conn.send(packet)
    await waitForBufferDrain(conn)

    // Record transfer time for adaptive chunk sizing
    const transferTime = Date.now() - chunkStartTime
    connState.chunker.recordTransfer(chunkData.byteLength, transferTime)

    chunkIndex++
    fileSent += chunkData.byteLength
    connState.totalSent += chunkData.byteLength
    connState.progress[file.name] = Math.round((fileSent / file.size) * 100)

    // Throttled UI updates for better performance
    if (connState.progressThrottler.shouldUpdate()) {
      const now = Date.now()
      const elapsed = (now - connState.startTime) / 1000
      if (elapsed > 0.5) connState.speed = connState.totalSent / elapsed
      aggregateUI()
    }
  }

  if (!connState.abort.aborted) {
    conn.send({ type: 'file-end', index })
    connState.progress[file.name] = 100
    connState.progressThrottler.forceUpdate() // Always update on file end
    aggregateUI()
  }
}

// ── Inline chat image helpers ────────────────────────────────────────────
//
// handleHostChunk: called from the host's per-connection chunkQueue when a
// binary packet arrives. The only binary the host accepts from a recipient
// today is a chat-image chunk (fileIndex===CHAT_IMAGE_FILE_INDEX). Decrypt
// it with the source's per-recipient key and append to the in-flight image
// buffer for that connection. The chat-image-end-enc handler will finalize
// + relay once the queue drains.
async function handleHostChunk(connState, rawData) {
  if (!connState.encryptKey) return
  const buffer = rawData instanceof ArrayBuffer
    ? rawData
    : (rawData.buffer || new Uint8Array(rawData).buffer)
  let parsed
  try { parsed = parseChunkPacket(buffer) } catch { return }
  if (parsed.fileIndex !== CHAT_IMAGE_FILE_INDEX) return // ignore unknown
  let plain
  try { plain = await decryptChunk(connState.encryptKey, parsed.data) }
  catch { return }
  const inFlight = connState.inProgressImage
  if (!inFlight) return // chunks before start — drop
  const bytes = plain instanceof Uint8Array ? plain : new Uint8Array(plain)
  inFlight.chunks.push(bytes)
  inFlight.receivedBytes += bytes.byteLength
}

// streamImageToConn: ship a plaintext image (Uint8Array) to a single
// connection through the binary chunk pipeline. Used by both the host's
// own outgoing image broadcast and by the relay path (forwarding an
// image received from one recipient to all the others). Each chunk is
// encrypted with that connection's per-recipient key, then sent through
// buildChunkPacket + waitForBufferDrain — same backpressure-aware path
// as file transfers.
async function streamImageToConn(conn, key, bytes, mime, text, replyTo, from, time) {
  if (!conn || conn.open === false || !key) return
  // 1. Announce
  try {
    const startPayload = JSON.stringify({ mime, size: bytes.byteLength, text, replyTo, time })
    const encStart = await encryptChunk(key, new TextEncoder().encode(startPayload))
    conn.send({ type: 'chat-image-start-enc', data: uint8ToBase64(new Uint8Array(encStart)), from, time })
  } catch { return }

  // 2. Stream the body
  const chunker = new AdaptiveChunker()
  let offset = 0
  let chunkIndex = 0
  while (offset < bytes.byteLength) {
    if (conn.open === false) return
    const chunkSize = Math.min(chunker.getChunkSize(), bytes.byteLength - offset)
    const slice = bytes.subarray(offset, offset + chunkSize)
    const tStart = Date.now()
    let encChunk
    try { encChunk = await encryptChunk(key, slice) } catch { return }
    const packet = buildChunkPacket(CHAT_IMAGE_FILE_INDEX, chunkIndex, encChunk)
    try { conn.send(packet) } catch { return }
    try { await waitForBufferDrain(conn) } catch { return }
    chunker.recordTransfer(slice.byteLength, Date.now() - tStart)
    offset += chunkSize
    chunkIndex++
  }

  // 3. End
  try {
    const encEnd = await encryptChunk(key, new TextEncoder().encode('{}'))
    conn.send({ type: 'chat-image-end-enc', data: uint8ToBase64(new Uint8Array(encEnd)) })
  } catch { /* receiver will see incomplete image; the next start clears it */ }
}
