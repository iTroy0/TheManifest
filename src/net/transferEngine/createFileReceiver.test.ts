import { describe, it, expect, vi } from 'vitest'
import { createFileReceiver } from './createFileReceiver'
import { IntegrityError } from './types'
import { EMPTY_INTEGRITY_CHAIN, bytesToHex, chainNextHash } from '../../utils/crypto'
import type { Session } from '../session'
import type { ChunkPacket } from '../../utils/fileChunker'
import type { WireAdapter } from './types'

function mockAdapter(): WireAdapter {
  return {
    buildFileStart: vi.fn(),
    buildFileEnd: vi.fn(),
    buildFileCancelled: vi.fn(),
    encryptChunk: vi.fn(),
    decryptChunk: vi.fn(async (_s, ct) => ct),
    packetIndexFor: vi.fn(() => 0),
    fileIdForPacketIndex: vi.fn((i: number) => i === 0 ? 'file-0' : null),
  }
}

function accumulatingSink(): { stream: WritableStream<Uint8Array>; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = []
  const stream = new WritableStream<Uint8Array>({
    write(chunk) { chunks.push(chunk) },
  })
  return {
    stream,
    bytes: () => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.byteLength }
      return out
    },
  }
}

function pkt(chunkIndex: number, bytes: Uint8Array): ChunkPacket {
  const ab = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(ab).set(bytes)
  return { fileIndex: 0, chunkIndex, data: ab }
}

function mockSession(): Session {
  return { encryptKey: {} as CryptoKey } as unknown as Session
}

describe('createFileReceiver', () => {
  it('writes chunks and closes writer on fileEnd', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 3, totalChunks: 1, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([7, 8, 9])))
    expect(recv.has('file-0')).toBe(true)
    await recv.onFileEnd('file-0')

    expect(sink.bytes()).toEqual(new Uint8Array([7, 8, 9]))
    expect(recv.has('file-0')).toBe(false)
  })

  it('resume cursor is monotonic max (out-of-order chunks)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 30, totalChunks: 3, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1])))
    expect(recv.getResumeCursor('file-0')).toBe(1)
    await recv.onChunk(pkt(2, new Uint8Array([2])))
    expect(recv.getResumeCursor('file-0')).toBe(3)
    await recv.onChunk(pkt(1, new Uint8Array([3])))
    expect(recv.getResumeCursor('file-0')).toBe(3)
  })

  it('drops chunk for unknown packet index', async () => {
    const session = mockSession()
    const adapter: WireAdapter = { ...mockAdapter(), fileIdForPacketIndex: () => null }
    const recv = createFileReceiver(session, adapter)

    await recv.onChunk({ fileIndex: 99, chunkIndex: 0, data: new ArrayBuffer(4) })
    expect(recv.has('file-0')).toBe(false)
  })

  it('drops chunk when no active fileStart for that fileId', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)

    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    expect(recv.has('file-0')).toBe(false)
  })

  it('decrypt failure drops chunk silently (cursor unchanged)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    adapter.decryptChunk = vi.fn(async () => { throw new Error('boom') })
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 3, totalChunks: 1, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))

    expect(recv.getResumeCursor('file-0')).toBe(0)
    expect(sink.bytes().byteLength).toBe(0)
  })

  it('abort aborts the writer and deletes the entry', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const abortSpy = vi.fn()
    const stream = new WritableStream<Uint8Array>({
      write() {},
      abort(reason) { abortSpy(reason) },
    })

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 10, totalChunks: 1, sink: stream })
    await recv.abort('file-0', 'cancelled')

    expect(abortSpy).toHaveBeenCalledWith('cancelled')
    expect(recv.has('file-0')).toBe(false)
  })

  it('onProgress fires with bytes-so-far and total', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()
    const progress = vi.fn()

    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 6, totalChunks: 2,
      sink: sink.stream, onProgress: progress,
    })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    await recv.onChunk(pkt(1, new Uint8Array([4, 5, 6])))

    expect(progress).toHaveBeenNthCalledWith(1, 3, 6)
    expect(progress).toHaveBeenNthCalledWith(2, 6, 6)
  })

  it('resumedBytes + resumedChunks seed the entry on onFileStart', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()
    const progress = vi.fn()

    // Resume scenario: peer already wrote 100 bytes across chunks 0..4.
    // First inbound chunk here is chunk index 5. Engine should report
    // 103 bytes (100 seed + 3 new) and resume cursor = 6.
    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 200, totalChunks: 10,
      sink: sink.stream,
      resumedBytes: 100,
      resumedChunks: 5,
      onProgress: progress,
    })
    expect(recv.getResumeCursor('file-0')).toBe(5)

    await recv.onChunk(pkt(5, new Uint8Array([1, 2, 3])))
    expect(recv.getResumeCursor('file-0')).toBe(6)
    expect(progress).toHaveBeenCalledWith(103, 200)
  })

  it('clamps malicious resumedChunks / resumedBytes to valid bounds', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 100, totalChunks: 10,
      sink: sink.stream,
      resumedBytes: Number.MAX_SAFE_INTEGER,
      resumedChunks: Number.MAX_SAFE_INTEGER,
    })
    expect(recv.getResumeCursor('file-0')).toBe(10)

    await recv.abort('file-0', 'cancelled')
    const sink2 = accumulatingSink()
    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 100, totalChunks: 10,
      sink: sink2.stream,
      resumedBytes: -5,
      resumedChunks: -3,
    })
    expect(recv.getResumeCursor('file-0')).toBe(0)

    await recv.abort('file-0', 'cancelled')
    const sink3 = accumulatingSink()
    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 100, totalChunks: 10,
      sink: sink3.stream,
      resumedBytes: Number.NaN,
      resumedChunks: Number.NaN,
    })
    expect(recv.getResumeCursor('file-0')).toBe(0)
  })

  it('aborts and drops entry when in-memory cap is exceeded', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    // Cap at 4 bytes. First chunk (3 bytes) fits; second (3 bytes) would push
    // bytesWritten to 6 which exceeds the cap, so the entry should abort.
    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 10, totalChunks: 4,
      sink: sink.stream, maxInMemoryBytes: 4,
    })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    expect(recv.has('file-0')).toBe(true)
    await recv.onChunk(pkt(1, new Uint8Array([4, 5, 6])))
    expect(recv.has('file-0')).toBe(false)
  })

  // ── M-i: integrity verification ──────────────────────────────────────
  async function expectedChain(plaintexts: Uint8Array[]): Promise<string> {
    let acc = EMPTY_INTEGRITY_CHAIN
    for (const p of plaintexts) acc = await chainNextHash(acc, p)
    return bytesToHex(acc)
  }

  it('passes when expected integrity matches the rolling chain hash', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    const c0 = new Uint8Array([1, 2, 3])
    const c1 = new Uint8Array([4, 5, 6])
    const integrity = await expectedChain([c0, c1])

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 6, totalChunks: 2, sink: sink.stream })
    await recv.onChunk(pkt(0, c0))
    await recv.onChunk(pkt(1, c1))
    await expect(recv.onFileEnd('file-0', integrity)).resolves.toBeUndefined()
    expect(sink.bytes()).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    expect(recv.has('file-0')).toBe(false)
  })

  it('throws IntegrityError(mismatch) and aborts writer when chain hash differs', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const abortSpy = vi.fn()
    const stream = new WritableStream<Uint8Array>({
      write() {},
      abort(reason) { abortSpy(reason) },
    })

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 3, totalChunks: 1, sink: stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))

    const wrongHash = '0'.repeat(64)
    await expect(recv.onFileEnd('file-0', wrongHash)).rejects.toBeInstanceOf(IntegrityError)
    // Abort fires synchronously before throw so the partial file is discarded.
    expect(abortSpy).toHaveBeenCalled()
    expect(recv.has('file-0')).toBe(false)
  })

  it('throws IntegrityError(incomplete) when chunk count is short, even without expected hash', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const abortSpy = vi.fn()
    const stream = new WritableStream<Uint8Array>({
      write() {},
      abort(reason) { abortSpy(reason) },
    })

    // Declare 3 chunks expected, only deliver 2.
    await recv.onFileStart({ fileId: 'file-0', totalBytes: 9, totalChunks: 3, sink: stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    await recv.onChunk(pkt(1, new Uint8Array([4, 5, 6])))

    await expect(recv.onFileEnd('file-0')).rejects.toMatchObject({
      name: 'IntegrityError',
      kind: 'incomplete',
      fileId: 'file-0',
    })
    expect(abortSpy).toHaveBeenCalled()
    expect(recv.has('file-0')).toBe(false)
  })

  it('count check passes despite duplicate chunk arrivals (Set dedupe)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 6, totalChunks: 2, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    // Duplicate of chunk 0 — Set add idempotent → still need chunk 1.
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))

    await expect(recv.onFileEnd('file-0')).rejects.toMatchObject({ kind: 'incomplete' })
  })

  it('skips integrity check when sender omitted hash (back-compat)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 3, totalChunks: 1, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    // No expectedIntegrity → only count check; passes.
    await expect(recv.onFileEnd('file-0')).resolves.toBeUndefined()
    expect(sink.bytes()).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('decrypt failure results in IntegrityError(incomplete) on close', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    let calls = 0
    adapter.decryptChunk = vi.fn(async (_s, ct) => {
      calls++
      if (calls === 2) throw new Error('boom')
      return ct
    })
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 6, totalChunks: 2, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    await recv.onChunk(pkt(1, new Uint8Array([4, 5, 6])))

    await expect(recv.onFileEnd('file-0')).rejects.toMatchObject({ kind: 'incomplete' })
  })

  it('out-of-order delivery disables chain hash but still passes count check', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    const c0 = new Uint8Array([1, 2, 3])
    const c1 = new Uint8Array([4, 5, 6])
    const inOrderHash = await expectedChain([c0, c1])

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 6, totalChunks: 2, sink: sink.stream })
    // Out of order: chunk 1 first, then chunk 0.
    await recv.onChunk(pkt(1, c1))
    await recv.onChunk(pkt(0, c0))

    // With expected hash that assumed in-order delivery, the receiver
    // disabled chain comparison. Count check passes → close succeeds.
    await expect(recv.onFileEnd('file-0', inOrderHash)).resolves.toBeUndefined()
  })

  it('drops entry when writer.write rejects (avoids orphan + unhandled rejection)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    // Streams spec: once a sink's write() rejects, the stream enters the
    // errored state and the sink's abort() is not invoked. We only assert
    // the outcomes that actually matter: the entry is removed and further
    // chunks no-op silently (no unhandled promise rejection).
    const stream = new WritableStream<Uint8Array>({
      write() { return Promise.reject(new Error('sink dead')) },
    })

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 6, totalChunks: 2, sink: stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    expect(recv.has('file-0')).toBe(false)

    // Subsequent chunk is a no-op: entry is gone, cursor returns default 0.
    await recv.onChunk(pkt(1, new Uint8Array([4, 5, 6])))
    expect(recv.getResumeCursor('file-0')).toBe(0)
  })
})
