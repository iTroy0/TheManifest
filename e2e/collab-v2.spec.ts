// Collab V2 E2E — guest→host file share, kick, rename broadcast,
// room close broadcast. Covers the paths that V1 left untested so
// the upcoming transferEngine split + any future hook refactor has
// a safety net.

import { test, expect } from '@playwright/test'
import {
  getCollabRoomUrl,
  openSecondPage,
  sendChatMessage,
  expectChatMessage,
} from './helpers'

async function openCollabHost(browser: import('@playwright/test').Browser) {
  const ctx = await browser.newContext()
  const host = await ctx.newPage()
  await host.goto('/collab')
  return { ctx, host }
}

test.describe('Collab kick', () => {
  test('host kicks guest; guest sees removed banner', async ({ browser }) => {
    const { ctx, host } = await openCollabHost(browser)
    const roomUrl = await getCollabRoomUrl(host)
    const guest = await openSecondPage(ctx, roomUrl)

    // Wait for the participant row to appear on the host side. The kick
    // button lives inside a row keyed by peerId; the data-testid carries
    // the peerId so we can target the right one even with multiple guests.
    // Removal is a two-tap: first tap (`-init` suffix) shows a 4s "Confirm?"
    // pill, second tap (without the suffix) actually kicks.
    const initButton = host.locator('[data-testid^="collab-kick-"][data-testid$="-init"]').first()
    await expect(initButton).toBeVisible({ timeout: 25_000 })
    await initButton.click()
    const confirmButton = host.locator('[data-testid^="collab-kick-"]:not([data-testid$="-init"])').first()
    await expect(confirmButton).toBeVisible()
    await confirmButton.click()

    // Guest should see a terminal banner. The app dispatches status='kicked'
    // + appends "You were removed from the room" to chat, but the
    // subsequent conn.on('close') fires shortly after and dispatches
    // status='closed', which the reducer accepts and whose full-page
    // banner ("Room Closed / The host has closed this room") is what
    // actually paints. Match either phrasing — both are valid evidence
    // that the kick took effect.
    await expect(guest.locator('body')).toContainText(
      /removed from the room|kicked|Room Closed|host has closed/i,
      { timeout: 15_000 },
    )

    await ctx.close()
  })
})

test.describe('Collab close room', () => {
  test('host closes; guest sees room-closed banner', async ({ browser }) => {
    const { ctx, host } = await openCollabHost(browser)
    const roomUrl = await getCollabRoomUrl(host)
    const guest = await openSecondPage(ctx, roomUrl)

    // Wait for guest to finish handshake so closeRoom actually reaches it.
    // The composer (contenteditable / textarea) only renders post-admission,
    // so it's a more reliable signal than substring-matching the body — the
    // "Joining room..." pre-handshake screen falsely matches /Room/i.
    await expect(guest.locator('[contenteditable="true"], textarea').first()).toBeVisible({ timeout: 25_000 })

    await host.getByTestId('collab-close-room').click()

    await expect(guest.locator('body')).toContainText(/room was closed|room closed|closed by host/i, { timeout: 15_000 })

    await ctx.close()
  })
})

test.describe('Collab nickname rename', () => {
  test('host renames; guest sees system-msg in chat', async ({ browser }) => {
    const { ctx, host } = await openCollabHost(browser)
    const roomUrl = await getCollabRoomUrl(host)
    const guest = await openSecondPage(ctx, roomUrl)

    // Ensure the guest chat has materialised before we rename.
    await expect(guest.locator('[contenteditable="true"], textarea').first()).toBeVisible({ timeout: 25_000 })

    await host.getByTestId('collab-edit-name').click()

    // The edit button swaps the name span for an inline input. Text input
    // shows up right where the name was. Use a broad locator.
    const newName = 'host-renamed-' + Date.now()
    const nameInput = host.locator('input[type="text"]').first()
    await expect(nameInput).toBeVisible({ timeout: 5_000 })
    await nameInput.fill(newName)
    await nameInput.press('Enter')

    // Guest chat should append "<oldName> renamed to <newName>". Match
    // loosely — the oldName is generated and unknown to us here.
    await expect(guest.locator('body')).toContainText(new RegExp(`renamed to ${newName}`, 'i'), { timeout: 15_000 })

    // And a chat message from the newly-named host should carry through.
    const msg = `after-rename-${Date.now()}`
    await sendChatMessage(host, msg)
    await expectChatMessage(guest, msg)

    await ctx.close()
  })
})

test.describe('Collab guest -> host file share', () => {
  test('guest shares a file; host sees it in the shared list', async ({ browser }) => {
    const { ctx, host } = await openCollabHost(browser)
    const roomUrl = await getCollabRoomUrl(host)
    const guest = await openSecondPage(ctx, roomUrl)

    // Wait for guest admission — the participant chat must materialise
    // before the file share input is wired up. Can't assert visibility
    // on the input itself (className="hidden" on CollabGuestView's file
    // picker), but setInputFiles works on hidden inputs.
    await expect(guest.locator('[contenteditable="true"], textarea').first()).toBeVisible({ timeout: 25_000 })
    const shareInput = guest.locator('input[type="file"][aria-label*="Share"]').first()
    await expect(shareInput).toBeAttached({ timeout: 25_000 })

    // Small fixture (unique name so host sees the exact filename).
    const fileName = `guest-shared-${Date.now()}.txt`
    await shareInput.setInputFiles({
      name: fileName,
      mimeType: 'text/plain',
      buffer: Buffer.from('collab-guest-shared-content'),
    })

    // Host's shared file list should eventually render a row matching the
    // filename. The list is rendered by CollabFileList — match by text.
    await expect(host.locator('body')).toContainText(fileName, { timeout: 20_000 })

    await ctx.close()
  })
})
