// Page helpers shared across portal.spec.ts and collab.spec.ts.
// Keep these as Page-scoped actions. No shared mutable state across tests.

import { expect, type Page, type BrowserContext } from '@playwright/test'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
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

// ── URL locators ────────────────────────────────────────────────────────

// Wait for the /portal/<peerId> link to appear anywhere on the page.
// On Home, this element only renders after:
//   1. peerRef.current opens (peerId set), AND
//   2. hasFiles || chatMode || sessionStarted is true.
// So callers must have already uploaded a file (or enabled chat mode).
// The regex matches the full URL format rendered by PortalLink — in a
// <code> block today, but we use getByText so a future refactor that
// moves the URL into a <div> / <pre> / <span> doesn't break us.
export async function getPortalUrl(page: Page): Promise<string> {
  const portalRegex = /https?:\/\/[^\s]+\/portal\/[a-f0-9-]{8,}/i
  await expect(page.getByText(portalRegex).first()).toBeVisible({ timeout: 15_000 })
  const text = await page.getByText(portalRegex).first().textContent()
  if (!text) throw new Error('portal link text empty')
  const match = text.match(portalRegex)
  if (!match) throw new Error(`portal link regex missed on text: ${text}`)
  return match[0]
}

// Collab host view renders the share URL inside a <div> (not <code>),
// formatted as `{origin}/collab/{roomId}`. Match the URL with the
// same broad getByText approach.
export async function getCollabRoomUrl(page: Page): Promise<string> {
  const roomRegex = /https?:\/\/[^\s]+\/collab\/[a-f0-9-]{8,}/i
  await expect(page.getByText(roomRegex).first()).toBeVisible({ timeout: 20_000 })
  const text = await page.getByText(roomRegex).first().textContent()
  if (!text) throw new Error('collab room link text empty')
  const match = text.match(roomRegex)
  if (!match) throw new Error(`collab room link regex missed on text: ${text}`)
  return match[0]
}

// ── File upload ─────────────────────────────────────────────────────────

// Browse + select a file via the host's hidden file input. The visible
// "Add files" button just proxies click() to the input; we skip that
// and set files directly for determinism.
export async function uploadFile(page: Page, filePath: string): Promise<void> {
  // Home shows two different file inputs depending on state:
  //   - DropZone's <input type="file" multiple> on the landing page
  //     (no aria-label, className="hidden").
  //   - Home's own <input aria-label="Select files to share"> once
  //     isActive (hasFiles || chatMode || sessionStarted) is true.
  // On initial load only DropZone's input exists. Match by attachment
  // rather than visibility — both are display:none — and take the first.
  const input = page.locator('input[type="file"]').first()
  await input.setInputFiles(filePath)
}

// ── Chat helpers ────────────────────────────────────────────────────────

// ChatPanel renders a contenteditable rich-text area + send button.
// Fall back to textarea/input if the component is later simplified.
async function locateChatInput(page: Page) {
  const candidates = [
    page.locator('[contenteditable="true"]'),
    page.getByPlaceholder(/message|type|chat/i),
    page.locator('textarea'),
  ]
  for (const loc of candidates) {
    if ((await loc.count()) > 0) return loc.first()
  }
  throw new Error('chat input not located (tried contenteditable, placeholder, textarea)')
}

export async function sendChatMessage(page: Page, text: string): Promise<void> {
  const input = await locateChatInput(page)
  // Avoid .click() — surrounding collapsible cards sometimes intercept
  // pointer events on the first few frames after the ChatPanel mounts.
  // Focus the input directly and type.
  await input.focus()
  await input.pressSequentially(text, { delay: 10 })
  await input.press('Enter')
}

// Assert a chat message with the given text appears for the current page.
export async function expectChatMessage(page: Page, text: string): Promise<void> {
  await expect(page.getByText(text, { exact: false }).first()).toBeVisible({ timeout: 15_000 })
}

// ── ContextPair — open two browser pages from the same context ─────────

export async function openSecondPage(context: BrowserContext, url: string): Promise<Page> {
  const page = await context.newPage()
  await page.goto(url)
  return page
}

// ── Manifest / receiver readiness ──────────────────────────────────────

// Receiver side — wait for the file list UI to appear, which fires once
// `manifest-enc` decrypts. We look for a "Download" button (the single-
// file or "Download all" CTA) which only renders after manifest arrival.
export async function waitForManifest(page: Page): Promise<void> {
  await expect(
    page.getByRole('button', { name: /download/i }).first(),
  ).toBeVisible({ timeout: 25_000 })
}

// ── Download assertion ─────────────────────────────────────────────────

// Waits for a download event, pulls its bytes, and compares to expected.
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
  const got = readFileSync(path)
  if (got.byteLength !== expected.byteLength) {
    throw new Error(`length mismatch: got ${got.byteLength}, expected ${expected.byteLength}`)
  }
  for (let i = 0; i < got.byteLength; i++) {
    if (got[i] !== expected[i]) {
      throw new Error(`byte ${i}: got 0x${got[i].toString(16)}, expected 0x${expected[i].toString(16)}`)
    }
  }
}
