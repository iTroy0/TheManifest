import { describe, it, expect } from 'vitest'
import { buildChunkPacket, parseChunkPacket, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX, AdaptiveChunker, ProgressThrottler } from './fileChunker'

describe('Chunk Packet Build/Parse', () => {
  it('round-trips fileIndex and chunkIndex', () => {
    const data: Uint8Array = new Uint8Array([1, 2, 3, 4, 5])
    const packet: ArrayBuffer = buildChunkPacket(42, 9999, data.buffer as ArrayBuffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(42)
    expect(parsed.chunkIndex).toBe(9999)
    expect(new Uint8Array(parsed.data)).toEqual(data)
  })

  it('handles max fileIndex (65535)', () => {
    const data: Uint8Array = new Uint8Array([10])
    const packet: ArrayBuffer = buildChunkPacket(65535, 0, data.buffer as ArrayBuffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(65535)
  })

  it('handles max chunkIndex (4294967295)', () => {
    const data: Uint8Array = new Uint8Array([10])
    const packet: ArrayBuffer = buildChunkPacket(0, 4294967295, data.buffer as ArrayBuffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.chunkIndex).toBe(4294967295)
  })

  it('handles empty data', () => {
    const packet: ArrayBuffer = buildChunkPacket(0, 0, new ArrayBuffer(0))
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(0)
    expect(parsed.chunkIndex).toBe(0)
    expect(new Uint8Array(parsed.data).length).toBe(0)
  })

  it('preserves 256KB chunk data', () => {
    const data: Uint8Array = new Uint8Array(CHUNK_SIZE)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const packet: ArrayBuffer = buildChunkPacket(1, 1, data.buffer as ArrayBuffer)
    const parsed = parseChunkPacket(packet)
    expect(new Uint8Array(parsed.data)).toEqual(data)
  })

  it('packet size is header + data', () => {
    const data: Uint8Array = new Uint8Array(100)
    const packet: ArrayBuffer = buildChunkPacket(0, 0, data.buffer as ArrayBuffer)
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
    const c: AdaptiveChunker = new AdaptiveChunker()
    expect(c.getChunkSize()).toBe(CHUNK_SIZE)
  })

  it('does not adjust before 3 samples', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    c.recordTransfer(CHUNK_SIZE, 10) // very fast
    c.recordTransfer(CHUNK_SIZE, 10)
    expect(c.getChunkSize()).toBe(CHUNK_SIZE) // unchanged
  })

  it('grows chunk size when transfers are very fast', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 10) // <30ms each
    expect(c.getChunkSize()).toBeGreaterThan(CHUNK_SIZE)
  })

  it('shrinks chunk size when transfers are slow', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 500) // >300ms each
    expect(c.getChunkSize()).toBeLessThan(CHUNK_SIZE)
  })

  it('never exceeds 1MB', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    for (let i = 0; i < 50; i++) c.recordTransfer(1024 * 1024, 5)
    expect(c.getChunkSize()).toBeLessThanOrEqual(1024 * 1024)
  })

  it('never goes below 64KB', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    for (let i = 0; i < 50; i++) c.recordTransfer(64 * 1024, 1000)
    expect(c.getChunkSize()).toBeGreaterThanOrEqual(64 * 1024)
  })

  it('reset restores default', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 10)
    c.reset()
    expect(c.getChunkSize()).toBe(CHUNK_SIZE)
    expect(c.getStats()).toBeNull()
  })

  it('getStats returns null with no measurements', () => {
    expect(new AdaptiveChunker().getStats()).toBeNull()
  })

  it('getStats returns averages after measurements', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    c.recordTransfer(CHUNK_SIZE, 100)
    const stats = c.getStats()
    expect(stats).not.toBeNull()
    expect(stats!.avgThroughput).toBeGreaterThan(0)
    expect(stats!.avgTransferTime).toBe(100)
    expect(stats!.currentChunkSize).toBe(CHUNK_SIZE)
  })
})

describe('ProgressThrottler', () => {
  it('allows first update immediately', () => {
    const t: ProgressThrottler = new ProgressThrottler(100)
    expect(t.shouldUpdate()).toBe(true)
  })

  it('blocks updates within the interval', () => {
    const t: ProgressThrottler = new ProgressThrottler(100)
    t.shouldUpdate() // first = allowed
    expect(t.shouldUpdate()).toBe(false) // too soon
  })

  it('forceUpdate always returns true', () => {
    const t: ProgressThrottler = new ProgressThrottler(100)
    t.shouldUpdate()
    expect(t.forceUpdate()).toBe(true)
  })

  it('allows update at exactly the interval boundary using fake timers', () => {
    // Simulate real-time passage so Date.now() advances
    const start = Date.now()
    let fakeNow = start
    const realDateNow = Date.now
    Date.now = () => fakeNow

    try {
      const t: ProgressThrottler = new ProgressThrottler(100)
      t.shouldUpdate() // consume first slot at fakeNow = start

      // Advance to exactly the boundary
      fakeNow = start + 100
      expect(t.shouldUpdate()).toBe(true) // exactly at boundary — should allow
    } finally {
      Date.now = realDateNow
    }
  })
})

describe('Chunk Packet edge cases', () => {
  it('throws when parsing a buffer shorter than 6 bytes', () => {
    const short: ArrayBuffer = new Uint8Array([0x00, 0x01, 0x00]).buffer
    // DataView will still read but slice(-3 past end) is empty — verify the
    // packet at least doesn't crash the fileIndex/chunkIndex parse
    // A buffer of 3 bytes means chunkIndex read crosses the boundary — WebCrypto
    // DataView throws a RangeError when offset + size exceeds buffer length
    expect(() => parseChunkPacket(short)).toThrow()
  })

  it('parses a packet with exactly 6 bytes (header only, empty data)', () => {
    const packet: ArrayBuffer = buildChunkPacket(7, 42, new ArrayBuffer(0))
    expect(new Uint8Array(packet).length).toBe(6)
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(7)
    expect(parsed.chunkIndex).toBe(42)
    expect(new Uint8Array(parsed.data).length).toBe(0)
  })

  it('parses a truncated packet (6-byte header, data region is empty slice)', () => {
    // Build a 6-byte packet explicitly
    const header = new ArrayBuffer(6)
    const view = new DataView(header)
    view.setUint16(0, 3, false)
    view.setUint32(2, 99, false)
    const parsed = parseChunkPacket(header)
    expect(parsed.fileIndex).toBe(3)
    expect(parsed.chunkIndex).toBe(99)
    expect(new Uint8Array(parsed.data).length).toBe(0)
  })

  it('buildChunkPacket with fileIndex 0 preserves zero correctly', () => {
    const data: Uint8Array = new Uint8Array([0xAB, 0xCD])
    const packet: ArrayBuffer = buildChunkPacket(0, 0, data.buffer as ArrayBuffer)
    const parsed = parseChunkPacket(packet)
    expect(parsed.fileIndex).toBe(0)
    expect(parsed.chunkIndex).toBe(0)
    expect(new Uint8Array(parsed.data)).toEqual(data)
  })
})

describe('AdaptiveChunker additional edge cases', () => {
  it('oscillates chunk size during mixed fast/slow workload', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    const sizes: number[] = []

    // 5 fast transfers -> chunk grows
    for (let i = 0; i < 5; i++) c.recordTransfer(CHUNK_SIZE, 10)
    sizes.push(c.getChunkSize())

    // 5 slow transfers -> chunk shrinks back
    for (let i = 0; i < 5; i++) c.recordTransfer(c.getChunkSize(), 500)
    sizes.push(c.getChunkSize())

    // Chunk size should have moved in both directions
    expect(sizes[0]).toBeGreaterThan(CHUNK_SIZE)
    expect(sizes[1]).toBeLessThan(sizes[0])
  })

  it('reaches max chunk size (1MB) after 10 consecutive very fast transfers', () => {
    const c: AdaptiveChunker = new AdaptiveChunker()
    for (let i = 0; i < 10; i++) c.recordTransfer(1024 * 1024, 5)
    expect(c.getChunkSize()).toBe(1024 * 1024)
  })
})
