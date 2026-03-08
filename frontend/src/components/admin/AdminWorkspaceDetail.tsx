/**
 * AdminWorkspaceDetail — single workspace detail view at /admin/workspaces/:wsId.
 * Full CRUD for workspace properties and data sources, with scoped views.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
    ChevronLeft, Plus, Database, Edit2,
    Loader2, Settings, X, AlertTriangle, Save,
    Tag,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceService, type WorkspaceResponse, type DataSourceResponse } from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { useSchemaStore } from '@/store/schema'
import { DataSourceCard } from './DataSourceCard'
import { AdminWizard, type WizardStep } from './AdminWizard'

// ─────────────────────────────────────────────────────────────────────
// Styled Confirm Dialog
// ─────────────────────────────────────────────────────────────────────

function ConfirmDialog({ open, title, message, danger, confirmLabel, onConfirm, onCancel }: {
    open: boolean; title: string; message: string; danger?: boolean
    confirmLabel?: string; onConfirm: () => void; onCancel: () => void
}) {
    if (!open) return null
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
            <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                <div className="flex items-center gap-3 mb-4">
                    <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", danger ? "bg-red-500/10" : "bg-amber-500/10")}>
                        <AlertTriangle className={cn("w-5 h-5", danger ? "text-red-500" : "text-amber-500")} />
                    </div>
                    <h3 className="text-lg font-bold text-ink">{title}</h3>
                </div>
                <p className="text-sm text-ink-secondary mb-6">{message}</p>
                <div className="flex justify-end gap-3">
                    <button onClick={onCancel} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">Cancel</button>
                    <button onClick={onConfirm} className={cn(
                        "px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors",
                        danger ? "bg-red-500 hover:bg-red-600" : "bg-amber-500 hover:bg-amber-600"
                    )}>{confirmLabel || 'Confirm'}</button>
                </div>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────
// Edit Data Source Modal
// ─────────────────────────────────────────────────────────────────────

function EditDsModal({ ds, onSave, onClose }: {
    ds: DataSourceResponse; onSave: (label: string) => void; onClose: () => void
}) {
    const [label, setLabel] = useState(ds.label || '')
    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                <div className="flex items-center justify-between mb-5">
                    <h3 className="text-lg font-bold text-ink">Edit Data Source</h3>
                    <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted"><X className="w-4 h-4" /></button>
                </div>
                <div className="space-y-4 mb-6">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Label</label>
                        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Display label"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink-muted mb-1">Provider</label>
                        <p className="text-sm text-ink">{ds.providerId}</p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink-muted mb-1">Graph</label>
                        <p className="text-sm font-mono text-ink">{ds.graphName || '—'}</p>
                    </div>
                </div>
                <div className="flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">Cancel</button>
                    <button onClick={() => onSave(label)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors">
                        <Save className="w-3.5 h-3.5" /> Save
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────
// AdminWorkspaceDetail
// ─────────────────────────────────────────────────────────────────────

export function AdminWorkspaceDetail() {
    const { wsId } = useParams<{ wsId: string }>()
    const navigate = useNavigate()
    const allViews = useSchemaStore(s => s.schema?.views || [])

    const [workspace, setWorkspace] = useState<WorkspaceResponse | null>(null)
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [providerNames, setProviderNames] = useState<Record<string, string>>({})
    const [graphOptions, setGraphOptions] = useState<Record<string, string[]>>({})
    const [dsStatsMap, setDsStatsMap] = useState<Record<string, DataSourceStats>>({})
    const [isLoading, setIsLoading] = useState(true)

    // Edit workspace state
    const [editingHeader, setEditingHeader] = useState(false)
    const [editName, setEditName] = useState('')
    const [editDesc, setEditDesc] = useState('')

    // Add DS wizard
    const [showAddDs, setShowAddDs] = useState(false)
    const [addDsProvider, setAddDsProvider] = useState('')
    const [addDsGraph, setAddDsGraph] = useState('')
    const [addDsLabel, setAddDsLabel] = useState('')
    const [addDsSubmitting, setAddDsSubmitting] = useState(false)

    // Delete confirm
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)

    // Edit DS modal
    const [editingDs, setEditingDs] = useState<DataSourceResponse | null>(null)

    // ── Data loading ────────────────────────────────────────
    const loadWorkspace = useCallback(async () => {
        if (!wsId) return
        setIsLoading(true)
        try {
            const [ws, provList] = await Promise.all([
                workspaceService.get(wsId),
                providerService.list(),
            ])
            setWorkspace(ws)
            setProviders(provList)
            setEditName(ws.name)
            setEditDesc(ws.description || '')

            const names: Record<string, string> = {}
            provList.forEach(p => { names[p.id] = p.name })
            setProviderNames(names)

            const stats: Record<string, DataSourceStats> = {}
            for (const ds of ws.dataSources || []) {
                try {
                    const res = await fetch(`/api/v1/${ws.id}/graph/stats?dataSourceId=${ds.id}`)
                    if (res.ok) {
                        const data = await res.json()
                        stats[ds.id] = {
                            nodeCount: data.node_count ?? data.nodeCount ?? 0,
                            edgeCount: data.edge_count ?? data.edgeCount ?? 0,
                            entityTypes: data.entity_types ?? data.entityTypes ?? [],
                        }
                    }
                } catch { /* ignore */ }
            }
            setDsStatsMap(stats)
        } catch (err) {
            console.error('Failed to load workspace', err)
        } finally {
            setIsLoading(false)
        }
    }, [wsId])

    useEffect(() => { loadWorkspace() }, [loadWorkspace])

    // Fetch graphs when provider selected in add wizard
    useEffect(() => {
        if (!addDsProvider) return
        if (graphOptions[addDsProvider]) return
        providerService.listGraphs(addDsProvider).then(r => {
            setGraphOptions(prev => ({ ...prev, [addDsProvider]: r.graphs }))
        }).catch(() => { })
    }, [addDsProvider]) // eslint-disable-line

    // ── Scoped views per data source ────────────────────────
    const viewsByDs = useMemo(() => {
        if (!workspace) return {}
        const map: Record<string, typeof allViews> = {}
        for (const ds of workspace.dataSources || []) {
            const scopeKey = `${workspace.id}/${ds.id}`
            map[ds.id] = allViews.filter(v => v.scopeKey === scopeKey || (!v.scopeKey && ds.isPrimary))
        }
        return map
    }, [workspace, allViews])

    // ── Handlers ────────────────────────────────────────────
    const handleSaveHeader = async () => {
        if (!wsId || !editName.trim()) return
        await workspaceService.update(wsId, { name: editName, description: editDesc || undefined })
        setEditingHeader(false)
        loadWorkspace()
    }

    const handleSetPrimary = async (dsId: string) => {
        if (!wsId) return
        await workspaceService.setPrimaryDataSource(wsId, dsId)
        loadWorkspace()
    }

    const handleDeleteDs = async () => {
        if (!wsId || !deleteTarget) return
        await workspaceService.removeDataSource(wsId, deleteTarget.id)
        setDeleteTarget(null)
        loadWorkspace()
    }

    const handleProjectionMode = async (dsId: string, mode: string) => {
        if (!wsId) return
        await workspaceService.setProjectionMode(wsId, dsId, mode)
        loadWorkspace()
    }

    const handleDedicatedGraphName = async (dsId: string, name: string) => {
        if (!wsId) return
        await workspaceService.updateDataSource(wsId, dsId, { dedicatedGraphName: name })
    }

    const handleEditDsSave = async (label: string) => {
        if (!wsId || !editingDs) return
        await workspaceService.updateDataSource(wsId, editingDs.id, { label })
        setEditingDs(null)
        loadWorkspace()
    }

    const resetAddDs = () => { setAddDsProvider(''); setAddDsGraph(''); setAddDsLabel('') }

    const handleAddDsComplete = async () => {
        if (!wsId) return
        setAddDsSubmitting(true)
        try {
            await workspaceService.addDataSource(wsId, {
                providerId: addDsProvider,
                graphName: addDsGraph,
                label: addDsLabel || undefined,
            })
            setShowAddDs(false)
            resetAddDs()
            loadWorkspace()
        } finally {
            setAddDsSubmitting(false)
        }
    }

    const addDsSteps: WizardStep[] = [
        {
            id: 'source',
            title: 'Select Source',
            icon: Database,
            validate: () => (addDsProvider && addDsGraph) ? true : 'Select a provider and graph.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Provider *</label>
                        <select value={addDsProvider} onChange={e => { setAddDsProvider(e.target.value); setAddDsGraph('') }}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50">
                            <option value="">Select a provider...</option>
                            {providers.map(p => <option key={p.id} value={p.id}>{p.name} ({p.providerType})</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Graph *</label>
                        <select value={addDsGraph} onChange={e => setAddDsGraph(e.target.value)} disabled={!addDsProvider}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 disabled:opacity-50">
                            <option value="">Select a graph...</option>
                            {(graphOptions[addDsProvider] || []).map(g => <option key={g} value={g}>{g}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Label</label>
                        <input value={addDsLabel} onChange={e => setAddDsLabel(e.target.value)} placeholder="Optional display label"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                    </div>
                </div>
            ),
        },
        {
            id: 'confirm',
            title: 'Confirm',
            icon: Settings,
            validate: () => true,
            content: (
                <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                    <h4 className="text-sm font-bold text-ink mb-3">Data Source Summary</h4>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div><dt className="text-ink-muted">Provider</dt><dd className="text-ink mt-0.5">{providers.find(p => p.id === addDsProvider)?.name || '—'}</dd></div>
                        <div><dt className="text-ink-muted">Graph</dt><dd className="font-mono text-ink mt-0.5">{addDsGraph || '—'}</dd></div>
                        <div><dt className="text-ink-muted">Label</dt><dd className="text-ink mt-0.5">{addDsLabel || '—'}</dd></div>
                        <div><dt className="text-ink-muted">Workspace</dt><dd className="text-ink mt-0.5">{workspace?.name || '—'}</dd></div>
                    </dl>
                </div>
            ),
        },
    ]

    // ── Render ──────────────────────────────────────────────
    if (isLoading) {
        return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
    }

    if (!workspace) {
        return (
            <div className="flex flex-col items-center justify-center h-full">
                <p className="text-ink-muted">Workspace not found.</p>
                <button onClick={() => navigate('/admin/workspaces')} className="mt-4 text-indigo-500 hover:underline text-sm">← Back to Workspaces</button>
            </div>
        )
    }

    return (
        <div className="p-8 max-w-5xl mx-auto">
            {/* Back */}
            <button onClick={() => navigate('/admin/workspaces')} className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors mb-6">
                <ChevronLeft className="w-4 h-4" /> Back to Workspaces
            </button>

            {/* ── Header ─────────────────────────────────────────── */}
            <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-6 mb-8">
                <div className="flex items-start justify-between">
                    <div className="flex items-center gap-4 flex-1 min-w-0">
                        <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center shrink-0">
                            <Database className="w-6 h-6 text-indigo-500" />
                        </div>

                        {editingHeader ? (
                            <div className="flex-1 space-y-3">
                                <input value={editName} onChange={e => setEditName(e.target.value)} autoFocus placeholder="Workspace name"
                                    className="text-xl font-bold text-ink bg-transparent border-b-2 border-indigo-500 outline-none pb-0.5 w-full" />
                                <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} placeholder="Description (optional)" rows={2}
                                    className="w-full text-sm text-ink-secondary bg-black/5 dark:bg-white/5 border border-glass-border rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                                <div className="flex gap-2">
                                    <button onClick={handleSaveHeader} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 transition-colors">
                                        <Save className="w-3 h-3" /> Save
                                    </button>
                                    <button onClick={() => { setEditingHeader(false); setEditName(workspace.name); setEditDesc(workspace.description || '') }}
                                        className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">Cancel</button>
                                </div>
                            </div>
                        ) : (
                            <div className="min-w-0">
                                <div className="flex items-center gap-2 mb-1">
                                    <h2 className="text-xl font-bold text-ink truncate">{workspace.name}</h2>
                                    <button onClick={() => setEditingHeader(true)} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted"><Edit2 className="w-3.5 h-3.5" /></button>
                                    {workspace.isDefault && (
                                        <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-indigo-500/10 text-indigo-500 border border-indigo-500/20">DEFAULT</span>
                                    )}
                                </div>
                                <p className="text-sm text-ink-muted line-clamp-2">{workspace.description || 'No description'}</p>
                                {/* Quick stats */}
                                <div className="flex items-center gap-4 mt-3 text-xs text-ink-muted">
                                    <span className="flex items-center gap-1"><Database className="w-3 h-3" /> {workspace.dataSources.length} sources</span>
                                    <span className="flex items-center gap-1"><Tag className="w-3 h-3" /> Created {new Date(workspace.createdAt).toLocaleDateString()}</span>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* ── Data Sources ───────────────────────────────────── */}
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-bold text-ink">Data Sources</h3>
                <button onClick={() => { resetAddDs(); setShowAddDs(true) }}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500/10 text-indigo-500 text-sm font-semibold hover:bg-indigo-500/20 transition-colors">
                    <Plus className="w-4 h-4" /> Add Source
                </button>
            </div>

            {workspace.dataSources.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 border-2 border-dashed border-glass-border rounded-2xl">
                    <Database className="w-10 h-10 text-ink-muted mb-3" />
                    <p className="text-sm text-ink-muted mb-4">No data sources in this workspace</p>
                    <button onClick={() => { resetAddDs(); setShowAddDs(true) }}
                        className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold">
                        <Plus className="w-4 h-4" /> Add First Source
                    </button>
                </div>
            ) : (
                <div className="space-y-3">
                    {workspace.dataSources.map(ds => (
                        <DataSourceCard
                            key={ds.id}
                            ds={ds}
                            stats={dsStatsMap[ds.id]}
                            providerName={providerNames[ds.providerId]}
                            isActive={ds.isPrimary}
                            views={viewsByDs[ds.id] || []}
                            onSetPrimary={() => handleSetPrimary(ds.id)}
                            onProjectionModeChange={mode => handleProjectionMode(ds.id, mode)}
                            onDedicatedGraphNameChange={name => handleDedicatedGraphName(ds.id, name)}
                            onEdit={() => setEditingDs(ds)}
                            onDelete={workspace.dataSources.length > 1 ? () => setDeleteTarget({ id: ds.id, label: ds.label || ds.graphName || 'Unnamed' }) : undefined}
                        />
                    ))}
                </div>
            )}

            {/* ── Modals ──────────────────────────────────────────── */}
            <AdminWizard
                title="Add Data Source"
                steps={addDsSteps}
                isOpen={showAddDs}
                onClose={() => { setShowAddDs(false); resetAddDs() }}
                onComplete={handleAddDsComplete}
                isSubmitting={addDsSubmitting}
                completionLabel="Add Source"
            />

            <ConfirmDialog
                open={!!deleteTarget}
                title="Remove Data Source"
                message={`Are you sure you want to remove "${deleteTarget?.label}" from this workspace? This action cannot be undone.`}
                danger
                confirmLabel="Remove"
                onConfirm={handleDeleteDs}
                onCancel={() => setDeleteTarget(null)}
            />

            {editingDs && (
                <EditDsModal
                    ds={editingDs}
                    onSave={handleEditDsSave}
                    onClose={() => setEditingDs(null)}
                />
            )}
        </div>
    )
}
