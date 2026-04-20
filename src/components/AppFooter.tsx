import { Link } from 'react-router-dom'
import { Coffee } from 'lucide-react'

export default function AppFooter() {
  return (
    <footer className="border-t border-border/40 mt-auto">
      <div className="max-w-[720px] mx-auto px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-2 text-center sm:text-left">
        <p className="font-mono text-xs text-muted">
          No servers. No storage. No tracking.
        </p>
        <p className="font-mono text-xs text-muted">
          <Link to="/faq" className="text-muted-light hover:text-accent transition-colors">FAQ</Link>
          {' · '}
          <Link to="/privacy" className="text-muted-light hover:text-accent transition-colors">Privacy</Link>
          {' · '}
          <a href="https://github.com/iTroy0/TheManifest" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">GitHub</a>
          {' · by '}
          <a href="https://github.com/iTroy0" target="_blank" rel="noopener noreferrer" className="text-muted-light hover:text-accent transition-colors">iTroy0</a>
          {' · '}
          <a href="https://buymeacoffee.com/itroy0" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-muted-light hover:text-accent transition-colors"><Coffee className="w-3 h-3" /> buy me a coffee</a>
        </p>
      </div>
    </footer>
  )
}
