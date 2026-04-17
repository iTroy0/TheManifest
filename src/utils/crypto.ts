// End-to-end encryption using ECDH key exchange + AES-256-GCM
// This layer encrypts data BEFORE it enters the WebRTC channel,
// so even a compromised TURN relay sees only encrypted bytes.

export function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

// Typed error thrown by `base64ToUint8` on malformed input. Callers that
// want to branch on decode failure (as opposed to any other thrown error)
// can `instanceof CryptoDecodeError` instead of sniffing the message.
export class CryptoDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CryptoDecodeError'
  }
}

export function base64ToUint8(b64: string): Uint8Array {
  if (typeof b64 !== 'string') {
    throw new CryptoDecodeError('base64 input is not a string')
  }
  // `atob` throws `DOMException` on malformed input. Normalize to
  // `CryptoDecodeError` so every call site can catch a single error type.
  let binary: string
  try { binary = atob(b64) }
  catch (e) {
    throw new CryptoDecodeError(`base64 decode failed: ${(e as Error)?.message || 'invalid input'}`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const ALGO = 'AES-GCM'
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96 bits for AES-GCM

export async function generateKeyPair(): Promise<CryptoKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  )
  return keyPair
}

export async function exportPublicKey(publicKey: CryptoKey): Promise<Uint8Array> {
  const raw = await crypto.subtle.exportKey('raw', publicKey)
  return new Uint8Array(raw)
}

export async function importPublicKey(rawBytes: Uint8Array | ArrayBuffer): Promise<CryptoKey> {
  const buffer: ArrayBuffer = rawBytes instanceof ArrayBuffer ? rawBytes : (rawBytes.buffer as ArrayBuffer).slice(rawBytes.byteOffset, rawBytes.byteOffset + rawBytes.byteLength)
  return crypto.subtle.importKey(
    'raw',
    buffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
}

// Sort two byte arrays deterministically so both sides produce the same
// concatenation, then SHA-256 it. Used for both the fingerprint and the
// HKDF salt so each session derives a unique, session-bound key.
async function sortedKeyDigest(a: Uint8Array, b: Uint8Array): Promise<Uint8Array> {
  // Lexicographic byte compare with an explicit length tie-breaker so the
  // output is deterministic even if the two inputs differ in length. The
  // old loop skipped the tie-break and silently left `first = a, second = b`
  // whenever every common-prefix byte was equal — safe today because we
  // only pass 65-byte P-256 pub keys, but a footgun for any future caller.
  let cmp = 0
  const minLen = Math.min(a.length, b.length)
  for (let i = 0; i < minLen; i++) {
    if (a[i] !== b[i]) { cmp = a[i] < b[i] ? -1 : 1; break }
  }
  if (cmp === 0) cmp = a.length - b.length
  const [first, second] = cmp <= 0 ? [a, b] : [b, a]
  const combined = new Uint8Array(first.length + second.length)
  combined.set(first, 0)
  combined.set(second, first.length)
  return new Uint8Array(await crypto.subtle.digest('SHA-256', combined))
}

// Derive a shared AES-256-GCM key from our private key + their public key.
// Uses HKDF to strengthen the raw ECDH output before use as an AES key.
// If both pub key byte arrays are provided, the HKDF salt is derived from
// their sorted SHA-256 digest — session-unique, identical on both sides.
// Omitting them falls back to a zero salt (test ergonomics only).
export async function deriveSharedKey(
  privateKey: CryptoKey,
  remotePublicKey: CryptoKey,
  localPubBytes?: Uint8Array,
  remotePubBytes?: Uint8Array,
): Promise<CryptoKey> {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePublicKey },
    privateKey,
    KEY_LENGTH
  )
  const salt = (localPubBytes && remotePubBytes)
    ? await sortedKeyDigest(localPubBytes, remotePubBytes)
    : new Uint8Array(32)
  const hkdfKey = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: new TextEncoder().encode('manifest-aes-gcm-v1') },
    hkdfKey,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

// Encrypt a chunk: prepends 12-byte IV to ciphertext
export async function encryptChunk(key: CryptoKey, data: Uint8Array | ArrayBuffer): Promise<ArrayBuffer> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const plaintext = data instanceof Uint8Array ? data : new Uint8Array(data)
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv: iv as BufferSource },
    key,
    plaintext as BufferSource
  )
  const output = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  output.set(iv, 0)
  output.set(new Uint8Array(ciphertext), IV_LENGTH)
  return output.buffer
}

export async function decryptChunk(key: CryptoKey, data: Uint8Array | ArrayBuffer): Promise<ArrayBuffer> {
  const input = data instanceof Uint8Array ? data : new Uint8Array(data)
  const iv = input.slice(0, IV_LENGTH)
  const ciphertext = input.slice(IV_LENGTH)
  const plaintext = await crypto.subtle.decrypt(
    { name: ALGO, iv },
    key,
    ciphertext
  )
  return plaintext
}

export async function decryptJSON<T = unknown>(key: CryptoKey, base64Data: string): Promise<T> {
  const decrypted = await decryptChunk(key, base64ToUint8(base64Data))
  return JSON.parse(new TextDecoder().decode(decrypted)) as T
}

export async function encryptJSON(key: CryptoKey, obj: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(obj))
  const encrypted = await encryptChunk(key, bytes)
  return uint8ToBase64(new Uint8Array(encrypted))
}

// Constant-time string comparison to prevent timing side-channels in
// credential checks. Length difference is folded into the result so
// early-exit on mismatched lengths can't leak info.
export function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a)
  const bBytes = new TextEncoder().encode(b)
  const maxLen = Math.max(aBytes.length, bBytes.length, 1)
  let diff = aBytes.length ^ bBytes.length
  for (let i = 0; i < maxLen; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0)
  }
  return diff === 0
}

// Generate a shared fingerprint from both public keys for visual verification.
// Both sides produce the same fingerprint by sorting keys before hashing.
export async function getKeyFingerprint(
  localPubBytes: Uint8Array,
  remotePubBytes: Uint8Array
): Promise<string> {
  const digest = await sortedKeyDigest(new Uint8Array(localPubBytes), new Uint8Array(remotePubBytes))
  return Array.from(digest.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ')
}
