// Receiver half of the transfer engine. Stateful factory returning a
// FileReceiver that manages per-file sink writers, enforces M11 monotonic
// resume cursors, and silently drops chunks whose decrypt fails.

import type { Session } from '../session'
import type { ChunkPacket } from '../../utils/fileChunker'
import type { FileReceiver, RecvOpts, WireAdapter } from './types'

interface Entry {
  sink: WritableStream<Uint8Array>
  writer: WritableStreamDefaultWriter<Uint8Array>
  totalChunks: number
  totalBytes: number
  bytesWritten: number
  lastIdx: number
  onProgress?: RecvOpts['onProgress']
}

export function createFileReceiver(
  session: Session,
  adapter: WireAdapter,
): FileReceiver {
  const perFile = new Map<string, Entry>()

  return {
    async onFileStart(opts) {
      const writer = opts.sink.getWriter()
      perFile.set(opts.fileId, {
        sink: opts.sink,
        writer,
        totalChunks: opts.totalChunks,
        totalBytes: opts.totalBytes,
        bytesWritten: 0,
        lastIdx: 0,
        onProgress: opts.onProgress,
      })
    },

    async onChunk(packet: ChunkPacket) {
      const fileId = adapter.fileIdForPacketIndex(packet.fileIndex)
      if (!fileId) return
      const entry = perFile.get(fileId)
      if (!entry) return

      let plaintext: ArrayBuffer
      try {
        plaintext = await adapter.decryptChunk(session, packet.data)
      } catch {
        return
      }

      await entry.writer.write(new Uint8Array(plaintext))
      entry.bytesWritten += plaintext.byteLength
      // M11: cursor is monotonic max — never retreat on out-of-order delivery
      entry.lastIdx = Math.max(entry.lastIdx, packet.chunkIndex + 1)
      entry.onProgress?.(entry.bytesWritten, entry.totalBytes)
    },

    async onFileEnd(fileId) {
      const entry = perFile.get(fileId)
      if (!entry) return
      try {
        await entry.writer.close()
      } finally {
        perFile.delete(fileId)
      }
    },

    async abort(fileId, reason) {
      const entry = perFile.get(fileId)
      if (!entry) return
      try {
        await entry.writer.abort(reason)
      } finally {
        perFile.delete(fileId)
      }
    },

    getResumeCursor(fileId) {
      return perFile.get(fileId)?.lastIdx ?? 0
    },

    has(fileId) {
      return perFile.has(fileId)
    },
  }
}
