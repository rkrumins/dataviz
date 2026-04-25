/**
 * Shared utilities for ontology features.
 */
import type { GraphSchemaStats } from '@/providers/GraphDataProvider'
import {
  fetchEnvelopedWithMeta,
  type CacheMeta,
} from '@/services/cacheEnvelope'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

/** Cache freshness metadata surfaced from the backend response envelope. */
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

/** Map an envelope's ``meta`` block to the legacy SchemaStatsFreshness shape. */
function _freshnessFromMeta(meta: CacheMeta | null, fromCache: boolean): SchemaStatsFreshness {
  if (!meta) {
    return {
      updatedAt: null,
      ageSeconds: null,
      source: fromCache ? 'postgres' : 'unknown',
      fromCache,
    }
  }
  // meta.source ∈ "postgres" | "ontology" | "none" | "error"
  // Map to the existing 'postgres' | 'live' | 'unknown' display vocabulary
  // since downstream UI components don't yet model the richer states.
  const source =
    meta.source === 'postgres' ? 'postgres'
    : meta.source === 'ontology' ? 'postgres'  // synthetic schema is still "from cache"
    : 'unknown'
  return {
    updatedAt: meta.updated_at ?? null,
    ageSeconds: meta.age_seconds,
    source,
    fromCache: source === 'postgres',
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
  const circuitScope = { workspaceId, dataSourceId }

  // 1. Try the management-DB cached-stats endpoint. The composite payload
  //    contains a ``schemaStats`` field; use ``fetchEnvelopedWithMeta`` so
  //    the UI can also render the freshness banner from ``meta``.
  if (dataSourceId) {
    const { data, meta } = await fetchEnvelopedWithMeta<{
      schemaStats?: GraphSchemaStats
    }>(
      `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-stats`,
      { circuitScope },
    )
    if (data?.schemaStats) {
      return {
        stats: data.schemaStats,
        freshness: _freshnessFromMeta(meta, /*fromCache*/ true),
      }
    }
  }

  // 2. Try the provider-backed introspection endpoint (also Postgres-cached).
  //    The unwrapped payload IS the GraphSchemaStats directly (no nested key).
  if (workspaceId && dataSourceId) {
    const { data, meta } = await fetchEnvelopedWithMeta<GraphSchemaStats>(
      `/api/v1/${workspaceId}/graph/introspection?dataSourceId=${encodeURIComponent(dataSourceId)}`,
      { circuitScope },
    )
    if (data) {
      return { stats: data, freshness: _freshnessFromMeta(meta, /*fromCache*/ false) }
    }
  }

  // 3. Last resort: direct provider call. ``getSchemaStats`` already unwraps
  //    the envelope internally and throws on error/cache-miss — let that
  //    propagate so callers can render their error UI.
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
  // The refresh endpoint returns the canonical {data, meta} envelope.
  // The job id lives at ``meta.job_id`` (envelope shape), not ``data.job_id``
  // — the legacy snake-case ``job_id`` field on the body root is gone.
  const res = await fetchWithTimeout(
    `/api/v1/${workspaceId}/graph/introspection/refresh?dataSourceId=${encodeURIComponent(dataSourceId)}`,
    { method: 'POST' },
  )
  if (!res.ok) {
    throw new Error(`Refresh failed: ${res.status} ${await res.text()}`)
  }
  const body = await res.json()
  const jobId = body?.meta?.job_id ?? body?.job_id ?? ''
  if (!jobId) {
    throw new Error('Refresh accepted but no jobId returned')
  }
  return { jobId }
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
