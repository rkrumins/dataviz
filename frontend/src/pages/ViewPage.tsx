/**
 * View page: /views/:viewId
 *
 * Uses the central useViewNavigation() hook to orchestrate the full
 * navigation pipeline:
 *   resolve view → switch scope → wait for provider → wait for schema → activate
 *
 * CanvasRouter is ALWAYS mounted once the view is ready so ReactFlow
 * never loses state during view navigation.
 */
import { useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, AlertTriangle } from 'lucide-react'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { useViewNavigation } from '@/hooks/useViewNavigation'
import { useWorkspacesStore } from '@/store/workspaces'

export function ViewPage() {
  const { viewId } = useParams<{ viewId: string }>()
  const { status, view, error } = useViewNavigation(viewId)
  const workspaces = useWorkspacesStore(s => s.workspaces)

  // Lightweight health check for the active view
  const healthWarning = useMemo(() => {
    if (!view || status !== 'ready') return null
    const ws = workspaces.find(w => w.id === view.workspaceId)
    if (!ws) return 'The workspace for this view no longer exists.'
    if (view.dataSourceId) {
      const ds = ws.dataSources?.find(d => d.id === view.dataSourceId)
      if (!ds) return 'The data source for this view has been deleted.'
    }
    return null
  }, [view, status, workspaces])

  // ─── Error state ────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <div className="text-6xl text-ink-faint">404</div>
          <h2 className="text-xl font-semibold text-ink-primary">View not found</h2>
          <p className="text-sm text-ink-secondary">
            {error ?? "The view you're looking for doesn't exist or you don't have access to it."}
          </p>
          <Link to="/explorer" className="text-sm text-accent-lineage hover:underline">
            Back to Explorer
          </Link>
        </div>
      </div>
    )
  }

  // ─── Ready state — render canvas ────────────────────────────────────
  return (
    <div className="absolute inset-0">
      {/* View name badge */}
      {view && status === 'ready' && (
        <div className="absolute top-2 left-2 z-20 glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 pointer-events-none">
          <span className="text-xs font-medium text-ink-primary">{view.name}</span>
          {view.isPublic && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">
              shared
            </span>
          )}
        </div>
      )}

      {/* Health warning overlay for broken views */}
      {status === 'ready' && healthWarning && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 backdrop-blur-sm z-30">
          <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
            <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center">
              <AlertTriangle className="w-7 h-7 text-red-500" />
            </div>
            <h2 className="text-xl font-bold text-ink">View Cannot Load</h2>
            <p className="text-sm text-ink-muted leading-relaxed">
              {healthWarning} This view may not display correctly.
            </p>
            <div className="flex items-center gap-3 mt-2">
              <Link
                to="/explorer"
                className="inline-flex items-center gap-2 rounded-xl px-5 py-2.5 bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold shadow-lg shadow-accent-lineage/25 hover:shadow-xl hover:-translate-y-0.5 transition-[transform,box-shadow] duration-200"
              >
                Back to Explorer
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Canvas is mounted once we reach 'ready' status */}
      {status === 'ready' && <CanvasRouter />}

      {/* Loading overlays for in-progress states */}
      {(status === 'resolving' || status === 'scope-switching' || status === 'loading-schema') && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/60 backdrop-blur-sm z-10">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
            <div className="text-sm text-ink-secondary">
              {status === 'resolving' && 'Loading view...'}
              {status === 'scope-switching' && 'Switching workspace...'}
              {status === 'loading-schema' && 'Loading schema...'}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
