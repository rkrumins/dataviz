/**
 * The capacity reads, shared by every surface that shows them: the Freshness
 * capacity card, the per-source drawer block, the re-trigger fit check, the
 * Defaults dialog's what-if and the Infrastructure page's headroom block.
 *
 * The server caches the fleet reading briefly, so a page full of viewers
 * shares one pass over the nodes; the poll here is slow on purpose — memory
 * moves in minutes, not seconds — and a manual "Re-measure" forces a fresh
 * one.
 *
 * ``keepPreviousData`` is the fix for a card that used to blank itself: one
 * failed poll replaced every row with "capacity could not be measured", and
 * the next poll brought them back. The figures stay on screen with a note
 * saying how old they are.
 */
import { keepPreviousData, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import {
    aggregationService,
    type AggregationCapacityResponse, type SourceCapacityResponse,
} from '@/services/aggregationService'

export const CAPACITY_KEYS = {
    fleet: ['aggregation', 'capacity'] as const,
    source: (dsId: string) => ['aggregation', 'capacity', 'source', dsId] as const,
}

export const CAPACITY_POLL_MS = 30_000

export function useFleetCapacity(enabled = true): UseQueryResult<AggregationCapacityResponse, Error> {
    return useQuery<AggregationCapacityResponse, Error>({
        queryKey: CAPACITY_KEYS.fleet,
        queryFn: () => aggregationService.getFleetCapacity(),
        enabled,
        staleTime: 10_000,
        refetchInterval: CAPACITY_POLL_MS,
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

export function useSourceCapacity(dsId: string | null, enabled = true): UseQueryResult<SourceCapacityResponse, Error> {
    return useQuery<SourceCapacityResponse, Error>({
        queryKey: CAPACITY_KEYS.source(dsId ?? ''),
        queryFn: () => aggregationService.getSourceCapacity(dsId!),
        enabled: enabled && !!dsId,
        staleTime: 10_000,
        placeholderData: keepPreviousData,
        retry: 1,
    })
}

/** A "Re-measure": one fresh sweep on the server, then every consumer
 *  re-reads. Returns the fresh fleet snapshot. */
export function useRemeasureCapacity() {
    const qc = useQueryClient()
    return async () => {
        const fresh = await aggregationService.getFleetCapacity(true)
        qc.setQueryData(CAPACITY_KEYS.fleet, fresh)
        await qc.invalidateQueries({ queryKey: ['aggregation', 'capacity', 'source'] })
        return fresh
    }
}
