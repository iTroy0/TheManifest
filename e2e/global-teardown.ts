// Shut down the local peerjs-server that global-setup.ts started. We
// hold the underlying http.Server so .close() works — the return value
// of PeerServer() is an Express app without a close handle.

import type { Server } from 'http'

export default async function globalTeardown(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const server = (globalThis as any).__PEER_HTTP__ as Server | undefined
  if (!server) return
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
  // eslint-disable-next-line no-console
  console.log('[playwright] peerjs-server stopped')
}
