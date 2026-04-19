import { makeZip } from 'client-zip'
import { isStreamSupported } from './streamWriter'
import streamSaver from 'streamsaver'

export interface StreamingZipHandle {
  startFile(name: string, size: number): void
  writeChunk(data: ArrayBuffer | Uint8Array): void
  endFile(): void
  finish(): void
  abort(): void
}

export function sanitizeName(name: string): string {
  // Strip path traversal and dangerous characters
  name = name.replace(/^.*[\\/]/, '')
  name = name.replace(/[<>:"|?*\x00-\x1f]/g, '_')
  name = name.replace(/^[\s.]+|[\s.]+$/g, '')
  return name || 'file'
}

// Async-iterable queue. Drives client-zip's `makeZip` from external pushes:
// `startFile` enqueues a new entry, `writeChunk` enqueues into the current
// entry's per-file ReadableStream, `finish` closes the queue → makeZip
// emits the central directory + EOCD and the outer pipeTo resolves.
function createQueue<T>() {
  const buf: T[] = []
  let pending: ((v: IteratorResult<T>) => void) | null = null
  let closed = false

  const iter: AsyncIterableIterator<T> = {
    [Symbol.asyncIterator]() { return this },
    next(): Promise<IteratorResult<T>> {
      if (buf.length > 0) {
        return Promise.resolve({ value: buf.shift() as T, done: false })
      }
      if (closed) {
        return Promise.resolve({ value: undefined as never, done: true })
      }
      return new Promise(resolve => { pending = resolve })
    },
  }

  return {
    iter,
    push(v: T): void {
      if (pending) {
        pending({ value: v, done: false })
        pending = null
      } else {
        buf.push(v)
      }
    },
    close(): void {
      closed = true
      if (pending) {
        pending({ value: undefined as never, done: true })
        pending = null
      }
    },
  }
}

// Streaming zip writer — pipes chunks directly to disk via StreamSaver
// without accumulating in RAM. Backed by `client-zip`, which writes Zip64
// extra fields (0x0001) for entries > 4 GB and emits the language-encoding
// flag (bit 11) for non-ASCII filenames automatically — closing the M-j
// gaps where fflate truncated the 4-byte size field and required manual
// flag setup.
export function createStreamingZip(zipName = 'manifest-files.zip'): StreamingZipHandle | null {
  if (!isStreamSupported()) return null

  try {
    const writeStream = streamSaver.createWriteStream(zipName)

    type Entry = { input: ReadableStream<Uint8Array>; name: string; size: number; lastModified: Date }
    const fileQueue = createQueue<Entry>()

    let currentController: ReadableStreamDefaultController<Uint8Array> | null = null
    let aborted = false

    // Build the outer zip stream and pipe it to disk. `pipeTo` returns a
    // promise that we deliberately swallow — the writer's own abort path
    // surfaces user-visible errors elsewhere; an unhandled rejection from a
    // mid-pipe StreamSaver service-worker death would otherwise crash the
    // tab. `buffersAreUTF8: true` is moot here (filenames are passed as
    // strings, which client-zip already flags as UTF-8), but kept as a
    // belt-and-braces guard for any future caller that switches to
    // ArrayBuffer filenames.
    const zipStream = makeZip(fileQueue.iter, { buffersAreUTF8: true })
    void zipStream.pipeTo(writeStream).catch(() => { /* surfaced via abort path */ })

    return {
      startFile(name: string, size: number): void {
        if (aborted) return
        // Each entry gets its own ReadableStream that client-zip drains
        // serially. `writeChunk` enqueues into this entry; `endFile` closes
        // it so client-zip moves on to the next queued entry.
        const entryStream = new ReadableStream<Uint8Array>({
          start(controller) { currentController = controller },
        })
        fileQueue.push({
          input: entryStream,
          name: sanitizeName(name),
          size,
          lastModified: new Date(),
        })
      },

      writeChunk(data: ArrayBuffer | Uint8Array): void {
        if (!currentController) return
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
        try {
          currentController.enqueue(chunk)
        } catch {
          // Controller already closed (entry ended early or aborted) —
          // drop the chunk silently rather than crash the chunk loop.
        }
      },

      endFile(): void {
        if (!currentController) return
        try { currentController.close() } catch { /* already closed */ }
        currentController = null
      },

      finish(): void {
        // Close any dangling entry then the outer queue so makeZip emits
        // the central directory + EOCD and pipeTo resolves.
        if (currentController) {
          try { currentController.close() } catch { /* noop */ }
          currentController = null
        }
        fileQueue.close()
      },

      abort(): void {
        aborted = true
        if (currentController) {
          try { currentController.error(new Error('zip aborted')) } catch { /* noop */ }
          currentController = null
        }
        fileQueue.close()
        try { writeStream.abort() } catch { /* writer may already be done */ }
      },
    }
  } catch {
    return null
  }
}
