import { describe, it, expect } from 'vitest'
import { buildChunkPacket, parseChunkPacket, CHUNK_SIZE } from './fileChunker'

describe('Chunk Packet Build/Parse', () => {
  it('round-trips fileIndex and chunkIndex', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    const packet = buildChunkPacket(42, 9999, data.buffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(42)
    expect(parsed.chunkIndex).toBe(9999)
    expect(new Uint8Array(parsed.data)).toEqual(data)
  })

  it('handles max fileIndex (65535)', () => {
    const data = new Uint8Array([10])
    const packet = buildChunkPacket(65535, 0, data.buffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(65535)
  })

  it('handles max chunkIndex (4294967295)', () => {
    const data = new Uint8Array([10])
    const packet = buildChunkPacket(0, 4294967295, data.buffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.chunkIndex).toBe(4294967295)
  })

  it('handles empty data', () => {
    const packet = buildChunkPacket(0, 0, new ArrayBuffer(0))
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(0)
    expect(parsed.chunkIndex).toBe(0)
    expect(new Uint8Array(parsed.data).length).toBe(0)
  })

  it('preserves 256KB chunk data', () => {
    const data = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const packet = buildChunkPacket(1, 1, data.buffer)
    const parsed = parseChunkPacket(packet)
    expect(new Uint8Array(parsed.data)).toEqual(data)
  })

  it('packet size is header + data', () => {
    const data = new Uint8Array(100)
    const packet = buildChunkPacket(0, 0, data.buffer)
    expect(new Uint8Array(packet).length).toBe(6 + 100) // 6-byte header
  })
})

describe('Constants', () => {
  it('chunk size is 256KB', () => {
    expect(CHUNK_SIZE).toBe(256 * 1024)
  })
})
