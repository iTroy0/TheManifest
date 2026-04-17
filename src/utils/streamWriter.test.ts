import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// streamWriter.ts runs `streamSaver.mitm = \`\${window.location.origin}/mitm.html\``
// at module load time. Stub window at file top-level so it is defined before
// any import (including the vi.mock factory below).
vi.stubGlobal('window', {
  location: { origin: 'https://example.com' },
  WritableStream: class WritableStream {},
})
vi.stubGlobal('WritableStream', class WritableStream {})

const mockWriter = {
  write: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
  abort: vi.fn().mockResolvedValue(undefined),
}

const mockWriteStream = {
  getWriter: vi.fn().mockReturnValue(mockWriter),
}

const mockCreateWriteStream = vi.fn().mockReturnValue(mockWriteStream)

vi.mock('streamsaver', () => ({
  default: {
    get mitm() { return '' },
    set mitm(_val: string) { /* suppress the module-level assignment */ },
    createWriteStream: mockCreateWriteStream,
  },
}))

import type { FileStreamHandle } from './streamWriter'

describe('isStreamSupported', () => {
  it('returns true when createWriteStream and WritableStream both exist', async () => {
    const { isStreamSupported } = await import('./streamWriter')
    expect(isStreamSupported()).toBe(true)
  })

  it('caches the result and returns the same value on repeated calls', async () => {
    const { isStreamSupported } = await import('./streamWriter')
    const first = isStreamSupported()
    const second = isStreamSupported()
    expect(first).toBe(second)
  })
})

describe('createFileStream', () => {
  beforeEach(() => {
    mockCreateWriteStream.mockReturnValue(mockWriteStream)
    mockWriteStream.getWriter.mockReturnValue(mockWriter)
    mockWriter.write.mockResolvedValue(undefined)
    mockWriter.close.mockResolvedValue(undefined)
    mockWriter.abort.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns a FileStreamHandle object when stream is supported', async () => {
    const { createFileStream } = await import('./streamWriter')
    const handle = createFileStream('test.bin', 1024)
    expect(handle).not.toBeNull()
    expect(typeof handle?.write).toBe('function')
    expect(typeof handle?.close).toBe('function')
    expect(typeof handle?.abort).toBe('function')
  })

  it('passes the fileName and fileSize to createWriteStream', async () => {
    const { createFileStream } = await import('./streamWriter')
    createFileStream('archive.zip', 8192)
    expect(mockCreateWriteStream).toHaveBeenCalledWith('archive.zip', { size: 8192 })
  })

  it('returns null when createWriteStream throws during stream creation', async () => {
    mockCreateWriteStream.mockImplementationOnce(() => { throw new Error('disk full') })
    const { createFileStream } = await import('./streamWriter')
    const handle = createFileStream('fail.bin', 100)
    expect(handle).toBeNull()
  })

  it('returns null when getWriter throws during stream creation', async () => {
    mockWriteStream.getWriter.mockImplementationOnce(() => { throw new Error('no writer') })
    const { createFileStream } = await import('./streamWriter')
    const handle = createFileStream('fail.bin', 100)
    expect(handle).toBeNull()
  })
})

describe('isStreamSupported – WritableStream absent', () => {
  afterEach(() => {
    // Restore for subsequent test files
    vi.stubGlobal('WritableStream', class WritableStream {})
    vi.stubGlobal('window', {
      location: { origin: 'https://example.com' },
      WritableStream: class WritableStream {},
    })
    vi.resetModules()
    // Re-register the mock so subsequent imports in other describes still work
    vi.doMock('streamsaver', () => ({
      default: {
        get mitm() { return '' },
        set mitm(_val: string) { /* no-op */ },
        createWriteStream: mockCreateWriteStream,
      },
    }))
  })

  it('returns false when WritableStream is not defined', async () => {
    vi.stubGlobal('WritableStream', undefined)
    vi.stubGlobal('window', {
      location: { origin: 'https://example.com' },
      WritableStream: undefined,
    })
    vi.resetModules()
    vi.doMock('streamsaver', () => ({
      default: {
        get mitm() { return '' },
        set mitm(_val: string) { /* no-op */ },
        createWriteStream: mockCreateWriteStream,
      },
    }))
    const { isStreamSupported } = await import('./streamWriter')
    expect(isStreamSupported()).toBe(false)
  })

  it('createFileStream returns null when stream is not supported', async () => {
    vi.stubGlobal('WritableStream', undefined)
    vi.stubGlobal('window', {
      location: { origin: 'https://example.com' },
      WritableStream: undefined,
    })
    vi.resetModules()
    vi.doMock('streamsaver', () => ({
      default: {
        get mitm() { return '' },
        set mitm(_val: string) { /* no-op */ },
        createWriteStream: mockCreateWriteStream,
      },
    }))
    const { createFileStream } = await import('./streamWriter')
    expect(createFileStream('test.bin', 100)).toBeNull()
  })
})

describe('FileStreamHandle.write', () => {
  let handle: FileStreamHandle

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCreateWriteStream.mockReturnValue(mockWriteStream)
    mockWriteStream.getWriter.mockReturnValue(mockWriter)
    mockWriter.write.mockResolvedValue(undefined)
    const { createFileStream } = await import('./streamWriter')
    handle = createFileStream('file.bin', 10)!
  })

  it('calls the underlying writer.write with a Uint8Array when given a Uint8Array', async () => {
    const chunk = new Uint8Array([1, 2, 3])
    await handle.write(chunk)
    expect(mockWriter.write).toHaveBeenCalledWith(chunk)
  })

  it('converts an ArrayBuffer to Uint8Array before passing to writer.write', async () => {
    const buffer = new ArrayBuffer(4)
    await handle.write(buffer)
    const written = mockWriter.write.mock.calls[0][0] as Uint8Array
    expect(written).toBeInstanceOf(Uint8Array)
    expect(written.buffer).toBe(buffer)
  })

  it('returns a promise that resolves when writer.write resolves', async () => {
    const p = handle.write(new Uint8Array([0]))
    expect(p).toBeInstanceOf(Promise)
    await expect(p).resolves.toBeUndefined()
  })
})

describe('FileStreamHandle.close', () => {
  let handle: FileStreamHandle

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCreateWriteStream.mockReturnValue(mockWriteStream)
    mockWriteStream.getWriter.mockReturnValue(mockWriter)
    mockWriter.close.mockResolvedValue(undefined)
    const { createFileStream } = await import('./streamWriter')
    handle = createFileStream('file.bin', 10)!
  })

  it('calls the underlying writer.close', async () => {
    await handle.close()
    expect(mockWriter.close).toHaveBeenCalledOnce()
  })

  it('returns a promise that resolves when writer.close resolves', async () => {
    await expect(handle.close()).resolves.toBeUndefined()
  })
})

describe('FileStreamHandle.abort', () => {
  let handle: FileStreamHandle

  beforeEach(async () => {
    vi.clearAllMocks()
    mockCreateWriteStream.mockReturnValue(mockWriteStream)
    mockWriteStream.getWriter.mockReturnValue(mockWriter)
    mockWriter.abort.mockResolvedValue(undefined)
    const { createFileStream } = await import('./streamWriter')
    handle = createFileStream('file.bin', 10)!
  })

  it('calls the underlying writer.abort', async () => {
    await handle.abort()
    expect(mockWriter.abort).toHaveBeenCalledOnce()
  })

  it('returns a promise that resolves when writer.abort resolves', async () => {
    await expect(handle.abort()).resolves.toBeUndefined()
  })
})
