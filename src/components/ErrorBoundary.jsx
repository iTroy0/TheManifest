import { Component } from 'react'
import { RefreshCw, AlertTriangle, RotateCcw, X } from 'lucide-react'

/**
 * Main app-level error boundary
 */
export default class ErrorBoundary extends Component {
  state = { hasError: false, error: null }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, errorInfo) {
    // Log error for debugging
    console.error('[ErrorBoundary] Caught error:', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-bg flex items-center justify-center px-6">
          <div className="text-center space-y-4 max-w-sm">
            <div className="w-16 h-16 rounded-2xl bg-danger/10 flex items-center justify-center mx-auto ring-4 ring-danger/5">
              <AlertTriangle className="w-8 h-8 text-danger" />
            </div>
            <p className="font-mono text-lg text-text font-medium">Something went wrong</p>
            <p className="text-sm text-muted leading-relaxed">
              The app encountered an unexpected error. Refreshing the page should fix it.
            </p>
            <button
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl font-mono text-sm
                bg-accent text-bg font-medium hover:bg-accent-dim active:scale-[0.98] transition-all"
            >
              <RefreshCw className="w-4 h-4" />
              Refresh Page
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

/**
 * Component-level error boundary for graceful degradation
 * Usage: <ComponentErrorBoundary name="FileList"><FileList /></ComponentErrorBoundary>
 */
export class ComponentErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    console.error(`[ComponentErrorBoundary:${this.props.name || 'unknown'}]`, error, errorInfo)
  }

  handleRetry = () => {
    this.setState({ hasError: false })
  }

  render() {
    const { name = 'Component', fallback, children, className = '' } = this.props

    if (this.state.hasError) {
      // Use custom fallback if provided
      if (fallback) return fallback

      // Default fallback UI
      return (
        <div className={`bg-surface border border-border rounded-xl p-4 ${className}`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-danger/10 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4 h-4 text-danger" />
              </div>
              <div>
                <p className="font-mono text-xs text-text">{name} failed to load</p>
                <p className="text-[10px] text-muted">An error occurred in this component</p>
              </div>
            </div>
            <button
              onClick={this.handleRetry}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-mono text-xs
                bg-accent/10 text-accent hover:bg-accent/20 active:scale-95 transition-all"
            >
              <RotateCcw className="w-3 h-3" />
              Retry
            </button>
          </div>
        </div>
      )
    }

    return children
  }
}

/**
 * Inline error boundary for critical but small components
 * Shows a minimal error indicator that doesn't disrupt layout
 */
export class InlineErrorBoundary extends Component {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error, errorInfo) {
    console.error(`[InlineErrorBoundary]`, error, errorInfo)
  }

  handleDismiss = () => {
    this.setState({ hasError: false })
  }

  render() {
    const { children, showDismiss = true } = this.props

    if (this.state.hasError) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded bg-danger/10 text-danger font-mono text-xs">
          <AlertTriangle className="w-3 h-3" />
          Error
          {showDismiss && (
            <button onClick={this.handleDismiss} className="ml-1 hover:text-danger/70">
              <X className="w-3 h-3" />
            </button>
          )}
        </span>
      )
    }

    return children
  }
}
