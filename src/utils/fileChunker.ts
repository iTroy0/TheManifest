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

interface Measurement {
  chunkSize: number
  transferTimeMs: number
  throughput: number
  timestamp: number
}

export interface ChunkerStats {
  avgThroughput: number
  avgTransferTime: number
  currentChunkSize: number
}

// Adaptive chunk size calculator based on RTT and throughput
export class AdaptiveChunker {
  private currentChunkSize: number
  private measurements: Measurement[]
  private readonly maxMeasurements: number

  constructor() {
    this.currentChunkSize = CHUNK_SIZE
    this.measurements = []
    this.maxMeasurements = 10
  }

  recordTransfer(chunkSize: number, transferTimeMs: number): void {
    if (transferTimeMs <= 0) return
    const throughput = (chunkSize / transferTimeMs) * 1000 // bytes per second
    this.measurements.push({ chunkSize, transferTimeMs, throughput, timestamp: Date.now() })
    if (this.measurements.length > this.maxMeasurements) {
      this.measurements.shift()
    }
    this.adjustChunkSize()
  }

  adjustChunkSize(): void {
    if (this.measurements.length < 3) return // Need at least 3 samples

    const recentMeasurements = this.measurements.slice(-5)
    const avgTransferTime = recentMeasurements.reduce((sum, m) => sum + m.transferTimeMs, 0) / recentMeasurements.length

    // Target: chunks should take 50-200ms to transfer for responsive progress.
    if (avgTransferTime < 30 && this.currentChunkSize < MAX_CHUNK_SIZE) {
      this.currentChunkSize = Math.min(this.currentChunkSize * 1.5, MAX_CHUNK_SIZE)
    } else if (avgTransferTime > 300 && this.currentChunkSize > MIN_CHUNK_SIZE) {
      this.currentChunkSize = Math.max(this.currentChunkSize * 0.7, MIN_CHUNK_SIZE)
    }

    // Round to nearest 64KB for alignment, clamped to MIN_CHUNK_SIZE
    this.currentChunkSize = Math.max(MIN_CHUNK_SIZE, Math.round(this.currentChunkSize / (64 * 1024)) * (64 * 1024))
  }

  getChunkSize(): number {
    return this.currentChunkSize
  }

  getStats(): ChunkerStats | null {
    if (this.measurements.length === 0) return null
    const recent = this.measurements.slice(-5)
    return {
      avgThroughput: recent.reduce((sum, m) => sum + m.throughput, 0) / recent.length,
      avgTransferTime: recent.reduce((sum, m) => sum + m.transferTimeMs, 0) / recent.length,
      currentChunkSize: this.currentChunkSize
    }
  }

  reset(): void {
    this.measurements = []
    this.currentChunkSize = CHUNK_SIZE
  }
}

export class ProgressThrottler {
  private updateIntervalMs: number
  private lastUpdate: number

  constructor(updateIntervalMs = 80) { // ~12fps default
    this.updateIntervalMs = updateIntervalMs
    this.lastUpdate = 0
  }

  shouldUpdate(): boolean {
    const now = Date.now()
    if (now - this.lastUpdate >= this.updateIntervalMs) {
      this.lastUpdate = now
      return true
    }
    return false
  }

  forceUpdate(): boolean {
    this.lastUpdate = Date.now()
    return true
  }
}

export interface ChunkYield {
  buffer: ArrayBuffer
  chunkSize: number
  offset: number
}

export async function* chunkFileAdaptive(file: File, chunker: AdaptiveChunker | null): AsyncGenerator<ChunkYield> {
  let offset = 0
  while (offset < file.size) {
    const chunkSize = chunker ? chunker.getChunkSize() : CHUNK_SIZE
    const slice = file.slice(offset, offset + chunkSize)
    const buffer = await slice.arrayBuffer()
    yield { buffer, chunkSize, offset }
    offset += chunkSize
  }
}

export function buildChunkPacket(fileIndex: number, chunkIndex: number, data: ArrayBuffer): ArrayBuffer {
  const header = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(header)
  view.setUint16(0, fileIndex, false)
  view.setUint32(2, chunkIndex, false)
  const packet = new Uint8Array(HEADER_SIZE + data.byteLength)
  packet.set(new Uint8Array(header), 0)
  packet.set(new Uint8Array(data), HEADER_SIZE)
  return packet.buffer
}

export interface ChunkPacket {
  fileIndex: number
  chunkIndex: number
  data: ArrayBuffer
}

export function parseChunkPacket(buffer: ArrayBuffer): ChunkPacket {
  const view = new DataView(buffer)
  const fileIndex = view.getUint16(0, false)
  const chunkIndex = view.getUint32(2, false)
  const data = buffer.slice(HEADER_SIZE)
  return { fileIndex, chunkIndex, data }
}

interface DataChannelLike {
  _dc?: RTCDataChannel
  dataChannel?: RTCDataChannel
}

export async function waitForBufferDrain(
  conn: DataChannelLike,
  signal?: AbortSignal,
): Promise<void> {
  const dc = conn._dc || conn.dataChannel
  if (!dc || dc.readyState === 'closed' || dc.readyState === 'closing') return
  if (signal?.aborted) throw new DOMException('drain aborted', 'AbortError')
  if (dc.bufferedAmount <= BUFFER_THRESHOLD) return

  return new Promise<void>((resolve, reject) => {
    let settled = false
    const done = () => { if (!settled) { settled = true; cleanup(); resolve() } }

    // Use `in` rather than `typeof dc.onbufferedamountlow !== 'undefined'` — the
    // handler slot always exists (defaults to null, `typeof null === 'object'`),
    // which would leave the polling path dead. Cast to `object` so the `in` check
    // doesn't narrow `dc` to `never` in the else branch.
    const useLowEvent = 'onbufferedamountlow' in (dc as object)
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let drainTimeout: ReturnType<typeof setTimeout> | null = null

    if (useLowEvent) {
      dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD
      dc.addEventListener('bufferedamountlow', done, { once: true })
      // Belt-and-braces: poll at a low rate in case the event never fires
      // (readyState transitions can swallow it).
      const poll = (): void => {
        if (settled) return
        if (dc.readyState === 'closed' || dc.bufferedAmount <= BUFFER_THRESHOLD) done()
        else pollTimer = setTimeout(poll, 500)
      }
      pollTimer = setTimeout(poll, 500)
    } else {
      const poll = (): void => {
        if (settled) return
        if (dc.readyState === 'closed' || dc.bufferedAmount <= BUFFER_THRESHOLD) done()
        else pollTimer = setTimeout(poll, 50)
      }
      poll()
    }

    const onClose = () => done()
    dc.addEventListener('close', onClose)
    dc.addEventListener('error', onClose)

    // Caller-controlled cancellation (session.close, transfer-cancel, explicit
    // opts.signal). Rejects so sendFile's try/catch exits the loop on the
    // next tick rather than waiting up to 60 s for the drain timer.
    const onAbort = (): void => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new DOMException('drain aborted', 'AbortError'))
      }
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })

    // Timeout rejects (not resolves) so callers can detect a stalled channel
    // and abort rather than piling chunks into a dead buffer.
    // Scale to actual bufferedAmount at 128 KB/s floor — a flat 15 s cap
    // killed big transfers on slow links before the buffer could drain.
    // Clamped between 15 s and 60 s.
    const MIN_THROUGHPUT_BPS = 128 * 1024
    const scaled = Math.ceil((dc.bufferedAmount / MIN_THROUGHPUT_BPS) * 2000)
    const drainTimeoutMs = Math.min(60_000, Math.max(15_000, scaled))
    drainTimeout = setTimeout(() => {
      if (!settled) {
        settled = true
        cleanup()
        reject(new Error('Buffer drain timeout — channel may be stalled'))
      }
    }, drainTimeoutMs)

    function cleanup(): void {
      if (!dc) return
      if (useLowEvent) dc.removeEventListener('bufferedamountlow', done)
      if (pollTimer) clearTimeout(pollTimer)
      if (drainTimeout) clearTimeout(drainTimeout)
      dc.removeEventListener('close', onClose)
      dc.removeEventListener('error', onClose)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  })
}
