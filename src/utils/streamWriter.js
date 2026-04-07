import streamSaver from 'streamsaver'

// Point StreamSaver to our self-hosted service worker
streamSaver.mitm = `${window.location.origin}/mitm.html`

let streamSupported = null

export function isStreamSupported() {
  if (streamSupported !== null) return streamSupported
  try {
    streamSupported = !!streamSaver.createWriteStream && !!window.WritableStream
  } catch {
    streamSupported = false
  }
  return streamSupported
}

export function createFileStream(fileName, fileSize) {
  if (!isStreamSupported()) return null

  try {
    const writeStream = streamSaver.createWriteStream(fileName, { size: fileSize })
    const writer = writeStream.getWriter()
    return {
      write(chunk) {
        const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        return writer.write(data)
      },
      close() {
        return writer.close()
      },
      abort() {
        return writer.abort()
      },
    }
  } catch {
    return null
  }
}
