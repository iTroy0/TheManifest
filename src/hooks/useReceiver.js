import Peer from 'peerjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import { parseChunkPacket } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, decryptChunk, getKeyFingerprint, uint8ToBase64, base64ToUint8 } from '../utils/crypto'
import { createFileStream } from '../utils/streamWriter'
import { createStreamingZip } from '../utils/zipBuilder'
import { STUN_ONLY, WITH_TURN } from '../utils/iceServers'

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
  const rttRef = useRef(null)
  const expectedChunkRef = useRef({}) // Track expected chunk index per file for ACK

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

          // RTT polling + ICE state monitoring for fast disconnect detection
          if (rttRef.current) clearInterval(rttRef.current)
          rttRef.current = setInterval(() => {
            const pc = conn.peerConnection
            if (!pc) return
            pc.getStats().then(stats => {
              stats.forEach(r => {
                if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime != null) {
                  setRtt(Math.round(r.currentRoundTripTime * 1000))
                }
              })
            }).catch(() => {})
          }, 3000)

          // Heartbeat mechanism - send ping every 5s
          const heartbeatInterval = setInterval(() => {
            try { conn.send({ type: 'ping', ts: Date.now() }) } catch {}
          }, 5000)
          let lastPong = Date.now()
          
          // Check for zombie connections
          const heartbeatCheck = setInterval(() => {
            if (Date.now() - lastPong > 15000 && !destroyedRef.current) {
              clearInterval(heartbeatInterval)
              clearInterval(heartbeatCheck)
              if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
              setRtt(null)
              setMessages(prev => [...prev, { text: 'Connection lost', from: 'system', time: Date.now(), self: false }])
              if (!wasTransferringRef.current) {
                setStatus('closed')
              }
            }
          }, 5000)
          
          // Store for cleanup
          conn._heartbeatInterval = heartbeatInterval
          conn._heartbeatCheck = heartbeatCheck
          conn._updateLastPong = () => { lastPong = Date.now() }

          // Fast disconnect detection via ICE state
          const pc = conn.peerConnection
          if (pc) {
            const prevHandler = pc.oniceconnectionstatechange
            pc.oniceconnectionstatechange = () => {
              if (prevHandler) prevHandler()
              const s = pc.iceConnectionState
              if ((s === 'disconnected' || s === 'failed' || s === 'closed') && !destroyedRef.current) {
                if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
                setRtt(null)
                setMessages(prev => [...prev, { text: 'Sender disconnected', from: 'system', time: Date.now(), self: false }])
                if (!wasTransferringRef.current) {
                  setStatus('closed')
                }
              }
            }
          }

          if (isReconnect && wasTransferringRef.current) {
            setStatus('manifest-received')
            conn.send({ type: 'request-file', index: lastFileIndexRef.current, resumeChunk: lastChunkIndexRef.current })
            setPendingFiles(prev => ({ ...prev, [lastFileIndexRef.current]: true }))
          } else {
            setStatus('connected')
            // Timeout if manifest never arrives
            const manifestTimeout = setTimeout(() => {
              if (!manifestRef.current && !destroyedRef.current) setStatus('closed')
            }, 15000)
            const origManifestHandler = (d) => { if (d.type === 'manifest') clearTimeout(manifestTimeout) }
            conn.on('data', origManifestHandler)
          }
          conn.send({ type: 'join', nickname })
        })

        conn.on('data', async (data) => {
          if (destroyedRef.current) return

          if (data instanceof ArrayBuffer || (data && data.byteLength !== undefined && !(typeof data === 'object' && data.type))) {
            handleChunk(data)
            return
          }

          // Heartbeat responses
          if (data.type === 'pong') {
            if (conn._updateLastPong) conn._updateLastPong()
            return
          }
          if (data.type === 'ping') {
            try { conn.send({ type: 'pong', ts: data.ts }) } catch {}
            return
          }

          // Key exchange: receive sender's public key, send ours back
          if (data.type === 'public-key') {
            if (!keyPairRef.current) {
              keyPairRef.current = await generateKeyPair()
            }
            const pubKeyBytes = await exportPublicKey(keyPairRef.current.publicKey)
            conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) })
            const remotePubKey = await importPublicKey(new Uint8Array(data.key))
            decryptKeyRef.current = await deriveSharedKey(keyPairRef.current.privateKey, remotePubKey)
            const fp = await getKeyFingerprint(pubKeyBytes, new Uint8Array(data.key))
            setFingerprint(fp)
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

          // Handle batched messages
          if (data.type === 'batch') {
            for (const msg of data.messages || []) {
              // Re-dispatch each message in the batch
              conn.emit('data', msg)
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
              try {
                const decrypted = await decryptChunk(decryptKeyRef.current, base64ToUint8(data.data))
                payload = JSON.parse(new TextDecoder().decode(decrypted))
              } catch { return }
            }
            setMessages(prev => [...prev, { text: payload.text || '', image: payload.image, replyTo: payload.replyTo, from: data.from || 'Sender', time: data.time, self: false }])
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
            fileMetaRef.current[data.index] = { name: data.name, size: data.size, totalChunks: data.totalChunks }
            lastFileIndexRef.current = data.index
            expectedChunkRef.current[data.index] = resumeFrom // Reset expected chunk for ACK
            if (!startTimeRef.current) startTimeRef.current = Date.now()

            if (resumeFrom === 0) {
              if (zipModeRef.current && zipWriterRef.current) {
                // Zip mode: start a new file entry in the streaming zip
                zipWriterRef.current.startFile(data.name, data.size)
              } else {
                // Stream mode: pipe individual file to disk
                const stream = createFileStream(data.name, data.size)
                if (stream) {
                  streamsRef.current[data.index] = stream
                } else {
                  // Fallback: store in memory, save as blob
                  chunksRef.current[data.index] = []
                }
              }
            } else {
              // Resume mode: ensure chunksRef is initialized for memory fallback
              if (!zipModeRef.current && !streamsRef.current[data.index] && !chunksRef.current[data.index]) {
                chunksRef.current[data.index] = []
              }
            }
          }

          if (data.type === 'file-end') {
            const meta = fileMetaRef.current[data.index]
            console.log("[v0] file-end", { index: data.index, meta, hasZip: !!zipWriterRef.current, hasStream: !!streamsRef.current[data.index], hasChunks: !!chunksRef.current[data.index], chunksLength: chunksRef.current[data.index]?.length })
            if (!meta) return

            if (zipModeRef.current && zipWriterRef.current) {
              // End the current file in the streaming zip
              zipWriterRef.current.endFile()
              console.log("[v0] ended zip file")
            } else if (streamsRef.current[data.index]) {
              try {
                streamsRef.current[data.index].close()
                console.log("[v0] closed stream")
              } catch (err) {
                console.log("[v0] stream close failed:", err)
              }
              streamsRef.current[data.index] = null
            }
            
            // Memory fallback: save blob (check if we have chunks stored)
            const chunks = chunksRef.current[data.index]
            console.log("[v0] checking memory fallback", { hasChunks: !!chunks, length: chunks?.length })
            if (chunks && chunks.length > 0) {
              const mimeType = manifestRef.current?.files?.[data.index]?.type || 'application/octet-stream'
              const blob = new Blob(chunks, { type: mimeType })
              console.log("[v0] created blob", { size: blob.size, type: mimeType, name: meta.name })
              const url = URL.createObjectURL(blob)
              const a = document.createElement('a')
              a.href = url
              a.download = meta.name
              document.body.appendChild(a)
              a.click()
              console.log("[v0] triggered download click")
              document.body.removeChild(a)
              setTimeout(() => URL.revokeObjectURL(url), 1000)
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
          if (conn._heartbeatInterval) clearInterval(conn._heartbeatInterval)
          if (conn._heartbeatCheck) clearInterval(conn._heartbeatCheck)
          if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
          if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
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
      if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
      decryptKeyRef.current = null
      keyPairRef.current = null
      Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
      if (zipWriterRef.current) { zipWriterRef.current.abort(); zipWriterRef.current = null }
      if (peerRef.current) peerRef.current.destroy()
    }
  }, [peerId, startConnection])

  const enableRelay = useCallback(() => {
    destroyedRef.current = true
    clearTimeout(timeoutRef.current)
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
    setMessages(prev => [...prev, { text, image, replyTo, from: 'You', time, self: true }])
    try {
      const payload = JSON.stringify({ text, image, replyTo })
      const encrypted = await encryptChunk(decryptKeyRef.current, new TextEncoder().encode(payload))
      conn.send({ type: 'chat-encrypted', data: uint8ToBase64(new Uint8Array(encrypted)), nickname, time })
    } catch {}
  }, [nickname])

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
      // Corrupted chunk - request retransmission
      const conn = connRef.current
      if (conn) {
        try { conn.send({ type: 'chunk-nack', fileIndex, chunkIndex }) } catch {}
      }
      return
    }

    // Check for out-of-order chunks (simple detection)
    const expected = expectedChunkRef.current[fileIndex] || 0
    if (chunkIndex > expected + 1) {
      // Missing chunks detected - request retransmission
      const conn = connRef.current
      if (conn) {
        for (let i = expected; i < chunkIndex; i++) {
          try { conn.send({ type: 'chunk-nack', fileIndex, chunkIndex: i }) } catch {}
        }
      }
    }
    expectedChunkRef.current[fileIndex] = chunkIndex + 1

    // Send ACK every 10 chunks for flow control
    if (chunkIndex % 10 === 0) {
      const conn = connRef.current
      if (conn) {
        try { conn.send({ type: 'chunk-ack', fileIndex, chunkIndex }) } catch {}
      }
    }

    lastFileIndexRef.current = fileIndex
    lastChunkIndexRef.current = chunkIndex + 1
    totalReceivedRef.current += plainData.byteLength

    // Write to zip stream, file stream, or memory fallback
    const chunk = plainData instanceof ArrayBuffer ? new Uint8Array(plainData) : plainData
    let written = false
    
    console.log("[v0] handleChunk", { fileIndex, chunkIndex, chunkSize: chunk.byteLength, hasZip: !!zipWriterRef.current, hasStream: !!streamsRef.current[fileIndex], hasChunks: !!chunksRef.current[fileIndex] })
    
    try {
      if (zipModeRef.current && zipWriterRef.current) {
        zipWriterRef.current.writeChunk(chunk)
        written = true
        console.log("[v0] wrote to zip")
      } else if (streamsRef.current[fileIndex]) {
        await streamsRef.current[fileIndex].write(chunk)
        written = true
        console.log("[v0] wrote to stream")
      }
    } catch (err) {
      // Stream write failed - will fall back to memory below
      console.log("[v0] stream write failed:", err)
      streamsRef.current[fileIndex] = null // Clear broken stream
    }
    
    // Memory fallback - store chunks in order (push to array)
    if (!written) {
      if (!chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = []
      chunksRef.current[fileIndex].push(chunk)
      console.log("[v0] stored in memory, total chunks:", chunksRef.current[fileIndex].length)
    }

    const now = Date.now()
    if (now - lastChunkUIUpdate >= 100) {
      lastChunkUIUpdate = now
      const meta = fileMetaRef.current[fileIndex]
      if (meta) {
        setProgress(prev => ({ ...prev, [meta.name]: Math.round(((chunkIndex + 1) / meta.totalChunks) * 100) }))
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
