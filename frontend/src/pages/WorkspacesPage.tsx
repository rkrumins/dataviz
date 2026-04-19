import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import {
    Database, Plus, Edit2, Settings, AlertTriangle,
    CircleDot, ArrowRightLeft, Eye, Sparkles, Boxes,
} from 'lucide-react'
import { listViews } from '@/services/viewApiService'
import { workspaceService, type WorkspaceResponse, type WorkspaceCreateRequest } from '@/services/workspaceService'
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
import { AdminWizard, type WizardStep } from '@/components/admin/AdminWizard'

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
    const [searchParams, setSearchParams] = useSearchParams()

    useEffect(() => {
        document.title = 'Workspaces · Synodic'
    }, [])

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

    /* ── Wizard state ── */
    const [showWizard, setShowWizard] = useState(false)
    const [wizName, setWizName] = useState('')
    const [wizDesc, setWizDesc] = useState('')
    const [wizCatalogItemId, setWizCatalogItemId] = useState('')
    const [wizDsLabel, setWizDsLabel] = useState('')
    const [wizSubmitting, setWizSubmitting] = useState(false)

    const [totalViews, setTotalViews] = useState(0)
    const [viewCountByWs, setViewCountByWs] = useState<Record<string, number>>({})

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
            const [wsList, catList, provList, ontoList] = await Promise.all([
                workspaceService.list(),
                catalogService.list(),
                providerService.list(),
                ontologyDefinitionService.list().catch(() => [] as OntologyDefinitionResponse[]),
            ])
            setWorkspaces(wsList)
            setCatalogItems(catList)
            setProviders(provList)
            setOntologies(ontoList)

            listViews({ limit: 200 }).then(({ items, total }) => {
                setTotalViews(total)
                const byWs: Record<string, number> = {}
                for (const v of items) { byWs[v.workspaceId] = (byWs[v.workspaceId] || 0) + 1 }
                setViewCountByWs(byWs)
            }).catch(() => {})

            const statsMap: Record<string, { nodes: number; edges: number; types: number }> = {}
            const statsPromises = wsList.map(async (ws) => {
                let totalNodes = 0, totalEdges = 0, allTypes = new Set<string>()
                const dsPromises = (ws.dataSources || []).map(async (ds) => {
                    try {
                        const res = await fetchWithTimeout(`/api/v1/admin/workspaces/${ws.id}/datasources/${ds.id}/cached-stats`)
                        if (res.ok) {
                            const data = await res.json()
                            totalNodes += (data.nodeCount ?? 0)
                            totalEdges += (data.edgeCount ?? 0)
                            const typeCounts = data.entityTypeCounts ?? {}
                            Object.keys(typeCounts).forEach((t: string) => allTypes.add(t))
                        }
                    } catch { /* no cached stats yet */ }
                })
                await Promise.all(dsPromises)
                statsMap[ws.id] = { nodes: totalNodes, edges: totalEdges, types: allTypes.size }
            })
            await Promise.all(statsPromises)
            setDsStats(statsMap)
        } catch (err) { console.error('Failed to load workspaces', err) }
        finally { setIsLoading(false) }
    }, [])

    useEffect(() => { loadData() }, [loadData])

    useEffect(() => {
        catalogService.listWithBindings().then(setCatalogBindings).catch(console.error)
    }, [showWizard])

    /* ── Actions ── */
    const handleDelete = async (wsId: string) => {
        if (!confirm('Delete this workspace and all its data sources?')) return
        await workspaceService.delete(wsId)
        loadData()
    }

    const handleSetDefault = async (wsId: string) => {
        await workspaceService.setDefault(wsId)
        loadData()
    }

    const resetWizard = () => { setWizName(''); setWizDesc(''); setWizCatalogItemId(''); setWizDsLabel('') }

    const handleWizardComplete = async () => {
        setWizSubmitting(true)
        try {
            const req: WorkspaceCreateRequest = {
                name: wizName, description: wizDesc || undefined,
                dataSources: wizCatalogItemId ? [{ catalogItemId: wizCatalogItemId, label: wizDsLabel || undefined }] : [],
            }
            await workspaceService.create(req)
            setShowWizard(false); resetWizard(); loadData()
        } catch (err) { console.error('Failed to create workspace', err) }
        finally { setWizSubmitting(false) }
    }

    const wsNameDuplicate = workspaces.some(w => w.name.toLowerCase() === wizName.trim().toLowerCase())
    const unboundCatalogs = catalogBindings.filter(b => !b.boundWorkspaceId)

    const wizardSteps: WizardStep[] = [
        {
            id: 'basics', title: 'Basics', icon: Edit2, validate: () => wizName.trim() && !wsNameDuplicate ? true : !wizName.trim() ? 'Please enter a workspace name.' : 'A workspace with this name already exists.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Workspace Name *</label>
                        <input value={wizName} onChange={e => setWizName(e.target.value)} placeholder="e.g. Production Analytics" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                        {wsNameDuplicate && (
                            <p className="mt-1.5 text-xs text-amber-500 flex items-center gap-1">
                                <AlertTriangle className="w-3 h-3" />
                                A workspace named &quot;{wizName.trim()}&quot; already exists
                            </p>
                        )}
                    </div>
                    <div><label className="block text-sm font-medium text-ink mb-1.5">Description</label><textarea value={wizDesc} onChange={e => setWizDesc(e.target.value)} placeholder="Optional description for this workspace" rows={3} className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none" /></div>
                </div>
            ),
        },
        {
            id: 'data-source', title: 'Data Source', icon: Database, validate: () => true,
            content: (
                <div className="space-y-4">
                    <p className="text-xs text-ink-muted mb-4">You can connect an initial data source to this workspace now, or do it later.</p>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Catalog Item</label>
                        <select value={wizCatalogItemId} onChange={e => setWizCatalogItemId(e.target.value)} className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"><option value="">Skip for now...</option>{unboundCatalogs.map(c => <option key={c.id} value={c.id}>{c.name} ({c.sourceIdentifier})</option>)}</select>
                        <p className="mt-1.5 text-xs text-ink-muted">Only unallocated data sources are shown</p>
                    </div>
                    <div><label className="block text-sm font-medium text-ink mb-1.5">Label</label><input value={wizDsLabel} onChange={e => setWizDsLabel(e.target.value)} placeholder="e.g. Main Graph, Analytics DB" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                </div>
            ),
        },
        {
            id: 'review', title: 'Review', icon: Settings, validate: () => true,
            content: (
                <div className="space-y-4">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                        <h4 className="text-sm font-bold text-ink mb-3">Workspace Summary</h4>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div><dt className="text-ink-muted">Name</dt><dd className="font-semibold text-ink mt-0.5">{wizName || '\u2014'}</dd></div>
                            <div><dt className="text-ink-muted">Description</dt><dd className="text-ink mt-0.5 line-clamp-2">{wizDesc || '\u2014'}</dd></div>
                            <div><dt className="text-ink-muted">Catalog Item</dt><dd className="text-ink mt-0.5">{catalogItems.find(c => c.id === wizCatalogItemId)?.name || '\u2014'}</dd></div>
                        </dl>
                    </div>
                </div>
            ),
        },
    ]

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

    const showPipelineNudge = !isLoading && providers.length === 0

    /* ── Render ── */
    return (
        <div className="p-8 max-w-7xl mx-auto space-y-6 animate-in fade-in duration-500">
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
                <button onClick={() => { resetWizard(); setShowWizard(true) }} className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:-translate-y-0.5 transition-all duration-200">
                    <Plus className="w-4 h-4" /> Create Workspace
                </button>
            </div>

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
                                index={i}
                                stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                                healthStatus={deriveWorkspaceHealth(ws.dataSources || [])}
                                dsProviders={wsProviderInfoMap[ws.id] || []}
                                schemaSummary={wsSchemaSummaryMap[ws.id] || { uniqueEntityTypes: 0, uniqueRelationshipTypes: 0, ontologyNames: [], providerGroups: [], viewCount: 0 }}
                                onOpen={() => navigate(`/workspaces/${ws.id}`)}
                                onDelete={() => handleDelete(ws.id)}
                                onSetDefault={() => handleSetDefault(ws.id)}
                            />
                        </div>
                    ))}
                </div>
            ) : (
                <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                    <div className="grid grid-cols-[16px_32px_minmax(0,2fr)_100px_70px_80px_80px_60px_90px_72px] gap-3 px-4 py-2.5 border-b border-glass-border/50 text-[10px] uppercase tracking-wider text-ink-muted font-bold">
                        <span></span><span></span><span>Name</span><span>Providers</span><span>Sources</span><span>Nodes</span><span>Edges</span><span>Types</span><span>Updated</span><span></span>
                    </div>
                    {filtered.map((ws, i) => (
                        <WorkspaceListRow
                            key={ws.id}
                            ws={ws}
                            index={i}
                            stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                            healthStatus={deriveWorkspaceHealth(ws.dataSources || [])}
                            dsProviders={wsProviderInfoMap[ws.id] || []}
                            onOpen={() => navigate(`/workspaces/${ws.id}`)}
                            onDelete={() => handleDelete(ws.id)}
                            onSetDefault={() => handleSetDefault(ws.id)}
                        />
                    ))}
                </div>
            )}

            {/* Create Workspace Wizard */}
            <AdminWizard title="Create Workspace" steps={wizardSteps} isOpen={showWizard} onClose={() => { setShowWizard(false); resetWizard() }} onComplete={handleWizardComplete} isSubmitting={wizSubmitting} completionLabel="Create Workspace" />
        </div>
    )
}