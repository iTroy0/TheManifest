# P3.3 — Playwright E2E harness plan

Goal: boot two (and sometimes three) headless browsers, drive the real
portal + collab + call entry points, and assert the full stack is
intact. Covers the code paths that vitest skips — `ChatPanel.tsx`
(63 KB), `CallPanel.tsx` (31 KB), `CollabFileList.tsx` (32 KB), and
every useSender/useReceiver/useCollabHost/useCollabGuest integration
the unit tests stop short of.

Baseline: branch `dev` as of the P2.2 landing. No E2E framework in the
repo today.

---

## Scope (what "covers everything" means here)

**In scope — golden paths:**

- Portal 1:1 — sender uploads file, receiver downloads, bytes match.
- Portal 1:N — sender + 2 receivers, both "Download all", both finish.
- Portal password gate — wrong password locks after N attempts,
  correct password unlocks.
- Portal chat — text message round-trip between sender and receiver.
- Portal pause / resume / cancel mid-file.
- Portal reconnect — simulate `offline` event, then `online`, verify
  receiver resumes from last chunk cursor.
- Collab host + guest — host shares file, guest downloads (host-relay
  path first, mesh-direct second — tests both C1 chain states).
- Collab guest shares file, host receives, second guest downloads via
  mesh.
- Collab chat — host + guest round-trip.
- Collab nickname rename — verify participant list + system-msg
  appear on both sides.
- Collab kick — host kicks guest, guest sees "kicked" banner.
- Collab password gate — wrong attempts rate-limited, correct unlocks.
- Collab room-close — host closes, guests see "Room closed".
- Call panel renders without throwing (structural smoke — full call
  flow is out of scope, see below).

**Out of scope (for this first pass):**

- Full voice/video call with actual media exchange. Requires
  `--use-fake-device-for-media-stream` and real getUserMedia which
  the Chromium Playwright ships with supports, but assertion surface
  is ugly (check `audioLevel` > 0? flaky). Defer to a later pass with
  a dedicated call.spec.ts.
- TURN relay path. Requires a running coturn in CI. We test the
  direct-P2P path through our local peerjs-server; TURN-only is
  covered indirectly by `enableRelay()` tearing down + reopening the
  peer (the session identity check is covered by unit tests).
- Bundle-size or performance budgets. Separate tool (size-limit) if
  we ever want that.

---

## Transport: local `peerjs-server`

The signaling config in `src/utils/iceServers.ts` today falls back to
the public PeerJS cloud server when `VITE_SIGNAL_HOST` is unset. For
CI + deterministic tests we need a local signaling server — the cloud
is flaky under load and tests would be at the mercy of a third party.

Plan:

1. Add `peer` (the official `peerjs-server` package) as a dev
   dependency.
2. Add `VITE_SIGNAL_PORT` and `VITE_SIGNAL_SECURE` env vars to the
   signaling config so the test env can point at `localhost:9000`
   over plain HTTP. Default values keep prod behaviour (port 443,
   secure: true).
3. `e2e/global-setup.ts` starts `peer-server` on port 9000 before
   the vite dev server boots. `global-teardown.ts` stops it.
4. `.env.test` sets:
   - `VITE_SIGNAL_HOST=localhost`
   - `VITE_SIGNAL_PORT=9000`
   - `VITE_SIGNAL_SECURE=false`
5. Playwright's `webServer` launches `npm run dev -- --mode test`
   which loads `.env.test`.

No production code path changes meaningfully. The env-var additions
are opt-in — prod continues to read only `VITE_SIGNAL_HOST` and
`VITE_SIGNAL_PATH` as before.

---

## Browser matrix

- **Chromium only** in CI for speed.
- Firefox and WebKit not essential for P0 coverage — PeerJS itself is
  the thing we're exercising, not browser-specific WebRTC quirks.
  Can be added later by uncommenting a line in playwright.config.ts.

---

## Test isolation

- Each test gets a fresh `page` (or two). No shared state.
- PeerJS IDs are auto-generated (UUIDv4-ish). Collision probability
  across parallel tests is negligible but the test harness waits for
  `peerOpen` before proceeding, so even a mid-test collision would
  surface as a deterministic timeout instead of cross-test leakage.
- The local peerjs-server is per-worker (Playwright runs tests
  serialized by default; we keep `workers: 1` so one signaling
  server serves all tests in sequence).

---

## Selector strategy

Current UI has zero `data-testid`. Tests use `getByRole`,
`getByText`, `getByPlaceholder`, `getByLabel` where the semantics
are unambiguous. We add `data-testid` attributes only where text is
duplicated (e.g. a "Send" button in ChatPanel vs. in CallPanel) or
where role-based queries would be brittle (e.g. the portal share
link area).

Target `data-testid` additions (lean list — adding these to the
respective component renders, not a separate PR):

- `[data-testid="portal-link"]` — the readable-URL box on Home.
- `[data-testid="portal-copy-link"]` — the copy button.
- `[data-testid="chat-input"]`, `[data-testid="chat-send"]`,
  `[data-testid="chat-messages"]` — ChatPanel.
- `[data-testid="file-list-item-${name}"]` — each file row.
- `[data-testid="file-download-all"]`, `[data-testid="file-download"]`,
  `[data-testid="file-pause"]`, `[data-testid="file-resume"]`,
  `[data-testid="file-cancel"]` — FileList.
- `[data-testid="collab-share-file"]` — the collab file-add input.
- `[data-testid="collab-password-input"]` — the password gate input.
- `[data-testid="collab-participants"]` — participant list.
- `[data-testid="collab-kick-${peerId}"]` — kick action per participant.
- `[data-testid="collab-close-room"]` — host-only close button.

---

## File layout

```
e2e/
├── global-setup.ts           # boot peerjs-server
├── global-teardown.ts        # stop it
├── helpers.ts                # page helpers: openPortal, waitForFingerprint, etc.
├── fixtures/
│   ├── tiny.txt              # <1 KB, for fast file-round-trip
│   └── medium.bin            # 256 KB, deterministic bytes for assertions
├── portal.spec.ts            # 1:1, 1:N, password, chat, pause/resume, reconnect
├── collab.spec.ts            # host+guest, mesh, chat, rename, kick, room-close
└── call.spec.ts              # panel smoke test (structural)
playwright.config.ts          # workers=1, webServer runs vite dev + test env
.env.test                     # local signaling config
```

---

## Playwright config shape

```ts
import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,    // one signaling server per run
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    permissions: ['clipboard-read', 'clipboard-write'],
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'npm run dev -- --mode test',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
```

---

## Per-test cadence

Average test ~5-15 s:
- ~1 s: page load + PeerJS peer-open.
- ~2 s: receiver connect + ECDH handshake.
- ~1 s: manifest exchange.
- ~2 s: fixture file (256 KB) transfer.
- ~1 s: assertion polling.

Full suite target: under 3 minutes on CI.

---

## CI integration

Add a new job to `.github/workflows/test.yml`:

```yaml
  e2e:
    runs-on: ubuntu-latest
    needs: test              # skip E2E if unit tests failed
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 7
```

---

## Known risks

1. **Timing flakiness.** Playwright's `waitFor` + generous timeouts
   (10 s per assertion) cover most of this, but peerjs-server on
   localhost is effectively instant, and our app's own ICE
   negotiation on the loopback interface is consistent. Seen in
   practice: sub-second handshakes. Flake budget should be close
   to zero.

2. **StreamSaver in headless Chromium.** Relies on a service worker
   at `/mitm.html`. Playwright runs against the vite dev server
   which serves that file. If it fails (e.g. because service
   workers are disabled in Playwright's default context), the app
   falls back to the in-memory path which closes with a standard
   `<a>` download click. Playwright's `page.waitForEvent('download')`
   catches either path. The fixture stays under 1 MB so the
   fallback never hits its 200 MB cap.

3. **Service-worker cache between tests.** Tear down via
   `browserContext.clearCookies()` + `context.serviceWorkers().forEach(sw => sw.unregister())`
   in an `afterEach` hook. Otherwise stale SW state from a prior
   test could redirect the download URL.

4. **Clipboard access in headless.** Playwright's `permissions` option
   grants clipboard read/write. No workaround needed.

5. **peerjs-server shutdown.** If a test throws mid-run and the
   global-teardown doesn't fire, the signaling server lingers on
   port 9000 and the next run fails. Use a process kill in teardown
   + a `ps | grep :9000 | kill` safety net in CI.

---

## Open questions (answer as we implement)

1. Do we want Playwright to run in parallel with unit tests in CI,
   or gate the E2E job behind unit tests passing? Proposal: gate
   (`needs: test`) — no point doing E2E if vitest's cheap checks
   failed.
2. Should we bundle Firefox + WebKit? Defer. Chromium only for P0.
3. Should fixture files be generated at test time (deterministic
   seed) or committed to the repo? Committed wins on CI speed.

---

## Acceptance

P3.3 is done when:

- `npm run test:e2e` passes locally.
- CI `e2e` job is green on the PR.
- Every test listed in "Scope" above is implemented.
- `playwright-report` artifact attaches on CI failure with traces
  + video.
- `docs/audit-roadmap.md` P3.3 section is updated to DONE.
