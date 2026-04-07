import { Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Portal from './pages/Portal'

export default function App() {
  return (
    <div className="min-h-screen bg-bg">
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/portal/:peerId" element={<Portal />} />
      </Routes>
    </div>
  )
}
