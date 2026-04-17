// Page helpers shared across portal.spec.ts and collab.spec.ts.
// Keep these as Page-scoped actions. No shared mutable state across tests.

import { expect, type Page, type BrowserContext, type Locator } from '@playwright/test'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ── Fixtures ────────────────────────────────────────────────────────────

export interface Fixture {
  path: string
  name: string
  bytes: Uint8Array
}

// Write a tiny deterministic file to a temp dir and return its metadata.
// Per-test fresh file so parallel / retried runs never clash.
export function writeFixture(name: string, bytes: Uint8Array): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'manifest-e2e-'))
  const path = join(dir, name)
  writeFileSync(path, bytes)
  return { path, name, bytes }
}

// Deterministic byte buffer seeded by `n`. Not random — we want
// assertions to be stable across runs.
export function patternedBytes(n: number): Uint8Array {
  const out = new Uint8Array(n)
  for (let i = 0; i < n; i++) out[i] = (i * 37 + 13) & 0xff
  return out
}

// ── Portal helpers ──────────────────────────────────────────────────────

// Grab the /portal/<peerId> URL rendered in PortalLink's <code> element.
// We wait up to the expect timeout because the peer-open event is async.
export async function getPortalUrl(page: Page): Promise<string> {
  const code = page.locator('code', { hasText: '/portal/' }).first()
  await expect(code).toBeVisible()
  const text = await code.textContent()
  if (!text) throw new Error('portal link not found')
  return text.trim()
}

// Browse + select a file via the host's hidden file input. The visible
// "Add files" button just proxies click() to the input; we skip that
// and set files directly for determinism.
export async function uploadFile(page: Page, filePath: string): Promise<void> {
  const input = page.locator('input[type="file"][aria-label="Select files to share"]')
  await input.setInputFiles(filePath)
}

// ── Chat helpers ────────────────────────────────────────────────────────

// The chat input is an editable div / textarea inside ChatPanel. We
// locate by placeholder; adjust if ChatPanel's placeholder text changes.
export async function sendChatMessage(page: Page, text: string): Promise<void> {
  // ChatPanel renders a contenteditable; fall back to textarea if the
  // component is later simplified. Try both.
  const editable = page.locator('[contenteditable="true"]').first()
  const textarea = page.locator('textarea').first()
  const input = (await editable.count()) > 0 ? editable : textarea
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

// Assert a chat message with the given text appears for the current page.
// Throws via expect() on timeout.
export async function expectChatMessage(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
}

// ── Collab helpers ──────────────────────────────────────────────────────

// Pull the /collab/<roomId> share URL from the host page. The link is
// displayed near the top of the room header once peer-open fires.
export async function getCollabRoomUrl(page: Page): Promise<string> {
  const code = page.locator('code', { hasText: '/collab/' }).first()
  await expect(code).toBeVisible()
  const text = await code.textContent()
  if (!text) throw new Error('collab room link not found')
  return text.trim()
}

// ── ContextPair — open two browser pages from the same context ─────────

// Most tests need a sender + a receiver. Contexts are isolated so
// service workers, IndexedDB, and localStorage don't bleed across.
export async function openSecondPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url)
  return page
}

// ── Key-exchange + handshake waiters ────────────────────────────────────

// Wait for the peer-ready indicator. Portal sender shows the portal URL
// as soon as peerRef.current opens, so any follow-up action is safe.
export async function waitForPeerOpen(page: Page): Promise<void> {
  await expect(page.locator('code', { hasText: /\/portal\/|\/collab\// }).first()).toBeVisible()
}

// Receiver side — wait for the manifest to be delivered. The UI
// transitions from "connecting" / "password-required" to showing the
// file list once `manifest-enc` decrypts successfully.
export async function waitForManifest(page: Page): Promise<void> {
  // The file list row count goes from 0 to >=1 when manifest arrives.
  // Use a liberal timeout — 1st connect + ECDH + manifest ~2-3 s.
  await expect(page.locator('text=Download').first()).toBeVisible({ timeout: 20_000 })
}

// ── Download assertion ─────────────────────────────────────────────────

// Waits for a download event, pulls its bytes, and compares to expected.
// The app writes downloads either via StreamSaver (service worker) or a
// plain <a download> click; both fire Playwright's 'download' event.
export async function expectDownloadMatches(
  page: Page,
  clickAction: () => Promise<void>,
  expected: Uint8Array,
): Promise<void> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 30_000 }),
    clickAction(),
  ])
  const path = await download.path()
  if (!path) throw new Error('download path unavailable')
  const { readFileSync } = await import('fs')
  const got = readFileSync(path)
  // Compare as arrays so mismatches produce readable diffs.
  if (got.byteLength !== expected.byteLength) {
    throw new Error(`length mismatch: got ${got.byteLength}, expected ${expected.byteLength}`)
  }
  for (let i = 0; i < got.byteLength; i++) {
    if (got[i] !== expected[i]) {
      throw new Error(`byte ${i}: got 0x${got[i].toString(16)}, expected 0x${expected[i].toString(16)}`)
    }
  }
}

// ── Utility: locate by any of several fallback strategies ───────────────

// Accept a list of candidate locators and return the first that resolves.
// Used where the UI's testable surface has a couple of plausible names.
export function firstVisible(locators: Locator[]): Locator {
  // Playwright's `or()` composes alternatives; fallback chain keeps tests
  // stable across minor UI refactors.
  return locators.reduce((acc, next) => acc.or(next))
}
