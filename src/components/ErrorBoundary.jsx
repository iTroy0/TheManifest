import { Component } from 'react'
import { RefreshCw } from 'lucide-react'

export default class ErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-bg flex items-center justify-center px-6">
          <div className="text-center space-y-4 max-w-sm">
            <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto">
              <span className="text-3xl">!</span>
            </div>
            <p className="font-mono text-sm text-text">Something went wrong.</p>
            <p className="text-xs text-muted leading-relaxed">
              The app encountered an unexpected error. Refreshing the page should fix it.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
                bg-surface border border-border text-text hover:border-accent/40 hover:text-accent transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
