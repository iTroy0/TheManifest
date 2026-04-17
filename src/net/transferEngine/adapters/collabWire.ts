import { encryptChunk, decryptChunk, encryptJSON } from '../../../utils/crypto'
import type { CollabInnerMsg, CollabUnencryptedMsg } from '../../protocol'
import type { WireAdapter } from '../types'

export interface CollabWire extends WireAdapter {
  seedFromInbound(fileId: string, packetIndex: number): void
}

// Collab file lifecycle messages (collab-file-start, collab-file-end,
// collab-cancel-file) are sent over the wire wrapped in a `collab-msg-enc`
// envelope and encrypted with the pair's ECDH-derived key. Portal does not
// wrap its equivalents; collab does because the DataConnection may relay
// through the host who must NOT see the inner payload. Adapter returns the
// envelope directly so sendFile's `session.send` emits the right bytes.
export function createCollabWire(): CollabWire {
  const toIdx = new Map<string, number>()
  const fromIdx = new Map<number, string>()
  let next = 0

  function allocate(fileId: string): number {
    const existing = toIdx.get(fileId)
    if (existing !== undefined) return existing
    while (next <= 0xFFFE && (fromIdx.has(next) || next === 0xFFFF)) {
      next++
    }
    // Exhaustion path: 65535 live fileIds on one session. Sender's sendFile
    // catches this throw, converts to 'error' result, and session.endTransfer
    // cleans up. buildFileCancelled/buildFileEnd don't allocate — they key
    // off the already-registered fileId — so the tail send still works.
    if (next > 0xFFFE) throw new Error('collabWire: packet-index exhausted')
    const idx = next++
    toIdx.set(fileId, idx)
    fromIdx.set(idx, fileId)
    return idx
  }

  async function wrap(session: { encryptKey: CryptoKey | null }, inner: CollabInnerMsg): Promise<CollabUnencryptedMsg> {
    if (!session.encryptKey) throw new Error('collabWire.wrap: no key')
    const data = await encryptJSON(session.encryptKey, inner)
    return { type: 'collab-msg-enc', data } satisfies CollabUnencryptedMsg
  }

  return {
    async buildFileStart(session, m) {
      const packetIndex = allocate(m.fileId)
      const inner: CollabInnerMsg = {
        type: 'collab-file-start',
        fileId: m.fileId,
        name: m.name,
        size: m.size,
        totalChunks: m.totalChunks,
        packetIndex,
      }
      return wrap(session, inner)
    },
    async buildFileEnd(session, fileId) {
      const inner: CollabInnerMsg = { type: 'collab-file-end', fileId }
      return wrap(session, inner)
    },
    async buildFileCancelled(session, fileId) {
      const inner: CollabInnerMsg = { type: 'collab-cancel-file', fileId }
      return wrap(session, inner)
    },
    async encryptChunk(session, pt) {
      if (!session.encryptKey) throw new Error('collabWire.encryptChunk: no key')
      return encryptChunk(session.encryptKey, pt)
    },
    async decryptChunk(session, ct) {
      if (!session.encryptKey) throw new Error('collabWire.decryptChunk: no key')
      return decryptChunk(session.encryptKey, ct)
    },
    packetIndexFor(fileId) { return allocate(fileId) },
    fileIdForPacketIndex(i) { return fromIdx.get(i) ?? null },
    seedFromInbound(fileId, packetIndex) {
      toIdx.set(fileId, packetIndex)
      fromIdx.set(packetIndex, fileId)
    },
  }
}
