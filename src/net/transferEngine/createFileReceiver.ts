// Receiver half of the transfer engine. Stateful factory returning a
// FileReceiver that manages per-file sink writers, enforces M11 monotonic
// resume cursors, and silently drops chunks whose decrypt fails.

import type { Session } from '../session'
import type { ChunkPacket } from '../../utils/fileChunker'
import { EMPTY_INTEGRITY_CHAIN, bytesToHex, chainNextHash } from '../../utils/crypto'
import { IntegrityError, type FileReceiver, type RecvOpts, type WireAdapter } from './types'

interface Entry {
  sink: WritableStream<Uint8Array>
  writer: WritableStreamDefaultWriter<Uint8Array>
  totalChunks: number
  totalBytes: number
  bytesWritten: number
  lastIdx: number
  maxBytes: number
  onProgress?: RecvOpts['onProgress']
  // M-i: chunk-count check. `Set` rather than counter so duplicate arrivals
  // (network retransmit, broken peer) don't double-count and falsely satisfy
  // the totalChunks check. Pre-seeded with `[0..resumedChunks)` so resumed
  // transfers also pass the check.
  receivedChunks: Set<number>
  // M-i: rolling chain hash of decrypted plaintext. Skipped (`null`) when
  // the transfer started mid-stream — the sender can't replay hashes for
  // skipped chunks, so the chain wouldn't match. The chunk-count check
  // still runs in that mode.
  integrityChain: Uint8Array | null
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
      // Seed the count-check set with already-received chunk indices so a
      // resumed transfer's count check still passes when totalChunks worth
      // of indices have been written across all attempts.
      const receivedChunks = new Set<number>()
      for (let i = 0; i < lastIdx; i++) receivedChunks.add(i)
      perFile.set(opts.fileId, {
        sink: opts.sink,
        writer,
        totalChunks: opts.totalChunks,
        totalBytes: opts.totalBytes,
        bytesWritten,
        lastIdx,
        maxBytes,
        onProgress: opts.onProgress,
        receivedChunks,
        // Resumed transfers can't verify the chain hash — the prior attempt's
        // chunks aren't in this entry's accumulator. Disable integrity here;
        // the sender also skips emitting `integrity` on resume (see sendFile).
        integrityChain: lastIdx > 0 ? null : EMPTY_INTEGRITY_CHAIN,
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
      // M-i count check: dedupe via Set (duplicate arrivals would otherwise
      // double-count and let a truncated transfer pass the totalChunks check).
      entry.receivedChunks.add(packet.chunkIndex)
      // M-i chain hash. Only chunks delivered IN ORDER contribute to the
      // chain — reordered arrival would scramble the hash without
      // implying corruption. The count check + write order are still
      // enforced; the chain is the additional substitution-detection layer
      // that requires deterministic input order.
      if (entry.integrityChain && packet.chunkIndex + 1 === entry.receivedChunks.size) {
        entry.integrityChain = await chainNextHash(entry.integrityChain, plaintext)
      } else if (entry.integrityChain) {
        // Out-of-order delivery breaks the chain hash but not the count
        // check. Disable hash verification for this entry; the count
        // check + per-chunk AES-GCM still cover truncation + corruption.
        entry.integrityChain = null
      }
      entry.onProgress?.(entry.bytesWritten, entry.totalBytes)
    },

    async onFileEnd(fileId, expectedIntegrity) {
      const entry = perFile.get(fileId)
      if (!entry) return
      // M-i count check. Catches: silent decrypt failures (`onChunk` returns
      // without writing), silent write failures (entry dropped pre-end is
      // fine — we early-returned above; mid-stream sink failures still
      // arrive at `onFileEnd` if the failing chunk wasn't the last one),
      // and missing chunks (sender skipped a request, peer dropped packets).
      if (entry.receivedChunks.size !== entry.totalChunks) {
        try { void entry.writer.abort(new Error('integrity: incomplete')).catch(() => {}) } catch { /* noop */ }
        perFile.delete(fileId)
        throw new IntegrityError(
          'incomplete',
          fileId,
          `received ${entry.receivedChunks.size}/${entry.totalChunks} chunks`,
        )
      }
      // M-i chain hash check. Skipped when:
      //  - sender omitted `integrity` (resume / pre-M-i peer)
      //  - receiver disabled chain (resume / out-of-order arrival)
      // The count check above is the always-on layer; the chain hash adds
      // detection for substituted bytes that AES-GCM somehow waved through
      // (key compromise scenarios) and reordered chunks that landed under
      // a peer ignoring the ordered=true datachannel default.
      if (expectedIntegrity && entry.integrityChain) {
        const actual = bytesToHex(entry.integrityChain)
        if (actual !== expectedIntegrity) {
          try { void entry.writer.abort(new Error('integrity: mismatch')).catch(() => {}) } catch { /* noop */ }
          perFile.delete(fileId)
          throw new IntegrityError(
            'mismatch',
            fileId,
            `chain hash differs (expected ${expectedIntegrity}, got ${actual})`,
          )
        }
      }
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
