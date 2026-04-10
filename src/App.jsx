import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Portal from './pages/Portal'
import FAQ from './pages/FAQ'
import Privacy from './pages/Privacy'

export default function App() {
  return (
    <div className="min-h-screen bg-bg">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/portal/:peerId" element={<Portal />} />
        <Route path="/faq" element={<FAQ />} />
        <Route path="/privacy" element={<Privacy />} />
      </Routes>
    </div>
  )
}
