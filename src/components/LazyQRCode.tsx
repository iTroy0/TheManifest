import { lazy, Suspense } from 'react'

// L-i: defer the qrcode.react chunk (~16 KB raw / ~6 KB gzip) until the
// user actually opens a QR view. Both PortalLink and CollabHostView render
// QR conditionally behind a `showQr` toggle but previously imported the
// component statically, so the chunk loaded on every page that referenced
// either site even when the user never clicked the QR button. Wrapping
// QRCodeSVG in React.lazy + Suspense + conditional mount means: the chunk
// only loads after first toggle-on, then stays cached for subsequent
// toggles. Fallback is a same-size empty placeholder so layout doesn't
// shift between off → loading → loaded.

const QRCodeSVG = lazy(() =>
  import('qrcode.react').then(m => ({ default: m.QRCodeSVG })),
)

interface LazyQRCodeProps {
  value: string
  size?: number
}

export default function LazyQRCode({ value, size = 120 }: LazyQRCodeProps) {
  return (
    <Suspense fallback={<div style={{ width: size, height: size }} aria-hidden="true" />}>
      <QRCodeSVG value={value} size={size} level="M" bgColor="#ffffff" fgColor="#050505" />
    </Suspense>
  )
}
