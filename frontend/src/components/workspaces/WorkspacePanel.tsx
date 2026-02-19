/**
 * WorkspacePanel — settings panel for full CRUD management of workspaces.
 *
 * Features:
 * - List all registered workspaces with status badges
 * - Create new workspaces (select provider, graph name, blueprint)
 * - Set default workspace
 * - Delete workspaces
 */
import { useState, useCallback, useEffect, type FC } from 'react'
import { useWorkspacesStore } from '@/store/workspaces'
import { workspaceService, type WorkspaceCreateRequest, type WorkspaceResponse } from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { blueprintService, type BlueprintResponse } from '@/services/blueprintService'

// ============================================================
// Form state
// ============================================================

interface FormState {
    name: string
    providerId: string
    graphName: string
    blueprintId: string
    description: string
}

const DEFAULT_FORM: FormState = {
    name: '',
    providerId: '',
    graphName: '',
    blueprintId: '',
    description: '',
}

// ============================================================
// Helpers
// ============================================================

function statusBadge(ws: WorkspaceResponse) {
    if (!ws.isActive) return <span className="text-xs text-red-500">Inactive</span>
    if (ws.isDefault) return <span className="text-xs text-emerald-500 font-medium">Default</span>
    return <span className="text-xs text-muted-foreground">Active</span>
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
    const [form, setForm] = useState<FormState>(DEFAULT_FORM)
    const [actionLoading, setActionLoading] = useState(false)
    const [actionError, setActionError] = useState<string | null>(null)

    // Available providers and blueprints for the form
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [blueprints, setBlueprints] = useState<BlueprintResponse[]>([])
    const [availableGraphs, setAvailableGraphs] = useState<string[]>([])
    const [graphsLoading, setGraphsLoading] = useState(false)

    // Load providers and blueprints when form opens
    useEffect(() => {
        if (showForm) {
            providerService.list().then(setProviders).catch(() => {})
            blueprintService.list().then(setBlueprints).catch(() => {})
        }
    }, [showForm])

    const clearError = useCallback(() => setActionError(null), [])

    const updateField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
        setForm((prev) => ({ ...prev, [key]: value }))
        clearError()
    }, [clearError])

    const handleFetchGraphs = useCallback(async () => {
        if (!form.providerId) return
        setGraphsLoading(true)
        try {
            const result = await providerService.listGraphs(form.providerId)
            setAvailableGraphs(result.graphs ?? [])
        } catch {
            // Ignore — user can still type graph name manually
        } finally {
            setGraphsLoading(false)
        }
    }, [form.providerId])

    const handleCreate = useCallback(async () => {
        setActionLoading(true)
        setActionError(null)
        try {
            const req: WorkspaceCreateRequest = {
                name: form.name,
                providerId: form.providerId,
                graphName: form.graphName,
                blueprintId: form.blueprintId || undefined,
                description: form.description || undefined,
            }
            const ws = await workspaceService.create(req)
            addWorkspace(ws)
            setShowForm(false)
            setForm(DEFAULT_FORM)
            setAvailableGraphs([])
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
        } catch (err) {
            setActionError(err instanceof Error ? err.message : 'Failed to delete workspace')
        } finally {
            setActionLoading(false)
        }
    }, [removeWorkspace])

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
                    {workspaces.map((ws) => (
                        <li
                            key={ws.id}
                            className={`flex items-center justify-between rounded-md border p-3 ${
                                ws.id === activeWorkspaceId ? 'border-primary bg-primary/5' : 'border-border'
                            }`}
                        >
                            <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm">{ws.name}</span>
                                    {statusBadge(ws)}
                                </div>
                                <span className="text-xs text-muted-foreground">
                                    {ws.graphName ? `Graph: ${ws.graphName}` : 'No graph'}
                                    {ws.description ? ` — ${ws.description}` : ''}
                                </span>
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
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
                        </li>
                    ))}
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
                            onChange={(e) => updateField('name', e.target.value)}
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
                            onChange={(e) => updateField('description', e.target.value)}
                            placeholder="Optional description"
                            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </label>

                    {/* Provider */}
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Provider *
                        <select
                            value={form.providerId}
                            onChange={(e) => {
                                updateField('providerId', e.target.value)
                                setAvailableGraphs([])
                            }}
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
                                    value={form.graphName}
                                    onChange={(e) => updateField('graphName', e.target.value)}
                                    className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                >
                                    {availableGraphs.map((g) => (
                                        <option key={g} value={g}>{g}</option>
                                    ))}
                                </select>
                            ) : (
                                <input
                                    type="text"
                                    value={form.graphName}
                                    onChange={(e) => updateField('graphName', e.target.value)}
                                    placeholder="nexus_lineage"
                                    className="flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            )}
                            {form.providerId && (
                                <button
                                    type="button"
                                    onClick={handleFetchGraphs}
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
                            value={form.blueprintId}
                            onChange={(e) => updateField('blueprintId', e.target.value)}
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

                    {/* Form actions */}
                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={handleCreate}
                            disabled={!form.name || !form.providerId || !form.graphName || actionLoading}
                            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors"
                        >
                            {actionLoading ? 'Creating...' : 'Create Workspace'}
                        </button>
                        <button
                            onClick={() => {
                                setShowForm(false)
                                setForm(DEFAULT_FORM)
                                setAvailableGraphs([])
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
