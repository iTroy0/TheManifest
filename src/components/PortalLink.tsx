import { useState, useCallback } from 'react'
import { Copy, Share2, QrCode } from 'lucide-react'
import LazyQRCode from './LazyQRCode'
import Toast from './Toast'

interface PortalLinkProps {
  peerId: string
}

export default function PortalLink({ peerId }: PortalLinkProps) {
  const [toast, setToast] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const url = `${window.location.origin}/portal/${peerId}`

  const canShare = typeof navigator.share === 'function'

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
      setToast(true)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      if (ok) {
        setToast(true)
      } else {
        prompt('Copy this link manually:', url)
      }
    }
  }

  async function handleShare() {
    try {
      await navigator.share({ title: 'The Manifest', text: 'Receive files from me', url })
    } catch { /* user cancelled */ }
  }

  const hideToast = useCallback(() => setToast(false), [])

  return (
    <>
      <div className="animate-fade-in-up" style={{ animationDelay: '100ms' }}>
        <p className="font-mono text-[10px] text-muted px-1 mb-2">Share this link with recipients</p>
        <div className="flex items-center gap-2 bg-surface-2/50 border border-border rounded-xl p-2 hover:border-accent/30 transition-colors group">
          <code
            onClick={handleCopy}
            className="flex-1 font-mono text-xs text-accent truncate px-2 py-1 min-w-0 cursor-pointer hover:text-accent/80 transition-colors rounded-lg hover:bg-accent/5 select-all"
          >
            {url}
          </code>
          <div className="flex items-center gap-1">
            <button
              onClick={handleCopy}
              aria-label="Copy link"
              className="shrink-0 p-2.5 rounded-lg bg-accent text-bg hover:bg-accent-dim active:scale-95 transition-all"
              title="Copy link"
            >
              <Copy className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowQr(q => !q)}
              aria-label="QR code"
              className={`shrink-0 p-2.5 rounded-lg transition-all active:scale-95 ${showQr ? 'bg-accent/20 text-accent' : 'bg-surface text-muted-light hover:text-accent hover:bg-accent/10'}`}
              title="QR code"
            >
              <QrCode className="w-4 h-4" />
            </button>
            {canShare && (
              <button
                onClick={handleShare}
                aria-label="Share"
                className="shrink-0 p-2.5 rounded-lg bg-surface text-muted-light hover:text-accent hover:bg-accent/10 active:scale-95 transition-all"
                title="Share"
              >
                <Share2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        {showQr && (
          <div className="flex flex-col items-center gap-2 pt-4 pb-2 animate-fade-in-up">
            <div className="bg-white p-3 rounded-xl shadow-xl shadow-black/40 ring-1 ring-white/20">
              <div role="img" aria-label={`QR code linking to ${url}`}>
                <LazyQRCode value={url} size={120} />
              </div>
            </div>
            <p className="font-mono text-[10px] text-muted">Scan to receive on mobile</p>
          </div>
        )}
      </div>
      <Toast message="Link copied to clipboard" visible={toast} onHide={hideToast} />
    </>
  )
}
