<h1 align="center">The Manifest</h1>

<p align="center">
  <strong>Encrypted P2P file sharing & chat. No servers. No accounts. No trace.</strong>
</p>

<p align="center">
  <a href="https://github.com/iTroy0/TheManifest/stargazers">
    <img src="https://img.shields.io/github/stars/iTroy0/TheManifest?style=for-the-badge&logo=github&logoColor=white&color=00FF88" alt="Stars" />
  </a>
  <a href="https://the-manifest-portal.vercel.app/">
    <img src="https://img.shields.io/badge/Live%20Demo-00FF88?style=for-the-badge&logo=vercel&logoColor=black" alt="Live Demo" />
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
| Completely free | ✅ | ❌ | ❌ | ❌ |

---

## Features

### Security & Privacy
- **End-to-end encrypted** — ECDH key exchange + AES-256-GCM on every chunk
- **Zero knowledge** — Files never touch a server, pure P2P via WebRTC DTLS
- **Password protection** — Optional password gate with encrypted transmission
- **Key fingerprints** — Verify connection integrity with visual fingerprints
- **Ephemeral** — Close the tab and everything is gone

### File Transfer
- **No file size limit** — StreamSaver writes directly to disk
- **Adaptive chunking** — Auto-adjusts chunk size based on connection quality
- **Pause, resume, cancel** — Full transfer control per file
- **Live file sharing** — Add files while recipients are connected
- **Bulk zip download** — Download all files as a single archive
- **File previews** — Image, video thumbnails & text previews

### Chat & Collaboration  
- **Encrypted chat rooms** — Standalone group chat mode
- **Typing indicators** — See who's typing in real-time
- **Emoji reactions** — React to any message
- **Reply threads** — Quote and reply to messages
- **Image sharing** — Share images directly in chat
- **Sound & notifications** — Get alerted for new messages

### Reliability
- **Multiple recipients** — Unlimited simultaneous connections
- **Auto-reconnect** — Resumes from last chunk on disconnect
- **Heartbeat monitoring** — Detects zombie connections
- **Chunk verification** — Request retransmission on corruption

### Experience
- **Mobile-friendly** — Touch support, native share API, QR codes
- **Accessible** — ARIA labels, keyboard navigation, WCAG AA
- **Connection stats** — Live RTT, P2P/Relay indicator

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/iTroy0/TheManifest.git
cd TheManifest

# Install dependencies
npm install

# Start development server
npm run dev

# Run tests
npm test
```

---

## Environment Variables

Create a `.env` file from the example:

```bash
cp .env.example .env
```

| Variable | Description | Required |
|----------|-------------|:--------:|
| `VITE_TURN_URL` | TURN relay hostname | Optional |
| `VITE_TURN_USER` | TURN username | Optional |
| `VITE_TURN_PASS` | TURN password | Optional |
| `VITE_SIGNAL_HOST` | PeerJS signaling hostname | Optional |
| `VITE_SIGNAL_PATH` | PeerJS signaling path | Optional |

> **Note:** The app works without any environment variables using public STUN servers. Configure TURN/signaling for better NAT traversal and privacy.

---

## Self-Hosting

For true zero-knowledge operation, run your own signaling and relay servers:

```bash
# TURN relay for strict NATs
sudo bash turn-setup.sh

# PeerJS signaling server
sudo bash signal-setup.sh
```

---

## Tech Stack

<p>
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=white" />
  <img src="https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite&logoColor=white" />
  <img src="https://img.shields.io/badge/Tailwind-4-38B2AC?style=flat-square&logo=tailwind-css&logoColor=white" />
  <img src="https://img.shields.io/badge/WebRTC-P2P-333333?style=flat-square&logo=webrtc&logoColor=white" />
  <img src="https://img.shields.io/badge/Web%20Crypto-AES--256-000000?style=flat-square" />
</p>

- **Frontend:** React 19, Vite, Tailwind CSS v4
- **P2P:** PeerJS (WebRTC), Web Crypto API
- **Streaming:** StreamSaver.js, fflate (zip)
- **DnD:** dnd-kit

**No backend. No database. Deploy as a static site.**

---

## Architecture

```
┌─────────────┐                    ┌─────────────┐
│   Sender    │                    │  Receiver   │
│  (Browser)  │                    │  (Browser)  │
└──────┬──────┘                    └──────┬──────┘
       │                                  │
       │  1. Exchange keys (ECDH)         │
       │◄────────────────────────────────►│
       │                                  │
       │  2. Derive shared secret         │
       │          (AES-256)               │
       │                                  │
       │  3. Stream encrypted chunks      │
       │─────────────────────────────────►│
       │                                  │
       │        WebRTC DataChannel        │
       │      (DTLS encrypted P2P)        │
       │                                  │
```

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
