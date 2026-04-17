import type { AdaptiveChunker, ChunkPacket } from '../../utils/fileChunker'
import type { Session } from '../session'

export type SendResult = 'complete' | 'cancelled' | 'error'

export interface SendFileOpts {
  fileId: string
  totalChunks?: number
  startChunk?: number
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
  onProgress?: (bytesWritten: number, totalBytes: number) => void
}

export interface FileReceiver {
  onFileStart(opts: RecvOpts): Promise<void>
  onChunk(packet: ChunkPacket): Promise<void>
  onFileEnd(fileId: string): Promise<void>
  abort(fileId: string, reason: 'cancelled' | 'error'): Promise<void>
  getResumeCursor(fileId: string): number
  has(fileId: string): boolean
}

export interface WireAdapter {
  buildFileStart(
    session: Session,
    m: { fileId: string; name: string; size: number; totalChunks: number; startChunk?: number },
  ): Promise<unknown>
  buildFileEnd(session: Session, fileId: string): Promise<unknown>
  buildFileCancelled(session: Session, fileId: string): Promise<unknown>
  encryptChunk(session: Session, plaintext: ArrayBuffer): Promise<ArrayBuffer>
  decryptChunk(session: Session, ciphertext: ArrayBuffer): Promise<ArrayBuffer>
  packetIndexFor(fileId: string): number
  fileIdForPacketIndex(index: number): string | null
}
