# P1.D transferEngine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated chunk-transfer code from four hooks into a single `src/net/transferEngine/` subsystem consumed via injected `WireAdapter` (portal / collab). Preserves every invariant; pure refactor.

**Architecture:** Factory functions (no classes); adapter owns wire shape + crypto; engine owns transport loop and resume cursor; Session (P1.C) owns lifecycle + transfer handles. See `docs/plan-transferEngine.md` for the full design doc — this plan executes it.

**Tech Stack:** TypeScript strict, React hooks, vitest, PeerJS DataConnection, Web Crypto API, WritableStream.

**Preconditions:** branch `dev` at or after current HEAD (`37c8386`), 309/309 tests passing, `tsc --noEmit` clean.

---

## File Structure

**New files:**
- `src/net/transferEngine/types.ts` — interfaces only, no runtime.
- `src/net/transferEngine/index.ts` — barrel re-exports.
- `src/net/transferEngine/sendFile.ts` — `sendFile()` pure function.
- `src/net/transferEngine/createFileReceiver.ts` — factory.
- `src/net/transferEngine/adapters/portalWire.ts`
- `src/net/transferEngine/adapters/collabWire.ts`
- `src/net/transferEngine/sendFile.test.ts`
- `src/net/transferEngine/createFileReceiver.test.ts`
- `src/net/transferEngine/engine-loop.test.ts`
- `src/net/transferEngine/adapters/portalWire.test.ts`
- `src/net/transferEngine/adapters/collabWire.test.ts`

**Modified:**
- `src/net/protocol.ts` — add `packetIndex: number` to `collab-file-start`.
- `src/net/protocol-fuzz.test.ts` — include new field in generator.
- `src/hooks/useSender.ts` — replace `sendSingleFile` body with `sendFile` call; delete fn at bottom of file.
- `src/hooks/useReceiver.ts` — replace `streamsRef`/`handleChunk` with `createFileReceiver`.
- `src/hooks/useCollabGuest.ts` — replace outbound `sendFileToRequester` + inbound chunk path.
- `src/hooks/useCollabHost.ts` — replace owner-path `sendFileToRequester` + guest-upload receiver.

**Deleted (task 13):**
- `useSender.ts` `sendSingleFile` function + its signature.
- `useReceiver.ts` `streamsRef` Map and manual chunk handler.
- `useCollabHost.ts` `inProgressDownloadsRef`.
- `useCollabGuest.ts` `inProgressFilesRef`, `currentDownloadFileId` fields on MeshMeta (moved to engine's closure state).

---

## Phase 1 — Engine + adapters (no migrations)

### Task 1: types

**Files:**
- Create: `src/net/transferEngine/types.ts`

- [ ] **Step 1: Write the types file**

```ts
// src/net/transferEngine/types.ts
//
// Shared types for the transfer engine. Implementations live in
// sibling files; this module is type-only.

import type { AdaptiveChunker, ChunkPacket } from '../../utils/fileChunker'
import type { Session } from '../session'

export type SendResult = 'complete' | 'cancelled' | 'error'

export interface SendFileOpts {
  fileId: string
  totalChunks?: number
  startChunk?: number
  chunker?: AdaptiveChunker
  signal?: AbortSignal
  onProgress?: (bytesSent: number, totalBytes: number, chunkIndex: number) => void
}

export interface RecvOpts {
  fileId: string
  totalBytes: number
  totalChunks: number
  sink: WritableStream<Uint8Array>
  onProgress?: (bytesWritten: number, totalBytes: number) => void
}

export interface FileReceiver {
  onFileStart(opts: RecvOpts): Promise<void>
  onChunk(packet: ChunkPacket): Promise<void>
  onFileEnd(fileId: string): Promise<void>
  abort(fileId: string, reason: 'cancelled' | 'error'): Promise<void>
  getResumeCursor(fileId: string): number
  has(fileId: string): boolean
}

export interface WireAdapter {
  buildFileStart(
    session: Session,
    m: { fileId: string; name: string; size: number; totalChunks: number },
  ): Promise<unknown>
  buildFileEnd(session: Session, fileId: string): Promise<unknown>
  buildFileCancelled(session: Session, fileId: string): Promise<unknown>
  encryptChunk(session: Session, plaintext: ArrayBuffer): Promise<ArrayBuffer>
  decryptChunk(session: Session, ciphertext: ArrayBuffer): Promise<ArrayBuffer>
  packetIndexFor(fileId: string): number
  fileIdForPacketIndex(index: number): string | null
}
```

- [ ] **Step 2: Verify tsc clean**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/net/transferEngine/types.ts
git commit -m "feat(transferEngine): add shared types"
```

---

### Task 2: protocol change — packetIndex on collab-file-start

**Files:**
- Modify: `src/net/protocol.ts`
- Modify: `src/net/protocol-fuzz.test.ts`

- [ ] **Step 1: Add field to CollabInnerMsg.collab-file-start**

In `src/net/protocol.ts` find the union entry for `collab-file-start` and add `packetIndex: number`:

```ts
| {
    type: 'collab-file-start'
    fileId: string
    name: string
    size: number
    totalChunks: number
    packetIndex: number   // NEW — per-session allocation from collabWire
  }
```

- [ ] **Step 2: Update the fuzz test generator**

Open `src/net/protocol-fuzz.test.ts`. Find the random `CollabInnerMsg` generator and add a `packetIndex` in the `collab-file-start` branch:

```ts
case 'collab-file-start':
  return {
    type: 'collab-file-start',
    fileId: randomString(), name: randomString(),
    size: randomSmallInt(), totalChunks: randomSmallInt(),
    packetIndex: Math.floor(Math.random() * 0xFFFE),
  }
```

- [ ] **Step 3: Run the fuzz tests**

Run: `npm test -- protocol-fuzz`
Expected: all 24 tests pass (round-trip with new field works).

- [ ] **Step 4: Commit**

```bash
git add src/net/protocol.ts src/net/protocol-fuzz.test.ts
git commit -m "feat(protocol): add packetIndex to collab-file-start"
```

---

### Task 3: portalWire adapter

**Files:**
- Create: `src/net/transferEngine/adapters/portalWire.ts`
- Create: `src/net/transferEngine/adapters/portalWire.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/net/transferEngine/adapters/portalWire.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { portalWire } from './portalWire'
import { finalizeKeyExchange } from '../../keyExchange'
import type { Session } from '../../session'

function makeSessionWithKey(key: CryptoKey): Session {
  // minimal shape — only encryptKey is read by adapter
  return { encryptKey: key } as unknown as Session
}

describe('portalWire', () => {
  let key: CryptoKey

  beforeAll(async () => {
    const a = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
    const b = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
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
    }) as { type: string; fileId: string; name: string; size: number; totalChunks: number }
    expect(msg.type).toBe('file-start')
    expect(msg.fileId).toBe('file-0')
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
})
```

- [ ] **Step 2: Run test — expect import failure**

Run: `npm test -- portalWire`
Expected: FAIL "Cannot find module './portalWire'".

- [ ] **Step 3: Write the adapter**

```ts
// src/net/transferEngine/adapters/portalWire.ts
import { encryptChunk, decryptChunk } from '../../../utils/crypto'
import type { Session } from '../../session'
import type { PortalMsg } from '../../protocol'
import type { WireAdapter } from '../types'

function portalPacketIndex(fileId: string): number {
  const m = /^file-(\d+)$/.exec(fileId)
  if (!m) throw new Error(`portalWire.packetIndexFor: invalid fileId '${fileId}'`)
  const n = Number(m[1])
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFE) {
    throw new Error(`portalWire.packetIndexFor: out-of-range fileId '${fileId}'`)
  }
  return n
}

export const portalWire: WireAdapter = {
  async buildFileStart(_s, m) {
    return {
      type: 'file-start',
      fileId: m.fileId, name: m.name,
      size: m.size, totalChunks: m.totalChunks,
    } satisfies PortalMsg
  },

  async buildFileEnd(_s, fileId) {
    return { type: 'file-end', fileId } satisfies PortalMsg
  },

  async buildFileCancelled(_s, fileId) {
    return { type: 'file-cancelled', index: portalPacketIndex(fileId) } satisfies PortalMsg
  },

  async encryptChunk(session, pt) {
    if (!session.encryptKey) throw new Error('portalWire.encryptChunk: no key')
    return encryptChunk(session.encryptKey, pt)
  },

  async decryptChunk(session, ct) {
    if (!session.encryptKey) throw new Error('portalWire.decryptChunk: no key')
    return decryptChunk(session.encryptKey, ct)
  },

  packetIndexFor(fileId) {
    return portalPacketIndex(fileId)
  },

  fileIdForPacketIndex(i) {
    if (i < 0 || i > 0xFFFE) return null
    return `file-${i}`
  },
}
```

- [ ] **Step 4: Verify `encryptChunk`/`decryptChunk` signatures match**

Run: `npx tsc --noEmit`

If `src/utils/crypto.ts`'s `encryptChunk` takes `(key, ArrayBuffer) → Promise<ArrayBuffer>` — matches. If it takes `(key, Uint8Array) → Promise<Uint8Array>`, adjust adapter accordingly. Check the real signature before moving on.

- [ ] **Step 5: Run tests**

Run: `npm test -- portalWire`
Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/net/transferEngine/adapters/portalWire.ts src/net/transferEngine/adapters/portalWire.test.ts
git commit -m "feat(transferEngine): portalWire adapter"
```

---

### Task 4: collabWire adapter

**Files:**
- Create: `src/net/transferEngine/adapters/collabWire.ts`
- Create: `src/net/transferEngine/adapters/collabWire.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/net/transferEngine/adapters/collabWire.test.ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createCollabWire, type CollabWire } from './collabWire'
import { finalizeKeyExchange } from '../../keyExchange'
import type { Session } from '../../session'

function makeSession(key: CryptoKey): Session {
  return { encryptKey: key } as unknown as Session
}

describe('collabWire', () => {
  let key: CryptoKey

  beforeAll(async () => {
    const a = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
    const b = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
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
    const w = createCollabWire() as CollabWire
    w.seedFromInbound('remote-file', 42)
    expect(w.packetIndexFor('remote-file')).toBe(42)
    expect(w.fileIdForPacketIndex(42)).toBe('remote-file')
  })

  it('skips 0xFFFF (reserved for chat-image)', () => {
    const w = createCollabWire() as CollabWire
    // Pre-seed up to 0xFFFE via seedFromInbound to force allocator past 0xFFFF
    for (let i = 0; i < 0xFFFF; i++) w.seedFromInbound(`f-${i}`, i)
    expect(() => w.packetIndexFor('next')).toThrow(/exhausted/)
  })

  it('buildFileStart includes packetIndex field', async () => {
    const w = createCollabWire()
    const s = makeSession(key)
    const msg = await w.buildFileStart(s, {
      fileId: 'x', name: 'a.txt', size: 10, totalChunks: 1,
    }) as { type: string; packetIndex: number }
    expect(msg.type).toBe('collab-file-start')
    expect(msg.packetIndex).toBe(0)
  })

  it('encrypt/decrypt round-trips', async () => {
    const w = createCollabWire()
    const s = makeSession(key)
    const pt = new Uint8Array([1, 2, 3]).buffer
    const ct = await w.encryptChunk(s, pt)
    const back = await w.decryptChunk(s, ct)
    expect(new Uint8Array(back)).toEqual(new Uint8Array(pt))
  })
})
```

- [ ] **Step 2: Run test — expect import failure**

Run: `npm test -- collabWire`
Expected: FAIL.

- [ ] **Step 3: Write the adapter**

```ts
// src/net/transferEngine/adapters/collabWire.ts
import { encryptChunk, decryptChunk } from '../../../utils/crypto'
import type { Session } from '../../session'
import type { CollabInnerMsg } from '../../protocol'
import type { WireAdapter } from '../types'

export interface CollabWire extends WireAdapter {
  seedFromInbound(fileId: string, packetIndex: number): void
}

export function createCollabWire(): CollabWire {
  const toIdx = new Map<string, number>()
  const fromIdx = new Map<number, string>()
  let next = 0

  function allocate(fileId: string): number {
    const existing = toIdx.get(fileId)
    if (existing !== undefined) return existing
    while (fromIdx.has(next) || next === 0xFFFF) {
      if (next > 0xFFFE) throw new Error('collabWire: packet-index exhausted')
      next++
    }
    if (next > 0xFFFE) throw new Error('collabWire: packet-index exhausted')
    const idx = next++
    toIdx.set(fileId, idx)
    fromIdx.set(idx, fileId)
    return idx
  }

  return {
    async buildFileStart(_s, m) {
      const packetIndex = allocate(m.fileId)
      return {
        type: 'collab-file-start',
        fileId: m.fileId, name: m.name,
        size: m.size, totalChunks: m.totalChunks,
        packetIndex,
      } satisfies CollabInnerMsg
    },

    async buildFileEnd(_s, fileId) {
      return { type: 'collab-file-end', fileId } satisfies CollabInnerMsg
    },

    async buildFileCancelled(_s, fileId) {
      return { type: 'collab-cancel-file', fileId } satisfies CollabInnerMsg
    },

    async encryptChunk(session, pt) {
      if (!session.encryptKey) throw new Error('collabWire.encryptChunk: no key')
      return encryptChunk(session.encryptKey, pt)
    },

    async decryptChunk(session, ct) {
      if (!session.encryptKey) throw new Error('collabWire.decryptChunk: no key')
      return decryptChunk(session.encryptKey, ct)
    },

    packetIndexFor(fileId) {
      return allocate(fileId)
    },

    fileIdForPacketIndex(i) {
      return fromIdx.get(i) ?? null
    },

    seedFromInbound(fileId, packetIndex) {
      toIdx.set(fileId, packetIndex)
      fromIdx.set(packetIndex, fileId)
    },
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- collabWire`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/net/transferEngine/adapters/collabWire.ts src/net/transferEngine/adapters/collabWire.test.ts
git commit -m "feat(transferEngine): collabWire adapter with per-session index allocator"
```

---

### Task 5: sendFile

**Files:**
- Create: `src/net/transferEngine/sendFile.ts`
- Create: `src/net/transferEngine/sendFile.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/net/transferEngine/sendFile.test.ts
import { describe, it, expect, vi } from 'vitest'
import { sendFile } from './sendFile'
import { createSession } from '../session'
import type { Session, TransferHandle } from '../session'
import type { WireAdapter } from './types'

function mockAdapter(overrides: Partial<WireAdapter> = {}): WireAdapter {
  return {
    buildFileStart: vi.fn(async (_s, m) => ({ type: 'file-start', ...m })),
    buildFileEnd: vi.fn(async (_s, fileId) => ({ type: 'file-end', fileId })),
    buildFileCancelled: vi.fn(async (_s, fileId) => ({ type: 'file-cancelled', fileId })),
    encryptChunk: vi.fn(async (_s, pt) => pt),   // passthrough for test
    decryptChunk: vi.fn(async (_s, ct) => ct),
    packetIndexFor: vi.fn(() => 0),
    fileIdForPacketIndex: vi.fn(() => 'file-0'),
    ...overrides,
  }
}

function mockConn() {
  return {
    peer: 'peer-x',
    send: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    _dc: { bufferedAmount: 0, readyState: 'open',
           addEventListener: vi.fn(), removeEventListener: vi.fn() },
  } as unknown as import('peerjs').DataConnection
}

function mockFile(size: number): File {
  const data = new Uint8Array(size).map((_, i) => i & 0xff)
  return new File([data], 'test.bin')
}

function openAndAuth(session: Session): void {
  session.dispatch({ type: 'connect-start' })
  session.dispatch({ type: 'conn-open' })
  // simulate keys-derived without real crypto — adapter is mocked
  session.dispatch({
    type: 'keys-derived',
    encryptKey: {} as CryptoKey,
    fingerprint: 'xx',
  })
}

describe('sendFile', () => {
  it('happy path sends all chunks and returns complete', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(300 * 1024)   // 300 KB — ~2 chunks at 256 KB default
    const adapter = mockAdapter()
    const onProgress = vi.fn()

    const result = await sendFile(session, file, adapter, {
      fileId: 'file-0',
      onProgress,
    })

    expect(result).toBe('complete')
    expect(adapter.buildFileStart).toHaveBeenCalledTimes(1)
    expect(adapter.buildFileEnd).toHaveBeenCalledTimes(1)
    expect(adapter.buildFileCancelled).not.toHaveBeenCalled()
    expect(onProgress).toHaveBeenCalled()
  })

  it('cancelled via handle sends file-cancelled and returns cancelled', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(1024 * 1024)
    const adapter = mockAdapter({
      // stall encryption so we can flip the handle before the first send
      encryptChunk: vi.fn(async (_s, pt) => {
        await new Promise(r => setTimeout(r, 10))
        return pt
      }),
    })

    const p = sendFile(session, file, adapter, { fileId: 'file-0' })

    // after microtask settling, the transfer handle exists
    await new Promise(r => setTimeout(r, 5))
    const handle = session.activeTransfers.get('file-0') as TransferHandle
    handle.aborted = true

    expect(await p).toBe('cancelled')
    expect(adapter.buildFileCancelled).toHaveBeenCalled()
    expect(adapter.buildFileEnd).not.toHaveBeenCalled()
  })

  it('cancelled via AbortSignal returns cancelled', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(1024 * 1024)
    const adapter = mockAdapter({
      encryptChunk: vi.fn(async (_s, pt) => {
        await new Promise(r => setTimeout(r, 10))
        return pt
      }),
    })
    const ac = new AbortController()

    const p = sendFile(session, file, adapter, {
      fileId: 'file-0',
      signal: ac.signal,
    })
    await new Promise(r => setTimeout(r, 5))
    ac.abort()

    expect(await p).toBe('cancelled')
  })

  it('terminal session mid-stream returns error', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(1024 * 1024)
    const adapter = mockAdapter({
      encryptChunk: vi.fn(async (_s, pt) => {
        await new Promise(r => setTimeout(r, 10))
        return pt
      }),
    })

    const p = sendFile(session, file, adapter, { fileId: 'file-0' })
    await new Promise(r => setTimeout(r, 5))
    session.close('peer-disconnect')

    expect(await p).toBe('error')
  })

  it('startChunk skips earlier chunks', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = mockFile(3 * 256 * 1024)   // 3 chunks
    const adapter = mockAdapter()

    await sendFile(session, file, adapter, {
      fileId: 'file-0',
      startChunk: 2,
    })

    // Exactly one encryptChunk call — only chunk 2 is sent.
    expect(adapter.encryptChunk).toHaveBeenCalledTimes(1)
  })

  it('empty file emits start + end only', async () => {
    const conn = mockConn()
    const session = createSession({ conn, role: 'portal-sender' })
    openAndAuth(session)
    const file = new File([new Uint8Array(0)], 'empty.bin')
    const adapter = mockAdapter()

    const result = await sendFile(session, file, adapter, { fileId: 'file-0' })

    expect(result).toBe('complete')
    expect(adapter.encryptChunk).not.toHaveBeenCalled()
    expect(adapter.buildFileEnd).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test -- sendFile`
Expected: FAIL "Cannot find module './sendFile'".

- [ ] **Step 3: Write sendFile**

```ts
// src/net/transferEngine/sendFile.ts
//
// Sender half of the transfer engine. Pure function over (session,
// file, adapter, opts). Uses the session's TransferHandle for
// pause/resume/cancel bookkeeping and emits per-chunk progress via
// opts.onProgress. State transitions flow through
// session.beginTransfer / endTransfer — engine does NOT touch
// session.state directly.
//
// Abort sources checked every loop iter, in order:
//   1. handle.aborted         (session-driven — cancelTransfer / cancelAll)
//   2. session terminal       (lifecycle — close() from any source)
//   3. opts.signal?.aborted   (caller-driven — React unmount, user cancel)

import { chunkFileAdaptive, buildChunkPacket, waitForBufferDrain } from '../../utils/fileChunker'
import type { Session, TransferHandle } from '../session'
import type { SendFileOpts, SendResult, WireAdapter } from './types'

function isTerminal(s: Session['state']): boolean {
  return s === 'closed' || s === 'error' || s === 'kicked'
}

export async function sendFile(
  session: Session,
  file: File,
  adapter: WireAdapter,
  opts: SendFileOpts,
): Promise<SendResult> {
  const handle: TransferHandle = {
    transferId: opts.fileId,
    direction: 'outbound',
    aborted: false,
    paused: false,
  }
  session.beginTransfer(handle)

  // Derive totalChunks: prefer explicit opt, else compute from file + chunker.
  const chunkSize = opts.chunker?.getChunkSize() ?? 256 * 1024
  const totalChunks = opts.totalChunks ?? Math.max(1, Math.ceil(file.size / chunkSize))

  let result: SendResult = 'complete'

  try {
    session.send((await adapter.buildFileStart(session, {
      fileId: opts.fileId,
      name: file.name,
      size: file.size,
      totalChunks,
    })) as Record<string, unknown>)
  } catch {
    result = 'error'
  }

  const startAt = opts.startChunk ?? 0
  let chunkIndex = 0
  let bytesSent = 0

  if (result === 'complete' && file.size > 0) {
    for await (const { buffer } of chunkFileAdaptive(file, opts.chunker ?? null)) {
      if (chunkIndex < startAt) {
        chunkIndex++
        continue
      }

      if (handle.aborted) { result = 'cancelled'; break }
      if (isTerminal(session.state)) { result = 'error'; break }
      if (opts.signal?.aborted) { result = 'cancelled'; break }

      if (handle.paused) {
        await new Promise<void>(resolve => {
          handle.pauseResolver = resolve
        })
        // After wake: re-check all abort sources before proceeding.
        if (handle.aborted) { result = 'cancelled'; break }
        if (isTerminal(session.state)) { result = 'error'; break }
        if (opts.signal?.aborted) { result = 'cancelled'; break }
      }

      try {
        const ct = await adapter.encryptChunk(session, buffer)
        const packet = buildChunkPacket(
          adapter.packetIndexFor(opts.fileId),
          chunkIndex,
          ct,
        )
        session.sendBinary(packet)
        await waitForBufferDrain(session.conn as unknown as { _dc?: RTCDataChannel })
      } catch {
        result = 'error'
        break
      }

      bytesSent += buffer.byteLength
      opts.onProgress?.(bytesSent, file.size, chunkIndex)
      chunkIndex++
    }
  }

  // Tail — notify peer of completion / cancellation if the session is
  // still live. Errors here are benign: peer may already be gone.
  try {
    if (result === 'cancelled' || result === 'error') {
      if (!isTerminal(session.state)) {
        session.send((await adapter.buildFileCancelled(session, opts.fileId)) as Record<string, unknown>)
      }
    } else {
      session.send((await adapter.buildFileEnd(session, opts.fileId)) as Record<string, unknown>)
    }
  } catch {
    /* peer gone; best-effort */
  }

  session.endTransfer(opts.fileId, result)
  return result
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- sendFile`
Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/net/transferEngine/sendFile.ts src/net/transferEngine/sendFile.test.ts
git commit -m "feat(transferEngine): sendFile with triple-abort + resume cursor"
```

---

### Task 6: createFileReceiver

**Files:**
- Create: `src/net/transferEngine/createFileReceiver.ts`
- Create: `src/net/transferEngine/createFileReceiver.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// src/net/transferEngine/createFileReceiver.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createFileReceiver } from './createFileReceiver'
import type { Session } from '../session'
import type { ChunkPacket } from '../../utils/fileChunker'
import type { WireAdapter } from './types'

function mockAdapter(): WireAdapter {
  return {
    buildFileStart: vi.fn(),
    buildFileEnd: vi.fn(),
    buildFileCancelled: vi.fn(),
    encryptChunk: vi.fn(),
    decryptChunk: vi.fn(async (_s, ct) => ct),
    packetIndexFor: vi.fn(() => 0),
    fileIdForPacketIndex: vi.fn((i: number) => i === 0 ? 'file-0' : null),
  }
}

function accumulatingSink(): { stream: WritableStream<Uint8Array>; bytes: () => Uint8Array } {
  const chunks: Uint8Array[] = []
  const stream = new WritableStream<Uint8Array>({
    write(chunk) { chunks.push(chunk) },
  })
  return {
    stream,
    bytes: () => {
      const total = chunks.reduce((n, c) => n + c.byteLength, 0)
      const out = new Uint8Array(total)
      let off = 0
      for (const c of chunks) { out.set(c, off); off += c.byteLength }
      return out
    },
  }
}

function pkt(chunkIndex: number, bytes: Uint8Array): ChunkPacket {
  return { fileIndex: 0, chunkIndex, data: bytes.buffer }
}

function mockSession(): Session {
  return { encryptKey: {} as CryptoKey } as unknown as Session
}

describe('createFileReceiver', () => {
  it('writes chunks and closes writer on fileEnd', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 3, totalChunks: 1, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([7, 8, 9])))
    expect(recv.has('file-0')).toBe(true)
    await recv.onFileEnd('file-0')

    expect(sink.bytes()).toEqual(new Uint8Array([7, 8, 9]))
    expect(recv.has('file-0')).toBe(false)
  })

  it('resume cursor is monotonic max (out-of-order chunks)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 30, totalChunks: 3, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1])))
    expect(recv.getResumeCursor('file-0')).toBe(1)
    await recv.onChunk(pkt(2, new Uint8Array([2])))
    expect(recv.getResumeCursor('file-0')).toBe(3)
    await recv.onChunk(pkt(1, new Uint8Array([3])))
    expect(recv.getResumeCursor('file-0')).toBe(3)   // stays at max
  })

  it('drops chunk for unknown packet index', async () => {
    const session = mockSession()
    const adapter: WireAdapter = { ...mockAdapter(), fileIdForPacketIndex: () => null }
    const recv = createFileReceiver(session, adapter)

    await recv.onChunk({ fileIndex: 99, chunkIndex: 0, data: new ArrayBuffer(4) })
    // should not throw; receiver state empty
    expect(recv.has('file-0')).toBe(false)
  })

  it('drops chunk when no active fileStart for that fileId', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)

    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    expect(recv.has('file-0')).toBe(false)
  })

  it('decrypt failure drops chunk silently (cursor unchanged)', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    adapter.decryptChunk = vi.fn(async () => { throw new Error('boom') })
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 3, totalChunks: 1, sink: sink.stream })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))

    expect(recv.getResumeCursor('file-0')).toBe(0)
    expect(sink.bytes().byteLength).toBe(0)
  })

  it('abort aborts the writer and deletes the entry', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const abortSpy = vi.fn()
    const stream = new WritableStream<Uint8Array>({
      write() {},
      abort(reason) { abortSpy(reason) },
    })

    await recv.onFileStart({ fileId: 'file-0', totalBytes: 10, totalChunks: 1, sink: stream })
    await recv.abort('file-0', 'cancelled')

    expect(abortSpy).toHaveBeenCalledWith('cancelled')
    expect(recv.has('file-0')).toBe(false)
  })

  it('onProgress fires with bytes-so-far and total', async () => {
    const session = mockSession()
    const adapter = mockAdapter()
    const recv = createFileReceiver(session, adapter)
    const sink = accumulatingSink()
    const progress = vi.fn()

    await recv.onFileStart({
      fileId: 'file-0', totalBytes: 6, totalChunks: 2,
      sink: sink.stream, onProgress: progress,
    })
    await recv.onChunk(pkt(0, new Uint8Array([1, 2, 3])))
    await recv.onChunk(pkt(1, new Uint8Array([4, 5, 6])))

    expect(progress).toHaveBeenNthCalledWith(1, 3, 6)
    expect(progress).toHaveBeenNthCalledWith(2, 6, 6)
  })
})
```

- [ ] **Step 2: Run tests — expect failure**

Run: `npm test -- createFileReceiver`
Expected: FAIL.

- [ ] **Step 3: Write createFileReceiver**

```ts
// src/net/transferEngine/createFileReceiver.ts
//
// Receiver half of the transfer engine. Factory returning an object
// that closes over per-file write state (sink, writer, monotonic
// chunk cursor, byte counter). One receiver per session.
//
// The engine is decrypt + write + track; the hook is responsible for
// parsing the wire message, constructing the sink (StreamSaver vs
// in-memory fallback), and deciding how to react to repeated decrypt
// failures. Keeps the engine browser-agnostic and role-agnostic.

import type { Session } from '../session'
import type { ChunkPacket } from '../../utils/fileChunker'
import type { FileReceiver, RecvOpts, WireAdapter } from './types'

interface Entry {
  sink: WritableStream<Uint8Array>
  writer: WritableStreamDefaultWriter<Uint8Array>
  totalChunks: number
  totalBytes: number
  bytesWritten: number
  lastIdx: number
  onProgress?: RecvOpts['onProgress']
}

export function createFileReceiver(
  session: Session,
  adapter: WireAdapter,
): FileReceiver {
  const perFile = new Map<string, Entry>()

  return {
    async onFileStart(opts) {
      const writer = opts.sink.getWriter()
      perFile.set(opts.fileId, {
        sink: opts.sink, writer,
        totalChunks: opts.totalChunks,
        totalBytes: opts.totalBytes,
        bytesWritten: 0,
        lastIdx: 0,
        onProgress: opts.onProgress,
      })
    },

    async onChunk(packet: ChunkPacket) {
      const fileId = adapter.fileIdForPacketIndex(packet.fileIndex)
      if (!fileId) return
      const entry = perFile.get(fileId)
      if (!entry) return

      let plaintext: ArrayBuffer
      try {
        plaintext = await adapter.decryptChunk(session, packet.data)
      } catch {
        // Drop silently. Hook decides whether a decrypt-failure streak
        // warrants closing the session.
        return
      }

      await entry.writer.write(new Uint8Array(plaintext))
      entry.bytesWritten += plaintext.byteLength
      entry.lastIdx = Math.max(entry.lastIdx, packet.chunkIndex + 1)  // M11
      entry.onProgress?.(entry.bytesWritten, entry.totalBytes)
    },

    async onFileEnd(fileId) {
      const entry = perFile.get(fileId)
      if (!entry) return
      try {
        await entry.writer.close()
      } finally {
        perFile.delete(fileId)
      }
    },

    async abort(fileId, reason) {
      const entry = perFile.get(fileId)
      if (!entry) return
      try {
        await entry.writer.abort(reason)
      } finally {
        perFile.delete(fileId)
      }
    },

    getResumeCursor(fileId) {
      return perFile.get(fileId)?.lastIdx ?? 0
    },

    has(fileId) {
      return perFile.has(fileId)
    },
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- createFileReceiver`
Expected: 7 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/net/transferEngine/createFileReceiver.ts src/net/transferEngine/createFileReceiver.test.ts
git commit -m "feat(transferEngine): createFileReceiver with M11 monotonic cursor"
```

---

### Task 7: barrel + integration test

**Files:**
- Create: `src/net/transferEngine/index.ts`
- Create: `src/net/transferEngine/engine-loop.test.ts`

- [ ] **Step 1: Write the barrel**

```ts
// src/net/transferEngine/index.ts
export type {
  SendFileOpts, SendResult, RecvOpts, FileReceiver, WireAdapter,
} from './types'
export { sendFile } from './sendFile'
export { createFileReceiver } from './createFileReceiver'
export { portalWire } from './adapters/portalWire'
export { createCollabWire, type CollabWire } from './adapters/collabWire'
```

- [ ] **Step 2: Write the integration test**

```ts
// src/net/transferEngine/engine-loop.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { sendFile, createFileReceiver, portalWire } from './index'
import { createSession } from '../session'
import { finalizeKeyExchange } from '../keyExchange'
import { parseChunkPacket } from '../../utils/fileChunker'
import type { Session } from '../session'

// Tiny in-memory DataConnection pair — one-way wiring mirrors what the
// real send loop does. Matches the surface used by Session.send /
// sendBinary / waitForBufferDrain.
function pair(): { a: any; b: any } {
  const aHandlers = { data: [] as Array<(d: unknown) => void> }
  const bHandlers = { data: [] as Array<(d: unknown) => void> }

  const fakeDc = {
    bufferedAmount: 0,
    bufferedAmountLowThreshold: 0,
    readyState: 'open' as const,
    addEventListener: () => {},
    removeEventListener: () => {},
  }

  const a = {
    peer: 'B',
    send: (d: unknown) => bHandlers.data.forEach(fn => fn(d)),
    on: (ev: string, fn: (d: unknown) => void) => {
      if (ev === 'data') aHandlers.data.push(fn)
    },
    off: () => {},
    _dc: fakeDc,
  }

  const b = {
    peer: 'A',
    send: (d: unknown) => aHandlers.data.forEach(fn => fn(d)),
    on: (ev: string, fn: (d: unknown) => void) => {
      if (ev === 'data') bHandlers.data.push(fn)
    },
    off: () => {},
    _dc: fakeDc,
  }

  return { a, b }
}

async function keyPair(): Promise<{ a: CryptoKey; b: CryptoKey }> {
  const keyA = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
  const keyB = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey'])
  const aPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyA.publicKey))
  const bPub = new Uint8Array(await crypto.subtle.exportKey('raw', keyB.publicKey))
  const a = (await finalizeKeyExchange({ localPrivate: keyA.privateKey, localPublic: aPub, remotePublic: bPub })).encryptKey
  const b = (await finalizeKeyExchange({ localPrivate: keyB.privateKey, localPublic: bPub, remotePublic: aPub })).encryptKey
  return { a, b }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

function authSession(s: Session, key: CryptoKey): void {
  s.dispatch({ type: 'connect-start' })
  s.dispatch({ type: 'conn-open' })
  s.dispatch({ type: 'keys-derived', encryptKey: key, fingerprint: 'test' })
}

describe('engine-loop integration', () => {
  let senderSession: Session
  let receiverSession: Session
  let connA: any
  let connB: any

  beforeEach(async () => {
    const { a, b } = pair()
    connA = a
    connB = b
    const { a: keyA, b: keyB } = await keyPair()
    senderSession = createSession({ conn: connA, role: 'portal-sender' })
    receiverSession = createSession({ conn: connB, role: 'portal-receiver' })
    authSession(senderSession, keyA)
    authSession(receiverSession, keyB)
  })

  it('128 KB random file round-trips with matching SHA-256', async () => {
    const bytes = new Uint8Array(128 * 1024)
    crypto.getRandomValues(bytes)
    const file = new File([bytes], 'payload.bin')

    const chunks: Uint8Array[] = []
    const receiver = createFileReceiver(receiverSession, portalWire)
    const sink = new WritableStream<Uint8Array>({ write(c) { chunks.push(c) } })

    connA.on('data', async (msg: unknown) => {
      if (msg instanceof ArrayBuffer) {
        await receiver.onChunk(parseChunkPacket(msg))
      } else {
        const m = msg as { type: string; fileId?: string; size?: number; totalChunks?: number }
        if (m.type === 'file-start') {
          await receiver.onFileStart({
            fileId: m.fileId!, totalBytes: m.size!, totalChunks: m.totalChunks!, sink,
          })
        } else if (m.type === 'file-end') {
          await receiver.onFileEnd(m.fileId!)
        }
      }
    })
    // The pair wires A→B for `a.send`; we want the receiver listening
    // on B. Swap if the wiring differs — adjust to match your stub.
    // (Comment: `a.send` fires `bHandlers.data`; receiver listens on B.)

    const result = await sendFile(senderSession, file, portalWire, { fileId: 'file-0' })
    expect(result).toBe('complete')

    const total = chunks.reduce((n, c) => n + c.byteLength, 0)
    const assembled = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { assembled.set(c, off); off += c.byteLength }
    expect(await sha256(assembled)).toBe(await sha256(bytes))
  })
})
```

> **Note:** the stub wiring in the test may need a quick adjust after running once — the `on('data')` call fires synchronously inside `send()`. If you see a deadlock, wrap the fan-out in `queueMicrotask(() => fn(d))`.

- [ ] **Step 3: Run tests**

Run: `npm test -- engine-loop`
Expected: 1 test passes. If it deadlocks, add the `queueMicrotask` fix noted above.

- [ ] **Step 4: Run ALL tests to ensure no existing regressions**

Run: `npm test`
Expected: 309 + (6+6+6+7+1) = 335 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/net/transferEngine/index.ts src/net/transferEngine/engine-loop.test.ts
git commit -m "feat(transferEngine): barrel + integration round-trip"
```

---

## Phase 2 — Migrations

**Before starting any migration task:** the migration snippets reference existing hook-level helpers (`buildReceiverSink`, `buildGuestSink`, `buildHostUploadSink`) and reducer actions (`UPDATE_PROGRESS`, `COMPLETE_FILE`, `CANCEL_FILE`, `UPDATE_UPLOAD_PROGRESS`). These names in the plan are suggestive — they map to existing inline logic in the hooks today. Before writing code for a migration task:

1. Grep the hook for the inline sink construction logic (look for `StreamSaver`, `WritableStream`, or `navigator.storage`) — extract or reuse.
2. Grep for `dispatchTransfer(` to find the actual action shape used in that hook; the names may differ from the plan.
3. Keep the actual action names consistent with what the hook's reducer already accepts. Engine contract only cares about `onProgress(written, total)` and `onFileStart/onFileEnd/abort` — the hook is free to wire those to any reducer action name.

### Task 8: migrate useSender

**Files:**
- Modify: `src/hooks/useSender.ts`

- [ ] **Step 1: Read useSender.ts lines 938-1000 (sendSingleFile)**

Understand the current signature:
```ts
async function sendSingleFile(
  conn: DataConnection,
  files: SendFile[],
  index: number,
  startChunkIndex: number,
  entry: ConnEntry,
  encryptKey: CryptoKey,
  aggregateUI: () => void,
): Promise<void>
```

- [ ] **Step 2: Replace the four call sites**

Find each call site (lines 647, 663, 684, 701 — may drift slightly after edits) and replace:

```ts
// BEFORE:
await sendSingleFile(conn, filesRef.current, msg.index as number, resumeChunk, entry, session.encryptKey, aggregateUI)

// AFTER:
const file = filesRef.current[msg.index as number]?.file
if (!file) {
  log.warn('useSender.sendFile.missingFile', { index: msg.index })
  return
}
const result = await sendFile(session, file, portalWire, {
  fileId: `file-${msg.index}`,
  startChunk: resumeChunk,
  chunker: entry.meta.chunker,
  signal: entry.meta.abort.signal,
  onProgress: (sent, total, chunkIndex) => {
    entry.meta.totalSent = sent
    entry.meta.progress = total > 0 ? sent / total : 0
    entry.meta.currentFileIndex = msg.index as number
    aggregateUI()
  },
})
if (result !== 'complete') {
  log.warn('useSender.sendFile.result', { result, index: msg.index })
}
```

Adjust the 3 other call sites (the two that use `idx` / `i` loop vars, and the resume path that uses `msg.fileIndex`/`msg.chunkIndex`).

- [ ] **Step 3: Add the imports at the top of useSender.ts**

```ts
import { sendFile, portalWire } from '../net/transferEngine'
```

- [ ] **Step 4: Delete the sendSingleFile function**

Remove the entire `async function sendSingleFile(...)` block (and its header comment line `// ── sendSingleFile ──`).

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: all tests pass. If `transfer.test.ts` regresses, inspect its simulation — it may be calling `sendSingleFile` directly via a module-level test helper; update the helper to use `sendFile`.

- [ ] **Step 6: Run type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 7: Manual smoke test (local dev server)**

1. `npm run dev` (in a second terminal).
2. Open two browser tabs to the dev URL.
3. Tab A: host portal, add a ~5 MB file.
4. Tab B: receiver portal, join, download.
5. Verify file arrives with matching byte length.
6. Tab B: mid-transfer, click Cancel. Verify tab A stops sending.
7. Tab B: rejoin, download again. Verify resume works.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useSender.ts
git commit -m "refactor(useSender): migrate sendSingleFile to transferEngine.sendFile"
```

---

### Task 9: migrate useReceiver

**Files:**
- Modify: `src/hooks/useReceiver.ts`

- [ ] **Step 1: Identify current chunk ingest path**

Grep for `streamsRef`, `handleChunk`, and `lastChunkIndexRef`. These are the three pieces the engine replaces:
- `streamsRef` → replaced by receiver factory's closure.
- `handleChunk` body → replaced by `receiver.onChunk(parseChunkPacket(ab))`.
- `lastChunkIndexRef` → replaced by `receiver.getResumeCursor(fileId)`.

- [ ] **Step 2: Wire in createFileReceiver**

Near the top of the hook body, alongside `sessionRef`, add:
```ts
const receiverRef = useRef<FileReceiver | null>(null)
```

In the handler that processes `public-key` (or wherever the session becomes authenticated) initialise:
```ts
receiverRef.current = createFileReceiver(sessionRef.current!, portalWire)
```

On `enableRelay`, null out and re-create on the new session.

On unmount/close, `receiverRef.current?.abort(currentFileId, 'cancelled')` for any active file, then null out.

- [ ] **Step 3: Replace inbound `file-start` handler**

```ts
case 'file-start': {
  const msg = data as Extract<PortalMsg, { type: 'file-start' }>
  const sink = buildReceiverSink(msg.fileId, msg.size, msg.name)   // existing helper
  await receiverRef.current!.onFileStart({
    fileId: msg.fileId,
    totalBytes: msg.size,
    totalChunks: msg.totalChunks,
    sink,
    onProgress: (written, total) => {
      dispatchTransfer({ type: 'UPDATE_PROGRESS',
        fileId: msg.fileId, bytesWritten: written, totalBytes: total })
    },
  })
  break
}
```

- [ ] **Step 4: Replace binary chunk handler**

```ts
// In the binary-data branch of conn.on('data'):
if (data instanceof ArrayBuffer) {
  const packet = parseChunkPacket(data)
  await receiverRef.current?.onChunk(packet)
  return
}
```

- [ ] **Step 5: Replace `file-end` handler**

```ts
case 'file-end': {
  const msg = data as Extract<PortalMsg, { type: 'file-end' }>
  await receiverRef.current?.onFileEnd(msg.fileId)
  dispatchTransfer({ type: 'COMPLETE_FILE', fileId: msg.fileId })
  break
}
```

- [ ] **Step 6: Replace `file-cancelled` handler**

```ts
case 'file-cancelled': {
  const msg = data as Extract<PortalMsg, { type: 'file-cancelled' }>
  const fileId = `file-${msg.index}`
  await receiverRef.current?.abort(fileId, 'cancelled')
  dispatchTransfer({ type: 'CANCEL_FILE', fileId })
  break
}
```

- [ ] **Step 7: Update resume path**

Where the hook currently reads `lastChunkIndexRef.current`, replace with:
```ts
const cursor = receiverRef.current?.getResumeCursor(fileId) ?? 0
conn.send({ type: 'request-file', index, chunkIndex: cursor } satisfies PortalMsg)
```

- [ ] **Step 8: Delete `streamsRef` + `lastChunkIndexRef` declarations**

Grep-clean.

- [ ] **Step 9: Run tests**

Run: `npm test`
Expected: pass.

- [ ] **Step 10: Manual smoke test**

Same as Task 8 Step 7 but from the receiver side. Test out-of-order chunk survival by toggling network throttle in devtools.

- [ ] **Step 11: Commit**

```bash
git add src/hooks/useReceiver.ts
git commit -m "refactor(useReceiver): migrate chunk ingest to transferEngine.createFileReceiver"
```

---

### Task 10: migrate useCollabGuest

**Files:**
- Modify: `src/hooks/useCollabGuest.ts`

- [ ] **Step 1: Add collabWire per session**

Each Session needs its own `CollabWire` instance (per-session packet-index allocator). Attach via a side-map OR as a field on `MeshMeta` / a new `GuestHostMeta`:

```ts
interface MeshMeta {
  inProgressFiles: /* will be deleted in Task 12 */
  currentDownloadFileId: /* will be deleted in Task 12 */
  wire: CollabWire                       // NEW
  receiver: FileReceiver                  // NEW
}

interface GuestHostMeta {
  wire: CollabWire                        // NEW (hostSessionRef's wire)
  receiver: FileReceiver                  // NEW
}
```

On mesh session creation, initialise `wire = createCollabWire()` and `receiver = createFileReceiver(session, wire)`.

On host session creation (`hostSessionRef` after keys-derived), same.

- [ ] **Step 2: Replace `sendFileToRequester`**

```ts
const sendFileToRequester = useCallback(async (
  fileId: string,
  peerId: string,
): Promise<void> => {
  const file = myFilesRef.current.find(f => f.id === fileId)?.file
  if (!file) return

  const mesh = peerConnectionsRef.current.get(peerId)
  const session = mesh?.session ?? hostSessionRef.current
  const wire = mesh?.meta.wire ?? hostMetaRef.current?.wire
  if (!session || !wire) return

  await sendFile(session, file, wire, {
    fileId,
    onProgress: (sent, total) => {
      dispatchTransfer({ type: 'UPDATE_UPLOAD_PROGRESS',
        fileId, peerId, bytesSent: sent, totalBytes: total })
    },
  })
}, [/* deps */])
```

- [ ] **Step 3: Replace inbound `collab-file-start` handler (both host-conn + mesh paths)**

```ts
case 'collab-file-start': {
  const m = decoded as Extract<CollabInnerMsg, { type: 'collab-file-start' }>
  // Seed the wire's index map before chunks arrive.
  meta.wire.seedFromInbound(m.fileId, m.packetIndex)
  const sink = buildGuestSink(m.fileId, m.size, m.name)
  await meta.receiver.onFileStart({
    fileId: m.fileId,
    totalBytes: m.size, totalChunks: m.totalChunks,
    sink,
    onProgress: (written, total) => {
      dispatchTransfer({ type: 'UPDATE_PROGRESS', fileId: m.fileId, bytesWritten: written, totalBytes: total })
    },
  })
  break
}
```

- [ ] **Step 4: Replace binary chunk handler**

```ts
if (data instanceof ArrayBuffer) {
  await meta.receiver.onChunk(parseChunkPacket(data))
  return
}
```

- [ ] **Step 5: Replace `collab-file-end` handler**

```ts
case 'collab-file-end': {
  const m = decoded as Extract<CollabInnerMsg, { type: 'collab-file-end' }>
  await meta.receiver.onFileEnd(m.fileId)
  dispatchTransfer({ type: 'COMPLETE_FILE', fileId: m.fileId })
  break
}
```

- [ ] **Step 6: Replace `collab-cancel-file` handler**

```ts
case 'collab-cancel-file': {
  const m = decoded as Extract<CollabInnerMsg, { type: 'collab-cancel-file' }>
  await meta.receiver.abort(m.fileId, 'cancelled')
  // preserve existing origin-check + activeTransferRoutes cleanup
  // (P0 fix #3) — those stay in the hook.
  break
}
```

- [ ] **Step 7: Run tests + smoke test**

Run: `npm test`
Smoke: two guest tabs join a collab room via a third host tab. Guest A shares a file; Guest B downloads. Verify bytes match. Test pause/resume/cancel on mesh direct path.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useCollabGuest.ts
git commit -m "refactor(useCollabGuest): migrate file send/recv to transferEngine (mesh + host-conn)"
```

---

### Task 11: migrate useCollabHost

**Files:**
- Modify: `src/hooks/useCollabHost.ts`

- [ ] **Step 1: Understand host's two roles**

Host is either:
- **Owner** — host adds its own files; sends on request. This path uses `sendFile`.
- **Relay** — host forwards chunks between two guests. The chunks are encrypted with the two guests' mesh key that the host does NOT hold. Pure bytes-forwarding. **Stays unchanged.**

- [ ] **Step 2: Add wire + receiver to GuestEntry**

```ts
interface GuestMeta {
  chunker: AdaptiveChunker
  progressThrottler: ProgressThrottler
  wire: CollabWire               // NEW
  uploadReceiver: FileReceiver   // NEW — inbound guest uploads
}
```

Initialise on guest session creation.

- [ ] **Step 3: Replace owner-path `sendFileToRequester`**

Find the branch that sends host-owned files. Replace its body with:
```ts
await sendFile(entry.session, file, entry.meta.wire, {
  fileId,
  chunker: entry.meta.chunker,
  onProgress: (sent, total) => {
    entry.meta.progressThrottler.update(sent, total, (s, t) => {
      dispatchTransfer({ type: 'UPDATE_UPLOAD_PROGRESS', fileId, peerId: entry.session.peerId, bytesSent: s, totalBytes: t })
    })
  },
})
```

The relay path (foreign-owned files, where host is forwarding encrypted bytes it cannot decrypt) stays as-is. Add a comment:

```ts
// INTENTIONAL: host does not decrypt mesh-encrypted chunks here.
// This is pure bytes-forwarding between two authenticated guest peers.
// transferEngine is not used on the relay path — see plan-transferEngine.md.
```

- [ ] **Step 4: Replace inbound guest-upload `collab-file-start`**

```ts
case 'collab-file-start': {
  const m = decoded as Extract<CollabInnerMsg, { type: 'collab-file-start' }>
  entry.meta.wire.seedFromInbound(m.fileId, m.packetIndex)
  const sink = buildHostUploadSink(m.fileId, m.size, m.name, entry.session.peerId)
  await entry.meta.uploadReceiver.onFileStart({
    fileId: m.fileId, totalBytes: m.size, totalChunks: m.totalChunks, sink,
  })
  break
}
```

- [ ] **Step 5: Replace guest-upload chunk + end paths**

Mirror Task 10 Steps 4-5 but on `entry.meta.uploadReceiver`.

- [ ] **Step 6: Run tests + smoke test**

Run: `npm test`
Smoke: host shares a file → guest downloads; guest shares a file → host receives. Both byte-level verified.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useCollabHost.ts
git commit -m "refactor(useCollabHost): migrate owner file send + guest upload recv to transferEngine"
```

---

## Phase 3 — Cleanup

### Task 12: delete dead code

**Files:**
- Modify: `src/hooks/useSender.ts` — confirm `sendSingleFile` deleted.
- Modify: `src/hooks/useReceiver.ts` — delete `streamsRef`, `lastChunkIndexRef`.
- Modify: `src/hooks/useCollabHost.ts` — delete `inProgressDownloadsRef` (if still present).
- Modify: `src/hooks/useCollabGuest.ts` — delete `inProgressFiles` + `currentDownloadFileId` from `MeshMeta`.

- [ ] **Step 1: grep-sweep for dead identifiers**

Run each:
```bash
rtk grep -nE "sendSingleFile|streamsRef|lastChunkIndexRef|inProgressDownloadsRef|inProgressFiles|currentDownloadFileId" src/
```

Expected output: zero hits in `src/hooks/`. The only hits should be in tests (if any) — update them.

- [ ] **Step 2: Clean up MeshMeta type**

Remove the unused fields from the interface:
```ts
// BEFORE:
interface MeshMeta {
  inProgressFiles: Map<string, { chunks: Uint8Array[]; ... }>
  currentDownloadFileId: string | null
  wire: CollabWire
  receiver: FileReceiver
}

// AFTER:
interface MeshMeta {
  wire: CollabWire
  receiver: FileReceiver
}
```

- [ ] **Step 3: Verify line-count targets**

Run:
```bash
rtk wc -l src/hooks/useSender.ts src/hooks/useReceiver.ts src/hooks/useCollabHost.ts src/hooks/useCollabGuest.ts
```

Expected:
- useSender < 1000 (from 1126)
- useReceiver < 950 (from 1056)
- useCollabHost < 1500 (from 1635)
- useCollabGuest < 1800 (from 1974)

If a hook hasn't shrunk enough, inspect for leftover bookkeeping that moved to the engine's closure.

- [ ] **Step 4: Full regression run**

Run: `npm test`
Expected: ≥ 335 passing (309 prior + 26+ new for the engine).

Run: `npx tsc --noEmit`
Expected: clean.

Run: `npm run build`
Expected: clean build.

- [ ] **Step 5: Staging run — the five scenarios**

Open the production build locally (`npm run preview`). Run each end-to-end:
1. Portal 1:1: 100 MB file, SHA-256 match.
2. Portal 1:N (2 receivers): each byte-verified.
3. Collab host-owned file → guest download: verified.
4. Collab guest-owned file → guest download (mesh direct): verified.
5. Collab guest-owned file → guest download (host relay): verified.

- [ ] **Step 6: Update roadmap**

Edit `docs/audit-roadmap.md` to mark P1.D done. In the TL;DR section, change the line about P1.C being complete and P1.D being next milestone to reflect P1.D shipped.

- [ ] **Step 7: Final commit**

```bash
git add src/hooks/useSender.ts src/hooks/useReceiver.ts src/hooks/useCollabHost.ts src/hooks/useCollabGuest.ts docs/audit-roadmap.md
git commit -m "chore(transferEngine): delete dead code + mark P1.D done"
```

---

## Acceptance checklist

- [ ] `src/net/transferEngine/` exists with types, sendFile, createFileReceiver, portalWire, createCollabWire.
- [ ] ~26 new tests land; 309 prior tests still pass; `tsc --noEmit` clean.
- [ ] All four hooks migrated; sendSingleFile / streamsRef / inProgressDownloadsRef / inProgressFilesRef grep-clean in `src/hooks/`.
- [ ] Hook line counts under the targets above.
- [ ] Five staging scenarios verified end-to-end with byte-level SHA-256 matches.
- [ ] `docs/audit-roadmap.md` reflects P1.D done.
- [ ] No behaviour change visible to users.
