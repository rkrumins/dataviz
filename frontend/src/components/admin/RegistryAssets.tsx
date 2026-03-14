/**
 * RegistryAssets — Full-page Data Asset Management
 *
 * Two-panel layout:
 *  Left: sticky provider selector with health + asset counts
 *  Right: scrollable asset list with search, filters, bulk actions,
 *         lazy stats, blast-radius unregister, and inline route step
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import {
    Database, Search, Filter, Loader2, Trash2,
    BookOpen, CheckCircle2, RefreshCw, Layers,
    AlertTriangle, ArrowRight, Zap, X, ChevronRight
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    providerService,
    type ProviderResponse,
    type ProviderImpactResponse,
} from '@/services/providerService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'

// ─── Provider type helpers ────────────────────────────────────────────────────
const PROVIDER_TYPES = [
    { type: 'falkordb', label: 'FalkorDB', icon: '⚡', color: 'text-amber-500 bg-amber-500/10 border-amber-500/20' },
    { type: 'neo4j', label: 'Neo4j', icon: '🔵', color: 'text-blue-500 bg-blue-500/10 border-blue-500/20' },
    { type: 'datahub', label: 'DataHub', icon: '📊', color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' },
    { type: 'mock', label: 'Mock', icon: '🧪', color: 'text-violet-500 bg-violet-500/10 border-violet-500/20' },
]
function getProviderConfig(type: string) {
    return PROVIDER_TYPES.find(p => p.type === type) || PROVIDER_TYPES[3]
}

// Stable palette of subtle indicator colours cycling for type chips
const TYPE_COLOURS = [
    'bg-blue-500/10 text-blue-600 border-blue-500/20',
    'bg-violet-500/10 text-violet-600 border-violet-500/20',
    'bg-amber-500/10 text-amber-600 border-amber-500/20',
    'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    'bg-rose-500/10 text-rose-600 border-rose-500/20',
    'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
    'bg-orange-500/10 text-orange-600 border-orange-500/20',
    'bg-teal-500/10 text-teal-600 border-teal-500/20',
]

// ─── AssetRow ─────────────────────────────────────────────────────────────────
function AssetRow({
    providerId, assetName, isRegistered, isSelected,
    onToggle, onUnregister,
}: {
    providerId: string
    assetName: string
    isRegistered: boolean
    isSelected: boolean
    onToggle: (name: string) => void
    onUnregister: (name: string) => void
}) {
    const [stats, setStats] = useState<any>(null)
    const [loadingStats, setLoadingStats] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const ref = useRef<HTMLDivElement>(null)

    useEffect(() => {
        const observer = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && !stats && !loadingStats) {
                setLoadingStats(true)
                providerService.getAssetStats(providerId, assetName)
                    .then(setStats)
                    .catch(() => { })
                    .finally(() => setLoadingStats(false))
                observer.disconnect()
            }
        }, { rootMargin: '200px' })
        if (ref.current) observer.observe(ref.current)
        return () => observer.disconnect()
    }, [assetName, providerId, stats, loadingStats])

    // Separate handlers: circle = select/unregister, chevron = expand
    const handleSelect = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (isRegistered) onUnregister(assetName)
        else onToggle(assetName)
    }
    const handleExpand = (e: React.MouseEvent) => {
        e.stopPropagation()
        setExpanded(v => !v)
    }

    const nodeTypes = stats?.entityTypeCounts
        ? (Object.entries(stats.entityTypeCounts) as [string, number][])
        : []
    const edgeTypes = stats?.edgeTypeCounts
        ? (Object.entries(stats.edgeTypeCounts) as [string, number][])
        : []
    const hasTypes = nodeTypes.length > 0 || edgeTypes.length > 0

    return (
        <div
            ref={ref}
            className={cn(
                'rounded-xl border-2 transition-all duration-150 overflow-hidden',
                isRegistered
                    ? 'bg-emerald-500/5 border-emerald-500/30'
                    : isSelected
                        ? 'bg-indigo-500/[0.06] border-indigo-500/40 shadow-sm'
                        : 'bg-canvas border-glass-border hover:border-indigo-400/40'
            )}
        >
            {/* ─── Header row ─────────────────────────────────────── */}
            <div className="flex items-center gap-3 p-3.5">
                {/* Selection circle */}
                <div
                    onClick={handleSelect}
                    role="checkbox"
                    aria-checked={isRegistered || isSelected}
                    className={cn(
                        'flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center cursor-pointer transition-all duration-150 group/sel',
                        isRegistered
                            ? 'border-emerald-500 bg-emerald-500 hover:border-red-400 hover:bg-red-400'
                            : isSelected
                                ? 'border-indigo-500 bg-indigo-500 hover:bg-indigo-400'
                                : 'border-glass-border bg-transparent hover:border-indigo-400'
                    )}
                >
                    {isRegistered && (
                        <>
                            <svg className="w-2.5 h-2.5 text-white group-hover/sel:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            <svg className="w-2.5 h-2.5 text-white hidden group-hover/sel:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </>
                    )}
                    {!isRegistered && isSelected && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    )}
                </div>

                {/* DB icon */}
                <div className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                    isRegistered ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-indigo-500/10 border border-indigo-500/20'
                )}>
                    <Database className={cn('w-3.5 h-3.5', isRegistered ? 'text-emerald-500' : 'text-indigo-500')} />
                </div>

                {/* Name + badge + metrics summary */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-ink truncate">{assetName}</span>
                        {isRegistered ? (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/25 font-bold uppercase tracking-wide">Active</span>
                        ) : isSelected ? (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 border border-indigo-500/25 font-bold uppercase tracking-wide">Queued</span>
                        ) : (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-ink-muted font-bold uppercase tracking-wide">Available</span>
                        )}
                    </div>

                    <div className="flex items-center gap-3">
                        {loadingStats ? (
                            <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>Loading metrics...</span>
                            </div>
                        ) : stats ? (
                            <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0"></span>
                                    {(stats.nodeCount ?? 0).toLocaleString()} nodes
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0"></span>
                                    {(stats.edgeCount ?? 0).toLocaleString()} edges
                                </span>
                                {nodeTypes.length > 0 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/8 text-blue-600 font-semibold border border-blue-500/15">
                                        {nodeTypes.length} entity type{nodeTypes.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {edgeTypes.length > 0 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/8 text-violet-600 font-semibold border border-violet-500/15">
                                        {edgeTypes.length} edge type{edgeTypes.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-[11px] text-ink-muted/40 font-mono truncate">{assetName}</span>
                        )}
                    </div>
                </div>

                {/* Expand toggle — only when types are available */}
                {(hasTypes || loadingStats) && (
                    <button
                        onClick={handleExpand}
                        className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        title={expanded ? 'Hide schema detail' : 'Show entity & relationship types'}
                    >
                        <svg
                            className={cn('w-3.5 h-3.5 transition-transform duration-200', expanded && 'rotate-180')}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                )}
            </div>

            {/* ─── Entity + Relationship type breakdown ───────────── */}
            {expanded && hasTypes && (
                <div className="border-t border-glass-border/60 px-3.5 pb-3.5 animate-in slide-in-from-top-1 fade-in duration-150">
                    <div className="pt-3 space-y-3">

                        {/* Node types */}
                        {nodeTypes.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0"></span>
                                    Entity Types ({nodeTypes.length})
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {[...nodeTypes]
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([typeName, count], i) => (
                                            <span
                                                key={typeName}
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-medium',
                                                    TYPE_COLOURS[i % TYPE_COLOURS.length]
                                                )}
                                            >
                                                <span className="font-semibold">{typeName}</span>
                                                <span className="opacity-55 font-mono text-[10px]">{(count as number).toLocaleString()}</span>
                                            </span>
                                        ))
                                    }
                                </div>
                            </div>
                        )}

                        {/* Relationship types */}
                        {edgeTypes.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0"></span>
                                    Edge Types ({edgeTypes.length})
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {[...edgeTypes]
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([typeName, count], i) => (
                                            <span
                                                key={typeName}
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-medium',
                                                    TYPE_COLOURS[(i + 3) % TYPE_COLOURS.length]
                                                )}
                                            >
                                                <svg className="w-2.5 h-2.5 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M5 12h14M14 7l5 5-5 5" /></svg>
                                                <span className="font-semibold">{typeName}</span>
                                                <span className="opacity-55 font-mono text-[10px]">{(count as number).toLocaleString()}</span>
                                            </span>
                                        ))
                                    }
                                </div>
                            </div>
                        )}

                        {/* Graph Connectivity score */}
                        {stats && (stats.nodeCount ?? 0) > 0 && (() => {
                            const ratio = (stats.edgeCount ?? 0) / Math.max(stats.nodeCount ?? 1, 1)
                            // Normalise: 0 edges/node = 0%, 10 edges/node = 100%
                            const pct = Math.min(100, Math.round((ratio / 10) * 100))
                            const label = pct < 20 ? 'Very Sparse' : pct < 40 ? 'Sparse' : pct < 60 ? 'Moderate' : pct < 80 ? 'Dense' : 'Very Dense'
                            const barColor = pct < 20
                                ? 'from-blue-400 to-blue-500'
                                : pct < 50
                                    ? 'from-blue-500 to-indigo-500'
                                    : pct < 75
                                        ? 'from-indigo-500 to-violet-500'
                                        : 'from-violet-500 to-amber-500'
                            return (
                                <div>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Graph Connectivity</p>
                                        <div className="flex items-center gap-1.5">
                                            <span className={cn(
                                                'text-[10px] font-bold px-1.5 py-0.5 rounded-full border',
                                                pct < 20 ? 'text-blue-500 bg-blue-500/10 border-blue-500/20'
                                                    : pct < 50 ? 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20'
                                                        : pct < 75 ? 'text-violet-500 bg-violet-500/10 border-violet-500/20'
                                                            : 'text-amber-500 bg-amber-500/10 border-amber-500/20'
                                            )}>{label}</span>
                                            <span className="text-[11px] font-black text-ink">{pct}%</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1 h-2 rounded-full bg-black/8 dark:bg-white/8 overflow-hidden">
                                            <div
                                                className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-700', barColor)}
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                        <span className="text-[10px] text-ink-muted font-mono shrink-0">{ratio.toFixed(2)} edges/node</span>
                                    </div>
                                </div>
                            )
                        })()}

                    </div>
                </div>
            )}
        </div>
    )
}

// ─── Unregister Dialog ────────────────────────────────────────────────────────
function UnregisterDialog({
    target,
    impact,
    loading,
    onCancel,
    onConfirm,
}: {
    target: CatalogItemResponse
    impact: ProviderImpactResponse | null
    loading: boolean
    onCancel: () => void
    onConfirm: () => void
}) {
    const hasImpact = impact && (impact.workspaces.length > 0 || impact.views.length > 0)
    return (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => !loading && onCancel()} />
            <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                        <Trash2 className="w-5 h-5 text-red-500" />
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-ink">Unregister Asset</h3>
                        <p className="text-xs text-ink-muted mt-0.5">{target.sourceIdentifier}</p>
                    </div>
                </div>

                <p className="text-sm text-ink-secondary mb-4">
                    This will remove <strong>{target.name || target.sourceIdentifier}</strong> from the Enterprise Catalog.
                </p>

                {loading ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-3 text-ink-muted">
                        <Loader2 className="w-6 h-6 animate-spin" />
                        <span className="text-sm">Calculating impact...</span>
                    </div>
                ) : hasImpact ? (
                    <div className="mb-5 rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
                        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border-b border-red-500/20">
                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                            <span className="text-sm font-bold text-red-500">Micro-Blast Radius Warning</span>
                        </div>
                        <div className="px-4 py-3 space-y-3 max-h-52 overflow-y-auto text-sm">
                            {impact!.workspaces.length > 0 && (
                                <div>
                                    <p className="text-xs font-bold text-red-400 uppercase tracking-wide mb-1.5">{impact!.workspaces.length} Impacted Workspace{impact!.workspaces.length > 1 ? 's' : ''}</p>
                                    <ul className="space-y-1">
                                        {impact!.workspaces.map(ws => (
                                            <li key={ws.id} className="flex items-center gap-2 text-red-500 text-xs">
                                                <ChevronRight className="w-3 h-3 shrink-0" />
                                                {ws.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {impact!.views.length > 0 && (
                                <div>
                                    <p className="text-xs font-bold text-red-400 uppercase tracking-wide mb-1.5">
                                        {impact!.views.length} Downstream Semantic View{impact!.views.length > 1 ? 's' : ''}
                                    </p>
                                    <ul className="space-y-1">
                                        {impact!.views.map(v => (
                                            <li key={v.id} className="flex items-center gap-2 text-red-500 text-xs">
                                                <ChevronRight className="w-3 h-3 shrink-0" />
                                                {v.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="mb-5 p-3 rounded-lg bg-emerald-500/10 text-emerald-600 text-sm font-medium flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        No downstream workspaces or views depend on this asset. Safe to remove.
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <button
                        onClick={onCancel}
                        disabled={loading}
                        className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={loading}
                        className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        Confirm Unregister
                    </button>
                </div>
            </div>
        </div>
    )
}

// ─── Route Step (inline bottom sheet) ─────────────────────────────────────────
function RouteStep({
    provider,
    registeredCatalogs,
    onClose,
    onDone,
}: {
    provider: ProviderResponse
    registeredCatalogs: any[]
    onClose: () => void
    onDone: () => void
}) {
    const navigate = useNavigate()
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [selectedWorkspace, setSelectedWorkspace] = useState('new')
    const [newWorkspaceName, setNewWorkspaceName] = useState('')
    const [projectionMode, setProjectionMode] = useState<'in_source' | 'dedicated'>('in_source')
    const [routing, setRouting] = useState(false)
    const [error, setError] = useState('')

    useEffect(() => {
        workspaceService.list().then(setWorkspaces).catch(console.error)
    }, [])

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
                    dataSources: registeredCatalogs.map((c: any) => ({ catalogItemId: c.id }))
                })
                targetWsId = ws.id
                targetDsId = ws.dataSources[0]?.id || ''
                if (projectionMode === 'dedicated') {
                    for (const ds of ws.dataSources) {
                        await workspaceService.setProjectionMode(targetWsId, ds.id, 'dedicated')
                    }
                }
            } else {
                const added = await Promise.all(
                    registeredCatalogs.map((c: any) =>
                        workspaceService.addDataSource(targetWsId, { catalogItemId: c.id })
                    )
                )
                targetDsId = added[0]?.id || ''
                if (projectionMode === 'dedicated') {
                    for (const ds of added) {
                        await workspaceService.setProjectionMode(targetWsId, ds.id, 'dedicated')
                    }
                }
            }
            navigate(`/schema?workspaceId=${targetWsId}&dataSourceId=${targetDsId}`)
        } catch (err: any) {
            setError(err.message || 'Failed to route assets.')
            setRouting(false)
        }
    }

    return (
        <div className="fixed inset-0 z-[60] flex items-end justify-center">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div className="relative w-full max-w-2xl mx-4 mb-4 bg-canvas-elevated border border-glass-border rounded-2xl shadow-2xl p-6 animate-in slide-in-from-bottom-4 fade-in duration-300">
                {/* Header */}
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                            <BookOpen className="w-5 h-5 text-emerald-500" />
                        </div>
                        <div>
                            <h3 className="text-base font-bold text-ink">
                                {registeredCatalogs.length} Asset{registeredCatalogs.length !== 1 ? 's' : ''} Registered
                            </h3>
                            <p className="text-xs text-ink-muted">Route these data products to a workspace to start exploring</p>
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                {error && <div className="mb-4 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">{error}</div>}

                <div className="grid grid-cols-2 gap-4 mb-5">
                    {/* Workspace selection */}
                    <div className="space-y-3">
                        <label className="block text-xs font-bold text-ink-muted uppercase tracking-wider">Workspace Destination</label>
                        <label className={cn(
                            'flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors',
                            selectedWorkspace === 'new' ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-glass-border hover:border-indigo-500/20'
                        )}>
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
                            <div>
                                <p className="text-xs font-semibold text-ink-muted mb-1.5">Or add to existing:</p>
                                <select
                                    value={selectedWorkspace === 'new' ? '' : selectedWorkspace}
                                    onChange={e => setSelectedWorkspace(e.target.value)}
                                    className="w-full px-3 py-2.5 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink focus:outline-none focus:ring-2 focus:ring-indigo-500/50 appearance-none"
                                >
                                    <option value="" disabled>Select a domain...</option>
                                    {workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
                                </select>
                            </div>
                        )}
                    </div>

                    {/* Projection strategy */}
                    <div>
                        <label className="block text-xs font-bold text-ink-muted uppercase tracking-wider mb-3">Aggregation Strategy</label>
                        <div className="space-y-2">
                            {([
                                { id: 'in_source', title: 'In-Source', desc: 'Write aggregated edges back to the physical graph', icon: '⚡' },
                                { id: 'dedicated', title: 'Dedicated Graph', desc: 'Sync projections to a separate cache graph', icon: '🗂️' },
                            ] as const).map(opt => (
                                <label key={opt.id} className={cn(
                                    'flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors',
                                    projectionMode === opt.id ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-glass-border hover:border-indigo-500/20'
                                )}>
                                    <input type="radio" name="proj" className="mt-0.5 accent-indigo-500" checked={projectionMode === opt.id} onChange={() => setProjectionMode(opt.id)} />
                                    <div>
                                        <div className="flex items-center gap-1.5 text-sm font-bold text-ink">{opt.icon} {opt.title}</div>
                                        <p className="text-xs text-ink-muted mt-0.5">{opt.desc}</p>
                                    </div>
                                </label>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="flex items-center justify-between pt-4 border-t border-glass-border">
                    <p className="text-sm text-ink-muted">
                        <span className="font-bold text-ink">{registeredCatalogs.length}</span> assets ready to route
                    </p>
                    <div className="flex gap-3">
                        <button onClick={onDone} disabled={routing} className="px-5 py-2.5 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors">
                            Skip for now
                        </button>
                        <button
                            onClick={handleRoute}
                            disabled={routing || (selectedWorkspace !== 'new' && !selectedWorkspace)}
                            className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-black bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-500/20 disabled:opacity-50 transition-colors"
                        >
                            {routing
                                ? <><Loader2 className="w-4 h-4 animate-spin" /> Routing...</>
                                : <><ArrowRight className="w-4 h-4" /> Route & Explore</>
                            }
                        </button>
                    </div>
                </div>
            </div>
        </div>
    )
}

// ─── Main: RegistryAssets ─────────────────────────────────────────────────────
export function RegistryAssets() {
    const [searchParams, setSearchParams] = useSearchParams()
    const initialProvider = searchParams.get('provider')

    // Providers
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [providersLoading, setProvidersLoading] = useState(true)
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(initialProvider)

    // Per-provider asset state
    const [assets, setAssets] = useState<string[]>([])
    const [existingCatalogs, setExistingCatalogs] = useState<CatalogItemResponse[]>([])
    const [selected, setSelected] = useState<Set<string>>(new Set())
    const [assetsLoading, setAssetsLoading] = useState(false)
    const [assetsError, setAssetsError] = useState('')

    // Filters
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<'all' | 'selected' | 'registered' | 'unregistered'>('all')

    // Actions
    const [registering, setRegistering] = useState(false)
    const [registerError, setRegisterError] = useState('')
    const [registeredCatalogs, setRegisteredCatalogs] = useState<any[]>([])
    const [showRoute, setShowRoute] = useState(false)

    // Unregister dialog
    const [unregisterTarget, setUnregisterTarget] = useState<CatalogItemResponse | null>(null)
    const [unregisterImpact, setUnregisterImpact] = useState<ProviderImpactResponse | null>(null)
    const [unregisterLoading, setUnregisterLoading] = useState(false)

    // Provider asset count cache (assetId → count)
    const [providerAssetCounts, setProviderAssetCounts] = useState<Record<string, { total: number; registered: number }>>({})

    // Load all providers
    const loadProviders = useCallback(async () => {
        setProvidersLoading(true)
        try {
            const list = await providerService.list()
            setProviders(list)
            if (!selectedProviderId && list.length > 0) {
                setSelectedProviderId(list[0].id)
            }
        } catch { /* swallow */ } finally {
            setProvidersLoading(false)
        }
    }, [selectedProviderId])

    useEffect(() => { loadProviders() }, [])

    // Load assets when provider changes
    useEffect(() => {
        if (!selectedProviderId) return
        let mounted = true
        setAssetsLoading(true)
        setAssetsError('')
        setSearchQuery('')
        setStatusFilter('all')

        Promise.all([
            providerService.listAssets(selectedProviderId),
            catalogService.list(selectedProviderId),
        ]).then(([res, existing]) => {
            if (!mounted) return
            const assetList = res.assets || []
            setAssets(assetList)
            setExistingCatalogs(existing)
            const existingSet = new Set(existing.map((c: any) => c.sourceIdentifier))
            setSelected(new Set(assetList.filter((a: string) => !existingSet.has(a))))

            // Cache counts for sidebar
            setProviderAssetCounts(prev => ({
                ...prev,
                [selectedProviderId]: {
                    total: assetList.length,
                    registered: existing.length,
                }
            }))
        }).catch(err => {
            if (mounted) setAssetsError(err.message || 'Failed to load assets.')
        }).finally(() => {
            if (mounted) setAssetsLoading(false)
        })
        return () => { mounted = false }
    }, [selectedProviderId])

    // Select provider + update URL
    const handleSelectProvider = (id: string) => {
        setSelectedProviderId(id)
        setSearchParams({ tab: 'assets', provider: id })
    }

    // Register queued assets
    const handleRegister = async () => {
        if (!selectedProviderId) return
        setRegistering(true)
        setRegisterError('')
        try {
            const created = await Promise.all(
                Array.from(selected).map(assetId =>
                    catalogService.create({
                        providerId: selectedProviderId,
                        sourceIdentifier: assetId,
                        name: assetId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
                        permittedWorkspaces: ['*'],
                    })
                )
            )
            setRegisteredCatalogs(created)
            // Refresh catalog state
            const existing = await catalogService.list(selectedProviderId)
            setExistingCatalogs(existing)
            setSelected(new Set())
            setProviderAssetCounts(prev => ({
                ...prev,
                [selectedProviderId]: { total: assets.length, registered: existing.length }
            }))
            setShowRoute(true)
        } catch (err: any) {
            setRegisterError(err.message || 'Failed to register assets.')
        } finally {
            setRegistering(false)
        }
    }

    // Initiate unregister
    const handleUnregisterClick = async (assetName: string) => {
        const catalogItem = existingCatalogs.find(c => c.sourceIdentifier === assetName)
        if (!catalogItem) return
        setUnregisterTarget(catalogItem)
        setUnregisterLoading(true)
        try {
            const impact = await catalogService.getImpact(catalogItem.id)
            setUnregisterImpact(impact)
        } catch { /* swallow */ } finally {
            setUnregisterLoading(false)
        }
    }

    // Confirm unregister
    const confirmUnregister = async () => {
        if (!unregisterTarget || !selectedProviderId) return
        setUnregisterLoading(true)
        try {
            await catalogService.delete(unregisterTarget.id, true)
            const existing = await catalogService.list(selectedProviderId)
            setExistingCatalogs(existing)
            setProviderAssetCounts(prev => ({
                ...prev,
                [selectedProviderId]: { total: assets.length, registered: existing.length }
            }))
            setUnregisterTarget(null)
            setUnregisterImpact(null)
        } catch { /* swallow */ } finally {
            setUnregisterLoading(false)
        }
    }

    const toggleSelection = (g: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(g)) next.delete(g)
            else next.add(g)
            return next
        })
    }

    const registeredCount = existingCatalogs.length

    const filteredAssets = assets.filter(g => {
        if (searchQuery && !g.toLowerCase().includes(searchQuery.toLowerCase())) return false
        const isReg = existingCatalogs.some(c => c.sourceIdentifier === g)
        if (statusFilter === 'registered' && !isReg) return false
        if (statusFilter === 'unregistered' && isReg) return false
        if (statusFilter === 'selected' && !selected.has(g)) return false
        return true
    })

    const selectedProvider = providers.find(p => p.id === selectedProviderId)

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <div className="flex gap-6 h-full min-h-0 animate-in fade-in duration-300">

            {/* ─── Left: Provider Sidebar ─────────────────────────────────────── */}
            <div className="w-64 shrink-0 flex flex-col gap-2">
                <div className="mb-1">
                    <p className="text-xs font-bold text-ink-muted uppercase tracking-wider">Providers</p>
                </div>

                {providersLoading ? (
                    <div className="flex items-center gap-2 text-ink-muted text-sm py-4">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Loading...</span>
                    </div>
                ) : providers.length === 0 ? (
                    <div className="p-4 rounded-xl border border-glass-border text-center text-ink-muted text-sm">
                        No providers registered yet.
                    </div>
                ) : (
                    providers.map(p => {
                        const config = getProviderConfig(p.providerType)
                        const counts = providerAssetCounts[p.id]
                        const isActive = selectedProviderId === p.id
                        return (
                            <button
                                key={p.id}
                                onClick={() => handleSelectProvider(p.id)}
                                className={cn(
                                    'w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-all duration-150',
                                    isActive
                                        ? 'bg-indigo-500/8 border-indigo-500/30 shadow-sm'
                                        : 'bg-canvas-elevated border-glass-border hover:border-indigo-400/30 hover:bg-indigo-500/5'
                                )}
                            >
                                <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center text-sm shrink-0', config.color)}>
                                    {config.icon}
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-semibold text-ink truncate">{p.name}</p>
                                    <p className="text-[11px] text-ink-muted">{config.label}</p>
                                </div>
                                {counts && (
                                    <div className="text-right shrink-0">
                                        <p className="text-xs font-bold text-emerald-500">{counts.registered}</p>
                                        <p className="text-[10px] text-ink-muted">/{counts.total}</p>
                                    </div>
                                )}
                            </button>
                        )
                    })
                )}

                {/* Global stats pill */}
                {providers.length > 0 && (
                    <div className="mt-2 p-3 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                        <p className="text-[11px] text-ink-muted mb-2 font-semibold uppercase tracking-wide">Catalog Summary</p>
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-ink-muted">Providers</span>
                                <span className="font-bold text-ink">{providers.length}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-ink-muted">Total Assets</span>
                                <span className="font-bold text-ink">
                                    {Object.values(providerAssetCounts).reduce((a, c) => a + c.total, 0)}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-ink-muted">Registered</span>
                                <span className="font-bold text-emerald-500">
                                    {Object.values(providerAssetCounts).reduce((a, c) => a + c.registered, 0)}
                                </span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ─── Right: Asset Panel ─────────────────────────────────────────── */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {!selectedProvider ? (
                    <div className="flex flex-col items-center justify-center h-full text-ink-muted gap-4">
                        <Layers className="w-12 h-12 opacity-20" />
                        <p className="text-sm font-semibold">Select a provider to view its assets</p>
                    </div>
                ) : (
                    <>
                        {/* Panel header */}
                        <div className="flex items-center justify-between mb-4 shrink-0">
                            <div>
                                <h2 className="text-base font-bold text-ink flex items-center gap-2">
                                    <span>{getProviderConfig(selectedProvider.providerType).icon}</span>
                                    {selectedProvider.name}
                                </h2>
                                <p className="text-sm text-ink-muted mt-0.5">
                                    {assetsLoading
                                        ? 'Scanning...'
                                        : `${assets.length} physical asset${assets.length !== 1 ? 's' : ''} · ${registeredCount} registered`
                                    }
                                </p>
                            </div>
                            <button
                                onClick={() => {
                                    if (!selectedProviderId) return
                                    setAssetsLoading(true)
                                    Promise.all([
                                        providerService.listAssets(selectedProviderId),
                                        catalogService.list(selectedProviderId),
                                    ]).then(([res, existing]) => {
                                        setAssets(res.assets || [])
                                        setExistingCatalogs(existing)
                                    }).finally(() => setAssetsLoading(false))
                                }}
                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <RefreshCw className="w-3.5 h-3.5" /> Refresh
                            </button>
                        </div>

                        {/* Toolbar */}
                        <div className="shrink-0 space-y-3 mb-4">
                            <div className="relative">
                                <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    type="text"
                                    placeholder="Search assets by name..."
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-canvas-elevated border border-glass-border focus:ring-2 focus:ring-indigo-500/50 outline-none text-sm text-ink placeholder:text-ink-muted"
                                />
                                {searchQuery && (
                                    <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center justify-between gap-2">
                                {/* Filter tabs */}
                                <div className="flex gap-1 p-1 bg-black/5 dark:bg-white/5 rounded-xl border border-glass-border">
                                    {[
                                        { id: 'all', label: `All (${assets.length})` },
                                        { id: 'selected', label: `Queued (${selected.size})` },
                                        { id: 'registered', label: `Active (${registeredCount})` },
                                        { id: 'unregistered', label: `Available (${assets.length - registeredCount})` },
                                    ].map(f => (
                                        <button
                                            key={f.id}
                                            onClick={() => setStatusFilter(f.id as any)}
                                            className={cn(
                                                'px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all duration-150 whitespace-nowrap',
                                                statusFilter === f.id
                                                    ? 'bg-canvas shadow text-ink'
                                                    : 'text-ink-muted hover:text-ink'
                                            )}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>

                                {/* Bulk actions */}
                                <div className="flex items-center gap-1.5">
                                    <button
                                        onClick={() => setSelected(new Set(assets.filter(a => !existingCatalogs.some(c => c.sourceIdentifier === a))))}
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

                        {/* Error from registration */}
                        {registerError && (
                            <div className="mb-3 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm flex items-center gap-2 shrink-0">
                                <AlertTriangle className="w-4 h-4 shrink-0" />
                                {registerError}
                            </div>
                        )}

                        {/* Asset list */}
                        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-0">
                            {assetsLoading ? (
                                <div className="flex flex-col items-center justify-center h-full text-ink-muted py-16 gap-4">
                                    <Loader2 className="w-8 h-8 animate-spin" />
                                    <div className="text-center">
                                        <p className="font-semibold text-sm">Scanning Provider</p>
                                        <p className="text-xs opacity-70 mt-1">Discovering physical data assets...</p>
                                    </div>
                                </div>
                            ) : assetsError ? (
                                <div className="flex flex-col items-center justify-center h-full text-red-500 py-12 gap-3">
                                    <AlertTriangle className="w-8 h-8" />
                                    <p className="text-sm font-semibold">{assetsError}</p>
                                </div>
                            ) : filteredAssets.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-ink-muted py-12 gap-3">
                                    <Filter className="w-10 h-10 opacity-20" />
                                    <p className="text-sm font-semibold">No assets match your filters</p>
                                    <button onClick={() => { setSearchQuery(''); setStatusFilter('all') }} className="text-xs text-indigo-500 hover:underline">
                                        Clear filters
                                    </button>
                                </div>
                            ) : (
                                filteredAssets.map(assetName => (
                                    <AssetRow
                                        key={assetName}
                                        providerId={selectedProviderId!}
                                        assetName={assetName}
                                        isRegistered={existingCatalogs.some(c => c.sourceIdentifier === assetName)}
                                        isSelected={selected.has(assetName)}
                                        onToggle={toggleSelection}
                                        onUnregister={handleUnregisterClick}
                                    />
                                ))
                            )}
                        </div>

                        {/* Footer action bar */}
                        <div className="shrink-0 mt-4 pt-4 border-t border-glass-border flex items-center justify-between gap-4">
                            <div className="text-sm text-ink-muted">
                                {selected.size > 0 ? (
                                    <><span className="font-bold text-ink">{selected.size}</span> queued to register</>
                                ) : (
                                    <><span className="font-bold text-emerald-500">{registeredCount}</span> active in catalog</>
                                )}
                            </div>
                            <button
                                onClick={handleRegister}
                                disabled={assetsLoading || selected.size === 0 || registering}
                                className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-black tracking-wide bg-indigo-500 text-white hover:bg-indigo-600 shadow-lg shadow-indigo-500/20 transition-all active:scale-95 disabled:opacity-50 disabled:active:scale-100 disabled:shadow-none"
                            >
                                {registering
                                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Registering...</>
                                    : <><Zap className="w-4 h-4" /> Onboard Assets ({selected.size})</>
                                }
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* ─── Dialogs ────────────────────────────────────────────────────── */}
            {unregisterTarget && (
                <UnregisterDialog
                    target={unregisterTarget}
                    impact={unregisterImpact}
                    loading={unregisterLoading}
                    onCancel={() => { setUnregisterTarget(null); setUnregisterImpact(null) }}
                    onConfirm={confirmUnregister}
                />
            )}

            {showRoute && selectedProvider && (
                <RouteStep
                    provider={selectedProvider}
                    registeredCatalogs={registeredCatalogs}
                    onClose={() => setShowRoute(false)}
                    onDone={() => setShowRoute(false)}
                />
            )}
        </div>
    )
}
