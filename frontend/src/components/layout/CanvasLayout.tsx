/**
 * CanvasLayout — Layout wrapper for routes that need the graph schema.
 *
 * Wraps /views/:viewId, /schema, and /explorer so that:
 *   - useGraphSchema() (fetches /metadata/schema) only fires when the user
 *     navigates to a canvas-bearing route, not on /dashboard or /admin.
 *   - A loading gate prevents CanvasRouter from mounting before the ontology
 *     is available, avoiding a spurious empty-state flash.
 *
 * Gates on BOTH isLoading (first fetch) AND isFetching (refetches triggered
 * by workspace/datasource switches) to prevent stale data from rendering.
 *
 * AppLayout handles auth, sidebar, topbar, and the view list (lightweight).
 * This component handles the heavier ontology fetch.
 */

import { Outlet } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useGraphSchema } from '@/hooks/useGraphSchema'

export function CanvasLayout() {
  const { isLoading, isFetching, isError, error, refetch } = useGraphSchema()

  if (isLoading) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-6 h-6 animate-spin text-accent-lineage" />
          <span className="text-sm text-ink-muted">Loading schema…</span>
        </div>
      </div>
    )
  }

  if (isError) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
          <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
            <Loader2 className="w-6 h-6 text-red-500" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-ink mb-1">Provider Unavailable</h3>
            <p className="text-sm text-ink-muted">
              {error instanceof Error ? error.message : 'Could not connect to the graph provider. The service may be temporarily unavailable.'}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-accent-lineage text-white hover:bg-accent-lineage/90 transition-colors"
          >
            Retry
          </button>
        </div>
      </div>
    )
  }

  return (
    <>
      <Outlet />
      {/* Subtle overlay during schema refetches (workspace/datasource switch) */}
      {isFetching && !isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/40 backdrop-blur-[2px] z-30 pointer-events-none">
          <div className="flex flex-col items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-accent-lineage" />
            <span className="text-xs text-ink-muted">Switching context…</span>
          </div>
        </div>
      )}
    </>
  )
}
