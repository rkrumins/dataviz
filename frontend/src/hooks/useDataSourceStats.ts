/**
 * useDataSourceStats — fetch cached node/edge/type counts for a specific set
 * of data sources.
 *
 * Takes (workspace, source) PAIRS rather than one workspace + many sources: the
 * wizard can now search across every workspace at once, so the sources on screen
 * no longer share a parent. The stats endpoint is per-(workspace, source), so the
 * pair is the real unit.
 *
 * Only the sources actually being shown are fetched — never eagerly for the whole
 * estate. Returns a map keyed `${wsId}/${dsId}`.
 */
import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import type { DataSourceStats } from './useDashboardData'

export type { DataSourceStats }

/** A data source, plus the workspace it lives in (its stats key). */
export interface DataSourceRef {
    workspaceId: string
    dataSourceId: string
}

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
    refs: DataSourceRef[],
): { statsMap: Record<string, DataSourceStats>; isLoading: boolean } {
    const statQueries = useQueries({
        queries: refs.map(({ workspaceId, dataSourceId }) => ({
            queryKey: ['ds-stats', workspaceId, dataSourceId] as const,
            queryFn: () => fetchDataSourceStats(workspaceId, dataSourceId),
            staleTime: 60_000,
            gcTime: 300_000,
            retry: false,
        })),
    })

    const statsMap = useMemo(() => {
        const map: Record<string, DataSourceStats> = {}
        refs.forEach(({ workspaceId, dataSourceId }, i) => {
            const q = statQueries[i]
            if (q?.data) map[`${workspaceId}/${dataSourceId}`] = q.data
        })
        return map
    }, [refs, statQueries])

    const isLoading = statQueries.some(q => q.isLoading)

    return { statsMap, isLoading }
}
