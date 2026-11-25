/**
 * The entity types a data source's semantic layer declares — for a source in
 * ANY of the caller's workspaces, not only the active one.
 *
 * Matching a layout template to data (how well it fits, what its update means
 * for a view) has to speak that data's spelling. `useDataSourceSchema` reads
 * through the active workspace's provider, which refuses a source from another
 * workspace; this asks that workspace's own provider. Same cache key, because
 * it is the same answer whichever provider fetched it.
 */
import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { fitTargetOf, type FitTarget } from '@/components/templates/templateFit'
import { getOrCreateProvider } from '@/providers/providerPool'
import { convertBackendEntityType, convertBackendRelationshipType } from '@/store/schema'

export function useWorkspaceEntityTypes(workspaceId?: string | null, dataSourceId?: string | null) {
    const enabled = !!workspaceId && !!dataSourceId
    const query = useQuery({
        queryKey: ['graph', 'schema', 'ds', dataSourceId ?? '__default__'],
        queryFn: () => getOrCreateProvider(workspaceId!, dataSourceId!).getFullSchema(dataSourceId!),
        enabled,
        staleTime: 5 * 60 * 1000,
        gcTime: 10 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: false,
    })
    const types = useMemo(
        () => (query.data ? (query.data.entityTypes ?? []).map(t => convertBackendEntityType(t).id) : null),
        [query.data],
    )
    /** What a template is fitted to on this source, the way the view wizard fits it. */
    const target = useMemo((): FitTarget | null => (query.data ? fitTargetOf({
        entityTypes: (query.data.entityTypes ?? []).map(convertBackendEntityType),
        relationshipTypes: (query.data.relationshipTypes ?? []).map(convertBackendRelationshipType),
        rootEntityTypes: query.data.rootEntityTypes ?? [],
        containmentEdgeTypes: query.data.containmentEdgeTypes ?? [],
    }) : null), [query.data])
    return { types, target, isLoading: enabled && query.isLoading, isError: query.isError }
}
