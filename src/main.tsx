import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
// Self-hosted fonts — no requests to fonts.googleapis.com / fonts.gstatic.com
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'

// M-aa — top-level async error listeners. React's ErrorBoundary only
// catches synchronous render/commit errors; unhandled promise rejections
// and non-React `window.onerror` events bypass it. In an E2E WebRTC app
// these are the norm, not the exception (ICE failures, getUserMedia
// rejections, DataChannel glitches). Log to the console so devs can see
// them; don't persist anywhere (consistent with the zero-trace stance).
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (ev) => {
    console.warn('[unhandledrejection]', ev.reason)
  })
  window.addEventListener('error', (ev) => {
    console.warn('[window.error]', ev.message, ev.error)
  })
}

const rootEl = document.getElementById('root') as HTMLElement
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>
)
