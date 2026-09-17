/**
 * The topology reads, shared by the Graph store page and every surface that
 * shows a piece of it (a provider's node list, a data source's placement).
 *
 * The server builds one snapshot per TTL behind a stampede lock, so a page
 * full of viewers costs one pass over the nodes however many components ask.
 * ``keepPreviousData`` everywhere: a failed poll must never blank a page an
 * operator is reading — the figures stay with a note saying how old they are.
 */
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
    graphStoreService,
    type GraphPlacementResponse, type GraphPlacementsResponse,
    type GraphStoreTopologyResponse, type ProviderTopologyResponse,
} from '@/services/graphStoreService'
import { CAPACITY_KEYS } from './useAggregationCapacity'

export const GRAPH_STORE_KEYS = {
    all: ['graph-store'] as const,
    topology: ['graph-store', 'topology'] as const,
    provider: (providerId: string) => ['graph-store', 'provider', providerId] as const,
    placement: (dsId: string) => ['graph-store', 'placement', dsId] as const,
    placements: (ids: string[]) => ['graph-store', 'placements', ids.join(',')] as const,
}

/** Memory moves in minutes; the server's own TTL is 30s. */
export const TOPOLOGY_POLL_MS = 30_000

export function useGraphStoreTopology(enabled = true): UseQueryResult<GraphStoreTopologyResponse, Error> {
    return useQuery<GraphStoreTopologyResponse, Error>({
        queryKey: GRAPH_STORE_KEYS.topology,
        queryFn: () => graphStoreService.getTopology(),
        enabled,
        staleTime: 15_000,
        refetchInterval: TOPOLOGY_POLL_MS,
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

export function useProviderTopology(providerId: string | null, enabled = true): UseQueryResult<ProviderTopologyResponse, Error> {
    return useQuery<ProviderTopologyResponse, Error>({
        queryKey: GRAPH_STORE_KEYS.provider(providerId ?? ''),
        queryFn: () => graphStoreService.getProviderTopology(providerId!),
        enabled: enabled && !!providerId,
        staleTime: 15_000,
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

export function useGraphPlacement(dsId: string | null, enabled = true): UseQueryResult<GraphPlacementResponse, Error> {
    return useQuery<GraphPlacementResponse, Error>({
        queryKey: GRAPH_STORE_KEYS.placement(dsId ?? ''),
        queryFn: () => graphStoreService.getPlacement(dsId!),
        enabled: enabled && !!dsId,
        staleTime: 15_000,
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

/** One request for a whole list of rows — never one per row. */
export function useGraphPlacements(dsIds: string[], enabled = true): UseQueryResult<GraphPlacementsResponse, Error> {
    const ids = [...dsIds].sort()
    return useQuery<GraphPlacementsResponse, Error>({
        queryKey: GRAPH_STORE_KEYS.placements(ids),
        queryFn: () => graphStoreService.getPlacements(ids),
        enabled: enabled && ids.length > 0,
        staleTime: 15_000,
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

/** A "Re-measure": one fresh read of every node, then every consumer
 *  re-reads — capacity included, since both come from the same snapshot. */
export function useRemeasureGraphStore() {
    const qc = useQueryClient()
    return async () => {
        const fresh = await graphStoreService.getTopology(true)
        qc.setQueryData(GRAPH_STORE_KEYS.topology, fresh)
        await Promise.all([
            qc.invalidateQueries({ queryKey: GRAPH_STORE_KEYS.all }),
            qc.invalidateQueries({ queryKey: CAPACITY_KEYS.fleet }),
            qc.invalidateQueries({ queryKey: ['aggregation', 'capacity', 'source'] }),
        ])
        return fresh
    }
}
