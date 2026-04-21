/**
 * Shared utilities for ontology features.
 */
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

/** Cache freshness metadata surfaced from the backend's X-Cache-* headers. */
export interface SchemaStatsFreshness {
  /** ISO timestamp of when the cache was last refreshed. */
  updatedAt: string | null
  /** Seconds since cache was refreshed (0 for live results). */
  ageSeconds: number | null
  /** `"postgres"` = served from persisted cache. `"live"` = computed now. */
  source: 'postgres' | 'live' | 'unknown'
  /** True when the result was served from cache (vs a live provider call). */
  fromCache: boolean
}

export interface SchemaStatsResult {
  stats: GraphSchemaStats
  freshness: SchemaStatsFreshness
}

function _parseFreshness(res: Response, fromCache: boolean): SchemaStatsFreshness {
  const updatedAt = res.headers.get('X-Cache-Updated-At')
  const ageRaw = res.headers.get('X-Cache-Age-Seconds')
  const source = (res.headers.get('X-Cache-Source') as 'postgres' | 'live' | null) ?? 'unknown'
  return {
    updatedAt,
    ageSeconds: ageRaw ? parseInt(ageRaw, 10) : null,
    source,
    fromCache: fromCache || source === 'postgres',
  }
}

/**
 * Fetch graph schema stats for an arbitrary workspace/data-source combination.
 * Prefers the DB-cached stats endpoint; falls back to the provider-backed
 * introspection endpoint (which itself also prefers the Postgres cache).
 *
 * On large graphs (1M+ nodes), a live provider call can take minutes —
 * callers should generally use {@link fetchSchemaStatsWithMeta} and check
 * `freshness.ageSeconds` to decide whether to offer the user a refresh.
 */
export async function fetchSchemaStats(
  workspaceId: string,
  dataSourceId?: string,
): Promise<GraphSchemaStats> {
  const result = await fetchSchemaStatsWithMeta(workspaceId, dataSourceId)
  return result.stats
}

/**
 * Same as {@link fetchSchemaStats}, but returns cache freshness metadata
 * so the UI can surface a staleness banner and refresh button.
 */
export async function fetchSchemaStatsWithMeta(
  workspaceId: string,
  dataSourceId?: string,
): Promise<SchemaStatsResult> {
  // 1. Try DB cache first (always fast, even on 1M+ graphs)
  if (dataSourceId) {
    try {
      const res = await fetchWithTimeout(
        `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-stats`,
      )
      if (res.ok) {
        const data = await res.json()
        if (data.schemaStats) {
          return {
            stats: data.schemaStats as GraphSchemaStats,
            freshness: _parseFreshness(res, /*fromCache*/ true),
          }
        }
      }
    } catch { /* cache miss — fall through */ }
  }

  // 2. Fall back to provider-backed endpoint (also checks Postgres cache first)
  if (workspaceId && dataSourceId) {
    try {
      const res = await fetchWithTimeout(
        `/api/v1/${workspaceId}/graph/introspection?dataSourceId=${encodeURIComponent(dataSourceId)}`,
      )
      if (res.ok) {
        const stats = await res.json() as GraphSchemaStats
        return { stats, freshness: _parseFreshness(res, false) }
      }
    } catch { /* fall through to provider */ }
  }

  // 3. Last resort: direct provider call (may time out on large graphs)
  const { RemoteGraphProvider } = await import('@/providers/RemoteGraphProvider')
  const provider = new RemoteGraphProvider({ workspaceId, dataSourceId })
  const stats = await provider.getSchemaStats()
  return {
    stats,
    freshness: { updatedAt: null, ageSeconds: null, source: 'live', fromCache: false },
  }
}

/**
 * Trigger a non-blocking refresh of the Postgres schema/introspection
 * cache for a data source. Returns immediately with a job ID; the backend
 * runs the actual introspection as a background task.
 */
export async function triggerIntrospectionRefresh(
  workspaceId: string,
  dataSourceId: string,
): Promise<{ jobId: string }> {
  const res = await fetchWithTimeout(
    `/api/v1/${workspaceId}/graph/introspection/refresh?dataSourceId=${encodeURIComponent(dataSourceId)}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    throw new Error(`Refresh failed: ${res.status} ${await res.text()}`)
  }
  const data = await res.json()
  return { jobId: data.job_id }
}

/**
 * Generate a meaningful name for a suggested ontology based on available context.
 * Prefers data source label, then workspace name, then dominant entity types.
 */
export function generateSuggestedName(
  dataSourceLabel: string | null | undefined,
  workspaceName: string | null | undefined,
  entityTypeIds?: string[],
): string {
  if (dataSourceLabel) return `${dataSourceLabel} Schema`
  if (workspaceName) return `${workspaceName} Schema`

  if (entityTypeIds && entityTypeIds.length > 0) {
    // Humanize the most common entity type as a domain hint
    const first = entityTypeIds[0]
      .replace(/_/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase())
    if (entityTypeIds.length <= 3) {
      const names = entityTypeIds.map(id =>
        id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      )
      return `${names.join(', ')} Schema`
    }
    return `${first} + ${entityTypeIds.length - 1} Types Schema`
  }

  return 'Graph Schema'
}
