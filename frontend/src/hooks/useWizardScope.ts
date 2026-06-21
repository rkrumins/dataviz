/**
 * useWizardScope — composite hook that provides the workspace list and schema
 * availability the View Wizard's ScopeStep needs.
 *
 * Schema availability is determined by whether a data source has an ontologyId
 * assigned (the authoritative source of truth from OntologySchemaPage), NOT by
 * whether a cache endpoint returns data. The cache is a performance detail;
 * the ontology assignment is the contract.
 *
 * Per-data-source stats are fetched separately (and lazily) by
 * `useDataSourceStats`, scoped to the selected workspace's visible sources, so
 * opening the wizard no longer fans out a request for every source in every
 * workspace.
 */

import { useMemo } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
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
    /** Schema availability for the currently selected data source. */
    schemaAvailability: SchemaAvailability
}

export function useWizardScope(
    enabled: boolean,
    /** Currently selected scope — used to determine schema availability. */
    selectedScope?: { workspaceId: string; dataSourceId: string } | null,
): WizardScopeData {
    const workspaces = useWorkspacesStore(s => s.workspaces)

    // Schema availability — authoritative check based on ontology assignment.
    // No HTTP calls needed: the ontologyId is already in the workspace store
    // (loaded from `GET /api/v1/admin/workspaces` at app startup).
    const schemaAvailability: SchemaAvailability = useMemo(() => {
        if (!enabled || !selectedScope?.workspaceId || !selectedScope?.dataSourceId) {
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
    }, [enabled, workspaces, selectedScope?.workspaceId, selectedScope?.dataSourceId])

    return { workspaces, schemaAvailability }
}
