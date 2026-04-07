// End-to-end encryption using ECDH key exchange + AES-256-GCM
// This layer encrypts data BEFORE it enters the WebRTC channel,
// so even a compromised TURN relay sees only encrypted bytes.

const ALGO = 'AES-GCM'
const KEY_LENGTH = 256
const IV_LENGTH = 12 // 96 bits for AES-GCM

// Generate an ECDH keypair
export async function generateKeyPair() {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false, // private key stays in WebCrypto, public key exported separately
    ['deriveBits']
  )
  return keyPair
}

// Export public key to raw bytes for transmission
export async function exportPublicKey(publicKey) {
  const raw = await crypto.subtle.exportKey('raw', publicKey)
  return new Uint8Array(raw)
}

// Import a raw public key from the other peer
export async function importPublicKey(rawBytes) {
  const buffer = rawBytes instanceof ArrayBuffer ? rawBytes : rawBytes.buffer
  return crypto.subtle.importKey(
    'raw',
    buffer,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
}

// Derive a shared AES-256-GCM key from our private key + their public key
export async function deriveSharedKey(privateKey, remotePublicKey) {
  const bits = await crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePublicKey },
    privateKey,
    KEY_LENGTH
  )
  return crypto.subtle.importKey(
    'raw',
    bits,
    { name: ALGO, length: KEY_LENGTH },
    false,
    ['encrypt', 'decrypt']
  )
}

// Encrypt a chunk: prepends 12-byte IV to ciphertext
export async function encryptChunk(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
  const plaintext = data instanceof Uint8Array ? data : new Uint8Array(data)
  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGO, iv },
    key,
    plaintext
  )
  // [IV (12 bytes)][ciphertext]
  const output = new Uint8Array(IV_LENGTH + ciphertext.byteLength)
  output.set(iv, 0)
  output.set(new Uint8Array(ciphertext), IV_LENGTH)
  return output.buffer
}

// Decrypt a chunk: reads IV from first 12 bytes
export async function decryptChunk(key, data) {
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

// Generate a shared fingerprint from both public keys for visual verification
// Both sides produce the same fingerprint by sorting keys before hashing
export async function getKeyFingerprint(localPubBytes, remotePubBytes) {
  const a = new Uint8Array(localPubBytes)
  const b = new Uint8Array(remotePubBytes)
  // Sort deterministically so both sides get the same order
  let first = a, second = b
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] < b[i]) break
    if (a[i] > b[i]) { first = b; second = a; break }
  }
  const combined = new Uint8Array(first.length + second.length)
  combined.set(first, 0)
  combined.set(second, first.length)
  const hash = await crypto.subtle.digest('SHA-256', combined)
  const arr = new Uint8Array(hash)
  return Array.from(arr.slice(0, 8))
    .map(b => b.toString(16).padStart(2, '0'))
    .join(' ')
}
