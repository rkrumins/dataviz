/**
 * React Query hook for fetching and caching the graph schema from the backend.
 *
 * Design:
 * - Explicit scope: workspaceId/dataSourceId can be passed directly (used by
 *   <SchemaScope> when resolving schema for a non-active workspace, e.g.
 *   editing a view created in workspace W1 while W2 is active). Defaults to
 *   the active graph-provider context when no explicit scope is supplied.
 * - DB-first: tries the cached-schema endpoint (management DB, no provider
 *   dependency, explicit URL scope).
 * - Provider-live fallback: calls provider.getFullSchema() when the DB cache
 *   is empty. The provider is always correctly scoped because callers render
 *   inside a scope boundary (SchemaScope or ViewExecutionProvider) that
 *   provides the right provider via ProviderOverride.
 * - No silent fallback: errors surface through React Query. Consumers MUST
 *   render under <SchemaScope>, which owns the loading + error UI.
 */
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useGraphProvider, useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useSchemaStore } from '@/store/schema'
import type { GraphSchema } from '@/providers/GraphDataProvider'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

export const GRAPH_SCHEMA_QUERY_KEY = ['graph', 'schema'] as const

export interface UseGraphSchemaOptions {
  /** Override workspace scope. Defaults to the active graph-provider context. */
  workspaceId?: string
  /** Override data-source scope. Defaults to the active graph-provider context. */
  dataSourceId?: string
}

/**
 * Fetch schema from the management DB cache (zero provider dependency).
 * Returns null if no cached schema is available for this exact scope.
 */
async function fetchCachedSchema(
  workspaceId: string,
  dataSourceId: string,
): Promise<GraphSchema | null> {
  try {
    const res = await fetchWithTimeout(
      `/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-schema`,
    )
    if (!res.ok) return null
    return (await res.json()) as GraphSchema
  } catch {
    return null
  }
}

/**
 * Fetch ontology metadata from the DB (zero provider dependency).
 * Used as a last-resort fallback when cached-schema is empty and the live
 * provider is also unavailable.
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
    const ontology = await res.json()
    // Wrap the ontology metadata into a GraphSchema-shaped envelope so
    // useSchemaStore.loadFromBackend can consume it.
    return {
      entityTypes: ontology?.entityTypes ?? [],
      relationshipTypes: ontology?.relationshipTypes ?? [],
      ontology,
    } as unknown as GraphSchema
  } catch {
    return null
  }
}

/**
 * Scope-aware schema fetch. Tries DB cache first, then the live provider
 * (which is always correctly scoped via ProviderOverride), then cached
 * ontology as a last resort.
 */
async function fetchGraphSchema(
  provider: ReturnType<typeof useGraphProvider>,
  workspaceId: string,
  dataSourceId: string,
): Promise<GraphSchema> {
  // 1. Try DB cache first (fast, explicit scope, no provider dependency).
  const cached = await fetchCachedSchema(workspaceId, dataSourceId)
  if (cached && cached.entityTypes && cached.entityTypes.length > 0) {
    return cached
  }

  // 2. Try the live provider. The provider is always correctly scoped because
  //    callers render inside SchemaScope or ViewExecutionProvider, both of
  //    which provide a ProviderOverride matching the requested scope.
  try {
    const live = await provider.getFullSchema()
    if (live && live.entityTypes && live.entityTypes.length > 0) {
      return live
    }
  } catch {
    // Provider unavailable — continue to fallback
  }

  // 3. Try the cached-ontology endpoint as a last resort. If the data source
  //    has an ontology assigned, this builds a minimal but valid schema from
  //    the ontology definition alone — no provider needed.
  const ontologySchema = await fetchCachedOntologyAsSchema(workspaceId, dataSourceId)
  if (ontologySchema) {
    return ontologySchema
  }

  // 4. Accept a cached schema even with zero entity types — some data sources
  //    legitimately have empty schemas (e.g. before ontology assignment).
  if (cached) {
    return cached
  }

  // 5. No cached schema, no ontology, provider failed — fail loudly
  //    so <SchemaScope> can render its error UI.
  throw new Error(
    `Graph schema unavailable for workspace="${workspaceId}" dataSource="${dataSourceId}".`,
  )
}

/**
 * useGraphSchema
 *
 * Primary consumer is <SchemaScope>, which passes explicit scope so non-canvas
 * routes (Dashboard, OntologySchemaPage, wizard edits of cross-workspace
 * views) can fetch schema on demand without depending on CanvasLayout having
 * been mounted first. Legacy zero-arg callers (CanvasLayout, useViewNavigation)
 * inherit scope from the active graph-provider context.
 */
export function useGraphSchema(options?: UseGraphSchemaOptions) {
  const provider = useGraphProvider()
  const ctx = useGraphProviderContext()
  const { providerVersion } = ctx

  // Explicit scope (from options) overrides the active context so callers can
  // fetch schema for a workspace other than the currently-active one.
  const workspaceId = options?.workspaceId ?? ctx.workspaceId ?? undefined
  const dataSourceId = options?.dataSourceId ?? ctx.dataSourceId ?? undefined

  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  const queryClient = useQueryClient()
  // Remembers which scope we've already background-refreshed so we don't fire
  // the provider call repeatedly for the same (workspace, dataSource, version).
  const backgroundRefreshDone = useRef<string | null>(null)

  const query = useQuery({
    // Include workspaceId + dataSourceId + providerVersion so workspace A's
    // schema is never served for workspace B.
    queryKey: [...GRAPH_SCHEMA_QUERY_KEY, workspaceId, dataSourceId, providerVersion],
    queryFn: () =>
      fetchGraphSchema(provider, workspaceId!, dataSourceId!),
    enabled: Boolean(workspaceId && dataSourceId),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: false, // Failure is loud — <SchemaScope> renders the error UI.
    refetchOnWindowFocus: false,
  })

  // Sync query result into the Zustand store. No silent fallback: if the
  // query errors, the effect is a no-op and React Query's `error` surfaces
  // to <SchemaScope>, which renders the error boundary.
  useEffect(() => {
    if (query.data && query.data.entityTypes && query.data.entityTypes.length > 0) {
      loadFromBackend(query.data, { workspaceId, dataSourceId })
    }
  }, [query.data, loadFromBackend, workspaceId, dataSourceId])

  // Background refresh: after the DB-cached schema is loaded, ask the live
  // provider once per scope to see if it has a fresher copy. The provider is
  // always correctly scoped (via ProviderOverride from SchemaScope or
  // ViewExecutionProvider). Race protection: the `cancelled` flag from the
  // effect cleanup fires on any dependency change, which is sufficient to
  // drop late responses after a scope switch.
  useEffect(() => {
    if (!query.data) return
    const capturedWs = workspaceId
    const capturedDs = dataSourceId
    if (!capturedWs || !capturedDs) return

    const scopeKey = `${capturedWs}::${capturedDs}::${providerVersion}`
    if (backgroundRefreshDone.current === scopeKey) return
    backgroundRefreshDone.current = scopeKey

    let cancelled = false
    provider
      .getFullSchema()
      .then(liveSchema => {
        if (cancelled) return
        if (
          liveSchema &&
          liveSchema.entityTypes &&
          liveSchema.entityTypes.length > 0
        ) {
          loadFromBackend(liveSchema, {
            workspaceId: capturedWs,
            dataSourceId: capturedDs,
          })
        }
      })
      .catch(() => {
        // Provider unavailable — the DB-cached schema is already loaded and
        // React Query's `error` field stays clean because this is a bonus
        // refresh, not the primary fetch.
      })

    return () => {
      cancelled = true
    }
  }, [
    query.data,
    provider,
    loadFromBackend,
    workspaceId,
    dataSourceId,
    providerVersion,
  ])

  return {
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    data: query.data,
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
