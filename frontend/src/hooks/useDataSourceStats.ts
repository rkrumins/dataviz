/**
 * useDataSourceStats — fetch cached node/edge/type counts for a specific set
 * of data sources within a single workspace.
 *
 * Co-located with the ViewWizard ScopeStep so stats are only fetched for the
 * data sources actually being shown (the selected workspace's filtered list),
 * rather than eagerly for every source across every workspace.
 *
 * Returns a map keyed `${wsId}/${dsId}` to match the lookup ScopeStep uses.
 */
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import type { DataSourceStats } from './useDashboardData'

export type { DataSourceStats }

export async function fetchDataSourceStats(wsId: string, dsId: string): Promise<DataSourceStats> {
    const url = `/api/v1/admin/workspaces/${wsId}/datasources/${dsId}/cached-stats`
    const data = await fetchEnveloped<{
        nodeCount?: number
        edgeCount?: number
        entityTypeCounts?: Record<string, number>
    }>(url, { circuitScope: { workspaceId: wsId, dataSourceId: dsId } })
    if (!data) return { nodeCount: 0, edgeCount: 0, entityTypes: [] }
    return {
        nodeCount: data.nodeCount ?? 0,
        edgeCount: data.edgeCount ?? 0,
        entityTypes: Object.keys(data.entityTypeCounts ?? {}),
    }
}

export function useDataSourceStats(
    wsId: string | null,
    dsIds: string[],
): { statsMap: Record<string, DataSourceStats>; isLoading: boolean } {
    const enabled = !!wsId

    const statQueries = useQueries({
        queries: (enabled ? dsIds : []).map(dsId => ({
            queryKey: ['ds-stats', wsId, dsId] as const,
            queryFn: () => fetchDataSourceStats(wsId as string, dsId),
            staleTime: 60_000,
            gcTime: 300_000,
            enabled,
            retry: false,
        })),
    })

    const statsMap = useMemo(() => {
        const map: Record<string, DataSourceStats> = {}
        if (!enabled) return map
        dsIds.forEach((dsId, i) => {
            const q = statQueries[i]
            if (q?.data) map[`${wsId}/${dsId}`] = q.data
        })
        return map
    }, [enabled, wsId, dsIds, statQueries])

    const isLoading = statQueries.some(q => q.isLoading)

    return { statsMap, isLoading }
}
