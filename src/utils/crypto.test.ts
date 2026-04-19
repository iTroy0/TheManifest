import { describe, it, expect } from 'vitest'
import {
  generateKeyPair, exportPublicKey, importPublicKey,
  deriveSharedKey, encryptChunk, decryptChunk,
  encryptJSON, decryptJSON,
  getKeyFingerprint, uint8ToBase64, base64ToUint8,
  timingSafeEqual,
} from './crypto'

describe('ECDH Key Exchange', () => {
  it('generates a valid keypair', async () => {
    const kp: CryptoKeyPair = await generateKeyPair()
    expect(kp.publicKey).toBeDefined()
    expect(kp.privateKey).toBeDefined()
    expect(kp.publicKey.type).toBe('public')
    expect(kp.privateKey.type).toBe('private')
  })

  it('generates fresh keypair each call', async () => {
    const kp1: CryptoKeyPair = await generateKeyPair()
    const kp2: CryptoKeyPair = await generateKeyPair()
    const pub1: Uint8Array = await exportPublicKey(kp1.publicKey)
    const pub2: Uint8Array = await exportPublicKey(kp2.publicKey)
    expect(pub1).not.toEqual(pub2)
  })

  it('private key is non-extractable', async () => {
    const kp: CryptoKeyPair = await generateKeyPair()
    expect(kp.privateKey.extractable).toBe(false)
  })

  it('exports public key as 65 bytes (uncompressed P-256)', async () => {
    const kp: CryptoKeyPair = await generateKeyPair()
    const raw: Uint8Array = await exportPublicKey(kp.publicKey)
    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw.length).toBe(65)
    expect(raw[0]).toBe(0x04) // uncompressed point prefix
  })

  it('imports a public key from raw bytes', async () => {
    const kp: CryptoKeyPair = await generateKeyPair()
    const raw: Uint8Array = await exportPublicKey(kp.publicKey)
    const imported: CryptoKey = await importPublicKey(raw)
    expect(imported.type).toBe('public')
    expect((imported.algorithm as EcKeyAlgorithm).name).toBe('ECDH')
  })

  it('derives matching shared keys from both sides', async () => {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const alicePub: Uint8Array = await exportPublicKey(alice.publicKey)
    const bobPub: Uint8Array = await exportPublicKey(bob.publicKey)
    const bobImported: CryptoKey = await importPublicKey(bobPub)
    const aliceImported: CryptoKey = await importPublicKey(alicePub)

    const keyA: CryptoKey = await deriveSharedKey(alice.privateKey, bobImported)
    const keyB: CryptoKey = await deriveSharedKey(bob.privateKey, aliceImported)

    const data: Uint8Array = new TextEncoder().encode('hello from alice')
    const encrypted: ArrayBuffer = await encryptChunk(keyA, data)
    const decrypted: ArrayBuffer = await decryptChunk(keyB, new Uint8Array(encrypted))
    expect(new TextDecoder().decode(decrypted)).toBe('hello from alice')
  })
})

describe('AES-256-GCM Encryption', () => {
  let key: CryptoKey

  async function makeKey(): Promise<CryptoKey> {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const bobPub: CryptoKey = await importPublicKey(await exportPublicKey(bob.publicKey))
    return deriveSharedKey(alice.privateKey, bobPub)
  }

  it('encrypt then decrypt returns original data', async () => {
    key = await makeKey()
    const original: Uint8Array = new TextEncoder().encode('test message 12345')
    const encrypted: ArrayBuffer = await encryptChunk(key, original)
    const decrypted: ArrayBuffer = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new TextDecoder().decode(decrypted)).toBe('test message 12345')
  })

  it('encrypted output is larger than input (IV + tag)', async () => {
    key = await makeKey()
    const data: Uint8Array = new Uint8Array(100)
    const encrypted: ArrayBuffer = await encryptChunk(key, data)
    expect(new Uint8Array(encrypted).length).toBe(128)
  })

  it('first 12 bytes are the IV', async () => {
    key = await makeKey()
    const encrypted: Uint8Array = new Uint8Array(await encryptChunk(key, new Uint8Array(10)))
    const iv: Uint8Array = encrypted.slice(0, 12)
    expect(iv.length).toBe(12)
    expect(iv.some(b => b !== 0)).toBe(true)
  })

  it('generates unique IVs for each encryption', async () => {
    key = await makeKey()
    const data: Uint8Array = new Uint8Array(16)
    const enc1: Uint8Array = new Uint8Array(await encryptChunk(key, data))
    const enc2: Uint8Array = new Uint8Array(await encryptChunk(key, data))
    const iv1: Uint8Array = enc1.slice(0, 12)
    const iv2: Uint8Array = enc2.slice(0, 12)
    expect(iv1).not.toEqual(iv2)
  })

  it('rejects tampered ciphertext (GCM tag verification)', async () => {
    key = await makeKey()
    const encrypted: Uint8Array = new Uint8Array(await encryptChunk(key, new TextEncoder().encode('secret')))
    // Flip a byte in the ciphertext
    encrypted[20] ^= 0xff
    await expect(decryptChunk(key, encrypted)).rejects.toThrow()
  })

  it('rejects wrong key', async () => {
    const key1: CryptoKey = await makeKey()
    const key2: CryptoKey = await makeKey()
    const encrypted: ArrayBuffer = await encryptChunk(key1, new TextEncoder().encode('data'))
    await expect(decryptChunk(key2, new Uint8Array(encrypted))).rejects.toThrow()
  })

  it('handles empty data', async () => {
    key = await makeKey()
    const encrypted: ArrayBuffer = await encryptChunk(key, new Uint8Array(0))
    const decrypted: ArrayBuffer = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new Uint8Array(decrypted).length).toBe(0)
  })

  it('handles large data (1MB)', async () => {
    key = await makeKey()
    const data: Uint8Array = new Uint8Array(1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const encrypted: ArrayBuffer = await encryptChunk(key, data)
    const decrypted: ArrayBuffer = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new Uint8Array(decrypted)).toEqual(data)
  })
})

describe('Key Fingerprint', () => {
  it('produces matching fingerprints from both sides', async () => {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const alicePub: Uint8Array = await exportPublicKey(alice.publicKey)
    const bobPub: Uint8Array = await exportPublicKey(bob.publicKey)
    const fp1: string = await getKeyFingerprint(alicePub, bobPub)
    const fp2: string = await getKeyFingerprint(bobPub, alicePub)
    expect(fp1).toBe(fp2)
  })

  it('produces 8 hex pairs separated by spaces', async () => {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const fp: string = await getKeyFingerprint(
      await exportPublicKey(alice.publicKey),
      await exportPublicKey(bob.publicKey)
    )
    expect(fp).toMatch(/^[0-9a-f]{2}( [0-9a-f]{2}){15}$/)
  })

  it('different keypairs produce different fingerprints', async () => {
    const a: CryptoKeyPair = await generateKeyPair()
    const b: CryptoKeyPair = await generateKeyPair()
    const c: CryptoKeyPair = await generateKeyPair()
    const fp1: string = await getKeyFingerprint(await exportPublicKey(a.publicKey), await exportPublicKey(b.publicKey))
    const fp2: string = await getKeyFingerprint(await exportPublicKey(a.publicKey), await exportPublicKey(c.publicKey))
    expect(fp1).not.toBe(fp2)
  })
})

describe('encryptJSON / decryptJSON', () => {
  async function makeKey(): Promise<CryptoKey> {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const bobPub: CryptoKey = await importPublicKey(await exportPublicKey(bob.publicKey))
    return deriveSharedKey(alice.privateKey, bobPub)
  }

  it('round-trips a simple object', async () => {
    const key: CryptoKey = await makeKey()
    const obj = { text: 'hello', count: 42, nested: { a: true } }
    const encrypted: string = await encryptJSON(key, obj)
    expect(typeof encrypted).toBe('string') // base64
    const decrypted = await decryptJSON(key, encrypted)
    expect(decrypted).toEqual(obj)
  })

  it('round-trips an object with unicode', async () => {
    const key: CryptoKey = await makeKey()
    const obj = { text: 'hello 世界 🎉', emoji: '💯' }
    const decrypted = await decryptJSON(key, await encryptJSON(key, obj))
    expect(decrypted).toEqual(obj)
  })

  it('round-trips an empty object', async () => {
    const key: CryptoKey = await makeKey()
    const decrypted = await decryptJSON(key, await encryptJSON(key, {}))
    expect(decrypted).toEqual({})
  })

  it('rejects wrong key', async () => {
    const key1: CryptoKey = await makeKey()
    const key2: CryptoKey = await makeKey()
    const encrypted: string = await encryptJSON(key1, { secret: true })
    await expect(decryptJSON(key2, encrypted)).rejects.toThrow()
  })
})

describe('Base64 Utilities', () => {
  it('round-trips correctly', () => {
    const data: Uint8Array = new Uint8Array([0, 1, 127, 128, 255])
    const b64: string = uint8ToBase64(data)
    const back: Uint8Array = base64ToUint8(b64)
    expect(back).toEqual(data)
  })

  it('handles empty input', () => {
    const b64: string = uint8ToBase64(new Uint8Array(0))
    expect(base64ToUint8(b64).length).toBe(0)
  })

  it('handles large data', () => {
    const data: Uint8Array = new Uint8Array(100000)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const back: Uint8Array = base64ToUint8(uint8ToBase64(data))
    expect(back).toEqual(data)
  })

  it('round-trips binary data with all 256 byte values (0x00-0xFF)', () => {
    const data: Uint8Array = new Uint8Array(256)
    for (let i = 0; i < 256; i++) data[i] = i
    const b64: string = uint8ToBase64(data)
    const back: Uint8Array = base64ToUint8(b64)
    expect(back).toEqual(data)
    for (let i = 0; i < 256; i++) expect(back[i]).toBe(i)
  })
})

describe('importPublicKey edge cases', () => {
  it('throws when importing a truncated byte array (32 bytes instead of 65)', async () => {
    const truncated: Uint8Array = new Uint8Array(32)
    await expect(importPublicKey(truncated)).rejects.toThrow()
  })

  it('throws when importing an array with wrong prefix (not 0x04)', async () => {
    const wrongPrefix: Uint8Array = new Uint8Array(65)
    wrongPrefix[0] = 0x02 // compressed-point prefix — invalid for 'raw' format
    await expect(importPublicKey(wrongPrefix)).rejects.toThrow()
  })

  it('throws when importing an empty Uint8Array', async () => {
    await expect(importPublicKey(new Uint8Array(0))).rejects.toThrow()
  })

  it('rejects truncated bytes with CryptoDecodeError (length check)', async () => {
    await expect(importPublicKey(new Uint8Array(64))).rejects.toThrow(/65 bytes/)
  })

  it('rejects wrong-prefix bytes with CryptoDecodeError (0x04 check)', async () => {
    const wrong = new Uint8Array(65)
    wrong[0] = 0x02
    await expect(importPublicKey(wrong)).rejects.toThrow(/0x04/)
  })

  it('rejects oversize bytes (>65) with length error', async () => {
    const oversize = new Uint8Array(66)
    oversize[0] = 0x04
    await expect(importPublicKey(oversize)).rejects.toThrow(/65 bytes/)
  })
})

describe('AES-256-GCM additional edge cases', () => {
  async function makeKey(): Promise<CryptoKey> {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const bobPub: CryptoKey = await importPublicKey(await exportPublicKey(bob.publicKey))
    return deriveSharedKey(alice.privateKey, bobPub)
  }

  it('decrypt with corrupted IV fails (first 12 bytes flipped)', async () => {
    const key: CryptoKey = await makeKey()
    const plaintext: Uint8Array = new TextEncoder().encode('sensitive payload')
    const encrypted: Uint8Array = new Uint8Array(await encryptChunk(key, plaintext))
    // Corrupt the entire IV region
    for (let i = 0; i < 12; i++) encrypted[i] ^= 0xff
    await expect(decryptChunk(key, encrypted)).rejects.toThrow()
  })

  it('encrypt/decrypt round-trip with 5MB of data', async () => {
    const key: CryptoKey = await makeKey()
    const data: Uint8Array = new Uint8Array(5 * 1024 * 1024)
    for (let i = 0; i < data.length; i++) data[i] = i % 256
    const encrypted: ArrayBuffer = await encryptChunk(key, data)
    const decrypted: ArrayBuffer = await decryptChunk(key, new Uint8Array(encrypted))
    expect(new Uint8Array(decrypted)).toEqual(data)
  }, 30000)
})

describe('decryptJSON edge cases', () => {
  async function makeKey(): Promise<CryptoKey> {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const bobPub: CryptoKey = await importPublicKey(await exportPublicKey(bob.publicKey))
    return deriveSharedKey(alice.privateKey, bobPub)
  }

  it('throws or returns malformed result when ciphertext contains non-JSON plaintext', async () => {
    const key: CryptoKey = await makeKey()
    const nonJsonBytes: Uint8Array = new TextEncoder().encode('not valid json }{')
    const encrypted: ArrayBuffer = await encryptChunk(key, nonJsonBytes)
    const b64: string = uint8ToBase64(new Uint8Array(encrypted))
    await expect(decryptJSON(key, b64)).rejects.toThrow()
  })
})

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('hello', 'hello')).toBe(true)
    expect(timingSafeEqual('', '')).toBe(true)
  })

  it('returns false for different strings of equal length', () => {
    expect(timingSafeEqual('abcd', 'abce')).toBe(false)
    expect(timingSafeEqual('xxxx', 'yyyy')).toBe(false)
  })

  it('returns false for strings of different lengths', () => {
    expect(timingSafeEqual('a', 'ab')).toBe(false)
    expect(timingSafeEqual('abc', '')).toBe(false)
    expect(timingSafeEqual('', 'x')).toBe(false)
  })

  it('handles multi-byte unicode correctly', () => {
    expect(timingSafeEqual('pässword', 'pässword')).toBe(true)
    expect(timingSafeEqual('pässword', 'passwörd')).toBe(false)
    // Different lengths when encoded (å = 2 bytes, a = 1)
    expect(timingSafeEqual('passwörd', 'password')).toBe(false)
  })

  it('result does not depend on shared prefix length', () => {
    expect(timingSafeEqual('a'.repeat(100) + 'b', 'a'.repeat(100) + 'c')).toBe(false)
    expect(timingSafeEqual('b' + 'a'.repeat(100), 'c' + 'a'.repeat(100))).toBe(false)
  })
})

describe('HKDF salt binding to public keys', () => {
  it('two sessions with same keypairs but different salts produce different keys', async () => {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const alicePub: Uint8Array = await exportPublicKey(alice.publicKey)
    const bobPub: Uint8Array = await exportPublicKey(bob.publicKey)
    const bobImported: CryptoKey = await importPublicKey(bobPub)

    const k1: CryptoKey = await deriveSharedKey(alice.privateKey, bobImported, alicePub, bobPub)
    // Swapped bytes produce the same sorted digest — keys should match
    const k2: CryptoKey = await deriveSharedKey(alice.privateKey, bobImported, bobPub, alicePub)
    // Omit salt material → zero salt (different key)
    const k3: CryptoKey = await deriveSharedKey(alice.privateKey, bobImported)

    const data: Uint8Array = new TextEncoder().encode('hi')
    const ct1: ArrayBuffer = await encryptChunk(k1, data)
    const pt12: ArrayBuffer = await decryptChunk(k2, new Uint8Array(ct1))
    expect(new TextDecoder().decode(pt12)).toBe('hi')

    await expect(decryptChunk(k3, new Uint8Array(ct1))).rejects.toThrow()
  })

  it('both sides derive identical keys when passing matching salt material', async () => {
    const alice: CryptoKeyPair = await generateKeyPair()
    const bob: CryptoKeyPair = await generateKeyPair()
    const alicePub: Uint8Array = await exportPublicKey(alice.publicKey)
    const bobPub: Uint8Array = await exportPublicKey(bob.publicKey)
    const bobImported: CryptoKey = await importPublicKey(bobPub)
    const aliceImported: CryptoKey = await importPublicKey(alicePub)

    const keyA: CryptoKey = await deriveSharedKey(alice.privateKey, bobImported, alicePub, bobPub)
    const keyB: CryptoKey = await deriveSharedKey(bob.privateKey, aliceImported, bobPub, alicePub)

    const data: Uint8Array = new TextEncoder().encode('round trip')
    const ct: ArrayBuffer = await encryptChunk(keyA, data)
    const pt: ArrayBuffer = await decryptChunk(keyB, new Uint8Array(ct))
    expect(new TextDecoder().decode(pt)).toBe('round trip')
  })
})
