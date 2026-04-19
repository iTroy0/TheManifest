import { describe, it, expect, beforeEach } from 'vitest'
import { sendFile, createFileReceiver, portalWire, IntegrityError } from './index'
import { createSession } from '../session'
import { finalizeKeyExchange } from '../keyExchange'
import { parseChunkPacket } from '../../utils/fileChunker'
import type { Session } from '../session'
import type { DataConnection } from 'peerjs'

// Minimal in-memory DataConnection pair. Matches the surface used by
// session.send / sendBinary and waitForBufferDrain (via _dc).
function pair() {
  const aHandlers = { data: [] as Array<(d: unknown) => void> }
  const bHandlers = { data: [] as Array<(d: unknown) => void> }
  const fakeDc = {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    readyState: 'open' as const,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const a = {
    peer: 'B',
    send: (d: unknown) => {
      // Use microtask to avoid deep synchronous recursion.
      queueMicrotask(() => bHandlers.data.forEach(fn => fn(d)))
    },
    on: (ev: string, fn: (d: unknown) => void) => {
      if (ev === 'data') aHandlers.data.push(fn)
    },
    off: () => {},
    _dc: fakeDc,
  } as unknown as DataConnection
  const b = {
    peer: 'A',
    send: (d: unknown) => {
      queueMicrotask(() => aHandlers.data.forEach(fn => fn(d)))
    },
    on: (ev: string, fn: (d: unknown) => void) => {
      if (ev === 'data') bHandlers.data.push(fn)
    },
    off: () => {},
    _dc: fakeDc,
  } as unknown as DataConnection
  return { a, b }
}

async function deriveKeyPair() {
  const keyA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  const keyB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits', 'deriveKey'])
  const aPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyA.publicKey))
  const bPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyB.publicKey))
  const a = (await finalizeKeyExchange({
    localPrivate: keyA.privateKey, localPublic: aPub, remotePublic: bPub,
  })).encryptKey
  const b = (await finalizeKeyExchange({
    localPrivate: keyB.privateKey, localPublic: bPub, remotePublic: aPub,
  })).encryptKey
  return { a, b }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  // Copy into a guaranteed plain ArrayBuffer to satisfy strict BufferSource typing.
  const plain = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(plain).set(bytes)
  const digest = await crypto.subtle.digest('SHA-256', plain)
  return [...new Uint8Array(digest)]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')
}

function authSession(s: Session, key: CryptoKey): void {
  s.dispatch({ type: 'connect-start' })
  s.dispatch({ type: 'conn-open' })
  s.dispatch({ type: 'keys-derived', encryptKey: key, fingerprint: 'test' })
}

describe('engine-loop integration', () => {
  let senderSession: Session
  let receiverSession: Session
  let connA: DataConnection
  let connB: DataConnection

  beforeEach(async () => {
    const { a, b } = pair()
    connA = a; connB = b
    const { a: keyA, b: keyB } = await deriveKeyPair()
    senderSession = createSession({ conn: connA, role: 'portal-sender' })
    receiverSession = createSession({ conn: connB, role: 'portal-receiver' })
    authSession(senderSession, keyA)
    authSession(receiverSession, keyB)
  })

  it('128 KB random file round-trips with matching SHA-256', async () => {
    const bytes = new Uint8Array(128 * 1024)
    // getRandomValues is capped at 65536 bytes per call
    for (let off = 0; off < bytes.byteLength; off += 65536) {
      crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.byteLength)))
    }
    const file = new File([bytes], 'payload.bin')

    const chunks: Uint8Array[] = []
    const receiver = createFileReceiver(receiverSession, portalWire)
    const sink = new WritableStream<Uint8Array>({ write(c) { chunks.push(c) } })

    // Receiver listens on connB for data from connA (sender → receiver).
    // Serialize the handler so that chunk writes always complete before
    // file-end closes the writer (microtask delivery is FIFO but the async
    // handlers would otherwise run concurrently).
    let recvQueue = Promise.resolve()
    connB.on('data', (msg: unknown) => {
      recvQueue = recvQueue.then(async () => {
        if (msg instanceof ArrayBuffer) {
          await receiver.onChunk(parseChunkPacket(msg))
        } else {
          const m = msg as { type: string; index?: number; size?: number; totalChunks?: number }
          if (m.type === 'file-start') {
            // Portal's file-start carries `index`; reconstruct fileId.
            const fileId = portalWire.fileIdForPacketIndex(m.index ?? 0) ?? 'file-0'
            await receiver.onFileStart({
              fileId,
              totalBytes: m.size ?? 0,
              totalChunks: m.totalChunks ?? 0,
              sink,
            })
          } else if (m.type === 'file-end') {
            const fileId = portalWire.fileIdForPacketIndex(m.index ?? 0) ?? 'file-0'
            await receiver.onFileEnd(fileId)
          }
        }
      })
    })

    const result = await sendFile(senderSession, file, portalWire, { fileId: 'file-0' })
    expect(result).toBe('complete')

    // Wait for the serialized receiver queue to fully drain (all chunks +
    // file-end processed). One setTimeout tick flushes the final microtasks
    // queued after sendFile returned, then we await the promise chain itself.
    await new Promise(r => setTimeout(r, 50))
    await recvQueue

    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const assembled = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { assembled.set(c, off); off += c.byteLength }
    expect(assembled.byteLength).toBe(bytes.byteLength)
    expect(await sha256(assembled)).toBe(await sha256(bytes))
  })

  it('pause-resume round-trip completes and preserves byte order', async () => {
    // 2 MB => 8 chunks at 256 KB default. Small files finish before the
    // pause flip can take effect; 8 chunks give real mid-stream blocking.
    const bytes = new Uint8Array(2 * 1024 * 1024)
    for (let off = 0; off < bytes.byteLength; off += 65536) {
      crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.byteLength)))
    }
    const file = new File([bytes], 'paused.bin')

    const chunks: Uint8Array[] = []
    const receiver = createFileReceiver(receiverSession, portalWire)
    const sink = new WritableStream<Uint8Array>({ write(c) { chunks.push(c) } })

    let recvQueue = Promise.resolve()
    connB.on('data', (msg: unknown) => {
      recvQueue = recvQueue.then(async () => {
        if (msg instanceof ArrayBuffer) {
          await receiver.onChunk(parseChunkPacket(msg))
        } else {
          const m = msg as { type: string; index?: number; size?: number; totalChunks?: number }
          if (m.type === 'file-start') {
            await receiver.onFileStart({
              fileId: portalWire.fileIdForPacketIndex(m.index ?? 0) ?? 'file-0',
              totalBytes: m.size ?? 0,
              totalChunks: m.totalChunks ?? 0,
              sink,
            })
          } else if (m.type === 'file-end') {
            await receiver.onFileEnd(portalWire.fileIdForPacketIndex(m.index ?? 0) ?? 'file-0')
          }
        }
      })
    })

    // L-f — pause synchronously before the chunk loop yields. sendFile
    // calls `session.beginTransfer` synchronously, so the handle exists
    // by the time pauseTransfer runs. Any `setTimeout`-based delay before
    // the pause raced against a fast CI that completed the whole
    // transfer before the pause landed.
    const p = sendFile(senderSession, file, portalWire, { fileId: 'file-0' })
    senderSession.pauseTransfer('file-0')
    // 100 ms: let any in-flight chunk settle + receiver queue drain.
    await new Promise(r => setTimeout(r, 100))
    await recvQueue
    const pausedAt = chunks.length
    const totalChunks = Math.max(1, Math.ceil(bytes.byteLength / (256 * 1024)))
    // Must actually be paused mid-file — otherwise we didn't exercise the path.
    expect(pausedAt).toBeLessThan(totalChunks)
    // No further chunks should arrive while paused.
    await new Promise(r => setTimeout(r, 100))
    await recvQueue
    expect(chunks.length).toBe(pausedAt)
    senderSession.resumeTransfer('file-0')

    expect(await p).toBe('complete')
    await new Promise(r => setTimeout(r, 50))
    await recvQueue

    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const assembled = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { assembled.set(c, off); off += c.byteLength }
    expect(assembled.byteLength).toBe(bytes.byteLength)
    expect(await sha256(assembled)).toBe(await sha256(bytes))
  })

  it('two concurrent files on the same session interleave + verify', async () => {
    // Two distinct fileIds -> distinct packet indices -> receiver routes
    // each chunk back to its correct sink via fileIdForPacketIndex.
    const bytesA = new Uint8Array(128 * 1024)
    const bytesB = new Uint8Array(128 * 1024)
    for (let off = 0; off < 128 * 1024; off += 65536) {
      crypto.getRandomValues(bytesA.subarray(off, off + 65536))
      crypto.getRandomValues(bytesB.subarray(off, off + 65536))
    }
    const fileA = new File([bytesA], 'a.bin')
    const fileB = new File([bytesB], 'b.bin')

    const chunksA: Uint8Array[] = []
    const chunksB: Uint8Array[] = []
    const receiver = createFileReceiver(receiverSession, portalWire)
    const sinkA = new WritableStream<Uint8Array>({ write(c) { chunksA.push(c) } })
    const sinkB = new WritableStream<Uint8Array>({ write(c) { chunksB.push(c) } })

    let recvQueue = Promise.resolve()
    connB.on('data', (msg: unknown) => {
      recvQueue = recvQueue.then(async () => {
        if (msg instanceof ArrayBuffer) {
          await receiver.onChunk(parseChunkPacket(msg))
        } else {
          const m = msg as { type: string; index?: number; size?: number; totalChunks?: number }
          const fileId = portalWire.fileIdForPacketIndex(m.index ?? 0) ?? `file-${m.index}`
          if (m.type === 'file-start') {
            await receiver.onFileStart({
              fileId,
              totalBytes: m.size ?? 0,
              totalChunks: m.totalChunks ?? 0,
              sink: fileId === 'file-0' ? sinkA : sinkB,
            })
          } else if (m.type === 'file-end') {
            await receiver.onFileEnd(fileId)
          }
        }
      })
    })

    const [rA, rB] = await Promise.all([
      sendFile(senderSession, fileA, portalWire, { fileId: 'file-0' }),
      sendFile(senderSession, fileB, portalWire, { fileId: 'file-1' }),
    ])
    expect(rA).toBe('complete')
    expect(rB).toBe('complete')

    await new Promise(r => setTimeout(r, 50))
    await recvQueue

    const assemble = (arr: Uint8Array[]): Uint8Array => {
      const total = arr.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(total)
      let o = 0
      for (const c of arr) { out.set(c, o); o += c.byteLength }
      return out
    }
    const aOut = assemble(chunksA)
    const bOut = assemble(chunksB)
    expect(aOut.byteLength).toBe(bytesA.byteLength)
    expect(bOut.byteLength).toBe(bytesB.byteLength)
    expect(await sha256(aOut)).toBe(await sha256(bytesA))
    expect(await sha256(bOut)).toBe(await sha256(bytesB))
  })

  // ── M-i: end-to-end integrity threading ─────────────────────────────────
  it('integrity hex from sender file-end verifies on receiver close', async () => {
    const bytes = new Uint8Array(64 * 1024)
    for (let off = 0; off < bytes.byteLength; off += 65536) {
      crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.byteLength)))
    }
    const file = new File([bytes], 'verified.bin')

    const chunks: Uint8Array[] = []
    const receiver = createFileReceiver(receiverSession, portalWire)
    const sink = new WritableStream<Uint8Array>({ write(c) { chunks.push(c) } })

    let recvQueue = Promise.resolve()
    let closeOk = false
    let closeErr: unknown = null
    connB.on('data', (msg: unknown) => {
      recvQueue = recvQueue.then(async () => {
        if (msg instanceof ArrayBuffer) {
          await receiver.onChunk(parseChunkPacket(msg))
        } else {
          const m = msg as { type: string; index?: number; size?: number; totalChunks?: number; integrity?: string }
          const fileId = portalWire.fileIdForPacketIndex(m.index ?? 0) ?? 'file-0'
          if (m.type === 'file-start') {
            await receiver.onFileStart({ fileId, totalBytes: m.size ?? 0, totalChunks: m.totalChunks ?? 0, sink })
          } else if (m.type === 'file-end') {
            try {
              await receiver.onFileEnd(fileId, m.integrity)
              closeOk = true
            } catch (err) {
              closeErr = err
            }
          }
        }
      })
    })

    const result = await sendFile(senderSession, file, portalWire, { fileId: 'file-0' })
    expect(result).toBe('complete')
    await new Promise(r => setTimeout(r, 50))
    await recvQueue

    expect(closeErr).toBeNull()
    expect(closeOk).toBe(true)
    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    expect(total).toBe(bytes.byteLength)
  })

  it('tampered ciphertext drops chunk → IntegrityError(incomplete) on close', async () => {
    const bytes = new Uint8Array(2 * 256 * 1024) // 2 chunks at default 256 KB
    for (let off = 0; off < bytes.byteLength; off += 65536) {
      crypto.getRandomValues(bytes.subarray(off, Math.min(off + 65536, bytes.byteLength)))
    }
    const file = new File([bytes], 'tampered.bin')

    const receiver = createFileReceiver(receiverSession, portalWire)
    const sink = new WritableStream<Uint8Array>({ write() {} })

    let recvQueue = Promise.resolve()
    let closeErr: IntegrityError | null = null
    let chunkCount = 0
    connB.on('data', (msg: unknown) => {
      recvQueue = recvQueue.then(async () => {
        if (msg instanceof ArrayBuffer) {
          chunkCount++
          // Flip one byte deep inside the second chunk's ciphertext payload
          // (offset past the 6-byte header + 12-byte AES-GCM IV). AES-GCM
          // authentication then rejects the chunk → receiver silently drops
          // it → count check fails on close.
          if (chunkCount === 2) {
            const view = new Uint8Array(msg)
            view[view.byteLength - 4] ^= 0xff
          }
          await receiver.onChunk(parseChunkPacket(msg))
        } else {
          const m = msg as { type: string; index?: number; size?: number; totalChunks?: number; integrity?: string }
          const fileId = portalWire.fileIdForPacketIndex(m.index ?? 0) ?? 'file-0'
          if (m.type === 'file-start') {
            await receiver.onFileStart({ fileId, totalBytes: m.size ?? 0, totalChunks: m.totalChunks ?? 0, sink })
          } else if (m.type === 'file-end') {
            try { await receiver.onFileEnd(fileId, m.integrity) }
            catch (err) { if (err instanceof IntegrityError) closeErr = err }
          }
        }
      })
    })

    const result = await sendFile(senderSession, file, portalWire, { fileId: 'file-0' })
    expect(result).toBe('complete')
    await new Promise(r => setTimeout(r, 50))
    await recvQueue

    expect(closeErr).not.toBeNull()
    expect((closeErr as unknown as IntegrityError).kind).toBe('incomplete')
    // Receiver dropped the entry; further `has` is false.
    expect(receiver.has('file-0')).toBe(false)
  })
})
