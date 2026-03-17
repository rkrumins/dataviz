/**
 * React Query hook for fetching and caching the graph schema from the backend.
 *
 * Replaces the ad-hoc fetch + mergeBackendSchema() pattern in App.tsx / AppLayout.tsx.
 * The query result is synced into the Zustand schema store so existing components
 * that read from useSchemaStore() continue to work without changes.
 *
 * Design:
 * - Single query per provider instance (stale while revalidate, 5 min stale time)
 * - On success: calls store.loadFromBackend() (no more manual mergeBackendSchema)
 * - On error: falls back to defaultWorkspaceSchema if no schema is loaded yet
 * - Returns {isLoading, isError, error} so callers can render skeleton/error states
 */
import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { useSchemaStore } from '@/store/schema'
import { defaultWorkspaceSchema } from '@/lib/default-schema'
import type { GraphSchema } from '@/providers/GraphDataProvider'

export const GRAPH_SCHEMA_QUERY_KEY = ['graph', 'schema'] as const

async function fetchGraphSchema(provider: ReturnType<typeof useGraphProvider>): Promise<GraphSchema> {
  return provider.getFullSchema()
}

/**
 * useGraphSchema
 *
 * Fetches the graph schema once per session (5 min stale time) and syncs it
 * into the Zustand schema store. Falls back to defaultWorkspaceSchema on error.
 *
 * Call this once from the top-level authenticated layout (AppLayout or App).
 * Child components read schema from useSchemaStore() as before.
 */
export function useGraphSchema() {
  const provider = useGraphProvider()
  // Read actions once — they are stable references (Zustand guarantees this)
  const loadFromBackend = useSchemaStore(s => s.loadFromBackend)
  const loadSchema = useSchemaStore(s => s.loadSchema)
  const queryClient = useQueryClient()

  const query = useQuery({
    queryKey: [...GRAPH_SCHEMA_QUERY_KEY, provider],
    queryFn: () => fetchGraphSchema(provider),
    staleTime: 5 * 60 * 1000,   // 5 minutes — matches backend _ONTOLOGY_CACHE_TTL
    gcTime: 10 * 60 * 1000,     // 10 minutes garbage collection
    retry: 2,
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
      const currentSchema = useSchemaStore.getState().schema
      if (currentSchema?.id === defaultWorkspaceSchema.id) return
      loadSchema(defaultWorkspaceSchema)
    }
  }, [query.data, query.isError, loadFromBackend, loadSchema])

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
