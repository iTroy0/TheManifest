// Tests for the wire-message helpers. The type unions themselves are
// compile-time contracts — these tests exercise the runtime bits:
//   - encodeEnc / decodeEnc round-trip via AES-GCM
//   - assertNever throws with the context label

import { describe, it, expect } from 'vitest'
import {
  encodeEnc,
  decodeEnc,
  assertNever,
  type PortalMsg,
  type CollabInnerMsg,
  type CallMsg,
} from './protocol'
import { deriveSharedKey, generateKeyPair, exportPublicKey } from '../utils/crypto'

async function makeSharedKey(): Promise<CryptoKey> {
  const a = await generateKeyPair()
  const b = await generateKeyPair()
  const aPub = await exportPublicKey(a.publicKey)
  const bPub = await exportPublicKey(b.publicKey)
  // Both sides produce the same key given sorted pub-key salt — we just
  // need ONE valid AES key for the round-trip check.
  return deriveSharedKey(a.privateKey, b.publicKey, aPub, bPub)
}

describe('encodeEnc / decodeEnc', () => {
  it('round-trips a PortalMsg', async () => {
    const key = await makeSharedKey()
    const original: PortalMsg = { type: 'request-file', index: 3, resumeChunk: 42 }
    const envelope = await encodeEnc<PortalMsg>(key, original)
    expect(typeof envelope).toBe('string')
    expect(envelope.length).toBeGreaterThan(0)

    const decoded = await decodeEnc<PortalMsg>(key, envelope)
    expect(decoded).toEqual(original)
  })

  it('round-trips a CollabInnerMsg', async () => {
    const key = await makeSharedKey()
    const original: CollabInnerMsg = {
      type: 'collab-file-start',
      fileId: 'abc',
      name: 'doc.pdf',
      size: 123,
      totalChunks: 4,
      packetIndex: 0, // TODO(task-10/11): wire from collabWire.packetIndexFor
    }
    const envelope = await encodeEnc<CollabInnerMsg>(key, original)
    const decoded = await decodeEnc<CollabInnerMsg>(key, envelope)
    expect(decoded).toEqual(original)
  })

  it('round-trips a CallMsg with nested array', async () => {
    const key = await makeSharedKey()
    const original: CallMsg = {
      type: 'call-roster',
      peers: [
        { peerId: 'p1', name: 'Alice', mode: 'audio' },
        { peerId: 'p2', name: 'Bob', mode: 'video' },
      ],
      from: 'host',
    }
    const envelope = await encodeEnc<CallMsg>(key, original)
    const decoded = await decodeEnc<CallMsg>(key, envelope)
    expect(decoded).toEqual(original)
  })

  it('throws on decrypt with a different key', async () => {
    const keyA = await makeSharedKey()
    const keyB = await makeSharedKey()
    const envelope = await encodeEnc<PortalMsg>(keyA, { type: 'done' })
    await expect(decodeEnc<PortalMsg>(keyB, envelope)).rejects.toThrow()
  })
})

describe('assertNever', () => {
  it('throws with the context label and serialized payload', () => {
    // Deliberately cast to satisfy the `never` position — the point of
    // the guard is to catch payloads whose `type` is off-union.
    const offUnion = { type: 'ghost', data: 'x' } as unknown as never
    expect(() => assertNever(offUnion, 'PortalMsg')).toThrowError(
      /unhandled protocol variant in PortalMsg/,
    )
  })

  it('survives circular-reference payloads (no JSON throw)', () => {
    const circ: Record<string, unknown> = { type: 'broken' }
    circ.self = circ
    expect(() => assertNever(circ as unknown as never, 'ctx')).toThrowError(
      /unhandled protocol variant in ctx/,
    )
  })
})
