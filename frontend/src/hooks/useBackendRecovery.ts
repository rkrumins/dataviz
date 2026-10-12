/**
 * useBackendRecovery — Automatically re-fetches critical data when the backend
 * recovers from an outage.
 *
 * Subscribes to the health store. When status transitions from
 * unreachable → recovered, it triggers:
 *   - Workspace list reload (populates sidebar, active workspace selection)
 *   - Views list reload (populates sidebar & view gallery)
 *   - Graph schema invalidation (next canvas route mount will re-fetch fresh)
 *   - Insights query invalidation: every query whose key starts with
 *     ``insights-`` (asset stats, job status, ...), plus the provider
 *     asset list and catalog keys, is invalidated so stuck "Computing"
 *     StatusChips and a stuck "no data sources" list both recover once
 *     Redis is back online.
 *
 * This eliminates the need for a full page refresh after a backend restart.
 * Mount once in AppLayout.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useHealthStore, type HealthStatus } from '@/store/health'
import { useWorkspacesStore } from '@/store/workspaces'
import { useSchemaStore } from '@/store/schema'
import { listViews, viewToViewConfig } from '@/services/viewApiService'
import { GRAPH_SCHEMA_QUERY_KEY } from '@/hooks/useGraphSchema'
import { PROVIDER_ASSETS_QUERY_KEY, PROVIDER_CATALOG_QUERY_KEY } from '@/hooks/useProviderAssets'
import { resetAllCircuitBreakers } from '@/services/circuitBreaker'

export function useBackendRecovery() {
  const queryClient = useQueryClient()
  const prevStatus = useRef<HealthStatus>('healthy')

  useEffect(() => {
    const unsubscribe = useHealthStore.subscribe((state) => {
      const prev = prevStatus.current
      const curr = state.status
      prevStatus.current = curr

      // Only trigger on recovery transitions
      const wasDown = prev === 'unreachable'
      const isBack = curr === 'recovered' || (curr === 'healthy' && wasDown)

      if (!isBack) return

      console.info('[useBackendRecovery] Backend recovered — reloading data')

      // Reset all circuit breakers so providers can be probed immediately
      resetAllCircuitBreakers()

      // Re-fetch workspaces (drives provider rebuild)
      useWorkspacesStore.getState().loadWorkspaces()

      // Re-fetch views list
      listViews()
        .then(({ items }) => {
          useSchemaStore.getState().upsertViews(items.map(viewToViewConfig))
        })
        .catch((err) => {
          console.warn('[useBackendRecovery] Views reload failed:', err)
        })

      // Invalidate cached graph schema so it re-fetches on next canvas mount
      queryClient.invalidateQueries({ queryKey: [...GRAPH_SCHEMA_QUERY_KEY] })

      // Invalidate every insights envelope/query so stuck "Computing"
      // chips refresh once Redis is back.
      //
      // The asset LIST is not under an ``insights-`` key — it is
      // ``provider-assets`` (useProviderAssets.ts), so the startsWith
      // predicate never matched it and the docstring above was wrong. That
      // mattered: an outage-era envelope with data:null classifies as
      // 'unavailable', which stops the poll, so the list stayed stuck on
      // "no data sources" after the backend came back while the per-row
      // chips un-stuck around it. Name both provider keys explicitly.
      queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0]
          if (typeof head !== 'string') return false
          return head.startsWith('insights-')
            || head === PROVIDER_ASSETS_QUERY_KEY
            || head === PROVIDER_CATALOG_QUERY_KEY
        },
      })
    })

    return unsubscribe
  }, [queryClient])
}
