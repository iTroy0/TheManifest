import { Zip, ZipPassThrough } from 'fflate'
import { isStreamSupported } from './streamWriter'
import streamSaver from 'streamsaver'

// Streaming zip writer — pipes chunks directly to disk via StreamSaver
// Each file is added one at a time. Chunks flow through without accumulating in RAM.
export function createStreamingZip(zipName = 'manifest-files.zip') {
  if (!isStreamSupported()) return null

  try {
    const writeStream = streamSaver.createWriteStream(zipName)
    const writer = writeStream.getWriter()
    const zip = new Zip()

    zip.ondata = (err, chunk, final) => {
      if (err) {
        writer.abort()
        return
      }
      writer.write(chunk)
      if (final) writer.close()
    }

    let currentEntry = null

    return {
      // Start a new file entry in the zip
      startFile(name, size) {
        currentEntry = new ZipPassThrough(name)
        zip.add(currentEntry)
      },

      // Write a chunk to the current file
      writeChunk(data) {
        if (!currentEntry) return
        const chunk = data instanceof Uint8Array ? data : new Uint8Array(data)
        currentEntry.push(chunk)
      },

      // Finish the current file
      endFile() {
        if (!currentEntry) return
        currentEntry.push(new Uint8Array(0), true) // signal end of this file
        currentEntry = null
      },

      // Finalize the entire zip
      finish() {
        zip.end()
      },

      // Abort on error
      abort() {
        try { writer.abort() } catch {}
      },
    }
  } catch {
    return null
  }
}
