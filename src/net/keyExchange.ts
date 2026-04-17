// ECDH handshake finalizer. Given our local key pair's public half and the
// remote peer's public half, derive the shared AES key and the fingerprint
// string. Extracted from the four hooks where this sequence was duplicated.
//
// Site-specific concerns (where to store the result, what to dispatch next,
// how to deal with password gating) stay in the caller — only the crypto
// lives here.

import { importPublicKey, deriveSharedKey, getKeyFingerprint } from '../utils/crypto'

export interface KeyExchangeResult {
  encryptKey: CryptoKey
  fingerprint: string
}

export async function finalizeKeyExchange(args: {
  localPrivate: CryptoKey
  localPublic: Uint8Array
  remotePublic: Uint8Array
}): Promise<KeyExchangeResult> {
  const remoteKey = await importPublicKey(args.remotePublic)
  const encryptKey = await deriveSharedKey(
    args.localPrivate,
    remoteKey,
    args.localPublic,
    args.remotePublic,
  )
  const fingerprint = await getKeyFingerprint(args.localPublic, args.remotePublic)
  return { encryptKey, fingerprint }
}
