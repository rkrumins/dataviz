/**
 * Shared utilities for ontology features.
 */
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

/**
 * Fetch graph schema stats for an arbitrary workspace/data-source combination.
 * Uses the DB-cached stats endpoint (no provider dependency).
 * Falls back to the provider-backed introspection endpoint if cache is empty.
 */
export async function fetchSchemaStats(
  workspaceId: string,
  dataSourceId?: string,
): Promise<GraphSchemaStats> {
  // 1. Try DB cache first (no provider needed)
  if (dataSourceId) {
    try {
      const res = await fetchWithTimeout(`/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-stats`)
      if (res.ok) {
        const data = await res.json()
        if (data.schemaStats) {
          return data.schemaStats as GraphSchemaStats
        }
      }
    } catch { /* cache miss — fall through */ }
  }

  // 2. Fall back to provider-backed endpoint
  const { RemoteGraphProvider } = await import('@/providers/RemoteGraphProvider')
  const provider = new RemoteGraphProvider({ workspaceId, dataSourceId })
  return provider.getSchemaStats()
}
