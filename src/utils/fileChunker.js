export const CHUNK_SIZE = 256 * 1024 // 256KB — larger chunks for better throughput
const BUFFER_THRESHOLD = 1024 * 1024 // 1MB — higher threshold for larger chunks
// Header: 2 bytes file index + 4 bytes chunk index = 6 bytes
const HEADER_SIZE = 6

export async function* chunkFile(file) {
  let offset = 0
  while (offset < file.size) {
    const slice = file.slice(offset, offset + CHUNK_SIZE)
    const buffer = await slice.arrayBuffer()
    yield buffer
    offset += CHUNK_SIZE
  }
}

export function buildChunkPacket(fileIndex, chunkIndex, data) {
  const header = new ArrayBuffer(HEADER_SIZE)
  const view = new DataView(header)
  view.setUint16(0, fileIndex, false) // 2 bytes, big-endian
  view.setUint32(2, chunkIndex, false) // 4 bytes, big-endian
  const packet = new Uint8Array(HEADER_SIZE + data.byteLength)
  packet.set(new Uint8Array(header), 0)
  packet.set(new Uint8Array(data), HEADER_SIZE)
  return packet.buffer
}

export function parseChunkPacket(buffer) {
  const view = new DataView(buffer)
  const fileIndex = view.getUint16(0, false)
  const chunkIndex = view.getUint32(2, false)
  const data = buffer.slice(HEADER_SIZE)
  return { fileIndex, chunkIndex, data }
}

export async function waitForBufferDrain(conn) {
  const dc = conn._dc || conn.dataChannel
  if (!dc || dc.bufferedAmount <= BUFFER_THRESHOLD) return

  return new Promise((resolve) => {
    if (typeof dc.onbufferedamountlow !== 'undefined') {
      dc.bufferedAmountLowThreshold = BUFFER_THRESHOLD
      const prev = dc.onbufferedamountlow
      dc.onbufferedamountlow = () => {
        dc.onbufferedamountlow = prev
        resolve()
      }
    } else {
      const poll = () => {
        if (dc.bufferedAmount <= BUFFER_THRESHOLD) resolve()
        else setTimeout(poll, 50)
      }
      poll()
    }
  })
}
