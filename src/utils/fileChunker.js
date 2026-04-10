// Chunk size bounds — used internally by AdaptiveChunker.
const MIN_CHUNK_SIZE = 64 * 1024   // 64KB - for poor connections
const MAX_CHUNK_SIZE = 1024 * 1024 // 1MB - for excellent connections
export const CHUNK_SIZE = 256 * 1024 // 256KB default

// Sentinel fileIndex value used by the chat-image binary transport. Real
// file indices in the manifest are 0..N-1 with N bounded well below this,
// so 0xFFFF is safe to repurpose as "this chunk belongs to an in-flight
// chat image on this connection". The chunk pipeline (buildChunkPacket /
// parseChunkPacket / waitForBufferDrain / receiver chunkQueueRef) is
// reused as-is — only the dispatch in handleChunk branches on this value.
export const CHAT_IMAGE_FILE_INDEX = 0xFFFF

const BUFFER_THRESHOLD = 2 * 1024 * 1024 // 2MB — higher threshold for larger chunks
// Header: 2 bytes file index + 4 bytes chunk index = 6 bytes
const HEADER_SIZE = 6

// Adaptive chunk size calculator based on RTT and throughput
export class AdaptiveChunker {
  constructor() {
    this.currentChunkSize = CHUNK_SIZE
    this.measurements = []
    this.maxMeasurements = 10
  }

  // Record a chunk transfer measurement
  recordTransfer(chunkSize, transferTimeMs) {
    if (transferTimeMs <= 0) return
    const throughput = (chunkSize / transferTimeMs) * 1000 // bytes per second
    this.measurements.push({ chunkSize, transferTimeMs, throughput, timestamp: Date.now() })
    if (this.measurements.length > this.maxMeasurements) {
      this.measurements.shift()
    }
    this.adjustChunkSize()
  }

  adjustChunkSize() {
    if (this.measurements.length < 3) return // Need at least 3 samples

    const recentMeasurements = this.measurements.slice(-5)
    const avgThroughput = recentMeasurements.reduce((sum, m) => sum + m.throughput, 0) / recentMeasurements.length
    const avgTransferTime = recentMeasurements.reduce((sum, m) => sum + m.transferTimeMs, 0) / recentMeasurements.length

    // Target: chunks should take 50-200ms to transfer for responsive progress
    if (avgTransferTime < 30 && this.currentChunkSize < MAX_CHUNK_SIZE) {
      // Transfers too fast - increase chunk size for efficiency
      this.currentChunkSize = Math.min(this.currentChunkSize * 1.5, MAX_CHUNK_SIZE)
    } else if (avgTransferTime > 300 && this.currentChunkSize > MIN_CHUNK_SIZE) {
      // Transfers too slow - decrease chunk size for better progress feedback
      this.currentChunkSize = Math.max(this.currentChunkSize * 0.7, MIN_CHUNK_SIZE)
    }

    // Round to nearest 64KB for alignment
    this.currentChunkSize = Math.round(this.currentChunkSize / (64 * 1024)) * (64 * 1024)
  }

  getChunkSize() {
    return this.currentChunkSize
  }

  getStats() {
    if (this.measurements.length === 0) return null
    const recent = this.measurements.slice(-5)
    return {
      avgThroughput: recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length,
      avgTransferTime: recent.reduce((sum, m) => sum + m.transferTimeMs, 0) / recent.length,
      currentChunkSize: this.currentChunkSize
    }
  }

  reset() {
    this.measurements = []
    this.currentChunkSize = CHUNK_SIZE
  }
}

// Progress throttler to limit UI updates
export class ProgressThrottler {
  constructor(updateIntervalMs = 80) { // ~12fps default
    this.updateIntervalMs = updateIntervalMs
    this.lastUpdate = 0
    this.pendingUpdate = null
  }

  shouldUpdate() {
    const now = Date.now()
    if (now - this.lastUpdate >= this.updateIntervalMs) {
      this.lastUpdate = now
      return true
    }
    return false
  }

  // Force update (for final chunk, file end, etc.)
  forceUpdate() {
    this.lastUpdate = Date.now()
    return true
  }
}

export async function* chunkFileAdaptive(file, chunker) {
  let offset = 0
  while (offset < file.size) {
    const chunkSize = chunker ? chunker.getChunkSize() : CHUNK_SIZE
    const slice = file.slice(offset, offset + chunkSize)
    const buffer = await slice.arrayBuffer()
    yield { buffer, chunkSize, offset }
    offset += chunkSize
  }
}

export function buildChunkPacket(fileIndex, chunkIndex, data) {
  const header = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(header)
  view.setUint16(0, fileIndex, false) // 2 bytes, big-endian
  view.setUint32(2, chunkIndex, false) // 4 bytes, big-endian
  const packet = new Uint8Array(HEADER_SIZE + data.byteLength)
  packet.set(new Uint8Array(header), 0)
  packet.set(new Uint8Array(data), HEADER_SIZE)
  return packet.buffer
}

export function parseChunkPacket(buffer) {
  const view = new DataView(buffer)
  const fileIndex = view.getUint16(0, false)
  const chunkIndex = view.getUint32(2, false)
  const data = buffer.slice(HEADER_SIZE)
  return { fileIndex, chunkIndex, data }
}

export async function waitForBufferDrain(conn) {
  const dc = conn._dc || conn.dataChannel
  if (!dc || dc.readyState === 'closed' || dc.readyState === 'closing') return
  if (dc.bufferedAmount <= BUFFER_THRESHOLD) return

  return new Promise((resolve) => {
    let settled = false
    const done = () => { if (!settled) { settled = true; cleanup(); resolve() } }

    // Race 1: buffer drains normally
    const useLowEvent = typeof dc.onbufferedamountlow !== 'undefined'
    let prevLow = null
    let pollTimer = null

    if (useLowEvent) {
      dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD
      prevLow = dc.onbufferedamountlow
      dc.onbufferedamountlow = done
    } else {
      const poll = () => {
        if (settled) return
        if (!dc || dc.readyState === 'closed' || dc.bufferedAmount <= BUFFER_THRESHOLD) done()
        else pollTimer = setTimeout(poll, 50)
      }
      poll()
    }

    // Race 2: channel dies — resolve so the sender loop can exit
    // instead of hanging forever.
    const onClose = () => done()
    dc.addEventListener('close', onClose)
    dc.addEventListener('error', onClose)

    function cleanup() {
      if (useLowEvent) dc.onbufferedamountlow = prevLow
      if (pollTimer) clearTimeout(pollTimer)
      dc.removeEventListener('close', onClose)
      dc.removeEventListener('error', onClose)
    }
  })
}
