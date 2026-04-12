/**
 * useWizardScope — composite hook that provides everything the View Wizard's
 * ScopeStep needs: workspace list + per-data-source cached stats + schema
 * availability based on authoritative ontology assignment.
 *
 * Schema availability is determined by whether a data source has an ontologyId
 * assigned (the authoritative source of truth from OntologySchemaPage), NOT by
 * whether a cache endpoint returns data. The cache is a performance detail;
 * the ontology assignment is the contract.
 *
 * Phase 1: composes from existing endpoints (workspace store + cached-stats).
 * Phase 2 (future): swap to a single backend `/api/v1/views/wizard/scope`
 *                    endpoint — this hook is the only file that changes.
 */

import { useMemo } from 'react'
import { useQueries } from '@tanstack/react-query'
import { useWorkspacesStore } from '@/store/workspaces'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import type { DataSourceStats } from './useDashboardData'

export type { DataSourceStats }

export interface SchemaAvailability {
    /** True if the data source has an ontology assigned (authoritative). */
    hasOntology: boolean
    /** Human-readable status for display. */
    status: 'ready' | 'no-ontology' | 'none-selected'
    /** Message describing the schema status. */
    message: string | null
}

export interface WizardScopeData {
    workspaces: ReturnType<typeof useWorkspacesStore.getState>['workspaces']
    statsMap: Record<string, DataSourceStats>
    isLoading: boolean
    /** Schema availability for the currently selected data source. */
    schemaAvailability: SchemaAvailability
}

async function fetchDataSourceStats(wsId: string, dsId: string): Promise<DataSourceStats> {
    const url = `/api/v1/admin/workspaces/${wsId}/datasources/${dsId}/cached-stats`
    const res = await fetchWithTimeout(url)
    if (!res.ok) return { nodeCount: 0, edgeCount: 0, entityTypes: [] }
    const data = await res.json()
    return {
        nodeCount: data.nodeCount ?? 0,
        edgeCount: data.edgeCount ?? 0,
        entityTypes: Object.keys(data.entityTypeCounts ?? {}),
    }
}

export function useWizardScope(
    enabled: boolean,
    /** Currently selected scope — used to determine schema availability. */
    selectedScope?: { workspaceId: string; dataSourceId: string } | null,
): WizardScopeData {
    const workspaces = useWorkspacesStore(s => s.workspaces)

    // Build a flat list of all (wsId, dsId) pairs for querying stats
    const dsPairs = useMemo(() => {
        if (!enabled) return []
        return workspaces.flatMap(ws =>
            (ws.dataSources ?? []).map(ds => ({ wsId: ws.id, dsId: ds.id }))
        )
    }, [workspaces, enabled])

    const statQueries = useQueries({
        queries: dsPairs.map(({ wsId, dsId }) => ({
            queryKey: ['ds-stats', wsId, dsId] as const,
            queryFn: () => fetchDataSourceStats(wsId, dsId),
            staleTime: 60_000,
            gcTime: 300_000,
            enabled,
            retry: false,
        })),
    })

    const statsMap = useMemo(() => {
        const map: Record<string, DataSourceStats> = {}
        dsPairs.forEach((pair, i) => {
            const q = statQueries[i]
            if (q?.data) {
                map[`${pair.wsId}/${pair.dsId}`] = q.data
            }
        })
        return map
    }, [dsPairs, statQueries])

    const isLoading = statQueries.some(q => q.isLoading)

    // Schema availability — authoritative check based on ontology assignment.
    // No HTTP calls needed: the ontologyId is already in the workspace store
    // (loaded from `GET /api/v1/admin/workspaces` at app startup).
    const schemaAvailability: SchemaAvailability = useMemo(() => {
        if (!selectedScope?.workspaceId || !selectedScope?.dataSourceId) {
            return { hasOntology: false, status: 'none-selected', message: null }
        }
        const ws = workspaces.find(w => w.id === selectedScope.workspaceId)
        const ds = ws?.dataSources?.find(d => d.id === selectedScope.dataSourceId)
        if (!ds) {
            return { hasOntology: false, status: 'none-selected', message: null }
        }
        if (ds.ontologyId) {
            return {
                hasOntology: true,
                status: 'ready',
                message: null,
            }
        }
        return {
            hasOntology: false,
            status: 'no-ontology',
            message: 'No semantic layer (ontology) assigned. Entity type filtering will be limited.',
        }
    }, [workspaces, selectedScope?.workspaceId, selectedScope?.dataSourceId])

    return { workspaces, statsMap, isLoading, schemaAvailability }
}
