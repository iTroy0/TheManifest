// Centralized accessors for PeerJS internals + misc unsafe casts that
// accumulate across the codebase. Each helper encapsulates one
// `as unknown as` cast so the unsafety is documented in a single
// place — hooks and net code call the typed accessors instead of
// spreading 80+ inline casts across the app.
//
// PeerJS does not expose `RTCPeerConnection` / `RTCDataChannel` on
// its typed surface; we reach into `mediaConnection.peerConnection`
// and `dataConnection._dc` (or `dataChannel`) as documented by its
// source. Keep these helpers as the only access point.

import type { DataConnection, MediaConnection, Peer } from 'peerjs'

export function getPeerConnection(mc: MediaConnection): RTCPeerConnection | undefined {
  return (mc as unknown as { peerConnection?: RTCPeerConnection }).peerConnection
}

export function getDataChannel(conn: DataConnection): RTCDataChannel | undefined {
  const d = conn as unknown as { _dc?: RTCDataChannel; dataChannel?: RTCDataChannel }
  return d._dc ?? d.dataChannel
}

// Adapter for `waitForBufferDrain` which consumes a structural
// `DataChannelLike` ({ _dc?, dataChannel? }). The cast is the same
// as `getDataChannel`'s, but returning the container keeps the
// buffer-drain API structurally typed on its consumer side.
export function asDataChannelLike(
  conn: DataConnection,
): { _dc?: RTCDataChannel; dataChannel?: RTCDataChannel } {
  return conn as unknown as { _dc?: RTCDataChannel; dataChannel?: RTCDataChannel }
}

type OffFn = (event: string, handler: (...args: unknown[]) => void) => void

// Peer's underlying emitter exposes both `off` (modern alias) and
// `removeListener`. The PeerJS types don't surface either — we grab
// whichever is present so a version bump that drops one alias
// doesn't silently leak our error handler.
export function getEmitterOff(peer: Peer): OffFn | undefined {
  const e = peer as unknown as { off?: OffFn; removeListener?: OffFn }
  return e.off ?? e.removeListener
}

// TS 5.7+ narrowed `Uint8Array<ArrayBuffer>` vs `Uint8Array<ArrayBufferLike>`
// so `new Blob([uint8])` no longer accepts a raw Uint8Array without a
// `BlobPart` cast. Same for `ArrayBuffer[]`. Encapsulate here.
export function asBlobPart(u8: Uint8Array): BlobPart {
  return u8 as unknown as BlobPart
}

export function asBlobParts(chunks: readonly (Uint8Array | ArrayBuffer)[]): BlobPart[] {
  return chunks as unknown as BlobPart[]
}
