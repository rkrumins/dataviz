/**
 * Reusable React error boundary with auto-reset support.
 *
 * Features:
 * - resetKeys: auto-resets when any key value changes (e.g. viewId, workspaceId)
 * - Safety valve: stops auto-resetting after 3 resets in 30s (prevents loops)
 * - Customizable fallback via render prop
 */
import { Component, type ReactNode, type ErrorInfo } from 'react'

const MAX_RESETS = 3
const RESET_WINDOW_MS = 30_000

interface ErrorBoundaryProps {
  children: ReactNode
  /** When any value in this array changes, the boundary auto-resets */
  resetKeys?: unknown[]
  /** Render the error fallback UI */
  fallback: (error: Error, reset: () => void) => ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
  resetTimestamps: number[]
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, resetTimestamps: [] }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary] Caught render error:', error, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (!this.state.error) return
    if (!this.props.resetKeys || !prevProps.resetKeys) return

    const changed = this.props.resetKeys.some(
      (key, i) => key !== prevProps.resetKeys![i]
    )
    if (changed) {
      this.tryReset()
    }
  }

  private tryReset = () => {
    const now = Date.now()
    const recent = this.state.resetTimestamps.filter(t => now - t < RESET_WINDOW_MS)
    if (recent.length >= MAX_RESETS) {
      // Safety valve: too many resets in the window — don't auto-reset
      return
    }
    this.setState({ error: null, resetTimestamps: [...recent, now] })
  }

  reset = () => {
    this.setState({ error: null, resetTimestamps: [] })
  }

  render() {
    if (this.state.error) {
      return this.props.fallback(this.state.error, this.reset)
    }
    return this.props.children
  }
}
