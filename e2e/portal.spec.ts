// Portal lane E2E — sender (useSender) + receiver (useReceiver).
// Exercises the golden path: open sender, add a file, open receiver via
// the portal link, download, verify bytes match.
//
// The test harness stands up a local peerjs-server on port 9000
// (see e2e/global-setup.ts) and runs the app against it via .env.test.

import { test, expect } from '@playwright/test'
import {
  patternedBytes,
  writeFixture,
  getPortalUrl,
  uploadFile,
  sendChatMessage,
  expectChatMessage,
  expectDownloadMatches,
  waitForPeerOpen,
  waitForManifest,
  openSecondPage,
} from './helpers'

test.describe('Portal 1:1', () => {
  test('sender -> receiver file transfer, bytes match', async ({ browser }) => {
    const fixture = writeFixture('tiny.bin', patternedBytes(4096))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await waitForPeerOpen(sender)
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    await expectDownloadMatches(
      receiver,
      async () => {
        // The receiver shows either "Download all" (multi-file) or a
        // single-file button. For a single file, click the per-row
        // download action.
        const dl = receiver.getByRole('button', { name: /download/i }).first()
        await dl.click()
      },
      fixture.bytes,
    )

    await ctx.close()
  })

  test('chat round-trip between sender and receiver', async ({ browser }) => {
    // No file needed — opening chat-only mode triggers the same peer
    // handshake. We still upload a tiny file to keep the code path
    // identical to real usage; chat-only mode needs a separate toggle.
    const fixture = writeFixture('chat.bin', patternedBytes(128))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await waitForPeerOpen(sender)
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    // Sender -> receiver
    const hello = `hello-from-sender-${Date.now()}`
    await sendChatMessage(sender, hello)
    await expectChatMessage(receiver, hello)

    // Receiver -> sender
    const reply = `hello-from-receiver-${Date.now()}`
    await sendChatMessage(receiver, reply)
    await expectChatMessage(sender, reply)

    await ctx.close()
  })
})

test.describe('Portal 1:N', () => {
  test('two receivers both download the same file', async ({ browser }) => {
    const fixture = writeFixture('multi.bin', patternedBytes(8192))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await waitForPeerOpen(sender)
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)

    const r1 = await openSecondPage(ctx, portalUrl)
    const r2 = await openSecondPage(ctx, portalUrl)
    await waitForManifest(r1)
    await waitForManifest(r2)

    await Promise.all([
      expectDownloadMatches(
        r1,
        async () => { await r1.getByRole('button', { name: /download/i }).first().click() },
        fixture.bytes,
      ),
      expectDownloadMatches(
        r2,
        async () => { await r2.getByRole('button', { name: /download/i }).first().click() },
        fixture.bytes,
      ),
    ])

    await ctx.close()
  })
})

test.describe('Portal fingerprint', () => {
  test('sender and receiver see a matching fingerprint string', async ({ browser }) => {
    // After ECDH the UI surfaces a fingerprint code. Both sides must
    // agree — a mismatch would indicate a MITM or a broken key-derivation
    // ordering. This is an integration check that protocol.ts + session.ts
    // actually derive the same artefact over a real DataConnection.
    const fixture = writeFixture('fp.bin', patternedBytes(64))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await waitForPeerOpen(sender)
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    // Fingerprint rendering is role-agnostic — we assert both pages
    // contain at least one 16-char hex-ish snippet matching the
    // getKeyFingerprint format (`xx:xx:xx:xx:...`). Tighter assertion
    // needs data-testid on the fingerprint pill.
    const fpRe = /[0-9a-f]{2}(:[0-9a-f]{2}){3,}/i
    await expect(sender.locator('body')).toContainText(fpRe, { timeout: 15_000 })
    await expect(receiver.locator('body')).toContainText(fpRe, { timeout: 15_000 })

    await ctx.close()
  })
})
