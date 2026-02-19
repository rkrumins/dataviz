/**
 * WorkspacePanel — settings panel for full CRUD management of workspaces.
 *
 * Features:
 * - List all registered workspaces with status badges
 * - Create new workspaces with one or more data sources
 * - Manage data sources within a workspace (add, remove, set primary)
 * - Set default workspace
 * - Delete workspaces
 */
import { useState, useCallback, useEffect, type FC } from 'react'
import { Database, Plus, Trash2, CheckCircle, AlertCircle, Server, X, Shield, Layers } from 'lucide-react'
import { useWorkspacesStore } from '@/store/workspaces'
import {
    workspaceService,
    type WorkspaceCreateRequest,
    type WorkspaceResponse,
    type DataSourceCreateRequest,
} from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { blueprintService, type BlueprintResponse } from '@/services/blueprintService'

// ============================================================
// Data source form row
// ============================================================

interface DataSourceFormRow {
    providerId: string
    graphName: string
    blueprintId: string
    label: string
}

const EMPTY_DS_ROW: DataSourceFormRow = {
    providerId: '',
    graphName: '',
    blueprintId: '',
    label: '',
}

// ============================================================
// Form state
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

// ============================================================
// Helpers
// ============================================================

function statusBadge(ws: WorkspaceResponse) {
    if (!ws.isActive) return <span className="flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-500"><AlertCircle className="w-3 h-3" /> Inactive</span>
    if (ws.isDefault) return <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-500"><CheckCircle className="w-3 h-3" /> Default</span>
    return <span className="flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-500">Active</span>
}



// ============================================================
// DataSourceFormRowEditor — reusable row for creating a data source
// ============================================================

interface DSRowEditorProps {
    row: DataSourceFormRow
    index: number
    providers: ProviderResponse[]
    blueprints: BlueprintResponse[]
    canRemove: boolean
    onChange: (index: number, row: DataSourceFormRow) => void
    onRemove: (index: number) => void
    onFetchGraphs: (providerId: string) => Promise<string[]>
}

const DSRowEditor: FC<DSRowEditorProps> = ({
    row, index, providers, blueprints, canRemove,
    onChange, onRemove, onFetchGraphs,
}) => {
    const [availableGraphs, setAvailableGraphs] = useState<string[]>([])
    const [graphsLoading, setGraphsLoading] = useState(false)

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
        } finally {
            setGraphsLoading(false)
        }
    }

    return (
        <div className="flex flex-col gap-3 rounded-xl border border-glass-border p-4 bg-black/5 dark:bg-white/5 transition-all duration-200 hover:shadow-md hover:bg-black/10 dark:hover:bg-white/10 group">
            <div className="flex items-center justify-between border-b border-glass-border pb-2 mb-1">
                <span className="text-xs font-semibold text-ink-secondary flex items-center gap-1.5 uppercase tracking-wider">
                    <Server className="w-3.5 h-3.5" />
                    Data Source {index + 1}
                </span>
                {canRemove && (
                    <button
                        type="button"
                        onClick={() => onRemove(index)}
                        className="text-xs text-red-500 hover:text-red-600 flex items-center gap-1 opacity-60 hover:opacity-100 transition-opacity"
                    >
                        <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4">
                {/* Provider */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    PROVIDER *
                    <select
                        value={row.providerId}
                        onChange={(e) => update('providerId', e.target.value)}
                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
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
                                className="flex-1 rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
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
                                className="flex-1 rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                            />
                        )}
                        {row.providerId && (
                            <button
                                type="button"
                                onClick={handleBrowse}
                                disabled={graphsLoading}
                                className="rounded-lg border border-glass-border px-3 py-2 text-xs font-medium bg-canvas hover:bg-black/5 dark:hover:bg-white/5 transition-all text-ink-secondary"
                                title="Fetch available graphs"
                            >
                                {graphsLoading ? '...' : 'Browse'}
                            </button>
                        )}
                    </div>
                </label>
            </div>

            <div className="grid grid-cols-2 gap-4">
                {/* Label */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    DISPLAY LABEL (OPTIONAL)
                    <input
                        type="text"
                        value={row.label}
                        onChange={(e) => update('label', e.target.value)}
                        placeholder="e.g. Core Master Data"
                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                    />
                </label>

                {/* Blueprint */}
                <label className="flex flex-col gap-1.5 text-[11px] font-medium text-ink-muted">
                    ONTOLOGY BLUEPRINT
                    <select
                        value={row.blueprintId}
                        onChange={(e) => update('blueprintId', e.target.value)}
                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                    >
                        <option value="">None (infer schema from data)</option>
                        {blueprints.map((bp) => (
                            <option key={bp.id} value={bp.id}>
                                {bp.name} v{bp.version}
                                {bp.isPublished ? ' (published)' : ' (draft)'}
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
}

const DataSourceList: FC<DataSourceListProps> = ({ workspace, onRefresh }) => {
    const [adding, setAdding] = useState(false)
    const [newRow, setNewRow] = useState<DataSourceFormRow>({ ...EMPTY_DS_ROW })
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [blueprints, setBlueprints] = useState<BlueprintResponse[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const activeDataSourceId = useWorkspacesStore((s) => s.activeDataSourceId)
    const setActiveDataSource = useWorkspacesStore((s) => s.setActiveDataSource)

    useEffect(() => {
        if (adding) {
            providerService.list().then(setProviders).catch(() => { })
            blueprintService.list().then(setBlueprints).catch(() => { })
        }
    }, [adding])

    const handleFetchGraphs = async (providerId: string) => {
        const result = await providerService.listGraphs(providerId)
        return result.graphs ?? []
    }

    const handleAdd = async () => {
        if (!newRow.providerId || !newRow.graphName) return
        setLoading(true)
        setError(null)
        try {
            const req: DataSourceCreateRequest = {
                providerId: newRow.providerId,
                graphName: newRow.graphName,
                blueprintId: newRow.blueprintId || undefined,
                label: newRow.label || undefined,
            }
            await workspaceService.addDataSource(workspace.id, req)
            setAdding(false)
            setNewRow({ ...EMPTY_DS_ROW })
            onRefresh()
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to add data source')
        } finally {
            setLoading(false)
        }
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
        <div className="flex flex-col gap-3 mt-4 pt-4 border-t border-glass-border">
            <span className="text-[11px] font-bold text-ink-muted uppercase tracking-wider flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5" /> Data Sources
            </span>
            {dataSources.length === 0 ? (
                <div className="text-xs text-ink-muted italic p-3 bg-black/5 dark:bg-white/5 rounded-lg border border-dashed border-glass-border text-center">
                    No data sources attached to this workspace.
                </div>
            ) : (
                <ul className="flex flex-col gap-2 pl-2 border-l-2 border-glass-border/50 ml-1.5">
                    {dataSources.map((ds) => (
                        <li
                            key={ds.id}
                            className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs transition-all ${ds.id === activeDataSourceId
                                ? 'border-accent-business bg-accent-business/5 shadow-sm'
                                : 'border-glass-border bg-canvas hover:bg-black/5 dark:hover:bg-white/5'
                                }`}
                        >
                            <div className="flex items-start justify-between">
                                <div className="flex flex-col gap-1 min-w-0">
                                    <div className="flex items-center gap-2">
                                        <span className="font-semibold text-ink truncate text-sm">{ds.label || ds.graphName}</span>
                                        {ds.isPrimary && (
                                            <span className="shrink-0 flex items-center gap-1 text-[10px] bg-accent-business/10 text-accent-business border border-accent-business/20 px-1.5 py-0.5 rounded-full font-medium">
                                                <CheckCircle className="w-3 h-3" /> Primary
                                            </span>
                                        )}
                                    </div>
                                    <span className="text-[11px] text-ink-muted flex items-center gap-1.5">
                                        <Server className="w-3 h-3" /> {ds.providerId}
                                        {ds.label && <span className="opacity-50">· {ds.graphName}</span>}
                                    </span>
                                </div>
                                <div className="flex items-center gap-2 shrink-0 ml-4">
                                    {ds.id !== activeDataSourceId && (
                                        <button
                                            onClick={() => setActiveDataSource(ds.id)}
                                            className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                        >
                                            Equip
                                        </button>
                                    )}
                                    {!ds.isPrimary && (
                                        <button
                                            onClick={() => handleSetPrimary(ds.id)}
                                            disabled={loading}
                                            className="px-2.5 py-1 text-[10px] font-medium rounded-md bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                        >
                                            Set Primary
                                        </button>
                                    )}
                                    {dataSources.length > 1 && (
                                        <button
                                            onClick={() => handleRemove(ds.id)}
                                            disabled={loading}
                                            className="p-1 text-red-500 hover:bg-red-500/10 rounded-md transition-colors disabled:opacity-50"
                                            title="Remove Data Source"
                                        >
                                            <Trash2 className="w-3.5 h-3.5" />
                                        </button>
                                    )}
                                </div>
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {error && <p className="text-xs text-red-500 bg-red-500/10 p-2 rounded-lg border border-red-500/20">{error}</p>}

            {!adding ? (
                <button
                    onClick={() => setAdding(true)}
                    className="self-start mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors border border-transparent hover:border-glass-border"
                >
                    <Plus className="w-3.5 h-3.5" /> Add Data Source
                </button>
            ) : (
                <div className="flex flex-col gap-3 p-3 mt-2 rounded-xl bg-canvas-elevated border border-glass-border shadow-md animate-in slide-in-from-top-2 fade-in duration-200">
                    <span className="text-[11px] font-bold text-ink-muted uppercase tracking-wider mb-1">New Data Source</span>
                    <DSRowEditor
                        row={newRow}
                        index={0}
                        providers={providers}
                        blueprints={blueprints}
                        canRemove={false}
                        onChange={(_, row) => setNewRow(row)}
                        onRemove={() => { }}
                        onFetchGraphs={handleFetchGraphs}
                    />
                    <div className="flex gap-2 justify-end mt-1">
                        <button
                            onClick={() => { setAdding(false); setNewRow({ ...EMPTY_DS_ROW }) }}
                            className="rounded-lg px-4 py-2 text-xs font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={handleAdd}
                            disabled={!newRow.providerId || !newRow.graphName || loading}
                            className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-4 py-2 text-xs font-semibold text-white disabled:opacity-50 disabled:grayscale hover:shadow-lg transition-all"
                        >
                            {loading ? 'Attaching...' : 'Attach Source'}
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}

// ============================================================
// Main component
// ============================================================

interface WorkspacePanelProps {
    onClose?: () => void
}

export const WorkspacePanel: FC<WorkspacePanelProps> = ({ onClose }) => {
    const workspaces = useWorkspacesStore((s) => s.workspaces)
    const activeWorkspaceId = useWorkspacesStore((s) => s.activeWorkspaceId)
    const setActiveWorkspace = useWorkspacesStore((s) => s.setActiveWorkspace)
    const addWorkspace = useWorkspacesStore((s) => s.addWorkspace)
    const removeWorkspace = useWorkspacesStore((s) => s.removeWorkspace)
    const loadWorkspaces = useWorkspacesStore((s) => s.loadWorkspaces)
    const isLoading = useWorkspacesStore((s) => s.isLoading)

    const [showForm, setShowForm] = useState(false)
    const [expandedWs, setExpandedWs] = useState<string | null>(null)
    const [form, setForm] = useState<FormState>({ ...DEFAULT_FORM })
    const [actionLoading, setActionLoading] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    // Available providers and blueprints for the create form
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [blueprints, setBlueprints] = useState<BlueprintResponse[]>([])

    // Load providers and blueprints when form opens
    useEffect(() => {
        if (showForm) {
            providerService.list().then(setProviders).catch(() => { })
            blueprintService.list().then(setBlueprints).catch(() => { })
        }
    }, [showForm])

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

    const handleCreate = useCallback(async () => {
        setActionLoading(true)
        setActionError(null)
        try {
            const req: WorkspaceCreateRequest = {
                name: form.name,
                description: form.description || undefined,
                dataSources: form.dataSources
                    .filter((ds) => ds.providerId && ds.graphName)
                    .map((ds) => ({
                        providerId: ds.providerId,
                        graphName: ds.graphName,
                        blueprintId: ds.blueprintId || undefined,
                        label: ds.label || undefined,
                    })),
            }
            const ws = await workspaceService.create(req)
            addWorkspace(ws)
            setShowForm(false)
            setForm({ ...DEFAULT_FORM })
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Failed to create workspace')
        } finally {
            setActionLoading(false)
        }
    }, [form, addWorkspace])

    const handleDelete = useCallback(async (id: string) => {
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

    const handleSetDefault = useCallback(async (id: string) => {
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

    const canCreate = form.name.trim() &&
        form.dataSources.some((ds) => ds.providerId && ds.graphName)

    // ── Render ────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full bg-canvas text-ink relative">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-glass-border bg-canvas-elevated sticky top-0 z-10">
                <div>
                    <h2 className="text-lg font-bold flex items-center gap-2">
                        <Database className="w-5 h-5 text-accent-business" />
                        Workspace Management
                    </h2>
                    <p className="text-xs text-ink-muted mt-1">Configure environments, data sources, and active ontologies.</p>
                </div>
                {onClose && (
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 text-ink-secondary transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                )}
            </div>

            <div className="flex flex-col gap-5 p-5 overflow-y-auto">
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
                            onClick={() => setShowForm(true)}
                            className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg transition-all"
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
                                    onClick={() => setShowForm(true)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                >
                                    <Plus className="w-3.5 h-3.5" /> New Workspace
                                </button>
                            )}
                        </div>
                        <ul className="flex flex-col gap-3">
                            {workspaces.map((ws) => {
                                const dsCount = ws.dataSources?.length ?? 0
                                const isExpanded = expandedWs === ws.id

                                return (
                                    <li
                                        key={ws.id}
                                        className={`flex flex-col rounded-xl border p-4 transition-all duration-200 ${ws.id === activeWorkspaceId
                                            ? 'border-accent-business/50 bg-accent-business/5 shadow-md shadow-accent-business/5'
                                            : 'border-glass-border bg-canvas-elevated hover:shadow-md'
                                            }`}
                                    >
                                        <div className="flex items-start justify-between">
                                            <div className="flex gap-3">
                                                <div className={`mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-inner border ${ws.id === activeWorkspaceId ? 'bg-accent-business/20 border-accent-business/30 text-accent-business' : 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-secondary'}`}>
                                                    <Database className="w-5 h-5" />
                                                </div>
                                                <div className="flex flex-col gap-1.5 min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-bold text-base text-ink">{ws.name}</span>
                                                        {statusBadge(ws)}
                                                    </div>
                                                    <p className="text-sm text-ink-secondary max-w-md line-clamp-2 leading-snug">
                                                        {ws.description || <span className="italic opacity-50">No description provided</span>}
                                                    </p>
                                                    <div className="flex items-center gap-3 mt-1 text-xs text-ink-muted">
                                                        <span className="flex items-center gap-1"><Layers className="w-3.5 h-3.5" /> {dsCount} Sources</span>
                                                        {ws.graphName && <span className="flex items-center gap-1"><Server className="w-3.5 h-3.5" /> {ws.graphName}</span>}
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="flex items-center gap-2 shrink-0 ml-4">
                                                {dsCount > 0 && (
                                                    <button
                                                        onClick={() => setExpandedWs(isExpanded ? null : ws.id)}
                                                        className="px-3 py-1.5 text-xs font-medium rounded-lg bg-canvas border border-glass-border text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                                    >
                                                        {isExpanded ? 'Hide Sources' : 'Manage Sources'}
                                                    </button>
                                                )}
                                                {ws.id !== activeWorkspaceId && (
                                                    <button
                                                        onClick={() => setActiveWorkspace(ws.id)}
                                                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                                    >
                                                        Enter Workspace
                                                    </button>
                                                )}
                                                <div className="w-px h-6 bg-glass-border mx-1" />
                                                {!ws.isDefault && (
                                                    <button
                                                        onClick={() => handleSetDefault(ws.id)}
                                                        disabled={actionLoading}
                                                        className="p-1.5 text-ink-muted hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                                        title="Set as Default"
                                                    >
                                                        <Shield className="w-4 h-4" />
                                                    </button>
                                                )}
                                                <button
                                                    onClick={() => handleDelete(ws.id)}
                                                    disabled={actionLoading}
                                                    className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                                                    title="Delete Workspace"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </div>

                                        {/* Expanded data sources */}
                                        {isExpanded && (
                                            <div className="animate-in slide-in-from-top-2 fade-in duration-200">
                                                <DataSourceList workspace={ws} onRefresh={loadWorkspaces} />
                                            </div>
                                        )}
                                    </li>
                                )
                            })}
                        </ul>
                    </div>
                )}

                {/* Action error general */}
                {actionError && (
                    <div className="p-3 mt-2 rounded-xl bg-red-500/10 border border-red-500/20 flex items-start gap-2 text-red-500 text-sm">
                        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                        <p>{actionError}</p>
                    </div>
                )}

                {/* New OR Create workspace form inline */}
                {showForm && (
                    <div className="mt-4 p-6 rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl animate-in slide-in-from-bottom-4 fade-in duration-300 relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent-business to-accent-lineage" />

                        <div className="flex items-center justify-between mb-5">
                            <div>
                                <h3 className="text-lg font-bold text-ink">New Workspace</h3>
                                <p className="text-xs text-ink-muted">Define the base properties for the new logical environment.</p>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-5 mb-6">
                            {/* Name */}
                            <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                WORKSPACE NAME *
                                <input
                                    type="text"
                                    value={form.name}
                                    onChange={(e) => {
                                        setForm((prev) => ({ ...prev, name: e.target.value }))
                                        clearError()
                                    }}
                                    placeholder="e.g. Production Analytics"
                                    className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                />
                            </label>

                            {/* Description */}
                            <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                DESCRIPTION
                                <input
                                    type="text"
                                    value={form.description}
                                    onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                                    placeholder="What is this environment used for?"
                                    className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                />
                            </label>
                        </div>

                        {/* Data sources */}
                        <div className="flex flex-col gap-3">
                            <div className="flex items-center justify-between">
                                <span className="text-xs font-bold text-ink-muted uppercase tracking-wider flex items-center gap-1.5"><Server className="w-4 h-4" /> Attached Data Sources *</span>
                                <button
                                    type="button"
                                    onClick={addDsRow}
                                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-all"
                                >
                                    <Plus className="w-3 h-3" /> Add Row
                                </button>
                            </div>

                            <div className="flex flex-col gap-3">
                                {form.dataSources.map((ds, i) => (
                                    <DSRowEditor
                                        key={i}
                                        row={ds}
                                        index={i}
                                        providers={providers}
                                        blueprints={blueprints}
                                        canRemove={form.dataSources.length > 1}
                                        onChange={updateDsRow}
                                        onRemove={removeDsRow}
                                        onFetchGraphs={handleFetchGraphs}
                                    />
                                ))}
                            </div>
                        </div>

                        {/* Form actions */}
                        <div className="flex items-center justify-end gap-3 mt-8 pt-4 border-t border-glass-border">
                            <button
                                onClick={() => {
                                    setShowForm(false)
                                    setForm({ ...DEFAULT_FORM })
                                    clearError()
                                }}
                                className="rounded-lg px-5 py-2.5 text-sm font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreate}
                                disabled={!canCreate || actionLoading}
                                className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-6 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg disabled:opacity-50 disabled:grayscale transition-all flex items-center gap-2"
                            >
                                {actionLoading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                                {actionLoading ? 'Provisioning...' : 'Provision Workspace'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
