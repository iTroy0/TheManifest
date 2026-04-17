import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import ErrorBoundary from './components/ErrorBoundary'
import App from './App'
// Self-hosted fonts — no requests to fonts.googleapis.com / fonts.gstatic.com
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './index.css'

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
