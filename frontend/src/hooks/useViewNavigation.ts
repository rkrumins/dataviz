/**
 * useViewNavigation — Central navigation pipeline for opening a view.
 *
 * Simplified 2-stage pipeline:
 *   1. Resolve view (local cache → API fetch)
 *   2. Activate (set as active, record visit, status → ready)
 *
 * Unlike the previous 5-stage version, this hook does NOT switch the global
 * active workspace. Views are self-scoping data products: they carry their own
 * workspaceId and dataSourceId, and the ViewExecutionProvider in ViewPage
 * creates an isolated execution context (provider + schema) for the view's
 * scope. This eliminates all race conditions that arose from mutating global
 * state (cleanupOnWorkspaceSwitch, provider rebuild, schema reload).
 *
 * The hook exports viewWorkspaceId and viewDataSourceId so ViewPage can
 * parameterize ViewExecutionProvider with the correct scope.
 */
import { useEffect, useRef, useState } from 'react'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useWorkspacesStore } from '@/store/workspaces'
import { useHealthStore } from '@/store/health'
import { useRecentViews } from '@/hooks/useRecentViews'
import { getView, viewToViewConfig, type View } from '@/services/viewApiService'
import type { ViewConfiguration } from '@/types/schema'

// ─── Types ──────────────────────────────────────────────────────────────────

export type ViewNavigationStatus =
  | 'idle'
  | 'resolving'       // Fetching view from API (cache miss / deep link)
  | 'ready'            // View is active, canvas can render
  | 'error'            // View not found or navigation failed

export interface UseViewNavigationResult {
  status: ViewNavigationStatus
  view: ViewConfiguration | null
  /** Layout type resolved from the navigation pipeline.
   *
   * Read directly from the fetched ViewConfiguration — NOT from schema.views —
   * so it remains correct even during scope transitions.
   */
  layoutType: string
  error: string | null
  /** The resolved view's workspace ID — consumed by ViewExecutionProvider. */
  viewWorkspaceId: string | null
  /** The resolved view's data source ID — consumed by ViewExecutionProvider. */
  viewDataSourceId: string | null
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useViewNavigation(viewId: string | undefined): UseViewNavigationResult {
  const [status, setStatus] = useState<ViewNavigationStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const { setActiveView } = useSchemaStore()
  const { setViewport } = useCanvasStore()
  const { recordVisit } = useRecentViews()

  // Active view from the store
  const activeView = useSchemaStore((s) => s.getActiveView())

  // Incrementing counter to force Step 1 to re-run (e.g. after backend recovery)
  const [retryCount, setRetryCount] = useState(0)
  // Track which viewId we've already fully navigated to, to avoid re-running
  const completedViewRef = useRef<string | null>(null)
  // Stores the resolved ViewConfiguration so it can be re-added to the schema
  // store after loadFromBackend clears views during a scope transition.
  const pendingViewConfigRef = useRef<ViewConfiguration | null>(null)
  // Cancellation for API fetches
  const cancelledRef = useRef(false)
  // Ref-tracked status for health recovery subscription (avoids stale closure)
  const statusRef = useRef<ViewNavigationStatus>(status)
  statusRef.current = status

  // ─── Step 1: Resolve view & activate ──────────────────────────────────

  useEffect(() => {
    if (!viewId) {
      setStatus('idle')
      return
    }

    // Already navigated to this view — skip
    if (completedViewRef.current === viewId) return

    cancelledRef.current = false
    setError(null)

    const resolveView = async () => {
      // 1a. Check local cache first (synchronous)
      const localView = useSchemaStore.getState().schema?.views.find(v => v.id === viewId)

      let viewConfig: ViewConfiguration | undefined
      let targetWsId: string | undefined
      let targetDsId: string | undefined

      if (localView) {
        viewConfig = localView
        targetWsId = localView.workspaceId
        targetDsId = localView.dataSourceId ?? undefined
        pendingViewConfigRef.current = viewConfig
      } else {
        // 1b. Fetch from API (deep link / shared URL)
        setStatus('resolving')
        try {
          const data: View = await getView(viewId)
          if (cancelledRef.current) return

          targetWsId = data.workspaceId
          targetDsId = data.dataSourceId
          viewConfig = viewToViewConfig(data)
          pendingViewConfigRef.current = viewConfig

          // Add to schema store for future cache hits
          useSchemaStore.getState().addOrUpdateView(viewConfig)

          // Restore viewport if the view stored one
          if (data.config?.viewport) {
            setViewport(data.config.viewport)
          }
        } catch (err) {
          if (!cancelledRef.current) {
            completedViewRef.current = viewId  // Prevent retry loop
            setStatus('error')
            setError(
              err instanceof Error && err.message.includes('500')
                ? 'The backend returned an error loading this view. Please try again later.'
                : 'View not found',
            )
          }
          return
        }
      }

      if (cancelledRef.current) return

      // 2. Validate workspace exists
      if (targetWsId) {
        const wsExists = useWorkspacesStore.getState().workspaces.some(w => w.id === targetWsId)
        if (!wsExists) {
          setStatus('error')
          setError('The workspace for this view no longer exists.')
          return
        }
      }

      // 3. Activate the view immediately — no scope switching needed.
      // Provider and schema loading are handled by ViewExecutionProvider
      // in the render tree.
      activateView(viewId, viewConfig, targetDsId)
    }

    resolveView()

    return () => {
      cancelledRef.current = true
    }
  }, [viewId, retryCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── View activation helper ───────────────────────────────────────────

  function activateView(
    id: string,
    viewConfig: ViewConfiguration | undefined,
    dsId: string | undefined,
  ) {
    if (completedViewRef.current === id) return

    // Re-insert the view config if loadFromBackend cleared schema.views
    // during a scope transition triggered by the ViewExecutionProvider's
    // schema fetch.
    const pending = pendingViewConfigRef.current
    if (pending && pending.id === id) {
      useSchemaStore.getState().addOrUpdateView(pending)
    }

    setActiveView(id)
    completedViewRef.current = id
    setStatus('ready')

    if (viewConfig) {
      const ds = dsId
        ? useWorkspacesStore.getState().workspaces
            .flatMap(w => w.dataSources ?? [])
            .find(d => d.id === dsId)
        : undefined
      recordVisit({
        viewId: viewConfig.id,
        viewName: viewConfig.name,
        viewType: viewConfig.layout?.type ?? 'graph',
        workspaceId: viewConfig.workspaceId,
        workspaceName: viewConfig.workspaceName,
        dataSourceId: dsId,
        dataSourceName: ds?.label || ds?.catalogItemId || undefined,
      })
    }
  }

  // ─── Handle rapid navigation (viewId changes while in progress) ────────

  useEffect(() => {
    completedViewRef.current = null
    pendingViewConfigRef.current = null
  }, [viewId])

  // ─── Auto-retry on backend recovery ────────────────────────────────────

  useEffect(() => {
    const unsubscribe = useHealthStore.subscribe((state, prev) => {
      const wasDown = prev.status === 'unreachable'
      const isBack = state.status === 'recovered' || (state.status === 'healthy' && wasDown)
      if (!isBack) return
      if (statusRef.current !== 'error') return

      completedViewRef.current = null
      setError(null)
      setRetryCount(c => c + 1)
    })
    return unsubscribe
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Derive layoutType from the resolved view config (not from the schema store).
  const layoutType =
    pendingViewConfigRef.current?.layout?.type ??
    activeView?.layout?.type ??
    'graph'

  // Derive scope from the resolved view config
  const viewWorkspaceId = pendingViewConfigRef.current?.workspaceId ?? activeView?.workspaceId ?? null
  const viewDataSourceId = pendingViewConfigRef.current?.dataSourceId ?? activeView?.dataSourceId ?? null

  return {
    status,
    view: activeView ?? null,
    layoutType,
    error,
    viewWorkspaceId,
    viewDataSourceId,
  }
}
