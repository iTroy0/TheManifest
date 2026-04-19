import type { AdaptiveChunker, ChunkPacket } from '../../utils/fileChunker'
import type { Session } from '../session'

export type SendResult = 'complete' | 'cancelled' | 'error'

export interface SendFileOpts {
  fileId: string
  totalChunks?: number
  startChunk?: number
  // Byte counter seed for resume. Adaptive chunkers may have used a
  // different size for the skipped region, so the caller (hook) passes
  // the true pre-resume bytes rather than letting the engine guess.
  resumedBytes?: number
  chunker?: AdaptiveChunker
  signal?: AbortSignal
  onProgress?: (bytesSent: number, totalBytes: number, chunkIndex: number) => void
}

export interface RecvOpts {
  fileId: string
  totalBytes: number
  totalChunks: number
  sink: WritableStream<Uint8Array>
  // Optional resume seeds. When a transfer resumes mid-file, the caller
  // (hook) should read `FileStartMsg.resumeFrom` (or the equivalent wire
  // field) and pass the pre-skipped byte + chunk counts so progress and
  // getResumeCursor report accurate values from the first inbound chunk.
  resumedBytes?: number
  resumedChunks?: number
  // Memory guardrail for the in-memory fallback sink path (Safari private,
  // iOS, old Edge — no StreamSaver service worker available). The engine
  // aborts the writer and drops the entry once `bytesWritten` exceeds this
  // cap. Omit for disk-backed sinks; 512 MiB is a reasonable default.
  maxInMemoryBytes?: number
  onProgress?: (bytesWritten: number, totalBytes: number) => void
}

export interface FileReceiver {
  onFileStart(opts: RecvOpts): Promise<void>
  onChunk(packet: ChunkPacket): Promise<void>
  // `expectedIntegrity` is the hex chain hash from `FileEndMsg.integrity` /
  // `collab-file-end.integrity`. When omitted (peer pre-dates M-i, or sender
  // skipped it on resume), only the chunk-count check runs. Throws
  // `IntegrityError` on either check failing — caller (hook) catches to
  // dispatch a UI error.
  onFileEnd(fileId: string, expectedIntegrity?: string): Promise<void>
  abort(fileId: string, reason: 'cancelled' | 'error'): Promise<void>
  getResumeCursor(fileId: string): number
  has(fileId: string): boolean
}

export interface WireAdapter {
  buildFileStart(
    session: Session,
    m: { fileId: string; name: string; size: number; totalChunks: number; startChunk?: number },
  ): Promise<unknown>
  // `integrity` is the hex-encoded rolling chain hash. Adapters serialize it
  // into the wire message when present; receivers verify before close. Omitted
  // by sendFile only on resumed transfers (startChunk > 0), where the sender
  // can't replay the hash for skipped chunks — see M-i.
  buildFileEnd(session: Session, fileId: string, integrity?: string): Promise<unknown>
  buildFileCancelled(session: Session, fileId: string): Promise<unknown>
  encryptChunk(session: Session, plaintext: ArrayBuffer): Promise<ArrayBuffer>
  decryptChunk(session: Session, ciphertext: ArrayBuffer): Promise<ArrayBuffer>
  packetIndexFor(fileId: string): number
  fileIdForPacketIndex(index: number): string | null
}

// Thrown by `FileReceiver.onFileEnd` when the chunk-count check or the
// optional integrity-hash check fails. The receiver aborts the underlying
// writer before throwing so the sink ends up in the errored state and any
// partially-written disk file is deleted by StreamSaver / closed cleanly by
// the in-memory fallback. Callers (hooks) catch this to dispatch a UI error
// instead of letting the file silently truncate.
export class IntegrityError extends Error {
  // 'incomplete' = chunk-count check failed (truncation).
  // 'mismatch'   = chain hash differs (substitution / reorder / corruption).
  readonly kind: 'incomplete' | 'mismatch'
  readonly fileId: string
  constructor(kind: 'incomplete' | 'mismatch', fileId: string, message: string) {
    super(message)
    this.name = 'IntegrityError'
    this.kind = kind
    this.fileId = fileId
  }
}
