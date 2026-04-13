/**
 * DataSourceDetailPanel — full-width detail panel that appears below the
 * data source grid when a source is selected.
 * Tabs: Insights · Aggregation · Views
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Database, Edit2, Trash2, X, ExternalLink, Settings2, Plus, Eye,
    CircleDot, ArrowRightLeft, Layers, BarChart3, AlertTriangle, Loader2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import type { View } from '@/services/viewApiService'
import { AggregationHistory } from '../AggregationHistory'

// ─────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────

interface DataSourceDetailPanelProps {
    ds: DataSourceResponse
    wsId: string
    stats?: DataSourceStats
    ontologyName?: string
    views: View[]
    onEdit: () => void
    onDelete?: () => void
    onExplore: () => void
    onReaggregate: () => void
    onPurge: () => Promise<void>
    onSetPrimary: () => void
    onProjectionModeChange: (mode: string) => void
    onDedicatedGraphNameChange: (name: string) => void
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

// ─────────────────────────────────────────────────────────────────────
// MiniKpi
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

// ─────────────────────────────────────────────────────────────────────
// TabBtn
// ─────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────
// DataSourceDetailPanel
// ─────────────────────────────────────────────────────────────────────

export function DataSourceDetailPanel({
    ds,
    wsId: _wsId,
    stats,
    ontologyName: _ontologyName,
    views,
    onEdit,
    onDelete,
    onExplore,
    onReaggregate,
    onPurge,
    onSetPrimary: _onSetPrimary,
    onProjectionModeChange,
    onDedicatedGraphNameChange,
    onClose,
}: DataSourceDetailPanelProps) {
    const navigate = useNavigate()
    const [activeTab, setActiveTab] = useState<'insights' | 'aggregation' | 'views'>('insights')
    const [localDedicatedName, setLocalDedicatedName] = useState(ds.dedicatedGraphName || '')
    const [purgeConfirm, setPurgeConfirm] = useState(false)
    const [purgeLoading, setPurgeLoading] = useState(false)

    const effectiveMode = ds.projectionMode || 'in_source'
    const isOverridden = !!ds.projectionMode

    const handleDedicatedModeSelect = () => {
        onProjectionModeChange('dedicated')
        if (!localDedicatedName) {
            const suggestion = `${ds.label || ds.catalogItemId}_aggregated`
            setLocalDedicatedName(suggestion)
            onDedicatedGraphNameChange(suggestion)
        }
    }

    const handleDedicatedNameChange = (name: string) => {
        setLocalDedicatedName(name)
        onDedicatedGraphNameChange(name)
    }

    return (
        <div className="mt-4 rounded-2xl border border-indigo-500/20 bg-canvas-elevated overflow-hidden animate-in slide-in-from-top-2 fade-in duration-200">
            {/* ── Header ─────────────────────────────────────────── */}
            <div className="px-5 py-4 border-b border-glass-border flex items-center justify-between">
                <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-indigo-500/15 text-indigo-500 flex items-center justify-center">
                        <Database className="w-4 h-4" />
                    </div>
                    <div>
                        <h4 className="text-sm font-bold text-ink">{ds.label || 'Unnamed'}</h4>
                        <p className="text-[10px] text-ink-muted font-mono">{ds.catalogItemId}</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button onClick={onExplore} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors">
                        <ExternalLink className="w-3 h-3" /> Explore
                    </button>
                    <button onClick={onEdit} className="p-1.5 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors" title="Edit">
                        <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={onReaggregate} className="p-1.5 rounded-lg text-ink-muted hover:text-emerald-500 hover:bg-emerald-500/10 transition-colors" title="Re-aggregate">
                        <Settings2 className="w-3.5 h-3.5" />
                    </button>
                    {onDelete && (
                        <button onClick={onDelete} className="p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors" title="Delete">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    )}
                    <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors" title="Close">
                        <X className="w-3.5 h-3.5" />
                    </button>
                </div>
            </div>

            {/* ── Tab Bar ────────────────────────────────────────── */}
            <div className="px-5 pt-3 pb-2 flex items-center gap-1.5">
                <TabBtn active={activeTab === 'insights'} icon={BarChart3} label="Insights" onClick={() => setActiveTab('insights')} />
                <TabBtn active={activeTab === 'aggregation'} icon={Settings2} label="Aggregation" onClick={() => setActiveTab('aggregation')} />
                <TabBtn active={activeTab === 'views'} icon={Eye} label="Views" count={views.length} onClick={() => setActiveTab('views')} />
            </div>

            {/* ── Tab Content ────────────────────────────────────── */}
            <div className="px-5 pb-5">
                {/* ─── Insights Tab ─────────────────────────────── */}
                {activeTab === 'insights' && (
                    <div className="space-y-4">
                        {stats ? (
                            <>
                                {/* KPI row */}
                                <div className="flex gap-3 mb-4">
                                    <MiniKpi icon={CircleDot} value={compactNum(stats.nodeCount)} label="Nodes" color="text-indigo-500" />
                                    <MiniKpi icon={ArrowRightLeft} value={compactNum(stats.edgeCount)} label="Edges" color="text-violet-500" />
                                    <MiniKpi icon={Layers} value={stats.entityTypes.length} label="Entity Types" color="text-emerald-500" />
                                </div>

                                {/* Entity type breakdown */}
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

                                {/* Node/edge ratio bar */}
                                {(stats.nodeCount > 0 || stats.edgeCount > 0) && (
                                    <div className="mt-4">
                                        <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Node / Edge Ratio</h6>
                                        <div className="flex h-2 rounded-full overflow-hidden bg-black/5 dark:bg-white/5">
                                            <div
                                                className="bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-l-full"
                                                style={{ width: `${Math.round(stats.nodeCount / (stats.nodeCount + stats.edgeCount) * 100)}%` }}
                                            />
                                            <div
                                                className="bg-gradient-to-r from-violet-500 to-violet-400 rounded-r-full"
                                                style={{ width: `${Math.round(stats.edgeCount / (stats.nodeCount + stats.edgeCount) * 100)}%` }}
                                            />
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

                {/* ─── Aggregation Tab ──────────────────────────── */}
                {activeTab === 'aggregation' && (
                    <div className="space-y-3">
                        {/* Inherit from Provider */}
                        <label className="flex items-start gap-3 p-3 rounded-lg border border-glass-border cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                            <input type="radio" name={`proj-${ds.id}`} checked={effectiveMode === 'in_source' && !isOverridden}
                                onChange={() => onProjectionModeChange('')} className="mt-1 accent-indigo-500" />
                            <div>
                                <span className="text-sm font-medium text-ink">Inherit from Provider</span>
                                <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-500/10 text-emerald-500">DEFAULT</span>
                                <p className="text-xs text-ink-muted mt-0.5">Uses the provider's default projection mode</p>
                            </div>
                        </label>

                        {/* In Source */}
                        <label className="flex items-start gap-3 p-3 rounded-lg border border-glass-border cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                            <input type="radio" name={`proj-${ds.id}`} checked={effectiveMode === 'in_source' && isOverridden}
                                onChange={() => onProjectionModeChange('in_source')} className="mt-1 accent-indigo-500" />
                            <div>
                                <span className="text-sm font-medium text-ink">In Source</span>
                                <p className="text-xs text-ink-muted mt-0.5">Store aggregated edges in the same graph</p>
                            </div>
                        </label>

                        {/* Dedicated Graph */}
                        <label className="flex items-start gap-3 p-3 rounded-lg border border-glass-border cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                            <input type="radio" name={`proj-${ds.id}`} checked={effectiveMode === 'dedicated'}
                                onChange={handleDedicatedModeSelect} className="mt-1 accent-indigo-500" />
                            <div className="flex-1">
                                <span className="text-sm font-medium text-ink">Dedicated Graph</span>
                                <p className="text-xs text-ink-muted mt-0.5">Store in a separate projection graph for isolation</p>

                                {effectiveMode === 'dedicated' && (
                                    <div className="mt-3 animate-in slide-in-from-top-2 fade-in duration-200">
                                        <label className="block text-[11px] font-medium text-ink-secondary mb-1">Dedicated Graph Name</label>
                                        <input
                                            type="text"
                                            value={localDedicatedName}
                                            onChange={e => handleDedicatedNameChange(e.target.value)}
                                            placeholder={`e.g. ${ds.label || ds.catalogItemId}_aggregated`}
                                            onClick={e => e.stopPropagation()}
                                            className="w-full px-3 py-2 rounded-lg bg-black/5 dark:bg-white/5 border border-glass-border text-sm text-ink placeholder:text-ink-muted focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50"
                                        />
                                        <p className="text-[10px] text-ink-muted mt-1">This graph will store aggregated lineage edges separately from the source data.</p>
                                    </div>
                                )}
                            </div>
                        </label>

                        {/* Override warning */}
                        {isOverridden && (
                            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
                                <span className="font-semibold">&#x26A0; Override active</span>
                                <span>— This data source is not using the provider default.</span>
                            </div>
                        )}

                        {/* Re-trigger & Purge buttons */}
                        <div className="mt-4 pt-4 border-t border-glass-border space-y-2">
                            <button
                                onClick={onReaggregate}
                                className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 font-semibold text-sm hover:bg-indigo-500/20 transition-colors"
                            >
                                <Settings2 className="w-4 h-4" />
                                Re-Trigger Aggregation
                            </button>

                            {ds.aggregationStatus === 'ready' && (
                                !purgeConfirm ? (
                                    <button
                                        onClick={() => setPurgeConfirm(true)}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors"
                                    >
                                        <Trash2 className="w-4 h-4" />
                                        Purge Aggregated Edges
                                    </button>
                                ) : (
                                    <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5 space-y-2.5">
                                        <div className="flex items-start gap-2">
                                            <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                            <p className="text-xs text-red-400 leading-relaxed">
                                                This will remove all materialized aggregated edges from the graph and reset aggregation status. This cannot be undone.
                                            </p>
                                        </div>
                                        <div className="flex justify-end gap-2">
                                            <button
                                                onClick={() => setPurgeConfirm(false)}
                                                disabled={purgeLoading}
                                                className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={async () => {
                                                    setPurgeLoading(true)
                                                    try { await onPurge() } finally {
                                                        setPurgeLoading(false)
                                                        setPurgeConfirm(false)
                                                    }
                                                }}
                                                disabled={purgeLoading}
                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50 shadow-sm shadow-red-500/25"
                                            >
                                                {purgeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                                Confirm Purge
                                            </button>
                                        </div>
                                    </div>
                                )
                            )}
                        </div>

                        {/* Aggregation history */}
                        <div className="mt-6 pt-4 border-t border-glass-border">
                            <AggregationHistory dataSourceId={ds.id} />
                        </div>
                    </div>
                )}

                {/* ─── Views Tab ────────────────────────────────── */}
                {activeTab === 'views' && (
                    <div>
                        <div className="flex items-center justify-between mb-3">
                            <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Associated Views</h6>
                            <button onClick={onExplore} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                                <Plus className="w-3 h-3" /> Create View
                            </button>
                        </div>

                        {views.length > 0 ? (
                            <div className="space-y-2">
                                {views.map(view => (
                                    <button
                                        key={view.id}
                                        onClick={() => navigate(`/views/${view.id}`)}
                                        className="w-full flex items-center justify-between p-3 rounded-lg border border-glass-border hover:border-indigo-500/20 hover:bg-indigo-500/[0.02] transition-all text-left group/view"
                                    >
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
                                            {view.layoutType && (
                                                <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-black/5 dark:bg-white/5 text-ink-muted">{view.layoutType}</span>
                                            )}
                                            <ExternalLink className="w-3 h-3 text-ink-muted opacity-0 group-hover/view:opacity-100 transition-opacity" />
                                        </div>
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="py-8 text-center bg-black/[0.02] dark:bg-white/[0.02] rounded-xl border border-glass-border border-dashed">
                                <Eye className="w-8 h-8 mx-auto mb-3 opacity-30 text-indigo-500" />
                                <div className="text-sm font-semibold text-ink mb-1">No views yet</div>
                                <div className="text-xs text-ink-muted">Views scoped to this data source will appear here.</div>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    )
}
