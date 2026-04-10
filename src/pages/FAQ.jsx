import { Link } from 'react-router-dom'
import { ArrowLeft, ChevronDown, Shield, Zap, Lock, Globe, Eye, Server, HelpCircle } from 'lucide-react'
import { useState } from 'react'
import { usePageTitle } from '../hooks/usePageTitle'

const faqs = [
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

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false)
  
  return (
    <div className="border-b border-border/50 last:border-0">
      <button
        onClick={() => setOpen(o => !o)}
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

function FAQCategory({ category, icon: Icon, items }) {
  return (
    <div className="glow-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-surface-2/30">
        <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center">
          <Icon className="w-4 h-4 text-accent" />
        </div>
        <h2 className="font-mono text-sm font-medium text-text">{category}</h2>
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
    <div className="min-h-screen flex flex-col bg-grid bg-radial-glow">
      
      {/* Header */}
      <header className="border-b border-border/60 backdrop-blur-sm bg-bg/80 sticky top-0 z-10">
        <div className="max-w-[720px] mx-auto px-6 py-5">
          <Link to="/" className="flex items-center gap-2 text-muted hover:text-accent transition-colors mb-3 w-fit group">
            <ArrowLeft className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" />
            <span className="font-mono text-xs">Back to app</span>
          </Link>
          <div className="flex items-center justify-between">
            <Link to="/" className="group">
              <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                The Manifest
              </h1>
              <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide">
                Frequently Asked Questions
              </p>
            </Link>
          </div>
        </div>
      </header>
      
      {/* Main */}
      <main className="flex-1 max-w-[720px] w-full mx-auto px-6 py-8 space-y-6">
        
        {/* Intro */}
        <div className="text-center py-4 animate-fade-in-up">
          <h2 className="font-mono text-xl font-bold text-text-bright mb-2">
            How can we help?
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
              bg-surface border border-border text-muted-light hover:border-accent/40 hover:text-accent transition-colors"
          >
            Open an issue on GitHub
          </a>
        </div>
        
      </main>
      
      {/* Footer */}
      <footer className="border-t border-border/40 py-6 mt-auto">
        <div className="max-w-[720px] mx-auto px-6 flex items-center justify-center gap-4 text-xs text-muted">
          <Link to="/" className="hover:text-accent transition-colors">Home</Link>
          <span className="text-border">|</span>
          <Link to="/privacy" className="hover:text-accent transition-colors">Privacy</Link>
          <span className="text-border">|</span>
          <a href="https://github.com/iTroy0/TheManifest" target="_blank" rel="noopener noreferrer" className="hover:text-accent transition-colors">GitHub</a>
          <span className="text-border">|</span>
          <span>Open Source</span>
        </div>
      </footer>
      
    </div>
  )
}
