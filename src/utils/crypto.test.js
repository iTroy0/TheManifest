import { describe, it, expect } from 'vitest'
import {
  generateKeyPair, exportPublicKey, importPublicKey,
  deriveSharedKey, encryptChunk, decryptChunk,
  getKeyFingerprint, uint8ToBase64, base64ToUint8,
} from './crypto'

describe('ECDH Key Exchange', () => {
  it('generates a valid keypair', async () => {
    const kp = await generateKeyPair()
    expect(kp.publicKey).toBeDefined()
    expect(kp.privateKey).toBeDefined()
    expect(kp.publicKey.type).toBe('public')
    expect(kp.privateKey.type).toBe('private')
  })

  it('generates fresh keypair each call', async () => {
    const kp1 = await generateKeyPair()
    const kp2 = await generateKeyPair()
    const pub1 = await exportPublicKey(kp1.publicKey)
    const pub2 = await exportPublicKey(kp2.publicKey)
    expect(pub1).not.toEqual(pub2)
  })

  it('private key is non-extractable', async () => {
    const kp = await generateKeyPair()
    expect(kp.privateKey.extractable).toBe(false)
  })

  it('exports public key as 65 bytes (uncompressed P-256)', async () => {
    const kp = await generateKeyPair()
    const raw = await exportPublicKey(kp.publicKey)
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw.length).toBe(65)
    expect(raw[0]).toBe(0x04) // uncompressed point prefix
  })

  it('imports a public key from raw bytes', async () => {
    const kp = await generateKeyPair()
    const raw = await exportPublicKey(kp.publicKey)
    const imported = await importPublicKey(raw)
    expect(imported.type).toBe('public')
    expect(imported.algorithm.name).toBe('ECDH')
  })

  it('derives matching shared keys from both sides', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const alicePub = await exportPublicKey(alice.publicKey)
    const bobPub = await exportPublicKey(bob.publicKey)
    const bobImported = await importPublicKey(bobPub)
    const aliceImported = await importPublicKey(alicePub)

    const keyA = await deriveSharedKey(alice.privateKey, bobImported)
    const keyB = await deriveSharedKey(bob.privateKey, aliceImported)

    // Encrypt with A, decrypt with B
    const data = new TextEncoder().encode('hello from alice')
    const encrypted = await encryptChunk(keyA, data)
    const decrypted = await decryptChunk(keyB, new Uint8Array(encrypted))
    expect(new TextDecoder().decode(decrypted)).toBe('hello from alice')
  })
})

describe('AES-256-GCM Encryption', () => {
  let key

  async function makeKey() {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const bobPub = await importPublicKey(await exportPublicKey(bob.publicKey))
    return deriveSharedKey(alice.privateKey, bobPub)
  }

  it('encrypt then decrypt returns original data', async () => {
    key = await makeKey()
    const original = new TextEncoder().encode('test message 12345')
    const encrypted = await encryptChunk(key, original)
    const decrypted = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new TextDecoder().decode(decrypted)).toBe('test message 12345')
  })

  it('encrypted output is larger than input (IV + tag)', async () => {
    key = await makeKey()
    const data = new Uint8Array(100)
    const encrypted = await encryptChunk(key, data)
    // 12 bytes IV + 100 bytes data + 16 bytes GCM tag = 128
    expect(new Uint8Array(encrypted).length).toBe(128)
  })

  it('first 12 bytes are the IV', async () => {
    key = await makeKey()
    const encrypted = new Uint8Array(await encryptChunk(key, new Uint8Array(10)))
    const iv = encrypted.slice(0, 12)
    expect(iv.length).toBe(12)
    // IV should not be all zeros (random)
    expect(iv.some(b => b !== 0)).toBe(true)
  })

  it('generates unique IVs for each encryption', async () => {
    key = await makeKey()
    const data = new Uint8Array(16)
    const enc1 = new Uint8Array(await encryptChunk(key, data))
    const enc2 = new Uint8Array(await encryptChunk(key, data))
    const iv1 = enc1.slice(0, 12)
    const iv2 = enc2.slice(0, 12)
    expect(iv1).not.toEqual(iv2)
  })

  it('rejects tampered ciphertext (GCM tag verification)', async () => {
    key = await makeKey()
    const encrypted = new Uint8Array(await encryptChunk(key, new TextEncoder().encode('secret')))
    // Flip a byte in the ciphertext
    encrypted[20] ^= 0xff
    await expect(decryptChunk(key, encrypted)).rejects.toThrow()
  })

  it('rejects wrong key', async () => {
    const key1 = await makeKey()
    const key2 = await makeKey()
    const encrypted = await encryptChunk(key1, new TextEncoder().encode('data'))
    await expect(decryptChunk(key2, new Uint8Array(encrypted))).rejects.toThrow()
  })

  it('handles empty data', async () => {
    key = await makeKey()
    const encrypted = await encryptChunk(key, new Uint8Array(0))
    const decrypted = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new Uint8Array(decrypted).length).toBe(0)
  })

  it('handles large data (1MB)', async () => {
    key = await makeKey()
    const data = new Uint8Array(1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const encrypted = await encryptChunk(key, data)
    const decrypted = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new Uint8Array(decrypted)).toEqual(data)
  })
})

describe('Key Fingerprint', () => {
  it('produces matching fingerprints from both sides', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const alicePub = await exportPublicKey(alice.publicKey)
    const bobPub = await exportPublicKey(bob.publicKey)
    const fp1 = await getKeyFingerprint(alicePub, bobPub)
    const fp2 = await getKeyFingerprint(bobPub, alicePub)
    expect(fp1).toBe(fp2)
  })

  it('produces 8 hex pairs separated by spaces', async () => {
    const alice = await generateKeyPair()
    const bob = await generateKeyPair()
    const fp = await getKeyFingerprint(
      await exportPublicKey(alice.publicKey),
      await exportPublicKey(bob.publicKey)
    )
    expect(fp).toMatch(/^[0-9a-f]{2}( [0-9a-f]{2}){7}$/)
  })

  it('different keypairs produce different fingerprints', async () => {
    const a = await generateKeyPair()
    const b = await generateKeyPair()
    const c = await generateKeyPair()
    const fp1 = await getKeyFingerprint(await exportPublicKey(a.publicKey), await exportPublicKey(b.publicKey))
    const fp2 = await getKeyFingerprint(await exportPublicKey(a.publicKey), await exportPublicKey(c.publicKey))
    expect(fp1).not.toBe(fp2)
  })
})

describe('Base64 Utilities', () => {
  it('round-trips correctly', () => {
    const data = new Uint8Array([0, 1, 127, 128, 255])
    const b64 = uint8ToBase64(data)
    const back = base64ToUint8(b64)
    expect(back).toEqual(data)
  })

  it('handles empty input', () => {
    const b64 = uint8ToBase64(new Uint8Array(0))
    expect(base64ToUint8(b64).length).toBe(0)
  })

  it('handles large data', () => {
    const data = new Uint8Array(100000)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const back = base64ToUint8(uint8ToBase64(data))
    expect(back).toEqual(data)
  })
})
