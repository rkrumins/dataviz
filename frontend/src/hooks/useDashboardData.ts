import { useState, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWorkspaces } from './useWorkspaces'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { withTimeout } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'
import { usePermission, useAnyWorkspacePermission } from '@/store/auth'

export interface DashboardStats {
    totalWorkspaces: number
    totalDataSources: number
    totalEntities: number
}

export interface DataSourceStats {
    nodeCount: number
    edgeCount: number
    entityTypes: string[]
    /** True when the stats cache is cold and still being computed server-side,
     *  so the UI can show a "computing" state instead of a misleading 0 / dash. */
    computing?: boolean
}

export interface TemplateBrief {
    id: string
    name: string
    description?: string
    category?: string
    entityTypesCount?: number
}

export interface OntologyBrief {
    id: string
    name: string
    description?: string
    version?: number
    isPublished?: boolean
    createdAt?: string
}

/** @deprecated Use OntologyBrief */
export type BlueprintBrief = OntologyBrief

// Stable empty refs so non-admins (query disabled → data undefined) don't get a
// fresh array identity each render.
const EMPTY_TEMPLATES: TemplateBrief[] = []
const EMPTY_ONTOLOGIES: OntologyBrief[] = []

export function useDashboardData() {
    const { workspaces, isLoading: isLoadingWorkspaces } = useWorkspaces()

    const [stats, setStats] = useState<DashboardStats>({
        totalWorkspaces: 0,
        totalDataSources: 0,
        totalEntities: 0,
    })

    // Per-datasource node/edge counts: key = "${wsId}/${dsId}"
    const [dataSourceStats, setDataSourceStats] = useState<Record<string, DataSourceStats>>({})

    // templates / ontologies + their loading + error are React Query-derived
    // below (was raw useState + a refetch-from-scratch-on-mount effect, which
    // re-spun the dashboard every visit; now stale-while-revalidate cached).

    // Calculate high level stats whenever workspaces change
    useEffect(() => {
        if (workspaces) {
            let dsCount = 0
            workspaces.forEach(ws => {
                if (ws.dataSources) dsCount += ws.dataSources.length
            })

            setStats(prev => ({
                ...prev,
                totalWorkspaces: workspaces.length,
                totalDataSources: dsCount,
            }))
        }
    }, [workspaces])

    // Fetch per-datasource graph stats (node + edge counts).
    //
    // React Query, NOT a per-instance effect: useDashboardData is mounted
    // by several components at once (Dashboard, WorkspaceGrid, InsightCards,
    // TemplateGrid, and one DataSourceCard / DataSourceGridCard PER card on
    // admin pages). A per-instance fetch fires a duplicate
    // workspaces×datasources fan-out for EVERY instance on mount — the
    // "hundreds of cached-stats requests" storm. One query keyed on the
    // ws/ds id-set means all instances share a single fan-out and cache;
    // identity churn on the workspaces array is harmless (same key → no
    // new requests).
    const statsKey = useMemo(
        () => (workspaces ?? [])
            .map(ws => `${ws.id}:${(ws.dataSources ?? []).map(d => d.id).sort().join(',')}`)
            .sort()
            .join('|'),
        [workspaces],
    )
    const dsStatsQuery = useQuery({
        queryKey: ['dashboard-datasource-stats', statsKey],
        enabled: !!workspaces?.length,
        staleTime: 30_000,
        queryFn: async () => {
            // One bulk request (DB-only, two SQL queries server-side)
            // replaces the former workspaces×datasources fan-out over the
            // per-ds /cached-stats endpoint. Entries are keyed
            // "<wsId>/<dsId>" — the same shape consumers already read.
            // status==='computing' rows are cold-cache placeholders (the
            // backend has already enqueued their refresh); skipping them
            // matches the old null-on-computing behavior.
            const data = await withTimeout(
                fetchEnveloped<Record<string, {
                    status?: string
                    nodeCount?: number
                    edgeCount?: number
                    entityTypeCounts?: Record<string, number>
                }>>('/api/v1/admin/workspaces/datasources/cached-stats'),
                TIMEOUTS.ADMIN_LIST_MS,
                'dashboard.cached-stats.bulk',
            )

            const results: Record<string, DataSourceStats> = {}
            let totalEntities = 0
            for (const [key, entry] of Object.entries(data ?? {})) {
                if (entry.status === 'computing') continue
                const nodeCount = entry.nodeCount ?? 0
                results[key] = {
                    nodeCount,
                    edgeCount: entry.edgeCount ?? 0,
                    entityTypes: Object.keys(entry.entityTypeCounts ?? {}),
                }
                totalEntities += nodeCount
            }
            return { results, totalEntities }
        },
    })

    // Sync the shared query result into the hook's existing state shape so
    // consumers keep their current API (dataSourceStats + stats.totalEntities).
    const dsStatsData = dsStatsQuery.data
    useEffect(() => {
        if (!dsStatsData) return
        setDataSourceStats(dsStatsData.results)
        setStats(prev => ({ ...prev, totalEntities: dsStatsData.totalEntities }))
    }, [dsStatsData])

    // Phase 17: Templates + Ontologies live behind system:admin gates.
    // Skip the fetch entirely for non-admins — the dashboard tiles and
    // the global-search Template/Semantic-Layer categories already
    // handle empty arrays, so the UI stays consistent (just no admin
    // probe + no 403 in the console). Re-fires when the claim flips
    // (login, silent-refresh after promotion). ``silent403`` is kept
    // as belt-and-suspenders in the rare case admin demotion races a
    // refresh while the effect is mid-flight.
    const isPlatformAdmin = usePermission('system:admin')
    // Phase 18: ontologies are now workspace-scoped reads (backend
    // filters to the user's visible set). Allow the fetch for anyone
    // holding workspace:ontology:read in any workspace. Templates stay
    // platform-admin (no workspace-scoped read path on the backend).
    //
    // NOTE: hooks must be called unconditionally (Rules of Hooks) — do
    // NOT short-circuit with `||`. Always call the workspace probe and
    // OR the boolean result.
    const hasOntologyRead = useAnyWorkspacePermission('workspace:ontology:read')
    const canReadOntologies = isPlatformAdmin || hasOntologyRead

    const templatesQuery = useQuery({
        queryKey: ['dashboard', 'templates'],
        enabled: isPlatformAdmin,
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
            const res = await fetchWithTimeout('/api/v1/admin/context-model-templates', { silent403: true })
            return res.ok ? (((await res.json()) as TemplateBrief[]) ?? EMPTY_TEMPLATES) : EMPTY_TEMPLATES
        },
    })

    const ontologiesQuery = useQuery({
        queryKey: ['dashboard', 'ontologies'],
        enabled: canReadOntologies,
        staleTime: 5 * 60 * 1000,
        queryFn: async () => {
            const res = await fetchWithTimeout('/api/v1/admin/ontologies', { silent403: true })
            return res.ok ? (((await res.json()) as OntologyBrief[]) ?? EMPTY_ONTOLOGIES) : EMPTY_ONTOLOGIES
        },
    })

    const templates = templatesQuery.data ?? EMPTY_TEMPLATES
    const ontologies = ontologiesQuery.data ?? EMPTY_ONTOLOGIES
    const isLoadingTemplates = templatesQuery.isLoading
    const isLoadingOntologies = ontologiesQuery.isLoading
    // Matches the old single `error` state, which only tracked templates/
    // ontologies fetch failures (dsStats errors were never surfaced here).
    const error = (templatesQuery.error ?? ontologiesQuery.error ?? null) as Error | null

    // NOTE: this hook used to also return `recentViews`, `popularViews` and a
    // `dashboardTier` derived from them. They were placeholders, not data:
    //   recentViews  = views.filter(v => !v.isDefault).slice(0, 8)  ← not recency
    //   popularViews = views.filter(v =>  v.isDefault)              ← not popularity
    // The dashboard now uses the real sources instead — useRecentViews() (server
    // -side per-user visits) and useViewStats() (authoritative catalog counts).

    return {
        stats,
        dataSourceStats,
        workspaces,
        templates,
        ontologies,
        /** @deprecated Use ontologies */
        blueprints: ontologies,
        isLoading: isLoadingWorkspaces || isLoadingTemplates || isLoadingOntologies,
        isLoadingWorkspaces,
        isLoadingTemplates,
        isLoadingOntologies,
        error
    }
}
