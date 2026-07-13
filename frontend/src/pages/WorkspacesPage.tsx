import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { fetchEnveloped } from '@/services/cacheEnvelope'
import {
    Database, Plus, AlertTriangle,
    CircleDot, ArrowRightLeft, Eye, Sparkles, Boxes,
} from 'lucide-react'
import { listViews } from '@/services/viewApiService'
import { useAuthStore } from '@/store/auth'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse, type CatalogItemBindingResponse } from '@/services/catalogService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { Link } from 'react-router-dom'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { WorkspaceCard, type WsDataSourceProviderInfo, type WorkspaceSchemaSummary } from '@/components/admin/WorkspaceCard'
import { WorkspaceFilterToolbar, type WorkspaceSortKey, type HealthFilter } from '@/components/admin/workspace/WorkspaceFilterToolbar'
import { WorkspaceListRow } from '@/components/admin/workspace/WorkspaceListRow'
import { WorkspaceCardSkeleton, WorkspaceListRowSkeleton } from '@/components/admin/workspace/WorkspaceCardSkeleton'
import { deriveWorkspaceHealth } from '@/components/admin/workspace/WorkspaceHealthBadge'
import { CreateWorkspaceWizard } from '@/components/admin/CreateWorkspaceWizard'
import { WorkspaceBulkBar } from '@/components/admin/workspace/WorkspaceBulkBar'
import { DangerConfirmDialog } from '@/components/ui/DangerConfirmDialog'
import {
    useWorkspaceDeletion, impactSections, DELETE_CAVEAT,
} from '@/components/admin/workspace/useWorkspaceDeletion'
import { withTimeout } from '@/lib/concurrency'
import { TIMEOUTS } from '@/config/timeouts'
import { useQueryClient } from '@tanstack/react-query'
import { prefetchWorkspaceDetail } from '@/components/admin/workspace/useWorkspaceDetailData'
import { PageContainer } from '@/components/layout/PageContainer'
import { cn } from '@/lib/utils'
import { Check } from 'lucide-react'

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
    return n.toLocaleString()
}

function providerLabel(type: string): string {
    if (type === 'neo4j') return 'Neo4j'
    if (type === 'falkordb') return 'FalkorDB'
    if (type === 'datahub') return 'DataHub'
    return type
}

export function WorkspacesPage() {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const [searchParams, setSearchParams] = useSearchParams()
    // Per-card permission check — read the resolver fn from the auth
    // store so we can call it inline for each row without violating
    // the rules of hooks.
    const can = useAuthStore(s => s.can)
    // Phase 18: providers / catalog / ontologies are now workspace-scoped
    // reads on the backend. Allow the probes for any workspace-bound
    // user; the BE returns the filtered subset they can see.
    const isPlatformAdmin = useAuthStore(s => s.can('system:admin'))
    const canReadProviders = useAuthStore(s => {
        if (s.can('system:admin') || s.can('system:org-admin')) return true
        for (const wsId of Object.keys(s.permissions.ws)) {
            if (s.can('workspace:provider:read', wsId)) return true
        }
        return false
    })
    // Workspace-create button visibility — the POST handler requires
    // system:workspaces:create (workspaces.py:100). Hiding the CTA for
    // users who can't create avoids a wizard-open → submit → 403 dance.
    const canCreateWorkspace = useAuthStore(s => s.can('system:workspaces:create'))

    useDocumentTitle('Workspaces')

    /* ── URL-synced state ── */
    const searchQuery = searchParams.get('q') || ''
    const sortKey = (searchParams.get('sort') as WorkspaceSortKey) || 'newest'
    const layout = (searchParams.get('layout') as 'grid' | 'list') || 'grid'
    const healthFilter = (searchParams.get('health') as HealthFilter) || 'all'

    const setParam = useCallback((key: string, value: string | null) => {
        setSearchParams(prev => {
            const next = new URLSearchParams(prev)
            if (value === null || value === '') next.delete(key)
            else next.set(key, value)
            return next
        }, { replace: true })
    }, [setSearchParams])

    /* ── Debounced search ── */
    const [searchInput, setSearchInput] = useState(searchQuery)
    const searchTimer = useRef<ReturnType<typeof setTimeout>>(null)
    useEffect(() => {
        if (searchTimer.current) clearTimeout(searchTimer.current)
        searchTimer.current = setTimeout(() => {
            const current = searchParams.get('q') ?? ''
            if (searchInput !== current) setParam('q', searchInput || null)
        }, 300)
        return () => { if (searchTimer.current) clearTimeout(searchTimer.current) }
    }, [searchInput])

    /* ── Data fetching state ── */
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [catalogItems, setCatalogItems] = useState<CatalogItemResponse[]>([])
    const [catalogBindings, setCatalogBindings] = useState<CatalogItemBindingResponse[]>([])
    const [dsStats, setDsStats] = useState<Record<string, { nodes: number; edges: number; types: number }>>({})
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [ontologies, setOntologies] = useState<OntologyDefinitionResponse[]>([])
    const [isLoading, setIsLoading] = useState(true)
    /** A provider/catalog/ontology probe failed — the extras on screen may be stale. */
    const [probeFailed, setProbeFailed] = useState(false)

    /* ── Create-workspace wizard ── */
    const [showWizard, setShowWizard] = useState(false)

    const [totalViews, setTotalViews] = useState(0)
    const [viewCountByWs, setViewCountByWs] = useState<Record<string, number>>({})

    /* ── Bulk selection ── */
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

    const toggleSelect = useCallback((wsId: string) => {
        setSelectedIds(prev => {
            const next = new Set(prev)
            if (next.has(wsId)) next.delete(wsId)
            else next.add(wsId)
            return next
        })
    }, [])

    const clearSelection = useCallback(() => setSelectedIds(new Set()), [])

    /* ── Per-workspace provider info map ── */
    const wsProviderInfoMap = useMemo(() => {
        const catMap: Record<string, CatalogItemResponse> = {}
        for (const c of catalogItems) catMap[c.id] = c
        const provMap: Record<string, ProviderResponse> = {}
        for (const p of providers) provMap[p.id] = p
        const ontoMap: Record<string, OntologyDefinitionResponse> = {}
        for (const o of ontologies) ontoMap[o.id] = o

        const result: Record<string, WsDataSourceProviderInfo[]> = {}
        for (const ws of workspaces) {
            const infos: WsDataSourceProviderInfo[] = []
            for (const ds of ws.dataSources || []) {
                const cat = catMap[ds.catalogItemId]
                const prov = cat ? provMap[cat.providerId] : undefined
                const onto = ds.ontologyId ? ontoMap[ds.ontologyId] : undefined
                infos.push({
                    dsId: ds.id,
                    dsLabel: ds.label,
                    isPrimary: ds.isPrimary,
                    providerType: prov?.providerType || 'unknown',
                    providerName: prov?.name || cat?.providerId || 'Unknown',
                    sourceIdentifier: cat?.sourceIdentifier,
                    aggregationStatus: ds.aggregationStatus,
                    ontologyName: onto ? `${onto.name} v${onto.version}` : undefined,
                    entityTypeNames: onto ? Object.keys(onto.entityTypeDefinitions || {}) : [],
                    relationshipTypeNames: onto ? Object.keys(onto.relationshipTypeDefinitions || {}) : [],
                })
            }
            result[ws.id] = infos
        }
        return result
    }, [workspaces, catalogItems, providers, ontologies])

    /* ── Per-workspace schema summary (deduplicated) ── */
    const wsSchemaSummaryMap = useMemo(() => {
        const result: Record<string, WorkspaceSchemaSummary> = {}
        for (const ws of workspaces) {
            const infos = wsProviderInfoMap[ws.id] || []

            const entitySet = new Set<string>()
            const relSet = new Set<string>()
            const ontoSet = new Set<string>()
            const provGroups = new Map<string, { providerType: string; providerName: string; dsCount: number }>()

            for (const info of infos) {
                for (const t of info.entityTypeNames) entitySet.add(t)
                for (const t of info.relationshipTypeNames) relSet.add(t)
                if (info.ontologyName) ontoSet.add(info.ontologyName)

                const existing = provGroups.get(info.providerType)
                if (existing) {
                    existing.dsCount++
                } else {
                    provGroups.set(info.providerType, {
                        providerType: info.providerType,
                        providerName: providerLabel(info.providerType),
                        dsCount: 1,
                    })
                }
            }

            result[ws.id] = {
                uniqueEntityTypes: entitySet.size,
                uniqueRelationshipTypes: relSet.size,
                ontologyNames: Array.from(ontoSet),
                providerGroups: Array.from(provGroups.values()).filter(g => g.providerType !== 'unknown'),
                viewCount: viewCountByWs[ws.id] || 0,
            }
        }
        return result
    }, [workspaces, wsProviderInfoMap, viewCountByWs])

    /* ── Global summary stats (deduplicated) ── */
    const globalSummary = useMemo(() => {
        let totalDs = 0, totalNodes = 0, totalEdges = 0
        const providerCounts: Record<string, number> = {}
        const allEntityTypes = new Set<string>()
        const allRelTypes = new Set<string>()
        const allOntologyNames = new Set<string>()

        for (const ws of workspaces) {
            totalDs += ws.dataSources?.length || 0
            const s = dsStats[ws.id]
            if (s) { totalNodes += s.nodes; totalEdges += s.edges }
        }

        for (const infos of Object.values(wsProviderInfoMap)) {
            for (const info of infos) {
                if (info.providerType && info.providerType !== 'unknown') {
                    providerCounts[info.providerType] = (providerCounts[info.providerType] || 0) + 1
                }
                for (const t of info.entityTypeNames) allEntityTypes.add(t)
                for (const t of info.relationshipTypeNames) allRelTypes.add(t)
                if (info.ontologyName) allOntologyNames.add(info.ontologyName)
            }
        }

        return {
            totalDs,
            totalNodes,
            totalEdges,
            totalEntityTypes: allEntityTypes.size,
            totalRelTypes: allRelTypes.size,
            ontologyCount: allOntologyNames.size,
            providerCounts,
            uniqueProviders: Object.keys(providerCounts),
        }
    }, [workspaces, dsStats, wsProviderInfoMap])

    /* ── Data loading ── */
    const loadData = useCallback(async () => {
        setIsLoading(true)
        try {
            // Per-call timeout so a slow provider listing (or any other
            // slow backend) does not pin the whole workspaces page on
            // a spinner. Render with whatever lists settled in time.
            //
            // Phase 18: catalog / providers / ontology endpoints are now
            // workspace-scoped reads. Fire the probes for any workspace-
            // bound user (the backend filters the response to what their
            // workspaces touch). The ``canReadProviders`` guard skips the
            // call for a user with literally no workspace bindings — they
            // would 403 cleanly anyway.
            const adminProbes: Array<Promise<unknown>> = canReadProviders
                ? [
                    withTimeout(catalogService.list(), TIMEOUTS.ADMIN_LIST_MS, 'catalog.list'),
                    withTimeout(providerService.list(), TIMEOUTS.ADMIN_LIST_MS, 'providers.list'),
                    withTimeout(ontologyDefinitionService.list(), TIMEOUTS.ADMIN_LIST_MS, 'ontology.list'),
                ]
                : [Promise.resolve([]), Promise.resolve([]), Promise.resolve([])]
            const settled = await Promise.allSettled([
                withTimeout(workspaceService.list(), TIMEOUTS.ADMIN_LIST_MS, 'workspaces.list'),
                ...adminProbes,
            ])
            const wsList = settled[0].status === 'fulfilled' ? settled[0].value as WorkspaceResponse[] : ([] as WorkspaceResponse[])
            setWorkspaces(wsList)

            // Keep what we already had when a probe FAILS.
            //
            // These three used to fall back to [] on any rejection — including a
            // timeout, which withTimeout produces routinely on a slow provider. The
            // page then re-rendered as if the estate had no providers, no catalog and
            // no ontologies: the summary silently dropped "Governed by N ontologies"
            // and "Connected via", and every card lost its provider logo and schema
            // chips. Nothing said anything had failed — the UI just quietly asserted
            // a smaller, false world, and only a page reload brought it back.
            //
            // Stale-but-true beats blank-and-false. A failed refresh means "we don't
            // know right now", not "there are none".
            if (settled[1].status === 'fulfilled') setCatalogItems(settled[1].value as CatalogItemResponse[])
            if (settled[2].status === 'fulfilled') setProviders(settled[2].value as ProviderResponse[])
            if (settled[3].status === 'fulfilled') setOntologies(settled[3].value as OntologyDefinitionResponse[])

            const degraded = settled.slice(1).some(r => r.status === 'rejected')
            setProbeFailed(degraded)
            if (degraded) {
                console.warn('[workspaces] provider/catalog/ontology refresh failed; keeping the last known values')
            }

            listViews({ limit: 200 }).then(({ items, total }) => {
                setTotalViews(total)
                const byWs: Record<string, number> = {}
                for (const v of items) { byWs[v.workspaceId] = (byWs[v.workspaceId] || 0) + 1 }
                setViewCountByWs(byWs)
            }).catch(() => {})

            // One bulk request replaces the former per-(workspace, datasource)
            // cached-stats fan-out (44 datasources × loadData re-runs was
            // hundreds of requests). Entries are keyed "<wsId>/<dsId>";
            // status==='computing' rows are cold-cache placeholders (refresh
            // already enqueued server-side) — skipped, same as the old
            // null-on-computing behavior.
            const bulk = await fetchEnveloped<Record<string, {
                status?: string
                nodeCount?: number
                edgeCount?: number
                entityTypeCounts?: Record<string, number>
            }>>('/api/v1/admin/workspaces/datasources/cached-stats').catch(() => null)
            const agg: Record<string, { nodes: number; edges: number; types: Set<string> }> = {}
            for (const [key, entry] of Object.entries(bulk ?? {})) {
                if (entry.status === 'computing') continue
                const wsId = key.slice(0, key.indexOf('/'))
                const a = (agg[wsId] ??= { nodes: 0, edges: 0, types: new Set<string>() })
                a.nodes += entry.nodeCount ?? 0
                a.edges += entry.edgeCount ?? 0
                for (const t of Object.keys(entry.entityTypeCounts ?? {})) a.types.add(t)
            }
            const statsMap: Record<string, { nodes: number; edges: number; types: number }> = {}
            for (const ws of wsList) {
                const a = agg[ws.id]
                statsMap[ws.id] = { nodes: a?.nodes ?? 0, edges: a?.edges ?? 0, types: a?.types.size ?? 0 }
            }
            setDsStats(statsMap)
        } catch (err) { console.error('Failed to load workspaces', err) }
        finally { setIsLoading(false) }
    }, [canReadProviders])

    useEffect(() => { loadData() }, [loadData])

    // Refresh when a permissions change is announced (silent refresh
    // or the 60s poller). Without this, the page keeps showing the
    // pre-revocation workspace list while it's open. The event is
    // dispatched by ``store/permissionChangeBus.notifyPermissionsChanged``.
    useEffect(() => {
        const onChange = () => { void loadData() }
        window.addEventListener('permissions:changed', onChange)
        return () => window.removeEventListener('permissions:changed', onChange)
    }, [loadData])

    useEffect(() => {
        // Wizard catalog picker — only fetch when the wizard is open and
        // the user can actually create workspaces. The bindings endpoint
        // is admin-only; firing it on every page-load for a non-admin
        // would silently 403.
        if (!showWizard || !canCreateWorkspace) return
        catalogService.listWithBindings().then(setCatalogBindings).catch(console.error)
    }, [showWizard, canCreateWorkspace])

    /* ── Actions ── */
    // The old guard was `confirm('Delete this workspace and all its data
    // sources?')` — wrong by omission. The backend cascade also HARD-deletes every
    // VIEW in the workspace (including ones already in the trash awaiting restore),
    // every member's access, and any workspace-scoped custom roles. One line of
    // browser chrome stood between a click and someone else's dashboards.
    const deletion = useWorkspaceDeletion(useCallback(() => {
        clearSelection()
        loadData()
    }, [clearSelection, loadData]))

    const handleDelete = useCallback((wsId: string) => {
        const ws = workspaces.find(w => w.id === wsId)
        if (ws) void deletion.open([ws])
    }, [workspaces, deletion])

    const handleSetDefault = async (wsId: string) => {
        await workspaceService.setDefault(wsId)
        loadData()
    }

    /* ── Client-side filtering + sorting ── */
    const filtered = useMemo(() => {
        let result = workspaces

        if (searchQuery) {
            const q = searchQuery.toLowerCase()
            result = result.filter(ws => ws.name.toLowerCase().includes(q) || ws.description?.toLowerCase().includes(q))
        }

        if (healthFilter !== 'all') {
            result = result.filter(ws => deriveWorkspaceHealth(ws.dataSources || []) === healthFilter)
        }

        result = [...result].sort((a, b) => {
            switch (sortKey) {
                case 'newest': return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
                case 'oldest': return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
                case 'az': return a.name.localeCompare(b.name)
                case 'za': return b.name.localeCompare(a.name)
                case 'most-sources': return (b.dataSources?.length || 0) - (a.dataSources?.length || 0)
                case 'most-entities': return (dsStats[b.id]?.nodes || 0) - (dsStats[a.id]?.nodes || 0)
                default: return 0
            }
        })

        return result
    }, [workspaces, searchQuery, healthFilter, sortKey, dsStats])

    // The pipeline nudge points to /ingestion?tab=providers — a route
    // only platform admins can act on. For non-admins, an empty
    // providers list is expected (they never fetched it), so the nudge
    // would mislead them into clicking a CTA they can't use.
    const showPipelineNudge = !isLoading && isPlatformAdmin && providers.length === 0

    // Live counts per health state. Without these the Health menu offered filters
    // that matched nothing (every workspace was "unknown"), so choosing one just
    // blanked the page.
    const healthCounts = useMemo(() => {
        const counts: Record<string, number> = { all: workspaces.length }
        for (const ws of workspaces) {
            const h = deriveWorkspaceHealth(ws.dataSources || [])
            counts[h] = (counts[h] ?? 0) + 1
        }
        return counts
    }, [workspaces])

    const selectedWorkspaces = useMemo(
        () => workspaces.filter(w => selectedIds.has(w.id)),
        [workspaces, selectedIds],
    )

    // Deleting a workspace needs workspace:admin ON THAT workspace. Offering a
    // bulk delete that would 403 on half the selection is worse than not offering
    // it, so the affordance disappears (with a reason) unless every one qualifies.
    const canDeleteAllSelected = selectedWorkspaces.length > 0
        && selectedWorkspaces.every(w => can('workspace:admin', w.id))

    /* ── Render ── */
    return (
        <div className="absolute inset-0 overflow-y-auto bg-canvas">
        <PageContainer className="py-8 space-y-6 animate-in fade-in duration-500">
            <style>{`
@keyframes card-in {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
}
.ws-card-stagger { animation: card-in 0.3s ease-out both; }
`}</style>

            {/* ── Header ── */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-blue-500/20">
                        <Boxes className="w-5 h-5 text-white" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-ink leading-tight">Workspaces</h1>
                        <p className="text-[11px] text-ink-muted">Your data domains — group sources, govern schemas, and power team views</p>
                    </div>
                </div>
                {canCreateWorkspace && (
                    <button onClick={() => setShowWizard(true)} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200">
                        <Plus className="w-4 h-4" /> Create Workspace
                    </button>
                )}
            </div>

            {/* A failed refresh used to erase the provider/ontology detail silently.
                Now it keeps it and admits it might be stale. */}
            {probeFailed && !isLoading && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] px-4 py-2.5 flex items-center gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                    <p className="text-xs text-ink-muted flex-1">
                        Couldn't refresh provider and semantic-layer details — showing the last known values.
                    </p>
                    <button
                        onClick={() => loadData()}
                        className="text-xs font-semibold text-amber-600 dark:text-amber-400 hover:underline shrink-0"
                    >
                        Retry
                    </button>
                </div>
            )}

            {/* Pipeline nudge when no providers exist */}
            {showPipelineNudge && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4 flex items-start gap-3">
                    <AlertTriangle className="w-5 h-5 text-amber-500 mt-0.5 shrink-0" />
                    <div className="flex-1">
                        <p className="text-sm font-semibold text-ink">No data sources connected yet</p>
                        <p className="text-xs text-ink-muted mt-0.5">
                            A workspace groups connected data sources. Set up your ingestion pipeline first, then create a workspace to use it.
                        </p>
                    </div>
                    <Link
                        to="/ingestion?tab=providers"
                        className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 transition-colors"
                    >
                        Set up Ingestion →
                    </Link>
                </div>
            )}

            {/* ── Summary banner ── */}
            {!isLoading && workspaces.length > 0 && (
                <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                    <div className="h-1 w-full bg-gradient-to-r from-indigo-500 via-violet-500 to-cyan-500" />
                    <div className="p-5">
                        {/* Top row — key metrics */}
                        <div className="flex flex-wrap items-center gap-x-8 gap-y-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                                    <Database className="w-5 h-5 text-indigo-500" />
                                </div>
                                <div>
                                    <div className="text-lg font-bold text-ink">{globalSummary.totalDs}</div>
                                    <div className="text-[10px] text-ink-muted uppercase tracking-wider">Data Sources</div>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                    <CircleDot className="w-5 h-5 text-emerald-500" />
                                </div>
                                <div>
                                    <div className="text-lg font-bold text-ink">{compactNum(globalSummary.totalNodes)}</div>
                                    <div className="text-[10px] text-ink-muted uppercase tracking-wider">Graph Nodes</div>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center">
                                    <ArrowRightLeft className="w-5 h-5 text-violet-500" />
                                </div>
                                <div>
                                    <div className="text-lg font-bold text-ink">{compactNum(globalSummary.totalEdges)}</div>
                                    <div className="text-[10px] text-ink-muted uppercase tracking-wider">Graph Edges</div>
                                </div>
                            </div>

                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                                    <Eye className="w-5 h-5 text-cyan-500" />
                                </div>
                                <div>
                                    <div className="text-lg font-bold text-ink">{totalViews}</div>
                                    <div className="text-[10px] text-ink-muted uppercase tracking-wider">Views</div>
                                </div>
                            </div>

                            {/* Separator + schema types from ontologies */}
                            {(globalSummary.totalEntityTypes > 0 || globalSummary.totalRelTypes > 0) && (
                                <>
                                    <div className="w-px h-10 bg-glass-border hidden lg:block" />
                                    <div>
                                        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">
                                            Governed by {globalSummary.ontologyCount} {globalSummary.ontologyCount === 1 ? 'ontology' : 'ontologies'}
                                        </div>
                                        <div className="flex items-center gap-3">
                                            {globalSummary.totalEntityTypes > 0 && (
                                                <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
                                                    <span className="w-2 h-2 rounded-full bg-amber-400" />
                                                    <span className="font-bold text-ink">{globalSummary.totalEntityTypes}</span> entity types
                                                </span>
                                            )}
                                            {globalSummary.totalRelTypes > 0 && (
                                                <span className="flex items-center gap-1.5 text-xs text-ink-secondary">
                                                    <span className="w-2 h-2 rounded-full bg-indigo-400" />
                                                    <span className="font-bold text-ink">{globalSummary.totalRelTypes}</span> relationship types
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                </>
                            )}

                            {/* Providers */}
                            {globalSummary.uniqueProviders.length > 0 && (
                                <>
                                    <div className="w-px h-10 bg-glass-border hidden lg:block" />
                                    <div>
                                        <div className="text-[10px] text-ink-muted uppercase tracking-wider mb-1.5">Connected via</div>
                                        <div className="flex items-center gap-2">
                                            {globalSummary.uniqueProviders.map(pt => {
                                                const Logo = getProviderLogo(pt)
                                                return (
                                                    <span key={pt} className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-[11px] font-medium text-ink-secondary">
                                                        <Logo className="w-4 h-4" />
                                                        {providerLabel(pt)}
                                                        <span className="text-ink-muted/70">{globalSummary.providerCounts[pt]}</span>
                                                    </span>
                                                )
                                            })}
                                        </div>
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Marketing-style tagline */}
                        <div className="mt-4 pt-4 border-t border-glass-border/50 flex items-center gap-2">
                            <Sparkles className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                            <p className="text-xs text-ink-muted">
                                {globalSummary.totalNodes > 0 && (
                                    <span>Your workspaces manage <span className="font-semibold text-ink">{compactNum(globalSummary.totalNodes)} nodes</span> and <span className="font-semibold text-ink">{compactNum(globalSummary.totalEdges)} edges</span></span>
                                )}
                                {globalSummary.totalEntityTypes > 0 && (
                                    <span>{globalSummary.totalNodes > 0 ? ', classified into ' : 'Classified into '}<span className="font-semibold text-ink">{globalSummary.totalEntityTypes} entity types</span> and <span className="font-semibold text-ink">{globalSummary.totalRelTypes} relationship types</span> via ontologies</span>
                                )}
                                {totalViews > 0 && (
                                    <span>{globalSummary.totalNodes > 0 || globalSummary.totalEntityTypes > 0 ? ', powering ' : 'Powering '}<Link to="/explorer" className="font-semibold text-indigo-500 hover:underline">{totalViews} view{totalViews !== 1 ? 's' : ''}</Link> for your team</span>
                                )}
                                {(globalSummary.totalNodes > 0 || globalSummary.totalEntityTypes > 0 || totalViews > 0) && <span>.</span>}
                            </p>
                        </div>
                    </div>
                </div>
            )}

            {/* Select-all lived only in the list header, so in grid view bulk
                selection had no entry point at all. */}
            {!isLoading && filtered.length > 0 && (
                <div className="flex items-center justify-between gap-3 -mb-2">
                    <button
                        type="button"
                        onClick={() => {
                            const allSelected = filtered.every(w => selectedIds.has(w.id))
                            setSelectedIds(allSelected ? new Set() : new Set(filtered.map(w => w.id)))
                        }}
                        className="inline-flex items-center gap-2 text-xs font-semibold text-ink-muted hover:text-ink transition-colors"
                    >
                        <span className={cn(
                            'w-[18px] h-[18px] rounded-[5px] border-2 flex items-center justify-center transition-colors',
                            filtered.length > 0 && filtered.every(w => selectedIds.has(w.id))
                                ? 'bg-indigo-500 border-indigo-500'
                                : selectedIds.size > 0
                                    ? 'border-indigo-400/70'
                                    : 'border-ink-muted/35 hover:border-indigo-500',
                        )}>
                            {filtered.length > 0 && filtered.every(w => selectedIds.has(w.id))
                                ? <Check className="w-3 h-3 text-white" strokeWidth={3} />
                                // Partial selection reads as a dash, not a tick.
                                : selectedIds.size > 0
                                    ? <span className="w-2 h-0.5 rounded-full bg-indigo-400" />
                                    : null}
                        </span>
                        {selectedIds.size > 0
                            ? `${selectedIds.size} selected`
                            : `Select all ${filtered.length}`}
                    </button>

                    {selectedIds.size > 0 && (
                        <button
                            type="button"
                            onClick={clearSelection}
                            className="text-xs font-medium text-ink-muted hover:text-ink transition-colors"
                        >
                            Clear
                        </button>
                    )}
                </div>
            )}

            {/* ── Filter toolbar ── */}
            <WorkspaceFilterToolbar
                search={searchInput}
                onSearchChange={setSearchInput}
                sort={sortKey}
                onSortChange={s => setParam('sort', s === 'newest' ? null : s)}
                layout={layout}
                onLayoutChange={l => setParam('layout', l === 'grid' ? null : l)}
                healthFilter={healthFilter}
                onHealthFilterChange={h => setParam('health', h === 'all' ? null : h)}
                healthCounts={healthCounts}
                totalCount={workspaces.length}
                filteredCount={filtered.length}
            />

            {/* Content */}
            {isLoading ? (
                layout === 'grid' ? (
                    <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                        {Array.from({ length: 6 }).map((_, i) => <WorkspaceCardSkeleton key={i} />)}
                    </div>
                ) : (
                    <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                        {Array.from({ length: 6 }).map((_, i) => <WorkspaceListRowSkeleton key={i} />)}
                    </div>
                )
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Database className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">{searchQuery ? 'No matching workspaces' : 'No workspaces yet'}</h3>
                    <p className="text-sm text-ink-muted">{searchQuery ? 'Try a different search term' : 'Create a workspace to get started'}</p>
                </div>
            ) : layout === 'grid' ? (
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filtered.map((ws, i) => (
                        <div key={ws.id} className="ws-card-stagger" style={{ animationDelay: `${Math.min(i * 40, 300)}ms` }}>
                            <WorkspaceCard
                                ws={ws}
                                isSelected={selectedIds.has(ws.id)}
                                onToggleSelect={() => toggleSelect(ws.id)}
                                selectionActive={selectedIds.size > 0}
                                stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                                healthStatus={deriveWorkspaceHealth(ws.dataSources || [])}
                                dsProviders={wsProviderInfoMap[ws.id] || []}
                                schemaSummary={wsSchemaSummaryMap[ws.id] || { uniqueEntityTypes: 0, uniqueRelationshipTypes: 0, ontologyNames: [], providerGroups: [], viewCount: 0 }}
                                onOpen={() => navigate(`/workspaces/${ws.id}`)}
                                onPrefetch={() => prefetchWorkspaceDetail(queryClient, ws.id)}
                                onDelete={() => handleDelete(ws.id)}
                                onSetDefault={() => handleSetDefault(ws.id)}
                                onManageMembers={
                                    can('workspace:admin', ws.id)
                                        ? () => navigate(`/workspaces/${ws.id}?tab=members`)
                                        : undefined
                                }
                            />
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                    <div className="grid grid-cols-[20px_16px_32px_minmax(0,2fr)_100px_70px_80px_80px_60px_90px_72px] gap-3 px-4 py-2.5 border-b border-glass-border/50 text-[10px] uppercase tracking-wider text-ink-muted font-bold">
                        {/* Select-all: the fastest way to bulk-act, and it selects only
                            what's currently FILTERED — not the whole catalogue. */}
                        <button
                            type="button"
                            onClick={() => {
                                const allSelected = filtered.length > 0 && filtered.every(w => selectedIds.has(w.id))
                                setSelectedIds(allSelected ? new Set() : new Set(filtered.map(w => w.id)))
                            }}
                            aria-label="Select all workspaces"
                            className="w-4 h-4 rounded border border-glass-border bg-canvas hover:border-indigo-500 transition-colors"
                        />
                        <span></span><span></span><span>Name</span><span>Providers</span><span>Sources</span><span>Nodes</span><span>Edges</span><span>Types</span><span>Updated</span><span></span>
                    </div>
                    {filtered.map((ws, i) => (
                        <WorkspaceListRow
                            key={ws.id}
                            ws={ws}
                            index={i}
                            isSelected={selectedIds.has(ws.id)}
                            onToggleSelect={() => toggleSelect(ws.id)}
                            stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                            healthStatus={deriveWorkspaceHealth(ws.dataSources || [])}
                            dsProviders={wsProviderInfoMap[ws.id] || []}
                            onOpen={() => navigate(`/workspaces/${ws.id}`)}
                            onPrefetch={() => prefetchWorkspaceDetail(queryClient, ws.id)}
                            onDelete={() => handleDelete(ws.id)}
                            onSetDefault={() => handleSetDefault(ws.id)}
                            onManageMembers={
                                can('workspace:admin', ws.id)
                                    ? () => navigate(`/workspaces/${ws.id}?tab=members`)
                                    : undefined
                            }
                        />
                    ))}
                </div>
            )}

            {/* Bulk selection bar */}
            <WorkspaceBulkBar
                selectedCount={selectedIds.size}
                onDelete={canDeleteAllSelected ? () => void deletion.open(selectedWorkspaces) : undefined}
                onClearSelection={clearSelection}
                blockedReason="You can only delete workspaces you administer"
            />

            {/* Delete — single or bulk, same honest blast radius */}
            <DangerConfirmDialog
                isOpen={!!deletion.target}
                title={
                    (deletion.target?.workspaces.length ?? 0) > 1
                        ? `Delete ${deletion.target?.workspaces.length} workspaces`
                        : 'Delete workspace'
                }
                subtitle={
                    (deletion.target?.workspaces.length ?? 0) > 1
                        ? deletion.target?.workspaces.map(w => w.name).join(', ')
                        : deletion.target?.workspaces[0]?.name
                }
                // Bulk can't ask you to type N names, so it asks for the count —
                // the same phrase the Explorer's bulk delete uses.
                confirmPhrase={
                    (deletion.target?.workspaces.length ?? 0) > 1
                        ? `delete ${deletion.target?.workspaces.length}`
                        : deletion.target?.workspaces[0]?.name ?? ''
                }
                confirmLabel={
                    (deletion.target?.workspaces.length ?? 0) > 1
                        ? `Delete ${deletion.target?.workspaces.length} workspaces`
                        : 'Delete workspace'
                }
                sections={impactSections(deletion.target?.impact ?? null)}
                loadingImpact={deletion.target?.loading}
                safeMessage="This workspace is empty — no views, data sources or members will be lost."
                caveat={DELETE_CAVEAT}
                onClose={deletion.close}
                onConfirm={deletion.confirm}
            />

            {/* Create Workspace — the premium shell, not the old AdminWizard */}
            <CreateWorkspaceWizard
                isOpen={showWizard}
                onClose={() => setShowWizard(false)}
                onCreated={ws => { loadData(); navigate(`/workspaces/${ws.id}`) }}
                existingWorkspaces={workspaces}
                catalogItems={catalogBindings}
                providers={providers}
            />
        </PageContainer>
        </div>
    )
}