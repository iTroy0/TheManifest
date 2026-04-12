import streamSaver from 'streamsaver'

// Point StreamSaver to our self-hosted service worker
streamSaver.mitm = `${window.location.origin}/mitm.html`

let streamSupported: boolean | null = null

export function isStreamSupported(): boolean {
  if (streamSupported !== null) return streamSupported
  try {
    streamSupported = !!streamSaver.createWriteStream && !!window.WritableStream
  } catch {
    streamSupported = false
  }
  return streamSupported
}

export interface FileStreamHandle {
  write(chunk: ArrayBufferLike | Uint8Array): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export function createFileStream(fileName: string, fileSize: number): FileStreamHandle | null {
  if (!isStreamSupported()) return null

  try {
    const writeStream = streamSaver.createWriteStream(fileName, { size: fileSize })
    const writer = writeStream.getWriter()
    return {
      write(chunk: ArrayBufferLike | Uint8Array): Promise<void> {
        const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        return writer.write(data)
      },
      close(): Promise<void> {
        return writer.close()
      },
      abort(): Promise<void> {
        return writer.abort()
      },
    }
  } catch (err) {
    console.warn('StreamSaver initialization failed, falling back to in-memory buffering:', err)
    return null
  }
}
