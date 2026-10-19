import { useQuery } from '@tanstack/react-query'
import { useWorkspaces } from './useWorkspaces'
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'
import { ontologyListKey } from '@/features/ontology/hooks/useOntologies'
import {
    ontologyDefinitionService,
    type OntologyDefinitionResponse,
} from '@/services/ontologyDefinitionService'

export interface DataSourceStats {
    nodeCount: number
    edgeCount: number
    entityTypes: string[]
    /** True when the stats cache is cold and still being computed server-side,
     *  so the UI can show a "computing" state instead of a misleading 0 / dash. */
    computing?: boolean
}

/**
 * The dashboard used to declare its own narrow shape here and fetch
 * /api/v1/admin/ontologies by hand — a SECOND cache of the same endpoint the
 * Semantic Layers page already reads through `useOntologies`. Two caches of one
 * resource drift: publish a layer on that page and the dashboard kept serving
 * the stale copy for its 5-minute staleTime, and the projection threw away every
 * fact worth showing (how many entity types it defines, whether it's published).
 *
 * It is now the SAME record, from the SAME query key, so an edit on the schema
 * page invalidates both.
 */
export type OntologyBrief = OntologyDefinitionResponse

/** @deprecated Use OntologyBrief */
export type BlueprintBrief = OntologyBrief

// Stable empty ref so non-readers (query disabled → data undefined) don't get a
// fresh array identity each render.
const EMPTY_ONTOLOGIES: OntologyBrief[] = []

export function useDashboardData() {
    const { workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces()

    // The dashboard's NUMBERS no longer come from here: totals used to be summed
    // from this workspace list (loaded once at sign-in, so they went stale) plus a
    // bulk stats request this hook fired on EVERY page — useGlobalSearch mounts it
    // inside the always-present command palette. They now come from the server's
    // workspace summary (useWorkspaceSummary), shared with Administration.

    // Ontologies are workspace-scoped reads (the backend filters to the user's
    // visible set): fetch for anyone holding workspace:ontology:read in any
    // workspace, or a platform admin — and skip the request (and its 403)
    // otherwise. Layout templates have their own library (useLayoutTemplates).
    //
    // NOTE: hooks must be called unconditionally (Rules of Hooks) — do
    // NOT short-circuit with `||`. Always call the workspace probe and
    // OR the boolean result.
    const isPlatformAdmin = usePermission('system:admin')
    const hasOntologyRead = useAnyWorkspacePermission('workspace:ontology:read')
    const canReadOntologies = isPlatformAdmin || hasOntologyRead

    // Same query key + same fetcher as `useOntologies` on the Semantic Layers
    // page, so the two share ONE cache entry. The permission gate stays here:
    // without it a user who can't read ontologies fires a pointless 403.
    const ontologiesQuery = useQuery({
        queryKey: ontologyListKey(false),
        enabled: canReadOntologies,
        staleTime: 30_000,
        queryFn: () => ontologyDefinitionService.list(false, false),
    })

    const ontologies = ontologiesQuery.data ?? EMPTY_ONTOLOGIES
    const isLoadingOntologies = ontologiesQuery.isLoading
    const error = (ontologiesQuery.error ?? null) as Error | null

    // NOTE: this hook used to also return `recentViews`, `popularViews` and a
    // `dashboardTier` derived from them. They were placeholders, not data:
    //   recentViews  = views.filter(v => !v.isDefault).slice(0, 8)  ← not recency
    //   popularViews = views.filter(v =>  v.isDefault)              ← not popularity
    // The dashboard now uses the real sources instead — useRecentViews() (server
    // -side per-user visits) and useViewStats() (authoritative catalog counts).

    return {
        workspaces,
        ontologies,
        /** @deprecated Use ontologies */
        blueprints: ontologies,
        isLoading: isLoadingWorkspaces || isLoadingOntologies,
        isLoadingWorkspaces,
        isLoadingOntologies,
        error
    }
}
