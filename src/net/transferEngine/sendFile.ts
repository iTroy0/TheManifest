// Sender half of the transfer engine. Pure function over
// (session, file, adapter, opts). Triple-abort: handle.aborted,
// session terminal, opts.signal. All converge on one exit path.

import {
  chunkFileAdaptive,
  buildChunkPacket,
  waitForBufferDrain,
} from '../../utils/fileChunker'
import type { Session, TransferHandle } from '../session'
import type { SendFileOpts, SendResult, WireAdapter } from './types'

function isTerminal(s: Session['state']): boolean {
  return s === 'closed' || s === 'error' || s === 'kicked'
}

export async function sendFile(
  session: Session,
  file: File,
  adapter: WireAdapter,
  opts: SendFileOpts,
): Promise<SendResult> {
  const handle: TransferHandle = {
    transferId: opts.fileId,
    direction: 'outbound',
    aborted: false,
    paused: false,
  }
  session.beginTransfer(handle)

  const chunkSize = opts.chunker?.getChunkSize() ?? 256 * 1024
  const totalChunks =
    opts.totalChunks ?? Math.max(1, Math.ceil(file.size / chunkSize))

  let result: SendResult = 'complete'

  try {
    session.send(
      (await adapter.buildFileStart(session, {
        fileId: opts.fileId,
        name: file.name,
        size: file.size,
        totalChunks,
        startChunk: opts.startChunk,
      })) as Record<string, unknown>,
    )
  } catch {
    result = 'error'
  }

  const startAt = opts.startChunk ?? 0
  let chunkIndex = 0
  // Pre-seed bytesSent from the skipped prefix so onProgress reports accurate
  // cumulative bytes during resume. Estimate via chunker's current chunk size;
  // for an adaptive chunker the pre-skipped bytes may have used a different
  // size, but the estimate is good enough for a UI progress bar (receiver's
  // bytesWritten comes from the sink's actual writes, so the on-disk count is
  // always exact).
  let bytesSent = Math.min(file.size, startAt * chunkSize)

  if (result === 'complete' && file.size > 0) {
    // chunkFileAdaptive is an AsyncGenerator with no try/finally and no
    // disposable state (File slicing + arrayBuffer reads are GC-managed).
    // A `break` out of this `for await` triggers the generator's return()
    // which is a no-op here; no resource leak to worry about. Preserve
    // that invariant if this generator ever grows a finalizer.
    for await (const { buffer } of chunkFileAdaptive(file, opts.chunker ?? null)) {
      if (chunkIndex < startAt) {
        chunkIndex++
        continue
      }

      if (handle.aborted) { result = 'cancelled'; break }
      if (isTerminal(session.state)) { result = 'error'; break }
      if (opts.signal?.aborted) { result = 'cancelled'; break }

      if (handle.paused) {
        await new Promise<void>(resolve => {
          handle.pauseResolver = resolve
        })
        if (handle.aborted) { result = 'cancelled'; break }
        if (isTerminal(session.state)) { result = 'error'; break }
        if (opts.signal?.aborted) { result = 'cancelled'; break }
      }

      try {
        const ct = await adapter.encryptChunk(session, buffer)
        const packet = buildChunkPacket(
          adapter.packetIndexFor(opts.fileId),
          chunkIndex,
          ct,
        )
        session.sendBinary(packet)
        await waitForBufferDrain(
          session.conn as unknown as { _dc?: RTCDataChannel },
        )
      } catch {
        result = 'error'
        break
      }

      bytesSent += buffer.byteLength
      opts.onProgress?.(bytesSent, file.size, chunkIndex)
      chunkIndex++
    }
  }

  try {
    if (result === 'cancelled' || result === 'error') {
      if (!isTerminal(session.state)) {
        session.send(
          (await adapter.buildFileCancelled(session, opts.fileId)) as Record<string, unknown>,
        )
      }
    } else {
      session.send(
        (await adapter.buildFileEnd(session, opts.fileId)) as Record<string, unknown>,
      )
    }
  } catch {
    /* peer gone; best-effort */
  }

  session.endTransfer(opts.fileId, result)
  return result
}
