/**
 * React Query hook for fetching and caching the graph schema from the backend.
 *
 * Design:
 * - DB-first: tries the cached-schema endpoint (management DB, no provider needed)
 * - Background refresh: fires provider.getFullSchema() in parallel; if it returns
 *   newer data it silently updates the schema store
 * - Fallback: if both DB cache and provider fail, falls back to defaultWorkspaceSchema
 * - Returns {isLoading, isError, error} so callers can render skeleton/error states
 */
import { useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useGraphProvider, useGraphProviderContext } from '@/providers/GraphProviderContext'
import { useSchemaStore } from '@/store/schema'
import { defaultWorkspaceSchema } from '@/lib/default-schema'
import type { GraphSchema } from '@/providers/GraphDataProvider'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'

export const GRAPH_SCHEMA_QUERY_KEY = ['graph', 'schema'] as const

/**
 * Fetch schema from management DB cache (zero provider dependency).
 * Returns null if no cached schema is available.
 */
async function fetchCachedSchema(workspaceId?: string, dataSourceId?: string): Promise<GraphSchema | null> {
  if (!workspaceId || !dataSourceId) return null
  try {
    const res = await fetchWithTimeout(`/api/v1/admin/workspaces/${workspaceId}/datasources/${dataSourceId}/cached-schema`)
    if (!res.ok) return null
    return await res.json() as GraphSchema
  } catch {
    return null
  }
}

/**
 * DB-first fetch: try cached schema from management DB, fall back to provider.
 * This ensures schema loads fast from DB even when the provider is slow or down.
 */
async function fetchGraphSchema(
  provider: ReturnType<typeof useGraphProvider>,
  workspaceId?: string,
  dataSourceId?: string,
): Promise<GraphSchema> {
  // 1. Try DB cache first (fast, no provider dependency)
  const cached = await fetchCachedSchema(workspaceId, dataSourceId)
  if (cached && cached.entityTypes && cached.entityTypes.length > 0) {
    return cached
  }

  // 2. Fall back to provider (may be slow or fail)
  return provider.getFullSchema()
}

/**
 * useGraphSchema
 *
 * Fetches the graph schema once per session (5 min stale time) and syncs it
 * into the Zustand schema store. Falls back to defaultWorkspaceSchema on error.
 *
 * Call this from CanvasLayout (canvas-bearing routes only).
 * Child components read schema from useSchemaStore() as before.
 */
export function useGraphSchema() {
  const provider = useGraphProvider()
  const { workspaceId, dataSourceId, providerVersion } = useGraphProviderContext()
  // Read actions once — they are stable references (Zustand guarantees this)
  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  const loadSchema = useSchemaStore(s => s.loadSchema)
  const queryClient = useQueryClient()
  const backgroundRefreshDone = useRef(false)

  const query = useQuery({
    // Include workspaceId + dataSourceId + providerVersion so workspace A's
    // schema is never served for workspace B.
    queryKey: [...GRAPH_SCHEMA_QUERY_KEY, workspaceId, dataSourceId, providerVersion],
    queryFn: () => fetchGraphSchema(provider, workspaceId ?? undefined, dataSourceId ?? undefined),
    staleTime: 5 * 60 * 1000,   // 5 minutes — matches backend _ONTOLOGY_CACHE_TTL
    gcTime: 10 * 60 * 1000,     // 10 minutes garbage collection
    retry: false,                // Don't retry — fallback to defaultWorkspaceSchema handles it
    refetchOnWindowFocus: false,
  })

  // Sync query result into Zustand store.
  // The store action itself is idempotent and no-op when payload is unchanged.
  useEffect(() => {
    if (query.data) {
      if (query.data.entityTypes.length > 0) {
        loadFromBackend(query.data)
      } else {
        // Graph returned empty schema — fall back to defaults
        const currentSchema = useSchemaStore.getState().schema
        if (currentSchema?.id === defaultWorkspaceSchema.id) return
        loadSchema(defaultWorkspaceSchema)
      }
    } else if (query.isError) {
      // No data at all — fall back to defaults so the app remains usable
      console.warn(
        '[useGraphSchema] Schema fetch failed — falling back to default schema.',
        'Edge classification (containment/lineage) will use defaults until schema loads.',
        query.error,
      )
      const currentSchema = useSchemaStore.getState().schema
      if (currentSchema?.id === defaultWorkspaceSchema.id) return
      loadSchema(defaultWorkspaceSchema)
    }
  }, [query.data, query.isError, loadFromBackend, loadSchema])

  // Background refresh: if we got schema from DB cache, try the provider
  // in the background to get potentially fresher data. Fire once per provider version.
  useEffect(() => {
    if (!query.data || backgroundRefreshDone.current) return
    backgroundRefreshDone.current = true

    provider.getFullSchema()
      .then((liveSchema) => {
        if (liveSchema && liveSchema.entityTypes && liveSchema.entityTypes.length > 0) {
          loadFromBackend(liveSchema)
        }
      })
      .catch(() => {
        // Provider unavailable — cached schema is already loaded, nothing to do
      })
  }, [query.data, provider, loadFromBackend])

  // Reset background refresh flag when provider version changes
  useEffect(() => {
    backgroundRefreshDone.current = false
  }, [providerVersion])

  return {
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    isError: query.isError,
    error: query.error,
    /** Force-refetch schema (e.g. after saving entity type changes) */
    refetch: query.refetch,
    /** Invalidate cached schema across all provider instances */
    invalidate: () => queryClient.invalidateQueries({ queryKey: GRAPH_SCHEMA_QUERY_KEY }),
  }
}

/**
 * useInvalidateGraphSchema
 *
 * Returns a function that invalidates the graph schema cache.
 * Use this from mutation callbacks (e.g. after saving an ontology change via API).
 */
export function useInvalidateGraphSchema() {
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: GRAPH_SCHEMA_QUERY_KEY })
}
