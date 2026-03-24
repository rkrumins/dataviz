import { useState, useCallback, type FC } from 'react'
import { fetchWithTimeout } from '@/services/fetchWithTimeout'
import { Network, Plus, Trash2, CheckCircle, AlertCircle, Activity, Shield, Database, Edit2 } from 'lucide-react'
import { useConnections } from '@/hooks/useConnections'
import { type ConnectionCreateRequest, type ConnectionUpdateRequest } from '@/services/connectionService'
import { ProviderType } from '@/services/providerService'

const PROVIDER_LABELS: Record<ProviderType, string> = {
    falkordb: 'FalkorDB',
    neo4j: 'Neo4j',
    datahub: 'DataHub',
    mock: 'Mock (testing)',
}

interface FormState {
    name: string
    providerType: ProviderType
    host: string
    port: string
    graphName: string
    username: string
    password: string
    token: string
    tlsEnabled: boolean
}

const DEFAULT_FORM: FormState = {
    name: '',
    providerType: 'falkordb',
    host: 'localhost',
    port: '6379',
    graphName: 'nexus_lineage',
    username: '',
    password: '',
    token: '',
    tlsEnabled: false,
}

const DEFAULT_PORTS: Record<ProviderType, string> = {
    falkordb: '6379',
    neo4j: '7687',
    datahub: '',
    mock: '',
}

function statusBadge(conn: { isActive: boolean; isPrimary: boolean }) {
    if (!conn.isActive) return <span className="flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-500"><AlertCircle className="w-3 h-3" /> Inactive</span>
    if (conn.isPrimary) return <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-500"><CheckCircle className="w-3 h-3" /> Primary</span>
    return <span className="flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-500">Active</span>
}

export const ConnectionsTab: FC = () => {
    const {
        connections,
        activeConnectionId,
        isLoading,
        actionLoading,
        actionError,
        clearError,
        setActiveConnection,
        createConnection,
        updateConnection,
        deleteConnection,
        testConnection,
        setPrimary,
    } = useConnections()

    const [showForm, setShowForm] = useState(false)
    const [editingId, setEditingId] = useState<string | null>(null)
    const [form, setForm] = useState<FormState>(DEFAULT_FORM)
    const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({})
    const [availableGraphs, setAvailableGraphs] = useState<string[]>([])
    const [graphsLoading, setGraphsLoading] = useState(false)

    const updateField = useCallback(<K extends keyof FormState>(key: K, value: FormState[K]) => {
        setForm((prev) => {
            const next = { ...prev, [key]: value }
            if (key === 'providerType') {
                next.port = DEFAULT_PORTS[value as ProviderType]
                next.host = value === 'datahub' ? 'http://localhost:9002' : 'localhost'
            }
            return next
        })
        clearError()
    }, [clearError])

    const handleFetchGraphs = useCallback(async () => {
        if (!form.host || !form.port) return
        setGraphsLoading(true)
        try {
            const res = await fetchWithTimeout('/graph/v1/providers/falkordb/graphs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    host: form.host,
                    port: parseInt(form.port, 10),
                    graph_name: form.graphName || 'nexus_lineage',
                }),
            })
            if (res.ok) {
                const data = await res.json()
                setAvailableGraphs(data.graphs ?? [])
            }
        } catch {
            // Ignore — user can still type graph name manually
        } finally {
            setGraphsLoading(false)
        }
    }, [form.host, form.port, form.graphName])

    const handleSave = useCallback(async () => {
        const payload = {
            name: form.name,
            providerType: form.providerType,
            host: form.host || undefined,
            port: form.port ? parseInt(form.port, 10) : undefined,
            graphName: form.graphName || undefined,
            tlsEnabled: form.tlsEnabled,
            credentials: (form.username || form.password || form.token)
                ? {
                    username: form.username || undefined,
                    password: form.password || undefined,
                    token: form.token || undefined,
                }
                : undefined,
        }

        try {
            if (editingId) {
                await updateConnection(editingId, payload as ConnectionUpdateRequest)
            } else {
                await createConnection(payload as ConnectionCreateRequest)
            }
            setShowForm(false)
            setEditingId(null)
            setForm(DEFAULT_FORM)
            setAvailableGraphs([])
        } catch {
            // Error shown via actionError
        }
    }, [form, editingId, createConnection, updateConnection])

    const handleTest = useCallback(async (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation()
        try {
            const result = await testConnection(id)
            setTestResults((prev) => ({
                ...prev,
                [id]: { ok: true, msg: `Healthy — ${result.latencyMs}ms` },
            }))
        } catch (err) {
            setTestResults((prev) => ({
                ...prev,
                [id]: {
                    ok: false,
                    msg: err instanceof Error ? err.message : 'Test failed',
                },
            }))
        }
    }, [testConnection])

    const handleDelete = useCallback(async (id: string, e?: React.MouseEvent) => {
        e?.stopPropagation()
        if (!confirm('Delete this connection? This cannot be undone.')) return
        await deleteConnection(id)
        if (activeConnectionId === id) {
            const next = connections.find((c) => c.id !== id)
            setActiveConnection(next?.id ?? null)
        }
    }, [deleteConnection, activeConnectionId, connections, setActiveConnection])

    const startEditing = useCallback((conn: any, e?: React.MouseEvent) => {
        e?.stopPropagation()
        setEditingId(conn.id)
        setForm({
            name: conn.name,
            providerType: conn.providerType,
            host: conn.host || '',
            port: conn.port ? String(conn.port) : '',
            graphName: conn.graphName || '',
            username: '',
            password: '',
            token: '',
            tlsEnabled: conn.tlsEnabled || false,
        })
        setShowForm(true)
        clearError()
    }, [clearError])

    return (
        <div className="flex flex-col gap-5 p-5 pb-10 overflow-y-auto h-full">
            {/* Connection list */}
            {isLoading ? (
                <div className="flex flex-col items-center justify-center py-12 gap-3 opacity-60">
                    <div className="w-6 h-6 border-2 border-accent-business border-t-transparent rounded-full animate-spin" />
                    <span className="text-sm font-medium">Loading connections...</span>
                </div>
            ) : connections.length === 0 ? (
                <div className="flex flex-col items-center justify-center p-10 mt-4 rounded-2xl border border-dashed border-glass-border bg-black/5 dark:bg-white/5 text-center">
                    <div className="w-12 h-12 rounded-full bg-accent-business/10 flex items-center justify-center mb-4">
                        <Network className="w-6 h-6 text-accent-business" />
                    </div>
                    <h3 className="text-base font-semibold mb-1">No Connections Found</h3>
                    <p className="text-sm text-ink-muted max-w-sm mb-5">
                        Connect standard databases like FalkorDB, Neo4j, or DataHub to fetch remote lineages directly.
                    </p>
                    <button
                        onClick={() => { setEditingId(null); setForm(DEFAULT_FORM); setShowForm(true); }}
                        className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg transition-all"
                    >
                        Add Connection
                    </button>
                </div>
            ) : (
                <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-ink-muted uppercase tracking-wider">Registered DBMS Connectors</span>
                        {!showForm && (
                            <button
                                onClick={() => { setEditingId(null); setForm(DEFAULT_FORM); setShowForm(true); setAvailableGraphs([]) }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors focus:outline-none focus:ring-2 focus:ring-accent-business"
                            >
                                <Plus className="w-3.5 h-3.5" /> New Connection
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

                    {/* Form inline (AT THE TOP) */}
                    {showForm && (
                        <div className="p-6 rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl animate-in slide-in-from-top-4 fade-in duration-300 relative overflow-hidden mb-4">
                            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent-business to-accent-lineage" />

                            <div className="flex items-center justify-between mb-5">
                                <div>
                                    <h3 className="text-lg font-bold text-ink">{editingId ? 'Edit Connection' : 'New Connection'}</h3>
                                    <p className="text-xs text-ink-muted">Enter networking details to securely access your graph data.</p>
                                </div>
                                <Activity className="w-6 h-6 text-accent-business/30" />
                            </div>

                            <div className="space-y-5">
                                <div className="grid grid-cols-2 gap-5">
                                    {/* Name */}
                                    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                        CONNECTION ALIAS *
                                        <input
                                            type="text"
                                            value={form.name}
                                            onChange={(e) => updateField('name', e.target.value)}
                                            placeholder="e.g. Neo4j Staging"
                                            className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                            autoFocus
                                        />
                                    </label>

                                    {/* Provider type */}
                                    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                        DBMS PROVIDER *
                                        <select
                                            value={form.providerType}
                                            onChange={(e) => updateField('providerType', e.target.value as ProviderType)}
                                            disabled={!!editingId} // Usually can't change provider type on edit
                                            className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            {(Object.keys(PROVIDER_LABELS) as ProviderType[]).map((p) => (
                                                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                                            ))}
                                        </select>
                                    </label>
                                </div>

                                {/* Host / port */}
                                {form.providerType !== 'mock' && (
                                    <div className="flex gap-5">
                                        <label className="flex flex-1 flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                            {form.providerType === 'datahub' ? 'BASE API URL *' : 'HOST URI *'}
                                            <input
                                                type="text"
                                                value={form.host}
                                                onChange={(e) => updateField('host', e.target.value)}
                                                placeholder={form.providerType === 'datahub' ? 'http://localhost:9002' : 'localhost'}
                                                className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                            />
                                        </label>
                                        {form.providerType !== 'datahub' && (
                                            <label className="flex w-32 flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                                PORT
                                                <input
                                                    type="number"
                                                    value={form.port}
                                                    onChange={(e) => updateField('port', e.target.value)}
                                                    className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                                />
                                            </label>
                                        )}
                                    </div>
                                )}

                                {/* Graph name */}
                                {(form.providerType === 'falkordb' || form.providerType === 'neo4j') && (
                                    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                        {form.providerType === 'neo4j' ? 'DATABASE NAME' : 'DEFAULT GRAPH NAME'}
                                        <div className="flex gap-3">
                                            {form.providerType === 'falkordb' && availableGraphs.length > 0 ? (
                                                <select
                                                    value={form.graphName}
                                                    onChange={(e) => updateField('graphName', e.target.value)}
                                                    className="flex-1 rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
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
                                                    className="flex-1 rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                                />
                                            )}
                                            {form.providerType === 'falkordb' && (
                                                <button
                                                    type="button"
                                                    onClick={handleFetchGraphs}
                                                    disabled={graphsLoading}
                                                    className="rounded-lg border border-glass-border px-5 py-3 text-xs font-medium bg-canvas hover:bg-black/5 dark:hover:bg-white/5 transition-all text-ink-secondary flex items-center justify-center min-w-[100px]"
                                                    title="Fetch available graphs from this instance"
                                                >
                                                    {graphsLoading ? 'Scanning...' : 'Fetch List'}
                                                </button>
                                            )}
                                        </div>
                                    </label>
                                )}

                                {/* Credentials */}
                                {form.providerType === 'datahub' && (
                                    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                        BEARER TOKEN (OPTIONAL)
                                        <input
                                            type="password"
                                            value={form.token}
                                            onChange={(e) => updateField('token', e.target.value)}
                                            placeholder={editingId ? '•••••••• (leave blank to keep current)' : '••••••••••••••••'}
                                            className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                        />
                                    </label>
                                )}
                                {form.providerType === 'neo4j' && (
                                    <div className="grid grid-cols-2 gap-5">
                                        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                            USERNAME
                                            <input
                                                type="text"
                                                value={form.username}
                                                onChange={(e) => updateField('username', e.target.value)}
                                                placeholder="neo4j"
                                                className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                            />
                                        </label>
                                        <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted tracking-wide">
                                            PASSWORD
                                            <input
                                                type="password"
                                                value={form.password}
                                                onChange={(e) => updateField('password', e.target.value)}
                                                placeholder={editingId ? '•••••••• (leave blank to keep current)' : '••••••••'}
                                                className="rounded-lg border border-glass-border bg-canvas px-4 py-3 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                            />
                                        </label>
                                    </div>
                                )}

                                {/* TLS */}
                                {(form.providerType === 'falkordb' || form.providerType === 'neo4j') && (
                                    <label className="flex items-center gap-3 mt-4 text-sm font-medium text-ink-secondary cursor-pointer hover:text-ink transition-colors max-w-fit">
                                        <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${form.tlsEnabled ? 'bg-accent-business border-accent-business text-white' : 'border-glass-border bg-transparent'}`}>
                                            {form.tlsEnabled && <CheckCircle className="w-3.5 h-3.5" />}
                                        </div>
                                        <input
                                            type="checkbox"
                                            className="hidden"
                                            checked={form.tlsEnabled}
                                            onChange={(e) => updateField('tlsEnabled', e.target.checked)}
                                        />
                                        Require TLS / SSL Encryption
                                    </label>
                                )}
                            </div>

                            {/* Form actions */}
                            <div className="flex items-center justify-end gap-3 mt-8 pt-5 border-t border-glass-border">
                                <button
                                    onClick={() => {
                                        setShowForm(false)
                                        setEditingId(null)
                                        setForm(DEFAULT_FORM)
                                        setAvailableGraphs([])
                                        clearError()
                                    }}
                                    className="rounded-lg px-6 py-2.5 text-sm font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors focus:outline-none focus:ring-2 focus:ring-ink"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={!form.name || actionLoading}
                                    className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-6 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg disabled:opacity-50 disabled:grayscale transition-all flex items-center gap-2 focus:outline-none focus:ring-2 focus:ring-accent-business focus:ring-offset-2 focus:ring-offset-canvas"
                                >
                                    {actionLoading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                                    {actionLoading ? 'Saving...' : (editingId ? 'Save Changes' : 'Save Connection')}
                                </button>
                            </div>
                        </div>
                    )}
                    <ul className="grid grid-cols-1 gap-4">
                        {connections.map((conn) => (
                            <li
                                key={conn.id}
                                onClick={() => conn.id !== activeConnectionId && setActiveConnection(conn.id)}
                                className={`flex flex-col rounded-xl border p-4 transition-all duration-200 cursor-pointer group ${conn.id === activeConnectionId
                                    ? 'border-accent-business/50 bg-accent-business/5 shadow-md shadow-accent-business/5'
                                    : 'border-glass-border bg-canvas-elevated hover:shadow-md hover:border-glass-border-strong'
                                    }`}
                            >
                                <div className="flex items-start justify-between">
                                    <div className="flex gap-4 items-center">
                                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 shadow-inner border transition-colors ${conn.id === activeConnectionId ? 'bg-accent-business/20 border-accent-business/30 text-accent-business' : 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-secondary group-hover:text-ink'}`}>
                                            <Database className="w-6 h-6" />
                                        </div>
                                        <div className="flex flex-col gap-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="font-bold text-base text-ink">{conn.name}</span>
                                                {statusBadge(conn)}
                                            </div>
                                            <p className="text-xs text-ink-muted font-mono bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded border border-glass-border/50 max-w-fit mt-0.5">
                                                {PROVIDER_LABELS[conn.providerType] ?? conn.providerType}
                                                {conn.host ? ` · ${conn.host}${conn.port ? `:${conn.port}` : ''}` : ''}
                                                {conn.graphName ? ` · ${conn.graphName}` : ''}
                                            </p>
                                            {testResults[conn.id] && (
                                                <span className={`text-[10px] font-semibold mt-1 flex items-center gap-1 px-2 py-0.5 rounded-full border max-w-fit ${testResults[conn.id].ok ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' : 'bg-red-500/10 text-red-500 border-red-500/20'}`}>
                                                    {testResults[conn.id].ok ? <CheckCircle className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                                                    {testResults[conn.id].msg}
                                                </span>
                                            )}
                                        </div>
                                    </div>

                                    <div className="flex flex-col items-end gap-2 shrink-0 ml-4">
                                        <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                            <button
                                                onClick={(e) => startEditing(conn, e)}
                                                disabled={actionLoading}
                                                className="p-1.5 text-ink-muted hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                                title="Edit Connection"
                                            >
                                                <Edit2 className="w-4 h-4" />
                                            </button>
                                            {!conn.isPrimary && (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setPrimary(conn.id) }}
                                                    disabled={actionLoading}
                                                    className="p-1.5 text-ink-muted hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 title-tooltip"
                                                    title="Set as Default Connection"
                                                >
                                                    <Shield className="w-4 h-4" />
                                                </button>
                                            )}
                                            <button
                                                onClick={(e) => handleDelete(conn.id, e)}
                                                disabled={actionLoading}
                                                className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                                                title="Delete Connection"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                        <div className="flex items-center gap-2 mt-2">
                                            {conn.id !== activeConnectionId && (
                                                <button
                                                    onClick={(e) => { e.stopPropagation(); setActiveConnection(conn.id) }}
                                                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                                >
                                                    Attach
                                                </button>
                                            )}
                                            <button
                                                onClick={(e) => handleTest(conn.id, e)}
                                                disabled={actionLoading}
                                                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                            >
                                                Test PING
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    )
}
