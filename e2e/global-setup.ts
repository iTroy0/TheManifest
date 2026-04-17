// Boots a local peerjs-server on port 9000 for the whole test run.
// The app's .env.test points at this instance.
//
// Implementation note: the `peer` package ships PeerServer(opts) that
// internally calls .listen() on an http.Server, but the return value is
// an Express app without a .close() handle. We use ExpressPeerServer
// attached to an http.Server we control so global-teardown.ts can shut
// it down cleanly.

import type { FullConfig } from '@playwright/test'
import { createServer, type Server } from 'http'
import express from 'express'
import { ExpressPeerServer } from 'peer'

const SIGNAL_PORT = 9000

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const app = express()
  const httpServer: Server = createServer(app)
  const peerServer = ExpressPeerServer(httpServer, {
    path: '/',
    allow_discovery: false,
  })
  app.use('/', peerServer)

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`peerjs-server failed to bind :${SIGNAL_PORT}`)),
      10_000,
    )
    httpServer.once('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    httpServer.listen(SIGNAL_PORT, () => {
      clearTimeout(timeout)
      resolve()
    })
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).__PEER_HTTP__ = httpServer
  // eslint-disable-next-line no-console
  console.log(`[playwright] peerjs-server listening on :${SIGNAL_PORT}`)
}
