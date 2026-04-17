import { describe, it, expect, beforeAll } from 'vitest'
import { portalWire } from './portalWire'
import { finalizeKeyExchange } from '../../keyExchange'
import type { Session } from '../../session'

function makeSessionWithKey(key: CryptoKey): Session {
  return { encryptKey: key } as unknown as Session
}

describe('portalWire', () => {
  let key: CryptoKey

  beforeAll(async () => {
    const a = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const b = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])
    const aPub = new Uint8Array(await crypto.subtle.exportKey('raw', a.publicKey))
    const bPub = new Uint8Array(await crypto.subtle.exportKey('raw', b.publicKey))
    const derived = await finalizeKeyExchange({
      localPrivate: a.privateKey, localPublic: aPub, remotePublic: bPub,
    })
    key = derived.encryptKey
  })

  it('buildFileStart returns PortalMsg.file-start shape', async () => {
    const s = makeSessionWithKey(key)
    const msg = await portalWire.buildFileStart(s, {
      fileId: 'file-0', name: 'a.txt', size: 10, totalChunks: 1,
    }) as { type: string; index: number; name: string; size: number; totalChunks: number }
    expect(msg.type).toBe('file-start')
    expect(msg.index).toBe(0)
    expect(msg.name).toBe('a.txt')
    expect(msg.size).toBe(10)
    expect(msg.totalChunks).toBe(1)
  })

  it('packetIndexFor strips file- prefix', () => {
    expect(portalWire.packetIndexFor('file-0')).toBe(0)
    expect(portalWire.packetIndexFor('file-42')).toBe(42)
  })

  it('fileIdForPacketIndex reconstructs fileId', () => {
    expect(portalWire.fileIdForPacketIndex(0)).toBe('file-0')
    expect(portalWire.fileIdForPacketIndex(42)).toBe('file-42')
  })

  it('packetIndexFor throws on invalid fileId', () => {
    expect(() => portalWire.packetIndexFor('garbage')).toThrow()
    expect(() => portalWire.packetIndexFor('file-65535')).toThrow()
    expect(() => portalWire.packetIndexFor('file--1')).toThrow()
  })

  it('encrypt/decrypt round-trips', async () => {
    const s = makeSessionWithKey(key)
    const plaintext = new Uint8Array([1, 2, 3, 4, 5]).buffer
    const ct = await portalWire.encryptChunk(s, plaintext)
    const pt = await portalWire.decryptChunk(s, ct)
    expect(new Uint8Array(pt)).toEqual(new Uint8Array(plaintext))
  })

  it('encryptChunk throws when key is null', async () => {
    const s = { encryptKey: null } as unknown as Session
    await expect(portalWire.encryptChunk(s, new ArrayBuffer(4))).rejects.toThrow(/no key/)
  })

  it('buildFileEnd returns PortalMsg.file-end with index', async () => {
    const msg = await portalWire.buildFileEnd({} as any, 'file-7') as { type: string; index: number }
    expect(msg.type).toBe('file-end')
    expect(msg.index).toBe(7)
  })

  it('buildFileCancelled returns PortalMsg.file-cancelled with index', async () => {
    const msg = await portalWire.buildFileCancelled({} as any, 'file-3') as { type: string; index: number }
    expect(msg.type).toBe('file-cancelled')
    expect(msg.index).toBe(3)
  })
})
