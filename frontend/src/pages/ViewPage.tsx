/**
 * Deep-link page: /views/:viewId
 * Loads a specific view by ID from the API first, then falls back
 * to the local schema store for views not yet persisted to the backend.
 */
import { useEffect, useState, useRef } from 'react'
import { useParams } from 'react-router-dom'
import { CanvasRouter } from '@/components/canvas/CanvasRouter'
import { useWorkspacesStore } from '@/store/workspaces'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { viewsApi, type ViewApiResponse } from '@/services/viewsApiService'

export function ViewPage() {
  const { viewId } = useParams<{ viewId: string }>()
  const [view, setView] = useState<ViewApiResponse | null>(null)
  const [localView, setLocalView] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const appliedRef = useRef<string | null>(null)

  const { activeWorkspaceId, setActiveWorkspace } = useWorkspacesStore()
  const { setActiveView, schema } = useSchemaStore()
  const { setViewport } = useCanvasStore()

  // Fetch view data — try API first, fall back to schema store
  useEffect(() => {
    if (!viewId) return

    const fetchView = async () => {
      setLoading(true)
      setError(null)
      setLocalView(false)

      try {
        const data = await viewsApi.get(viewId)
        setView(data)

        // Set the correct workspace if different from active
        if (data.workspaceId && data.workspaceId !== activeWorkspaceId) {
          setActiveWorkspace(data.workspaceId)
        }
      } catch {
        // API failed — fall back to local schema store
        const schemaView = schema?.views.find(v => v.id === viewId)
        if (schemaView) {
          // Found in local store — activate it directly
          setActiveView(viewId)
          setLocalView(true)
          setView({
            id: schemaView.id,
            name: schemaView.name,
            description: schemaView.description,
            viewType: schemaView.layout?.type ?? 'graph',
            config: {
              content: schemaView.content,
              layout: schemaView.layout,
              filters: schemaView.filters,
              entityOverrides: schemaView.entityOverrides,
              icon: schemaView.icon,
            },
            visibility: schemaView.isPublic ? 'enterprise' : 'private',
            isPinned: false,
            favouriteCount: 0,
            isFavourited: false,
            createdAt: schemaView.createdAt ?? new Date().toISOString(),
            updatedAt: schemaView.updatedAt ?? new Date().toISOString(),
          })
        } else {
          setError('View not found')
        }
      } finally {
        setLoading(false)
      }
    }

    fetchView()
  }, [viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Apply view config to canvas once loaded (only once per view)
  useEffect(() => {
    if (!view || appliedRef.current === view.id) return
    appliedRef.current = view.id

    // Apply view config to stores
    if (view.config) {
      const config = view.config as Record<string, any>

      // Apply viewport if present
      if (config.viewport) {
        setViewport(config.viewport)
      }

      // Set as the active view in schema store (unless already set for local view)
      if (!localView) {
        setActiveView(view.id)
      }
    }
  }, [view, localView, setActiveView, setViewport])

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
      {view && (
        <div className="absolute top-2 left-2 z-20 glass-panel-subtle rounded-lg px-3 py-1.5 flex items-center gap-2">
          <span className="text-xs font-medium text-ink-primary">{view.name}</span>
          {view.workspaceName && (
            <>
              <span className="text-ink-faint">/</span>
              <span className="text-xs text-ink-secondary">{view.workspaceName}</span>
            </>
          )}
          {view.visibility !== 'private' && (
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${
              view.visibility === 'enterprise'
                ? 'bg-green-500/20 text-green-400'
                : 'bg-blue-500/20 text-blue-400'
            }`}>
              {view.visibility}
            </span>
          )}
        </div>
      )}
      <CanvasRouter />
    </div>
  )
}
