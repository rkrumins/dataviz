import { useState, useCallback, useEffect, type FC } from 'react'
import { Database, Plus, Trash2, CheckCircle, AlertCircle, Server, Shield, Layers, Edit2, Check } from 'lucide-react'
import { useWorkspacesStore } from '@/store/workspaces'
import {
    workspaceService,
    type WorkspaceCreateRequest,
    type WorkspaceUpdateRequest,
    type WorkspaceResponse,
    type DataSourceCreateRequest,
    type DataSourceUpdateRequest,
    type DataSourceResponse,
} from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { ontologyDefinitionService, type OntologyDefinitionResponse } from '@/services/ontologyDefinitionService'

// ============================================================
// Helpers
// ============================================================

function statusBadge(ws: WorkspaceResponse) {
    if (!ws.isActive) return <span className="flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-500"><AlertCircle className="w-3 h-3" /> Inactive</span>
    if (ws.isDefault) return <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-500"><CheckCircle className="w-3 h-3" /> Default</span>
    return <span className="flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-500">Active</span>
}

interface DataSourceFormRow {
    providerId: string
    graphName: string
    ontologyId: string
    label: string
}

const EMPTY_DS_ROW: DataSourceFormRow = {
    providerId: '',
    graphName: '',
    ontologyId: '',
    label: '',
}

// ============================================================
// DSRowEditor — reusable row for creating or editing data sources
// ============================================================

interface DSRowEditorProps {
    row: DataSourceFormRow
    index: number
    providers: ProviderResponse[]
    ontologies: OntologyDefinitionResponse[]
    canRemove: boolean
    onChange: (index: number, row: DataSourceFormRow) => void
    onRemove: (index: number) => void
    onFetchGraphs: (providerId: string) => Promise<string[]>
}

export const DSRowEditor: FC<DSRowEditorProps> = ({
    row, index, providers, ontologies, canRemove,
    onChange, onRemove, onFetchGraphs,
}) => {
    const [availableGraphs, setAvailableGraphs] = useState<string[]>([])
    const [graphsLoading, setGraphsLoading] = useState(false)

    // Ensure we load graphs if providerId is present initially (like on edit)
    useEffect(() => {
        if (row.providerId) {
            handleBrowse()
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const update = (field: keyof DataSourceFormRow, value: string) => {
        onChange(index, { ...row, [field]: value })
        if (field === 'providerId') setAvailableGraphs([])
    }

    const handleBrowse = async () => {
        if (!row.providerId) return
        setGraphsLoading(true)
        try {
            const graphs = await onFetchGraphs(row.providerId)
            setAvailableGraphs(graphs)
        } catch { } finally {
            setGraphsLoading(false)
        }
    }

    return (
        <div className="flex flex-col gap-3 rounded-xl border border-glass-border p-5 bg-black/5 dark:bg-white/5 transition-all duration-200 hover:shadow-md hover:bg-black/10 dark:hover:bg-white/10 group mb-3 last:mb-0">
            <div className="flex items-center justify-between border-b border-glass-border pb-3 mb-2">
                <span className="text-xs font-semibold text-ink-secondary flex items-center gap-1.5 uppercase tracking-wider">
                    <Server className="w-4 h-4" />
                    Data Source {index + 1}
                </span>
                {canRemove && (
                    <button
                        type="button"
                        onClick={() => onRemove(index)}
                        className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity px-2 py-1 rounded hover:bg-red-500/10"
                    >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                )}
            </div>

            <div className="grid grid-cols-2 gap-5">
                {/* Provider */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    PROVIDER *
                    <select
                        value={row.providerId}
                        onChange={(e) => update('providerId', e.target.value)}
                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                    >
                        <option value="">Select a provider...</option>
                        {providers.map((p) => (
                            <option key={p.id} value={p.id}>
                                {p.name} ({p.providerType}{p.host ? ` · ${p.host}` : ''})
                            </option>
                        ))}
                    </select>
                </label>

                {/* Graph name */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    GRAPH / DATASET NAME *
                    <div className="flex gap-2">
                        {availableGraphs.length > 0 ? (
                            <select
                                value={row.graphName}
                                onChange={(e) => update('graphName', e.target.value)}
                                className="flex-1 rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                            >
                                <option value="">Select a graph...</option>
                                {availableGraphs.map((g) => (
                                    <option key={g} value={g}>{g}</option>
                                ))}
                            </select>
                        ) : (
                            <input
                                type="text"
                                value={row.graphName}
                                onChange={(e) => update('graphName', e.target.value)}
                                placeholder="nexus_lineage"
                                className="flex-1 rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                            />
                        )}
                        {row.providerId && (
                            <button
                                type="button"
                                onClick={handleBrowse}
                                disabled={graphsLoading}
                                className="rounded-lg border border-glass-border px-3 py-2.5 text-xs font-medium bg-canvas hover:bg-black/5 dark:hover:bg-white/5 transition-all text-ink-secondary"
                                title="Fetch available graphs"
                            >
                                {graphsLoading ? '...' : 'Browse'}
                            </button>
                        )}
                    </div>
                </label>
            </div>

            <div className="grid grid-cols-2 gap-5 mt-2">
                {/* Label */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    DISPLAY LABEL (OPTIONAL)
                    <input
                        type="text"
                        value={row.label}
                        onChange={(e) => update('label', e.target.value)}
                        placeholder="e.g. Core Master Data"
                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                    />
                </label>

                {/* Ontology */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    ONTOLOGY
                    <select
                        value={row.ontologyId}
                        onChange={(e) => update('ontologyId', e.target.value)}
                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                    >
                        <option value="">None (infer schema from data)</option>
                        {ontologies.map((ont) => (
                            <option key={ont.id} value={ont.id}>
                                {ont.name} v{ont.version}
                                {ont.isPublished ? ' (published)' : ' (draft)'}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
        </div>
    )
}

// ============================================================
// DataSourceList — manage data sources of an existing workspace
// ============================================================

interface DataSourceListProps {
    workspace: WorkspaceResponse
    onRefresh: () => void
    providers: ProviderResponse[]
    ontologies: OntologyDefinitionResponse[]
}

const DataSourceList: FC<DataSourceListProps> = ({ workspace, onRefresh, providers, ontologies }) => {
    const [adding, setAdding] = useState(false)
    const [editingDsId, setEditingDsId] = useState<string | null>(null)
    const [rowState, setRowState] = useState<DataSourceFormRow>({ ...EMPTY_DS_ROW })
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const setActiveDataSource = useWorkspacesStore((s) => s.setActiveDataSource)

    const handleFetchGraphs = async (providerId: string) => {
        const result = await providerService.listGraphs(providerId)
        return result.graphs ?? []
    }

    const handleSave = async () => {
        if (!rowState.providerId || !rowState.graphName) return
        setLoading(true)
        setError(null)
        try {
            if (editingDsId) {
                const req: DataSourceUpdateRequest = {
                    providerId: rowState.providerId,
                    graphName: rowState.graphName,
                    ontologyId: rowState.ontologyId || undefined,
                    label: rowState.label || undefined,
                }
                await workspaceService.updateDataSource(workspace.id, editingDsId, req)
                setEditingDsId(null)
            } else {
                const req: DataSourceCreateRequest = {
                    providerId: rowState.providerId,
                    graphName: rowState.graphName,
                    ontologyId: rowState.ontologyId || undefined,
                    label: rowState.label || undefined,
                }
                await workspaceService.addDataSource(workspace.id, req)
                setAdding(false)
            }
            setRowState({ ...EMPTY_DS_ROW })
            onRefresh()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to save data source')
        } finally {
            setLoading(false)
        }
    }

    const handleEditSetup = (ds: DataSourceResponse) => {
        setEditingDsId(ds.id)
        setRowState({
            providerId: ds.providerId,
            graphName: ds.graphName || '',
            ontologyId: ds.ontologyId || '',
            label: ds.label || '',
        })
        setAdding(false) // make sure adding is off
        setError(null)
    }

    const handleRemove = async (dsId: string) => {
        if (!confirm('Remove this data source?')) return
        setLoading(true)
        setError(null)
        try {
            await workspaceService.removeDataSource(workspace.id, dsId)
            onRefresh()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to remove data source')
        } finally {
            setLoading(false)
        }
    }

    const handleSetPrimary = async (dsId: string) => {
        setLoading(true)
        setError(null)
        try {
            await workspaceService.setPrimaryDataSource(workspace.id, dsId)
            onRefresh()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to set primary')
        } finally {
            setLoading(false)
        }
    }

    const dataSources = workspace.dataSources ?? []

    return (
        <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-glass-border ml-2 mr-2">
            <div className="flex items-center justify-between pl-1">
                <span className="text-[11px] font-bold text-ink-muted uppercase tracking-wider flex items-center gap-1.5">
                    <Layers className="w-3.5 h-3.5" /> Attached Sources
                </span>
                {!adding && !editingDsId && (
                    <button
                        onClick={() => { setAdding(true); setRowState({ ...EMPTY_DS_ROW }); setError(null); }}
                        className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                    >
                        <Plus className="w-3 h-3" /> Attach Source
                    </button>
                )}
            </div>

            {dataSources.length === 0 && !adding ? (
                <div className="text-xs text-ink-muted italic p-4 bg-black/5 dark:bg-white/5 rounded-xl border border-dashed border-glass-border text-center">
                    No data sources attached to this workspace.
                </div>
            ) : (
                <ul className="flex flex-col gap-3">
                    {dataSources.map((ds) => {
                        if (editingDsId === ds.id) {
                            return (
                                <div key={ds.id} className="flex flex-col gap-3 p-4 mt-2 mb-2 rounded-xl bg-canvas-elevated border-2 border-accent-business/50 shadow-md animate-in fade-in duration-200">
                                    <span className="text-[11px] font-bold text-ink-muted uppercase tracking-wider mb-1 flex justify-between">
                                        Edit Data Source
                                    </span>
                                    <DSRowEditor
                                        row={rowState}
                                        index={0}
                                        providers={providers}
                                        ontologies={ontologies}
                                        canRemove={false}
                                        onChange={(_, row) => setRowState(row)}
                                        onRemove={() => { }}
                                        onFetchGraphs={handleFetchGraphs}
                                    />
                                    <div className="flex gap-2 justify-end mt-2 pt-3 border-t border-glass-border">
                                        <button
                                            onClick={() => { setEditingDsId(null); setRowState({ ...EMPTY_DS_ROW }) }}
                                            className="rounded-lg px-4 py-2 text-xs font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={handleSave}
                                            disabled={!rowState.providerId || !rowState.graphName || loading}
                                            className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-5 py-2 text-xs font-semibold text-white disabled:opacity-50 disabled:grayscale hover:shadow-lg transition-all"
                                        >
                                            {loading ? 'Saving...' : 'Save Changes'}
                                        </button>
                                    </div>
                                    {error && <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded-lg border border-red-500/20">{error}</p>}
                                </div>
                            )
                        }

                        return (
                            <li
                                key={ds.id}
                                className={`flex flex-col gap-2 rounded-xl border px-4 py-3 text-xs transition-all group ${ds.id === activeDataSourceId
                                    ? 'border-accent-business/60 bg-accent-business/5 shadow-sm'
                                    : 'border-glass-border bg-canvas hover:border-glass-border-strong hover:bg-black/5 dark:hover:bg-white/5'
                                    }`}
                            >
                                <div className="flex items-start justify-between">
                                    <div className="flex flex-col gap-1.5 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="font-semibold text-ink truncate text-sm">{ds.label || ds.graphName}</span>
                                            {ds.isPrimary && (
                                                <span className="shrink-0 flex items-center gap-1 text-[10px] bg-accent-business/10 text-accent-business border border-accent-business/20 px-1.5 py-0.5 rounded-full font-medium">
                                                    <CheckCircle className="w-3 h-3" /> Default Primary
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-[11px] text-ink-muted flex items-center gap-1.5 font-mono bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded max-w-fit mt-0.5">
                                            <Server className="w-3 h-3" /> {ds.providerId}
                                            {ds.label && <span className="opacity-50">· {ds.graphName}</span>}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0 ml-4">
                                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={() => handleEditSetup(ds)}
                                                disabled={loading}
                                                className="p-1.5 rounded bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                                title="Edit Data Source"
                                            >
                                                <Edit2 className="w-3.5 h-3.5" />
                                            </button>
                                            {!ds.isPrimary && (
                                                <button
                                                    onClick={() => handleSetPrimary(ds.id)}
                                                    disabled={loading}
                                                    className="p-1.5 rounded bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                                    title="Set as Primary Source"
                                                >
                                                    <Shield className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                            {dataSources.length > 1 && (
                                                <button
                                                    onClick={() => handleRemove(ds.id)}
                                                    disabled={loading}
                                                    className="p-1.5 text-red-500 bg-canvas border border-transparent hover:bg-red-500/10 hover:border-red-500/20 rounded transition-colors disabled:opacity-50"
                                                    title="Remove Data Source"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                </button>
                                            )}
                                        </div>
                                        <div className="w-px h-5 bg-glass-border mx-1 opacity-0 group-hover:opacity-100 transition-opacity" />
                                        {ds.id !== activeDataSourceId ? (
                                            <button
                                                onClick={() => setActiveDataSource(ds.id)}
                                                className="px-3 py-1.5 text-[11px] font-semibold rounded-lg bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                            >
                                                Equip Data
                                            </button>
                                        ) : (
                                            <span className="px-3 py-1.5 text-[11px] font-bold text-accent-business flex items-center gap-1">
                                                <Check className="w-3.5 h-3.5" /> Equipped
                                            </span>
                                        )}
                                    </div>
                                </div>
                            </li>
                        )
                    })}
                </ul>
            )}

            {adding && (
                <div className="flex flex-col gap-3 p-4 mt-2 rounded-xl bg-canvas-elevated border border-glass-border shadow-md animate-in slide-in-from-top-2 fade-in duration-200">
                    <span className="text-[11px] font-bold text-ink-muted uppercase tracking-wider mb-1">New Data Source</span>
                    <DSRowEditor
                        row={rowState}
                        index={0}
                        providers={providers}
                        ontologies={ontologies}
                        canRemove={false}
                        onChange={(_, row) => setRowState(row)}
                        onRemove={() => { }}
                        onFetchGraphs={handleFetchGraphs}
                    />
                    <div className="flex gap-2 justify-end mt-2 pt-3 border-t border-glass-border">
                        <button
                            onClick={() => { setAdding(false); setRowState({ ...EMPTY_DS_ROW }) }}
                            className="rounded-lg px-4 py-2 text-xs font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={!rowState.providerId || !rowState.graphName || loading}
                            className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-5 py-2 text-xs font-semibold text-white disabled:opacity-50 disabled:grayscale hover:shadow-lg transition-all"
                        >
                            {loading ? 'Attaching...' : 'Attach Source'}
                        </button>
                    </div>
                </div>
            )}
            {error && !editingDsId && <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded-lg border border-red-500/20 mt-2">{error}</p>}
        </div>
    )
}

// ============================================================
// EnvironmentsTab main
// ============================================================

interface FormState {
    name: string
    description: string
    dataSources: DataSourceFormRow[]
}

const DEFAULT_FORM: FormState = {
    name: '',
    description: '',
    dataSources: [{ ...EMPTY_DS_ROW }],
}

export const EnvironmentsTab: FC = () => {
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)
    const addWorkspace = useWorkspacesStore((s) => s.addWorkspace)
    const updateWorkspaceState = useWorkspacesStore((s) => s.updateWorkspace)
    const removeWorkspace = useWorkspacesStore((s) => s.removeWorkspace)
    const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
    const isLoading = useWorkspacesStore((s) => s.isLoading)

    const [showForm, setShowForm] = useState(false)
    const [editingWsId, setEditingWsId] = useState<string | null>(null)
    const [expandedWs, setExpandedWs] = useState<string | null>(null)
    const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM })
    const [actionLoading, setActionLoading] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [ontologies, setOntologies] = useState<OntologyDefinitionResponse[]>([])

    // Load available dependencies
    useEffect(() => {
        providerService.list().then(setProviders).catch(() => { })
        ontologyDefinitionService.list().then(setOntologies).catch(() => { })
    }, [])

    const clearError = useCallback(() => setActionError(null), [])

    const handleFetchGraphs = useCallback(async (providerId: string) => {
        const result = await providerService.listGraphs(providerId)
        return result.graphs ?? []
    }, [])

    const updateDsRow = useCallback((index: number, row: DataSourceFormRow) => {
        setForm((prev) => {
            const dataSources = [...prev.dataSources]
            dataSources[index] = row
            return { ...prev, dataSources }
        })
        clearError()
    }, [clearError])

    const removeDsRow = useCallback((index: number) => {
        setForm((prev) => ({
            ...prev,
            dataSources: prev.dataSources.filter((_, i) => i !== index),
        }))
    }, [])

    const addDsRow = useCallback(() => {
        setForm((prev) => ({
            ...prev,
            dataSources: [...prev.dataSources, { ...EMPTY_DS_ROW }],
        }))
    }, [])

    const handleSave = useCallback(async () => {
        setActionLoading(true)
        setActionError(null)
        try {
            if (editingWsId) {
                const req: WorkspaceUpdateRequest = {
                    name: form.name,
                    description: form.description || undefined,
                }
                const ws = await workspaceService.update(editingWsId, req)
                updateWorkspaceState(ws)
                setEditingWsId(null)
            } else {
                const req: WorkspaceCreateRequest = {
                    name: form.name,
                    description: form.description || undefined,
                    dataSources: form.dataSources
                        .filter((ds) => ds.providerId && ds.graphName)
                        .map((ds) => ({
                            providerId: ds.providerId,
                            graphName: ds.graphName,
                            ontologyId: ds.ontologyId || undefined,
                            label: ds.label || undefined,
                        })),
                }
                const ws = await workspaceService.create(req)
                addWorkspace(ws)
            }
            setShowForm(false)
            setForm({ name: '', description: '', dataSources: [{ ...EMPTY_DS_ROW }] })
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Failed to save workspace')
        } finally {
            setActionLoading(false)
        }
    }, [form, editingWsId, updateWorkspaceState, addWorkspace])

    const handleDelete = useCallback(async (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation()
        if (!confirm('Delete this workspace? This cannot be undone.')) return
        setActionLoading(true)
        try {
            await workspaceService.delete(id)
            removeWorkspace(id)
            if (expandedWs === id) setExpandedWs(null)
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Failed to delete workspace')
        } finally {
            setActionLoading(false)
        }
    }, [removeWorkspace, expandedWs])

    const handleSetDefault = useCallback(async (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation()
        setActionLoading(true)
        try {
            await workspaceService.setDefault(id)
            await loadWorkspaces()
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Failed to set default')
        } finally {
            setActionLoading(false)
        }
    }, [loadWorkspaces])

    const startEditing = (ws: WorkspaceResponse, e?: React.MouseEvent) => {
        e?.stopPropagation()
        setEditingWsId(ws.id)
        setForm({
            name: ws.name,
            description: ws.description || '',
            dataSources: [] // not editable from the top level Workspace edit
        })
        setShowForm(true)
        clearError()
    }

    const canCreate = form.name.trim() && (editingWsId || form.dataSources.some((ds) => ds.providerId && ds.graphName))

    return (
        <div className="flex flex-col gap-5 p-5 pb-10 overflow-y-auto h-full">
            {/* Workspace list */}
            {isLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 opacity-60">
                    <div className="w-6 h-6 border-2 border-accent-business border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-medium">Loading environments...</span>
                </div>
            ) : workspaces.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-10 mt-4 rounded-2xl border border-dashed border-glass-border bg-black/5 dark:bg-white/5 text-center">
                    <div className="w-12 h-12 rounded-full bg-accent-business/10 flex items-center justify-center mb-4">
                        <Database className="w-6 h-6 text-accent-business" />
                    </div>
                    <h3 className="text-base font-semibold mb-1">No Workspaces Found</h3>
                    <p className="text-sm text-ink-muted max-w-sm mb-5">
                        Workspaces let you bind multiple data sources and ontologies together. Create your first environment to begin.
                    </p>
                    <button
                        onClick={() => { setEditingWsId(null); setForm({ name: '', description: '', dataSources: [{ ...EMPTY_DS_ROW }] }); setShowForm(true); }}
                        className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg transition-all focus:outline-none focus:ring-2 focus:ring-accent-business"
                    >
                        Create Workspace
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-ink-muted uppercase tracking-wider">Configured Environments</span>
                        {!showForm && (
                            <button
                                onClick={() => {
                                    setEditingWsId(null)
                                    setForm({ name: '', description: '', dataSources: [{ ...EMPTY_DS_ROW }] })
                                    setShowForm(true)
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors focus:outline-none focus:ring-2 focus:ring-accent-business"
                            >
                                <Plus className="w-3.5 h-3.5" /> New Workspace
                            </button>
                        )}
                    </div>

                    {/* Action error general */}
                    {actionError && (
                        <div className="p-3 mt-2 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-red-500 text-sm">
                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                            <p>{actionError}</p>
                        </div>
                    )}

                    {/* Create/Edit workspace form inline AT THE TOP */}
                    {showForm && (
                        <div className="p-6 rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl animate-in slide-in-from-top-4 fade-in duration-300 relative overflow-hidden mb-4">
                            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent-business to-accent-lineage" />

                            <div className="flex items-center justify-between mb-6">
                                <div>
                                    <h3 className="text-xl font-bold text-ink tracking-tight">{editingWsId ? 'Edit Workspace Details' : 'New Workspace'}</h3>
                                    <p className="text-sm text-ink-muted mt-1">{editingWsId ? 'Update basic environment metadata.' : 'Define base properties and initial data sources.'}</p>
                                </div>
                            </div>

                            <div className="grid grid-cols-2 gap-6 mb-6">
                                {/* Name */}
                                <label className="flex flex-col gap-1.5 text-xs font-bold text-ink-muted tracking-wide">
                                    WORKSPACE NAME *
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={(e) => {
                                            setForm((prev) => ({ ...prev, name: e.target.value }))
                                            clearError()
                                        }}
                                        placeholder="e.g. Production Analytics"
                                        className="rounded-xl border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200 shadow-sm"
                                        autoFocus
                                    />
                                </label>

                                {/* Description */}
                                <label className="flex flex-col gap-1.5 text-xs font-bold text-ink-muted tracking-wide">
                                    DESCRIPTION
                                    <input
                                        type="text"
                                        value={form.description}
                                        onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                                        placeholder="What is this environment used for?"
                                        className="rounded-xl border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200 shadow-sm"
                                    />
                                </label>
                            </div>

                            {/* Data sources (only on create) */}
                            {!editingWsId && (
                                <div className="flex flex-col gap-4 mt-8 pt-6 border-t border-glass-border border-dashed">
                                    <div className="flex items-center justify-between">
                                        <span className="text-sm font-bold text-ink-muted uppercase tracking-wider flex items-center gap-1.5 text-ink"><Server className="w-5 h-5 text-accent-business" /> Initial Data Sources *</span>
                                        <button
                                            type="button"
                                            onClick={addDsRow}
                                            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all shadow-sm focus:outline-none focus:ring-2 focus:ring-ink"
                                        >
                                            <Plus className="w-4 h-4" /> Add Row
                                        </button>
                                    </div>

                                    <div className="flex flex-col gap-4">
                                        {form.dataSources.map((ds, i) => (
                                            <DSRowEditor
                                                key={i}
                                                row={ds}
                                                index={i}
                                                providers={providers}
                                                ontologies={ontologies}
                                                canRemove={form.dataSources.length > 1}
                                                onChange={updateDsRow}
                                                onRemove={removeDsRow}
                                                onFetchGraphs={handleFetchGraphs}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {/* Form actions */}
                            <div className="flex items-center justify-end gap-3 mt-8 pt-5 border-t border-glass-border">
                                <button
                                    onClick={() => {
                                        setShowForm(false)
                                        setEditingWsId(null)
                                        setForm({ name: '', description: '', dataSources: [{ ...EMPTY_DS_ROW }] })
                                        clearError()
                                    }}
                                    className="rounded-lg px-6 py-2.5 text-sm font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors shadow-sm focus:outline-none focus:ring-2 focus:ring-ink"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={!canCreate || actionLoading}
                                    className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-7 py-2.5 text-sm font-bold text-white shadow-md hover:shadow-lg disabled:opacity-50 disabled:grayscale transition-all flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-accent-business focus:ring-offset-2 focus:ring-offset-canvas"
                                >
                                    {actionLoading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                                    {actionLoading ? 'Saving...' : (editingWsId ? 'Save Changes' : 'Provision Workspace')}
                                </button>
                            </div>
                        </div>
                    )}
                    <ul className="flex flex-col gap-4">
                        {workspaces.map((ws) => {
                            const dsCount = ws.dataSources?.length ?? 0
                            const isExpanded = expandedWs === ws.id

                            return (
                                <li
                                    key={ws.id}
                                    className={`flex flex-col rounded-2xl border p-5 transition-all duration-200 group ${ws.id === activeWorkspaceId
                                        ? 'border-accent-business/50 bg-accent-business/5 shadow-md shadow-accent-business/5'
                                        : 'border-glass-border bg-canvas-elevated hover:shadow-md hover:border-glass-border-strong'
                                        }`}
                                >
                                    <div className="flex items-start justify-between cursor-pointer" onClick={() => setActiveWorkspace(ws.id)}>
                                        <div className="flex gap-4">
                                            <div className={`mt-0.5 w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-inner border transition-colors ${ws.id === activeWorkspaceId ? 'bg-accent-business/20 border-accent-business/30 text-accent-business' : 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-secondary group-hover:text-ink'}`}>
                                                <Database className="w-6 h-6" />
                                            </div>
                                            <div className="flex flex-col gap-1.5 min-w-0">
                                                <div className="flex items-center gap-3">
                                                    <span className="font-extrabold text-lg text-ink tracking-tight">{ws.name}</span>
                                                    {statusBadge(ws)}
                                                </div>
                                                <p className="text-sm text-ink-secondary max-w-lg leading-snug">
                                                    {ws.description || <span className="italic opacity-50">No description provided</span>}
                                                </p>
                                                <div className="flex items-center gap-4 mt-2 text-xs text-ink-muted bg-black/5 dark:bg-white/5 px-2 py-1 rounded max-w-fit border border-glass-border/50">
                                                    <span className="flex items-center gap-1.5 font-medium"><Layers className="w-3.5 h-3.5" /> {dsCount} Sources</span>
                                                    {ws.graphName && <span className="flex items-center gap-1.5"><Server className="w-3.5 h-3.5" /> {ws.graphName}</span>}
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex flex-col items-end gap-2 shrink-0 ml-4">
                                            <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                <button
                                                    onClick={(e) => startEditing(ws, e)}
                                                    className="p-1.5 rounded-lg bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                                    title="Edit Workspace Fields"
                                                >
                                                    <Edit2 className="w-4 h-4" />
                                                </button>
                                                {!ws.isDefault && (
                                                    <button
                                                        onClick={(e) => handleSetDefault(ws.id, e)}
                                                        disabled={actionLoading}
                                                        className="p-1.5 rounded-lg bg-canvas border border-glass-border text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                                        title="Set as Default Workspace"
                                                    >
                                                        <Shield className="w-4 h-4" />
                                                    </button>
                                                )}
                                                <button
                                                    onClick={(e) => handleDelete(ws.id, e)}
                                                    disabled={actionLoading}
                                                    className="p-1.5 text-red-500 bg-canvas border border-transparent hover:bg-red-500/10 hover:border-red-500/20 rounded-lg transition-colors disabled:opacity-50"
                                                    title="Delete Workspace"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>

                                            <div className="flex items-center gap-2 mt-2">
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setExpandedWs(isExpanded ? null : ws.id) }}
                                                    className="px-4 py-2 text-xs font-semibold rounded-lg bg-canvas border border-glass-border text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                                >
                                                    {isExpanded ? 'Hide Sources' : 'Manage Sources'}
                                                </button>
                                                {ws.id !== activeWorkspaceId ? (
                                                    <button
                                                        onClick={(e) => { e.stopPropagation(); setActiveWorkspace(ws.id) }}
                                                        className="px-4 py-2 text-xs font-bold rounded-lg bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                                    >
                                                        Enter Workspace
                                                    </button>
                                                ) : (
                                                    <span className="px-4 py-2 text-xs font-bold text-accent-business flex items-center gap-1.5">
                                                        <Check className="w-4 h-4" /> Active
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Expanded data sources */}
                                    {isExpanded && (
                                        <div className="animate-in slide-in-from-top-2 fade-in duration-200 mt-2">
                                            <DataSourceList workspace={ws} onRefresh={loadWorkspaces} providers={providers} ontologies={ontologies} />
                                        </div>
                                    )}
                                </li>
                            )
                        })}
                    </ul>
                </div>
            )}
        </div>
    )
}
