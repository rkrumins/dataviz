import { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Server, Plus, RefreshCw, Wifi, WifiOff, Edit2, Trash2, Zap,
    Shield, Globe, ChevronDown, ChevronUp, Loader2, BookOpen
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { providerService, type ProviderResponse, type ProviderCreateRequest, type ProviderUpdateRequest, type ProviderImpactResponse } from '@/services/providerService'
import { catalogService } from '@/services/catalogService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { AdminWizard, type WizardStep } from './AdminWizard'

const PROVIDER_TYPES = [
    { type: 'falkordb' as const, label: 'FalkorDB', icon: '⚡', color: 'text-amber-500 bg-amber-500/10 border-amber-500/20', desc: 'High-performance graph database' },
    { type: 'neo4j' as const, label: 'Neo4j', icon: '🔵', color: 'text-blue-500 bg-blue-500/10 border-blue-500/20', desc: 'The original graph database' },
    { type: 'datahub' as const, label: 'DataHub', icon: '📊', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20', desc: 'LinkedIn metadata platform' },
    { type: 'mock' as const, label: 'Mock', icon: '🧪', color: 'text-violet-500 bg-violet-500/10 border-violet-500/20', desc: 'Testing & development' },
]

function getProviderConfig(type: string) {
    return PROVIDER_TYPES.find(p => p.type === type) || PROVIDER_TYPES[3]
}

type HealthStatus = 'checking' | 'healthy' | 'unhealthy' | 'unknown'
interface ProviderHealth { status: HealthStatus; latencyMs?: number; error?: string }

function ConnectionCard({ provider, health, onTest, onEdit, onDelete, onScan }: { provider: ProviderResponse; health: ProviderHealth; onTest: () => void; onEdit: () => void; onDelete: () => void; onScan: () => void }) {
    const config = getProviderConfig(provider.providerType)
    const [expanded, setExpanded] = useState(false)
    const statusDot = { checking: 'bg-amber-400 animate-pulse', healthy: 'bg-emerald-400', unhealthy: 'bg-red-400', unknown: 'bg-gray-400' }[health.status]

    return (
        <div className={cn("group border border-glass-border rounded-xl bg-canvas-elevated hover:shadow-lg transition-all duration-200", health.status === 'healthy' && "hover:border-emerald-500/30", health.status === 'unhealthy' && "border-red-500/20")}>
            <div className="p-5">
                <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className={cn("w-10 h-10 rounded-xl border flex items-center justify-center text-lg", config.color)}>{config.icon}</div>
                        <div>
                            <h3 className="text-sm font-bold text-ink">{provider.name}</h3>
                            <p className="text-xs text-ink-muted">{config.label}</p>
                        </div>
                    </div>
                    <div className="flex items-center gap-2">
                        <div className={cn("w-2.5 h-2.5 rounded-full", statusDot)} title={health.status} />
                        {health.latencyMs !== undefined && <span className="text-[10px] font-mono text-ink-muted">{Math.round(health.latencyMs)}ms</span>}
                    </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-ink-muted mb-4">
                    {provider.host && <div className="flex items-center gap-1.5"><Globe className="w-3 h-3" /><span className="font-mono">{provider.host}:{provider.port || '—'}</span></div>}
                    {provider.tlsEnabled && <div className="flex items-center gap-1 text-emerald-500"><Shield className="w-3 h-3" /><span>TLS</span></div>}
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={onTest} disabled={health.status === 'checking'} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-ink-secondary hover:text-ink transition-colors disabled:opacity-50">
                        {health.status === 'checking' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />} Test
                    </button>
                    <button onClick={onScan} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 transition-colors"><RefreshCw className="w-3 h-3" /> Discover Assets</button>
                    <button onClick={onEdit} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 text-ink-secondary hover:text-ink transition-colors"><Edit2 className="w-3 h-3" /> Edit</button>
                    <button onClick={onDelete} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg text-red-500 hover:bg-red-500/10 transition-colors ml-auto"><Trash2 className="w-3 h-3" /></button>
                    <button onClick={() => setExpanded(!expanded)} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                </div>
            </div>
            {expanded && (
                <div className="px-5 pb-5 pt-3 border-t border-glass-border animate-in slide-in-from-top-2 fade-in duration-200">
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                        <div><dt className="text-ink-muted font-medium">Provider ID</dt><dd className="font-mono text-ink mt-0.5 truncate">{provider.id}</dd></div>
                        <div><dt className="text-ink-muted font-medium">Status</dt><dd className={cn("mt-0.5 font-semibold", provider.isActive ? "text-emerald-500" : "text-red-500")}>{provider.isActive ? 'Active' : 'Inactive'}</dd></div>
                        <div><dt className="text-ink-muted font-medium">Created</dt><dd className="text-ink mt-0.5">{new Date(provider.createdAt).toLocaleDateString()}</dd></div>
                        <div><dt className="text-ink-muted font-medium">Last Updated</dt><dd className="text-ink mt-0.5">{new Date(provider.updatedAt).toLocaleDateString()}</dd></div>
                        {health.error && <div className="col-span-2"><dt className="text-red-500 font-medium">Error</dt><dd className="text-red-400 mt-0.5 font-mono text-[11px] break-all">{health.error}</dd></div>}
                    </dl>
                </div>
            )}
        </div>
    )
}

export function RegistryConnections() {
    const navigate = useNavigate()
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
    const [deleteImpact, setDeleteImpact] = useState<ProviderImpactResponse | null>(null)
    const [loadingImpact, setLoadingImpact] = useState(false)

    const loadProviders = useCallback(async () => {
        setIsLoading(true)
        try {
            const data = await providerService.list()
            setProviders(data)
        } catch (err) { console.error('Failed to load providers', err) }
        finally { setIsLoading(false) }
    }, [])

    useEffect(() => { loadProviders() }, [loadProviders])
    useEffect(() => {
        if (!providers.length) return
        providers.forEach(p => testProvider(p.id))
    }, [providers.length]) // eslint-disable-line react-hooks/exhaustive-deps

    const testProvider = async (id: string) => {
        setHealthMap(prev => ({ ...prev, [id]: { status: 'checking' } }))
        try {
            const result = await providerService.test(id)
            setHealthMap(prev => ({ ...prev, [id]: { status: result.success ? 'healthy' : 'unhealthy', latencyMs: result.latencyMs, error: result.error } }))
        } catch {
            setHealthMap(prev => ({ ...prev, [id]: { status: 'unhealthy', error: 'Connection test failed' } }))
        }
    }

    const handleDeleteClick = async (p: ProviderResponse) => {
        setDeleteTarget(p)
        setLoadingImpact(true)
        try {
            const impact = await providerService.getImpact(p.id)
            setDeleteImpact(impact)
        } catch (err) {
            console.error('Failed to load impact', err)
        } finally {
            setLoadingImpact(false)
        }
    }

    const deleteProvider = async () => {
        if (!deleteTarget) return
        try { await providerService.delete(deleteTarget.id) } catch (err) { console.error('Failed to delete provider', err) }
        setDeleteTarget(null)
        setDeleteImpact(null)
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
                name: wizName, providerType: wizType as any, host: wizHost || undefined, port: wizPort || undefined, tlsEnabled: wizTls,
                credentials: (wizUsername || wizPassword) ? { username: wizUsername || undefined, password: wizPassword || undefined } : undefined,
            }
            const newlyCreated = await providerService.create(req)
            setShowWizard(false)
            resetWizard()
            loadProviders()

            // Auto-navigate to assets tab for immediate discovery
            navigate(`/admin/registry?tab=assets&provider=${newlyCreated.id}`)
        } catch (err) { console.error('Failed to create provider', err) }
        finally { setWizSubmitting(false) }
    }

    const handleEditProvider = (p: ProviderResponse) => {
        setEditingProvider(p); setWizType(p.providerType); setWizName(p.name); setWizHost(p.host || ''); setWizPort(p.port || 6379)
        setWizTls(p.tlsEnabled); setWizUsername(''); setWizPassword('')
        setShowWizard(true)
    }

    const handleEditComplete = async () => {
        if (!editingProvider) return
        setWizSubmitting(true)
        try {
            const req: ProviderUpdateRequest = {
                name: wizName, host: wizHost || undefined, port: wizPort || undefined, tlsEnabled: wizTls,
                credentials: (wizUsername || wizPassword) ? { username: wizUsername || undefined, password: wizPassword || undefined } : undefined,
            }
            await providerService.update(editingProvider.id, req)
            setShowWizard(false); setEditingProvider(null); resetWizard(); loadProviders()
        } catch (err) { console.error('Failed to update provider', err) }
        finally { setWizSubmitting(false) }
    }

    const wizardSteps: WizardStep[] = [
        {
            id: 'type', title: 'Provider Type', icon: Server, validate: () => wizType ? true : 'Please select a provider type.',
            content: (
                <div className="grid grid-cols-2 gap-3">
                    {PROVIDER_TYPES.map(pt => (
                        <button key={pt.type} onClick={() => { setWizType(pt.type); if (pt.type === 'falkordb') setWizPort(6379); else if (pt.type === 'neo4j') setWizPort(7687); }}
                            className={cn("p-5 rounded-xl border-2 text-left transition-all duration-200 hover:shadow-md", wizType === pt.type ? "border-indigo-500 bg-indigo-500/5 shadow-md shadow-indigo-500/10" : "border-glass-border hover:border-indigo-500/30")}
                        >
                            <div className="text-2xl mb-2">{pt.icon}</div><h4 className="text-sm font-bold text-ink">{pt.label}</h4><p className="text-xs text-ink-muted mt-1">{pt.desc}</p>
                        </button>
                    ))}
                </div>
            ),
        },
        {
            id: 'connection', title: 'Connection Details', icon: Globe, validate: () => wizName ? true : 'Please enter a name for this provider.',
            content: (
                <div className="space-y-4">
                    <div><label className="block text-sm font-medium text-ink mb-1.5">Connection Name *</label><input value={wizName} onChange={e => setWizName(e.target.value)} placeholder="e.g. Production Data Warehouse" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                    <div className="grid grid-cols-3 gap-3">
                        <div className="col-span-2"><label className="block text-sm font-medium text-ink mb-1.5">Host</label><input value={wizHost} onChange={e => setWizHost(e.target.value)} placeholder="localhost" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                        <div><label className="block text-sm font-medium text-ink mb-1.5">Port</label><input type="number" value={wizPort} onChange={e => setWizPort(Number(e.target.value))} className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div><label className="block text-sm font-medium text-ink mb-1.5">Username</label><input value={wizUsername} onChange={e => setWizUsername(e.target.value)} placeholder="optional" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                        <div><label className="block text-sm font-medium text-ink mb-1.5">Password</label><input type="password" value={wizPassword} onChange={e => setWizPassword(e.target.value)} placeholder="optional" className="w-full px-4 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50" /></div>
                    </div>
                </div>
            ),
        },
        {
            id: 'review', title: 'Review & Save', icon: Shield, validate: () => true,
            content: (
                <div className="space-y-4">
                    <div className="rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] p-5">
                        <h4 className="text-sm font-bold text-ink mb-3">Connection Summary</h4>
                        <dl className="grid grid-cols-2 gap-3 text-sm">
                            <div><dt className="text-ink-muted">Type</dt><dd className="font-semibold text-ink mt-0.5">{getProviderConfig(wizType).label}</dd></div>
                            <div><dt className="text-ink-muted">Name</dt><dd className="font-semibold text-ink mt-0.5">{wizName || '—'}</dd></div>
                            <div><dt className="text-ink-muted">Host</dt><dd className="font-mono text-ink mt-0.5">{wizHost || 'localhost'}:{wizPort}</dd></div>
                        </dl>
                    </div>
                </div>
            ),
        },
    ]

    const healthyCount = Object.values(healthMap).filter(h => h.status === 'healthy').length
    const unhealthyCount = Object.values(healthMap).filter(h => h.status === 'unhealthy').length

    return (
        <div className="space-y-6 animate-in fade-in duration-500">
            {/* Header / Actions */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-xl font-bold text-ink">Physical Connections</h2>
                    <p className="text-sm text-ink-muted mt-1">Manage database clusters and catalog availability.</p>
                </div>
                <button onClick={() => { resetWizard(); setShowWizard(true) }} className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-500 hover:bg-indigo-600 text-white text-sm font-semibold transition-colors">
                    <Plus className="w-4 h-4" /> Register Connection
                </button>
            </div>

            {/* Health Summary */}
            {providers.length > 0 && (
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                        <Wifi className="w-3 h-3" /> {healthyCount} Connected
                    </div>
                    {unhealthyCount > 0 && (
                        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-500/10 text-red-500 text-xs font-medium">
                            <WifiOff className="w-3 h-3" /> {unhealthyCount} Disconnected
                        </div>
                    )}
                    <button onClick={() => providers.forEach(p => testProvider(p.id))} className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-ink-muted hover:text-ink transition-colors ml-auto">
                        <RefreshCw className="w-3 h-3" /> Re-test All
                    </button>
                </div>
            )}

            {/* Grid */}
            {isLoading ? (
                <div className="flex justify-center py-20"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
            ) : providers.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-20 border-2 border-dashed border-glass-border rounded-2xl">
                    <Server className="w-12 h-12 text-ink-muted mb-4" />
                    <h3 className="text-lg font-bold text-ink mb-1">No connections</h3>
                    <p className="text-sm text-ink-muted">Connect your first database to begin.</p>
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {providers.map(p => (
                        <ConnectionCard key={p.id} provider={p} health={healthMap[p.id] || { status: 'unknown' }} onTest={() => testProvider(p.id)} onEdit={() => handleEditProvider(p)} onDelete={() => handleDeleteClick(p)} onScan={() => navigate(`/admin/registry?tab=assets&provider=${p.id}`)} />
                    ))}
                </div>
            )}

            <AdminWizard title={editingProvider ? `Edit ${editingProvider.name}` : 'Register Connection'} steps={wizardSteps} isOpen={showWizard} onClose={() => { setShowWizard(false); setEditingProvider(null); resetWizard() }} onComplete={editingProvider ? handleEditComplete : handleWizardComplete} isSubmitting={wizSubmitting} completionLabel={editingProvider ? 'Save Changes' : 'Connect'} />

            {deleteTarget && (
                <div className="fixed inset-0 z-50 flex items-center justify-center">
                    <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => { setDeleteTarget(null); setDeleteImpact(null); }} />
                    <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                        <div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center"><Trash2 className="w-5 h-5 text-red-500" /></div><h3 className="text-lg font-bold text-ink">Delete Connection</h3></div>

                        <p className="text-sm text-ink-secondary mb-4">Are you sure you want to delete <strong>{deleteTarget.name}</strong>?</p>

                        {loadingImpact ? (
                            <div className="flex justify-center py-4"><Loader2 className="w-5 h-5 animate-spin text-ink-muted" /></div>
                        ) : deleteImpact ? (
                            <div className="mb-6 p-4 rounded-xl border border-red-500/20 bg-red-500/5 text-sm">
                                <h4 className="font-semibold text-red-500 mb-2 flex items-center gap-2">< Zap className="w-4 h-4" /> Blast Radius Warning</h4>
                                <p className="text-red-400 mb-3 text-xs leading-relaxed">
                                    Deleting this infrastructure will cause a cascading deletion of the following dependent assets across the entire Enterprise:
                                </p>
                                <ul className="space-y-1 text-xs text-red-500 font-medium">
                                    <li>• {deleteImpact.catalogItems.length} Enterprise Catalog Data Products</li>
                                    <li>• {deleteImpact.workspaces.length} Subscribing Workspaces</li>
                                    <li>• {deleteImpact.views.length} Downstream Semantic Views</li>
                                </ul>
                                {(deleteImpact.catalogItems.length > 0 || deleteImpact.workspaces.length > 0 || deleteImpact.views.length > 0) && (
                                    <p className="mt-3 text-red-400 text-[11px] uppercase tracking-wider font-bold">This action cannot be undone.</p>
                                )}
                            </div>
                        ) : null}

                        <div className="flex justify-end gap-3">
                            <button onClick={() => { setDeleteTarget(null); setDeleteImpact(null); }} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5">Cancel</button>
                            <button onClick={deleteProvider} disabled={loadingImpact} className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors">Confirm Deletion</button>
                        </div>
                    </div>
                </div>
            )}

        </div>
    )
}

import { CatalogItemResponse } from '@/services/catalogService'
import { Search, Filter, ShieldAlert, Database } from 'lucide-react'
import { useRef } from 'react'

function AssetRow({ providerId, assetName, isRegistered, isSelected, onToggle, onUnregister }: {
    providerId: string
    assetName: string
    isRegistered: boolean
    isSelected: boolean
    onToggle: (name: string) => void
    onUnregister: (name: string) => void
}) {
    const [stats, setStats] = useState<any>(null)
    const [loading, setLoading] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !stats && !loading) {
                setLoading(true)
                providerService.getAssetStats(providerId, assetName)
                    .then(setStats)
                    .catch(() => { })
                    .finally(() => setLoading(false))
                observer.disconnect()
            }
        }, { rootMargin: '150px' })
        if (ref.current) observer.observe(ref.current)
        return () => observer.disconnect()
    }, [assetName, providerId, stats, loading])

    const isActive = isRegistered || isSelected
    void isActive // consumed by className below

    const handleClick = () => {
        if (isRegistered) onUnregister(assetName)
        else onToggle(assetName)
    }

    return (
        <div
            ref={ref}
            onClick={handleClick}
            className={cn(
                "relative flex items-start gap-3 p-4 rounded-xl border-2 cursor-pointer transition-all duration-200 select-none",
                isRegistered
                    ? "bg-emerald-500/5 border-emerald-500/30 hover:border-red-400/50 hover:bg-red-500/5 group/reg"
                    : isSelected
                        ? "bg-indigo-500/8 border-indigo-500/40 shadow-sm shadow-indigo-500/10"
                        : "bg-canvas border-glass-border hover:border-indigo-400/40 hover:bg-indigo-500/5"
            )}
        >
            {/* Selection indicator — top-left corner */}
            <div className={cn(
                "flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 transition-all duration-200",
                isRegistered
                    ? "border-emerald-500 bg-emerald-500 group-hover/reg:border-red-400 group-hover/reg:bg-red-400"
                    : isSelected
                        ? "border-indigo-500 bg-indigo-500"
                        : "border-glass-border bg-transparent"
            )}>
                {isRegistered ? (
                    <svg className="w-3 h-3 text-white group-hover/reg:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                ) : null}
                {isRegistered ? (
                    // X icon on hover for registered
                    <svg className="w-3 h-3 text-white hidden group-hover/reg:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                ) : isSelected ? (
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                ) : null}
            </div>

            {/* Icon */}
            <div className={cn(
                "w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-colors",
                isRegistered ? "bg-emerald-500/10 border border-emerald-500/20" : "bg-indigo-500/10 border border-indigo-500/20"
            )}>
                <Database className={cn("w-4 h-4", isRegistered ? "text-emerald-500" : "text-indigo-500")} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-semibold text-ink truncate">{assetName}</span>
                    {isRegistered ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/25 font-bold uppercase tracking-wide group-hover/reg:bg-red-500/15 group-hover/reg:text-red-500 group-hover/reg:border-red-500/25 transition-colors">
                            <span className="group-hover/reg:hidden">Active</span>
                            <span className="hidden group-hover/reg:inline">Remove</span>
                        </span>
                    ) : isSelected ? (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 border border-indigo-500/25 font-bold uppercase tracking-wide">Queued</span>
                    ) : (
                        <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-ink-muted font-bold uppercase tracking-wide">Available</span>
                    )}
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-3">
                    {loading ? (
                        <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Loading metrics...</span>
                        </div>
                    ) : stats ? (
                        <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                            <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-blue-400"></span>
                                {(stats.nodeCount ?? 0).toLocaleString()} nodes
                            </span>
                            <span className="flex items-center gap-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-violet-400"></span>
                                {(stats.edgeCount ?? 0).toLocaleString()} edges
                            </span>
                            {stats.entityTypeCounts && Object.keys(stats.entityTypeCounts).length > 0 && (
                                <span className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/5 font-mono text-[10px]">
                                    {Object.keys(stats.entityTypeCounts).length} types
                                </span>
                            )}
                        </div>
                    ) : (
                        <span className="text-[11px] text-ink-muted/50 font-mono">{assetName}</span>
                    )}
                </div>
            </div>
        </div>
    )
}

function ManageAssetsModal({ provider, onClose }: { provider: ProviderResponse; onClose: () => void }) {
    const navigate = useNavigate()
    const [step, setStep] = useState<'discover' | 'route'>('discover')
    const [assets, setAssets] = useState<string[]>([])
    const [existingCatalogs, setExistingCatalogs] = useState<CatalogItemResponse[]>([])
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState('')
    const [registering, setRegistering] = useState(false)

    // Routing step state
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [registeredCatalogs, setRegisteredCatalogs] = useState<any[]>([])
    const [selectedWorkspace, setSelectedWorkspace] = useState<string>('new')
    const [newWorkspaceName, setNewWorkspaceName] = useState('')
    const [routing, setRouting] = useState(false)
    const [projectionMode, setProjectionMode] = useState<'in_source' | 'dedicated'>('in_source')

    // Search & Filter state
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<'all' | 'selected' | 'registered' | 'unregistered'>('all')

    // Un-register state
    const [unregisterTarget, setUnregisterTarget] = useState<CatalogItemResponse | null>(null)
    const [unregisterImpact, setUnregisterImpact] = useState<ProviderImpactResponse | null>(null)
    const [loadingImpact, setLoadingImpact] = useState(false)

    useEffect(() => {
        let mounted = true
        async function fetchState() {
            setLoading(true)
            try {
                const [res, existing] = await Promise.all([
                    providerService.listAssets(provider.id),
                    catalogService.list(provider.id)
                ])
                if (mounted) {
                    setAssets(res.assets || [])
                    setExistingCatalogs(existing)

                    const existingSet = new Set(existing.map((c: any) => c.sourceIdentifier))
                    const toSelect = (res.assets || []).filter((g: string) => !existingSet.has(g))
                    setSelected(new Set(toSelect))
                }
            } catch (err: any) {
                if (mounted) setError(err.message || 'Failed to scan database for assets')
            } finally {
                if (mounted) setLoading(false)
            }
        }
        fetchState()
        return () => { mounted = false }
    }, [provider.id])

    useEffect(() => {
        if (step === 'route') {
            workspaceService.list().then(setWorkspaces).catch(console.error)
        }
    }, [step])

    const handleRegister = async () => {
        setRegistering(true)
        setError('')
        try {
            const promises = Array.from(selected).map((assetId: string) =>
                catalogService.create({
                    providerId: provider.id,
                    sourceIdentifier: assetId,
                    name: assetId.replace(/_/g, ' ').replace(/\b\w/g, (l: string) => l.toUpperCase()),
                    permittedWorkspaces: ['*'], // By default, grant globally for magic onboarding
                })
            )
            const created = await Promise.all(promises)
            setRegisteredCatalogs(created)
            setStep('route')
        } catch (err) {
            console.error('Failed to register catalogs', err)
            setError('Failed to bulk register assets.')
            setRegistering(false)
        }
    }

    const handleRoute = async () => {
        setRouting(true)
        setError('')
        try {
            let targetWsId = selectedWorkspace
            let targetDsId = ''

            if (targetWsId === 'new') {
                const wsName = newWorkspaceName.trim() || `${provider.name} Domain`
                const ws = await workspaceService.create({
                    name: wsName,
                    dataSources: registeredCatalogs.map((c: any) => ({
                        catalogItemId: c.id
                    }))
                })
                targetWsId = ws.id
                targetDsId = ws.dataSources[0]?.id || ''

                // set projection modes
                if (projectionMode === 'dedicated') {
                    for (const ds of ws.dataSources) {
                        await workspaceService.setProjectionMode(targetWsId, ds.id, 'dedicated')
                    }
                }
            } else {
                const promises = registeredCatalogs.map((c: any) =>
                    workspaceService.addDataSource(targetWsId, { catalogItemId: c.id })
                )
                const added = await Promise.all(promises)
                targetDsId = added[0]?.id || ''

                if (projectionMode === 'dedicated') {
                    for (const ds of added) {
                        await workspaceService.setProjectionMode(targetWsId, ds.id, 'dedicated')
                    }
                }
            }
            navigate(`/schema?workspaceId=${targetWsId}&dataSourceId=${targetDsId}`)
        } catch (err) {
            console.error('Failed to route', err)
            setError('Failed to route data assets.')
            setRouting(false)
        }
    }

    const toggleSelection = (g: string) => {
        const next = new Set(selected)
        if (next.has(g)) next.delete(g)
        else next.add(g)
        setSelected(next)
    }

    const handleUnregisterClick = async (assetId: string) => {
        const catalogItem = existingCatalogs.find(c => c.sourceIdentifier === assetId)
        if (!catalogItem) return
        setUnregisterTarget(catalogItem)
        setLoadingImpact(true)
        try {
            const impact = await catalogService.getImpact(catalogItem.id)
            setUnregisterImpact(impact)
        } catch (err) {
            console.error(err)
        } finally {
            setLoadingImpact(false)
        }
    }

    const confirmUnregister = async () => {
        if (!unregisterTarget) return
        setLoadingImpact(true)
        try {
            await catalogService.delete(unregisterTarget.id, true)
            const existing = await catalogService.list(provider.id)
            setExistingCatalogs(existing)
            setUnregisterTarget(null)
            setUnregisterImpact(null)
        } catch (err) {
            console.error(err)
            setError('Failed to unregister asset.')
        } finally {
            setLoadingImpact(false)
        }
    }

    const filteredAssets = assets.filter(g => {
        if (searchQuery && !g.toLowerCase().includes(searchQuery.toLowerCase())) return false
        const isReg = existingCatalogs.some(c => c.sourceIdentifier === g)
        if (statusFilter === 'registered' && !isReg) return false
        if (statusFilter === 'unregistered' && isReg) return false
        if (statusFilter === 'selected' && !selected.has(g)) return false
        return true
    })

    if (unregisterTarget) {
        return (
            <div className="fixed inset-0 z-[60] flex items-center justify-center">
                <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !loadingImpact && setUnregisterTarget(null)} />
                <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                    <div className="flex items-center gap-3 mb-4"><div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center"><Trash2 className="w-5 h-5 text-red-500" /></div><h3 className="text-lg font-bold text-ink">Unregister Asset</h3></div>
                    <p className="text-sm text-ink-secondary mb-4">Are you sure you want to remove <strong>{unregisterTarget.sourceIdentifier}</strong> from the Enterprise Catalog?</p>

                    {loadingImpact ? (
                        <div className="flex justify-center py-6"><Loader2 className="w-6 h-6 animate-spin text-ink-muted" /></div>
                    ) : unregisterImpact && (unregisterImpact.workspaces.length > 0 || unregisterImpact.views.length > 0) ? (
                        <div className="mb-6 p-4 rounded-xl border border-red-500/20 bg-red-500/5 text-sm">
                            <h4 className="font-bold text-red-500 mb-2 flex items-center gap-2"><ShieldAlert className="w-4 h-4" /> Micro-Blast Radius Warning</h4>
                            <p className="text-red-400 mb-3 text-xs leading-relaxed">
                                Unregistering this asset will irreparably break the following dependencies:
                            </p>
                            <div className="space-y-2 text-xs text-red-500 font-medium max-h-48 overflow-y-auto mt-2 p-2 bg-red-500/10 rounded-lg">
                                {unregisterImpact.workspaces.length > 0 && (
                                    <div>
                                        <p className="font-bold underline mb-1">{unregisterImpact.workspaces.length} Subscribing Workspaces:</p>
                                        <ul className="list-disc pl-4 space-y-0.5">
                                            {unregisterImpact.workspaces.map(ws => <li key={ws.id}>{ws.name}</li>)}
                                        </ul>
                                    </div>
                                )}
                                {unregisterImpact.views.length > 0 && (
                                    <div className="mt-2">
                                        <p className="font-bold underline mb-1">{unregisterImpact.views.length} Downstream Semantic Views:</p>
                                        <ul className="list-disc pl-4 space-y-0.5">
                                            {unregisterImpact.views.map(v => <li key={v.id}>{v.name}</li>)}
                                        </ul>
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="mb-6 p-3 rounded-lg bg-emerald-500/10 text-emerald-500 text-sm font-medium flex items-center gap-2">
                            <ShieldAlert className="w-4 h-4" /> Safe to unregister. No downstream workspaces or views depend on this asset.
                        </div>
                    )}

                    <div className="flex justify-end gap-3">
                        <button onClick={() => setUnregisterTarget(null)} className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors">Cancel</button>
                        <button onClick={confirmUnregister} disabled={loadingImpact} className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2">
                            {loadingImpact ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} Confirm Unregister
                        </button>
                    </div>
                </div>
            </div>
        )
    }

    if (step === 'discover') {
        const registeredCount = existingCatalogs.length

        return (
            <div className="fixed inset-0 z-50 flex items-center justify-center">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm shadow-2xl" />
                <div className="relative bg-canvas border border-glass-border rounded-[24px] shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col mx-4 animate-in zoom-in-95 fade-in duration-300">

                    <div className="p-6 border-b border-glass-border flex items-center justify-between opacity-100 bg-canvas-elevated rounded-t-[24px]">
                        <div>
                            <h3 className="text-xl font-black text-ink tracking-tight flex items-center gap-2"><Zap className="w-5 h-5 text-indigo-500" /> Manage Data Assets</h3>
                            <p className="text-sm text-ink-muted mt-1">
                                Managing <strong>{provider.name}</strong>. Found <strong>{assets.length}</strong> physical data assets.
                            </p>
                        </div>
                        <button onClick={onClose} className="p-2 text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">✕</button>
                    </div>

                    {/* Toolbar: search + bulk actions */}
                    <div className="p-4 border-b border-glass-border bg-canvas-elevated space-y-3">
                        {/* Row 1: Search */}
                        <div className="relative">
                            <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                            <input
                                type="text"
                                placeholder="Search assets by name..."
                                value={searchQuery}
                                onChange={e => setSearchQuery(e.target.value)}
                                className="w-full pl-9 pr-4 py-2.5 rounded-xl bg-canvas border border-glass-border focus:ring-2 focus:ring-indigo-500/50 outline-none text-sm text-ink placeholder:text-ink-muted"
                            />
                        </div>

                        {/* Row 2: Filters + Select bulk actions */}
                        <div className="flex items-center justify-between gap-2">
                            {/* Status filter tabs */}
                            <div className="flex gap-1 p-1 bg-black/5 dark:bg-white/5 rounded-xl border border-glass-border">
                                {[
                                    { id: 'all', label: `All (${assets.length})` },
                                    { id: 'selected', label: `Queued (${selected.size})` },
                                    { id: 'registered', label: `Active (${registeredCount})` },
                                    { id: 'unregistered', label: `Available (${assets.length - registeredCount})` }
                                ].map(f => (
                                    <button
                                        key={f.id}
                                        onClick={() => setStatusFilter(f.id as any)}
                                        className={cn(
                                            "px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all duration-150 whitespace-nowrap",
                                            statusFilter === f.id
                                                ? "bg-canvas shadow text-ink"
                                                : "text-ink-muted hover:text-ink"
                                        )}
                                    >
                                        {f.label}
                                    </button>
                                ))}
                            </div>

                            {/* Bulk actions */}
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={() => {
                                        const unregisteredAssets = assets.filter(a => !existingCatalogs.some(c => c.sourceIdentifier === a))
                                        setSelected(new Set(unregisteredAssets))
                                    }}
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
                                >
                                    Select All
                                </button>
                                <button
                                    onClick={() => setSelected(new Set())}
                                    disabled={selected.size === 0}
                                    className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-muted bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-40"
                                >
                                    Clear
                                </button>
                            </div>
                        </div>
                    </div>

                    <div className="flex-1 overflow-y-auto p-4 bg-canvas space-y-2 min-h-[300px]">
                        {loading ? (
                            <div className="flex flex-col items-center justify-center h-full text-ink-muted py-20">
                                <Loader2 className="w-8 h-8 animate-spin mb-4" />
                                <span className="font-semibold">Deep Scanning Cluster...</span>
                            </div>
                        ) : error ? (
                            <div className="flex flex-col items-center justify-center h-full text-red-500 py-10">
                                <span className="text-sm font-semibold">{error}</span>
                            </div>
                        ) : filteredAssets.length === 0 ? (
                            <div className="flex flex-col items-center justify-center h-full text-ink-muted py-10">
                                <Filter className="w-10 h-10 mb-3 opacity-20" />
                                <span className="text-sm font-semibold">No data assets match your filters.</span>
                            </div>
                        ) : (
                            filteredAssets.map((g: string) => {
                                const isRegistered = existingCatalogs.some(c => c.sourceIdentifier === g)
                                return (
                                    <AssetRow
                                        key={g}
                                        providerId={provider.id}
                                        assetName={g}
                                        isRegistered={isRegistered}
                                        isSelected={selected.has(g)}
                                        onToggle={toggleSelection}
                                        onUnregister={handleUnregisterClick}
                                    />
                                )
                            })
                        )}
                    </div>

                    <div className="p-4 border-t border-glass-border bg-canvas-elevated rounded-b-[24px] flex items-center justify-between">
                        <div className="text-sm">
                            <span className="font-bold text-ink">{selected.size}</span> <span className="text-ink-muted font-medium">selected to register</span>
                            <span className="mx-2 text-glass-border">|</span>
                            <span className="font-bold text-emerald-500">{registeredCount}</span> <span className="text-ink-muted font-medium">already active</span>
                        </div>
                        <div className="flex gap-3">
                            <button
                                onClick={onClose}
                                disabled={registering}
                                className="px-5 py-2.5 rounded-xl text-sm font-bold text-ink-muted border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                            >
                                Done
                            </button>
                            <button
                                onClick={handleRegister}
                                disabled={loading || !!error || selected.size === 0 || registering}
                                className="flex items-center justify-center gap-2 px-6 py-2.5 rounded-xl text-sm font-black tracking-wide bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:active:scale-100 disabled:shadow-none"
                            >
                                {registering ? (
                                    <><Loader2 className="w-4 h-4 animate-spin" /> REGISTERING...</>
                                ) : (
                                    <>ONBOARD ASSETS ({selected.size})</>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div className="relative bg-canvas-elevated border border-glass-border rounded-[24px] shadow-2xl w-full max-w-md mx-4 p-6 animate-in slide-in-from-right-8 fade-in duration-300">
                <div className="flex items-center justify-center w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 mb-4 text-emerald-500 mx-auto">
                    <BookOpen className="w-6 h-6" />
                </div>

                <div className="text-center mb-6">
                    <h3 className="text-xl font-bold text-ink tracking-tight mb-2">Assets Registered</h3>
                    <p className="text-sm text-ink-muted">
                        Where should we route these <strong>{registeredCatalogs.length} data products</strong> right now?
                    </p>
                </div>

                {error && <div className="p-3 mb-4 rounded-lg bg-red-500/10 text-red-500 text-sm">{error}</div>}

                <div className="space-y-4 mb-6">
                    <div className="space-y-2">
                        <label className="flex items-start gap-3 p-4 rounded-xl border border-glass-border cursor-pointer hover:border-indigo-500/30 transition-colors bg-black/[0.02] dark:bg-white/[0.02] shadow-sm">
                            <input type="radio" checked={selectedWorkspace === 'new'} onChange={() => setSelectedWorkspace('new')} className="mt-1 accent-indigo-500" />
                            <div className="flex-1">
                                <span className="block text-sm font-bold text-ink mb-2">Create New Domain</span>
                                <input
                                    value={newWorkspaceName}
                                    onChange={e => { setSelectedWorkspace('new'); setNewWorkspaceName(e.target.value) }}
                                    placeholder={`${provider.name} Project`}
                                    className="w-full px-3 py-2 rounded-lg bg-canvas border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50"
                                />
                            </div>
                        </label>

                        {workspaces.length > 0 && (
                            <div className="pt-2 px-1">
                                <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-2">Or add to existing:</label>
                                <select
                                    value={selectedWorkspace === 'new' ? '' : selectedWorkspace}
                                    onChange={e => setSelectedWorkspace(e.target.value)}
                                    className="w-full px-4 py-3 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 appearance-none font-medium"
                                >
                                    <option value="" disabled>Select a domain...</option>
                                    {workspaces.map((w: WorkspaceResponse) => <option key={w.id} value={w.id}>{w.name}</option>)}
                                </select>
                            </div>
                        )}
                    </div>

                    <div className="p-4 rounded-xl border border-glass-border bg-black/5 dark:bg-white/5">
                        <label className="block text-xs font-semibold text-ink-muted uppercase tracking-wider mb-3">Projection Strategy</label>
                        <div className="flex gap-3">
                            <label className={cn("flex-1 p-3 rounded-lg border text-center cursor-pointer transition-colors", projectionMode === 'in_source' ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-500" : "bg-canvas border-transparent text-ink-secondary hover:text-ink")}>
                                <input type="radio" name="proj" className="hidden" checked={projectionMode === 'in_source'} onChange={() => setProjectionMode('in_source')} />
                                <span className="block text-sm font-bold mb-1">In-Source</span>
                                <span className="block text-[10px] opacity-80">Write back to physical</span>
                            </label>
                            <label className={cn("flex-1 p-3 rounded-lg border text-center cursor-pointer transition-colors", projectionMode === 'dedicated' ? "bg-indigo-500/10 border-indigo-500/30 text-indigo-500" : "bg-canvas border-transparent text-ink-secondary hover:text-ink")}>
                                <input type="radio" name="proj" className="hidden" checked={projectionMode === 'dedicated'} onChange={() => setProjectionMode('dedicated')} />
                                <span className="block text-sm font-bold mb-1">Dedicated</span>
                                <span className="block text-[10px] opacity-80">Sync to cache graph</span>
                            </label>
                        </div>
                    </div>
                </div>

                <div className="flex gap-3">
                    <button onClick={onClose} disabled={routing} className="px-5 py-3 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors">
                        Close
                    </button>
                    <button onClick={handleRoute} disabled={routing || (selectedWorkspace !== 'new' && !selectedWorkspace)} className="flex-1 flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-black uppercase tracking-wide bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-500/20 disabled:opacity-50 transition-colors">
                        {routing ? <><Loader2 className="w-4 h-4 animate-spin" /> Routing...</> : <>Route & Expand</>}
                    </button>
                </div>
            </div>
        </div>
    )
}
