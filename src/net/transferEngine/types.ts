// src/net/transferEngine/types.ts
//
// Shared types for the transfer engine. Implementations live in
// sibling files; this module is type-only.

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
    m: { fileId: string; name: string; size: number; totalChunks: number },
  ): Promise<unknown>
  buildFileEnd(session: Session, fileId: string): Promise<unknown>
  buildFileCancelled(session: Session, fileId: string): Promise<unknown>
  encryptChunk(session: Session, plaintext: ArrayBuffer): Promise<ArrayBuffer>
  decryptChunk(session: Session, ciphertext: ArrayBuffer): Promise<ArrayBuffer>
  packetIndexFor(fileId: string): number
  fileIdForPacketIndex(index: number): string | null
}
