/**
 * View page: /views/:viewId
 *
 * Resolution order:
 * 1. Schema store (local cache — includes API-loaded views AND the default view)
 * 2. Context Model API (for deep-links / shared URLs not yet in the store)
 * 3. 404
 *
 * CanvasRouter is ALWAYS mounted so ReactFlow never loses its state during
 * view navigation. A loading overlay is shown only for genuine API fetches
 * (deep-links not yet in the cache). Cache hits resolve synchronously and
 * never show any loading UI.
 */
import { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { getView, viewToViewConfig } from '@/services/viewApiService'
import { useRecentViews } from '@/hooks/useRecentViews'
import { switchToViewScope, parseDataSourceId } from '@/utils/viewNavigation'

export function ViewPage() {
  const { viewId } = useParams<{ viewId: string }>()
  // fetching = true only while waiting on the API (genuine cache miss)
  const [fetching, setFetching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { setActiveView } = useSchemaStore()
  const { setViewport } = useCanvasStore()
  const { recordVisit } = useRecentViews()

  // The active view read directly from the store — single source of truth
  const activeView = useSchemaStore((s) => s.getActiveView())

  useEffect(() => {
    if (!viewId) return

    setError(null)

    // 1. Check schema store (local cache) — synchronous, no loading state needed
    const localView = useSchemaStore.getState().schema?.views.find(v => v.id === viewId)
    if (localView) {
      // Prefer explicit dataSourceId field; fall back to parsing scopeKey for legacy views
      const localDsId = localView.dataSourceId ?? parseDataSourceId(localView.scopeKey)
      switchToViewScope(localView.workspaceId, localDsId ?? undefined)
      setActiveView(viewId)
      recordVisit({
        viewId: localView.id,
        viewName: localView.name,
        viewType: localView.layout?.type ?? 'graph',
        workspaceId: localView.workspaceId,
        workspaceName: localView.workspaceName,
        dataSourceId: localDsId ?? undefined,
      })
      return
    }

    // 2. Not in local store — fetch from API (deep-link / shared URL)
    const fetchFromApi = async () => {
      setFetching(true)
      try {
        const data = await getView(viewId)

        switchToViewScope(data.workspaceId, data.dataSourceId)

        const viewConfig = viewToViewConfig(data)
        useSchemaStore.getState().addOrUpdateView(viewConfig)
        setActiveView(viewId)
        recordVisit({
          viewId: viewConfig.id,
          viewName: viewConfig.name,
          viewType: viewConfig.layout?.type ?? 'graph',
          workspaceId: viewConfig.workspaceId,
          workspaceName: viewConfig.workspaceName,
          dataSourceId: data.dataSourceId,
        })

        if (data.config?.viewport) {
          setViewport(data.config.viewport)
        }
      } catch {
        setError('View not found')
      } finally {
        setFetching(false)
      }
    }

    fetchFromApi()
  }, [viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <div className="text-6xl text-ink-faint">404</div>
          <h2 className="text-xl font-semibold text-ink-primary">View not found</h2>
          <p className="text-sm text-ink-secondary">
            The view you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          <Link to="/dashboard" className="text-sm text-accent-lineage hover:underline">
            Go to dashboard
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0">
      {/* View name badge — reads from schema store, no split state */}
      {activeView && (
        <div className="absolute top-2 left-2 z-20 glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2 pointer-events-none">
          <span className="text-xs font-medium text-ink-primary">{activeView.name}</span>
          {activeView.isPublic && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">
              shared
            </span>
          )}
        </div>
      )}

      {/* Canvas is ALWAYS mounted — ReactFlow state is never lost on view navigation */}
      <CanvasRouter />

      {/* Non-blocking overlay only for genuine API fetches (deep-links) */}
      {fetching && (
        <div className="absolute inset-0 flex items-center justify-center bg-canvas/60 backdrop-blur-sm z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
            <div className="text-sm text-ink-secondary">Loading view...</div>
          </div>
        </div>
      )}
    </div>
  )
}
