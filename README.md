<h1 align="center">The Manifest</h1>

<p align="center">
  <strong>Encrypted P2P file sharing & chat. No servers. No accounts. No trace.</strong>
</p>

<p align="center">
  <a href="https://github.com/iTroy0/TheManifest/stargazers">
    <img src="https://img.shields.io/github/stars/iTroy0/TheManifest?style=for-the-badge&logo=github" alt="Stars" />
  </a>
  <a href="https://the-manifest-portal.vercel.app/">
    <img src="https://img.shields.io/badge/Live_Demo-grey?style=for-the-badge&logo=vercel" alt="Live Demo" />
  </a>
  <a href="https://github.com/iTroy0/TheManifest/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/License-AGPL%20v3-blue?style=for-the-badge" alt="License" />
  </a>
  <a href="https://buymeacoffee.com/itroy0">
    <img src="https://img.shields.io/badge/Buy%20Me%20A%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me A Coffee" />
  </a>
</p>

<p align="center">
  <sub>Files and messages stream directly browser-to-browser via WebRTC.<br/>End-to-end encrypted. Close the tab and it's gone.</sub>
</p>

---

## Screenshots

<table>
  <tr>
    <td align="center"><strong>Home</strong></td>
    <td align="center"><strong>Sender</strong></td>
    <td align="center"><strong>Receiver</strong></td>
  </tr>
  <tr>
    <td><img src="screenshots/Home.png" alt="Home" width="280" /></td>
    <td><img src="screenshots/Sender%20Page.png" alt="Sender" width="280" /></td>
    <td><img src="screenshots/Reciever%20Page.png" alt="Receiver" width="280" /></td>
  </tr>
</table>

---

## Why The Manifest?

| Feature | The Manifest | WeTransfer | Dropbox | Google Drive |
|---------|:------------:|:----------:|:-------:|:------------:|
| No file size limit | ✅ | ❌ | ❌ | ❌ |
| No account required | ✅ | ✅ | ❌ | ❌ |
| End-to-end encrypted | ✅ | ❌ | ❌ | ❌ |
| Zero server storage | ✅ | ❌ | ❌ | ❌ |
| Real-time chat | ✅ | ❌ | ❌ | ❌ |
| Voice notes | ✅ | ❌ | ❌ | ❌ |
| No third-party requests | ✅ | ❌ | ❌ | ❌ |
| Completely free | ✅ | ❌ | ❌ | ❌ |

---

## Features

### Security & Privacy
- **End-to-end encrypted** — ECDH P-256 key exchange + AES-256-GCM on every chunk
- **Two encryption layers** — App-level E2E encryption + WebRTC DTLS transport
- **Zero knowledge** — Files never touch a server, pure P2P via WebRTC
- **Zero third-party requests** — Self-hosted fonts, self-hosted STUN/TURN, no analytics, no cookies, no tracking
- **Password protection** — Optional password gate with constant-time verification
- **Key fingerprints** — Verify connection integrity with visual fingerprints
- **Ephemeral** — Close the tab and everything is gone. No localStorage, no cookies, no data retention
- **Strict CSP** — Content Security Policy with frame-ancestors, form-action, upgrade-insecure-requests

### File Transfer
- **No file size limit** — StreamSaver writes directly to disk (tested with 1GB+)
- **Adaptive chunking** — Auto-adjusts chunk size (64KB-1MB) based on connection quality
- **Backpressure-aware** — Buffer drain between chunks prevents congestion
- **Pause, resume, cancel** — Full transfer control per file
- **Auto-reconnect** — Resumes from last chunk on disconnect
- **Live file sharing** — Add or remove files while recipients are connected
- **Bulk zip download** — Download all files as a single streaming archive
- **File previews** — Image/video thumbnails & text previews via Web Worker

### Chat & Collaboration
- **Encrypted chat rooms** — Standalone group chat mode
- **Voice notes** — Record and send encrypted voice messages (up to 3 minutes) with seekable playback
- **GIF support** — Animated GIFs sent through the binary chunk pipeline (no base64 inflation)
- **Image sharing** — Drag-and-drop or paste images directly in chat
- **Typing indicators** — See who's typing in real-time
- **Emoji reactions** — React to any message
- **Reply threads** — Quote and reply to messages
- **Sound & notifications** — Configurable alerts for new messages
- **Fullscreen & popout** — Moveable, resizable popout chat on desktop; fullscreen on mobile
- **RTL support** — Arabic and other RTL languages work natively
- **Clear messages** — Local-only clear with confirmation dialog

### Reliability
- **Multiple recipients** — Unlimited simultaneous connections
- **Heartbeat monitoring** — 30s timeout with proof-of-life on any incoming traffic
- **Zombie detection** — ICE state + heartbeat dedup prevents false disconnects
- **Reconnect dedup** — Nickname-based eviction prevents stale connection accumulation
- **Buffer drain safety** — waitForBufferDrain races against channel close to prevent hangs
- **TURN relay fallback** — Encrypted relay for strict NATs and firewalls

### Experience
- **Mobile-optimized** — iOS viewport fix, non-sticky header on mobile, touch-friendly
- **Accessible** — ARIA labels, keyboard navigation, role attributes
- **Connection stats** — Live RTT, P2P/Relay indicator, online count
- **QR codes** — Share portal links via QR code
- **Privacy page** — Transparent privacy policy at `/privacy`
- **FAQ** — Common questions answered at `/faq`

---

## Quick Start

```bash
git clone https://github.com/iTroy0/TheManifest.git
cd TheManifest
npm install
npm run dev
```

Run the test suite:

```bash
npm test                        # 196 tests
npm test -- --reporter=verbose  # see each test name
```

---

## Environment Variables

Create a `.env` file from the example:

```bash
cp .env.example .env
```

| Variable | Description | Required |
|----------|-------------|:--------:|
| `VITE_TURN_URL` | TURN/STUN server hostname | Optional |
| `VITE_TURN_USER` | TURN username | Optional |
| `VITE_TURN_PASS` | TURN password | Optional |
| `VITE_SIGNAL_HOST` | PeerJS signaling hostname | Optional |
| `VITE_SIGNAL_PATH` | PeerJS signaling path | Optional |

> **Note:** The app works without any environment variables using public STUN servers. Configure TURN/signaling for better NAT traversal and full privacy (no third-party requests).

---

## Self-Hosting

For true zero-knowledge operation, run your own signaling and relay servers:

```bash
# TURN/STUN relay (coturn) for strict NATs
sudo bash turn-setup.sh

# PeerJS signaling server
sudo bash signal-setup.sh
```

With self-hosted infrastructure, the only external connections during a session are between the two peers themselves.

---

## Tech Stack

<p>
  <img src="https://img.shields.io/badge/TypeScript-strict-3178C6?style=flat-square&logo=typescript&logoColor=white" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-6-646CFF?style=flat-square&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind-4-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white" />
  <img src="https://img.shields.io/badge/WebRTC-P2P-333333?style=flat-square&logo=webrtc&logoColor=white" />
  <img src="https://img.shields.io/badge/Web%20Crypto-AES--256-000000?style=flat-square" />
  <img src="https://img.shields.io/badge/Vitest-196%20tests-6E9F18?style=flat-square&logo=vitest&logoColor=white" />
</p>

- **Language:** TypeScript (strict mode)
- **Frontend:** React 19, Vite 6, Tailwind CSS v4
- **P2P:** PeerJS (WebRTC), Web Crypto API (ECDH + AES-256-GCM)
- **Streaming:** StreamSaver.js, fflate (zip)
- **Fonts:** Self-hosted Inter & JetBrains Mono via @fontsource
- **Testing:** Vitest (196 tests — crypto, chunking, transfer pipeline, connection helpers, integration)

**No backend. No database. Deploy as a static site.**

---

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│   Sender    │                    │  Receiver   │
│  (Browser)  │                    │  (Browser)  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  1. Exchange keys (ECDH P-256)   │
       │◄────────────────────────────────►│
       │                                  │
       │  2. Derive shared AES-256-GCM   │
       │          secret key              │
       │                                  │
       │  3. Stream encrypted chunks      │
       │     (backpressure-aware)         │
       │─────────────────────────────────►│
       │                                  │
       │  4. Chat, images & voice notes   │
       │     via binary chunk pipeline    │
       │◄────────────────────────────────►│
       │                                  │
       │        WebRTC DataChannel        │
       │      (DTLS encrypted P2P)        │
       │                                  │
```

---

## Security

- **Encryption:** ECDH P-256 key exchange + AES-256-GCM with fresh random IV per chunk
- **Password:** Constant-time XOR comparison prevents timing side-channel attacks
- **Input validation:** Chunk fileIndex bounds-checked against manifest to prevent injection
- **Key validation:** Invalid P-256 curve points abort the connection
- **CSP:** Strict Content-Security-Policy with no external domains
- **Headers:** X-Frame-Options SAMEORIGIN, HSTS, no-referrer, permissions-policy

The signaling server facilitates the WebRTC handshake only. The fingerprint displayed in the UI lets both sides verify no MITM occurred during key exchange.

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

---

## License

This project is licensed under the **AGPL-3.0 License** — see the [LICENSE](LICENSE) file for details.

---

<p align="center">
  <sub>Made with care by <a href="https://github.com/iTroy0">@iTroy0</a></sub>
  <br/>
  <sub>Open source, free forever.</sub>
</p>
