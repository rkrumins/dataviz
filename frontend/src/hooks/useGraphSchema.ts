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
import { httpStatusOf, toApiStatusError } from '@/services/graphRequestFailure'
import { useSchemaStore } from '@/store/schema'
import { useEffect } from 'react'

export const GRAPH_SCHEMA_QUERY_KEY = ['graph', 'schema'] as const

export interface UseGraphSchemaOptions {
  /** Override workspace scope. Defaults to the active graph-provider context. */
  workspaceId?: string
  /** Override data-source scope. Defaults to the active graph-provider context. */
  dataSourceId?: string
  /** View-capability context — authorizes non-members of the view's
   *  workspace through their read access to the view. */
  viewId?: string
}

interface SchemaFetchResult {
  schema: GraphSchema | null
  meta: CacheMeta | null
}

/**
 * A non-OK cache read. A 404 (no such data source, or no cache row yet) is a
 * legitimate miss the caller degrades from; anything else — a session the
 * fetch layer could not repair (401/403), a slow or restarting backend
 * (5xx, 504) — is thrown WITH its status. These endpoints read Postgres,
 * never the graph provider, so their failures used to be swallowed into
 * `null` and rendered as "Provider Offline"; carrying the status lets React
 * Query retry the transient ones and the layout say what actually happened.
 */
async function rejectUnlessMiss(res: Response): Promise<null> {
  if (res.status === 404) return null
  throw toApiStatusError(res, await res.text())
}

/** True when a schema failure should be retried by React Query: a slow or
 *  restarting backend (5xx), load shedding (429), or no HTTP answer at all
 *  (network error, client timeout). A 4xx — including a session problem,
 *  which the fetch layer has already replayed once — is not. */
export function isRetryableSchemaError(error: unknown): boolean {
  const status = httpStatusOf(error)
  if (status === null) return true
  return status >= 500 || status === 429
}

/** 401/403: the session, not the schema. The session-lost and access-denied
 *  flows own the messaging, so the schema surfaces stay quiet. */
export function isSchemaAuthError(error: unknown): boolean {
  const status = httpStatusOf(error)
  return status === 401 || status === 403
}

/**
 * Fetch schema from the management DB cache (zero provider dependency).
 * Returns both the unwrapped schema and the envelope `meta` so the hook
 * can drive a refetch interval while the worker is still computing.
 */
async function fetchCachedSchema(
  workspaceId: string,
  dataSourceId: string,
  viewId?: string,
): Promise<SchemaFetchResult> {
  const viewParam = viewId ? `?viewId=${encodeURIComponent(viewId)}` : ''
  const res = await fetchWithTimeout(
    `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-schema${viewParam}`,
  )
  if (!res.ok) {
    await rejectUnlessMiss(res)
    return { schema: null, meta: null }
  }
  const json = await res.json()
  const { data, meta } = unwrapEnvelopeWithMeta<GraphSchema>(json)
  return { schema: data, meta }
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
  viewId?: string,
): Promise<GraphSchema | null> {
  const viewParam = viewId ? `?viewId=${encodeURIComponent(viewId)}` : ''
  const res = await fetchWithTimeout(
    `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-ontology${viewParam}`,
  )
  if (!res.ok) return rejectUnlessMiss(res)
  const json = await res.json()
  const { data: ontology } = unwrapEnvelopeWithMeta<Record<string, unknown>>(json)
  if (!ontology) return null
  return {
    entityTypes: (ontology as { entityTypes?: unknown[] }).entityTypes ?? [],
    relationshipTypes:
      (ontology as { relationshipTypes?: unknown[] }).relationshipTypes ?? [],
    ontology,
  } as unknown as GraphSchema
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
  viewId?: string,
): Promise<SchemaFetchResult> {
  const cached = await fetchCachedSchema(workspaceId, dataSourceId, viewId)
  if (cached.schema && cached.schema.entityTypes && cached.schema.entityTypes.length > 0) {
    return cached
  }

  // Empty cache — surface a minimal ontology-derived schema so the
  // wizard's entity-type selectors render. Carry through the cached
  // meta so the hook still drives the refetch interval correctly.
  const ontologySchema = await fetchCachedOntologyAsSchema(workspaceId, dataSourceId, viewId)
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
  const viewId = options?.viewId

  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  const queryClient = useQueryClient()

  const query = useQuery<SchemaFetchResult>({
    // Include workspaceId + dataSourceId + providerVersion so workspace A's
    // schema is never served for workspace B.
    // viewId is part of the key so a member's cached entry can never mask
    // a non-member's authorization path (and vice versa).
    queryKey: [...GRAPH_SCHEMA_QUERY_KEY, workspaceId, dataSourceId, providerVersion, viewId ?? null],
    queryFn: () => fetchGraphSchema(workspaceId!, dataSourceId!, viewId),
    enabled: Boolean(workspaceId && dataSourceId),
    // Keep serving the schema we already have while a re-key refetches.
    //
    // `providerVersion` is part of the key, so anything that bumps it — a
    // projection watermark catching up, a provider health recovery — produced a
    // COLD cache entry: `data` went `undefined`, and every gate downstream
    // (`ViewSchemaGate`, `SchemaScope`) unmounted the canvas subtree it was
    // guarding, taking the React Flow instance, the open lens and the trace state
    // with it. Reusing the previous entry's data makes that a background refetch
    // instead of a teardown.
    //
    // The scope guard is NOT optional: a bare `(prev) => prev` would hand
    // workspace A's ontology to workspace B's provider, which is the exact
    // cross-workspace contamination the key comment above exists to prevent. Only
    // reuse when workspace, data source and view are identical and it is purely
    // the version that moved.
    placeholderData: (prev, prevQuery) => {
      const key = prevQuery?.queryKey as unknown[] | undefined
      if (!key) return undefined
      const sameScope = key[2] === workspaceId
        && key[3] === dataSourceId
        && key[5] === (viewId ?? null)
      return sameScope ? prev : undefined
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    // Retries buy resilience against transient blips (network drop, a
    // 502/504 from a rolling deploy or a slow backend) without masking
    // real failures: a 4xx is final, and after the budget <SchemaScope>
    // still renders its error UI. Backed off so a restarting backend gets
    // a few seconds, while a failed initial mount on a healthy backend
    // stays invisible.
    retry: (failureCount, error) => failureCount < 3 && isRetryableSchemaError(error),
    retryDelay: (attempt) => Math.min(800 * 2 ** attempt, 4_000),
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
