import { describe, it, expect } from 'vitest'
import { buildChunkPacket, parseChunkPacket, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from './fileChunker'

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

  it('CHAT_IMAGE_FILE_INDEX is 0xFFFF', () => {
    expect(CHAT_IMAGE_FILE_INDEX).toBe(0xFFFF)
  })
})

describe('AdaptiveChunker', () => {
  it('starts at CHUNK_SIZE (256KB)', () => {
    const c = new AdaptiveChunker()
    expect(c.getChunkSize()).toBe(CHUNK_SIZE)
  })

  it('does not adjust before 3 samples', () => {
    const c = new AdaptiveChunker()
    c.recordTransfer(CHUNK_SIZE, 10) // very fast
    c.recordTransfer(CHUNK_SIZE, 10)
    expect(c.getChunkSize()).toBe(CHUNK_SIZE) // unchanged
  })

  it('grows chunk size when transfers are very fast', () => {
    const c = new AdaptiveChunker()
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 10) // <30ms each
    expect(c.getChunkSize()).toBeGreaterThan(CHUNK_SIZE)
  })

  it('shrinks chunk size when transfers are slow', () => {
    const c = new AdaptiveChunker()
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 500) // >300ms each
    expect(c.getChunkSize()).toBeLessThan(CHUNK_SIZE)
  })

  it('never exceeds 1MB', () => {
    const c = new AdaptiveChunker()
    for (let i = 0; i < 50; i++) c.recordTransfer(1024 * 1024, 5)
    expect(c.getChunkSize()).toBeLessThanOrEqual(1024 * 1024)
  })

  it('never goes below 64KB', () => {
    const c = new AdaptiveChunker()
    for (let i = 0; i < 50; i++) c.recordTransfer(64 * 1024, 1000)
    expect(c.getChunkSize()).toBeGreaterThanOrEqual(64 * 1024)
  })

  it('reset restores default', () => {
    const c = new AdaptiveChunker()
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 10)
    c.reset()
    expect(c.getChunkSize()).toBe(CHUNK_SIZE)
    expect(c.getStats()).toBeNull()
  })

  it('getStats returns null with no measurements', () => {
    expect(new AdaptiveChunker().getStats()).toBeNull()
  })

  it('getStats returns averages after measurements', () => {
    const c = new AdaptiveChunker()
    c.recordTransfer(CHUNK_SIZE, 100)
    const stats = c.getStats()
    expect(stats).not.toBeNull()
    expect(stats.avgThroughput).toBeGreaterThan(0)
    expect(stats.avgTransferTime).toBe(100)
    expect(stats.currentChunkSize).toBe(CHUNK_SIZE)
  })
})

describe('ProgressThrottler', () => {
  it('allows first update immediately', () => {
    const t = new ProgressThrottler(100)
    expect(t.shouldUpdate()).toBe(true)
  })

  it('blocks updates within the interval', () => {
    const t = new ProgressThrottler(100)
    t.shouldUpdate() // first = allowed
    expect(t.shouldUpdate()).toBe(false) // too soon
  })

  it('forceUpdate always returns true', () => {
    const t = new ProgressThrottler(100)
    t.shouldUpdate()
    expect(t.forceUpdate()).toBe(true)
  })
})
