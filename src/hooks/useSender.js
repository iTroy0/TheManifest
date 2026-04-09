import Peer from 'peerjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import { chunkFile, buildChunkPacket, waitForBufferDrain, CHUNK_SIZE } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, getKeyFingerprint, uint8ToBase64, base64ToUint8 } from '../utils/crypto'
import { STUN_ONLY } from '../utils/iceServers'

async function generateThumbnail(file, maxDim = 80) {
  const bitmap = await createImageBitmap(file)
  const ratio = Math.min(maxDim / bitmap.width, maxDim / bitmap.height, 1)
  const w = Math.round(bitmap.width * ratio)
  const h = Math.round(bitmap.height * ratio)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.5)
}

async function buildManifestData(files, chatOnly) {
  const fileEntries = await Promise.all(files.map(async f => {
    const entry = { name: f.name, size: f.size, type: f.type }
    if (f.type?.startsWith('image/') && f instanceof File) {
      try { entry.thumbnail = await generateThumbnail(f) } catch {}
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
  const rttRef = useRef(null)

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
      }
      connectionsRef.current.set(connId, connState)
      setRecipientCount(connectionsRef.current.size)

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
        setStatus('connected')

        // Start RTT polling
        if (!rttRef.current) {
          rttRef.current = setInterval(() => {
            const conns = Array.from(connectionsRef.current.values())
            const c = conns.find(cs => cs.conn?.peerConnection)
            if (!c) return
            c.conn.peerConnection.getStats().then(stats => {
              stats.forEach(r => {
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
                  setRtt(Math.round(r.currentRoundTripTime * 1000))
                }
              })
            }).catch(() => {})
          }, 3000)
        }

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
                if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
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

        if (data.type === 'public-key') {
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
          if (password === passwordRef.current) {
            conn.send({ type: 'password-accepted' })
            await sendManifest(conn)
          } else {
            conn.send({ type: 'password-wrong' })
          }
          return
        }

        if (data.type === 'typing') {
          const nick = data.nickname
          setTypingUsers(prev => prev.includes(nick) ? prev : [...prev, nick])
          clearTimeout(typingTimeouts.current[nick])
          typingTimeouts.current[nick] = setTimeout(() => {
            setTypingUsers(prev => prev.filter(n => n !== nick))
          }, 3000)
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) { try { cs.conn.send({ type: 'typing', nickname: nick }) } catch {} }
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
            try {
              const decrypted = await decryptChunk(connState.encryptKey, base64ToUint8(data.data))
              payload = JSON.parse(new TextDecoder().decode(decrypted))
            } catch { return }
          }
          const msg = { text: payload.text || '', image: payload.image, replyTo: payload.replyTo, from: data.nickname || 'Anon', time: data.time, self: false }
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

        if (data.type === 'join') {
          connState.nickname = data.nickname
          setMessages(prev => [...prev, { text: `${data.nickname} joined`, from: 'system', time: Date.now(), self: false }])
          // Broadcast online count + join to all receivers
          const count = connectionsRef.current.size + 1
          connectionsRef.current.forEach((cs, id) => {
            try { cs.conn.send({ type: 'online-count', count }) } catch {}
            if (id !== connId) {
              try { cs.conn.send({ type: 'system-msg', text: `${data.nickname} joined`, time: Date.now() }) } catch {}
            }
          })
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
          if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
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
      if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
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
    if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
    connectionsRef.current.forEach(cs => { cs.abort.aborted = true })
    connectionsRef.current.clear()
    if (peerRef.current) peerRef.current.destroy()
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
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  connState.currentFileIndex = index
  conn.send({ type: 'file-start', name: file.name, size: file.size, index, totalChunks, resumeFrom: startChunk })

  let chunkIndex = 0
  let fileSent = startChunk * CHUNK_SIZE
  let lastUIUpdate = 0

  for await (const chunkData of chunkFile(file)) {
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

    const dataToSend = encryptKey
      ? await encryptChunk(encryptKey, chunkData)
      : chunkData

    const packet = buildChunkPacket(index, chunkIndex, dataToSend)
    conn.send(packet)
    await waitForBufferDrain(conn)

    chunkIndex++
    fileSent += chunkData.byteLength
    connState.totalSent += chunkData.byteLength
    connState.progress[file.name] = Math.round((fileSent / file.size) * 100)

    const now = Date.now()
    if (now - lastUIUpdate >= 100) {
      lastUIUpdate = now
      const elapsed = (now - connState.startTime) / 1000
      if (elapsed > 0.5) connState.speed = connState.totalSent / elapsed
      aggregateUI()
    }
  }

  if (!connState.abort.aborted) {
    conn.send({ type: 'file-end', index })
    connState.progress[file.name] = 100
    aggregateUI()
  }
}
