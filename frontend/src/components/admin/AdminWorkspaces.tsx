/**
 * AdminWorkspaces — workspace management page.
 * Shows workspace cards with embedded data source summaries and quick stats.
 */
import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Database, Plus, Search, Settings, ChevronRight, Trash2,
    Edit2, Shield, Loader2, Star, Layers, CircleDot,
    ArrowRightLeft, FolderOpen,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceService, type WorkspaceResponse, type WorkspaceCreateRequest } from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { AdminWizard, type WizardStep } from './AdminWizard'

// ─────────────────────────────────────────────────────────────────────
// Palette
// ─────────────────────────────────────────────────────────────────────

const WS_PALETTES = [
    { icon: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20', accent: 'border-indigo-500/30', glow: 'shadow-indigo-500/10' },
    { icon: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', accent: 'border-emerald-500/30', glow: 'shadow-emerald-500/10' },
    { icon: 'bg-violet-500/10 text-violet-500 border-violet-500/20', accent: 'border-violet-500/30', glow: 'shadow-violet-500/10' },
    { icon: 'bg-amber-500/10 text-amber-500 border-amber-500/20', accent: 'border-amber-500/30', glow: 'shadow-amber-500/10' },
    { icon: 'bg-rose-500/10 text-rose-500 border-rose-500/20', accent: 'border-rose-500/30', glow: 'shadow-rose-500/10' },
    { icon: 'bg-cyan-500/10 text-cyan-500 border-cyan-500/20', accent: 'border-cyan-500/30', glow: 'shadow-cyan-500/10' },
]

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

// ─────────────────────────────────────────────────────────────────────
// Workspace Card
// ─────────────────────────────────────────────────────────────────────

function WorkspaceCard({
    ws,
    index,
    stats,
    onOpen,
    onDelete,
    onSetDefault,
}: {
    ws: WorkspaceResponse
    index: number
    stats: { nodes: number; edges: number; types: number }
    onOpen: () => void
    onDelete: () => void
    onSetDefault: () => void
}) {
    const palette = WS_PALETTES[index % WS_PALETTES.length]

    return (
        <div
            className={cn(
                "group border rounded-xl bg-canvas-elevated cursor-pointer",
                "hover:shadow-lg transition-all duration-200",
                ws.isDefault ? palette.accent : "border-glass-border hover:border-indigo-500/20"
            )}
            onClick={onOpen}
        >
            <div className="p-5">
                {/* Header */}
                <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className={cn("w-10 h-10 rounded-xl border flex items-center justify-center", palette.icon)}>
                            <FolderOpen className="w-5 h-5" />
                        </div>
                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-sm font-bold text-ink">{ws.name}</h3>
                                {ws.isDefault && (
                                    <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">DEFAULT</span>
                                )}
                            </div>
                            {ws.description && <p className="text-xs text-ink-muted mt-0.5 line-clamp-1">{ws.description}</p>}
                        </div>
                    </div>
                    <ChevronRight className="w-4 h-4 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>

                {/* Quick Stats */}
                <div className="flex items-center gap-4 mb-4">
                    <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                        <Database className="w-3 h-3 text-indigo-500" />
                        <span className="font-semibold">{ws.dataSources?.length || 0}</span>
                        <span className="text-ink-muted">sources</span>
                    </div>
                    {stats.nodes > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                            <CircleDot className="w-3 h-3 text-emerald-500" />
                            <span className="font-semibold">{compactNum(stats.nodes)}</span>
                            <span className="text-ink-muted">nodes</span>
                        </div>
                    )}
                    {stats.edges > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                            <ArrowRightLeft className="w-3 h-3 text-violet-500" />
                            <span className="font-semibold">{compactNum(stats.edges)}</span>
                            <span className="text-ink-muted">edges</span>
                        </div>
                    )}
                    {stats.types > 0 && (
                        <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                            <Layers className="w-3 h-3 text-amber-500" />
                            <span className="font-semibold">{stats.types}</span>
                            <span className="text-ink-muted">types</span>
                        </div>
                    )}
                </div>

                {/* Data Source Mini-list */}
                {ws.dataSources && ws.dataSources.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                        {ws.dataSources.slice(0, 4).map(ds => (
                            <span key={ds.id} className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-black/5 dark:bg-white/5 text-ink-secondary border border-glass-border">
                                {ds.isPrimary && <Star className="w-2.5 h-2.5 text-amber-500" />}
                                {ds.label || ds.graphName || 'source'}
                            </span>
                        ))}
                        {ws.dataSources.length > 4 && (
                            <span className="px-2 py-1 text-[10px] text-ink-muted">+{ws.dataSources.length - 4}</span>
                        )}
                    </div>
                )}
            </div>

            {/* Actions footer */}
            <div className="px-5 py-3 border-t border-glass-border flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                {!ws.isDefault && (
                    <button
                        onClick={(e) => { e.stopPropagation(); onSetDefault() }}
                        className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors"
                    >
                        <Shield className="w-3 h-3" />
                        Set Default
                    </button>
                )}
                <button
                    onClick={(e) => { e.stopPropagation(); onDelete() }}
                    className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors ml-auto"
                >
                    <Trash2 className="w-3 h-3" />
                    Delete
                </button>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────
// AdminWorkspaces Page
// ─────────────────────────────────────────────────────────────────────

export function AdminWorkspaces() {
    const navigate = useNavigate()
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [graphOptions, setGraphOptions] = useState<Record<string, string[]>>({})
    const [dsStats, setDsStats] = useState<Record<string, { nodes: number; edges: number; types: number }>>({})
    const [searchQuery, setSearchQuery] = useState('')
    const [isLoading, setIsLoading] = useState(true)
    const [showWizard, setShowWizard] = useState(false)

    // Wizard form state
    const [wizName, setWizName] = useState('')
    const [wizDesc, setWizDesc] = useState('')
    const [wizDsProvider, setWizDsProvider] = useState('')
    const [wizDsGraph, setWizDsGraph] = useState('')
    const [wizDsLabel, setWizDsLabel] = useState('')
    const [wizSubmitting, setWizSubmitting] = useState(false)

    const loadData = useCallback(async () => {
        setIsLoading(true)
        try {
            const [wsList, provList] = await Promise.all([
                workspaceService.list(),
                providerService.list(),
            ])
            setWorkspaces(wsList)
            setProviders(provList)

            // Fetch per-DS stats
            const statsMap: Record<string, { nodes: number; edges: number; types: number }> = {}
            for (const ws of wsList) {
                let totalNodes = 0, totalEdges = 0, allTypes = new Set<string>()
                for (const ds of ws.dataSources || []) {
                    try {
                        const res = await fetch(`/api/v1/${ws.id}/graph/stats?dataSourceId=${ds.id}`)
                        if (res.ok) {
                            const data = await res.json()
                            const n = data.node_count ?? data.nodeCount ?? 0
                            const e = data.edge_count ?? data.edgeCount ?? 0
                            const types = data.entity_types ?? data.entityTypes ?? []
                            totalNodes += n; totalEdges += e; types.forEach((t: string) => allTypes.add(t))
                        }
                    } catch { /* ignore */ }
                }
                statsMap[ws.id] = { nodes: totalNodes, edges: totalEdges, types: allTypes.size }
            }
            setDsStats(statsMap)
        } catch (err) {
            console.error('Failed to load workspaces', err)
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => { loadData() }, [loadData])

    // Load graph options when provider selected
    useEffect(() => {
        if (!wizDsProvider) return
        if (graphOptions[wizDsProvider]) return
        providerService.listGraphs(wizDsProvider).then(r => {
            setGraphOptions(prev => ({ ...prev, [wizDsProvider]: r.graphs }))
        }).catch(() => { })
    }, [wizDsProvider]) // eslint-disable-line

    const handleDelete = async (wsId: string) => {
        if (!confirm('Delete this workspace and all its data sources?')) return
        await workspaceService.delete(wsId)
        loadData()
    }

    const handleSetDefault = async (wsId: string) => {
        await workspaceService.setDefault(wsId)
        loadData()
    }

    const resetWizard = () => {
        setWizName(''); setWizDesc(''); setWizDsProvider(''); setWizDsGraph(''); setWizDsLabel('')
    }

    const handleWizardComplete = async () => {
        setWizSubmitting(true)
        try {
            const req: WorkspaceCreateRequest = {
                name: wizName,
                description: wizDesc || undefined,
                dataSources: [{
                    providerId: wizDsProvider,
                    graphName: wizDsGraph,
                    label: wizDsLabel || undefined,
                }],
            }
            await workspaceService.create(req)
            setShowWizard(false)
            resetWizard()
            loadData()
        } catch (err) {
            console.error('Failed to create workspace', err)
        } finally {
            setWizSubmitting(false)
        }
    }

    const wizardSteps: WizardStep[] = [
        {
            id: 'basics',
            title: 'Basics',
            icon: Edit2,
            validate: () => wizName.trim() ? true : 'Please enter a workspace name.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Workspace Name *</label>
                        <input
                            value={wizName} onChange={e => setWizName(e.target.value)}
                            placeholder="e.g. Production Analytics"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Description</label>
                        <textarea
                            value={wizDesc} onChange={e => setWizDesc(e.target.value)}
                            placeholder="Optional description for this workspace"
                            rows={3}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 resize-none"
                        />
                    </div>
                </div>
            ),
        },
        {
            id: 'data-source',
            title: 'Data Source',
            icon: Database,
            validate: () => (wizDsProvider && wizDsGraph) ? true : 'Select a provider and graph.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Provider *</label>
                        <select
                            value={wizDsProvider} onChange={e => { setWizDsProvider(e.target.value); setWizDsGraph('') }}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        >
                            <option value="">Select a provider...</option>
                            {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.providerType})</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Graph *</label>
                        <select
                            value={wizDsGraph} onChange={e => setWizDsGraph(e.target.value)}
                            disabled={!wizDsProvider}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-50"
                        >
                            <option value="">Select a graph...</option>
                            {(graphOptions[wizDsProvider] || []).map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                        {wizDsProvider && !graphOptions[wizDsProvider] && (
                            <p className="text-xs text-ink-muted mt-1 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading graphs...</p>
                        )}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Label</label>
                        <input
                            value={wizDsLabel} onChange={e => setWizDsLabel(e.target.value)}
                            placeholder="e.g. Main Graph, Analytics DB"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                        />
                    </div>
                </div>
            ),
        },
        {
            id: 'review',
            title: 'Review',
            icon: Settings,
            validate: () => true,
            content: (
                <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                    <h4 className="text-sm font-bold text-ink mb-3">Workspace Summary</h4>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div><dt className="text-ink-muted">Name</dt><dd className="font-semibold text-ink mt-0.5">{wizName || '—'}</dd></div>
                        <div><dt className="text-ink-muted">Description</dt><dd className="text-ink mt-0.5 line-clamp-2">{wizDesc || '—'}</dd></div>
                        <div><dt className="text-ink-muted">Provider</dt><dd className="text-ink mt-0.5">{providers.find(p => p.id === wizDsProvider)?.name || '—'}</dd></div>
                        <div><dt className="text-ink-muted">Graph</dt><dd className="font-mono text-ink mt-0.5">{wizDsGraph || '—'}</dd></div>
                    </dl>
                </div>
            ),
        },
    ]

    const filtered = workspaces.filter(ws =>
        !searchQuery || ws.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        ws.description?.toLowerCase().includes(searchQuery.toLowerCase())
    )

    return (
        <div className="p-8 max-w-6xl mx-auto">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h2 className="text-2xl font-bold text-ink">Workspaces</h2>
                    <p className="text-sm text-ink-muted mt-1">Manage environments and their data sources</p>
                </div>
                <button
                    onClick={() => { resetWizard(); setShowWizard(true) }}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:shadow-indigo-500/30 transition-all"
                >
                    <Plus className="w-4 h-4" />
                    Create Workspace
                </button>
            </div>

            {/* Search */}
            {workspaces.length > 0 && (
                <div className="relative mb-6">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                        value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                        placeholder="Search workspaces..."
                        className="w-full pl-11 pr-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                    />
                </div>
            )}

            {/* Grid */}
            {isLoading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
                </div>
            ) : filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Database className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">{searchQuery ? 'No matching workspaces' : 'No workspaces yet'}</h3>
                    <p className="text-sm text-ink-muted mb-6">{searchQuery ? 'Try a different search term' : 'Create a workspace to get started'}</p>
                    {!searchQuery && (
                        <button onClick={() => { resetWizard(); setShowWizard(true) }} className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold">
                            <Plus className="w-4 h-4" /> Create Your First Workspace
                        </button>
                    )}
                </div>
            ) : (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    {filtered.map((ws, i) => (
                        <WorkspaceCard
                            key={ws.id}
                            ws={ws}
                            index={i}
                            stats={dsStats[ws.id] || { nodes: 0, edges: 0, types: 0 }}
                            onOpen={() => navigate(`/admin/workspaces/${ws.id}`)}
                            onDelete={() => handleDelete(ws.id)}
                            onSetDefault={() => handleSetDefault(ws.id)}
                        />
                    ))}
                </div>
            )}

            {/* Create Wizard */}
            <AdminWizard
                title="Create Workspace"
                steps={wizardSteps}
                isOpen={showWizard}
                onClose={() => { setShowWizard(false); resetWizard() }}
                onComplete={handleWizardComplete}
                isSubmitting={wizSubmitting}
                completionLabel="Create Workspace"
            />
        </div>
    )
}
