// Sender half of the transfer engine. Pure function over
// (session, file, adapter, opts). Triple-abort: handle.aborted,
// session terminal, opts.signal. All converge on one exit path.

import {
  chunkFileAdaptive,
  buildChunkPacket,
  waitForBufferDrain,
} from '../../utils/fileChunker'
import {
  EMPTY_INTEGRITY_CHAIN,
  bytesToHex,
  chainNextHash,
} from '../../utils/crypto'
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

  // Unified cancellation: session close, transfer-cancel for this fileId, or
  // caller-supplied opts.signal all trip one AbortController. Threaded into
  // waitForBufferDrain so cancel during a multi-megabyte queued buffer exits
  // in <1 ms instead of waiting up to 60 s for the drain timer.
  const abortCtrl = new AbortController()
  const unsubs: Array<() => void> = []
  unsubs.push(session.on('closed', () => abortCtrl.abort()))
  unsubs.push(
    session.on('transfer-cancel', ev => {
      if (ev.transferId === opts.fileId) abortCtrl.abort()
    }),
  )
  if (opts.signal) {
    if (opts.signal.aborted) abortCtrl.abort()
    else opts.signal.addEventListener('abort', () => abortCtrl.abort(), { once: true })
  }

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
    // L-e: surface the failure to the progress callback so the UI can flip
    // to an error state immediately instead of sitting at 0% until the
    // caller observes `endTransfer` emit `'error'`.
    result = 'error'
    opts.onProgress?.(0, file.size, -1)
  }

  const startAt = opts.startChunk ?? 0
  let chunkIndex = 0
  // Prefer the caller's exact seed (true pre-resume bytes). Fallback to
  // an estimate when the caller didn't provide one — the guess assumes
  // `chunkSize` for every skipped chunk, which drifts when the adaptive
  // chunker changed size mid-session. Clamp both into `[0, file.size]`.
  let bytesSent = Number.isFinite(opts.resumedBytes)
    ? Math.max(0, Math.min(file.size, Math.floor(opts.resumedBytes as number)))
    : Math.min(file.size, startAt * chunkSize)
  // M-i: rolling chain hash over plaintext bytes. Skipped on resumed
  // transfers — we'd be hashing only the tail and the receiver has nothing
  // to compare against. The receiver's chunk-count check still catches
  // truncation in that mode.
  const computeIntegrity = startAt === 0
  let integrityChain: Uint8Array = EMPTY_INTEGRITY_CHAIN

  if (result === 'complete' && file.size > 0) {
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
        if (computeIntegrity) {
          integrityChain = await chainNextHash(integrityChain, buffer)
        }
        const ct = await adapter.encryptChunk(session, buffer)
        const packet = buildChunkPacket(
          adapter.packetIndexFor(opts.fileId),
          chunkIndex,
          ct,
        )
        session.sendBinary(packet)
        await waitForBufferDrain(
          session.conn as unknown as { _dc?: RTCDataChannel },
          abortCtrl.signal,
        )
      } catch (err) {
        // AbortError from drain means the cancellation channel fired; route
        // to 'cancelled'. Any other error (drain timeout, send throw) stays
        // as 'error' so the UI surfaces a failure rather than a silent stop.
        if (err instanceof DOMException && err.name === 'AbortError') {
          result = 'cancelled'
        } else {
          result = 'error'
        }
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
      const integrity = computeIntegrity ? bytesToHex(integrityChain) : undefined
      session.send(
        (await adapter.buildFileEnd(session, opts.fileId, integrity)) as Record<string, unknown>,
      )
    }
  } catch {
    /* peer gone; best-effort */
  }

  for (const u of unsubs) u()
  session.endTransfer(opts.fileId, result)
  return result
}
