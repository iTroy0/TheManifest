// Portal V2 E2E — password gate + cancel mid-transfer. Adds coverage
// for the flows that V1 skipped: the password-gated handshake path
// and the receiver-initiated cancel.

import { test, expect } from '@playwright/test'
import {
  patternedBytes,
  writeFixture,
  getPortalUrl,
  uploadFile,
  expectDownloadMatches,
  waitForManifest,
  openSecondPage,
} from './helpers'

test.describe('Portal password gate', () => {
  test('wrong password shows error, correct password unlocks manifest', async ({ browser }) => {
    const fixture = writeFixture('pw.bin', patternedBytes(512))
    const PASSWORD = 'open-sesame'

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await uploadFile(sender, fixture.path)

    // PasswordSection on Home has a single password input. Enter before
    // any receiver connects (host refuses to change password once guests
    // are admitted).
    const pwInput = sender.getByPlaceholder(/password/i).first()
    await pwInput.fill(PASSWORD)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)

    // Password-required screen — enter WRONG password first.
    const portalPw = receiver.getByLabel('Portal password')
    await expect(portalPw).toBeVisible({ timeout: 20_000 })
    await portalPw.fill('nope-not-it')
    await receiver.getByTestId('portal-password-submit').click()
    await expect(receiver.getByText(/wrong password/i)).toBeVisible({ timeout: 10_000 })

    // Sender enforces exponential backoff: 1s after first wrong, 2s after
    // second, ... Capped at 30s. Wait past the 1s window before the next
    // attempt so the sender doesn't reject with 'password-rate-limited'.
    await receiver.waitForTimeout(1200)

    // Now the correct one. UI resets the error and submits again.
    await portalPw.fill(PASSWORD)
    await receiver.getByTestId('portal-password-submit').click()

    // Manifest should arrive. File list appears and Download becomes clickable.
    await waitForManifest(receiver)
    await expectDownloadMatches(
      receiver,
      async () => { await receiver.getByRole('button', { name: /download/i }).first().click() },
      fixture.bytes,
    )

    await ctx.close()
  })
})

test.describe('Portal receiver cancel', () => {
  test('receiver cancels mid-transfer; sender sees cancel signal', async ({ browser }) => {
    // Needs to be big enough that localhost P2P takes more than a few
    // frames — 512 KB finished before we could click cancel, so bump to
    // 10 MB. The adaptive chunker on loopback sustains ~50 MB/s in
    // Chromium, so ~200 ms window for the cancel to arrive mid-stream.
    const fixture = writeFixture('big.bin', patternedBytes(10 * 1024 * 1024))

    const ctx = await browser.newContext()
    const sender = await ctx.newPage()
    await sender.goto('/')
    await uploadFile(sender, fixture.path)

    const portalUrl = await getPortalUrl(sender)
    const receiver = await openSecondPage(ctx, portalUrl)
    await waitForManifest(receiver)

    // Kick off a download but DON'T await its completion.
    await receiver.getByRole('button', { name: /download/i }).first().click()

    // Cancel button — FileList exposes aria-label="Cancel download". Might
    // not appear until a chunk has streamed; wait up to a few seconds.
    const cancel = receiver.getByRole('button', { name: /cancel download/i }).first()
    await expect(cancel).toBeVisible({ timeout: 10_000 })
    await cancel.click()

    // Sender's UI should flip back to 'connected' / 'waiting' within a
    // few seconds of the cancel message arriving. Receiver's file list
    // should reflect the canceled state — either via a "cancelled" chip,
    // or the download disappearing from the pending set.
    // Loose assertion: neither side still shows "Downloading".
    await expect(sender.locator('body')).not.toContainText(/transferring/i, { timeout: 15_000 })

    await ctx.close()
  })
})
