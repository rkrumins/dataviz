/**
 * View page: /views/:viewId
 *
 * Uses the simplified useViewNavigation() hook to resolve the view, then
 * wraps the canvas in a ViewExecutionProvider that creates an isolated
 * execution context (provider + schema) scoped to the view's workspace
 * and data source. No global workspace mutation occurs.
 */
import { useMemo } from 'react'
import { useParams, Link } from 'react-router-dom'
import { Loader2, AlertTriangle } from 'lucide-react'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { UnsavedWorkGuard } from '@/components/canvas/UnsavedWorkGuard'
import { useViewNavigation } from '@/hooks/useViewNavigation'
import { ViewPageHeader } from '@/components/views/ViewPageHeader'
import { useWorkspacesStore } from '@/store/workspaces'
import { ViewExecutionProvider } from '@/providers/ViewExecutionContext'
import { useDocumentTitle } from '@/lib/useDocumentTitle'

export function ViewPage() {
  const { viewId } = useParams<{ viewId: string }>()
  const {
    status, view, layoutType, error,
    viewWorkspaceId, viewDataSourceId,
    viewWorkspaceName, viewProviderId, access,
  } = useViewNavigation(viewId)
  const workspaces = useWorkspacesStore(s => s.workspaces)

  // Tab title: "{View} · {Workspace} · {Brand}". The API response names the
  // workspace even for non-members; the store lookup is only a fallback for
  // locally-created views.
  const wsName =
    viewWorkspaceName
    ?? view?.workspaceName
    ?? workspaces.find(w => w.id === view?.workspaceId)?.name
  useDocumentTitle(
    status === 'ready' && view
      ? (wsName ? `${view.name} · ${wsName}` : view.name)
      : 'View',
  )

  // Lightweight health check for the active view. Membership-scoped on
  // purpose: the workspace store only lists workspaces the caller belongs
  // to, so for a shared/enterprise view its absence proves nothing — the
  // server already vouched for the view by returning it.
  const healthWarning = useMemo(() => {
    if (!view || status !== 'ready') return null
    const ws = workspaces.find(w => w.id === view.workspaceId)
    if (!ws) return null
    if (view.dataSourceId) {
      const ds = ws.dataSources?.find(d => d.id === view.dataSourceId)
      if (!ds) return 'The data source for this view has been deleted.'
    }
    return null
  }, [view, status, workspaces])

  // ─── Error state ────────────────────────────────────────────────────
  if (status === 'error') {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-4 max-w-md text-center px-6">
          <div className="w-14 h-14 rounded-2xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 flex items-center justify-center">
            <AlertTriangle className="w-7 h-7 text-red-500" />
          </div>
          <h2 className="text-xl font-bold text-ink">View Cannot Load</h2>
          <p className="text-sm text-ink-muted leading-relaxed">
            {error ?? "The view you're looking for doesn't exist or you don't have access to it."}
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
    )
  }

  // ─── Ready state — render canvas in a view-scoped execution context ──
  return (
    <div className="absolute inset-0 flex flex-col">
      {/* The view had no identity on screen — its name lived only in the tab
          title — and neither Details nor Activity was reachable from the canvas,
          which is where people actually work. */}
      {status === 'ready' && view?.id && (
        <ViewPageHeader viewId={view.id} workspaceName={wsName} />
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

      {/* Canvas wrapped in view-scoped execution context.
          ViewExecutionProvider creates an isolated provider + schema for the
          view's workspace/datasource. All downstream hooks (useGraphProvider,
          useGraphHydration, useViewEntityTypes, etc.) receive view-scoped data.
          No global workspace mutation occurs. */}
      {status === 'ready' && viewWorkspaceId && (
        <div className="relative flex-1 min-h-0">
          <ViewExecutionProvider
            workspaceId={viewWorkspaceId}
            dataSourceId={viewDataSourceId}
            viewId={view?.id ?? null}
            providerId={viewProviderId}
            access={access}
          >
            <CanvasRouter layoutType={layoutType} />
            <UnsavedWorkGuard />
          </ViewExecutionProvider>
        </div>
      )}

      {/* Loading overlay */}
      {status === 'resolving' && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/60 backdrop-blur-sm z-10">
          <div className="flex flex-col items-center gap-3">
            <Loader2 className="w-8 h-8 animate-spin text-accent-lineage" />
            <div className="text-sm text-ink-secondary">Loading view...</div>
          </div>
        </div>
      )}
    </div>
  )
}
