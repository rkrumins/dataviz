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
import { useConnections } from '@/hooks/useConnections'
import { connectionService, type ConnectionCreateRequest } from '@/services/connectionService'

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
    if (!conn.isActive) return <span className="text-xs text-red-500">Inactive</span>
    if (conn.isPrimary) return <span className="text-xs text-emerald-500 font-medium">Primary</span>
    return <span className="text-xs text-muted-foreground">Active</span>
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
        <div className="flex flex-col gap-4 p-4 min-w-[480px]">
            <div className="flex items-center justify-between">
                <h2 className="text-lg font-semibold">Graph Connections</h2>
                {onClose && (
                    <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
                        ✕
                    </button>
                )}
            </div>

            {/* Connection list */}
            {isLoading ? (
                <p className="text-sm text-muted-foreground animate-pulse">Loading…</p>
            ) : connections.length === 0 ? (
                <p className="text-sm text-muted-foreground">No connections registered yet.</p>
            ) : (
                <ul className="flex flex-col gap-2">
                    {connections.map((conn) => (
                        <li
                            key={conn.id}
                            className={`flex items-center justify-between rounded-md border p-3 ${
                                conn.id === activeConnectionId ? 'border-primary bg-primary/5' : 'border-border'
                            }`}
                        >
                            <div className="flex flex-col gap-0.5">
                                <div className="flex items-center gap-2">
                                    <span className="font-medium text-sm">{conn.name}</span>
                                    {statusBadge(conn)}
                                </div>
                                <span className="text-xs text-muted-foreground">
                                    {PROVIDER_LABELS[conn.providerType] ?? conn.providerType}
                                    {conn.host ? ` · ${conn.host}${conn.port ? `:${conn.port}` : ''}` : ''}
                                    {conn.graphName ? ` · ${conn.graphName}` : ''}
                                </span>
                                {testResults[conn.id] && (
                                    <span
                                        className={`text-xs ${testResults[conn.id].ok ? 'text-emerald-500' : 'text-red-500'}`}
                                    >
                                        {testResults[conn.id].msg}
                                    </span>
                                )}
                            </div>
                            <div className="flex items-center gap-2 shrink-0">
                                {conn.id !== activeConnectionId && (
                                    <button
                                        onClick={() => setActiveConnection(conn.id)}
                                        className="text-xs text-primary hover:underline"
                                    >
                                        Use
                                    </button>
                                )}
                                <button
                                    onClick={() => handleTest(conn.id)}
                                    disabled={actionLoading}
                                    className="text-xs text-muted-foreground hover:text-foreground"
                                >
                                    Test
                                </button>
                                {!conn.isPrimary && (
                                    <button
                                        onClick={() => setPrimary(conn.id)}
                                        disabled={actionLoading}
                                        className="text-xs text-muted-foreground hover:text-foreground"
                                    >
                                        Set Primary
                                    </button>
                                )}
                                <button
                                    onClick={() => handleDelete(conn.id)}
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

            {/* New connection form toggle */}
            {!showForm ? (
                <button
                    onClick={() => setShowForm(true)}
                    className="self-start rounded-md border border-dashed border-border px-3 py-1.5 text-sm text-muted-foreground hover:border-primary hover:text-primary transition-colors"
                >
                    + Add connection
                </button>
            ) : (
                <div className="flex flex-col gap-3 rounded-md border border-border p-4">
                    <h3 className="font-medium text-sm">New Connection</h3>

                    {/* Name */}
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Name *
                        <input
                            type="text"
                            value={form.name}
                            onChange={(e) => updateField('name', e.target.value)}
                            placeholder="Production FalkorDB"
                            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                    </label>

                    {/* Provider type */}
                    <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                        Provider *
                        <select
                            value={form.providerType}
                            onChange={(e) => updateField('providerType', e.target.value as ProviderType)}
                            className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        >
                            {(Object.keys(PROVIDER_LABELS) as ProviderType[]).map((p) => (
                                <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
                            ))}
                        </select>
                    </label>

                    {/* Host / port (not shown for mock) */}
                    {form.providerType !== 'mock' && (
                        <div className="flex gap-2">
                            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                {form.providerType === 'datahub' ? 'Base URL' : 'Host'}
                                <input
                                    type="text"
                                    value={form.host}
                                    onChange={(e) => updateField('host', e.target.value)}
                                    placeholder={form.providerType === 'datahub' ? 'http://localhost:9002' : 'localhost'}
                                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </label>
                            {form.providerType !== 'datahub' && (
                                <label className="flex w-24 flex-col gap-1 text-xs text-muted-foreground">
                                    Port
                                    <input
                                        type="number"
                                        value={form.port}
                                        onChange={(e) => updateField('port', e.target.value)}
                                        className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                    />
                                </label>
                            )}
                        </div>
                    )}

                    {/* Graph name (FalkorDB / Neo4j) */}
                    {(form.providerType === 'falkordb' || form.providerType === 'neo4j') && (
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            {form.providerType === 'neo4j' ? 'Database' : 'Graph name'}
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
                                {form.providerType === 'falkordb' && (
                                    <button
                                        type="button"
                                        onClick={handleFetchGraphs}
                                        disabled={graphsLoading}
                                        className="rounded border border-border px-2 py-1 text-xs hover:bg-muted"
                                        title="Fetch available graphs from this FalkorDB instance"
                                    >
                                        {graphsLoading ? '…' : 'Browse'}
                                    </button>
                                )}
                            </div>
                        </label>
                    )}

                    {/* Credentials */}
                    {form.providerType === 'datahub' && (
                        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                            Bearer token (optional)
                            <input
                                type="password"
                                value={form.token}
                                onChange={(e) => updateField('token', e.target.value)}
                                className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                            />
                        </label>
                    )}
                    {form.providerType === 'neo4j' && (
                        <div className="flex gap-2">
                            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                Username
                                <input
                                    type="text"
                                    value={form.username}
                                    onChange={(e) => updateField('username', e.target.value)}
                                    placeholder="neo4j"
                                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </label>
                            <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
                                Password
                                <input
                                    type="password"
                                    value={form.password}
                                    onChange={(e) => updateField('password', e.target.value)}
                                    className="rounded border border-border bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                                />
                            </label>
                        </div>
                    )}

                    {/* TLS */}
                    {(form.providerType === 'falkordb' || form.providerType === 'neo4j') && (
                        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                            <input
                                type="checkbox"
                                checked={form.tlsEnabled}
                                onChange={(e) => updateField('tlsEnabled', e.target.checked)}
                            />
                            TLS / SSL
                        </label>
                    )}

                    {/* Form actions */}
                    <div className="flex gap-2 pt-1">
                        <button
                            onClick={handleCreate}
                            disabled={!form.name || actionLoading}
                            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50 hover:bg-primary/90 transition-colors"
                        >
                            {actionLoading ? 'Saving…' : 'Add Connection'}
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
