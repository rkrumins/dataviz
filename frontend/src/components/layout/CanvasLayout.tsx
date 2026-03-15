/**
 * CanvasLayout — Layout wrapper for routes that need the graph schema.
 *
 * Wraps /views/:viewId, /schema, and /explorer so that:
 *   - useGraphSchema() (fetches /metadata/schema) only fires when the user
 *     navigates to a canvas-bearing route, not on /dashboard or /admin.
 *   - A loading gate prevents CanvasRouter from mounting before the ontology
 *     is available, avoiding a spurious empty-state flash.
 *
 * AppLayout handles auth, sidebar, topbar, and the view list (lightweight).
 * This component handles the heavier ontology fetch.
 */

import { Outlet } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useGraphSchema } from '@/hooks/useGraphSchema'

export function CanvasLayout() {
  const { isLoading } = useGraphSchema()

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

  return <Outlet />
}
