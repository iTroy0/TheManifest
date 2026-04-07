import { useState, useCallback } from 'react'
import { Copy, Link as LinkIcon, Share2 } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import Toast from './Toast'

export default function PortalLink({ peerId }) {
  const [toast, setToast] = useState(false)
  const url = `${window.location.origin}/portal/${peerId}`

  const canShare = typeof navigator.share === 'function'

  async function handleCopy() {
    await navigator.clipboard.writeText(url)
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
        <div className="glow-card p-5 space-y-5">
          {/* Label */}
          <div className="flex items-center gap-2">
            <LinkIcon className="w-3.5 h-3.5 text-accent" />
            <span className="font-mono text-xs text-accent uppercase tracking-wider">
              Portal Link
            </span>
          </div>

          {/* URL + copy */}
          <div className="flex items-center gap-2 bg-bg border border-border rounded-lg p-3">
            <code className="flex-1 font-mono text-sm text-accent truncate select-all text-glow">
              {url}
            </code>
            <button
              onClick={handleCopy}
              className="shrink-0 px-3 py-1.5 rounded-lg font-mono text-xs transition-all duration-300
                bg-surface-2 text-muted hover:text-text hover:bg-border"
            >
              <span className="flex items-center gap-1.5">
                <Copy className="w-3.5 h-3.5" /> Copy
              </span>
            </button>
            {canShare && (
              <button
                onClick={handleShare}
                className="shrink-0 px-3 py-1.5 rounded-lg font-mono text-xs transition-all duration-300
                  bg-accent/10 text-accent hover:bg-accent/20"
              >
                <span className="flex items-center gap-1.5">
                  <Share2 className="w-3.5 h-3.5" /> Share
                </span>
              </button>
            )}
          </div>

          {/* Instruction */}
          <p className="font-mono text-[10px] text-muted text-center">
            Send this link to your recipient. They'll connect directly to your browser.
          </p>

          {/* QR */}
          <div className="flex justify-center">
            <div className="bg-white/95 p-3.5 rounded-xl shadow-lg shadow-black/30">
              <QRCodeSVG
                value={url}
                size={130}
                level="M"
                bgColor="#ffffff"
                fgColor="#050505"
              />
            </div>
          </div>
          <p className="font-mono text-[10px] text-muted text-center">
            Or scan with a phone to receive on mobile
          </p>
        </div>
      </div>
      <Toast message="Link copied to clipboard" visible={toast} onHide={hideToast} />
    </>
  )
}
