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
import { useWorkspacesStore } from '@/store/workspaces'
import {
    workspaceService,
    type WorkspaceCreateRequest,
    type WorkspaceResponse,
    type DataSourceCreateRequest,
    type DataSourceResponse,
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
    if (!ws.isActive) return <span className="text-xs text-red-500">Inactive</span>
    if (ws.isDefault) return <span className="text-xs text-emerald-500 font-medium">Default</span>
    return <span className="text-xs text-muted-foreground">Active</span>
}

function dataSourceSummary(ds: DataSourceResponse) {
    const parts: string[] = []
    if (ds.label) parts.push(ds.label)
    if (ds.graphName) parts.push(ds.graphName)
    parts.push(ds.providerId)
    return parts.join(' · ')
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
        <div className="flex flex-col gap-2 rounded border border-border/50 p-3 bg-muted/30">
            <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">
                    Data Source {index + 1}
                </span>
                {canRemove && (
                    <button
                        type="button"
                        onClick={() => onRemove(index)}
                        className="text-xs text-red-500 hover:text-red-700"
                    >
                        Remove
                    </button>
                )}
            </div>

            {/* Label */}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Label
                <input
                    type="text"
                    value={row.label}
                    onChange={(e) => update('label', e.target.value)}
                    placeholder="e.g. Production Lineage"
                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />
            </label>

            {/* Provider */}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Provider *
                <select
                    value={row.providerId}
                    onChange={(e) => update('providerId', e.target.value)}
                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Graph Name *
                <div className="flex gap-2">
                    {availableGraphs.length > 0 ? (
                        <select
                            value={row.graphName}
                            onChange={(e) => update('graphName', e.target.value)}
                            className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
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
                            className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    )}
                    {row.providerId && (
                        <button
                            type="button"
                            onClick={handleBrowse}
                            disabled={graphsLoading}
                            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                            title="Fetch available graphs from this provider"
                        >
                            {graphsLoading ? '...' : 'Browse'}
                        </button>
                    )}
                </div>
            </label>

            {/* Blueprint */}
            <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                Ontology Blueprint
                <select
                    value={row.blueprintId}
                    onChange={(e) => update('blueprintId', e.target.value)}
                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                >
                    <option value="">None (use graph introspection)</option>
                    {blueprints.map((bp) => (
                        <option key={bp.id} value={bp.id}>
                            {bp.name} v{bp.version}
                            {bp.isPublished ? ' (published)' : ' (draft)'}
                        </option>
                    ))}
                </select>
            </label>
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
            providerService.list().then(setProviders).catch(() => {})
            blueprintService.list().then(setBlueprints).catch(() => {})
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
        <div className="flex flex-col gap-2 mt-2">
            <span className="text-xs font-medium text-muted-foreground">Data Sources</span>
            {dataSources.length === 0 ? (
                <span className="text-xs text-muted-foreground italic">No data sources</span>
            ) : (
                <ul className="flex flex-col gap-1">
                    {dataSources.map((ds) => (
                        <li
                            key={ds.id}
                            className={`flex items-center justify-between rounded border px-2 py-1.5 text-xs ${
                                ds.id === activeDataSourceId
                                    ? 'border-primary/50 bg-primary/5'
                                    : 'border-border/50'
                            }`}
                        >
                            <div className="flex items-center gap-2 min-w-0">
                                <span className="truncate">{dataSourceSummary(ds)}</span>
                                {ds.isPrimary && (
                                    <span className="shrink-0 text-[10px] text-emerald-500 font-medium">
                                        Primary
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0 ml-2">
                                {ds.id !== activeDataSourceId && (
                                    <button
                                        onClick={() => setActiveDataSource(ds.id)}
                                        className="text-[10px] text-primary hover:underline"
                                    >
                                        Use
                                    </button>
                                )}
                                {!ds.isPrimary && (
                                    <button
                                        onClick={() => handleSetPrimary(ds.id)}
                                        disabled={loading}
                                        className="text-[10px] text-muted-foreground hover:text-foreground"
                                    >
                                        Set Primary
                                    </button>
                                )}
                                {dataSources.length > 1 && (
                                    <button
                                        onClick={() => handleRemove(ds.id)}
                                        disabled={loading}
                                        className="text-[10px] text-red-500 hover:text-red-700"
                                    >
                                        Remove
                                    </button>
                                )}
                            </div>
                        </li>
                    ))}
                </ul>
            )}

            {error && <p className="text-xs text-red-500">{error}</p>}

            {!adding ? (
                <button
                    onClick={() => setAdding(true)}
                    className="self-start text-xs text-muted-foreground hover:text-primary"
                >
                    + Add data source
                </button>
            ) : (
                <div className="flex flex-col gap-2">
                    <DSRowEditor
                        row={newRow}
                        index={0}
                        providers={providers}
                        blueprints={blueprints}
                        canRemove={false}
                        onChange={(_, row) => setNewRow(row)}
                        onRemove={() => {}}
                        onFetchGraphs={handleFetchGraphs}
                    />
                    <div className="flex gap-2">
                        <button
                            onClick={handleAdd}
                            disabled={!newRow.providerId || !newRow.graphName || loading}
                            className="rounded bg-primary px-2 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50 hover:bg-primary/90"
                        >
                            {loading ? 'Adding...' : 'Add'}
                        </button>
                        <button
                            onClick={() => { setAdding(false); setNewRow({ ...EMPTY_DS_ROW }) }}
                            className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                        >
                            Cancel
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
            providerService.list().then(setProviders).catch(() => {})
            blueprintService.list().then(setBlueprints).catch(() => {})
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
        <div className="flex flex-col gap-4 p-4 min-w-[480px]">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Workspaces</h2>
                {onClose && (
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                        ✕
                    </button>
                )}
            </div>

            {/* Workspace list */}
            {isLoading ? (
                <p className="text-sm text-muted-foreground animate-pulse">Loading...</p>
            ) : workspaces.length === 0 ? (
                <p className="text-sm text-muted-foreground">No workspaces registered yet.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {workspaces.map((ws) => {
                        const dsCount = ws.dataSources?.length ?? 0
                        const isExpanded = expandedWs === ws.id

                        return (
                            <li
                                key={ws.id}
                                className={`flex flex-col rounded-md border p-3 ${
                                    ws.id === activeWorkspaceId ? 'border-primary bg-primary/5' : 'border-border'
                                }`}
                            >
                                <div className="flex items-center justify-between">
                                    <div className="flex flex-col gap-0.5 min-w-0">
                                        <div className="flex items-center gap-2">
                                            <span className="font-medium text-sm">{ws.name}</span>
                                            {statusBadge(ws)}
                                            <span className="text-[10px] text-muted-foreground">
                                                {dsCount} source{dsCount !== 1 ? 's' : ''}
                                            </span>
                                        </div>
                                        <span className="text-xs text-muted-foreground truncate">
                                            {ws.graphName ? `Graph: ${ws.graphName}` : 'No primary graph'}
                                            {ws.description ? ` — ${ws.description}` : ''}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                        {dsCount > 0 && (
                                            <button
                                                onClick={() => setExpandedWs(isExpanded ? null : ws.id)}
                                                className="text-xs text-muted-foreground hover:text-foreground"
                                            >
                                                {isExpanded ? 'Collapse' : 'Sources'}
                                            </button>
                                        )}
                                        {ws.id !== activeWorkspaceId && (
                                            <button
                                                onClick={() => setActiveWorkspace(ws.id)}
                                                className="text-xs text-primary hover:underline"
                                            >
                                                Use
                                            </button>
                                        )}
                                        {!ws.isDefault && (
                                            <button
                                                onClick={() => handleSetDefault(ws.id)}
                                                disabled={actionLoading}
                                                className="text-xs text-muted-foreground hover:text-foreground"
                                            >
                                                Set Default
                                            </button>
                                        )}
                                        <button
                                            onClick={() => handleDelete(ws.id)}
                                            disabled={actionLoading}
                                            className="text-xs text-red-500 hover:text-red-700"
                                        >
                                            Delete
                                        </button>
                                    </div>
                                </div>

                                {/* Expanded data sources */}
                                {isExpanded && (
                                    <DataSourceList workspace={ws} onRefresh={loadWorkspaces} />
                                )}
                            </li>
                        )
                    })}
                </ul>
            )}

            {/* Action error */}
            {actionError && (
                <p className="text-sm text-red-500">{actionError}</p>
            )}

            {/* New workspace form toggle */}
            {!showForm ? (
                <button
                    onClick={() => setShowForm(true)}
                    className="self-start rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                    + Add workspace
                </button>
            ) : (
                <div className="flex flex-col gap-3 rounded-md border border-border p-4">
                    <h3 className="font-medium text-sm">New Workspace</h3>

                    {/* Name */}
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Name *
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => {
                                setForm((prev) => ({ ...prev, name: e.target.value }))
                                clearError()
                            }}
                            placeholder="Production Lineage"
                            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </label>

                    {/* Description */}
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Description
                        <input
                            type="text"
                            value={form.description}
                            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
                            placeholder="Optional description"
                            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </label>

                    {/* Data sources */}
                    <div className="flex flex-col gap-2">
                        <span className="text-xs font-medium text-muted-foreground">Data Sources *</span>
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
                        <button
                            type="button"
                            onClick={addDsRow}
                            className="self-start text-xs text-muted-foreground hover:text-primary"
                        >
                            + Add another source
                        </button>
                    </div>

                    {/* Form actions */}
                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={handleCreate}
                            disabled={!canCreate || actionLoading}
                            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors"
                        >
                            {actionLoading ? 'Creating...' : 'Create Workspace'}
                        </button>
                        <button
                            onClick={() => {
                                setShowForm(false)
                                setForm({ ...DEFAULT_FORM })
                                clearError()
                            }}
                            className="rounded-md border border-border px-3 py-1.5 text-sm hover:bg-muted transition-colors"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
