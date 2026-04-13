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
    Trash2, GitBranch, Eye,
} from 'lucide-react'
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
        workspace, catalogItems, ontologies, ontologyMap, dsStatsMap,
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
                isEditing={editingHeader}
                editName={editName}
                editDesc={editDesc}
                onEditNameChange={setEditName}
                onEditDescChange={setEditDesc}
                onStartEdit={() => setEditingHeader(true)}
                onSave={handleSaveHeader}
                onCancel={() => { setEditingHeader(false); setEditName(workspace.name); setEditDesc(workspace.description || '') }}
            />

            {/* Section Tabs */}
            <div className="flex items-center gap-1 border-b border-glass-border mt-8 mb-6">
                {([
                    { id: 'sources' as const, label: 'Data Sources', icon: Database, count: workspace.dataSources.length },
                    { id: 'views' as const, label: 'Views', icon: Eye, count: allWorkspaceViews.length },
                    { id: 'aggregation' as const, label: 'Aggregation', icon: Settings2 },
                    { id: 'ontology' as const, label: 'Ontology', icon: GitBranch },
                ]).map(tab => {
                    const Icon = tab.icon
                    const isActive = activeSection === tab.id
                    return (
                        <button key={tab.id} onClick={() => setActiveSection(tab.id)}
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
                        <>
                            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-3">
                                {workspace.dataSources.map(ds => {
                                    const onto = ds.ontologyId ? ontologyMap[ds.ontologyId] : undefined
                                    return (
                                        <DataSourceGridCard
                                            key={ds.id}
                                            ds={ds}
                                            stats={dsStatsMap[ds.id]}
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

                            {/* Detail panel for selected DS */}
                            {selectedDsId && workspace.dataSources.find(ds => ds.id === selectedDsId) && (
                                <DataSourceDetailPanel
                                    ds={workspace.dataSources.find(ds => ds.id === selectedDsId)!}
                                    wsId={wsId!}
                                    stats={dsStatsMap[selectedDsId]}
                                    ontologyName={ontologyNameMap[workspace.dataSources.find(ds => ds.id === selectedDsId)?.ontologyId || '']}
                                    views={viewsByDs[selectedDsId] || []}
                                    onEdit={() => setEditingDs(workspace.dataSources.find(ds => ds.id === selectedDsId)!)}
                                    onDelete={workspace.dataSources.length > 1
                                        ? () => handleDeleteDsClick(selectedDsId, workspace.dataSources.find(ds => ds.id === selectedDsId)?.label || selectedDsId)
                                        : undefined}
                                    onExplore={() => navigate(`/schema?workspaceId=${workspace.id}&dataSourceId=${selectedDsId}`)}
                                    onReaggregate={() => handleReaggregate(workspace.dataSources.find(ds => ds.id === selectedDsId)!)}
                                    onPurge={() => handlePurge(workspace.dataSources.find(ds => ds.id === selectedDsId)!)}
                                    onSetPrimary={() => handleSetPrimary(selectedDsId)}
                                    onProjectionModeChange={mode => handleProjectionMode(selectedDsId, mode)}
                                    onDedicatedGraphNameChange={name => handleDedicatedGraphName(selectedDsId, name)}
                                    onClose={() => setSelectedDsId(null)}
                                />
                            )}
                        </>
                    )}
                </>
            )}

            {/* ── Views Tab ────────────────────────────────── */}
            {activeSection === 'views' && (
                <WorkspaceViewsSection wsId={wsId!} dataSources={workspace.dataSources} views={allWorkspaceViews} />
            )}

            {/* ── Aggregation Tab ──────────────────────────── */}
            {activeSection === 'aggregation' && (
                <WorkspaceAggregationDashboard
                    dataSources={workspace.dataSources}
                    readinessMap={readinessMap}
                    onReaggregate={handleReaggregate}
                    onPurge={handlePurge}
                />
            )}

            {/* ── Ontology Tab ─────────────────────────────── */}
            {activeSection === 'ontology' && (
                <WorkspaceOntologyTimeline dataSources={workspace.dataSources} ontologyMap={ontologyMap} />
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
        </div>
    )
}
