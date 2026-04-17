import { encryptChunk, decryptChunk } from '../../../utils/crypto'
import type { CollabInnerMsg } from '../../protocol'
import type { WireAdapter } from '../types'

export interface CollabWire extends WireAdapter {
  seedFromInbound(fileId: string, packetIndex: number): void
}

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

  return {
    async buildFileStart(_s, m) {
      const packetIndex = allocate(m.fileId)
      return {
        type: 'collab-file-start',
        fileId: m.fileId,
        name: m.name,
        size: m.size,
        totalChunks: m.totalChunks,
        packetIndex,
      } satisfies CollabInnerMsg
    },
    async buildFileEnd(_s, fileId) {
      return { type: 'collab-file-end', fileId } satisfies CollabInnerMsg
    },
    async buildFileCancelled(_s, fileId) {
      return { type: 'collab-cancel-file', fileId } satisfies CollabInnerMsg
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
