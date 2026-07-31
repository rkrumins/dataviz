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
import { useQueryClient } from '@tanstack/react-query'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useWorkspacesStore } from '@/store/workspaces'
import { useHealthStore } from '@/store/health'
import { useRecentViews } from '@/hooks/useRecentViews'
import { VIEW_QUERY_KEY } from '@/hooks/useViewMetadata'
import { getView, viewToViewConfig, type View, type ViewAccess } from '@/services/viewApiService'
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
  /** The resolved view's data source ID — consumed by ViewExecutionProvider.
   *  Server-resolved (workspace primary when the view stores NULL), so it is
   *  correct even for callers with no workspace membership. */
  viewDataSourceId: string | null
  /** Display name of the view's workspace, from the API response — present
   *  even when the caller is not a member (the workspace list can't say). */
  viewWorkspaceName: string | null
  /** Display name of the view's (resolved) data source, from the API. */
  viewDataSourceName: string | null
  /** Provider behind the view's resolved source — boots the canvas without
   *  the (membership-gated) workspace list. */
  viewProviderId: string | null
  /** The caller's capability envelope; null until the API response lands. */
  access: ViewAccess | null
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useViewNavigation(viewId: string | undefined): UseViewNavigationResult {
  const [status, setStatus] = useState<ViewNavigationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  // The raw API response — carries the access envelope + enriched names
  // that the (RBAC-scoped) workspace store cannot supply for non-members.
  const [apiView, setApiView] = useState<View | null>(null)
  const queryClient = useQueryClient()

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

    // One GET per view open: the shared ['view', viewId] React Query entry
    // also feeds ViewPageHeader, useViewAccess, and the Share dialog.
    const fetchApiView = () =>
      queryClient.ensureQueryData<View>({
        queryKey: [...VIEW_QUERY_KEY, viewId],
        queryFn: () => getView(viewId, undefined, { silent403: true }),
        staleTime: 60 * 1000,
      })

    const resolveView = async () => {
      // 1a. Check local cache first (synchronous)
      const localView = useSchemaStore.getState().schema?.views.find(v => v.id === viewId)

      let viewConfig: ViewConfiguration | undefined
      let targetDsId: string | undefined
      let apiData: View | undefined

      if (localView) {
        viewConfig = localView
        targetDsId = localView.dataSourceId ?? undefined
        pendingViewConfigRef.current = viewConfig
        // The store copy lacks the access envelope + enriched names —
        // fetch them in the background without blocking activation.
        fetchApiView()
          .then(data => { if (!cancelledRef.current) setApiView(data) })
          .catch(() => { /* envelope is an enhancement on this path */ })
      } else {
        // 1b. Fetch from API (deep link / shared URL)
        setStatus('resolving')
        try {
          const data: View = await fetchApiView()
          if (cancelledRef.current) return

          apiData = data
          setApiView(data)
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
            // The backend answers 404 for both "doesn't exist" and "not
            // shared with you" (existence-hiding), so the copy covers both
            // honestly instead of the old flat "View not found".
            setError(
              err instanceof Error && err.message.includes('500')
                ? 'The backend returned an error loading this view. Please try again later.'
                : "This view doesn't exist or hasn't been shared with you. Ask its owner for access.",
            )
          }
          return
        }
      }

      if (cancelledRef.current) return

      // 2. Activate the view immediately — no scope switching, and no
      // workspace-store existence check: that list is RBAC-scoped to the
      // caller's memberships, so for a shared/enterprise view it said
      // "the workspace no longer exists" to exactly the people the view
      // was shared with. The server already vouched for the view.
      activateView(viewId, viewConfig, targetDsId, apiData)
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
    apiData?: View,
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
      // Names come from the API response when we have it (works for
      // non-members); the workspace-store lookup is only the fallback
      // for the store-hit path.
      const ds = !apiData && dsId
        ? useWorkspacesStore.getState().workspaces
            .flatMap(w => w.dataSources ?? [])
            .find(d => d.id === dsId)
        : undefined
      recordVisit({
        viewId: viewConfig.id,
        viewName: viewConfig.name,
        viewType: viewConfig.layout?.type ?? 'graph',
        icon: viewConfig.icon,
        workspaceId: viewConfig.workspaceId,
        workspaceName: apiData?.workspaceName ?? viewConfig.workspaceName,
        dataSourceId: apiData?.dataSourceId ?? dsId,
        dataSourceName: apiData?.dataSourceName ?? ds?.label ?? ds?.catalogItemId ?? undefined,
      })
    }
  }

  // ─── Handle rapid navigation (viewId changes while in progress) ────────

  useEffect(() => {
    completedViewRef.current = null
    pendingViewConfigRef.current = null
    setApiView(null)
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

  // Derive scope from the resolved view config. The API response wins for
  // the data source: the server resolves NULL to the workspace primary,
  // which a non-member could never look up locally.
  const viewWorkspaceId = pendingViewConfigRef.current?.workspaceId ?? activeView?.workspaceId ?? null
  const viewDataSourceId =
    apiView?.dataSourceId
    ?? pendingViewConfigRef.current?.dataSourceId
    ?? activeView?.dataSourceId
    ?? null

  return {
    status,
    view: activeView ?? null,
    layoutType,
    error,
    viewWorkspaceId,
    viewDataSourceId,
    viewWorkspaceName: apiView?.workspaceName ?? null,
    viewDataSourceName: apiView?.dataSourceName ?? null,
    viewProviderId: apiView?.providerId ?? null,
    access: apiView?.access ?? null,
  }
}
