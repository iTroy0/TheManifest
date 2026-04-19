import { useState } from 'react'
import { Shield, Wifi, Upload, ChevronDown } from 'lucide-react'

export interface FingerprintEntry {
  peerId: string
  name: string
  fingerprint?: string
}

// First 16 hex chars formatted as "XXXX XXXX XXXX XXXX" for real
// out-of-band verification (64 bits of disambiguation).
export function formatFingerprint(fp: string | null | undefined): string {
  if (!fp) return '—'
  const clean = fp.replace(/[^0-9a-fA-F]/g, '').toLowerCase()
  if (clean.length < 16) return clean
  return `${clean.slice(0, 4)} ${clean.slice(4, 8)} ${clean.slice(8, 12)} ${clean.slice(12, 16)}`
}

// Fingerprint panel — participants compare out-of-band (voice/SMS) and
// detect a man-in-the-middle (C1). H3 — open by default so the
// verification surface is visible without a click; users can still
// collapse it. A buried panel is the biggest realistic gap against the
// E2E marketing claim.
export function VerifyConnectionsPanel({ entries }: { entries: FingerprintEntry[] }) {
  const [open, setOpen] = useState(true)
  if (entries.length === 0) return null
  return (
    <div className="border-t border-border">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-5 py-3 text-left hover:bg-surface-2/30 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 text-accent" />
          <span className="font-mono text-xs text-muted uppercase tracking-wide">Verify connections</span>
        </div>
        <ChevronDown className={`w-3.5 h-3.5 text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-5 pb-4 space-y-1.5">
          <p className="font-mono text-[10px] text-muted leading-relaxed">
            Compare fingerprints out-of-band (voice/SMS) to detect a man-in-the-middle.
          </p>
          {entries.map(e => (
            <div key={e.peerId} className="flex items-center justify-between py-1.5 px-2 rounded bg-surface-2/40 border border-border/50">
              <span className="font-mono text-[11px] text-text truncate max-w-[40%]">{e.name}</span>
              {e.fingerprint ? (
                <code className="font-mono text-[11px] text-accent tabular-nums tracking-widest">{formatFingerprint(e.fingerprint)}</code>
              ) : (
                <code className="font-mono text-[11px] text-muted tabular-nums tracking-widest">pending…</code>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// RTT / P2P-or-relay / E2E status chips re-used in both Host and Guest views.
export function ConnectionChips({ rtt, fingerprint, useRelay }: { rtt: number | null; fingerprint: string | null; useRelay?: boolean }) {
  return (
    <>
      <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${useRelay ? 'bg-warning/5 border-warning/20' : 'bg-accent/5 border-accent/20'}`} title={useRelay ? 'Files pass through an encrypted relay server' : 'Files transfer directly between browsers'}>
        <Wifi className={`w-3 h-3 ${useRelay ? 'text-warning' : 'text-accent'}`} />
        <span className={`font-mono text-[10px] ${useRelay ? 'text-warning' : 'text-accent'}`}>{useRelay ? 'Relay' : 'P2P'}</span>
      </div>
      {rtt !== null && (
        <div className={`flex items-center gap-1 rounded-full px-2 py-0.5 border cursor-default ${rtt < 100 ? 'bg-accent/5 border-accent/20' : rtt < 300 ? 'bg-warning-mid/5 border-warning-mid/20' : 'bg-danger/5 border-danger/20'}`} title={`Round-trip latency: ${rtt}ms`}>
          <span className={`font-mono text-[10px] ${rtt < 100 ? 'text-accent' : rtt < 300 ? 'text-warning-mid' : 'text-danger'}`}>{rtt}ms</span>
        </div>
      )}
      <div className="flex items-center gap-1 bg-accent/5 border border-accent/20 rounded-full px-2 py-0.5 cursor-default" title={fingerprint ? `Verify fingerprint: ${fingerprint}` : 'E2E encrypted'}>
        <Shield className="w-3 h-3 text-accent" />
        <span className="font-mono text-[10px] text-accent">E2E</span>
      </div>
    </>
  )
}

// Uploads-in-flight summary. Null when no uploads, single-file detail when
// one is active, otherwise a count.
export function UploadsSummary({ uploads }: { uploads: Record<string, { progress: number; speed: number; fileName: string }> }) {
  const keys = Object.keys(uploads)
  if (keys.length === 0) return null
  if (keys.length === 1) {
    const u = uploads[keys[0]]
    return (
      <div className="px-4 py-2 border-t border-border">
        <div className="flex items-center gap-2 bg-info/5 border border-info/15 rounded-lg px-3 py-2">
          <Upload className="w-3.5 h-3.5 text-info shrink-0" />
          <span className="flex-1 font-mono text-[11px] text-info truncate">
            Uploading {u.fileName} ({Math.min(100, u.progress)}%)
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className="px-4 py-2 border-t border-border">
      <div className="flex items-center gap-2 bg-info/5 border border-info/15 rounded-lg px-3 py-2">
        <Upload className="w-3.5 h-3.5 text-info shrink-0" />
        <span className="flex-1 font-mono text-[11px] text-info">
          Uploading {keys.length} files
        </span>
      </div>
    </div>
  )
}
