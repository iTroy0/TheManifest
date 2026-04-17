# P1.D — `src/net/transferEngine/` plan

Unify the four independent file send/receive paths (one per hook) into a
single engine consumed through a `WireAdapter` interface. Sits directly
on top of `Session` (P1.C) and `protocol.ts` (P1.B); pulls the chunk
loop, resume cursor, pause/resume/cancel plumbing out of the hooks.

Baseline: branch `dev`, HEAD after P1.C complete (309/309 tests).
Plan date: 2026-04-17. Don't start coding until this is reviewed.

---

## Motivation

Today four copies of the same chunk pipeline live in the hooks:

| Path | File | Scope |
|------|------|-------|
| `sendSingleFile` | `useSender.ts:938` | Portal 1:N sender |
| `handleChunk` + `streamsRef` | `useReceiver.ts` | Portal receiver |
| `sendFileToRequester` | `useCollabHost.ts:411` | Collab host (owner path) |
| `sendFileToRequester` | `useCollabGuest.ts:318` | Collab guest (mesh + host-conn) |

Plus four copies of the inbound chunk-assembly path (write sink, resume
cursor, progress throttle, abort). Every change has to land in 4-8
places. M11 (resume cursor backwards) and M15 (per-peer vs hook-level
chunkQueue race) both came from ad-hoc chunk state that would not exist
if every transfer went through a single engine with documented
invariants.

P1.B locked the wire shapes. P1.C locked the per-peer lifecycle.
**P1.D locks the per-transfer byte pipeline.**

---

## Scope

**In:** file send + file recv across all four hooks. File identified by
string `fileId`; bytes identified by `(fileIndex: u16, chunkIndex: u32)`
packet header, unchanged from today.

**Out (P1.D.2 follow-up):** chat-image binary stream (uses
`CHAT_IMAGE_FILE_INDEX = 0xFFFF` on the same packet pipeline). Engine
API is designed to accept a future `ImageWireAdapter` — the packet
header sentinel stays reserved.

**Out (forever):** host-relay byte-passthrough. When collab host relays
chunks from a guest-owner to a guest-requester, the host never decrypts
(mesh is E2E between the two guests). That is pure bytes-forwarding and
stays hook-level; engine is not involved on either side of the relay.
Guest-owner runs `sendFile` on its mesh session to the requester; the
host is just a DataConnection hop.

---

## Layout

```
src/net/transferEngine/
  index.ts                     ← barrel: re-exports + shared types
  types.ts                     ← SendFileOpts, RecvOpts, WireAdapter,
                                  TransferResult, FileReceiver interface
  sendFile.ts                  ← sendFile(session, file, adapter, opts)
  createFileReceiver.ts        ← factory returning FileReceiver
  adapters/
    portalWire.ts              ← PortalMsg file-* adapter
    collabWire.ts              ← CollabInnerMsg collab-file-* adapter
                                  (encrypts inner payload inside collab-msg-enc)
  sendFile.test.ts
  createFileReceiver.test.ts
  engine-loop.test.ts          ← two-session round-trip integration
  adapters/portalWire.test.ts
  adapters/collabWire.test.ts
```

One import path for consumers: `import { sendFile, createFileReceiver,
portalWire, collabWire } from '../net/transferEngine'`.

**Circular-dep guard:** engine imports `Session`; Session must not
import engine. Engine imports `protocol.ts` for wire-shape types;
protocol must not import engine. Enforced by convention + `tsc`.

---

## API surface

```ts
// types.ts

import type { ChunkPacket, AdaptiveChunker } from '../../utils/fileChunker'
import type { Session } from '../session'

export interface WireAdapter {
  // Outbound — build the typed wire message for this dialect.
  // Return type is `unknown` because dialects produce different
  // satisfies-checked shapes (PortalMsg vs CollabInnerMsg). Caller of
  // `session.send` handles the actual typing at the call-site.
  buildFileStart(
    session: Session,
    m: { fileId: string; name: string; size: number; totalChunks: number },
  ): Promise<unknown>
  buildFileEnd(session: Session, fileId: string): Promise<unknown>
  buildFileCancelled(session: Session, fileId: string): Promise<unknown>

  // Crypto. Adapter owns the cipher so key rotation, alt suites, or a
  // no-crypto test double are a one-file change.
  encryptChunk(session: Session, plaintext: ArrayBuffer): Promise<ArrayBuffer>
  decryptChunk(session: Session, ciphertext: ArrayBuffer): Promise<ArrayBuffer>

  // Packet-index shim. Portal packs the manifest position into the
  // 16-bit packet header; collab hashes a per-session fileId → index
  // map on first use. Engine never touches the number itself.
  packetIndexFor(fileId: string): number
  fileIdForPacketIndex(index: number): string | null
}

export interface SendFileOpts {
  fileId: string
  totalChunks?: number           // derived from file.size/chunker if absent
  startChunk?: number            // resume cursor; default 0
  chunker?: AdaptiveChunker      // hook-owned; optional
  signal?: AbortSignal           // caller abort (unmount, user cancel)
  onProgress?(bytesSent: number, totalBytes: number, chunkIndex: number): void
}

export type SendResult = 'complete' | 'cancelled' | 'error'

export interface RecvOpts {
  fileId: string
  sink: WritableStream<Uint8Array>   // hook constructs
  totalBytes: number
  onProgress?(bytesWritten: number, totalBytes: number): void
}

export interface FileReceiver {
  // Caller has already parsed the wire message (P1.B discipline). Pass
  // the resolved fields directly; engine doesn't re-parse.
  onFileStart(opts: RecvOpts & { totalChunks: number }): Promise<void>
  onChunk(packet: ChunkPacket): Promise<void>
  onFileEnd(fileId: string): Promise<void>
  abort(fileId: string, reason: 'cancelled' | 'error'): Promise<void>
  // Monotonic — max(prev, chunkIndex+1). Safe for resume after reconnect.
  getResumeCursor(fileId: string): number
  // True iff the receiver holds state for this fileId.
  has(fileId: string): boolean
}
```

---

## Flow — sender

```
sendFile(session, file, adapter, opts) → Promise<SendResult>

1.  handle = { transferId: opts.fileId, direction: 'outbound',
                aborted: false, paused: false }
2.  session.beginTransfer(handle)              // state → 'transferring'
3.  totalChunks = opts.totalChunks ?? ceil(file.size / chunker.getChunkSize())
4.  session.send(await adapter.buildFileStart(session, {...}))
5.  startAt = opts.startChunk ?? 0
6.  bytesSent = startAt * avgChunkSize         // approximate for progress math
7.  chunkIndex = startAt
8.  for { buffer, offset } of chunkFileAdaptive(file, chunker):
      if chunkIndex < startAt → continue       // skip-on-resume
      check abort sources (in order, short-circuit on first hit):
        - handle.aborted                       // via session.cancelTransfer
        - isTerminal(session.state)            // session.close() mid-stream
        - opts.signal?.aborted                 // caller-driven (React unmount)
        → break loop, result = 'cancelled'
      if handle.paused:
        await new Promise<void>(r => handle.pauseResolver = r)
        // resumed by session.resumeTransfer → r()
        // cancelled by session.cancelTransfer → also invokes r(), then
        //  handle.aborted is true on next iter
      ciphertext = await adapter.encryptChunk(session, buffer)
      packet = buildChunkPacket(
        adapter.packetIndexFor(opts.fileId),
        chunkIndex,
        ciphertext,
      )
      try:
        session.sendBinary(packet)
        await waitForBufferDrain(session.conn)
      catch:
        result = 'error'; break
      bytesSent += buffer.byteLength
      opts.onProgress?.(bytesSent, file.size, chunkIndex)
      chunkIndex++
9.  tail:
      if result === 'cancelled':
        try: session.send(await adapter.buildFileCancelled(session, opts.fileId))
        catch: /* session already terminal; nothing to tell the peer */
      elif result === 'error': same as cancelled with 'error' classification
      else: result = 'complete';
        session.send(await adapter.buildFileEnd(session, opts.fileId))
10. session.endTransfer(opts.fileId, result)   // state → 'authenticated'
                                                // if activeTransfers empty
11. return result
```

**Why the three abort checks run every iter, not once:** session can
turn terminal asynchronously (peer-disconnect while we await drain);
handle.aborted flips from another event-loop tick; signal.aborted is
the React-unmount lever. Checking all three at the loop top keeps the
exit deterministic regardless of the wake path.

---

## Flow — receiver

```
createFileReceiver(session, adapter, opts) → FileReceiver

State owned by closure:
  perFile: Map<fileId, {
    sink: WritableStream<Uint8Array>
    writer: WritableStreamDefaultWriter<Uint8Array>
    totalChunks: number
    totalBytes: number
    bytesWritten: number
    lastIdx: number                // M11: max observed chunkIndex + 1
  }>

onFileStart(opts):
  // Caller (hook) has already parsed the inbound wire message via the
  // typed protocol.ts discriminated union (P1.B). Caller passes fileId,
  // totalBytes, totalChunks, and a constructed sink (StreamSaver or
  // in-memory fallback) directly — engine does not re-parse.
  writer = opts.sink.getWriter()
  perFile.set(opts.fileId, {
    sink: opts.sink, writer,
    totalChunks: opts.totalChunks,
    totalBytes: opts.totalBytes,
    bytesWritten: 0, lastIdx: 0,
  })

onChunk(packet):
  fileId = adapter.fileIdForPacketIndex(packet.fileIndex)
  if !fileId → drop silently (unknown packet index)
  entry = perFile.get(fileId)
  if !entry → drop silently (no matching start; M7 pattern)
  try:
    plaintext = await adapter.decryptChunk(session, packet.data)
  catch:
    // Decrypt failure: do NOT advance cursor, do NOT write. Hook
    // decides whether to abort the transfer (enough failures in a
    // row → close session with 'error'). Engine stays agnostic.
    return
  await entry.writer.write(new Uint8Array(plaintext))
  entry.bytesWritten += plaintext.byteLength
  entry.lastIdx = Math.max(entry.lastIdx, packet.chunkIndex + 1)  // M11
  opts.onProgress?.(entry.bytesWritten, entry.totalBytes)

onFileEnd(fileId):
  entry = perFile.get(fileId)
  if !entry → noop
  await entry.writer.close()
  perFile.delete(fileId)

abort(fileId, reason):
  entry = perFile.get(fileId)
  if !entry → noop
  await entry.writer.abort(reason)
  perFile.delete(fileId)

getResumeCursor(fileId):
  return perFile.get(fileId)?.lastIdx ?? 0

has(fileId):
  return perFile.has(fileId)
```

**Why no `session` field on perFile:** the factory captures `session`
once; every entry implicitly belongs to the same session. If a hook
needs cross-session receivers, it creates one receiver per session.

---

## WireAdapter specification

### `portalWire.ts`

```ts
export const portalWire: WireAdapter = {
  buildFileStart(_s, m) {
    // Portal's file-start is unencrypted JSON over the raw DataConnection.
    return { type: 'file-start', fileId: m.fileId, name: m.name,
             size: m.size, totalChunks: m.totalChunks } satisfies PortalMsg
  },
  buildFileEnd(_s, fileId) {
    return { type: 'file-end', fileId } satisfies PortalMsg
  },
  buildFileCancelled(_s, fileId) {
    const index = portalPacketIndex(fileId)
    return { type: 'file-cancelled', index } satisfies PortalMsg
  },
  encryptChunk(session, pt) {
    if (!session.encryptKey) throw new Error('portalWire.encryptChunk: no key')
    return encryptChunk(session.encryptKey, pt)
  },
  decryptChunk(session, ct) {
    if (!session.encryptKey) throw new Error('portalWire.decryptChunk: no key')
    return decryptChunk(session.encryptKey, ct)
  },
  packetIndexFor(fileId) { return portalPacketIndex(fileId) },
  fileIdForPacketIndex(i) { return `file-${i}` },
}

// Portal fileIds are deterministic 'file-<manifestPos>'; encode
// directly into the 16-bit header.
function portalPacketIndex(fileId: string): number {
  const n = Number(fileId.replace(/^file-/, ''))
  if (!Number.isInteger(n) || n < 0 || n > 0xFFFE) {
    throw new Error(`portalWire.packetIndexFor: invalid fileId '${fileId}'`)
  }
  return n
}
```

### `collabWire.ts`

```ts
export function createCollabWire(): WireAdapter {
  // Per-session (not per-engine) allocator. Allocation key is the
  // fileId itself; seeded on first `buildFileStart` (sender side) or
  // explicit `seedFromInbound(fileId, packetIndex)` call (receiver
  // side — the hook calls this after parsing an inbound
  // `collab-file-start` via P1.B's typed union).
  const toIdx = new Map<string, number>()
  const fromIdx = new Map<number, string>()
  let next = 0

  function allocate(fileId: string): number {
    const existing = toIdx.get(fileId)
    if (existing !== undefined) return existing
    while (fromIdx.has(next) || next === 0xFFFF) next++
    if (next > 0xFFFE) throw new Error('collabWire: packet-index exhausted')
    toIdx.set(fileId, next)
    fromIdx.set(next, fileId)
    return next++
  }

  return {
    async buildFileStart(_s, m) {
      const packetIndex = allocate(m.fileId)
      return { type: 'collab-file-start', fileId: m.fileId,
               name: m.name, size: m.size, totalChunks: m.totalChunks,
               packetIndex } satisfies CollabInnerMsg
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
    packetIndexFor(fileId) { return allocate(fileId) },
    fileIdForPacketIndex(i) { return fromIdx.get(i) ?? null },
    // Exposed for the receiving hook to seed after parsing an inbound
    // `collab-file-start` message (parsing lives at the hook per P1.B).
    // Attached as a non-interface method; exported via `CollabWire` type.
    seedFromInbound(fileId: string, packetIndex: number) {
      toIdx.set(fileId, packetIndex)
      fromIdx.set(packetIndex, fileId)
    },
  }
}
```

**Protocol change:** `CollabInnerMsg.collab-file-start` gains
`packetIndex: number` so the receiver can seed its index map before
chunks arrive. Additive; guests still running pre-P1.D code are fine
to ignore the field. Add the field to `src/net/protocol.ts`; update
`protocol-fuzz.test.ts`.

---

## Test plan (TDD — write before migration)

**Unit — `sendFile.test.ts`** (~12 tests):
- Happy path: mock session + mock adapter, 10 KB file, verify all chunks
  sent, `beginTransfer` + `endTransfer('complete')` called, onProgress
  fires ≥ 3 times, returns `'complete'`.
- Resume: `startChunk: 2` skips chunks 0-1, engine sends chunks 2+.
- Pause/resume: pre-seed `handle.paused = true`; verify loop blocks on
  `new Promise`. Trigger `session.resumeTransfer` → loop continues.
- Cancel via handle: `handle.aborted = true` → loop exits, sends
  `buildFileCancelled`, returns `'cancelled'`, `endTransfer('cancelled')`.
- Cancel via signal: `opts.signal.abort()` → same path.
- Terminal session mid-stream: `session.close(...)` → loop exits,
  `'error'`, `endTransfer('error')`. `send` inside tail try/catches.
- Drain timeout: adapter's encrypt OK; session's drain rejects.
  Engine returns `'error'`, `endTransfer('error')`.
- Empty file: 0 bytes, 0 chunks → `buildFileStart` + `buildFileEnd`
  emitted, no chunks sent, returns `'complete'`.
- Abort before first chunk: `handle.aborted` set after beginTransfer,
  before first iter → returns `'cancelled'`, one `buildFileCancelled`
  emitted.
- Adapter encrypt throws: returns `'error'`, no chunk sent after
  failure, `endTransfer('error')`.

**Unit — `createFileReceiver.test.ts`** (~10 tests):
- Happy path: onFileStart + onChunk×N + onFileEnd → writer.close called,
  entry deleted. `getResumeCursor` returns N afterwards (via `has`
  check: receiver deletes entry on end; test with `has` before end).
- Out-of-order: chunks arrive `[0, 2, 1]`. After each:
  `getResumeCursor` = 1, 3, 3 respectively. M11.
- Duplicate chunk: same chunkIndex twice → second write still happens
  (idempotence not enforced by engine; writer sees dup bytes), cursor
  unchanged after second.
- Abort: `abort(fileId, 'cancelled')` → writer.abort called with reason,
  entry deleted.
- Decrypt failure: adapter throws → chunk dropped, cursor unchanged,
  bytesWritten unchanged, onProgress NOT called.
- Unknown packet-index on onChunk: dropped silently.
- No matching start: onChunk before onFileStart → dropped silently.
- onFileEnd with no active file: noop.
- Writer.close throws: onFileEnd propagates — engine doesn't swallow
  sink errors (hook decides whether to warn + retry).

**Unit — `adapters/portalWire.test.ts`** (~6 tests):
- `buildFileStart` returns `satisfies PortalMsg` shape with all fields.
- `packetIndexFor('file-3')` = 3; `fileIdForPacketIndex(3)` = `'file-3'`.
- `packetIndexFor('file-0xFFFF')` throws (reserved).
- `packetIndexFor('garbage')` throws.
- Encrypt/decrypt round-trip with a real CryptoKey from keyExchange.
- Encrypt throws clearly when `session.encryptKey` is null.

**Unit — `adapters/collabWire.test.ts`** (~6 tests):
- `packetIndexFor` allocates 0, 1, 2 for successive new fileIds.
- Same fileId twice returns same index.
- `seedFromInbound` pre-registers index; subsequent `packetIndexFor`
  for the same fileId returns the seeded value.
- Skips 0xFFFF when allocating.
- Exhaustion: after 0..0xFFFE allocated, next allocation throws.
- buildFileStart shape satisfies CollabInnerMsg and includes
  `packetIndex` field.

**Integration — `engine-loop.test.ts`** (~4 tests):
- Two sessions (in-memory DataConnection stubs, real ECDH from P1.A),
  real portalWire. Send 128 KB random file, receiver writes to
  `new WritableStream` with an accumulator. Verify bytes SHA-256 match.
- Same with `startChunk: 3` on sender; receiver only gets chunks 3+;
  bytes match the tail of the file.
- Pause mid-stream, resume, complete. Bytes match.
- Cancel mid-stream. Receiver sees `abort()`, writer aborted, no
  partial file leaked.

**Total:** ~38 new tests. 309 + 38 = 347 target.

---

## Migration strategy

Five steps, each its own commit, bisectable.

### Step 1 — land engine + tests

Ship `src/net/transferEngine/` alongside existing hooks. Zero
consumers. Tests pass in isolation.

### Step 2 — migrate `useSender`

Replace `sendSingleFile` body with:
```ts
const sink = sinkForFileIndex(index)   // (sender doesn't need a sink;
                                        //  only recv uses sink)
const result = await sendFile(session, file, portalWire, {
  fileId: `file-${index}`,
  startChunk: resumeChunk,
  chunker: meta.chunker,
  signal: meta.abort.signal,
  onProgress: (sent, total, idx) => {
    meta.totalSent = sent
    meta.progress = sent / total
    aggregateUI(...)
  },
})
```

Delete the old `sendSingleFile` function. All 4 call sites (647, 663,
684, 701) now call `sendFile` directly.

### Step 3 — migrate `useReceiver`

Replace `streamsRef` + `handleChunk` with:
```ts
const receiver = createFileReceiver(session, portalWire, {})
// on inbound 'file-start':
await receiver.onFileStart({
  fileId: msg.fileId,
  totalChunks: msg.totalChunks,
  totalBytes: msg.size,
  sink: buildSink(msg),
  onProgress: (written, total) => dispatchTransfer(...),
})
// on inbound binary chunk:
await receiver.onChunk(parseChunkPacket(ab))
// on inbound 'file-end':
await receiver.onFileEnd(msg.fileId)
// enableRelay: receiver.abort(currentFileId, 'cancelled'); new session, new receiver
```

`lastChunkIndexRef` hook-level state goes away — engine's
`getResumeCursor` is the source. Hook calls `receiver.getResumeCursor`
on reconnect to seed the next `request-file.chunkIndex`.

### Step 4 — migrate `useCollabGuest` (mesh + host-conn, one commit)

`sendFileToRequester(fileId, peerId)` becomes:
```ts
const session = peerConnectionsRef.current.get(peerId)?.session
                ?? hostSessionRef.current
const file = myFilesRef.current.find(f => f.id === fileId)
const wire = collabWireRef.current
await sendFile(session, file, wire, {
  fileId,
  onProgress: (sent, total) => dispatchTransfer(...),
  signal: ...,
})
```

Inbound path: guest owns `guestFileReceiverRef = createFileReceiver(hostSession, wire, {})`
for host-conn path, plus one per mesh peer for mesh path. Each receiver
closes over its own session.

### Step 5 — migrate `useCollabHost`

Host OWNS files (broadcast own inventory): `sendFile(guestSession, file, collabWire, ...)` for each request.

Host RELAYS foreign files (guest-A → host → guest-B): **stays unchanged.**
This is the pure-bytes-forwarding path documented as out-of-scope
above. Document the rationale with a comment at the relay site.

Host INGESTS guest-uploads (guest → host file-share): use
`createFileReceiver(guestSession, collabWire, {})`.

### Step 6 — cleanup

After all four hooks migrated + a real mesh staging run:
- Delete `sendSingleFile` from useSender.
- Delete `streamsRef` declarations (replaced by receiver closure state).
- Delete `inProgressDownloadsRef` from useCollabHost owner path.
- Delete `inProgressFilesRef` + `currentDownloadFileId` from
  useCollabGuest (per-mesh-peer `MeshMeta` shrinks).
- grep for any remaining direct `buildChunkPacket` / `parseChunkPacket`
  calls outside the engine — they should not exist in hooks post-
  migration (except the chat-image path, which stays until P1.D.2).

Each step lands behind its own commit with a real two-peer staging run
before moving on. No feature flag — the engine swap is a pure refactor,
no behaviour change.

---

## Invariants preserved

Every security and reliability invariant from the P0/M findings must
still hold post-migration. Engine does not own most of these — the
fact that the engine is agnostic to them is part of the design.

- **P0 #3** — origin check for forwarded control (`requesterPeerId ===
  transfer.targetPeerId`). Stays in hook (guest-side owner gate + host-
  side `requestedFileIds` amplification gate). Engine is called only
  after the hook has authorised the operation.
- **M11** — resume cursor monotonic. **Engine enforces by construction**
  (`Math.max(prev, chunkIndex + 1)`). One location, one invariant.
- **M12** — host `requestedFileIds` amplification-DoS gate. Stays in
  hook; engine does not know about it. Host calls `sendFile` only
  after asserting the fileId is in `session.requestedFileIds`.
- **M13** — chat-image abort message. Out of P1.D scope; preserved in
  the existing hook paths. Engine will pick it up in P1.D.2.
- **M15** — per-peer chunkQueue await. Already on Session
  (`session.chunkQueue`); engine respects the existing serialisation.
  Engine never awaits `hookLevelQueue` that doesn't exist anymore.
- **Per-chunk IV** (AES-GCM). Adapter calls existing
  `encryptChunk(key, data)` which generates a fresh 12-byte random IV
  per call. **No IV reuse possible** — same property as today.
- **timingSafeEqual on password** — out of transfer scope entirely;
  unchanged.

---

## Gotchas

- **Adapter packetIndex MUST round-trip.** Test both sides of the wire
  with the same fileId and assert index matches. A mismatch here
  silently corrupts which file the receiver writes bytes into.
- **Collab packetIndex is per-session, not global.** Two guests with
  the same fileId may allocate different indices on their own sessions
  to the host. The receiving hook seeds its adapter's map via
  `seedFromInbound(fileId, packetIndex)` after decoding an inbound
  `collab-file-start`; do NOT rely on deterministic allocation order.
  Test explicitly.
- **Sink writer backpressure.** `writer.write()` awaits if the sink
  applies backpressure. Engine does not add its own backpressure on
  top — that's the sink's job (StreamSaver's service worker handles it
  for disk flush). Don't introduce a second queue.
- **AbortSignal vs handle.aborted semantics.** Both are abort sources;
  both set the handle to aborted and break the loop. But:
  `handle.aborted` is set by `session.cancelTransfer` or peer-originated
  cancel-file message handling in the hook; `signal.aborted` is set by
  React unmount / user-driven abort. Engine treats them identically —
  both → `'cancelled'` result. If a differentiation ever matters, add
  `opts.onAbort(source: 'signal' | 'handle')` later.
- **Decrypt failure handling.** Engine drops the chunk silently (does
  not advance cursor, does not write). Hook decides whether N failures
  in a row mean the session is compromised and should close. This is
  intentional — don't add a "max decrypt failures" counter to the
  engine; it doesn't have the context to pick the right N.
- **Writer.abort propagation.** `WritableStream.abort` is async; engine
  awaits it. If the sink ignores abort and hangs, engine's `abort()`
  hangs. Hook should race `receiver.abort` against a timeout if the
  sink is suspect; engine does not add a default timeout.
- **Host-relay is not in the engine.** Do not try to force it in.
  Relay has no encrypt/decrypt step (host is blind to the mesh key);
  engine's adapter-owns-crypto model doesn't fit. A separate
  `relayFile(hostSession, upstreamSession, downstreamSession)`
  function could live in the engine folder as a sibling later, but
  that's out of P1.D scope.

---

## Open questions (answered 2026-04-17)

1. **Scope: include chat-image?** No. P1.D is file-only.
   Chat-image is P1.D.2. Sentinel `0xFFFF` stays reserved.
2. **Layout: flat or subdirectory?** Subdirectory
   `src/net/transferEngine/` with barrel. Four lanes will ship
   eventually; subdirectory contains blast radius.
3. **API shape: function, class, or factory?** Hybrid:
   `sendFile()` pure function; `createFileReceiver()` factory
   returning plain object. No classes (matches `createSession`
   convention, no `this` binding hazards).
4. **Progress/events: callbacks, bus, or iterable?** Hybrid:
   lifecycle via Session bus (already has `transfer-begin`/`end`),
   per-chunk progress via direct `opts.onProgress` callback.
5. **Resume-from-chunk: engine or hook?** Engine.
   `opts.startChunk` on send, `receiver.getResumeCursor(fileId)`
   on recv.
6. **Wire protocol: agnostic + caller adapter, role-aware, or
   injected adapter?** Injected adapter. `portalWire`, `collabWire`
   as top-level exports. Engine stays dialect-agnostic.
7. **Crypto: engine, adapter, or hook?** Adapter. Separation of
   concerns (engine = transport; adapter = wire + cipher).
   Future-proofs for key rotation, alt cipher suites, no-crypto
   test doubles.
8. **Abort sources: which and how propagated?** Three:
   `handle.aborted` (session-driven), `isTerminal(session.state)`
   (lifecycle-driven), `opts.signal` (caller-driven). Engine checks
   all three at each loop top; all converge on one exit path.
9. **Receiver write sink: who owns?** Hook owns construction;
   engine receives `WritableStream<Uint8Array>` in opts. Keeps
   engine browser-agnostic.

---

## Out of scope for P1.D

- **Chat-image binary stream.** Uses the same packet pipeline with
  sentinel `0xFFFF`. Will be folded into the engine in P1.D.2 as a
  second pair of `sendImage` / `createImageReceiver` entry points
  sharing the packet primitives. Adapter interface already supports
  it via a future `ImageWireAdapter` (build/parse for
  `chat-image-start` / `chat-image-end` / `chat-image-abort`).
- **Host-relay byte-passthrough.** Hook stays in charge; engine is
  not involved. Documented above.
- **Replacing PeerJS or changing transport.** Engine still wraps
  `session.conn` (a PeerJS `DataConnection`). A future transport
  swap changes Session's construction, not engine's logic.
- **Changing the packet header format.** 6 bytes, `uint16 fileIndex
  + uint32 chunkIndex` stays. Engine does not re-negotiate.
- **Resume across sessions (beyond chunk index).** Engine exposes
  the cursor; hook decides what to do with it on reconnect. Engine
  is stateless across sessions.

---

## Acceptance

P1.D is done when:

- `src/net/transferEngine/` exists with `sendFile`,
  `createFileReceiver`, `portalWire`, `collabWire`.
- ~38 new tests pass; 309 existing tests still pass (target 347+).
- `tsc --noEmit` clean.
- All four hooks migrated: useSender, useReceiver, useCollabHost
  (owner path only), useCollabGuest.
- Dead code deleted: `sendSingleFile`, `streamsRef`,
  `inProgressDownloadsRef`, `inProgressFilesRef`,
  `currentDownloadFileId`. grep-clean.
- Hook line counts drop:
  - useSender < 1000 (from 1126, -126)
  - useReceiver < 950 (from 1056, -106)
  - useCollabHost < 1500 (from 1635, -135)
  - useCollabGuest < 1800 (from 1974, -174)
  - Total: ~540 lines moved into engine (~400 new engine lines net,
    ~140 pure deduplication win).
- Byte-level round-trip verified in real staging:
  - Portal 1:1 send + receive, 100 MB file, SHA-256 match.
  - Portal 1:N with 2 receivers, same.
  - Collab host-owned file → guest download, same.
  - Collab guest-owned file → guest download (mesh direct), same.
  - Collab guest-owned file → guest download (host relay).
- No behaviour change visible to users. This is a pure refactor.
