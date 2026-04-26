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
 *     ``insights-`` (asset stats, asset list, job status, ...) is
 *     invalidated so stuck "Computing" StatusChips refresh once
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
      // chips refresh once Redis is back. Tuple-key predicate form:
      // any query whose first key is a string starting with
      // ``insights-`` (asset stats/list, job status, etc.).
      queryClient.invalidateQueries({
        predicate: (q) => {
          const head = q.queryKey[0]
          return typeof head === 'string' && head.startsWith('insights-')
        },
      })
    })

    return unsubscribe
  }, [queryClient])
}
