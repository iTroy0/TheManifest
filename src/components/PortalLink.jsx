import { useState, useCallback } from 'react'
import { Copy, Share2, QrCode } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import Toast from './Toast'

export default function PortalLink({ peerId }) {
  const [toast, setToast] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const url = `${window.location.origin}/portal/${peerId}`

  const canShare = typeof navigator.share === 'function'

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setToast(true)
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
        <p className="font-mono text-[10px] text-muted px-1 mb-1">Share this link with your recipient</p>
        <div className="flex items-center gap-1.5 bg-surface border border-border rounded-xl p-1.5">
          <code
            onClick={handleCopy}
            className="flex-1 font-mono text-[11px] text-accent truncate px-2 min-w-0 cursor-pointer hover:text-accent/80 transition-colors"
          >
            {url}
          </code>
          <button onClick={handleCopy} className="shrink-0 p-2 rounded-lg bg-surface-2 text-muted-light hover:text-accent hover:bg-accent/10 transition-colors" title="Copy link">
            <Copy className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setShowQr(q => !q)} className={`shrink-0 p-2 rounded-lg transition-colors ${showQr ? 'bg-accent/15 text-accent' : 'bg-surface-2 text-muted-light hover:text-accent hover:bg-accent/10'}`} title="QR code">
            <QrCode className="w-3.5 h-3.5" />
          </button>
          {canShare && (
            <button onClick={handleShare} className="shrink-0 p-2 rounded-lg bg-accent/10 text-accent hover:bg-accent/20 transition-colors" title="Share">
              <Share2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        {/* QR — collapsible */}
        <div className={`grid transition-all duration-300 ease-in-out ${showQr ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'}`}>
          <div className="overflow-hidden">
            <div className="flex flex-col items-center gap-1.5 pt-3 pb-1">
              <div className="bg-white/95 p-2.5 rounded-lg shadow-lg shadow-black/30">
                <QRCodeSVG value={url} size={100} level="M" bgColor="#ffffff" fgColor="#050505" />
              </div>
              <p className="font-mono text-[9px] text-muted">Scan to receive on mobile</p>
            </div>
          </div>
        </div>
      </div>
      <Toast message="Link copied to clipboard" visible={toast} onHide={hideToast} />
    </>
  )
}
