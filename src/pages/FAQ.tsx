import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronDown, Shield, Zap, Globe, HelpCircle, Users, type LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { usePageTitle } from '../hooks/usePageTitle'
import AppFooter from '../components/AppFooter'

interface FAQItemData {
  q: string
  a: string
}

interface FAQCategoryData {
  category: string
  icon: LucideIcon
  items: FAQItemData[]
}

const faqs: FAQCategoryData[] = [
  {
    category: 'General',
    icon: HelpCircle,
    items: [
      {
        q: 'What is The Manifest?',
        a: 'The Manifest is a peer-to-peer encrypted file sharing and chat application. Files and messages are transferred directly between browsers using WebRTC, with no server ever storing your data.'
      },
      {
        q: 'Do I need to create an account?',
        a: 'No. The Manifest requires no accounts, no sign-ups, and no personal information. Just open the app, share your link, and start transferring.'
      },
      {
        q: 'Is it really free?',
        a: 'Yes, completely free and open source. No premium tiers, no hidden fees, no ads. The code is available on GitHub under the AGPL v3 license.'
      },
      {
        q: 'What file types and sizes are supported?',
        a: 'Any file type is supported. There are no artificial size limits - you can transfer files as large as your browser can handle. For very large files (5GB+), we recommend a stable connection.'
      }
    ]
  },
  {
    category: 'Privacy & Security',
    icon: Shield,
    items: [
      {
        q: 'How is my data encrypted?',
        a: 'All data is encrypted using AES-256-GCM with keys derived via ECDH (Elliptic Curve Diffie-Hellman). The encryption happens in your browser before any data leaves your device.'
      },
      {
        q: 'Can the server see my files?',
        a: 'No. The server only facilitates the initial connection (signaling). Once connected, all data flows directly between browsers. The server never sees your files, messages, or encryption keys.'
      },
      {
        q: 'What is the fingerprint for?',
        a: 'The fingerprint is a unique identifier derived from your shared encryption key. You can verify it with your recipient (e.g., over a phone call) to confirm no one is intercepting your connection.'
      },
      {
        q: 'What happens when I close the tab?',
        a: 'Everything is gone. No data is stored on any server. Your files exist only in browser memory during the transfer. Close the tab and there is no trace.'
      },
      {
        q: 'Is password protection secure?',
        a: 'Yes. When you set a password, recipients must enter it before they can receive any data. The password is verified cryptographically and never transmitted in plain text.'
      }
    ]
  },
  {
    category: 'How It Works',
    icon: Zap,
    items: [
      {
        q: 'What is WebRTC?',
        a: 'WebRTC (Web Real-Time Communication) is a browser technology that enables direct peer-to-peer connections. It powers video calls in apps like Google Meet and Discord, and we use it for encrypted file transfers.'
      },
      {
        q: 'What is a "portal"?',
        a: 'A portal is your unique sharing session. When you add files or start a chat room, you get a portal link. Anyone with this link can connect directly to your browser and receive your files.'
      },
      {
        q: 'Why did my connection fail?',
        a: 'Some networks (corporate firewalls, strict NATs) block direct peer-to-peer connections. If direct connection fails, you can try the encrypted relay option which routes data through a TURN server while maintaining end-to-end encryption.'
      },
      {
        q: 'What is the relay option?',
        a: 'When direct connection is not possible, data can be routed through a TURN relay server. Your data remains end-to-end encrypted - the relay cannot read your files. Speed may be slightly slower than direct connections.'
      },
      {
        q: 'Can multiple people download at once?',
        a: 'Yes! Multiple recipients can connect to your portal simultaneously. Each gets their own encrypted channel with a unique encryption key.'
      },
      {
        q: 'Are voice notes encrypted?',
        a: 'Yes. Voice notes go through the same binary chunk pipeline as file transfers — each chunk is encrypted with AES-256-GCM before leaving your browser. The relay server cannot hear your recordings.'
      },
      {
        q: 'Does the app access my microphone or camera?',
        a: 'Only when you explicitly tap a button — recording a voice note or joining a live call. Your browser will ask permission the first time. Audio and video are captured locally and streamed directly to the other peers. Nothing is ever sent to a server.'
      },
      {
        q: 'How are live voice & video calls encrypted?',
        a: 'Calls use WebRTC\'s built-in DTLS-SRTP encryption, which is end-to-end between browsers — no server can listen in. Files and chat are additionally wrapped in an app-level AES-256-GCM layer; live media runs on a single encryption layer because adding a second layer to real-time media is impractical without an SFU.'
      },
      {
        q: 'Is there a limit on how many people can be in a call?',
        a: 'Voice calls scale up to 20 participants (same cap as file transfer) using a peer-to-peer mesh. Video calls are 1:1 — only the first two people to click Join Video get their cameras shared. Everyone else can still join audio.'
      },
      {
        q: 'Can I control the volume of other people in a call?',
        a: 'Yes. Tap the settings (gear) icon in the call controls to reveal a master volume slider that applies to everyone you\'re listening to. For a faster silence, the controls row also has a dedicated mute-speakers button. On mobile, tap targets are sized for thumbs and the video grid stacks vertically in portrait.'
      }
    ]
  },
  {
    category: 'Collaborative Rooms',
    icon: Users,
    items: [
      {
        q: 'What is a collaborative room?',
        a: 'A collaborative room is a multi-party workspace where every participant can share files, chat, react, and join voice/video calls in one place. Unlike the 1:N portal mode where one sender hands files to N receivers, a collab room lets every guest be both sender and receiver at the same time. Open one at /collab or from the "Collaborative room" button on the home page.'
      },
      {
        q: 'How does the encryption work with multiple people?',
        a: 'Every pair-wise connection runs its own ECDH P-256 key exchange and derives its own AES-256-GCM key. Host↔guest and guest↔guest links each get an independent shared secret, so no single key covers the whole room. Files and chat are encrypted before they leave your browser, and each connection exposes its own fingerprint in the UI so you can verify it out-of-band.'
      },
      {
        q: 'Does the host see what guests share with each other?',
        a: 'No. Guests form direct peer-to-peer connections with each other via a "mesh" and transfer files over those mesh links using a key the host does not have. The host only acts as a signaling broker and a fallback relay. If a direct guest-to-guest connection cannot be formed (strict NAT), the host forwards already-encrypted bytes — the host\'s browser cannot decrypt them, and neither can we.'
      },
      {
        q: 'What do the fingerprints in the "Verify connections" panel mean?',
        a: 'Each fingerprint is a short hash of the public keys used on that specific connection. If you and the other person see the same 4+4 hex string, no one is in the middle. If they differ, the connection has been tampered with. Compare them over a separate channel (voice, SMS, in person) to be sure.'
      },
      {
        q: 'Can the host add or remove a password while people are in the room?',
        a: 'No. Password changes are blocked once at least one guest is connected, because flipping the requirement mid-session would either lock out admitted guests or give a false sense of security to people who joined before the lock. Set the password before sharing the link, or remove everyone, change the password, and re-invite.'
      },
      {
        q: 'What happens if a guest leaves mid-transfer?',
        a: 'Only transfers that were going to or from that specific guest are aborted. Other mesh transfers and host-relay transfers keep running untouched. Files owned by a guest who leaves are removed from the shared list so no one can click "Download" on a ghost entry.'
      },
      {
        q: 'How many people can be in a collab room?',
        a: 'Up to 20 participants — the same cap as voice calls and the 1:N portal. Beyond that, WebRTC mesh fan-out starts to stress typical home connections.'
      },
      {
        q: 'Can I download many files at once?',
        a: 'Yes. When a room has multiple files, the file list header shows a "Download all (N)" button that fetches every file you have not already downloaded. Individual files also support pause, resume, cancel, and retry on error.'
      }
    ]
  },
  {
    category: 'Troubleshooting',
    icon: Globe,
    items: [
      {
        q: 'Transfer is slow, what can I do?',
        a: 'Transfer speed depends on both parties\' internet connections. Try: closing other bandwidth-heavy apps, using a wired connection instead of WiFi, or ensuring both parties have stable internet.'
      },
      {
        q: 'Connection keeps dropping',
        a: 'This usually indicates an unstable network. The app will automatically try to reconnect and resume transfers. If problems persist, try the relay option or check your network stability.'
      },
      {
        q: 'Files not downloading on mobile',
        a: 'Some mobile browsers have limitations with large file downloads. For best results on mobile, use the latest Chrome or Safari, and ensure you have enough storage space.'
      },
      {
        q: 'The link expired or shows an error',
        a: 'Portal links are only valid while the sender has their browser open. If the sender closed their tab or lost connection, the link becomes invalid. Ask them to create a new portal.'
      }
    ]
  }
]

interface FAQItemProps {
  q: string
  a: string
}

function FAQItem({ q, a }: FAQItemProps) {
  const [open, setOpen] = useState<boolean>(false)

  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-start justify-between gap-4 py-4 text-left group"
      >
        <span className="font-mono text-sm text-text group-hover:text-accent transition-colors">{q}</span>
        <ChevronDown className={`w-4 h-4 text-muted shrink-0 mt-0.5 transition-transform duration-300 ${open ? 'rotate-180' : ''}`} />
      </button>
      <div className={`grid transition-all duration-300 ease-in-out ${open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
        <div className="overflow-hidden">
          <p className="text-sm text-muted-light leading-relaxed pb-4">{a}</p>
        </div>
      </div>
    </div>
  )
}

interface FAQCategoryProps {
  category: string
  icon: LucideIcon
  items: FAQItemData[]
}

function FAQCategory({ category, icon: Icon, items }: FAQCategoryProps) {
  return (
    <div className="glow-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-surface-2/30">
        <div className="w-8 h-8 rounded-lg glass-accent flex items-center justify-center">
          <Icon className="w-4 h-4 text-accent" />
        </div>
        <h2 className="font-mono text-sm font-medium text-text-bright">{category}</h2>
      </div>
      <div className="px-4">
        {items.map((item, i) => (
          <FAQItem key={i} q={item.q} a={item.a} />
        ))}
      </div>
    </div>
  )
}

export default function FAQ() {
  usePageTitle('FAQ')

  return (
    <div className="min-h-screen flex flex-col bg-grid">

      {/* Header */}
      <header className="border-b border-border/60 glass">
        <div className="max-w-[720px] mx-auto px-6 py-5">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-accent transition-colors mb-3 w-fit group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-mono text-xs">Back to app</span>
          </Link>
          <div className="flex items-center justify-between">
            <Link to="/" className="group flex items-center gap-3">
              <span className="relative inline-flex w-9 h-9 rounded-xl items-center justify-center glass-accent shrink-0">
                <HelpCircle className="w-4 h-4 text-accent" strokeWidth={2} />
                <span className="absolute inset-0 rounded-xl bg-accent/10 blur-md -z-10" />
              </span>
              <span>
                <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                  The Manifest
                </h1>
                <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide">
                  Frequently Asked Questions
                </p>
              </span>
            </Link>
          </div>
        </div>
      </header>

      {/* Main */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">

        {/* Intro */}
        <div className="text-center py-4 animate-fade-in-up">
          <h2 className="font-mono text-2xl font-bold mb-2">
            <span className="text-gradient-accent">How can we help?</span>
          </h2>
          <p className="text-sm text-muted-light max-w-md mx-auto">
            Find answers to common questions about The Manifest, privacy, security, and troubleshooting.
          </p>
        </div>

        {/* FAQ Categories */}
        <div className="space-y-4">
          {faqs.map((cat, i) => (
            <div key={cat.category} className="animate-fade-in-up" style={{ animationDelay: `${i * 100}ms` }}>
              <FAQCategory category={cat.category} icon={cat.icon} items={cat.items} />
            </div>
          ))}
        </div>

        {/* Still have questions */}
        <div className="text-center py-8 animate-fade-in-up" style={{ animationDelay: '400ms' }}>
          <p className="font-mono text-sm text-muted mb-3">Still have questions?</p>
          <a
            href="https://github.com/iTroy0/TheManifest/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
              glass-accent text-accent hover:text-accent-bright hover:border-accent/50 transition-colors"
          >
            Open an issue on GitHub
          </a>
        </div>

      </main>

      <AppFooter />

    </div>
  )
}
