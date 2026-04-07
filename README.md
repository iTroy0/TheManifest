# The Manifest

**[the-manifest-portal.vercel.app](https://the-manifest-portal.vercel.app/)**

Zero-server, browser-to-browser file sharing. Drop files, share a link, transfer directly via WebRTC. The link dies when you close the tab.

## Screenshots

| Home | Sender | Receiver |
|------|--------|----------|
| ![Home](screenshots/Home.png) | ![Sender](screenshots/Sender%20Page.png) | ![Receiver](screenshots/Reciever%20Page.png) |

## How It Works

1. **Drop your files** — Drag files in, click to browse, or paste with Ctrl+V. Drag to reorder. Set an optional password.
2. **Share the link** — Copy the portal link, use native share on mobile, or let them scan the QR code.
3. **End-to-end encryption** — ECDH key exchange + AES-256-GCM on every chunk. Both sides verify a matching key fingerprint.
4. **Recipient chooses** — Full file list shown upfront. Download individually or as a streaming zip. Nothing starts until they decide.
5. **Direct transfer** — Files stream browser-to-browser with real-time progress, speed, and ETA. Chat with the sender while you wait.
6. **Streamed to disk** — StreamSaver writes directly to the device. No file size limit, no RAM bottleneck.

## Features

**Encryption & Security**
- **Double encryption** — AES-256-GCM application layer + WebRTC DTLS transport. Two independent encryption layers.
- **Non-extractable keys** — Private keys stay inside WebCrypto boundary. Cannot be extracted by scripts.
- **Key fingerprint verification** — Both sides see the same fingerprint. Compare out-of-band to detect MITM.
- **Encrypted chat** — All chat messages encrypted with the shared AES-256-GCM key.
- **Encrypted passwords** — Portal passwords encrypted before transmission.
- **Security headers** — CSP, X-Frame-Options DENY, no-referrer policy, permissions policy.
- **ZIP filename sanitization** — Path traversal and special characters stripped from zip entries.
- **Key cleanup** — Encryption keys nulled on disconnect to minimize memory exposure.

**File Sharing**
- **Per-file download** — Recipient picks which files to download. No forced bulk downloads.
- **Download All as Zip** — Streams all files into a zip directly to disk. Zero RAM accumulation.
- **No file size limit** — 256KB chunks with backpressure control. StreamSaver writes to disk.
- **Drag to reorder** — Smooth drag-and-drop reorder before sharing (dnd-kit).
- **Image previews** — Thumbnails for image files before sending.
- **Resume on disconnect** — Auto-reconnects and resumes from the last chunk.

**Collaboration**
- **Multiple recipients** — Unlimited simultaneous connections. Each gets their own encrypted channel.
- **Password-protected portals** — Optional password gate before file access.
- **Live encrypted chat** — Bidirectional group chat between sender and all recipients.
- **Auto-generated nicknames** — Each recipient gets a random name (e.g. SwiftFox42).
- **Join/leave notifications** — System messages when recipients connect or disconnect.

**Connection & Monitoring**
- **Connection quality** — Live RTT latency badge. Green (<100ms), yellow (100-300ms), red (>300ms).
- **Connection type badge** — Shows "Direct P2P" or "Relay" with hover tooltips.
- **Disconnect detection** — ICE state monitoring for fast detection on both sides.
- **Self-hosted signaling** — Optional self-hosted PeerJS server for true zero-knowledge.
- **Relay fallback** — Opt-in encrypted TURN relay for strict NATs/firewalls.

**UX**
- **Mobile share API** — Native share button on mobile devices.
- **QR code sharing** — Collapsible QR code for quick mobile access.
- **Clipboard paste** — Ctrl+V to add files.
- **Real-time progress** — Per-file and overall progress with speed, ETA, elapsed time.
- **Tab title updates** — Transfer progress shown in browser tab.
- **Collapsible sections** — File list, password, QR code all collapsible for clean UI.
- **No accounts** — No sign-up, no login, no tracking.
- **Ephemeral** — Close the tab and the portal is gone.

## Tech Stack

- **React 19 + Vite** — Frontend framework
- **PeerJS** — WebRTC abstraction + signaling (self-hostable)
- **Web Crypto API** — ECDH key exchange + AES-256-GCM encryption
- **StreamSaver.js** — Stream files directly to disk
- **fflate** — Streaming zip creation
- **dnd-kit** — Accessible drag-and-drop
- **Tailwind CSS v4** — Styling
- **React Router v7** — Client-side routing
- **qrcode.react** — QR code generation
- **Lucide React** — Icons
- **coturn** — Self-hosted TURN relay (optional)

No backend. No database. Deploy as a static site.

## Getting Started

```bash
npm install
npm run dev
npm run build
```

## Environment Variables

```bash
cp .env.example .env
```

| Variable | Description |
|----------|-------------|
| `VITE_TURN_URL` | TURN relay server hostname |
| `VITE_TURN_USER` | TURN username |
| `VITE_TURN_PASS` | TURN password |
| `VITE_SIGNAL_HOST` | Self-hosted PeerJS signaling hostname |
| `VITE_SIGNAL_PATH` | PeerJS signaling path (default: `/signal`) |

On Vercel, add these in Settings → Environment Variables.

## Self-Hosted Servers (Optional)

**TURN relay** — for users behind strict NATs:
```bash
sudo bash turn-setup.sh
```

**PeerJS signaling** — for true zero-knowledge (no third-party signaling):
```bash
sudo bash signal-setup.sh
```

Both scripts install on Ubuntu, configure nginx with SSL (Let's Encrypt), and create systemd services.

## Deployment

**Vercel** (recommended):
```bash
# vercel.json is configured for SPA routing + security headers
# Connect your repo to Vercel and deploy
# Add env vars in Vercel dashboard
```

**Any static host:**
```bash
npm run build
# Serve dist/ with SPA fallback routing
```

## Limitations

- Both sender and receiver must keep their tabs open during transfer
- StreamSaver requires Chrome/Edge for direct-to-disk streaming. Other browsers fall back to in-memory blob download
- TURN relay and self-hosted signaling require a VPS

## License

AGPL-3.0 — See [LICENSE](LICENSE) for details.

---

by [iTroy0](https://github.com/iTroy0) — open source, free forever

[☕ Buy me a coffee](https://buymeacoffee.com/itroy0) if you find this useful.
