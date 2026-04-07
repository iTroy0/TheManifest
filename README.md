# The Manifest

**[the-manifest-portal.vercel.app](https://the-manifest-portal.vercel.app/)**

Zero-server, browser-to-browser file sharing. Drop files, share a link, transfer directly via WebRTC. The link dies when you close the tab.

## How It Works

1. **Drop your files** — Drag files into the portal zone, click to browse, or paste from clipboard (Ctrl+V). Any type, any number, no size limit.
2. **Share the link** — A unique portal link and QR code are generated instantly. Send it to your recipient.
3. **End-to-end encryption** — Both browsers perform an automatic ECDH key exchange. A shared AES-256-GCM key is derived. Both sides can verify the key fingerprint.
4. **Recipient chooses** — The recipient sees the file list and downloads individual files or everything as a zip. No auto-downloads — full control.
5. **Direct transfer** — Files stream browser-to-browser via WebRTC. Each chunk is encrypted before transmission. Progress, speed, and ETA shown in real time.
6. **Streamed to disk** — Files download directly to the device via StreamSaver. No file size limit, no RAM bottleneck.

## Features

- **End-to-end encrypted** — ECDH P-256 key exchange + AES-256-GCM encryption on every chunk, on top of WebRTC DTLS. Even a compromised relay sees only encrypted bytes.
- **Key fingerprint verification** — Both sender and receiver see a matching fingerprint to verify no man-in-the-middle.
- **Per-file download control** — Recipient picks which files to download, one at a time. No forced bulk downloads.
- **Download All as Zip** — Streams all files into a zip directly to disk. Zero RAM accumulation.
- **No file size limit** — 256KB chunks with 4-byte indexing. StreamSaver writes directly to disk.
- **Peer-to-peer** — Files go directly from sender to receiver. No server in the middle.
- **Ephemeral** — Close the tab and the portal is gone. No traces left behind.
- **No accounts** — No sign-up, no login, no tracking, no analytics.
- **Relay fallback** — If direct P2P fails (strict NATs/firewalls), the user can opt-in to an encrypted relay.
- **Connection type badge** — Shows "Direct P2P" or "Relay" so the user always knows.
- **Resume on disconnect** — If the connection drops mid-transfer, it auto-reconnects and resumes from the last chunk.
- **QR code sharing** — Scan with a phone to receive on mobile.
- **Clipboard paste** — Ctrl+V to add files.
- **Image previews** — Thumbnails for image files before sending.
- **Real-time progress** — Per-file and overall progress with animated counters, speed, ETA, and elapsed time.
- **Connection visualization** — Animated data flow between sender and receiver.
- **Tab title updates** — Shows transfer progress in the browser tab.
- **Portal ring animation** — Visual feedback when portal is open and waiting.
- **New session** — Start fresh after a transfer completes.
- **Error boundary** — Graceful error handling instead of white screens.

## Privacy & Security

- **Double encryption** — AES-256-GCM application layer + WebRTC DTLS transport layer. Two independent encryption layers.
- **Key exchange** — ECDH P-256 keypair generated fresh for every session. Keys never leave the browser.
- **Fingerprint verification** — Both sides display the same key fingerprint. Compare out-of-band to detect MITM attacks.
- **Zero knowledge** — No accounts. No logs. No analytics. No database. Files never touch a server.
- **Ephemeral** — Close the tab and everything is gone. No traces left behind.
- **Open source** — Every line of code is auditable. AGPL-3.0 licensed.

## Tech Stack

- **React 19 + Vite** — Frontend framework
- **PeerJS** — WebRTC abstraction + signaling
- **Web Crypto API** — ECDH key exchange + AES-256-GCM encryption
- **StreamSaver.js** — Stream files directly to disk
- **fflate** — Streaming zip creation
- **Tailwind CSS v4** — Styling
- **React Router v7** — Client-side routing
- **qrcode.react** — QR code generation
- **Lucide React** — Icons
- **coturn** — Self-hosted TURN relay (optional)

No backend. No database. Deploy as a static site.

## Getting Started

```bash
# Install dependencies
npm install

# Start dev server
npm run dev

# Build for production
npm run build
```

## Environment Variables

TURN relay credentials are loaded from environment variables (not hardcoded):

```bash
# Copy the example and fill in your values
cp .env.example .env
```

On Vercel, add these in Settings → Environment Variables.

## TURN Relay Server (Optional)

If users behind strict NATs can't connect directly, deploy a TURN relay on any Ubuntu VPS:

```bash
sudo bash turn-setup.sh
```

Then set the `VITE_TURN_URL`, `VITE_TURN_USER`, and `VITE_TURN_PASS` environment variables.

## Deployment

**Vercel** (recommended):
```bash
# vercel.json is already configured for SPA routing
# Connect your repo to Vercel and deploy
# Add TURN env vars in Vercel dashboard
```

**Any static host:**
```bash
npm run build
# Serve the dist/ folder with SPA fallback routing
```

## Limitations

- One recipient at a time per portal
- Both sender and receiver must keep their tabs open during transfer
- StreamSaver requires Chrome/Edge for direct-to-disk streaming. Other browsers fall back to in-memory blob download.
- Relay fallback requires a self-hosted TURN server

## License

AGPL-3.0 — See [LICENSE](LICENSE) for details.

---

by [iTroy0](https://github.com/iTroy0) — open source, free forever

[☕ Buy me a coffee](https://buymeacoffee.com/itroy0) if you find this useful.
