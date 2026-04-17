import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Portal from './pages/Portal'
import CollabPortal from './pages/CollabPortal'
import FAQ from './pages/FAQ'
import Privacy from './pages/Privacy'

export default function App() {
  return (
    <div className="min-h-screen bg-bg">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/portal/:peerId" element={<Portal />} />
        <Route path="/collab" element={<CollabPortal />} />
        <Route path="/collab/:roomId" element={<CollabPortal />} />
        <Route path="/faq" element={<FAQ />} />
        <Route path="/privacy" element={<Privacy />} />
        <Route path="*" element={
          <div className="min-h-screen flex items-center justify-center">
            <div className="text-center space-y-4 animate-fade-in-up">
              <h1 className="font-mono text-5xl font-bold text-muted/30">404</h1>
              <p className="font-mono text-base text-muted">Page not found</p>
              <a href="/" className="inline-block px-5 py-2.5 rounded-xl font-mono text-sm bg-surface border border-border text-muted-light hover:border-accent/40 hover:text-accent transition-colors">
                Go Home
              </a>
            </div>
          </div>
        } />
      </Routes>
    </div>
  )
}
