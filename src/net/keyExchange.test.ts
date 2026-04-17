import { describe, it, expect } from 'vitest'
import { generateKeyPair, exportPublicKey, encryptChunk, decryptChunk } from '../utils/crypto'
import { finalizeKeyExchange } from './keyExchange'

describe('finalizeKeyExchange', () => {
  it('produces matching encryptKey and fingerprint on both sides', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const alicePub = await exportPublicKey(alice.publicKey)
    const bobPub = await exportPublicKey(bob.publicKey)

    const aliceResult = await finalizeKeyExchange({
      localPrivate: alice.privateKey,
      localPublic: alicePub,
      remotePublic: bobPub,
    })
    const bobResult = await finalizeKeyExchange({
      localPrivate: bob.privateKey,
      localPublic: bobPub,
      remotePublic: alicePub,
    })

    expect(aliceResult.fingerprint).toBe(bobResult.fingerprint)

    // Round-trip an encrypt on one side, decrypt on the other, to prove the
    // derived AES keys are genuinely equal (key equality is not directly
    // observable on WebCrypto CryptoKey objects).
    const plaintext = new TextEncoder().encode('handshake works')
    const enc = await encryptChunk(aliceResult.encryptKey, plaintext)
    const dec = await decryptChunk(bobResult.encryptKey, enc)
    expect(new TextDecoder().decode(dec)).toBe('handshake works')
  })

  it('produces different fingerprints for different peer pairs', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const eve = await generateKeyPair()
    const alicePub = await exportPublicKey(alice.publicKey)
    const bobPub = await exportPublicKey(bob.publicKey)
    const evePub = await exportPublicKey(eve.publicKey)

    const aliceBob = await finalizeKeyExchange({
      localPrivate: alice.privateKey,
      localPublic: alicePub,
      remotePublic: bobPub,
    })
    const aliceEve = await finalizeKeyExchange({
      localPrivate: alice.privateKey,
      localPublic: alicePub,
      remotePublic: evePub,
    })

    expect(aliceBob.fingerprint).not.toBe(aliceEve.fingerprint)
  })
})
