import { describe, it, expect, beforeAll } from 'vitest'
import { createCollabWire } from './collabWire'
import { finalizeKeyExchange } from '../../keyExchange'
import { decryptJSON } from '../../../utils/crypto'
import type { Session } from '../../session'
import type { CollabInnerMsg } from '../../protocol'

function makeSession(key: CryptoKey): Session {
  return { encryptKey: key } as unknown as Session
}

describe('collabWire', () => {
  let key: CryptoKey

  beforeAll(async () => {
    const a = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const b = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const aPub = new Uint8Array(await crypto.subtle.exportKey('raw', a.publicKey))
    const bPub = new Uint8Array(await crypto.subtle.exportKey('raw', b.publicKey))
    key = (await finalizeKeyExchange({
      localPrivate: a.privateKey, localPublic: aPub, remotePublic: bPub,
    })).encryptKey
  })

  it('allocates sequential indices 0, 1, 2 for new fileIds', () => {
    const w = createCollabWire()
    expect(w.packetIndexFor('a')).toBe(0)
    expect(w.packetIndexFor('b')).toBe(1)
    expect(w.packetIndexFor('c')).toBe(2)
  })

  it('returns same index for same fileId', () => {
    const w = createCollabWire()
    const first = w.packetIndexFor('x')
    expect(w.packetIndexFor('x')).toBe(first)
  })

  it('seedFromInbound pre-registers a fileId/index pair', () => {
    const w = createCollabWire()
    w.seedFromInbound('remote-file', 42)
    expect(w.packetIndexFor('remote-file')).toBe(42)
    expect(w.fileIdForPacketIndex(42)).toBe('remote-file')
  })

  it('allocator skips indices already taken by seedFromInbound', () => {
    const w = createCollabWire()
    w.seedFromInbound('seeded', 0)
    expect(w.packetIndexFor('fresh')).toBe(1)  // 0 taken, allocator advances
  })

  it('buildFileStart returns a collab-msg-enc envelope wrapping an encrypted collab-file-start', async () => {
    const w = createCollabWire()
    const s = makeSession(key)
    const msg = await w.buildFileStart(s, {
      fileId: 'x', name: 'a.txt', size: 10, totalChunks: 1,
    }) as { type: string; data: string }
    expect(msg.type).toBe('collab-msg-enc')
    expect(typeof msg.data).toBe('string')

    const inner = await decryptJSON<CollabInnerMsg>(key, msg.data)
    expect(inner.type).toBe('collab-file-start')
    if (inner.type !== 'collab-file-start') throw new Error('type narrow')
    expect(inner.fileId).toBe('x')
    expect(inner.name).toBe('a.txt')
    expect(inner.size).toBe(10)
    expect(inner.totalChunks).toBe(1)
    expect(inner.packetIndex).toBe(0)
  })

  it('buildFileEnd returns a collab-msg-enc envelope wrapping collab-file-end', async () => {
    const w = createCollabWire()
    const s = makeSession(key)
    const msg = await w.buildFileEnd(s, 'x') as { type: string; data: string }
    expect(msg.type).toBe('collab-msg-enc')
    const inner = await decryptJSON<CollabInnerMsg>(key, msg.data)
    expect(inner.type).toBe('collab-file-end')
    if (inner.type !== 'collab-file-end') throw new Error('type narrow')
    expect(inner.fileId).toBe('x')
  })

  it('buildFileCancelled returns a collab-msg-enc envelope wrapping collab-cancel-file', async () => {
    const w = createCollabWire()
    const s = makeSession(key)
    const msg = await w.buildFileCancelled(s, 'x') as { type: string; data: string }
    expect(msg.type).toBe('collab-msg-enc')
    const inner = await decryptJSON<CollabInnerMsg>(key, msg.data)
    expect(inner.type).toBe('collab-cancel-file')
    if (inner.type !== 'collab-cancel-file') throw new Error('type narrow')
    expect(inner.fileId).toBe('x')
  })

  it('buildFileStart throws when key is null', async () => {
    const w = createCollabWire()
    const s = { encryptKey: null } as unknown as Session
    await expect(w.buildFileStart(s, { fileId: 'x', name: 'a', size: 1, totalChunks: 1 })).rejects.toThrow(/no key/)
  })

  it('encrypt/decrypt round-trips', async () => {
    const w = createCollabWire()
    const s = makeSession(key)
    const pt = new Uint8Array([1, 2, 3]).buffer
    const ct = await w.encryptChunk(s, pt)
    const back = await w.decryptChunk(s, ct)
    expect(new Uint8Array(back)).toEqual(new Uint8Array(pt))
  })

  it('encryptChunk throws when key is null', async () => {
    const w = createCollabWire()
    const s = { encryptKey: null } as unknown as Session
    await expect(w.encryptChunk(s, new ArrayBuffer(4))).rejects.toThrow(/no key/)
  })

  it('seedFromInbound is idempotent for the same mapping', () => {
    const w = createCollabWire()
    w.seedFromInbound('a', 5)
    expect(() => w.seedFromInbound('a', 5)).not.toThrow()
    expect(w.packetIndexFor('a')).toBe(5)
  })

  it('seedFromInbound throws when the packet index is already bound to a different fileId', () => {
    const w = createCollabWire()
    w.seedFromInbound('a', 5)
    expect(() => w.seedFromInbound('b', 5)).toThrow(/already bound to 'a'/)
  })

  it('seedFromInbound throws when the fileId is already bound to a different index', () => {
    const w = createCollabWire()
    w.seedFromInbound('a', 5)
    expect(() => w.seedFromInbound('a', 6)).toThrow(/already bound to index 5/)
  })
})
