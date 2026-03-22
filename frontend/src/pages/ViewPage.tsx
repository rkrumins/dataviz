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
import { useParams, Link } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { useViewNavigation } from '@/hooks/useViewNavigation'

export function ViewPage() {
  const { viewId } = useParams<{ viewId: string }>()
  const { status, view, error } = useViewNavigation(viewId)

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
