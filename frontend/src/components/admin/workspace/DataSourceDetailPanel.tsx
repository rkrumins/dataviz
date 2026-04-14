/**
 * DataSourceDetailPanel — slide-in drawer for data source details.
 * Renders as a right-side panel via portal (same pattern as ExplorerPreviewDrawer).
 * Tabs: Insights · Aggregation · Views
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Database, Edit2, Trash2, X, ExternalLink, Settings2, Plus, Eye,
    CircleDot, ArrowRightLeft, Layers, BarChart3, AlertTriangle, Loader2,
    GitBranch, Star, Clock, Compass, Save, RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import type { View } from '@/services/viewApiService'
import { AggregationHistory } from '../AggregationHistory'
import { getProviderLogo } from '../ProviderLogos'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'

// ─────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────

export interface AggregationConfigSnapshot {
    projectionMode: string
    dedicatedGraphName: string
}

interface DataSourceDetailPanelProps {
    ds: DataSourceResponse | null
    wsId: string
    isOpen: boolean
    stats?: DataSourceStats
    providerInfo?: DataSourceProviderInfo
    ontologyName?: string
    ontologyId?: string
    views: View[]
    onEdit: () => void
    onDelete?: () => void
    onExplore: () => void
    onReaggregate: () => void
    onPurge: () => Promise<void>
    onSetPrimary: () => void
    /**
     * Persist the Aggregation tab as a single transaction. Receives both the
     * pending edits (local) and the original snapshot (server) so the parent
     * can compute a minimal PATCH.
     */
    onSaveAggregationConfig: (
        pending: AggregationConfigSnapshot,
        original: AggregationConfigSnapshot,
    ) => Promise<void>
    onClose: () => void
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

const AGG_STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
    ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
    running: { label: 'Running', dot: 'bg-indigo-400 animate-pulse', text: 'text-indigo-600 dark:text-indigo-400' },
    pending: { label: 'Pending', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-600 dark:text-amber-400' },
    failed: { label: 'Failed', dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400' },
    skipped: { label: 'Skipped', dot: 'bg-gray-400', text: 'text-ink-muted' },
    none: { label: 'Not Started', dot: 'bg-gray-400', text: 'text-ink-muted' },
}

// ─────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────

function MiniKpi({ icon: Icon, value, label, color }: {
    icon: React.ComponentType<{ className?: string }>
    value: string | number
    label: string
    color: string
}) {
    return (
        <div className="flex-1 p-3 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]">
            <div className="flex items-center gap-2 mb-1">
                <Icon className={cn("w-3.5 h-3.5", color)} />
                <span className="text-lg font-bold text-ink">{value}</span>
            </div>
            <span className="text-[10px] text-ink-muted uppercase tracking-wide">{label}</span>
        </div>
    )
}

function TabBtn({ active, icon: Icon, label, count, onClick }: {
    active: boolean
    icon: React.ComponentType<{ className?: string }>
    label: string
    count?: number
    onClick: () => void
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all",
                active
                    ? "bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20"
                    : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 border border-transparent"
            )}
        >
            <Icon className="w-3 h-3" />
            {label}
            {count !== undefined && count > 0 && (
                <span className={cn(
                    "ml-1 px-1.5 py-0.5 rounded-full text-[9px] font-bold",
                    active ? "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                )}>
                    {count}
                </span>
            )}
        </button>
    )
}

function DetailRow({ icon: Icon, label, children }: {
    icon: React.ComponentType<{ className?: string }>
    label: string
    children: React.ReactNode
}) {
    return (
        <div className="flex items-start gap-3">
            <div className="w-7 h-7 rounded-lg bg-black/[0.04] dark:bg-white/[0.06] flex items-center justify-center shrink-0 mt-0.5">
                <Icon className="h-3.5 w-3.5 text-ink-muted" />
            </div>
            <div className="min-w-0 flex-1">
                <span className="text-[10px] uppercase tracking-widest font-bold text-ink-muted block mb-0.5">{label}</span>
                <div className="text-sm font-medium text-ink">{children}</div>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────
// DataSourceDetailPanel (Drawer)
// ─────────────────────────────────────────────────────────────────────

export function DataSourceDetailPanel({
    ds,
    wsId,
    isOpen,
    stats,
    providerInfo,
    ontologyName,
    ontologyId,
    views,
    onEdit,
    onDelete,
    onExplore,
    onReaggregate,
    onPurge,
    onSaveAggregationConfig,
    onClose,
}: DataSourceDetailPanelProps) {
    const [activeTab, setActiveTab] = useState<'insights' | 'aggregation' | 'views'>('insights')
    const [purgeConfirm, setPurgeConfirm] = useState(false)
    const [purgeLoading, setPurgeLoading] = useState(false)

    // ── Aggregation tab: pending edits live entirely in local state until the
    //    user clicks Save. This avoids per-keystroke API calls and full-page
    //    reloads that would unmount this drawer mid-interaction.
    const originalMode = ds?.projectionMode ?? ''
    const originalDedicatedName = ds?.dedicatedGraphName ?? ''
    const [pendingMode, setPendingMode] = useState(originalMode)
    const [pendingDedicatedName, setPendingDedicatedName] = useState(originalDedicatedName)
    const [isSaving, setIsSaving] = useState(false)

    // Reset pending state whenever the drawer points at a different DS, or when
    // a reload has brought fresh server values (originals) for the same DS.
    useEffect(() => {
        setPendingMode(originalMode)
        setPendingDedicatedName(originalDedicatedName)
        setIsSaving(false)
    }, [ds?.id, originalMode, originalDedicatedName])

    const isDirty = pendingMode !== originalMode || pendingDedicatedName !== originalDedicatedName
    const isOverridden = !!pendingMode

    const handleSelectInherit = () => setPendingMode('')
    const handleSelectInSource = () => setPendingMode('in_source')
    const handleSelectDedicated = () => {
        setPendingMode('dedicated')
        if (!pendingDedicatedName && ds) {
            setPendingDedicatedName(`${ds.label || ds.catalogItemId}_aggregated`)
        }
    }

    const handleSaveConfig = async () => {
        if (!ds || !isDirty || isSaving) return
        setIsSaving(true)
        try {
            await onSaveAggregationConfig(
                { projectionMode: pendingMode, dedicatedGraphName: pendingDedicatedName },
                { projectionMode: originalMode, dedicatedGraphName: originalDedicatedName },
            )
            // The parent triggers a reload after save. The useEffect above will
            // resync pending state when the new originals arrive.
        } finally {
            setIsSaving(false)
        }
    }

    const handleDiscardConfig = () => {
        setPendingMode(originalMode)
        setPendingDedicatedName(originalDedicatedName)
    }

    const aggMeta = AGG_STATUS_META[ds?.aggregationStatus || 'none'] || AGG_STATUS_META.none

    const content = (
        <AnimatePresence>
            {isOpen && ds && (
                <>
                    {/* Backdrop */}
                    <motion.div
                        className="fixed inset-0 z-[60] bg-black/40"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        onClick={onClose}
                    />

                    {/* Drawer */}
                    <motion.aside
                        className={cn(
                            'fixed right-0 top-0 h-full w-[480px] max-w-[92vw] z-[61]',
                            'bg-canvas border-l border-glass-border',
                            'flex flex-col shadow-2xl',
                        )}
                        initial={{ x: 480 }}
                        animate={{ x: 0 }}
                        exit={{ x: 480 }}
                        transition={{ type: 'spring', damping: 30, stiffness: 300 }}
                    >
                        {/* ── Header ─────────────────────────────────────── */}
                        <div className="px-6 pt-6 pb-4 border-b border-glass-border/50 shrink-0">
                            <div className="flex items-start justify-between gap-3 mb-4">
                                <div className="flex items-center gap-3 min-w-0">
                                    <div className="w-10 h-10 rounded-xl bg-indigo-500/15 border border-indigo-500/20 flex items-center justify-center shrink-0">
                                        {providerInfo ? (
                                            (() => { const Logo = getProviderLogo(providerInfo.providerType); return <Logo className="w-5 h-5" /> })()
                                        ) : (
                                            <Database className="w-5 h-5 text-indigo-500" />
                                        )}
                                    </div>
                                    <div className="min-w-0">
                                        <div className="flex items-center gap-2">
                                            <h2 className="text-lg font-bold text-ink truncate">{ds.label || providerInfo?.catalogItemName || 'Unnamed'}</h2>
                                            {ds.isPrimary && (
                                                <span className="flex items-center gap-1 px-2 py-0.5 text-[9px] font-bold rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                                                    <Star className="w-2.5 h-2.5" /> Primary
                                                </span>
                                            )}
                                        </div>
                                        {providerInfo ? (
                                            <p className="text-[11px] text-ink-muted truncate">
                                                <span className="font-medium">{providerInfo.providerName}</span>
                                                {providerInfo.sourceIdentifier && <span className="font-mono"> / {providerInfo.sourceIdentifier}</span>}
                                            </p>
                                        ) : (
                                            <p className="text-[11px] text-ink-muted font-mono truncate">{ds.catalogItemId}</p>
                                        )}
                                    </div>
                                </div>
                                <button onClick={onClose} className="p-2 rounded-xl text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.06] transition-colors shrink-0">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>

                            {/* Status + meta badges */}
                            <div className="flex flex-wrap items-center gap-2 mb-4">
                                <span className={cn("flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-full border", aggMeta.text,
                                    ds.aggregationStatus === 'ready' ? 'bg-emerald-500/10 border-emerald-500/20' :
                                    ds.aggregationStatus === 'failed' ? 'bg-red-500/10 border-red-500/20' :
                                    ds.aggregationStatus === 'running' || ds.aggregationStatus === 'pending' ? 'bg-amber-500/10 border-amber-500/20' :
                                    'bg-black/5 dark:bg-white/5 border-glass-border'
                                )}>
                                    <span className={cn("w-2 h-2 rounded-full", aggMeta.dot)} />
                                    {aggMeta.label}
                                </span>
                                {ontologyName && (
                                    <Link
                                        to={ontologyId ? `/schema/${ontologyId}` : '/schema'}
                                        className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors"
                                    >
                                        <GitBranch className="w-3 h-3" /> {ontologyName}
                                    </Link>
                                )}
                                {ds.lastAggregatedAt && (
                                    <span className="flex items-center gap-1 text-[10px] text-ink-muted">
                                        <Clock className="w-3 h-3" /> Aggregated {new Date(ds.lastAggregatedAt).toLocaleDateString()}
                                    </span>
                                )}
                            </div>

                            {/* Quick action buttons */}
                            <div className="flex items-center gap-2">
                                <Link
                                    to={`/schema?workspaceId=${wsId}&dataSourceId=${ds.id}`}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors"
                                >
                                    <ExternalLink className="w-3 h-3" /> Schema Editor
                                </Link>
                                <Link
                                    to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-[11px] font-semibold text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
                                >
                                    <Compass className="w-3 h-3" /> Explorer
                                </Link>
                                <button onClick={onEdit} className="p-2 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Edit">
                                    <Edit2 className="w-3.5 h-3.5" />
                                </button>
                                {onDelete && (
                                    <button onClick={onDelete} className="p-2 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors" title="Remove">
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* ── Tab Bar ────────────────────────────────────── */}
                        <div className="px-6 pt-3 pb-2 flex items-center gap-1.5 shrink-0 border-b border-glass-border/30">
                            <TabBtn active={activeTab === 'insights'} icon={BarChart3} label="Insights" onClick={() => setActiveTab('insights')} />
                            <TabBtn active={activeTab === 'aggregation'} icon={Settings2} label="Aggregation" onClick={() => setActiveTab('aggregation')} />
                            <TabBtn active={activeTab === 'views'} icon={Eye} label="Views" count={views.length} onClick={() => setActiveTab('views')} />
                        </div>

                        {/* ── Tab Content (scrollable) ───────────────────── */}
                        <div className="flex-1 overflow-y-auto custom-scrollbar px-6 py-5">
                            {/* ─── Insights Tab ─────────────────────────── */}
                            {activeTab === 'insights' && (
                                <div className="space-y-5">
                                    {stats ? (
                                        <>
                                            <div className="flex gap-3">
                                                <MiniKpi icon={CircleDot} value={compactNum(stats.nodeCount)} label="Nodes" color="text-indigo-500" />
                                                <MiniKpi icon={ArrowRightLeft} value={compactNum(stats.edgeCount)} label="Edges" color="text-violet-500" />
                                                <MiniKpi icon={Layers} value={stats.entityTypes.length} label="Entity Types" color="text-emerald-500" />
                                            </div>

                                            {/* Key details */}
                                            <div className="space-y-3">
                                                <DetailRow icon={Database} label="Catalog Item">
                                                    <span className="font-mono text-xs">{ds.catalogItemId}</span>
                                                </DetailRow>
                                                {ontologyName && (
                                                    <DetailRow icon={GitBranch} label="Ontology">
                                                        <Link to={ontologyId ? `/schema/${ontologyId}` : '/schema'} className="text-indigo-500 hover:underline">
                                                            {ontologyName}
                                                        </Link>
                                                    </DetailRow>
                                                )}
                                                <DetailRow icon={Clock} label="Updated">
                                                    {new Date(ds.updatedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                                                </DetailRow>
                                            </div>

                                            {stats.entityTypes.length > 0 && (
                                                <div>
                                                    <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Entity Type Breakdown</h6>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {stats.entityTypes.sort().map(type => (
                                                            <span key={type} className="px-2.5 py-1 text-[11px] font-medium rounded-lg bg-black/5 dark:bg-white/5 text-ink-secondary border border-glass-border hover:bg-indigo-500/5 hover:border-indigo-500/20 hover:text-indigo-600 dark:hover:text-indigo-400 transition-colors cursor-default">
                                                                {type}
                                                            </span>
                                                        ))}
                                                    </div>
                                                </div>
                                            )}

                                            {(stats.nodeCount > 0 || stats.edgeCount > 0) && (
                                                <div>
                                                    <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Node / Edge Ratio</h6>
                                                    <div className="flex h-2 rounded-full overflow-hidden bg-black/5 dark:bg-white/5">
                                                        <div className="bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-l-full" style={{ width: `${Math.round(stats.nodeCount / (stats.nodeCount + stats.edgeCount) * 100)}%` }} />
                                                        <div className="bg-gradient-to-r from-violet-500 to-violet-400 rounded-r-full" style={{ width: `${Math.round(stats.edgeCount / (stats.nodeCount + stats.edgeCount) * 100)}%` }} />
                                                    </div>
                                                    <div className="flex justify-between mt-1 text-[10px] text-ink-muted">
                                                        <span>Nodes: {Math.round(stats.nodeCount / (stats.nodeCount + stats.edgeCount) * 100)}%</span>
                                                        <span>Edges: {Math.round(stats.edgeCount / (stats.nodeCount + stats.edgeCount) * 100)}%</span>
                                                    </div>
                                                </div>
                                            )}
                                        </>
                                    ) : (
                                        <div className="py-6 text-center text-xs text-ink-muted">
                                            <BarChart3 className="w-8 h-8 mx-auto mb-2 opacity-30" />
                                            No statistics available for this data source
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* ─── Aggregation Tab ──────────────────────── */}
                            {activeTab === 'aggregation' && (
                                <div className="space-y-3">
                                    <div className="flex items-center justify-between">
                                        <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">
                                            Projection Mode
                                        </h6>
                                        {isDirty && (
                                            <span className="flex items-center gap-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                                <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                                                Unsaved
                                            </span>
                                        )}
                                    </div>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === '' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === ''}
                                            onChange={handleSelectInherit} className="mt-1 accent-indigo-500" />
                                        <div>
                                            <span className="text-sm font-medium text-ink">Inherit from Provider</span>
                                            <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-500/10 text-emerald-500">DEFAULT</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Uses the provider's default projection mode</p>
                                        </div>
                                    </label>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === 'in_source' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === 'in_source'}
                                            onChange={handleSelectInSource} className="mt-1 accent-indigo-500" />
                                        <div>
                                            <span className="text-sm font-medium text-ink">In Source</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Store aggregated edges in the same graph</p>
                                        </div>
                                    </label>

                                    <label className={cn(
                                        "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors",
                                        pendingMode === 'dedicated' ? "border-indigo-500/40 bg-indigo-500/[0.04]" : "border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    )}>
                                        <input type="radio" name={`proj-${ds.id}`} checked={pendingMode === 'dedicated'}
                                            onChange={handleSelectDedicated} className="mt-1 accent-indigo-500" />
                                        <div className="flex-1">
                                            <span className="text-sm font-medium text-ink">Dedicated Graph</span>
                                            <p className="text-xs text-ink-muted mt-0.5">Store in a separate projection graph for isolation</p>
                                            {pendingMode === 'dedicated' && (
                                                <div className="mt-3 animate-in slide-in-from-top-2 fade-in duration-200">
                                                    <label className="block text-[11px] font-medium text-ink-secondary mb-1">Dedicated Graph Name</label>
                                                    <input type="text" value={pendingDedicatedName}
                                                        onChange={e => setPendingDedicatedName(e.target.value)}
                                                        placeholder={`e.g. ${ds.label || ds.catalogItemId}_aggregated`}
                                                        onClick={e => e.stopPropagation()}
                                                        className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50" />
                                                </div>
                                            )}
                                        </div>
                                    </label>

                                    {isOverridden && !isDirty && (
                                        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
                                            <span className="font-semibold">&#x26A0; Override active</span>
                                            <span>— This data source is not using the provider default.</span>
                                        </div>
                                    )}

                                    {/* Save / Discard bar — sticky feel, only when dirty */}
                                    {isDirty && (
                                        <div className="flex items-center justify-end gap-2 p-3 rounded-lg bg-amber-500/[0.06] border border-amber-500/20 animate-in slide-in-from-top-1 fade-in duration-150">
                                            <button
                                                onClick={handleDiscardConfig}
                                                disabled={isSaving}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                            >
                                                <RotateCcw className="w-3 h-3" /> Discard
                                            </button>
                                            <button
                                                onClick={handleSaveConfig}
                                                disabled={isSaving || (pendingMode === 'dedicated' && !pendingDedicatedName.trim())}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500 text-white hover:bg-indigo-600 transition-colors disabled:opacity-50 shadow-sm"
                                            >
                                                {isSaving
                                                    ? <Loader2 className="w-3 h-3 animate-spin" />
                                                    : <Save className="w-3 h-3" />}
                                                {isSaving ? 'Saving…' : 'Save Changes'}
                                            </button>
                                        </div>
                                    )}

                                    <div className="mt-4 pt-4 border-t border-glass-border space-y-2">
                                        <button onClick={onReaggregate} disabled={isDirty}
                                            title={isDirty ? 'Save your config changes before re-triggering aggregation.' : undefined}
                                            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-semibold text-sm hover:bg-indigo-500/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                                            <Settings2 className="w-4 h-4" /> Re-Trigger Aggregation
                                        </button>

                                        {ds.aggregationStatus === 'ready' && (
                                            !purgeConfirm ? (
                                                <button onClick={() => setPurgeConfirm(true)}
                                                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors">
                                                    <Trash2 className="w-4 h-4" /> Purge Aggregated Edges
                                                </button>
                                            ) : (
                                                <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5 space-y-2.5">
                                                    <div className="flex items-start gap-2">
                                                        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                                        <p className="text-xs text-red-400 leading-relaxed">
                                                            This will remove all materialized aggregated edges and reset aggregation status. This cannot be undone.
                                                        </p>
                                                    </div>
                                                    <div className="flex justify-end gap-2">
                                                        <button onClick={() => setPurgeConfirm(false)} disabled={purgeLoading}
                                                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors">Cancel</button>
                                                        <button onClick={async () => { setPurgeLoading(true); try { await onPurge() } finally { setPurgeLoading(false); setPurgeConfirm(false) } }}
                                                            disabled={purgeLoading}
                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50 shadow-sm shadow-red-500/25">
                                                            {purgeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />} Confirm Purge
                                                        </button>
                                                    </div>
                                                </div>
                                            )
                                        )}
                                    </div>

                                    <div className="mt-6 pt-4 border-t border-glass-border">
                                        <AggregationHistory dataSourceId={ds.id} />
                                    </div>
                                </div>
                            )}

                            {/* ─── Views Tab ────────────────────────────── */}
                            {activeTab === 'views' && (
                                <div>
                                    <div className="flex items-center justify-between mb-3">
                                        <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Associated Views</h6>
                                        <Link to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                                            <Plus className="w-3 h-3" /> Create View
                                        </Link>
                                    </div>

                                    {views.length > 0 ? (
                                        <div className="space-y-2">
                                            {views.map(view => (
                                                <Link key={view.id} to={`/views/${view.id}`}
                                                    className="flex items-center justify-between p-3 rounded-lg border border-glass-border hover:border-indigo-500/20 hover:bg-indigo-500/[0.02] transition-all group/view">
                                                    <div className="flex items-center gap-3 min-w-0">
                                                        <div className="w-7 h-7 rounded-lg bg-cyan-500/10 text-cyan-500 flex items-center justify-center shrink-0">
                                                            <Eye className="w-3.5 h-3.5" />
                                                        </div>
                                                        <div className="min-w-0">
                                                            <span className="text-sm font-medium text-ink truncate block">{view.name}</span>
                                                            {view.description && <span className="text-[10px] text-ink-muted truncate block">{view.description}</span>}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-2 shrink-0">
                                                        {view.layoutType && <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-black/5 dark:bg-white/5 text-ink-muted">{view.layoutType}</span>}
                                                        <ExternalLink className="w-3 h-3 text-ink-muted opacity-0 group-hover/view:opacity-100 transition-opacity" />
                                                    </div>
                                                </Link>
                                            ))}
                                        </div>
                                    ) : (
                                        <div className="py-8 text-center bg-black/[0.02] dark:bg-white/[0.02] rounded-xl border border-glass-border border-dashed">
                                            <Eye className="w-8 h-8 mx-auto mb-3 opacity-30 text-indigo-500" />
                                            <div className="text-sm font-semibold text-ink mb-1">No views yet</div>
                                            <div className="text-xs text-ink-muted mb-3">Views scoped to this data source will appear here.</div>
                                            <Link to={`/explorer?workspace=${wsId}&dataSource=${ds.id}`}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-semibold hover:bg-indigo-600 transition-colors">
                                                <Compass className="w-3 h-3" /> Open Explorer
                                            </Link>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* ── Footer actions ─────────────────────────────── */}
                        <div className="px-6 py-4 border-t border-glass-border/50 shrink-0 space-y-2">
                            <button onClick={() => { onExplore(); onClose() }}
                                className={cn(
                                    'w-full inline-flex items-center justify-center gap-2 rounded-xl px-4 py-3',
                                    'bg-gradient-to-r from-accent-lineage to-violet-600 text-white text-sm font-semibold',
                                    'shadow-lg shadow-accent-lineage/25 hover:shadow-xl hover:-translate-y-0.5',
                                    'transition-[transform,box-shadow] duration-200',
                                )}>
                                <ExternalLink className="w-4 h-4" /> Open in Schema Editor
                            </button>
                        </div>
                    </motion.aside>
                </>
            )}
        </AnimatePresence>
    )

    return createPortal(content, document.body)
}
