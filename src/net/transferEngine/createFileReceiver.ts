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
  maxBytes: number
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
      // Clamp resume hints into valid bounds. A malicious or buggy peer could
      // send Number.MAX_SAFE_INTEGER / NaN / negative for resumedChunks and
      // poison the cursor, permanently dropping every subsequent chunk.
      const rc = Number.isFinite(opts.resumedChunks) ? (opts.resumedChunks ?? 0) : 0
      const rb = Number.isFinite(opts.resumedBytes) ? (opts.resumedBytes ?? 0) : 0
      const lastIdx = Math.max(0, Math.min(opts.totalChunks, Math.floor(rc)))
      const bytesWritten = Math.max(0, Math.min(opts.totalBytes, Math.floor(rb)))
      const maxBytes = Number.isFinite(opts.maxInMemoryBytes)
        ? Math.max(0, opts.maxInMemoryBytes as number)
        : Number.POSITIVE_INFINITY
      perFile.set(opts.fileId, {
        sink: opts.sink,
        writer,
        totalChunks: opts.totalChunks,
        totalBytes: opts.totalBytes,
        bytesWritten,
        lastIdx,
        maxBytes,
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

      // Memory-sink guardrail. When a caller opted into the in-memory
      // fallback path (Safari private, iOS, old Edge — no StreamSaver SW),
      // they pass `maxInMemoryBytes`. Cross the cap → abort the writer and
      // drop the entry before committing bytes, so the tab doesn't OOM on
      // an oversized (or malicious) transfer.
      if (entry.bytesWritten + plaintext.byteLength > entry.maxBytes) {
        const err = new Error(`in-memory cap exceeded (${entry.maxBytes} bytes)`)
        try { void entry.writer.abort(err).catch(() => {}) } catch { /* noop */ }
        perFile.delete(fileId)
        return
      }

      // Sink write can reject long after the chunk was accepted — StreamSaver
      // service worker death, user-cancelled download, disk full, in-memory
      // fallback OOM. Before this guard, a write rejection left the entry in
      // perFile and every subsequent chunk threw unhandled to the hook's
      // inbound handler. Treat any write failure as terminal for this fileId:
      // abort the writer and drop the entry so the transfer can be retried.
      try {
        await entry.writer.write(new Uint8Array(plaintext))
      } catch (err) {
        try { void entry.writer.abort(err).catch(() => {}) } catch { /* noop */ }
        perFile.delete(fileId)
        return
      }
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
