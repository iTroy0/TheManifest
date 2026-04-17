import { Zip, ZipPassThrough } from 'fflate'
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

// Streaming zip writer — pipes chunks directly to disk via StreamSaver without accumulating in RAM.
export function createStreamingZip(zipName = 'manifest-files.zip'): StreamingZipHandle | null {
  if (!isStreamSupported()) return null

  try {
    const writeStream = streamSaver.createWriteStream(zipName)
    const writer = writeStream.getWriter()
    const zip = new Zip()

    zip.ondata = (err: Error | null, chunk: Uint8Array, final: boolean) => {
      if (err) {
        writer.abort()
        return
      }
      writer.write(chunk)
      if (final) writer.close()
    }

    let currentEntry: ZipPassThrough | null = null

    return {
      startFile(name: string, _size: number): void {
        currentEntry = new ZipPassThrough(sanitizeName(name))
        zip.add(currentEntry)
      },

      writeChunk(data: ArrayBuffer | Uint8Array): void {
        if (!currentEntry) return
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
        currentEntry.push(chunk)
      },

      endFile(): void {
        if (!currentEntry) return
        currentEntry.push(new Uint8Array(0), true)
        currentEntry = null
      },

      finish(): void {
        zip.end()
      },

      abort(): void {
        try { writer.abort() } catch {}
      },
    }
  } catch {
    return null
  }
}
