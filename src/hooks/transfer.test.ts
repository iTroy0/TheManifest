import { describe, it, expect } from 'vitest'
import { buildChunkPacket, parseChunkPacket, CHUNK_SIZE, CHAT_IMAGE_FILE_INDEX } from '../utils/fileChunker'
import {
  generateKeyPair, exportPublicKey, importPublicKey, deriveSharedKey,
  encryptChunk, decryptChunk, encryptJSON, decryptJSON,
} from '../utils/crypto'

// ── Helpers ──────────────────────────────────────────────────────────────

interface SharedKeys {
  senderKey: CryptoKey
  receiverKey: CryptoKey
}

interface ChunkResult {
  fileIndex: number
  chunkIndex: number
  data: Uint8Array
}

interface ReassembleResult {
  result: Uint8Array
  chunks: ChunkResult[]
}

// Derive a shared key pair (simulates sender + receiver key exchange)
async function makeSharedKeys(): Promise<SharedKeys> {
  const sender: CryptoKeyPair = await generateKeyPair()
  const receiver: CryptoKeyPair = await generateKeyPair()
  const senderPub: Uint8Array = await exportPublicKey(sender.publicKey)
  const receiverPub: Uint8Array = await exportPublicKey(receiver.publicKey)
  const senderKey: CryptoKey = await deriveSharedKey(sender.privateKey, await importPublicKey(receiverPub))
  const receiverKey: CryptoKey = await deriveSharedKey(receiver.privateKey, await importPublicKey(senderPub))
  return { senderKey, receiverKey }
}

// Simulate chunking a file's bytes into packets (mirrors transferEngine.sendFile)
async function chunkAndEncrypt(bytes: Uint8Array, fileIndex: number, key: CryptoKey): Promise<ArrayBuffer[]> {
  const packets: ArrayBuffer[] = []
  let offset = 0
  let chunkIndex = 0
  while (offset < bytes.length) {
    const chunkSize: number = Math.min(CHUNK_SIZE, bytes.length - offset)
    const slice: Uint8Array = bytes.subarray(offset, offset + chunkSize)
    const encrypted: ArrayBuffer = await encryptChunk(key, slice)
    const packet: ArrayBuffer = buildChunkPacket(fileIndex, chunkIndex, encrypted)
    packets.push(packet)
    offset += chunkSize
    chunkIndex++
  }
  return packets
}

// Simulate receiving packets (mirrors handleChunk)
async function decryptAndReassemble(packets: ArrayBuffer[], key: CryptoKey): Promise<ReassembleResult> {
  const chunks: ChunkResult[] = []
  for (const packet of packets) {
    const { fileIndex, chunkIndex, data } = parseChunkPacket(packet)
    const plain: ArrayBuffer = await decryptChunk(key, data)
    chunks.push({ fileIndex, chunkIndex, data: new Uint8Array(plain) })
  }
  const totalSize: number = chunks.reduce((s, c) => s + c.data.byteLength, 0)
  const result = new Uint8Array(totalSize)
  let off = 0
  for (const c of chunks) {
    result.set(c.data, off)
    off += c.data.byteLength
  }
  return { result, chunks }
}

// ── File Transfer Pipeline ───────────────────────────────────────────────

describe('File Transfer Pipeline (encrypt → chunk → packet → parse → decrypt)', () => {
  it('round-trips a small file (1KB)', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const original = new Uint8Array(1024)
    for (let i = 0; i < original.length; i++) original[i] = i % 256

    const packets = await chunkAndEncrypt(original, 0, senderKey)
    expect(packets.length).toBe(1) // 1KB < 256KB chunk

    const { result } = await decryptAndReassemble(packets, receiverKey)
    expect(result).toEqual(original)
  })

  it('round-trips a multi-chunk file (512KB = 2 chunks)', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const original = new Uint8Array(512 * 1024)
    for (let i = 0; i < original.length; i++) original[i] = i % 256

    const packets = await chunkAndEncrypt(original, 0, senderKey)
    expect(packets.length).toBe(2)

    const { result } = await decryptAndReassemble(packets, receiverKey)
    expect(result).toEqual(original)
  })

  it('round-trips a large file (1MB = 4 chunks)', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const original = new Uint8Array(1024 * 1024)
    for (let i = 0; i < original.length; i++) original[i] = (i * 7) % 256

    const packets = await chunkAndEncrypt(original, 0, senderKey)
    expect(packets.length).toBe(4)

    const { result } = await decryptAndReassemble(packets, receiverKey)
    expect(result).toEqual(original)
  })

  it('preserves file index across chunks', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const original = new Uint8Array(600 * 1024) // 3 chunks

    const packets = await chunkAndEncrypt(original, 42, senderKey)
    const { chunks } = await decryptAndReassemble(packets, receiverKey)

    for (const c of chunks) {
      expect(c.fileIndex).toBe(42)
    }
    expect(chunks.map(c => c.chunkIndex)).toEqual([0, 1, 2])
  })

  it('handles empty file', async () => {
    const { senderKey } = await makeSharedKeys()
    const original = new Uint8Array(0)

    const packets = await chunkAndEncrypt(original, 0, senderKey)
    expect(packets.length).toBe(0)
  })

  it('rejects tampered chunk (GCM auth failure)', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const original = new Uint8Array(100)

    const packets = await chunkAndEncrypt(original, 0, senderKey)
    // Tamper with the encrypted data inside the packet
    const tampered = new Uint8Array(packets[0])
    tampered[20] ^= 0xFF
    const tamperedPacket: ArrayBuffer = tampered.buffer

    const { data } = parseChunkPacket(tamperedPacket)
    await expect(decryptChunk(receiverKey, data)).rejects.toThrow()
  })

  it('rejects wrong key', async () => {
    const sender = await makeSharedKeys()
    const wrongKey: CryptoKey = (await makeSharedKeys()).receiverKey
    const original = new Uint8Array(100)

    const packets = await chunkAndEncrypt(original, 0, sender.senderKey)
    const { data } = parseChunkPacket(packets[0])
    await expect(decryptChunk(wrongKey, data)).rejects.toThrow()
  })
})

// ── Chat Image Pipeline ─────────────────────────────────────────────────

describe('Chat Image Pipeline (binary chunks with CHAT_IMAGE_FILE_INDEX)', () => {
  it('round-trips a GIF through the image chunk path', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    // Simulate a 500KB GIF
    const gif = new Uint8Array(500 * 1024)
    for (let i = 0; i < gif.length; i++) gif[i] = (i * 13) % 256

    const packets = await chunkAndEncrypt(gif, CHAT_IMAGE_FILE_INDEX, senderKey)

    // All packets should use the image sentinel
    for (const p of packets) {
      const { fileIndex } = parseChunkPacket(p)
      expect(fileIndex).toBe(CHAT_IMAGE_FILE_INDEX)
    }

    const { result } = await decryptAndReassemble(packets, receiverKey)
    expect(result).toEqual(gif)
  })

  it('image metadata round-trips through encryptJSON', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const meta = { mime: 'image/gif', size: 500000, text: 'check this out', time: Date.now() }

    const encrypted: string = await encryptJSON(senderKey, meta)
    const decrypted = await decryptJSON<{ mime: string; size: number; text: string; time: number }>(receiverKey, encrypted)

    expect(decrypted.mime).toBe('image/gif')
    expect(decrypted.size).toBe(500000)
    expect(decrypted.text).toBe('check this out')
    expect(decrypted.time).toBe(meta.time)
  })
})

// ── Chat Message Encryption ─────────────────────────────────────────────

describe('Chat Message Encryption', () => {
  it('round-trips a text message', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const msg = { text: 'Hello from sender!', replyTo: null }

    const encrypted: string = await encryptJSON(senderKey, msg)
    const decrypted = await decryptJSON<{ text: string; replyTo: null }>(receiverKey, encrypted)

    expect(decrypted.text).toBe('Hello from sender!')
    expect(decrypted.replyTo).toBeNull()
  })

  it('round-trips a message with unicode and emoji', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const msg = { text: 'Hello 世界! 🎉🔥💯' }

    const decrypted = await decryptJSON<{ text: string }>(receiverKey, await encryptJSON(senderKey, msg))
    expect(decrypted.text).toBe('Hello 世界! 🎉🔥💯')
  })

  it('round-trips a message with reply context', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const msg = {
      text: 'I agree!',
      replyTo: { text: 'What do you think?', from: 'Alice', time: 1234567890 },
    }

    const decrypted = await decryptJSON<{ text: string; replyTo: { from: string; text: string; time: number } }>(receiverKey, await encryptJSON(senderKey, msg))
    expect(decrypted.replyTo.from).toBe('Alice')
    expect(decrypted.replyTo.text).toBe('What do you think?')
  })
})

// ── Password Verification ────────────────────────────────────────────────

describe('Password Verification (constant-time)', () => {
  // Mirrors the comparison in useSender.js
  function constantTimeCompare(a: string, b: string): boolean {
    const aBuf: Uint8Array = new TextEncoder().encode(a)
    const bBuf: Uint8Array = new TextEncoder().encode(b)
    let match: number = aBuf.length === bBuf.length ? 0 : 1
    for (let i = 0; i < aBuf.length; i++) match |= aBuf[i] ^ (bBuf[i] || 0)
    return match === 0 && aBuf.length > 0
  }

  it('accepts correct password', () => {
    expect(constantTimeCompare('secret123', 'secret123')).toBe(true)
  })

  it('rejects wrong password', () => {
    expect(constantTimeCompare('secret123', 'wrong')).toBe(false)
  })

  it('rejects empty password', () => {
    expect(constantTimeCompare('', '')).toBe(false)
  })

  it('rejects password with different length', () => {
    expect(constantTimeCompare('short', 'muchlongerpassword')).toBe(false)
  })

  it('rejects password differing by one character', () => {
    expect(constantTimeCompare('password1', 'password2')).toBe(false)
  })

  it('handles unicode passwords', () => {
    expect(constantTimeCompare('p@$$w0rd!🔑', 'p@$$w0rd!🔑')).toBe(true)
    expect(constantTimeCompare('p@$$w0rd!🔑', 'p@$$w0rd!🗝️')).toBe(false)
  })
})

// ── Mock Connection Integration ──────────────────────────────────────────

interface MockMessage {
  type?: string
  key?: number[]
  [key: string]: unknown
}

interface MockConn {
  send: (data: MockMessage | ArrayBuffer) => void
  open: boolean
}

interface MockConnectionPair {
  senderConn: MockConn
  receiverConn: MockConn
  senderMessages: MockMessage[]
  receiverMessages: (MockMessage | ArrayBuffer)[]
}

describe('Mock Connection Integration (sender → receiver data flow)', () => {
  // Simple mock that simulates conn.send() delivering to the other side
  function createMockConnectionPair(): MockConnectionPair {
    const senderMessages: MockMessage[] = []
    const receiverMessages: (MockMessage | ArrayBuffer)[] = []
    const senderConn: MockConn = {
      send: (data: MockMessage | ArrayBuffer) => receiverMessages.push(structuredClone(data) as MockMessage | ArrayBuffer),
      open: true,
    }
    const receiverConn: MockConn = {
      send: (data: MockMessage | ArrayBuffer) => senderMessages.push(structuredClone(data) as MockMessage),
      open: true,
    }
    return { senderConn, receiverConn, senderMessages, receiverMessages }
  }

  it('simulates key exchange producing matching shared keys', async () => {
    const { senderConn, receiverConn, senderMessages, receiverMessages } = createMockConnectionPair()

    // Sender generates keypair and sends public key
    const senderKP: CryptoKeyPair = await generateKeyPair()
    const senderPub: Uint8Array = await exportPublicKey(senderKP.publicKey)
    senderConn.send({ type: 'public-key', key: Array.from(senderPub) })

    // Receiver gets sender's public key
    const senderPubMsg = receiverMessages.find(m => (m as MockMessage).type === 'public-key') as MockMessage | undefined
    expect(senderPubMsg).toBeDefined()

    // Receiver generates keypair, sends back, derives shared key
    const receiverKP: CryptoKeyPair = await generateKeyPair()
    const receiverPub: Uint8Array = await exportPublicKey(receiverKP.publicKey)
    receiverConn.send({ type: 'public-key', key: Array.from(receiverPub) })

    const remoteSenderPub: CryptoKey = await importPublicKey(new Uint8Array(senderPubMsg!.key!))
    const receiverKey: CryptoKey = await deriveSharedKey(receiverKP.privateKey, remoteSenderPub)

    // Sender gets receiver's public key and derives shared key
    const receiverPubMsg = senderMessages.find(m => m.type === 'public-key') as MockMessage | undefined
    const remoteReceiverPub: CryptoKey = await importPublicKey(new Uint8Array(receiverPubMsg!.key!))
    const senderKey: CryptoKey = await deriveSharedKey(senderKP.privateKey, remoteReceiverPub)

    // Both keys should decrypt each other's messages
    const testData: Uint8Array = new TextEncoder().encode('hello from integration test')
    const encrypted: ArrayBuffer = await encryptChunk(senderKey, testData)
    const decrypted: ArrayBuffer = await decryptChunk(receiverKey, new Uint8Array(encrypted))
    expect(new TextDecoder().decode(decrypted)).toBe('hello from integration test')
  })

  it('simulates full file transfer: manifest → request → chunks → done', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()
    const { senderConn, receiverMessages } = createMockConnectionPair()

    // 1. Sender sends manifest
    const fileContent = new Uint8Array(300 * 1024) // 300KB file
    for (let i = 0; i < fileContent.length; i++) fileContent[i] = (i * 3) % 256

    senderConn.send({
      type: 'manifest',
      files: [{ name: 'test.bin', size: fileContent.length, type: 'application/octet-stream' }],
      totalSize: fileContent.length,
    })

    const manifest = receiverMessages.find(m => (m as MockMessage).type === 'manifest') as MockMessage | undefined
    expect((manifest!.files as Array<{ name: string }>)[0].name).toBe('test.bin')

    // 2. Sender sends file-start
    const totalChunks: number = Math.ceil(fileContent.length / CHUNK_SIZE)
    senderConn.send({ type: 'file-start', name: 'test.bin', size: fileContent.length, index: 0, totalChunks, resumeFrom: 0 })

    // 3. Sender sends encrypted chunks
    const packets: ArrayBuffer[] = await chunkAndEncrypt(fileContent, 0, senderKey)
    for (const p of packets) {
      // Simulate conn.send(packet) — packet is ArrayBuffer
      receiverMessages.push(p)
    }

    // 4. Sender sends file-end
    senderConn.send({ type: 'file-end', index: 0 })

    // 5. Receiver decrypts and reassembles
    const chunkPackets = receiverMessages.filter(m => m instanceof ArrayBuffer || (m as unknown as ArrayBuffer).byteLength !== undefined) as unknown as ArrayBuffer[]
    const { result } = await decryptAndReassemble(chunkPackets, receiverKey)

    expect(result).toEqual(fileContent)
    expect(result.length).toBe(300 * 1024)
  })

  it('simulates chat image flow: start → chunks → end', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()

    // Simulate a 100KB image
    const imageBytes = new Uint8Array(100 * 1024)
    for (let i = 0; i < imageBytes.length; i++) imageBytes[i] = (i * 17) % 256

    // 1. Encrypt and send start metadata
    const meta = { mime: 'image/gif', size: imageBytes.length, text: 'cool gif', time: Date.now() }
    const encMeta: string = await encryptJSON(senderKey, meta)

    // 2. Encrypt and chunk the image body using CHAT_IMAGE_FILE_INDEX
    const packets: ArrayBuffer[] = await chunkAndEncrypt(imageBytes, CHAT_IMAGE_FILE_INDEX, senderKey)

    // 3. Encrypt end marker
    const encEnd: string = await encryptJSON(senderKey, {})

    // 4. Receiver decrypts metadata
    const decMeta = await decryptJSON<{ mime: string; size: number; text: string; time: number }>(receiverKey, encMeta)
    expect(decMeta.mime).toBe('image/gif')
    expect(decMeta.size).toBe(imageBytes.length)
    expect(decMeta.text).toBe('cool gif')

    // 5. Receiver decrypts and reassembles chunks
    const { result, chunks } = await decryptAndReassemble(packets, receiverKey)
    for (const c of chunks) {
      expect(c.fileIndex).toBe(CHAT_IMAGE_FILE_INDEX)
    }
    expect(result).toEqual(imageBytes)

    // 6. Receiver decrypts end marker
    const decEnd = await decryptJSON(receiverKey, encEnd)
    expect(decEnd).toEqual({})
  })

  it('simulates encrypted password exchange', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()

    // Receiver encrypts password and sends to sender
    const password = 'MySecretPass123!'
    const encPassword: ArrayBuffer = await encryptChunk(receiverKey, new TextEncoder().encode(password))

    // Sender decrypts and verifies
    const decrypted: ArrayBuffer = await decryptChunk(senderKey, new Uint8Array(encPassword))
    const received: string = new TextDecoder().decode(decrypted)
    expect(received).toBe(password)
  })

  it('multiple files in sequence maintain correct indices', async () => {
    const { senderKey, receiverKey } = await makeSharedKeys()

    const file1 = new Uint8Array(100).fill(0xAA)
    const file2 = new Uint8Array(200).fill(0xBB)
    const file3 = new Uint8Array(150).fill(0xCC)

    const packets1: ArrayBuffer[] = await chunkAndEncrypt(file1, 0, senderKey)
    const packets2: ArrayBuffer[] = await chunkAndEncrypt(file2, 1, senderKey)
    const packets3: ArrayBuffer[] = await chunkAndEncrypt(file3, 2, senderKey)

    const { result: r1 } = await decryptAndReassemble(packets1, receiverKey)
    const { result: r2 } = await decryptAndReassemble(packets2, receiverKey)
    const { result: r3 } = await decryptAndReassemble(packets3, receiverKey)

    expect(r1).toEqual(file1)
    expect(r2).toEqual(file2)
    expect(r3).toEqual(file3)
  })
})
