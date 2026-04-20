// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { prepareImage, ImageTooLargeError } from './chatImage'

function makeFile(content: Uint8Array | string, type: string, name = 'pic'): File {
  return new File([content as BlobPart], name, { type })
}

describe('prepareImage — GIF path', () => {
  it('passes through small GIFs without recompression', async () => {
    const bytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
    const file = makeFile(bytes, 'image/gif', 'tiny.gif')
    const trackedUrls: Blob[] = []
    const createTrackedBlobUrl = vi.fn((blob: Blob) => {
      trackedUrls.push(blob)
      return 'blob:gif-stub-1'
    })

    const out = await prepareImage(file, createTrackedBlobUrl)

    expect(out.mime).toBe('image/gif')
    expect(out.url).toBe('blob:gif-stub-1')
    expect(out.bytes).toEqual(bytes)
    expect(createTrackedBlobUrl).toHaveBeenCalledOnce()
    expect(trackedUrls[0].type).toBe('image/gif')
    expect(trackedUrls[0].size).toBe(bytes.byteLength)
  })

  it('throws ImageTooLargeError for GIFs over 3 MB', async () => {
    const bigBytes = new Uint8Array(3 * 1024 * 1024 + 1)
    const file = makeFile(bigBytes, 'image/gif', 'big.gif')
    const createTrackedBlobUrl = vi.fn(() => 'blob:never')

    await expect(prepareImage(file, createTrackedBlobUrl)).rejects.toBeInstanceOf(ImageTooLargeError)
    await expect(prepareImage(file, createTrackedBlobUrl)).rejects.toThrow(/3 MB/)
    expect(createTrackedBlobUrl).not.toHaveBeenCalled()
  })

  it('accepts GIFs at exactly the 3 MB boundary', async () => {
    const bytes = new Uint8Array(3 * 1024 * 1024)
    const file = makeFile(bytes, 'image/gif', 'edge.gif')
    const createTrackedBlobUrl = vi.fn(() => 'blob:edge')

    const out = await prepareImage(file, createTrackedBlobUrl)
    expect(out.bytes.byteLength).toBe(bytes.byteLength)
  })
})

describe('prepareImage — compress path (non-GIF)', () => {
  // happy-dom does not implement canvas drawImage → toDataURL with real
  // rendering. Stub the canvas surface to return a known JPEG data URI so
  // the test can assert the byte-decode path without a real raster.
  const STUB_DATA_URI = 'data:image/jpeg;base64,/9j/2wBDAAEBAQE='

  function stubCanvas(): void {
    const ctxStub = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockImplementation(() => ctxStub)
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL')
      .mockReturnValue(STUB_DATA_URI)
  }

  function stubImageDecode(): void {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      configurable: true,
      set(this: HTMLImageElement, _v: string) {
        // Simulate decode: width/height set, then onload fires.
        Object.defineProperty(this, 'width', { value: 100, configurable: true })
        Object.defineProperty(this, 'height', { value: 100, configurable: true })
        queueMicrotask(() => this.onload?.(new Event('load')))
      },
    })
  }

  it('compresses a JPEG to a data URI and returns matching bytes', async () => {
    stubCanvas()
    stubImageDecode()

    const file = makeFile(new Uint8Array([0xff, 0xd8, 0xff]), 'image/jpeg', 'photo.jpg')
    const createTrackedBlobUrl = vi.fn(() => 'blob:never-called-on-compress-path')

    const out = await prepareImage(file, createTrackedBlobUrl)

    expect(out.url).toBe(STUB_DATA_URI)
    expect(out.mime).toBe('image/jpeg')
    // Bytes are the base64-decoded payload of the stubbed data URI.
    const expected = Uint8Array.from(atob(STUB_DATA_URI.split(',')[1]), c => c.charCodeAt(0))
    expect(out.bytes).toEqual(expected)
    // Compress path returns the data URI directly; no blob is tracked.
    expect(createTrackedBlobUrl).not.toHaveBeenCalled()
  })
})
