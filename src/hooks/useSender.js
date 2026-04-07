import Peer from 'peerjs'
import { useState, useEffect, useRef, useCallback } from 'react'
import { chunkFile, buildChunkPacket, waitForBufferDrain, CHUNK_SIZE } from '../utils/fileChunker'
import { generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey, encryptChunk, getKeyFingerprint } from '../utils/crypto'
import { STUN_ONLY } from '../utils/iceServers'

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
  const peerRef = useRef(null)
  const connRef = useRef(null)
  const filesRef = useRef([])
  const hasRecipient = useRef(false)
  const transferAbortRef = useRef(null)
  const totalSentRef = useRef(0)
  const startTimeRef = useRef(null)
  const encryptKeyRef = useRef(null)

  const setFiles = useCallback((files) => {
    filesRef.current = files
  }, [])

  useEffect(() => {
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

      if (hasRecipient.current) {
        conn.on('open', () => {
          conn.send({ type: 'rejected', reason: 'Another user is already connected to this portal.' })
          setTimeout(() => conn.close(), 500)
        })
        return
      }

      connRef.current = conn

      const senderKeyPairRef = { current: null }

      conn.on('open', async () => {
        if (destroyed) return
        hasRecipient.current = true
        setStatus('connected')

        // Generate keypair and send public key
        senderKeyPairRef.current = await generateKeyPair()
        const pubKeyBytes = await exportPublicKey(senderKeyPairRef.current.publicKey)
        conn.send({ type: 'public-key', key: Array.from(pubKeyBytes) })
      })

      conn.on('data', async (data) => {
        if (destroyed) return

        // Key exchange: receive receiver's public key, derive shared key, send manifest
        if (data.type === 'public-key') {
          const remotePubKey = await importPublicKey(new Uint8Array(data.key))
          encryptKeyRef.current = await deriveSharedKey(senderKeyPairRef.current.privateKey, remotePubKey)
          const fp = await getKeyFingerprint(new Uint8Array(data.key))
          setFingerprint(fp)

          // Now send manifest
          const files = filesRef.current
          conn.send({
            type: 'manifest',
            files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
            totalSize: files.reduce((sum, f) => sum + f.size, 0),
            sentAt: new Date().toISOString(),
          })
          return
        }

        // Single file request
        if (data.type === 'request-file') {
          setStatus('transferring')
          if (!startTimeRef.current) startTimeRef.current = Date.now()
          const abort = { aborted: false }
          transferAbortRef.current = abort
          await sendSingleFile(conn, filesRef.current, data.index, data.resumeChunk || 0, abort, setProgress, setCurrentFileIndex, totalSentRef, setTotalSent, setSpeed, setOverallProgress, setEta, startTimeRef, encryptKeyRef.current)
          setStatus('connected')
          setCurrentFileIndex(-1)
        }

        // All files request
        if (data.type === 'request-all') {
          setStatus('transferring')
          startTimeRef.current = Date.now()
          const abort = { aborted: false }
          transferAbortRef.current = abort
          const indices = data.indices || filesRef.current.map((_, i) => i)
          for (const idx of indices) {
            if (abort.aborted) break
            await sendSingleFile(conn, filesRef.current, idx, 0, abort, setProgress, setCurrentFileIndex, totalSentRef, setTotalSent, setSpeed, setOverallProgress, setEta, startTimeRef, encryptKeyRef.current)
          }
          if (!abort.aborted) {
            conn.send({ type: 'batch-done' })
            setStatus('connected')
            setCurrentFileIndex(-1)
          }
        }

        // Legacy ready (backward compat)
        if (data.type === 'ready') {
          setStatus('transferring')
          startTimeRef.current = Date.now()
          const abort = { aborted: false }
          transferAbortRef.current = abort
          for (let i = 0; i < filesRef.current.length; i++) {
            if (abort.aborted) break
            await sendSingleFile(conn, filesRef.current, i, 0, abort, setProgress, setCurrentFileIndex, totalSentRef, setTotalSent, setSpeed, setOverallProgress, setEta, startTimeRef, encryptKeyRef.current)
          }
          if (!abort.aborted) {
            conn.send({ type: 'done' })
            setStatus('done')
          }
        }

        if (data.type === 'resume') {
          setStatus('transferring')
          if (!startTimeRef.current) startTimeRef.current = Date.now()
          const abort = { aborted: false }
          transferAbortRef.current = abort
          await sendSingleFile(conn, filesRef.current, data.fileIndex, data.chunkIndex, abort, setProgress, setCurrentFileIndex, totalSentRef, setTotalSent, setSpeed, setOverallProgress, setEta, startTimeRef, encryptKeyRef.current)
          if (!abort.aborted) setStatus('connected')
        }
      })

      conn.on('close', () => {
        if (destroyed) return
        if (transferAbortRef.current) transferAbortRef.current.aborted = true
        hasRecipient.current = false
        setStatus(prev => prev === 'done' ? prev : 'waiting')
      })
      conn.on('error', () => {
        if (destroyed) return
        if (transferAbortRef.current) transferAbortRef.current.aborted = true
        setStatus('error')
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
      if (transferAbortRef.current) transferAbortRef.current.aborted = true
      peer.destroy()
    }
  }, [sessionKey])

  const reset = useCallback(() => {
    if (transferAbortRef.current) transferAbortRef.current.aborted = true
    if (peerRef.current) peerRef.current.destroy()
    hasRecipient.current = false
    connRef.current = null
    filesRef.current = []
    totalSentRef.current = 0
    startTimeRef.current = null
    setPeerId(null)
    setStatus('initializing')
    setProgress({})
    setOverallProgress(0)
    setSpeed(0)
    setEta(null)
    setCurrentFileIndex(-1)
    setTotalSent(0)
    setFingerprint(null)
    encryptKeyRef.current = null
    setSessionKey(k => k + 1)
  }, [])

  return { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint }
}

async function sendSingleFile(conn, files, index, startChunk, abort, setProgress, setCurrentFileIndex, totalSentRef, setTotalSent, setSpeed, setOverallProgress, setEta, startTimeRef, encryptKey) {
  const file = files[index]
  if (!file) return
  const totalSize = files.reduce((sum, f) => sum + f.size, 0)
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  setCurrentFileIndex(index)
  conn.send({ type: 'file-start', name: file.name, size: file.size, index, totalChunks, resumeFrom: startChunk })

  let chunkIndex = 0
  let fileSent = startChunk * CHUNK_SIZE

  for await (const chunkData of chunkFile(file)) {
    if (abort.aborted) return

    if (chunkIndex < startChunk) {
      chunkIndex++
      continue
    }

    // Encrypt the chunk data before wrapping in the packet
    const dataToSend = encryptKey
      ? await encryptChunk(encryptKey, chunkData)
      : chunkData

    const packet = buildChunkPacket(index, chunkIndex, dataToSend)
    conn.send(packet)
    await waitForBufferDrain(conn)

    chunkIndex++
    fileSent += chunkData.byteLength
    totalSentRef.current += chunkData.byteLength
    setTotalSent(totalSentRef.current)

    const filePercent = Math.round((fileSent / file.size) * 100)
    setProgress(prev => ({ ...prev, [file.name]: filePercent }))

    setOverallProgress(Math.round((totalSentRef.current / totalSize) * 100))

    const elapsed = (Date.now() - startTimeRef.current) / 1000
    if (elapsed > 0.5) {
      const currentSpeed = totalSentRef.current / elapsed
      setSpeed(currentSpeed)
      setEta((totalSize - totalSentRef.current) / currentSpeed)
    }
  }

  if (!abort.aborted) {
    conn.send({ type: 'file-end', index })
    setProgress(prev => ({ ...prev, [file.name]: 100 }))
  }
}
