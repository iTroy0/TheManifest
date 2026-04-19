import { Link } from 'react-router-dom'
import { ArrowLeft, Shield, EyeOff, Server, Globe, Mail, Database, type LucideIcon } from 'lucide-react'
import { usePageTitle } from '../hooks/usePageTitle'
import AppFooter from '../components/AppFooter'

interface SectionData {
  icon: LucideIcon
  title: string
  body: React.ReactNode
}

const sections: SectionData[] = [
  {
    icon: EyeOff,
    title: "What we don't collect",
    body: (
      <ul className="space-y-2 text-sm text-muted-light leading-relaxed list-disc pl-5">
        <li>No accounts. We never ask for an email, name, phone number, or anything else.</li>
        <li>No analytics. No Google Analytics, Vercel Analytics, Plausible, or any tracking pixel.</li>
        <li>No cookies. The Manifest does not set cookies or use localStorage to track you.</li>
        <li>No telemetry. Nothing about your session is reported back to us.</li>
        <li>No file metadata. We never see file names, sizes, types, or contents.</li>
        <li>No chat logs. Messages exist only in the browsers of the people in the room.</li>
        <li>No voice recordings stored. Voice notes are encrypted and streamed peer-to-peer. We never hear them.</li>
      </ul>
    ),
  },
  {
    icon: Shield,
    title: 'How your data flows',
    body: (
      <div className="space-y-3 text-sm text-muted-light leading-relaxed">
        <p>
          The Manifest is a peer-to-peer app. When you share a file or open a chat room, your
          browser opens a direct WebRTC connection to the other person&apos;s browser. Files and
          messages travel between you, not through us.
        </p>
        <p>
          Everything is end-to-end encrypted with AES-256-GCM using a key derived in your browser
          via ECDH (P-256). The encryption happens before data leaves your device. We could not
          read your files or messages even if we wanted to &mdash; we do not have the keys.
        </p>
        <p>
          <span className="text-text">Collaborative rooms</span> work the same way. The host&apos;s
          browser acts as a small in-memory coordinator for the participant list and chat fan-out,
          but each pair of guests also forms a direct mesh connection whenever their networks
          allow, and every link runs its own independent ECDH key exchange. File transfers prefer
          the direct guest-to-guest path. When a direct path is not possible the host forwards
          already-encrypted bytes &mdash; the host&apos;s browser cannot decrypt them, and neither
          can we. Each connection shows a fingerprint in the UI that you can compare out-of-band
          to verify nobody is in the middle.
        </p>
      </div>
    ),
  },
  {
    icon: Server,
    title: 'What our servers see',
    body: (
      <div className="space-y-3 text-sm text-muted-light leading-relaxed">
        <p>
          We run two services to make peer-to-peer connections possible. Neither stores anything to
          disk:
        </p>
        <ul className="space-y-2 list-disc pl-5">
          <li>
            <span className="text-text">Signaling server</span> (PeerJS) &mdash; relays the WebRTC
            handshake between two browsers so they can find each other. It sees connection metadata
            (peer IDs, SDP offers/answers, ICE candidates which contain IP addresses) in memory
            only. Nothing is logged or persisted. Once your two browsers are connected, the
            signaling server is no longer involved.
          </li>
          <li>
            <span className="text-text">TURN relay</span> (coturn) &mdash; only used when a direct
            connection between two browsers cannot be established (strict firewalls, symmetric
            NAT). It forwards already-encrypted bytes between peers. It cannot decrypt them. Bytes
            are not stored.
          </li>
        </ul>
        <p>
          The hosting provider (Vercel) processes standard HTTP request logs for the static site,
          as any web host does. We do not maintain our own access logs or analytics on top of that.
        </p>
      </div>
    ),
  },
  {
    icon: Globe,
    title: 'Third parties',
    body: (
      <div className="space-y-3 text-sm text-muted-light leading-relaxed">
        <p>The site loads no third-party scripts, fonts, or trackers. Specifically:</p>
        <ul className="space-y-2 list-disc pl-5">
          <li>
            <span className="text-text">Fonts</span> are self-hosted (Inter and JetBrains Mono).
            No requests to Google Fonts.
          </li>
          <li>
            <span className="text-text">STUN</span> is used to discover your public IP for NAT
            traversal (a standard part of WebRTC). We run our own STUN server on the same coturn
            instance as the relay, so this stays in-house. Google&apos;s public STUN servers
            (<code className="text-accent text-xs">stun.l.google.com</code>) are listed as a
            fallback only and are reached only if our box is unavailable. STUN sees your IP but
            never sees any of your traffic.
          </li>
          <li>
            <span className="text-text">Microphone</span> access is requested only when you tap the
            voice note button. Audio is recorded locally in your browser, encrypted, and streamed
            directly to the other peer. No audio data is sent to or processed by any server.
          </li>
          <li>
            <span className="text-text">External links</span> in the footer (GitHub, Buy Me a
            Coffee) take you to third-party sites with their own privacy policies. We do not share
            anything with them; clicking is your choice.
          </li>
        </ul>
      </div>
    ),
  },
  {
    icon: Database,
    title: 'Data retention',
    body: (
      <p className="text-sm text-muted-light leading-relaxed">
        There is nothing to retain. Files exist only in the browsers transferring them. Chat
        messages exist only in the browsers in the room. Connection metadata on the signaling
        server lives in RAM and disappears when the connection ends. Closing your tab erases your
        side completely.
      </p>
    ),
  },
  {
    icon: Shield,
    title: 'Your rights',
    body: (
      <p className="text-sm text-muted-light leading-relaxed">
        Since we do not collect, store, or process personal data, there is nothing for us to
        delete, export, or correct on your behalf. If you are an EU resident under GDPR, the
        principle of data minimisation is satisfied by design &mdash; we never had your data in
        the first place.
      </p>
    ),
  },
  {
    icon: Mail,
    title: 'Contact',
    body: (
      <p className="text-sm text-muted-light leading-relaxed">
        Questions about this policy or how the app works? Open an issue on{' '}
        <a
          href="https://github.com/iTroy0/TheManifest/issues"
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:underline"
        >
          GitHub
        </a>
        . The Manifest is open source under AGPL v3, so you can also read the code and verify any
        of the claims on this page.
      </p>
    ),
  },
]

interface SectionProps {
  icon: LucideIcon
  title: string
  children: React.ReactNode
}

function Section({ icon: Icon, title, children }: SectionProps) {
  return (
    <div className="glow-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border/50 bg-surface-2/30">
        <div className="w-8 h-8 rounded-lg glass-accent flex items-center justify-center">
          <Icon className="w-4 h-4 text-accent" />
        </div>
        <h2 className="font-mono text-sm font-medium text-text-bright">{title}</h2>
      </div>
      <div className="px-4 py-4">{children}</div>
    </div>
  )
}

export default function Privacy() {
  usePageTitle('Privacy')

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
                <Shield className="w-4 h-4 text-accent" strokeWidth={2} />
                <span className="absolute inset-0 rounded-xl bg-accent/10 blur-md -z-10" />
              </span>
              <span>
                <h1 className="font-mono font-bold text-lg tracking-[0.25em] uppercase title-engraved group-hover:opacity-80 transition-opacity">
                  The Manifest
                </h1>
                <p className="font-mono text-[11px] text-muted-light mt-0.5 tracking-wide">
                  Privacy Policy
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
            <span className="text-gradient-accent">Privacy is the product</span>
          </h2>
          <p className="text-sm text-muted-light max-w-md mx-auto">
            The Manifest is built so that we cannot spy on you even if we wanted to. Here is
            exactly what that means.
          </p>
        </div>

        {/* Sections */}
        <div className="space-y-4">
          {sections.map((s, i) => (
            <div key={s.title} className="animate-fade-in-up" style={{ animationDelay: `${i * 80}ms` }}>
              <Section icon={s.icon} title={s.title}>
                {s.body}
              </Section>
            </div>
          ))}
        </div>

      </main>

      <AppFooter />

    </div>
  )
}
