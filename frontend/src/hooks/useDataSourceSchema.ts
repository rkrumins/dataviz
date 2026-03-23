/**
 * useDataSourceSchema - Fetch graph schema scoped to a specific data source.
 *
 * A view is always created for a specific data source that has a specific
 * ontology assigned. This hook fetches the schema for that data source so
 * wizard steps show only the entity and relationship types relevant to the
 * active ontology — not the global workspace schema.
 *
 * The result is kept in react-query's cache keyed by dataSourceId, so
 * switching between data sources is fast (stale-while-revalidate).
 *
 * Usage:
 *   const { entityTypes, relationshipTypes, containmentEdgeTypes, isLoading } =
 *     useDataSourceSchema(formData.dataSourceId)
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useGraphProvider } from '@/providers/GraphProviderContext'
import { convertBackendEntityType, convertBackendRelationshipType } from '@/store/schema'
import type { EntityTypeSchema, RelationshipTypeSchema } from '@/types/schema'

export interface DataSourceSchemaResult {
  entityTypes: EntityTypeSchema[]
  relationshipTypes: RelationshipTypeSchema[]
  containmentEdgeTypes: string[]
  lineageEdgeTypes: string[]
  rootEntityTypes: string[]
  isLoading: boolean
  isError: boolean
}

const EMPTY: DataSourceSchemaResult = {
  entityTypes: [],
  relationshipTypes: [],
  containmentEdgeTypes: [],
  lineageEdgeTypes: [],
  rootEntityTypes: [],
  isLoading: false,
  isError: false,
}

/**
 * Fetch schema for a specific data source (and its assigned ontology).
 *
 * When `dataSourceId` is undefined or empty, fetches the default workspace schema.
 */
export function useDataSourceSchema(dataSourceId?: string): DataSourceSchemaResult {
  const provider = useGraphProvider()

  const query = useQuery({
    queryKey: ['graph', 'schema', 'ds', dataSourceId ?? '__default__'],
    queryFn: () => provider.getFullSchema(dataSourceId || undefined),
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    retry: 2,
    refetchOnWindowFocus: false,
  })

  return useMemo(() => {
    if (query.isLoading) return { ...EMPTY, isLoading: true }
    if (query.isError || !query.data) return { ...EMPTY, isError: !!query.isError }

    const schema = query.data
    return {
      entityTypes: (schema.entityTypes ?? []).map(convertBackendEntityType),
      relationshipTypes: (schema.relationshipTypes ?? []).map(convertBackendRelationshipType),
      containmentEdgeTypes: schema.containmentEdgeTypes ?? [],
      lineageEdgeTypes: schema.lineageEdgeTypes ?? [],
      rootEntityTypes: schema.rootEntityTypes ?? [],
      isLoading: false,
      isError: false,
    }
  }, [query.isLoading, query.isError, query.data])
}
