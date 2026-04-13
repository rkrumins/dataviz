import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import {
    Database, Plus, Edit2, Settings, AlertTriangle,
} from 'lucide-react'
import { workspaceService, type WorkspaceResponse, type WorkspaceCreateRequest } from '@/services/workspaceService'
import { catalogService, type CatalogItemResponse, type CatalogItemBindingResponse } from '@/services/catalogService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { WorkspaceCard } from './WorkspaceCard'
import { WorkspaceFilterToolbar, type WorkspaceSortKey, type HealthFilter } from './workspace/WorkspaceFilterToolbar'
import { WorkspaceListRow } from './workspace/WorkspaceListRow'
import { WorkspaceCardSkeleton, WorkspaceListRowSkeleton } from './workspace/WorkspaceCardSkeleton'
import { deriveWorkspaceHealth } from './workspace/WorkspaceHealthBadge'
import { AdminWizard, type WizardStep } from './AdminWizard'

export function RegistryWorkspaces() {
    const navigate = useNavigate()
    const [searchParams, setSearchParams] = useSearchParams()

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
            // Preserve the tab param from parent AdminRegistry
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
    const [isLoading, setIsLoading] = useState(true)

    /* ── Wizard state ── */
    const [showWizard, setShowWizard] = useState(false)
    const [wizName, setWizName] = useState('')
    const [wizDesc, setWizDesc] = useState('')
    const [wizCatalogItemId, setWizCatalogItemId] = useState('')
    const [wizDsLabel, setWizDsLabel] = useState('')
    const [wizSubmitting, setWizSubmitting] = useState(false)

    /* ── Provider type map ── */
    const providerTypeMap = useMemo(() => {
        const map: Record<string, string> = {}
        for (const p of providers) map[p.id] = p.providerType
        return map
    }, [providers])

    /* ── Data loading ── */
    const loadData = useCallback(async () => {
        setIsLoading(true)
        try {
            const [wsList, catList, provList] = await Promise.all([
                workspaceService.list(),
                catalogService.list(),
                providerService.list(),
            ])
            setWorkspaces(wsList)
            setCatalogItems(catList)
            setProviders(provList)

            const statsMap: Record<string, { nodes: number; edges: number; types: number }> = {}
            // Fetch cached stats from management DB (no provider dependency) in parallel
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

        // Search filter
        if (searchQuery) {
            const q = searchQuery.toLowerCase()
            result = result.filter(ws => ws.name.toLowerCase().includes(q) || ws.description?.toLowerCase().includes(q))
        }

        // Health filter
        if (healthFilter !== 'all') {
            result = result.filter(ws => deriveWorkspaceHealth(ws.dataSources || []) === healthFilter)
        }

        // Sort
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

    /* ── Render ── */
    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            <style>{`
@keyframes card-in {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
}
.ws-card-stagger { animation: card-in 0.3s ease-out both; }
`}</style>

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-ink">Workspaces</h2>
                    <p className="text-sm text-ink-muted mt-1">Tenant environments subscribed to data sources.</p>
                </div>
                <button onClick={() => { resetWizard(); setShowWizard(true) }} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors">
                    <Plus className="w-4 h-4" /> Create Workspace
                </button>
            </div>

            {/* Filter toolbar */}
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
                // Skeleton loading
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
                // Empty state
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Database className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">{searchQuery ? 'No matching workspaces' : 'No workspaces yet'}</h3>
                    <p className="text-sm text-ink-muted">{searchQuery ? 'Try a different search term' : 'Create a workspace to get started'}</p>
                </div>
            ) : layout === 'grid' ? (
                // Grid layout
                <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                    {filtered.map((ws, i) => (
                        <div key={ws.id} className="ws-card-stagger" style={{ animationDelay: `${Math.min(i * 40, 300)}ms` }}>
                            <WorkspaceCard
                                ws={ws}
                                index={i}
                                stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                                healthStatus={deriveWorkspaceHealth(ws.dataSources || [])}
                                providerType={providerTypeMap[ws.providerId || '']}
                                onOpen={() => navigate(`/admin/registry/workspaces/${ws.id}`)}
                                onDelete={() => handleDelete(ws.id)}
                                onSetDefault={() => handleSetDefault(ws.id)}
                            />
                        </div>
                    ))}
                </div>
            ) : (
                // List layout
                <div className="rounded-2xl border border-glass-border overflow-hidden bg-canvas-elevated">
                    <div className="grid grid-cols-[16px_32px_minmax(0,2fr)_70px_80px_80px_60px_90px_72px] gap-3 px-4 py-2.5 border-b border-glass-border/50 text-[10px] uppercase tracking-wider text-ink-muted font-bold">
                        <span></span><span></span><span>Name</span><span>Sources</span><span>Nodes</span><span>Edges</span><span>Types</span><span>Updated</span><span></span>
                    </div>
                    {filtered.map((ws, i) => (
                        <WorkspaceListRow
                            key={ws.id}
                            ws={ws}
                            index={i}
                            stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                            healthStatus={deriveWorkspaceHealth(ws.dataSources || [])}
                            onOpen={() => navigate(`/admin/registry/workspaces/${ws.id}`)}
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
