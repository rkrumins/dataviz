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
 * - Provider-live background refresh: if the requested scope matches the
 *   active provider scope, fires `provider.getFullSchema()` in the background;
 *   race-protected via capture-then-commit so a mid-flight response after a
 *   workspace switch is dropped instead of clobbering the new workspace's
 *   schema.
 * - No silent fallback: errors surface through React Query. Consumers MUST
 *   render under <SchemaScope>, which owns the loading + error UI.
 */
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useGraphProvider, useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useSchemaStore } from '@/store/schema'
import { useWorkspacesStore } from '@/store/workspaces'
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
 * Scope-aware schema fetch. The hook short-circuits (`enabled: false`) when
 * workspaceId/dataSourceId are not set, so this function can assume both are
 * present by the time it runs.
 */
async function fetchGraphSchema(
  provider: ReturnType<typeof useGraphProvider>,
  workspaceId: string,
  dataSourceId: string,
  providerMatchesScope: boolean,
): Promise<GraphSchema> {
  // 1. Try DB cache first (fast, explicit scope, no provider dependency).
  const cached = await fetchCachedSchema(workspaceId, dataSourceId)
  if (cached && cached.entityTypes && cached.entityTypes.length > 0) {
    return cached
  }

  // 2. Fall back to the live provider ONLY when its configured scope matches
  //    what we asked for — otherwise the provider would return a DIFFERENT
  //    workspace's schema and we'd silently serve cross-workspace data.
  if (providerMatchesScope) {
    return provider.getFullSchema()
  }

  // 3. No cached schema for this scope and no matching provider — fail loudly
  //    so <SchemaScope> can render its error UI. The admin cached-schema
  //    endpoint is the contract for cross-workspace reads; if it's empty, we
  //    have no safe path to the non-active workspace's schema.
  throw new Error(
    `Graph schema unavailable for workspace="${workspaceId}" dataSource="${dataSourceId}": ` +
      `no cached schema and the active graph provider is scoped to a different workspace.`,
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
  const providerMatchesScope =
    workspaceId === ctx.workspaceId && dataSourceId === ctx.dataSourceId

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
      fetchGraphSchema(provider, workspaceId!, dataSourceId!, providerMatchesScope),
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
  // provider once per scope to see if it has a fresher copy. Only runs when
  // the active provider scope matches the requested scope (otherwise we'd be
  // asking the wrong provider). Capture-then-commit drops late responses
  // after a workspace switch.
  useEffect(() => {
    if (!query.data || !providerMatchesScope) return
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
        // Re-read the *current* active scope and drop the write if the user
        // has switched workspaces while we were awaiting the provider call.
        const latest = useWorkspacesStore.getState()
        if (
          capturedWs !== latest.activeWorkspaceId ||
          capturedDs !== latest.activeDataSourceId
        ) {
          return
        }
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
    providerMatchesScope,
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
