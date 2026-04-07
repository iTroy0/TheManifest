import Peer from 'peerjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import { parseChunkPacket } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, decryptChunk, getKeyFingerprint } from '../utils/crypto'
import { createFileStream } from '../utils/streamWriter'
import { createStreamingZip } from '../utils/zipBuilder'
import { STUN_ONLY, WITH_TURN } from '../utils/iceServers'

const ANIMALS = ['Fox', 'Wolf', 'Bear', 'Hawk', 'Lynx', 'Owl', 'Crow', 'Deer', 'Hare', 'Pike']
const ADJECTIVES = ['Swift', 'Bold', 'Calm', 'Keen', 'Wild', 'Wise', 'Dark', 'Bright']
function generateNickname() {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
  const b = ANIMALS[Math.floor(Math.random() * ANIMALS.length)]
  return `${a}${b}${Math.floor(Math.random() * 100)}`
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
  const [nickname] = useState(() => generateNickname())

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

  const startConnection = useCallback((withTurn, isReconnect = false) => {
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

          // RTT polling
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

          if (isReconnect && wasTransferringRef.current) {
            setStatus('manifest-received')
            conn.send({ type: 'request-file', index: lastFileIndexRef.current, resumeChunk: lastChunkIndexRef.current })
            setPendingFiles(prev => ({ ...prev, [lastFileIndexRef.current]: true }))
          } else {
            setStatus('connected')
          }
          conn.send({ type: 'join', nickname })
        })

        conn.on('data', async (data) => {
          if (destroyedRef.current) return

          if (data instanceof ArrayBuffer || (data && data.byteLength !== undefined && !(typeof data === 'object' && data.type))) {
            handleChunk(data)
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
            const fp = await getKeyFingerprint(new Uint8Array(data.key))
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

          if (data.type === 'chat') {
            setMessages(prev => [...prev, { text: data.text, from: data.from || 'Sender', time: data.time, self: false }])
            return
          }

          if (data.type === 'manifest') {
            setManifest(data)
            manifestRef.current = data
            setStatus('manifest-received')
          }

          if (data.type === 'rejected') setStatus('rejected')

          if (data.type === 'file-start') {
            const resumeFrom = data.resumeFrom || 0
            fileMetaRef.current[data.index] = { name: data.name, size: data.size, totalChunks: data.totalChunks }
            lastFileIndexRef.current = data.index
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
            }
          }

          if (data.type === 'file-end') {
            const meta = fileMetaRef.current[data.index]
            if (!meta) return

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
          }

          if (data.type === 'done' || data.type === 'batch-done') {
            wasTransferringRef.current = false
            setPendingFiles({})

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
          if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
          if (wasTransferringRef.current && reconnectCountRef.current < MAX_RECONNECTS) {
            reconnectCountRef.current++
            peer.destroy()
            setTimeout(() => { if (!destroyedRef.current) startConnection(useTurnRef.current, true) }, RECONNECT_DELAY)
            return
          }
          Object.values(streamsRef.current).forEach(s => { if (s) s.abort() })
          setRtt(null)
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

  const sendMessage = useCallback((text) => {
    if (!text.trim()) return
    const conn = connRef.current
    if (!conn) return
    const time = Date.now()
    setMessages(prev => [...prev, { text: text.trim(), from: 'You', time, self: true }])
    try { conn.send({ type: 'chat', text: text.trim(), nickname, time }) } catch {}
  }, [nickname])

  const submitPassword = useCallback((password) => {
    const conn = connRef.current
    if (!conn) return
    setPasswordError(false)
    conn.send({ type: 'password', password })
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

  async function handleChunk(rawData) {
    const buffer = rawData instanceof ArrayBuffer ? rawData : rawData.buffer || new Uint8Array(rawData).buffer
    const { fileIndex, chunkIndex, data } = parseChunkPacket(buffer)

    // Decrypt if we have a key
    const plainData = decryptKeyRef.current
      ? await decryptChunk(decryptKeyRef.current, data)
      : data

    lastFileIndexRef.current = fileIndex
    lastChunkIndexRef.current = chunkIndex + 1
    totalReceivedRef.current += plainData.byteLength

    // Write to zip stream, file stream, or memory fallback
    if (zipModeRef.current && zipWriterRef.current) {
      zipWriterRef.current.writeChunk(plainData)
    } else if (streamsRef.current[fileIndex]) {
      streamsRef.current[fileIndex].write(plainData)
    } else {
      if (!chunksRef.current[fileIndex]) chunksRef.current[fileIndex] = []
      chunksRef.current[fileIndex][chunkIndex] = plainData
    }

    const meta = fileMetaRef.current[fileIndex]
    if (meta) {
      const pct = Math.min(99, Math.round(((chunkIndex + 1) / meta.totalChunks) * 100))
      setProgress(prev => ({ ...prev, [meta.name]: pct }))
    }

    const totalSize = transferTotalRef.current || manifestRef.current?.totalSize || 0
    if (totalSize > 0) {
      setOverallProgress(Math.min(100, Math.round((totalReceivedRef.current / totalSize) * 100)))
      const elapsed = (Date.now() - startTimeRef.current) / 1000
      if (elapsed > 0.5) {
        const currentSpeed = totalReceivedRef.current / elapsed
        setSpeed(currentSpeed)
        setEta(Math.max(0, (totalSize - totalReceivedRef.current) / currentSpeed))
      }
    }
  }

  return {
    manifest, status, progress, overallProgress, speed, eta,
    pendingFiles, completedFiles, requestFile, requestAllAsZip,
    retryCount, useRelay, enableRelay, zipMode, fingerprint,
    passwordRequired, passwordError, submitPassword,
    messages, sendMessage, rtt, nickname,
  }
}
