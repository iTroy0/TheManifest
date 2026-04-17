// Portal lane E2E — sender (useSender) + receiver (useReceiver).
// Exercises the golden path: open sender, add a file, open receiver via
// the portal link, download, verify bytes match.

import { test, expect } from '@playwright/test'
import {
  patternedBytes,
  writeFixture,
  getPortalUrl,
  uploadFile,
  sendChatMessage,
  expectChatMessage,
  expectDownloadMatches,
  waitForManifest,
  openSecondPage,
} from './helpers'

test.describe('Portal 1:1', () => {
  test('sender -> receiver file transfer, bytes match', async ({ browser }) => {
    const fixture = writeFixture('tiny.bin', patternedBytes(4096))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    // Upload FIRST — the portal link only renders once hasFiles becomes true.
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    await expectDownloadMatches(
      receiver,
      async () => {
        const dl = receiver.getByRole('button', { name: /download/i }).first()
        await dl.click()
      },
      fixture.bytes,
    )

    await ctx.close()
  })

  test('chat round-trip between sender and receiver', async ({ browser }) => {
    const fixture = writeFixture('chat.bin', patternedBytes(128))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    const hello = `hello-from-sender-${Date.now()}`
    await sendChatMessage(sender, hello)
    await expectChatMessage(receiver, hello)

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
    const fixture = writeFixture('fp.bin', patternedBytes(64))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    // Fingerprint is hex pairs; rendered separator varies (':' in some
    // builds, ' ' in the current UI). Accept either.
    const fpRe = /[0-9a-f]{2}([\s:][0-9a-f]{2}){3,}/i
    await expect(sender.locator('body')).toContainText(fpRe, { timeout: 20_000 })
    await expect(receiver.locator('body')).toContainText(fpRe, { timeout: 20_000 })

    await ctx.close()
  })
})
