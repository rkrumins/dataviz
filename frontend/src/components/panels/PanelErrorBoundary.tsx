/**
 * Panel-level error boundary.
 *
 * Wraps detail/entity panels so a crash in one panel doesn't bring down
 * the canvas or page. Shows an inline error message with a retry button.
 */
import type { ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { ErrorBoundary } from '@/components/ErrorBoundary'

interface PanelErrorBoundaryProps {
  children: ReactNode
  resetKeys?: unknown[]
}

export function PanelErrorBoundary({ children, resetKeys }: PanelErrorBoundaryProps) {
  return (
    <ErrorBoundary
      resetKeys={resetKeys}
      fallback={(error, reset) => (
        <div className="flex flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <p className="text-sm text-ink-muted">{error.message || 'Panel failed to render'}</p>
          <button
            onClick={reset}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-surface-elevated border border-border text-xs font-medium text-ink hover:bg-surface-hover transition-colors"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  )
}
