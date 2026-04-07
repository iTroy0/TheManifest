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
  const [recipientCount, setRecipientCount] = useState(0)
  const [messages, setMessages] = useState([])
  const [rtt, setRtt] = useState(null)
  const peerRef = useRef(null)
  const filesRef = useRef([])
  const connectionsRef = useRef(new Map())
  const passwordRef = useRef(null)
  const rttRef = useRef(null)

  const setFiles = useCallback((files) => {
    filesRef.current = files
  }, [])

  const setPassword = useCallback((pwd) => {
    passwordRef.current = pwd || null
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

        if (active.length === 0) return

        const sent = active.reduce((s, cs) => s + cs.totalSent, 0)
        const total = active.reduce((s, cs) => s + cs.transferTotalSize, 0)
        const spd = active.reduce((s, cs) => s + cs.speed, 0)
        setTotalSent(sent)
        setOverallProgress(total > 0 ? Math.min(100, Math.round((sent / total) * 100)) : 0)
        setSpeed(spd)
        setEta(spd > 0 ? Math.max(0, (total - sent) / spd) : null)
      }

      function sendManifest(c) {
        const files = filesRef.current
        c.send({
          type: 'manifest',
          files: files.map(f => ({ name: f.name, size: f.size, type: f.type })),
          totalSize: files.reduce((sum, f) => sum + f.size, 0),
          sentAt: new Date().toISOString(),
        })
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
              connectionsRef.current.forEach(cs => {
                try { cs.conn.send({ type: 'chat', text: `${name} left`, from: 'system', time: Date.now() }) } catch {}
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
          const fp = await getKeyFingerprint(new Uint8Array(data.key))
          setFingerprint(fp)

          if (passwordRef.current) {
            conn.send({ type: 'password-required' })
          } else {
            sendManifest(conn)
          }
          return
        }

        if (data.type === 'password') {
          if (data.password === passwordRef.current) {
            conn.send({ type: 'password-accepted' })
            sendManifest(conn)
          } else {
            conn.send({ type: 'password-wrong' })
          }
          return
        }

        if (data.type === 'chat') {
          const msg = { text: data.text, from: data.nickname || 'Anon', time: data.time, self: false }
          setMessages(prev => [...prev, msg])
          // Relay to all OTHER receivers
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) {
              try { cs.conn.send({ type: 'chat', text: data.text, from: data.nickname || 'Anon', time: data.time }) } catch {}
            }
          })
          return
        }

        if (data.type === 'join') {
          connState.nickname = data.nickname
          setMessages(prev => [...prev, { text: `${data.nickname} joined`, from: 'system', time: Date.now(), self: false }])
          // Notify other receivers
          connectionsRef.current.forEach((cs, id) => {
            if (id !== connId) {
              try { cs.conn.send({ type: 'chat', text: `${data.nickname} joined`, from: 'system', time: Date.now() }) } catch {}
            }
          })
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
          const transferSize = filesRef.current[data.index]?.size || 0
          startTransfer(transferSize)
          await sendSingleFile(conn, filesRef.current, data.index, data.resumeChunk || 0, connState, connState.encryptKey, aggregateUI)
          if (!connState.abort.aborted) endTransfer()
        }

        if (data.type === 'request-all') {
          const indices = data.indices || filesRef.current.map((_, i) => i)
          const transferSize = indices.reduce((sum, i) => sum + (filesRef.current[i]?.size || 0), 0)
          startTransfer(transferSize)
          for (const idx of indices) {
            if (connState.abort.aborted) break
            await sendSingleFile(conn, filesRef.current, idx, 0, connState, connState.encryptKey, aggregateUI)
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
            await sendSingleFile(conn, filesRef.current, i, 0, connState, connState.encryptKey, aggregateUI)
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
        connectionsRef.current.delete(connId)
        setRecipientCount(connectionsRef.current.size)
        setMessages(prev => [...prev, { text: `${name} left`, from: 'system', time: Date.now(), self: false }])
        // Notify other receivers
        connectionsRef.current.forEach(cs => {
          try { cs.conn.send({ type: 'chat', text: `${name} left`, from: 'system', time: Date.now() }) } catch {}
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

  const sendMessage = useCallback((text) => {
    if (!text.trim()) return
    const time = Date.now()
    setMessages(prev => [...prev, { text: text.trim(), from: 'You', time, self: true }])
    connectionsRef.current.forEach(cs => {
      try { cs.conn.send({ type: 'chat', text: text.trim(), from: 'Sender', time }) } catch {}
    })
  }, [])

  const reset = useCallback(() => {
    if (rttRef.current) { clearInterval(rttRef.current); rttRef.current = null }
    connectionsRef.current.forEach(cs => { cs.abort.aborted = true })
    connectionsRef.current.clear()
    if (peerRef.current) peerRef.current.destroy()
    filesRef.current = []
    passwordRef.current = null
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
    setSessionKey(k => k + 1)
  }, [])

  return { peerId, status, progress, overallProgress, speed, eta, setFiles, reset, currentFileIndex, totalSent, fingerprint, recipientCount, setPassword, messages, sendMessage, rtt }
}

async function sendSingleFile(conn, files, index, startChunk, connState, encryptKey, aggregateUI) {
  const file = files[index]
  if (!file) return
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE)

  connState.currentFileIndex = index
  conn.send({ type: 'file-start', name: file.name, size: file.size, index, totalChunks, resumeFrom: startChunk })

  let chunkIndex = 0
  let fileSent = startChunk * CHUNK_SIZE

  for await (const chunkData of chunkFile(file)) {
    if (connState.abort.aborted) return

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

    const elapsed = (Date.now() - connState.startTime) / 1000
    if (elapsed > 0.5) {
      connState.speed = connState.totalSent / elapsed
    }

    aggregateUI()
  }

  if (!connState.abort.aborted) {
    conn.send({ type: 'file-end', index })
    connState.progress[file.name] = 100
    aggregateUI()
  }
}
