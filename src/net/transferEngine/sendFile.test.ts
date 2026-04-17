import { describe, it, expect, vi } from 'vitest'
import { sendFile } from './sendFile'
import { createSession } from '../session'
import type { Session, TransferHandle } from '../session'
import type { WireAdapter } from './types'

function mockAdapter(overrides: Partial<WireAdapter> = {}): WireAdapter {
  return {
    buildFileStart: vi.fn(async (_s, m) => ({ type: 'file-start', index: 0, ...m })),
    buildFileEnd: vi.fn(async (_s, _fileId) => ({ type: 'file-end', index: 0 })),
    buildFileCancelled: vi.fn(async (_s, _fileId) => ({ type: 'file-cancelled', index: 0 })),
    encryptChunk: vi.fn(async (_s, pt) => pt),
    decryptChunk: vi.fn(async (_s, ct) => ct),
    packetIndexFor: vi.fn(() => 0),
    fileIdForPacketIndex: vi.fn(() => 'file-0'),
    ...overrides,
  }
}

function mockConn() {
  return {
    peer: 'peer-x',
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    _dc: {
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      readyState: 'open',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  } as unknown as import('peerjs').DataConnection
}

function mockFile(size: number): File {
  const data = new Uint8Array(size)
  for (let i = 0; i < size; i++) data[i] = i & 0xff
  return new File([data], 'test.bin')
}

function openAndAuth(session: Session): void {
  session.dispatch({ type: 'connect-start' })
  session.dispatch({ type: 'conn-open' })
  session.dispatch({
    type: 'keys-derived',
    encryptKey: {} as CryptoKey,
    fingerprint: 'xx',
  })
}

describe('sendFile', () => {
  it('happy path sends all chunks and returns complete', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(300 * 1024)
    const adapter = mockAdapter()
    const onProgress = vi.fn()

    const result = await sendFile(session, file, adapter, {
      fileId: 'file-0',
      onProgress,
    })

    expect(result).toBe('complete')
    expect(adapter.buildFileStart).toHaveBeenCalledTimes(1)
    expect(adapter.buildFileEnd).toHaveBeenCalledTimes(1)
    expect(adapter.buildFileCancelled).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalled()
  })

  it('cancelled via handle sends file-cancelled and returns cancelled', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(1024 * 1024)
    const adapter = mockAdapter({
      encryptChunk: vi.fn(async (_s, pt) => {
        await new Promise(r => setTimeout(r, 10))
        return pt
      }),
    })

    const p = sendFile(session, file, adapter, { fileId: 'file-0' })

    await new Promise(r => setTimeout(r, 5))
    const handle = session.activeTransfers.get('file-0') as TransferHandle
    handle.aborted = true

    expect(await p).toBe('cancelled')
    expect(adapter.buildFileCancelled).toHaveBeenCalled()
    expect(adapter.buildFileEnd).not.toHaveBeenCalled()
  })

  it('cancelled via AbortSignal returns cancelled', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(1024 * 1024)
    const adapter = mockAdapter({
      encryptChunk: vi.fn(async (_s, pt) => {
        await new Promise(r => setTimeout(r, 10))
        return pt
      }),
    })
    const ac = new AbortController()

    const p = sendFile(session, file, adapter, {
      fileId: 'file-0',
      signal: ac.signal,
    })
    await new Promise(r => setTimeout(r, 5))
    ac.abort()

    expect(await p).toBe('cancelled')
  })

  it('terminal session mid-stream returns error', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(1024 * 1024)
    const adapter = mockAdapter({
      encryptChunk: vi.fn(async (_s, pt) => {
        await new Promise(r => setTimeout(r, 10))
        return pt
      }),
    })

    const p = sendFile(session, file, adapter, { fileId: 'file-0' })
    await new Promise(r => setTimeout(r, 5))
    session.close('peer-disconnect')

    expect(await p).toBe('error')
  })

  it('startChunk skips earlier chunks', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(3 * 256 * 1024)
    const adapter = mockAdapter()

    await sendFile(session, file, adapter, {
      fileId: 'file-0',
      startChunk: 2,
    })

    expect(adapter.encryptChunk).toHaveBeenCalledTimes(1)
  })

  it('empty file emits start + end only', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = new File([new Uint8Array(0)], 'empty.bin')
    const adapter = mockAdapter()

    const result = await sendFile(session, file, adapter, { fileId: 'file-0' })

    expect(result).toBe('complete')
    expect(adapter.encryptChunk).not.toHaveBeenCalled()
    expect(adapter.buildFileEnd).toHaveBeenCalledTimes(1)
  })
})
