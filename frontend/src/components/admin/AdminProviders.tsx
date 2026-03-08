/**
 * AdminProviders — provider management page (CRUD + health).
 * Shows providers as cards with health status, latency, and quick actions.
 */
import { useState, useEffect, useCallback } from 'react'
import {
    Server, Plus, RefreshCw, Wifi, WifiOff, Edit2, Trash2, Zap,
    Shield, Globe, ChevronDown, ChevronUp, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService, type ProviderResponse, type ProviderCreateRequest, type ProviderUpdateRequest } from '@/services/providerService'
import { AdminWizard, type WizardStep } from './AdminWizard'

// ─────────────────────────────────────────────────────────────────────
// Provider Type Config
// ─────────────────────────────────────────────────────────────────────

const PROVIDER_TYPES = [
    { type: 'falkordb' as const, label: 'FalkorDB', icon: '⚡', color: 'text-amber-500 bg-amber-500/10 border-amber-500/20', desc: 'High-performance graph database' },
    { type: 'neo4j' as const, label: 'Neo4j', icon: '🔵', color: 'text-blue-500 bg-blue-500/10 border-blue-500/20', desc: 'The original graph database' },
    { type: 'datahub' as const, label: 'DataHub', icon: '📊', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', desc: 'LinkedIn metadata platform' },
    { type: 'mock' as const, label: 'Mock', icon: '🧪', color: 'text-violet-500 bg-violet-500/10 border-violet-500/20', desc: 'Testing & development' },
]

function getProviderConfig(type: string) {
    return PROVIDER_TYPES.find(p => p.type === type) || PROVIDER_TYPES[3]
}

// ─────────────────────────────────────────────────────────────────────
// Health State
// ─────────────────────────────────────────────────────────────────────

type HealthStatus = 'checking' | 'healthy' | 'unhealthy' | 'unknown'

interface ProviderHealth {
    status: HealthStatus
    latencyMs?: number
    error?: string
}

// ─────────────────────────────────────────────────────────────────────
// Provider Card
// ─────────────────────────────────────────────────────────────────────

function ProviderCard({
    provider,
    health,
    onTest,
    onEdit,
    onDelete,
}: {
    provider: ProviderResponse
    health: ProviderHealth
    onTest: () => void
    onEdit: () => void
    onDelete: () => void
}) {
    const config = getProviderConfig(provider.providerType)
    const [expanded, setExpanded] = useState(false)

    const statusDot = {
        checking: 'bg-amber-400 animate-pulse',
        healthy: 'bg-emerald-400',
        unhealthy: 'bg-red-400',
        unknown: 'bg-gray-400',
    }[health.status]

    return (
        <div className={cn(
            "group border border-glass-border rounded-xl bg-canvas-elevated hover:shadow-lg transition-all duration-200",
            health.status === 'healthy' && "hover:border-emerald-500/30",
            health.status === 'unhealthy' && "border-red-500/20",
        )}>
            <div className="p-5">
                {/* Top Row */}
                <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className={cn("w-10 h-10 rounded-xl border flex items-center justify-center text-lg", config.color)}>
                            {config.icon}
                        </div>
                        <div>
                            <h3 className="text-sm font-bold text-ink">{provider.name}</h3>
                            <p className="text-xs text-ink-muted">{config.label}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className={cn("w-2.5 h-2.5 rounded-full", statusDot)} title={health.status} />
                        {health.latencyMs !== undefined && (
                            <span className="text-[10px] font-mono text-ink-muted">{Math.round(health.latencyMs)}ms</span>
                        )}
                    </div>
                </div>

                {/* Connection Info */}
                <div className="flex items-center gap-4 text-xs text-ink-muted mb-4">
                    {provider.host && (
                        <div className="flex items-center gap-1.5">
                            <Globe className="w-3 h-3" />
                            <span className="font-mono">{provider.host}:{provider.port || '—'}</span>
                        </div>
                    )}
                    {provider.tlsEnabled && (
                        <div className="flex items-center gap-1 text-emerald-500">
                            <Shield className="w-3 h-3" />
                            <span>TLS</span>
                        </div>
                    )}
                </div>

                {/* Action Row */}
                <div className="flex items-center gap-2">
                    <button
                        onClick={onTest}
                        disabled={health.status === 'checking'}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-ink-secondary hover:text-ink transition-colors disabled:opacity-50"
                    >
                        {health.status === 'checking' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                        Test
                    </button>
                    <button
                        onClick={onEdit}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-ink-secondary hover:text-ink transition-colors"
                    >
                        <Edit2 className="w-3 h-3" />
                        Edit
                    </button>
                    <button
                        onClick={onDelete}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors ml-auto"
                    >
                        <Trash2 className="w-3 h-3" />
                    </button>
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors"
                    >
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                </div>
            </div>

            {/* Expanded details */}
            {expanded && (
                <div className="px-5 pb-5 pt-3 border-t border-glass-border animate-in slide-in-from-top-2 fade-in duration-200">
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                        <div>
                            <dt className="text-ink-muted font-medium">Provider ID</dt>
                            <dd className="font-mono text-ink mt-0.5 truncate">{provider.id}</dd>
                        </div>
                        <div>
                            <dt className="text-ink-muted font-medium">Status</dt>
                            <dd className={cn("mt-0.5 font-semibold", provider.isActive ? "text-emerald-500" : "text-red-500")}>
                                {provider.isActive ? 'Active' : 'Inactive'}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-ink-muted font-medium">Created</dt>
                            <dd className="text-ink mt-0.5">{new Date(provider.createdAt).toLocaleDateString()}</dd>
                        </div>
                        <div>
                            <dt className="text-ink-muted font-medium">Last Updated</dt>
                            <dd className="text-ink mt-0.5">{new Date(provider.updatedAt).toLocaleDateString()}</dd>
                        </div>
                        {health.error && (
                            <div className="col-span-2">
                                <dt className="text-red-500 font-medium">Error</dt>
                                <dd className="text-red-400 mt-0.5 font-mono text-[11px] break-all">{health.error}</dd>
                            </div>
                        )}
                    </dl>
                </div>
            )}
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────
// AdminProviders Page
// ─────────────────────────────────────────────────────────────────────

export function AdminProviders() {
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [healthMap, setHealthMap] = useState<Record<string, ProviderHealth>>({})
    const [isLoading, setIsLoading] = useState(true)
    const [showWizard, setShowWizard] = useState(false)

    // Wizard form state
    const [wizType, setWizType] = useState<string>('')
    const [wizName, setWizName] = useState('')
    const [wizHost, setWizHost] = useState('')
    const [wizPort, setWizPort] = useState<number>(6379)
    const [wizTls, setWizTls] = useState(false)
    const [wizUsername, setWizUsername] = useState('')
    const [wizPassword, setWizPassword] = useState('')
    const [wizSubmitting, setWizSubmitting] = useState(false)
    const [editingProvider, setEditingProvider] = useState<ProviderResponse | null>(null)
    const [deleteTarget, setDeleteTarget] = useState<ProviderResponse | null>(null)

    const loadProviders = useCallback(async () => {
        setIsLoading(true)
        try {
            const data = await providerService.list()
            setProviders(data)
        } catch (err) {
            console.error('Failed to load providers', err)
        } finally {
            setIsLoading(false)
        }
    }, [])

    useEffect(() => { loadProviders() }, [loadProviders])

    // Auto health-check on load
    useEffect(() => {
        if (!providers.length) return
        providers.forEach(p => testProvider(p.id))
    }, [providers.length]) // eslint-disable-line react-hooks/exhaustive-deps

    const testProvider = async (id: string) => {
        setHealthMap(prev => ({ ...prev, [id]: { status: 'checking' } }))
        try {
            const result = await providerService.test(id)
            setHealthMap(prev => ({
                ...prev,
                [id]: { status: result.success ? 'healthy' : 'unhealthy', latencyMs: result.latencyMs, error: result.error }
            }))
        } catch {
            setHealthMap(prev => ({ ...prev, [id]: { status: 'unhealthy', error: 'Connection test failed' } }))
        }
    }

    const deleteProvider = async () => {
        if (!deleteTarget) return
        try {
            await providerService.delete(deleteTarget.id)
        } catch (err) {
            console.error('Failed to delete provider', err)
        }
        setDeleteTarget(null)
        loadProviders()
    }

    const resetWizard = () => {
        setWizType(''); setWizName(''); setWizHost(''); setWizPort(6379)
        setWizTls(false); setWizUsername(''); setWizPassword('')
    }

    const handleWizardComplete = async () => {
        setWizSubmitting(true)
        try {
            const req: ProviderCreateRequest = {
                name: wizName,
                providerType: wizType as any,
                host: wizHost || undefined,
                port: wizPort || undefined,
                tlsEnabled: wizTls,
                credentials: (wizUsername || wizPassword) ? { username: wizUsername || undefined, password: wizPassword || undefined } : undefined,
            }
            await providerService.create(req)
            setShowWizard(false)
            resetWizard()
            loadProviders()
        } catch (err) {
            console.error('Failed to create provider', err)
        } finally {
            setWizSubmitting(false)
        }
    }

    const handleEditProvider = (p: ProviderResponse) => {
        setEditingProvider(p)
        setWizType(p.providerType)
        setWizName(p.name)
        setWizHost(p.host || '')
        setWizPort(p.port || 6379)
        setWizTls(p.tlsEnabled)
        setWizUsername('')
        setWizPassword('')
        setShowWizard(true)
    }

    const handleEditComplete = async () => {
        if (!editingProvider) return
        setWizSubmitting(true)
        try {
            const req: ProviderUpdateRequest = {
                name: wizName,
                host: wizHost || undefined,
                port: wizPort || undefined,
                tlsEnabled: wizTls,
                credentials: (wizUsername || wizPassword) ? { username: wizUsername || undefined, password: wizPassword || undefined } : undefined,
            }
            await providerService.update(editingProvider.id, req)
            setShowWizard(false)
            setEditingProvider(null)
            resetWizard()
            loadProviders()
        } catch (err) {
            console.error('Failed to update provider', err)
        } finally {
            setWizSubmitting(false)
        }
    }

    const wizardSteps: WizardStep[] = [
        {
            id: 'type',
            title: 'Provider Type',
            icon: Server,
            validate: () => wizType ? true : 'Please select a provider type.',
            content: (
                <div className="grid grid-cols-2 gap-3">
                    {PROVIDER_TYPES.map(pt => (
                        <button
                            key={pt.type}
                            onClick={() => { setWizType(pt.type); if (pt.type === 'falkordb') setWizPort(6379); else if (pt.type === 'neo4j') setWizPort(7687); }}
                            className={cn(
                                "p-5 rounded-xl border-2 text-left transition-all duration-200 hover:shadow-md",
                                wizType === pt.type
                                    ? "border-indigo-500 bg-indigo-500/5 shadow-md shadow-indigo-500/10"
                                    : "border-glass-border hover:border-indigo-500/30"
                            )}
                        >
                            <div className="text-2xl mb-2">{pt.icon}</div>
                            <h4 className="text-sm font-bold text-ink">{pt.label}</h4>
                            <p className="text-xs text-ink-muted mt-1">{pt.desc}</p>
                        </button>
                    ))}
                </div>
            ),
        },
        {
            id: 'connection',
            title: 'Connection Details',
            icon: Globe,
            validate: () => wizName ? true : 'Please enter a name for this provider.',
            content: (
                <div className="space-y-4">
                    <div>
                        <label className="block text-sm font-medium text-ink mb-1.5">Provider Name *</label>
                        <input
                            value={wizName} onChange={e => setWizName(e.target.value)}
                            placeholder="e.g. Production FalkorDB"
                            className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50"
                        />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2">
                            <label className="block text-sm font-medium text-ink mb-1.5">Host</label>
                            <input
                                value={wizHost} onChange={e => setWizHost(e.target.value)}
                                placeholder="localhost"
                                className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1.5">Port</label>
                            <input
                                type="number" value={wizPort} onChange={e => setWizPort(Number(e.target.value))}
                                className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                            />
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1.5">Username</label>
                            <input
                                value={wizUsername} onChange={e => setWizUsername(e.target.value)}
                                placeholder="optional"
                                className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                            />
                        </div>
                        <div>
                            <label className="block text-sm font-medium text-ink mb-1.5">Password</label>
                            <input
                                type="password" value={wizPassword} onChange={e => setWizPassword(e.target.value)}
                                placeholder="optional"
                                className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                            />
                        </div>
                    </div>
                    <label className="flex items-center gap-3 cursor-pointer">
                        <div className={cn(
                            "w-10 h-6 rounded-full transition-colors flex items-center px-1",
                            wizTls ? "bg-emerald-500" : "bg-black/10 dark:bg-white/10"
                        )}>
                            <div className={cn("w-4 h-4 rounded-full bg-white shadow transition-transform", wizTls && "translate-x-4")} />
                        </div>
                        <span className="text-sm text-ink">Enable TLS</span>
                    </label>
                </div>
            ),
        },
        {
            id: 'review',
            title: 'Review & Save',
            icon: Shield,
            validate: () => true,
            content: (
                <div className="space-y-4">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                        <h4 className="text-sm font-bold text-ink mb-3">Provider Summary</h4>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div><dt className="text-ink-muted">Type</dt><dd className="font-semibold text-ink mt-0.5">{getProviderConfig(wizType).label}</dd></div>
                            <div><dt className="text-ink-muted">Name</dt><dd className="font-semibold text-ink mt-0.5">{wizName || '—'}</dd></div>
                            <div><dt className="text-ink-muted">Host</dt><dd className="font-mono text-ink mt-0.5">{wizHost || 'localhost'}:{wizPort}</dd></div>
                            <div><dt className="text-ink-muted">TLS</dt><dd className={cn("font-semibold mt-0.5", wizTls ? "text-emerald-500" : "text-ink-muted")}>{wizTls ? 'Enabled' : 'Disabled'}</dd></div>
                            <div><dt className="text-ink-muted">Authentication</dt><dd className="text-ink mt-0.5">{wizUsername ? `User: ${wizUsername}` : 'None'}</dd></div>
                        </dl>
                    </div>
                    <p className="text-xs text-ink-muted">
                        The connection will be tested automatically after creation.
                    </p>
                </div>
            ),
        },
    ]

    // ── Render ────────────────────────────────────────────────────────

    const healthyCount = Object.values(healthMap).filter(h => h.status === 'healthy').length
    const unhealthyCount = Object.values(healthMap).filter(h => h.status === 'unhealthy').length

    return (
        <div className="p-8 max-w-6xl mx-auto">
            {/* Page Header */}
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h2 className="text-2xl font-bold text-ink">Providers</h2>
                    <p className="text-sm text-ink-muted mt-1">Manage database connections and monitor health</p>
                </div>
                <button
                    onClick={() => { resetWizard(); setShowWizard(true) }}
                    className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold shadow-lg shadow-indigo-500/25 hover:shadow-xl hover:shadow-indigo-500/30 transition-all"
                >
                    <Plus className="w-4 h-4" />
                    Add Provider
                </button>
            </div>

            {/* Health Summary */}
            {providers.length > 0 && (
                <div className="flex items-center gap-4 mb-6">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                        <Wifi className="w-3 h-3" />
                        {healthyCount} Connected
                    </div>
                    {unhealthyCount > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 text-red-500 text-xs font-medium">
                            <WifiOff className="w-3 h-3" />
                            {unhealthyCount} Disconnected
                        </div>
                    )}
                    <button
                        onClick={() => providers.forEach(p => testProvider(p.id))}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors ml-auto"
                    >
                        <RefreshCw className="w-3 h-3" />
                        Re-test All
                    </button>
                </div>
            )}

            {/* Grid */}
            {isLoading ? (
                <div className="flex items-center justify-center py-20">
                    <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
                </div>
            ) : providers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Server className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">No providers configured</h3>
                    <p className="text-sm text-ink-muted mb-6">Add a database provider to get started</p>
                    <button
                        onClick={() => { resetWizard(); setShowWizard(true) }}
                        className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold"
                    >
                        <Plus className="w-4 h-4" />
                        Add Your First Provider
                    </button>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {providers.map(p => (
                        <ProviderCard
                            key={p.id}
                            provider={p}
                            health={healthMap[p.id] || { status: 'unknown' }}
                            onTest={() => testProvider(p.id)}
                            onEdit={() => handleEditProvider(p)}
                            onDelete={() => setDeleteTarget(p)}
                        />
                    ))}
                </div>
            )}

            {/* Create Wizard */}
            <AdminWizard
                title={editingProvider ? `Edit ${editingProvider.name}` : 'Add Provider'}
                steps={wizardSteps}
                isOpen={showWizard}
                onClose={() => { setShowWizard(false); setEditingProvider(null); resetWizard() }}
                onComplete={editingProvider ? handleEditComplete : handleWizardComplete}
                isSubmitting={wizSubmitting}
                completionLabel={editingProvider ? 'Save Changes' : 'Create Provider'}
            />

            {/* Delete Confirm */}
            {deleteTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDeleteTarget(null)} />
                    <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                                <Trash2 className="w-5 h-5 text-red-500" />
                            </div>
                            <h3 className="text-lg font-bold text-ink">Delete Provider</h3>
                        </div>
                        <p className="text-sm text-ink-secondary mb-6">
                            Are you sure you want to delete <strong>{deleteTarget.name}</strong>? Data sources using this provider will need to be reconfigured.
                        </p>
                        <div className="flex justify-end gap-3">
                            <button onClick={() => setDeleteTarget(null)} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">Cancel</button>
                            <button onClick={deleteProvider} className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors">Delete</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
