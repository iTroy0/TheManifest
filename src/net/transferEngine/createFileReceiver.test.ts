import { describe, it, expect, vi } from 'vitest'
import { createFileReceiver } from './createFileReceiver'
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
})
