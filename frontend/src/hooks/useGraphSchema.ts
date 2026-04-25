/**
 * React Query hook for fetching and caching the graph schema from the backend.
 *
 * Design (post-insights-refactor):
 * - **Cache-only.** The backend's `/cached-schema` endpoint reads from
 *   `data_source_stats.graph_schema` and never calls the upstream
 *   provider; the insights worker is the only thing that ever
 *   re-populates that cache. Calling `provider.getFullSchema()` from
 *   the browser would just re-read the same cache under a different
 *   envelope, so that path was deleted.
 * - **Status-aware refetch.** The endpoint returns the universal
 *   envelope `{data, meta}`; when `meta.status === 'computing'`
 *   React Query refetches every 2s until the worker finishes the
 *   refresh and the row flips to `fresh`.
 * - **Ontology fallback.** When the cache row is genuinely empty
 *   (e.g. a new data source whose first poll hasn't completed yet),
 *   we synthesise a minimal schema from `cached-ontology` so the
 *   wizard can still render entity-type selectors.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { GraphSchema } from '@/providers/GraphDataProvider'
import { useGraphProviderContext } from '@/providers/GraphProviderContext'
import { unwrapEnvelopeWithMeta } from '@/services/cacheEnvelope'
import type { CacheMeta } from '@/services/cacheEnvelope'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { useSchemaStore } from '@/store/schema'
import { useEffect } from 'react'

export const GRAPH_SCHEMA_QUERY_KEY = ['graph', 'schema'] as const

export interface UseGraphSchemaOptions {
  /** Override workspace scope. Defaults to the active graph-provider context. */
  workspaceId?: string
  /** Override data-source scope. Defaults to the active graph-provider context. */
  dataSourceId?: string
}

interface SchemaFetchResult {
  schema: GraphSchema | null
  meta: CacheMeta | null
}

/**
 * Fetch schema from the management DB cache (zero provider dependency).
 * Returns both the unwrapped schema and the envelope `meta` so the hook
 * can drive a refetch interval while the worker is still computing.
 */
async function fetchCachedSchema(
  workspaceId: string,
  dataSourceId: string,
): Promise<SchemaFetchResult> {
  try {
    const res = await fetchWithTimeout(
      `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-schema`,
    )
    if (!res.ok) return { schema: null, meta: null }
    const json = await res.json()
    const { data, meta } = unwrapEnvelopeWithMeta<GraphSchema>(json)
    return { schema: data, meta }
  } catch {
    return { schema: null, meta: null }
  }
}

/**
 * Fetch ontology metadata as a synthesised minimal GraphSchema for the
 * wizard's entity-type selectors. Used only when the cached-schema row
 * is empty AND has no entity types — a new data source whose first
 * poll hasn't completed yet.
 */
async function fetchCachedOntologyAsSchema(
  workspaceId: string,
  dataSourceId: string,
): Promise<GraphSchema | null> {
  try {
    const res = await fetchWithTimeout(
      `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-ontology`,
    )
    if (!res.ok) return null
    const json = await res.json()
    const { data: ontology } = unwrapEnvelopeWithMeta<Record<string, unknown>>(json)
    if (!ontology) return null
    return {
      entityTypes: (ontology as { entityTypes?: unknown[] }).entityTypes ?? [],
      relationshipTypes:
        (ontology as { relationshipTypes?: unknown[] }).relationshipTypes ?? [],
      ontology,
    } as unknown as GraphSchema
  } catch {
    return null
  }
}

/**
 * Cache-first schema fetch. Tries the DB cache; if the cache is empty
 * (no entity types yet), falls back to a synthesised schema from
 * the ontology endpoint. The provider is intentionally NOT consulted
 * here — that path was dead code (the matching backend endpoint is
 * also cache-only).
 */
async function fetchGraphSchema(
  workspaceId: string,
  dataSourceId: string,
): Promise<SchemaFetchResult> {
  const cached = await fetchCachedSchema(workspaceId, dataSourceId)
  if (cached.schema && cached.schema.entityTypes && cached.schema.entityTypes.length > 0) {
    return cached
  }

  // Empty cache — surface a minimal ontology-derived schema so the
  // wizard's entity-type selectors render. Carry through the cached
  // meta so the hook still drives the refetch interval correctly.
  const ontologySchema = await fetchCachedOntologyAsSchema(workspaceId, dataSourceId)
  if (ontologySchema) {
    return { schema: ontologySchema, meta: cached.meta }
  }

  // Accept an empty cached schema if it exists — some new data sources
  // legitimately have nothing yet and the wizard can show that state.
  if (cached.schema) {
    return cached
  }

  throw new Error(
    `Graph schema unavailable for workspace="${workspaceId}" dataSource="${dataSourceId}".`,
  )
}

/**
 * useGraphSchema
 *
 * Used by <SchemaScope> (which can pass explicit scope) and the legacy
 * zero-arg call sites in CanvasLayout / useViewNavigation that inherit
 * scope from the active graph-provider context.
 */
export function useGraphSchema(options?: UseGraphSchemaOptions) {
  const ctx = useGraphProviderContext()
  const { providerVersion } = ctx

  const workspaceId = options?.workspaceId ?? ctx.workspaceId ?? undefined
  const dataSourceId = options?.dataSourceId ?? ctx.dataSourceId ?? undefined

  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  const queryClient = useQueryClient()

  const query = useQuery<SchemaFetchResult>({
    // Include workspaceId + dataSourceId + providerVersion so workspace A's
    // schema is never served for workspace B.
    queryKey: [...GRAPH_SCHEMA_QUERY_KEY, workspaceId, dataSourceId, providerVersion],
    queryFn: () => fetchGraphSchema(workspaceId!, dataSourceId!),
    enabled: Boolean(workspaceId && dataSourceId),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false, // Failure is loud — <SchemaScope> renders the error UI.
    refetchOnWindowFocus: false,
    // While the backend cache is `computing` (worker has been kicked
    // but hasn't finished yet), poll every 2s. As soon as `meta.status`
    // flips to `fresh`/`stale` the function returns false and React
    // Query stops refetching automatically.
    refetchInterval: (q) => {
      const status = q.state.data?.meta?.status
      return status === 'computing' ? 2000 : false
    },
  })

  // Sync schema into the Zustand store. No silent fallback: if the
  // query errors, the effect is a no-op and React Query's `error`
  // surfaces to <SchemaScope>, which renders the error boundary.
  useEffect(() => {
    const schema = query.data?.schema
    if (schema && schema.entityTypes && schema.entityTypes.length > 0) {
      loadFromBackend(schema, { workspaceId, dataSourceId })
    }
  }, [query.data, loadFromBackend, workspaceId, dataSourceId])

  return {
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    data: query.data?.schema ?? undefined,
    /** Cache freshness/state — surface this in banners or spinners. */
    meta: query.data?.meta ?? null,
    /** Force-refetch schema (e.g. after saving entity type changes). */
    refetch: query.refetch,
    /** Invalidate cached schema across all provider instances. */
    invalidate: () => queryClient.invalidateQueries({ queryKey: GRAPH_SCHEMA_QUERY_KEY }),
  }
}

/**
 * useInvalidateGraphSchema
 *
 * Returns a function that invalidates the graph schema cache. Use this from
 * mutation callbacks (e.g. after saving an ontology change via API).
 */
export function useInvalidateGraphSchema() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: GRAPH_SCHEMA_QUERY_KEY })
}
