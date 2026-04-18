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
          <div className="min-h-screen flex items-center justify-center bg-grid px-6">
            <div className="text-center space-y-5 animate-fade-in-up glass-strong rounded-3xl px-10 py-12 max-w-md">
              <h1 className="font-mono text-7xl font-bold text-gradient-accent tracking-tight">404</h1>
              <p className="font-mono text-base text-muted-light">Page not found</p>
              <a href="/" className="inline-block px-5 py-2.5 rounded-xl font-mono text-sm glass-accent text-accent hover:text-accent-bright hover:border-accent/50 transition-colors">
                Go Home
              </a>
            </div>
          </div>
        } />
      </Routes>
    </div>
  )
}
