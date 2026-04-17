// Collab lane E2E — host (useCollabHost) + guest (useCollabGuest).

import { test, expect } from '@playwright/test'
import {
  getCollabRoomUrl,
  sendChatMessage,
  expectChatMessage,
  openSecondPage,
} from './helpers'

async function openCollabHost(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext()
  const host = await ctx.newPage()
  await host.goto('/collab')
  return { ctx, host }
}

test.describe('Collab host + guest', () => {
  test('guest joins, room URL + participants visible on both sides', async ({ browser }) => {
    const { ctx, host } = await openCollabHost(browser)
    const roomUrl = await getCollabRoomUrl(host)

    const guest = await openSecondPage(ctx, roomUrl)

    // Host sees guest join. Either via the participant list (2 entries)
    // or the chat "joined" system message.
    await expect(host.locator('body')).toContainText(/joined/i, { timeout: 25_000 })
    // Guest sees the room — at minimum the connection chip or the chat
    // input has rendered (password-gate isn't in play for these tests).
    await expect(guest.locator('body')).toContainText(/Room|Connected|connected|online/i, { timeout: 25_000 })

    await ctx.close()
  })

  test('chat round-trip host <-> guest', async ({ browser }) => {
    const { ctx, host } = await openCollabHost(browser)
    const roomUrl = await getCollabRoomUrl(host)
    const guest = await openSecondPage(ctx, roomUrl)

    // Wait for the guest's chat surface to render. ChatPanel appears once
    // the host's announceJoin fires on the guest side.
    await expect(host.locator('[contenteditable="true"], textarea').first()).toBeVisible({ timeout: 20_000 })
    await expect(guest.locator('[contenteditable="true"], textarea').first()).toBeVisible({ timeout: 20_000 })

    const hostMsg = `host-says-${Date.now()}`
    await sendChatMessage(host, hostMsg)
    await expectChatMessage(guest, hostMsg)

    const guestMsg = `guest-says-${Date.now()}`
    await sendChatMessage(guest, guestMsg)
    await expectChatMessage(host, guestMsg)

    await ctx.close()
  })
})

test.describe('Collab room lifecycle', () => {
  test('navigating to a non-existent room surfaces an error state', async ({ browser }) => {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    // An unlikely roomId — PeerJS emits 'peer-unavailable', useCollabGuest
    // flips to error status. The UI copy is either "Room not found" or
    // an error banner.
    await page.goto('/collab/does-not-exist-' + Date.now())
    await expect(page.locator('body')).toContainText(
      /Connection Failed|Could not connect|no longer exist|room not found|error|closed|unavailable/i,
      { timeout: 25_000 },
    )
    await ctx.close()
  })
})

test.describe('Collab call panel smoke', () => {
  test('call panel lazy chunk loads without a React error', async ({ browser }) => {
    // Just a structural check: CallPanelLazy -> Suspense -> CallPanelRuntime
    // must resolve on a collab-host page without an ErrorBoundary fallback.
    // A rendered <svg> anywhere on the page is enough evidence that the
    // lazy chunk mounted (CallPanel uses lucide icons heavily).
    const { ctx, host } = await openCollabHost(browser)
    // Room URL rendering already proves the page shell mounted; wait a
    // beat for the lazy chunk to attach, then assert at least one SVG.
    await getCollabRoomUrl(host)
    await expect(host.locator('svg').first()).toBeVisible({ timeout: 20_000 })
    // Look for the absence of the error-boundary fallback text (matches
    // ComponentErrorBoundary's default copy).
    const errorText = await host.locator('body').textContent()
    if (errorText && /something went wrong/i.test(errorText)) {
      throw new Error('ErrorBoundary fallback rendered on host page')
    }
    await ctx.close()
  })
})
