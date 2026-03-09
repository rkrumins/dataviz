/**
 * View page: /views/:viewId
 *
 * Resolution order:
 * 1. Schema store (local cache — includes API-loaded views AND the default view)
 * 2. Context Model API (for deep-links / shared URLs not yet in the store)
 * 3. 404
 *
 * This ensures local-only views (e.g. the auto-generated default) and
 * API-backed views (cm_ IDs) both work seamlessly.
 */
import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { useWorkspacesStore } from '@/store/workspaces'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { getView, contextModelToViewConfig } from '@/services/contextModelService'
import type { ViewConfiguration } from '@/types/schema'

export function ViewPage() {
  const { viewId } = useParams<{ viewId: string }>()
  const [resolvedView, setResolvedView] = useState<ViewConfiguration | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const appliedRef = useRef<string | null>(null)

  const { activeWorkspaceId, setActiveWorkspace } = useWorkspacesStore()
  const { setActiveView } = useSchemaStore()
  const { setViewport } = useCanvasStore()

  // Resolve the view: schema store first, then API
  useEffect(() => {
    if (!viewId) return

    // Reset state on view change
    setLoading(true)
    setError(null)
    appliedRef.current = null

    // 1. Check schema store (local cache)
    const localView = useSchemaStore.getState().schema?.views.find(v => v.id === viewId)
    if (localView) {
      setResolvedView(localView)
      setActiveView(viewId)
      setLoading(false)
      return
    }

    // 2. Not in local store — fetch from API (deep-link / shared URL)
    const fetchFromApi = async () => {
      try {
        const data = await getView(viewId)

        // Switch workspace if needed
        if (data.workspaceId && data.workspaceId !== activeWorkspaceId) {
          setActiveWorkspace(data.workspaceId)
        }

        // Convert and add to schema store cache
        const viewConfig = contextModelToViewConfig(data)
        useSchemaStore.getState().addOrUpdateView(viewConfig)
        setActiveView(viewId)
        setResolvedView(viewConfig)

        // Apply viewport if present
        if (data.config?.viewport) {
          setViewport(data.config.viewport)
        }
      } catch {
        setError('View not found')
      } finally {
        setLoading(false)
      }
    }

    fetchFromApi()
  }, [viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-2 border-accent-lineage border-t-transparent rounded-full animate-spin" />
          <div className="text-sm text-ink-secondary">Loading view...</div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-canvas">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <div className="text-6xl text-ink-faint">404</div>
          <h2 className="text-xl font-semibold text-ink-primary">View not found</h2>
          <p className="text-sm text-ink-secondary">
            The view you&apos;re looking for doesn&apos;t exist or you don&apos;t have access to it.
          </p>
          <a href="/dashboard" className="text-sm text-accent-lineage hover:underline">
            Go to dashboard
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0">
      {resolvedView && (
        <div className="absolute top-2 left-2 z-20 glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-xs font-medium text-ink-primary">{resolvedView.name}</span>
          {resolvedView.isPublic && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">
              shared
            </span>
          )}
        </div>
      )}
      <CanvasRouter />
    </div>
  )
}
