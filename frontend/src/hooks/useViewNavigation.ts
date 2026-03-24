/**
 * useViewNavigation — Central navigation pipeline for opening a view.
 *
 * Orchestrates the full sequence:
 *   1. Resolve view (local cache → API fetch)
 *   2. Switch workspace/datasource scope if needed
 *   3. Wait for provider to rebuild (if scope changed)
 *   4. Wait for schema to reload (if provider changed)
 *   5. Activate the view in the schema store
 *
 * This replaces the ad-hoc navigation logic that was previously inlined in
 * ViewPage.tsx, which suffered from race conditions between scope switching
 * and view activation.
 */
import { useEffect, useRef, useState } from 'react'
import { useSchemaStore } from '@/store/schema'
import { useCanvasStore } from '@/store/canvas'
import { useWorkspacesStore } from '@/store/workspaces'
import { useHealthStore } from '@/store/health'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useGraphSchema } from '@/hooks/useGraphSchema'
import { useRecentViews } from '@/hooks/useRecentViews'
import { getView, viewToViewConfig, type View } from '@/services/viewApiService'
import { switchToViewScope, parseDataSourceId, type ScopeSwitchResult } from '@/utils/viewNavigation'
import type { ViewConfiguration } from '@/types/schema'

const LOADING_SCHEMA_TIMEOUT_MS = 8_000

// ─── Types ──────────────────────────────────────────────────────────────────

export type ViewNavigationStatus =
  | 'idle'
  | 'resolving'       // Fetching view from API (cache miss / deep link)
  | 'scope-switching'  // Workspace or datasource is changing
  | 'loading-schema'   // Waiting for schema to reload after scope switch
  | 'ready'            // View is active, canvas can hydrate
  | 'error'            // View not found or navigation failed

export interface UseViewNavigationResult {
  status: ViewNavigationStatus
  view: ViewConfiguration | null
  error: string | null
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export function useViewNavigation(viewId: string | undefined): UseViewNavigationResult {
  const [status, setStatus] = useState<ViewNavigationStatus>('idle')
  const [error, setError] = useState<string | null>(null)

  const { setActiveView } = useSchemaStore()
  const { setViewport } = useCanvasStore()
  const { recordVisit } = useRecentViews()

  // Provider context — used to detect when provider is ready after scope switch
  const { providerVersion } = useGraphProviderContext()

  // Schema readiness — used to wait for schema reload after provider change
  const { isLoading: schemaIsLoading, isFetching: schemaIsFetching } = useGraphSchema()

  // Active view from the store
  const activeView = useSchemaStore((s) => s.getActiveView())

  // Incrementing counter to force Step 1 to re-run (e.g. after backend recovery)
  const [retryCount, setRetryCount] = useState(0)
  // Track which viewId we've already fully navigated to, to avoid re-running
  const completedViewRef = useRef<string | null>(null)
  // Track the scope switch result to know if we need to wait
  const pendingSwitchRef = useRef<ScopeSwitchResult | null>(null)
  // Track the provider version at the time of scope switch
  const switchProviderVersionRef = useRef<number>(providerVersion)
  // Cancellation for API fetches
  const cancelledRef = useRef(false)
  // Ref-tracked status for health recovery subscription (avoids stale closure)
  const statusRef = useRef<ViewNavigationStatus>(status)
  statusRef.current = status

  // ─── Step 1: Resolve view & switch scope ──────────────────────────────

  useEffect(() => {
    if (!viewId) {
      setStatus('idle')
      return
    }

    // Already navigated to this view — skip
    if (completedViewRef.current === viewId) return

    cancelledRef.current = false
    setError(null)
    pendingSwitchRef.current = null

    const resolveView = async () => {
      // 1a. Check local cache first (synchronous)
      const localView = useSchemaStore.getState().schema?.views.find(v => v.id === viewId)

      let targetWsId: string | undefined
      let targetDsId: string | undefined
      let viewConfig: ViewConfiguration | undefined

      if (localView) {
        targetWsId = localView.workspaceId
        targetDsId = localView.dataSourceId ?? parseDataSourceId(localView.scopeKey) ?? undefined
        viewConfig = localView
      } else {
        // 1b. Fetch from API (deep link / shared URL)
        setStatus('resolving')
        try {
          const data: View = await getView(viewId)
          if (cancelledRef.current) return

          targetWsId = data.workspaceId
          targetDsId = data.dataSourceId
          viewConfig = viewToViewConfig(data)

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

      // 2. Validate workspace exists before switching scope
      if (targetWsId) {
        const wsExists = useWorkspacesStore.getState().workspaces.some(w => w.id === targetWsId)
        if (!wsExists) {
          setStatus('error')
          setError('The workspace for this view no longer exists.')
          return
        }
      }

      // 3. Switch scope if needed
      const switchResult = switchToViewScope(targetWsId, targetDsId)
      pendingSwitchRef.current = switchResult
      switchProviderVersionRef.current = providerVersion

      if (switchResult.workspaceChanged || switchResult.dataSourceChanged) {
        // Scope changed — we need to wait for provider rebuild + schema reload
        setStatus('scope-switching')
      } else {
        // No scope change — activate immediately
        setActiveView(viewId)
        completedViewRef.current = viewId
        setStatus('ready')

        if (viewConfig) {
          const ds = targetDsId
            ? useWorkspacesStore.getState().workspaces
                .flatMap(w => w.dataSources ?? [])
                .find(d => d.id === targetDsId)
            : undefined
          recordVisit({
            viewId: viewConfig.id,
            viewName: viewConfig.name,
            viewType: viewConfig.layout?.type ?? 'graph',
            workspaceId: viewConfig.workspaceId,
            workspaceName: viewConfig.workspaceName,
            dataSourceId: targetDsId,
            dataSourceName: ds?.label || ds?.catalogItemId || undefined,
          })
        }
      }
    }

    resolveView()

    return () => {
      cancelledRef.current = true
    }
  }, [viewId, retryCount]) // eslint-disable-line react-hooks/exhaustive-deps

  // ─── Step 2: Wait for provider rebuild after scope switch ─────────────

  useEffect(() => {
    if (status !== 'scope-switching') return
    if (!pendingSwitchRef.current) return

    // Provider has rebuilt if its version has incremented since we started the switch
    if (providerVersion > switchProviderVersionRef.current) {
      setStatus('loading-schema')
    }
  }, [status, providerVersion])

  // ─── Step 3: Wait for schema to finish loading after provider change ──

  useEffect(() => {
    if (status !== 'loading-schema') return
    if (schemaIsLoading || schemaIsFetching) return

    // Schema settled (success or error with fallback) — activate view
    activateView()
  }, [status, schemaIsLoading, schemaIsFetching, viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Safety timeout: if stuck in loading-schema for too long, proceed anyway
  // (default schema is already loaded by useGraphSchema fallback)
  useEffect(() => {
    if (status !== 'loading-schema') return
    const timer = setTimeout(() => activateView(), LOADING_SCHEMA_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [status, viewId]) // eslint-disable-line react-hooks/exhaustive-deps

  function activateView() {
    if (!viewId || completedViewRef.current === viewId) return
    setActiveView(viewId)
    completedViewRef.current = viewId
    setStatus('ready')

    const viewConfig = useSchemaStore.getState().schema?.views.find(v => v.id === viewId)
    if (viewConfig) {
      const dsId = viewConfig.dataSourceId ?? parseDataSourceId(viewConfig.scopeKey) ?? undefined
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

  // ─── Step 4: Handle rapid navigation (viewId changes while in progress) ─

  useEffect(() => {
    // When viewId changes, reset the completed ref so the pipeline re-runs
    completedViewRef.current = null
  }, [viewId])

  // ─── Step 5: Auto-retry on backend recovery ───────────────────────────
  // When the backend comes back from an outage, reset error state so the
  // view re-resolves automatically — no manual page refresh needed.

  useEffect(() => {
    const unsubscribe = useHealthStore.subscribe((state, prev) => {
      const wasDown = prev.status === 'unreachable' || prev.status === 'degraded'
      const isBack = state.status === 'recovered' || (state.status === 'healthy' && wasDown)
      if (!isBack) return
      if (statusRef.current !== 'error') return // only retry if we're currently in error

      // Reset so Step 1 effect re-runs with fresh retryCount
      completedViewRef.current = null
      setError(null)
      setRetryCount(c => c + 1)
    })
    return unsubscribe
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return {
    status,
    view: activeView ?? null,
    error,
  }
}
