/**
 * useBackendRecovery — Automatically re-fetches critical data when the backend
 * recovers from an outage.
 *
 * Subscribes to the health store. When status transitions from
 * unreachable → recovered, it triggers:
 *   - Workspace list reload (populates sidebar, active workspace selection)
 *   - Connection list reload (legacy compat)
 *   - Views list reload (populates sidebar & view gallery)
 *   - Graph schema invalidation (next canvas route mount will re-fetch fresh)
 *
 * This eliminates the need for a full page refresh after a backend restart.
 * Mount once in AppLayout.
 */
import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useHealthStore, type HealthStatus } from '@/store/health'
import { useWorkspacesStore } from '@/store/workspaces'
import { useConnectionsStore } from '@/store/connections'
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

      // Re-fetch workspaces + connections (drives provider rebuild)
      useWorkspacesStore.getState().loadWorkspaces()
      useConnectionsStore.getState().loadConnections()

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
    })

    return unsubscribe
  }, [queryClient])
}
