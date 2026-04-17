import { encryptChunk, decryptChunk } from '../../../utils/crypto'
import type { WireAdapter } from '../types'
import type { PortalMsg } from '../../protocol'

function portalPacketIndex(fileId: string): number {
  const m = /^file-(\d+)$/.exec(fileId)
  if (!m) throw new Error(`portalWire.packetIndexFor: invalid fileId '${fileId}'`)
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFE) {
    throw new Error(`portalWire.packetIndexFor: out-of-range fileId '${fileId}'`)
  }
  return n
}

export const portalWire: WireAdapter = {
  async buildFileStart(_s, m) {
    return {
      type: 'file-start',
      index: portalPacketIndex(m.fileId),
      name: m.name,
      size: m.size,
      totalChunks: m.totalChunks,
      ...(m.startChunk ? { resumeFrom: m.startChunk } : {}),
    } satisfies PortalMsg
  },
  async buildFileEnd(_s, fileId) {
    return {
      type: 'file-end',
      index: portalPacketIndex(fileId),
    } satisfies PortalMsg
  },
  async buildFileCancelled(_s, fileId) {
    return {
      type: 'file-cancelled',
      index: portalPacketIndex(fileId),
    } satisfies PortalMsg
  },
  async encryptChunk(session, pt) {
    if (!session.encryptKey) throw new Error('portalWire.encryptChunk: no key')
    return encryptChunk(session.encryptKey, pt)
  },
  async decryptChunk(session, ct) {
    if (!session.encryptKey) throw new Error('portalWire.decryptChunk: no key')
    return decryptChunk(session.encryptKey, ct)
  },
  packetIndexFor(fileId) { return portalPacketIndex(fileId) },
  fileIdForPacketIndex(i) {
    if (i < 0 || i > 0xFFFE) return null
    return `file-${i}`
  },
}
