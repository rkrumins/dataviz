/**
 * ConnectionsPanel — settings panel for full CRUD management of graph connections.
 *
 * Features:
 * - List all registered connections with status badges
 * - Create new connections (with per-provider field sets)
 * - Test connectivity before saving
 * - Set primary connection
 * - Delete connections
 * - FalkorDB graph picker: fetches GRAPH.LIST after entering host/port
 */
import { useState, useCallback, type FC } from 'react'
import { Network, Plus, Trash2, CheckCircle, AlertCircle, X, Activity, Shield, Database } from 'lucide-react'
import { useConnections } from '@/hooks/useConnections'
import { type ConnectionCreateRequest } from '@/services/connectionService'

type ProviderType = 'falkordb' | 'neo4j' | 'datahub' | 'mock'

const PROVIDER_LABELS: Record<ProviderType, string> = {
    falkordb: 'FalkorDB',
    neo4j: 'Neo4j',
    datahub: 'DataHub',
    mock: 'Mock (testing)',
}

// ============================================================
// Connection form state
// ============================================================

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

// ============================================================
// Helpers
// ============================================================

function statusBadge(conn: { isActive: boolean; isPrimary: boolean }) {
    if (!conn.isActive) return <span className="flex items-center gap-1 rounded-full bg-red-500/10 border border-red-500/20 px-2 py-0.5 text-[10px] font-medium text-red-500"><AlertCircle className="w-3 h-3" /> Inactive</span>
    if (conn.isPrimary) return <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-500"><CheckCircle className="w-3 h-3" /> Primary</span>
    return <span className="flex items-center gap-1 rounded-full bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 text-[10px] font-medium text-blue-500">Active</span>
}

// ============================================================
// Main component
// ============================================================

interface ConnectionsPanelProps {
    onClose?: () => void
}

export const ConnectionsPanel: FC<ConnectionsPanelProps> = ({ onClose }) => {
    const {
        connections,
        activeConnectionId,
        isLoading,
        actionLoading,
        actionError,
        clearError,
        setActiveConnection,
        createConnection,
        deleteConnection,
        testConnection,
        setPrimary,
    } = useConnections()

    const [showForm, setShowForm] = useState(false)
    const [form, setForm] = useState<FormState>(DEFAULT_FORM)
    const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({})
    const [availableGraphs, setAvailableGraphs] = useState<string[]>([])
    const [graphsLoading, setGraphsLoading] = useState(false)

    // ── Form helpers ──────────────────────────────────────────

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
            const res = await fetch('/graph/v1/providers/falkordb/graphs', {
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

    const handleCreate = useCallback(async () => {
        const req: ConnectionCreateRequest = {
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
            await createConnection(req)
            setShowForm(false)
            setForm(DEFAULT_FORM)
            setAvailableGraphs([])
        } catch {
            // Error shown via actionError
        }
    }, [form, createConnection])

    const handleTest = useCallback(async (id: string) => {
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

    const handleDelete = useCallback(async (id: string) => {
        if (!confirm('Delete this connection? This cannot be undone.')) return
        await deleteConnection(id)
        if (activeConnectionId === id) {
            const next = connections.find((c) => c.id !== id)
            setActiveConnection(next?.id ?? null)
        }
    }, [deleteConnection, activeConnectionId, connections, setActiveConnection])

    // ── Render ────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full bg-canvas text-ink relative">
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-glass-border bg-canvas-elevated sticky top-0 z-10">
                <div>
                    <h2 className="text-lg font-bold flex items-center gap-2">
                        <Network className="w-5 h-5 text-accent-business" />
                        Legacy Connections
                    </h2>
                    <p className="text-xs text-ink-muted mt-1">Manage global direct graph connection credentials and endpoints.</p>
                </div>
                {onClose && (
                    <button onClick={onClose} className="p-2 rounded-full hover:bg-black/5 dark:hover:bg-white/5 text-ink-secondary transition-colors">
                        <X className="w-5 h-5" />
                    </button>
                )}
            </div>

            <div className="flex flex-col gap-5 p-5 overflow-y-auto">
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
                            onClick={() => setShowForm(true)}
                            className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-5 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg transition-all"
                        >
                            Add Connection
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4">
                        <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-ink-muted uppercase tracking-wider">Registered Endpoints</span>
                            {!showForm && (
                                <button
                                    onClick={() => setShowForm(true)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                >
                                    <Plus className="w-3.5 h-3.5" /> New Connection
                                </button>
                            )}
                        </div>
                        <ul className="flex flex-col gap-3">
                            {connections.map((conn) => (
                                <li
                                    key={conn.id}
                                    className={`flex flex-col rounded-xl border p-4 transition-all duration-200 ${conn.id === activeConnectionId
                                        ? 'border-accent-business/50 bg-accent-business/5 shadow-md shadow-accent-business/5'
                                        : 'border-glass-border bg-canvas-elevated hover:shadow-md'
                                        }`}
                                >
                                    <div className="flex items-start justify-between">
                                        <div className="flex gap-3">
                                            <div className={`mt-0.5 w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-inner border ${conn.id === activeConnectionId ? 'bg-accent-business/20 border-accent-business/30 text-accent-business' : 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-secondary'}`}>
                                                <Database className="w-5 h-5" />
                                            </div>
                                            <div className="flex flex-col gap-1.5 min-w-0">
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

                                        <div className="flex items-center gap-2 shrink-0 ml-4">
                                            {conn.id !== activeConnectionId && (
                                                <button
                                                    onClick={() => setActiveConnection(conn.id)}
                                                    className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-accent-business/10 text-accent-business hover:bg-accent-business/20 transition-colors"
                                                >
                                                    Attach
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleTest(conn.id)}
                                                disabled={actionLoading}
                                                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-canvas border border-glass-border text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                            >
                                                Test PING
                                            </button>
                                            <div className="w-px h-6 bg-glass-border mx-1" />
                                            {!conn.isPrimary && (
                                                <button
                                                    onClick={() => setPrimary(conn.id)}
                                                    disabled={actionLoading}
                                                    className="p-1.5 text-ink-muted hover:text-ink rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 title-tooltip"
                                                    title="Set as Default Connection"
                                                >
                                                    <Shield className="w-4 h-4" />
                                                </button>
                                            )}
                                            <button
                                                onClick={() => handleDelete(conn.id)}
                                                disabled={actionLoading}
                                                className="p-1.5 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors disabled:opacity-50"
                                                title="Delete Connection"
                                            >
                                                <Trash2 className="w-4 h-4" />
                                            </button>
                                        </div>
                                    </div>
                                </li>
                            ))}
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

                {/* New connection form inline */}
                {showForm && (
                    <div className="mt-4 p-6 rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl animate-in slide-in-from-bottom-4 fade-in duration-300 relative overflow-hidden">
                        <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-accent-business to-accent-lineage" />

                        <div className="flex items-center justify-between mb-5">
                            <div>
                                <h3 className="text-lg font-bold text-ink">New Connection</h3>
                                <p className="text-xs text-ink-muted">Enter networking details to securely access your graph data.</p>
                            </div>
                            <Activity className="w-6 h-6 text-accent-business/30" />
                        </div>

                        <div className="space-y-4">
                            <div className="grid grid-cols-2 gap-4">
                                {/* Name */}
                                <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                    CONNECTION ALIAS *
                                    <input
                                        type="text"
                                        value={form.name}
                                        onChange={(e) => updateField('name', e.target.value)}
                                        placeholder="e.g. Neo4j Staging"
                                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                    />
                                </label>

                                {/* Provider type */}
                                <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                    DBMS PROVIDER *
                                    <select
                                        value={form.providerType}
                                        onChange={(e) => updateField('providerType', e.target.value as ProviderType)}
                                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                    >
                                        {(Object.keys(PROVIDER_LABELS) as ProviderType[]).map((p) => (
                                            <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                                        ))}
                                    </select>
                                </label>
                            </div>

                            {/* Host / port (not shown for mock) */}
                            {form.providerType !== 'mock' && (
                                <div className="flex gap-4">
                                    <label className="flex flex-1 flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                        {form.providerType === 'datahub' ? 'BASE API URL *' : 'HOST URI *'}
                                        <input
                                            type="text"
                                            value={form.host}
                                            onChange={(e) => updateField('host', e.target.value)}
                                            placeholder={form.providerType === 'datahub' ? 'http://localhost:9002' : 'localhost'}
                                            className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                        />
                                    </label>
                                    {form.providerType !== 'datahub' && (
                                        <label className="flex w-32 flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                            PORT
                                            <input
                                                type="number"
                                                value={form.port}
                                                onChange={(e) => updateField('port', e.target.value)}
                                                className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                            />
                                        </label>
                                    )}
                                </div>
                            )}

                            {/* Graph name (FalkorDB / Neo4j) */}
                            {(form.providerType === 'falkordb' || form.providerType === 'neo4j') && (
                                <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                    {form.providerType === 'neo4j' ? 'DATABASE NAME' : 'DEFAULT GRAPH NAME'}
                                    <div className="flex gap-2">
                                        {form.providerType === 'falkordb' && availableGraphs.length > 0 ? (
                                            <select
                                                value={form.graphName}
                                                onChange={(e) => updateField('graphName', e.target.value)}
                                                className="flex-1 rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
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
                                                className="flex-1 rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                            />
                                        )}
                                        {form.providerType === 'falkordb' && (
                                            <button
                                                type="button"
                                                onClick={handleFetchGraphs}
                                                disabled={graphsLoading}
                                                className="rounded-lg border border-glass-border px-4 py-2 text-xs font-medium bg-canvas hover:bg-black/5 dark:hover:bg-white/5 transition-all text-ink-secondary"
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
                                <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                    BEARER TOKEN (OPTIONAL)
                                    <input
                                        type="password"
                                        value={form.token}
                                        onChange={(e) => updateField('token', e.target.value)}
                                        placeholder="••••••••••••••••"
                                        className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                    />
                                </label>
                            )}
                            {form.providerType === 'neo4j' && (
                                <div className="grid grid-cols-2 gap-4">
                                    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                        USERNAME
                                        <input
                                            type="text"
                                            value={form.username}
                                            onChange={(e) => updateField('username', e.target.value)}
                                            placeholder="neo4j"
                                            className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1.5 text-xs font-medium text-ink-muted">
                                        PASSWORD
                                        <input
                                            type="password"
                                            value={form.password}
                                            onChange={(e) => updateField('password', e.target.value)}
                                            placeholder="••••••••"
                                            className="rounded-lg border border-glass-border bg-canvas px-3 py-2.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-business/50 focus:border-accent-business transition-all duration-200"
                                        />
                                    </label>
                                </div>
                            )}

                            {/* TLS */}
                            {(form.providerType === 'falkordb' || form.providerType === 'neo4j') && (
                                <label className="flex items-center gap-2 mt-4 text-xs font-medium text-ink-secondary cursor-pointer hover:text-ink transition-colors max-w-fit">
                                    <div className={`w-4 h-4 rounded border flex items-center justify-center transition-colors ${form.tlsEnabled ? 'bg-accent-business border-accent-business text-white' : 'border-glass-border bg-transparent'}`}>
                                        {form.tlsEnabled && <CheckCircle className="w-3 h-3" />}
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
                        <div className="flex items-center justify-end gap-3 mt-8 pt-4 border-t border-glass-border">
                            <button
                                onClick={() => {
                                    setShowForm(false)
                                    setForm(DEFAULT_FORM)
                                    setAvailableGraphs([])
                                    clearError()
                                }}
                                className="rounded-lg px-5 py-2.5 text-sm font-medium bg-canvas border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleCreate}
                                disabled={!form.name || actionLoading}
                                className="rounded-lg bg-gradient-to-r from-accent-business to-accent-lineage px-6 py-2.5 text-sm font-semibold text-white shadow-md hover:shadow-lg disabled:opacity-50 disabled:grayscale transition-all flex items-center gap-2"
                            >
                                {actionLoading && <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                                {actionLoading ? 'Connecting...' : 'Save Connection'}
                            </button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    )
}
