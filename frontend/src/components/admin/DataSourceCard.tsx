/**
 * DataSourceCard — rich card with stats overview and 3-tab expanded detail panel.
 * Tabs: Insights · Aggregation · Views
 */
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
    Database, Layers, GitBranch, ChevronDown, ChevronUp,
    Star, Clock, CircleDot, ArrowRightLeft, BarChart3,
    Settings2, Eye, Edit2, Trash2, ExternalLink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

interface DataSourceView {
    id: string
    name: string
    description?: string
    layout?: { type?: string }
    isDefault?: boolean
    scopeKey?: string | null
}

interface DataSourceCardProps {
    ds: DataSourceResponse
    stats?: DataSourceStats
    providerName?: string
    ontologyName?: string
    isActive?: boolean
    views?: DataSourceView[]
    onSetPrimary?: () => void
    onProjectionModeChange?: (mode: string) => void
    onDedicatedGraphNameChange?: (name: string) => void
    onEdit?: () => void
    onDelete?: () => void
    onSelect?: () => void
    onExplore?: () => void
}

type DetailTab = 'insights' | 'aggregation' | 'views'

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

// ─────────────────────────────────────────────────────────────────────
// Mini KPI Card (inside Insights tab)
// ─────────────────────────────────────────────────────────────────────

function MiniKpi({ icon: Icon, value, label, color }: {
    icon: React.ComponentType<{ className?: string }>
    value: string | number
    label: string
    color: string
}) {
    return (
        <div className={cn("flex-1 p-3 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02]")}>
            <div className="flex items-center gap-2 mb-1">
                <Icon className={cn("w-3.5 h-3.5", color)} />
                <span className="text-lg font-bold text-ink">{value}</span>
            </div>
            <span className="text-[10px] text-ink-muted uppercase tracking-wide">{label}</span>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────
// Tab Button
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
// DataSourceCard
// ─────────────────────────────────────────────────────────────────────

export function DataSourceCard({
    ds,
    stats,
    providerName,
    ontologyName,
    isActive,
    views = [],
    onSetPrimary,
    onProjectionModeChange,
    onDedicatedGraphNameChange,
    onEdit,
    onDelete,
    onSelect,
    onExplore,
}: DataSourceCardProps) {
    const navigate = useNavigate()
    const [expanded, setExpanded] = useState(false)
    const [activeTab, setActiveTab] = useState<DetailTab>('insights')
    const [localDedicatedName, setLocalDedicatedName] = useState(ds.dedicatedGraphName || '')

    const effectiveMode = ds.projectionMode || 'in_source'
    const isOverridden = !!ds.projectionMode

    const handleDedicatedModeSelect = () => {
        onProjectionModeChange?.('dedicated')
        if (!localDedicatedName) {
            const suggestion = `${ds.label || ds.catalogItemId}_aggregated`
            setLocalDedicatedName(suggestion)
            onDedicatedGraphNameChange?.(suggestion)
        }
    }

    const handleDedicatedNameChange = (name: string) => {
        setLocalDedicatedName(name)
        onDedicatedGraphNameChange?.(name)
    }

    return (
        <div
            className={cn(
                "border rounded-xl transition-all duration-200 group/card",
                isActive
                    ? "border-indigo-500/30 bg-indigo-500/[0.03] dark:bg-indigo-500/[0.05] shadow-sm"
                    : "border-glass-border bg-canvas-elevated hover:border-indigo-500/20 hover:shadow-sm"
            )}
        >
            {/* ── Header ─────────────────────────────────────────── */}
            <div className="p-4">
                <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3 cursor-pointer min-w-0" onClick={onSelect}>
                        <div className={cn(
                            "w-9 h-9 rounded-lg flex items-center justify-center shrink-0",
                            isActive ? "bg-indigo-500/15 text-indigo-500" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                        )}>
                            <Database className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                            <h4 className="text-sm font-bold text-ink truncate">{ds.label || providerName || 'Unnamed'}</h4>
                            <p className="text-[11px] text-ink-muted truncate border border-glass-border px-1.5 py-0.5 rounded max-w-max bg-black/5 dark:bg-white/5 mt-0.5">
                                {ds.catalogItemId}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                        {ds.isPrimary && (
                            <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                <Star className="w-3 h-3" />
                                Primary
                            </span>
                        )}
                        {!ds.isPrimary && onSetPrimary && (
                            <button onClick={onSetPrimary} className="px-2 py-0.5 text-[10px] font-medium rounded-full text-ink-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors">
                                Set Primary
                            </button>
                        )}
                        {/* Action buttons on hover */}
                        {onEdit && (
                            <button onClick={onEdit} className="p-1 rounded-lg text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 opacity-0 group-hover/card:opacity-100 transition-all" title="Edit">
                                <Edit2 className="w-3 h-3" />
                            </button>
                        )}
                        {onDelete && (
                            <button onClick={onDelete} className="p-1 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 opacity-0 group-hover/card:opacity-100 transition-all" title="Delete">
                                <Trash2 className="w-3 h-3" />
                            </button>
                        )}
                    </div>
                </div>

                {/* ── Stats Row ────────────────────────────────────── */}
                {stats && (
                    <div className="flex items-center gap-4 mb-3">
                        <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                            <CircleDot className="w-3 h-3 text-indigo-500" />
                            <span className="font-semibold">{compactNum(stats.nodeCount)}</span>
                            <span className="text-ink-muted">nodes</span>
                        </div>
                        <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                            <ArrowRightLeft className="w-3 h-3 text-violet-500" />
                            <span className="font-semibold">{compactNum(stats.edgeCount)}</span>
                            <span className="text-ink-muted">edges</span>
                        </div>
                        {stats.entityTypes.length > 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                                <Layers className="w-3 h-3 text-emerald-500" />
                                <span className="font-semibold">{stats.entityTypes.length}</span>
                                <span className="text-ink-muted">types</span>
                            </div>
                        )}
                        {views.length > 0 && (
                            <div className="flex items-center gap-1.5 text-xs text-ink-secondary">
                                <Eye className="w-3 h-3 text-cyan-500" />
                                <span className="font-semibold">{views.length}</span>
                                <span className="text-ink-muted">views</span>
                            </div>
                        )}
                    </div>
                )}

                {/* ── Entity pills + meta footer ───────────────────── */}
                {stats && stats.entityTypes.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mb-3">
                        {stats.entityTypes.slice(0, 6).map(type => (
                            <span key={type} className="px-2 py-0.5 text-[10px] font-medium rounded-full bg-black/5 dark:bg-white/5 text-ink-secondary border border-glass-border">
                                {type}
                            </span>
                        ))}
                        {stats.entityTypes.length > 6 && (
                            <span className="px-2 py-0.5 text-[10px] font-medium rounded-full text-ink-muted">+{stats.entityTypes.length - 6}</span>
                        )}
                    </div>
                )}

                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs text-ink-muted">
                        {ontologyName && <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{ontologyName}</span>}
                        {ds.updatedAt && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{new Date(ds.updatedAt).toLocaleDateString()}</span>}
                        {isOverridden && <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">OVERRIDE</span>}
                    </div>
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className={cn(
                            "p-1.5 rounded-lg transition-all",
                            expanded ? "bg-indigo-500/10 text-indigo-500" : "hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted"
                        )}
                    >
                        {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                    </button>
                </div>
            </div>

            {/* ── Expanded Tabbed Detail Panel ────────────────────── */}
            {expanded && (
                <div className="border-t border-glass-border animate-in slide-in-from-top-2 fade-in duration-200">
                    {/* Tab Bar */}
                    <div className="px-4 pt-3 pb-2 flex items-center gap-1.5">
                        <TabBtn active={activeTab === 'insights'} icon={BarChart3} label="Insights" onClick={() => setActiveTab('insights')} />
                        <TabBtn active={activeTab === 'aggregation'} icon={Settings2} label="Aggregation" onClick={() => setActiveTab('aggregation')} />
                        <TabBtn active={activeTab === 'views'} icon={Eye} label="Views" count={views.length} onClick={() => setActiveTab('views')} />
                    </div>

                    {/* ─── Insights Tab ─────────────────────────────── */}
                    {activeTab === 'insights' && (
                        <div className="px-4 pb-4 space-y-4">
                            {stats ? (
                                <>
                                    {/* KPI row */}
                                    <div className="flex gap-3">
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

                                    {/* Ratio bar */}
                                    {(stats.nodeCount > 0 || stats.edgeCount > 0) && (
                                        <div>
                                            <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider mb-2">Node / Edge Ratio</h6>
                                            <div className="flex h-2 rounded-full overflow-hidden bg-black/5 dark:bg-white/5">
                                                <div
                                                    className="bg-gradient-to-r from-indigo-500 to-indigo-400 rounded-l-full transition-all"
                                                    style={{ width: `${Math.round(stats.nodeCount / (stats.nodeCount + stats.edgeCount) * 100)}%` }}
                                                />
                                                <div
                                                    className="bg-gradient-to-r from-violet-500 to-violet-400 rounded-r-full transition-all"
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
                        <div className="px-4 pb-4 space-y-3">
                            {/* Inherit */}
                            <label className="flex items-start gap-3 p-3 rounded-lg border border-glass-border cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                                <input type="radio" name={`proj-${ds.id}`} checked={effectiveMode === 'in_source' && !isOverridden}
                                    onChange={() => onProjectionModeChange?.('')} className="mt-1 accent-indigo-500" />
                                <div>
                                    <span className="text-sm font-medium text-ink">Inherit from Provider</span>
                                    <span className="inline-flex items-center gap-1 ml-2 px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-500/10 text-emerald-500">DEFAULT</span>
                                    <p className="text-xs text-ink-muted mt-0.5">Uses the provider's default projection mode</p>
                                </div>
                            </label>

                            {/* In-Source */}
                            <label className="flex items-start gap-3 p-3 rounded-lg border border-glass-border cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors">
                                <input type="radio" name={`proj-${ds.id}`} checked={effectiveMode === 'in_source' && isOverridden}
                                    onChange={() => onProjectionModeChange?.('in_source')} className="mt-1 accent-indigo-500" />
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

                                    {/* ─ Dedicated graph name input (animated) ─ */}
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

                            {isOverridden && (
                                <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-xs text-amber-600 dark:text-amber-400">
                                    <span className="font-semibold">⚠ Override active</span>
                                    <span>— This data source is not using the provider default.</span>
                                </div>
                            )}
                        </div>
                    )}

                    {/* ─── Views Tab ────────────────────────────────── */}
                    {activeTab === 'views' && (
                        <div className="px-4 pb-4">
                            <div className="flex items-center justify-between mb-3">
                                <h6 className="text-[10px] font-semibold text-ink-muted uppercase tracking-wider">Associated Views</h6>
                                {onExplore && (
                                    <button onClick={onExplore} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-indigo-500 text-white text-[11px] font-semibold hover:bg-indigo-600 transition-colors shadow-sm">
                                        <ArrowRightLeft className="w-3 h-3" /> Explore & Create View
                                    </button>
                                )}
                            </div>

                            {views.length > 0 ? (
                                <div className="space-y-2">
                                    {views.map(view => (
                                        <button
                                            key={view.id}
                                            onClick={() => navigate(`/views/${view.id}`)}
                                            className="w-full flex items-center justify-between p-3 rounded-lg border border-glass-border hover:border-indigo-500/20 hover:bg-indigo-500/[0.02] dark:hover:bg-indigo-500/[0.03] transition-all text-left group/view"
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
                                                {view.isDefault && (
                                                    <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-cyan-500/10 text-cyan-500">PINNED</span>
                                                )}
                                                {view.layout?.type && (
                                                    <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-black/5 dark:bg-white/5 text-ink-muted">{view.layout.type}</span>
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
                                    <div className="text-xs text-ink-muted max-w-[250px] mx-auto">
                                        Views scoped to this workspace and data source will appear here.
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
