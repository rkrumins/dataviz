/**
 * AdminWorkspaceDetail — single workspace detail view at /admin/workspaces/:wsId.
 * Modern tabbed dashboard with hero header, data source grid, views,
 * aggregation, and ontology sections.
 */
import { useState, useEffect, useMemo } from 'react'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { useParams, useNavigate } from 'react-router-dom'
import {
    ChevronLeft, Plus, Database, Loader2, Settings2, X, Save,
    Trash2, GitBranch, Eye, Info, Compass, HelpCircle,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { cn } from '@/lib/utils'
import { workspaceService, type DataSourceResponse, type WorkspaceDataSourceImpactResponse } from '@/services/workspaceService'
import { aggregationService } from '@/services/aggregationService'
import type { OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'
import { useToast } from '@/components/ui/toast'
import { AdminWizard, type WizardStep } from './AdminWizard'
import { useWorkspaceDetailData } from './workspace/useWorkspaceDetailData'
import { WorkspaceHeroHeader } from './workspace/WorkspaceHeroHeader'
import { DataSourceGridCard } from './workspace/DataSourceGridCard'
import { DataSourceDetailPanel } from './workspace/DataSourceDetailPanel'
import WorkspaceViewsSection from './workspace/WorkspaceViewsSection'
import { WorkspaceAggregationDashboard } from './workspace/WorkspaceAggregationDashboard'
import { WorkspaceOntologyTimeline } from './workspace/WorkspaceOntologyTimeline'

// ─────────────────────────────────────────────────────────────────────
// Edit Data Source Modal
// ─────────────────────────────────────────────────────────────────────

function EditDsModal({ ds, ontologies, onSave, onClose }: {
    ds: DataSourceResponse
    ontologies: OntologyDefinitionResponse[]
    onSave: (label: string, ontologyId: string | undefined) => void
    onClose: () => void
}) {
    const [label, setLabel] = useState(ds.label || '')
    const [ontologyId, setOntologyId] = useState(ds.ontologyId || '')
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
                        <label className="block text-sm font-medium text-ink mb-1.5">Ontology</label>
                        <select value={ontologyId} onChange={e => setOntologyId(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50">
                            <option value="">None (use system defaults)</option>
                            {ontologies.map(o => (
                                <option key={o.id} value={o.id}>{o.name} v{o.version}{o.isPublished ? '' : ' (draft)'}</option>
                            ))}
                        </select>
                        <p className="text-xs text-ink-muted mt-1">Assigns a semantic ontology to this data source for entity type resolution.</p>
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink-muted mb-1">Catalog Item</label>
                        <p className="text-sm font-mono text-ink">{ds.catalogItemId}</p>
                    </div>
                </div>
                <div className="flex justify-end gap-3">
                    <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">Cancel</button>
                    <button onClick={() => onSave(label, ontologyId || undefined)} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 text-white text-sm font-semibold hover:bg-indigo-600 transition-colors">
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
    const { showToast } = useToast()

    // ── Data fetching via custom hook ──────────────────────
    const {
        workspace, catalogItems, ontologies, ontologyMap, dsStatsMap, dsProviderMap,
        viewsByDs, allWorkspaceViews, readinessMap, healthStatus,
        aggregateStats, isLoading, reload
    } = useWorkspaceDetailData(wsId)

    // ── Edit header state ──────────────────────────────────
    const [editingHeader, setEditingHeader] = useState(false)
    const [editName, setEditName] = useState('')
    const [editDesc, setEditDesc] = useState('')

    // ── Add DS wizard state ────────────────────────────────
    const [showAddDs, setShowAddDs] = useState(false)
    const [addDsCatalogId, setAddDsCatalogId] = useState('')
    const [addDsLabel, setAddDsLabel] = useState('')
    const [addDsOntologyId, setAddDsOntologyId] = useState('')
    const [addDsSubmitting, setAddDsSubmitting] = useState(false)

    // ── Delete confirm state ───────────────────────────────
    const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null)
    const [deleteImpact, setDeleteImpact] = useState<WorkspaceDataSourceImpactResponse | null>(null)
    const [loadingImpact, setLoadingImpact] = useState(false)

    // ── Edit DS modal state ────────────────────────────────
    const [editingDs, setEditingDs] = useState<DataSourceResponse | null>(null)

    // ── Selection + tab state ──────────────────────────────
    const [selectedDsId, setSelectedDsId] = useState<string | null>(null)
    const [activeSection, setActiveSection] = useState<'sources' | 'views' | 'aggregation' | 'ontology'>('sources')

    // ── Sync editName/editDesc when workspace loads ────────
    useEffect(() => {
        if (workspace) {
            setEditName(workspace.name)
            setEditDesc(workspace.description || '')
        }
    }, [workspace])

    // ── Derived data ───────────────────────────────────────
    const ontologyNameMap = useMemo(() => {
        const map: Record<string, string> = {}
        for (const o of ontologies) map[o.id] = `${o.name} v${o.version}`
        return map
    }, [ontologies])

    const allowedCatalogItems = useMemo(() => {
        if (!wsId || !catalogItems) return []
        return catalogItems.filter(item =>
            item.permittedWorkspaces.includes('*') || item.permittedWorkspaces.includes(wsId)
        )
    }, [wsId, catalogItems])

    const selectedDs = useMemo(() => {
        if (!workspace || !selectedDsId) return null
        return workspace.dataSources.find(ds => ds.id === selectedDsId) || null
    }, [workspace, selectedDsId])

    const primaryOntologyName = useMemo(() => {
        if (!workspace) return undefined
        const primaryDs = workspace.dataSources.find(ds => ds.isPrimary)
        if (primaryDs?.ontologyId) return ontologyNameMap[primaryDs.ontologyId]
        return undefined
    }, [workspace, ontologyNameMap])

    // ── Handlers ───────────────────────────────────────────
    const handleSaveHeader = async () => {
        if (!wsId || !editName.trim()) return
        await workspaceService.update(wsId, { name: editName, description: editDesc || undefined })
        setEditingHeader(false)
        reload()
    }

    const handleSetPrimary = async (dsId: string) => {
        if (!wsId) return
        await workspaceService.setPrimaryDataSource(wsId, dsId)
        reload()
    }

    const handleDeleteDsClick = async (dsId: string, label: string) => {
        if (!wsId) return
        setDeleteTarget({ id: dsId, label })
        setLoadingImpact(true)
        try {
            const impact = await workspaceService.getDataSourceImpact(wsId, dsId)
            setDeleteImpact(impact)
        } catch (err) {
            console.error(err)
        } finally {
            setLoadingImpact(false)
        }
    }

    const handleDeleteDs = async () => {
        if (!wsId || !deleteTarget) return
        await workspaceService.removeDataSource(wsId, deleteTarget.id)
        setDeleteTarget(null)
        setDeleteImpact(null)
        reload()
    }

    const handleProjectionMode = async (dsId: string, mode: string) => {
        if (!wsId) return
        await workspaceService.setProjectionMode(wsId, dsId, mode)
        reload()
    }

    const handleDedicatedGraphName = async (dsId: string, name: string) => {
        if (!wsId) return
        await workspaceService.updateDataSource(wsId, dsId, { dedicatedGraphName: name })
    }

    const handleEditDsSave = async (label: string, ontologyId: string | undefined) => {
        if (!wsId || !editingDs) return
        await workspaceService.updateDataSource(wsId, editingDs.id, { label, ontologyId })
        setEditingDs(null)
        reload()
    }

    const handleReaggregate = async (ds: DataSourceResponse) => {
        if (!wsId) return
        try {
            await fetchWithTimeout(`/api/v1/admin/data-sources/${ds.id}/aggregation-jobs?triggerSource=manual`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    projectionMode: ds.projectionMode || 'in_source',
                    batchSize: 1000
                })
            })
            reload()
        } catch (err) {
            console.error('Failed to trigger aggregation', err)
        }
    }

    const handlePurge = async (ds: DataSourceResponse) => {
        try {
            const result = await aggregationService.purgeAggregation(ds.id)
            showToast('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            reload()
        } catch (err: any) {
            showToast('error', err?.message ?? 'Purge failed')
            throw err
        }
    }

    const resetAddDs = () => { setAddDsCatalogId(''); setAddDsLabel(''); setAddDsOntologyId('') }

    const handleAddDsComplete = async () => {
        if (!wsId) return
        setAddDsSubmitting(true)
        try {
            await workspaceService.addDataSource(wsId, {
                catalogItemId: addDsCatalogId,
                label: addDsLabel || undefined,
                ontologyId: addDsOntologyId || undefined,
            })
            setShowAddDs(false)
            resetAddDs()
            reload()
        } finally {
            setAddDsSubmitting(false)
        }
    }

    // ── Add DS wizard steps ────────────────────────────────
    const addDsSteps: WizardStep[] = [
        {
            id: 'source',
            title: 'Select Data Source',
            icon: Database,
            validate: () => addDsCatalogId ? true : 'Please select a catalog item.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Enterprise Catalog Item *</label>
                        <select value={addDsCatalogId} onChange={e => setAddDsCatalogId(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50">
                            <option value="">Select a data source...</option>
                            {allowedCatalogItems.map(c => <option key={c.id} value={c.id}>{c.name} ({c.sourceIdentifier})</option>)}
                        </select>
                        {allowedCatalogItems.length === 0 && (
                            <p className="text-xs text-amber-500 mt-2">No catalog items are permitted for this workspace. Contact your administrator.</p>
                        )}
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Connection Label</label>
                        <input value={addDsLabel} onChange={e => setAddDsLabel(e.target.value)} placeholder="Optional display label in this workspace"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" />
                    </div>
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5 flex items-center gap-1.5">
                            <GitBranch className="w-3.5 h-3.5 text-ink-muted" /> Ontology
                        </label>
                        <select value={addDsOntologyId} onChange={e => setAddDsOntologyId(e.target.value)}
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50">
                            <option value="">None (use system defaults)</option>
                            {ontologies.map(o => (
                                <option key={o.id} value={o.id}>{o.name} v{o.version}{o.isPublished ? '' : ' (draft)'}</option>
                            ))}
                        </select>
                        <p className="text-xs text-ink-muted mt-1">Optional. Assigns a semantic ontology for entity type and edge classification.</p>
                    </div>
                </div>
            ),
        },
        {
            id: 'confirm',
            title: 'Confirm',
            icon: Settings2,
            validate: () => true,
            content: (
                <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                    <h4 className="text-sm font-bold text-ink mb-3">Data Source Summary</h4>
                    <dl className="grid grid-cols-2 gap-3 text-sm">
                        <div><dt className="text-ink-muted">Catalog Item</dt><dd className="text-ink mt-0.5">{catalogItems.find(c => c.id === addDsCatalogId)?.name || '\u2014'}</dd></div>
                        <div><dt className="text-ink-muted">Label</dt><dd className="text-ink mt-0.5">{addDsLabel || '\u2014'}</dd></div>
                        <div><dt className="text-ink-muted">Workspace</dt><dd className="text-ink mt-0.5">{workspace?.name || '\u2014'}</dd></div>
                        <div><dt className="text-ink-muted">Ontology</dt><dd className="text-ink mt-0.5">{addDsOntologyId ? ontologies.find(o => o.id === addDsOntologyId)?.name || addDsOntologyId : 'System defaults'}</dd></div>
                    </dl>
                </div>
            ),
        },
    ]

    // ── Render ─────────────────────────────────────────────
    if (isLoading) {
        return <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
    }

    if (!workspace) {
        return (
            <div className="flex flex-col items-center justify-center h-full">
                <p className="text-ink-muted">Workspace not found.</p>
                <button onClick={() => navigate('/admin/registry?tab=workspaces')} className="mt-4 text-indigo-500 hover:underline text-sm">&larr; Back to Workspaces</button>
            </div>
        )
    }

    return (
        <div className="p-8 max-w-5xl mx-auto">
            {/* Back */}
            <button onClick={() => navigate('/admin/registry?tab=workspaces')} className="flex items-center gap-1.5 text-sm text-ink-muted hover:text-ink transition-colors mb-6">
                <ChevronLeft className="w-4 h-4" /> Back to Workspaces
            </button>

            {/* Hero Header */}
            <WorkspaceHeroHeader
                workspace={workspace}
                healthStatus={healthStatus}
                aggregateStats={aggregateStats}
                primaryOntologyName={primaryOntologyName}
                providerInfos={Object.values(dsProviderMap)}
                isEditing={editingHeader}
                editName={editName}
                editDesc={editDesc}
                onEditNameChange={setEditName}
                onEditDescChange={setEditDesc}
                onStartEdit={() => setEditingHeader(true)}
                onSave={handleSaveHeader}
                onCancel={() => { setEditingHeader(false); setEditName(workspace.name); setEditDesc(workspace.description || '') }}
            />

            {/* Quick-links bar */}
            <div className="flex items-center gap-2 mt-6 mb-2">
                <span className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mr-1">Quick Links</span>
                <Link to={`/explorer?workspace=${wsId}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted border border-glass-border hover:text-indigo-500 hover:border-indigo-500/20 hover:bg-indigo-500/5 transition-colors">
                    <Compass className="w-3 h-3" /> Explorer
                </Link>
                <Link to={`/schema?workspaceId=${wsId}`}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted border border-glass-border hover:text-violet-500 hover:border-violet-500/20 hover:bg-violet-500/5 transition-colors">
                    <GitBranch className="w-3 h-3" /> Schema Editor
                </Link>
                <Link to="/admin/registry?tab=jobs"
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium text-ink-muted border border-glass-border hover:text-emerald-500 hover:border-emerald-500/20 hover:bg-emerald-500/5 transition-colors">
                    <Settings2 className="w-3 h-3" /> Global Jobs
                </Link>
            </div>

            {/* Section Tabs */}
            <div className="flex items-center gap-1 border-b border-glass-border mt-4 mb-0">
                {([
                    { id: 'sources' as const, label: 'Data Sources', icon: Database, count: workspace.dataSources.length, hint: 'Graph databases connected to this workspace' },
                    { id: 'views' as const, label: 'Views', icon: Eye, count: allWorkspaceViews.length, hint: 'Saved visual perspectives on your data' },
                    { id: 'aggregation' as const, label: 'Aggregation', icon: Settings2, hint: 'Edge materialization and job monitoring' },
                    { id: 'ontology' as const, label: 'Ontology', icon: GitBranch, hint: 'Semantic type system and change history' },
                ]).map(tab => {
                    const Icon = tab.icon
                    const isActive = activeSection === tab.id
                    return (
                        <button key={tab.id} onClick={() => setActiveSection(tab.id)}
                            title={tab.hint}
                            className={cn(
                                'flex items-center gap-2 px-5 py-3 text-sm font-semibold transition-all border-b-2',
                                isActive ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                         : 'border-transparent text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 rounded-t-xl'
                            )}>
                            <Icon className="w-4 h-4" />
                            {tab.label}
                            {tab.count !== undefined && (
                                <span className={cn("px-1.5 py-0.5 rounded-full text-[10px] font-bold",
                                    isActive ? "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                                )}>{tab.count}</span>
                            )}
                        </button>
                    )
                })}
            </div>

            {/* ── Data Sources Tab ─────────────────────────── */}
            {activeSection === 'sources' && (
                <>
                    {/* Section intro */}
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm text-ink-secondary leading-relaxed">
                                Data sources are the graph databases that feed this workspace. Each source can have its own ontology and aggregation configuration.
                                <span className="text-ink-muted"> Click on any card below to inspect its details, configure aggregation, or browse associated views.</span>
                            </p>
                        </div>
                    </div>

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
                            <h4 className="text-sm font-bold text-ink mb-2">No data sources connected</h4>
                            <p className="text-xs text-ink-muted mb-1 max-w-md text-center">
                                Data sources connect this workspace to your enterprise graph databases. Once connected, you can configure ontologies, run aggregation, and create views.
                            </p>
                            <div className="flex items-center gap-4 mt-4 text-[10px] text-ink-muted">
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">1</span> Add a source</span>
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">2</span> Assign ontology</span>
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">3</span> Run aggregation</span>
                                <span className="flex items-center gap-1.5"><span className="w-5 h-5 rounded-full bg-indigo-500/10 text-indigo-500 flex items-center justify-center text-[9px] font-bold">4</span> Create views</span>
                            </div>
                            <button onClick={() => { resetAddDs(); setShowAddDs(true) }}
                                className="flex items-center gap-2 px-4 py-2 mt-5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold">
                                <Plus className="w-4 h-4" /> Add First Source
                            </button>
                        </div>
                    ) : (
                        <>
                            {/* Hint for first-time users */}
                            {!selectedDsId && workspace.dataSources.length > 0 && (
                                <div className="flex items-center gap-2 px-3 py-2 mb-3 rounded-lg bg-indigo-500/5 border border-indigo-500/10 text-xs text-indigo-600 dark:text-indigo-400">
                                    <HelpCircle className="w-3.5 h-3.5 shrink-0" />
                                    <span>Click on a data source card to open its detail panel with insights, aggregation settings, and views.</span>
                                </div>
                            )}

                            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                                {workspace.dataSources.map(ds => {
                                    const onto = ds.ontologyId ? ontologyMap[ds.ontologyId] : undefined
                                    return (
                                        <DataSourceGridCard
                                            key={ds.id}
                                            ds={ds}
                                            stats={dsStatsMap[ds.id]}
                                            providerInfo={dsProviderMap[ds.id]}
                                            ontologyName={onto?.name}
                                            ontologyVersion={onto?.version}
                                            ontologyPublished={onto?.isPublished}
                                            viewCount={(viewsByDs[ds.id] || []).length}
                                            isSelected={selectedDsId === ds.id}
                                            onSelect={() => setSelectedDsId(prev => prev === ds.id ? null : ds.id)}
                                            onSetPrimary={() => handleSetPrimary(ds.id)}
                                        />
                                    )
                                })}
                            </div>
                        </>
                    )}
                </>
            )}

            {/* ── Views Tab ────────────────────────────────── */}
            {activeSection === 'views' && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-cyan-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Views are saved visual perspectives on your graph data — like dashboards for your knowledge graph. Each view can display data as a hierarchy, lineage map, reference model, or table.
                            <span className="text-ink-muted"> Filter by data source or search to find specific views. Click any view to open it.</span>
                        </p>
                    </div>
                    <WorkspaceViewsSection wsId={wsId!} dataSources={workspace.dataSources} views={allWorkspaceViews} />
                </>
            )}

            {/* ── Aggregation Tab ──────────────────────────── */}
            {activeSection === 'aggregation' && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Aggregation materializes lineage edges by traversing your graph and computing transitive relationships.
                            This pre-computation enables fast lineage queries in views.
                            <span className="text-ink-muted"> Monitor job progress, configure projection modes, and manage aggregation schedules for each data source below.</span>
                        </p>
                    </div>
                    <WorkspaceAggregationDashboard
                        dataSources={workspace.dataSources}
                        readinessMap={readinessMap}
                        onReaggregate={handleReaggregate}
                        onPurge={handlePurge}
                    />
                </>
            )}

            {/* ── Ontology Tab ─────────────────────────────── */}
            {activeSection === 'ontology' && (
                <>
                    <div className="flex items-start gap-3 py-4 mb-2">
                        <Info className="w-4 h-4 text-violet-500 shrink-0 mt-0.5" />
                        <p className="text-sm text-ink-secondary leading-relaxed">
                            Ontologies define the semantic type system — which entity types and relationship types exist in your data.
                            Each data source can use its own ontology version.
                            <span className="text-ink-muted"> The timeline below shows all changes across ontologies assigned to this workspace's data sources.</span>
                        </p>
                    </div>
                    <WorkspaceOntologyTimeline dataSources={workspace.dataSources} ontologyMap={ontologyMap} />
                </>
            )}

            {/* ── Modals ──────────────────────────────────── */}
            <AdminWizard
                title="Add Data Source"
                steps={addDsSteps}
                isOpen={showAddDs}
                onClose={() => { setShowAddDs(false); resetAddDs() }}
                onComplete={handleAddDsComplete}
                isSubmitting={addDsSubmitting}
                completionLabel="Add Source"
            />

            {deleteTarget && (
                <div className="fixed inset-0 z-[60] flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !loadingImpact && setDeleteTarget(null)} />
                    <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                                <Trash2 className="w-5 h-5 text-red-500" />
                            </div>
                            <h3 className="text-lg font-bold text-ink">Remove Data Source</h3>
                        </div>
                        <p className="text-sm text-ink-secondary mb-4">
                            Are you sure you want to decouple <strong>{deleteTarget.label}</strong> from this domain?
                        </p>

                        {loadingImpact ? (
                            <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
                        ) : deleteImpact && deleteImpact.views.length > 0 ? (
                            <div className="mb-6 p-4 rounded-xl border border-red-500/20 bg-red-500/5 text-sm">
                                <h4 className="font-bold text-red-500 mb-2 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Blast Radius Warning</h4>
                                <p className="text-red-400 mb-3 text-xs leading-relaxed">
                                    Removing this data source will instantly break the following semantic views in this workspace:
                                </p>
                                <div className="space-y-2 text-xs text-red-500 font-medium max-h-48 overflow-y-auto mt-2 p-2 bg-red-500/10 rounded-lg">
                                    <p className="font-bold underline mb-1">{deleteImpact.views.length} Semantic Views:</p>
                                    <ul className="list-disc pl-4 space-y-0.5">
                                        {deleteImpact.views.map(v => <li key={v.id}>{v.name}</li>)}
                                    </ul>
                                </div>
                            </div>
                        ) : (
                            <div className="mb-6 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm font-medium flex items-center gap-2">
                                <ShieldAlert className="w-4 h-4" /> Safe to decouple. No views explicitly depend on this data source.
                            </div>
                        )}

                        <div className="flex justify-end gap-3">
                            <button onClick={() => { setDeleteTarget(null); setDeleteImpact(null); }} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors">Cancel</button>
                            <button onClick={handleDeleteDs} disabled={loadingImpact} className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2">
                                {loadingImpact ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Confirm Removal
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {editingDs && (
                <EditDsModal
                    ds={editingDs}
                    ontologies={ontologies}
                    onSave={handleEditDsSave}
                    onClose={() => setEditingDs(null)}
                />
            )}

            {/* Data source detail drawer (renders via portal — no scroll impact) */}
            <DataSourceDetailPanel
                ds={selectedDs}
                isOpen={!!selectedDsId && !!selectedDs}
                wsId={wsId!}
                stats={selectedDsId ? dsStatsMap[selectedDsId] : undefined}
                providerInfo={selectedDsId ? dsProviderMap[selectedDsId] : undefined}
                ontologyName={selectedDsId ? ontologyNameMap[selectedDs?.ontologyId || ''] : undefined}
                ontologyId={selectedDs?.ontologyId}
                views={selectedDsId ? (viewsByDs[selectedDsId] || []) : []}
                onEdit={() => { if (selectedDs) setEditingDs(selectedDs) }}
                onDelete={workspace.dataSources.length > 1 && selectedDs
                    ? () => handleDeleteDsClick(selectedDs.id, selectedDs.label || selectedDs.id)
                    : undefined}
                onExplore={() => navigate(`/schema?workspaceId=${workspace.id}&dataSourceId=${selectedDsId}`)}
                onReaggregate={() => { if (selectedDs) handleReaggregate(selectedDs) }}
                onPurge={async () => { if (selectedDs) await handlePurge(selectedDs) }}
                onSetPrimary={() => { if (selectedDsId) handleSetPrimary(selectedDsId) }}
                onProjectionModeChange={mode => { if (selectedDsId) handleProjectionMode(selectedDsId, mode) }}
                onDedicatedGraphNameChange={name => { if (selectedDsId) handleDedicatedGraphName(selectedDsId, name) }}
                onClose={() => setSelectedDsId(null)}
            />
        </div>
    )
}
