/**
 * DataSourceCard — compact summary card for a data source.
 * Detailed panel (Insights / Aggregation / Views tabs) lives in DataSourceDetailPanel.
 */
import {
    Database, Layers, GitBranch, Star, Clock, CircleDot, ArrowRightLeft,
    Edit2, Trash2, ExternalLink, Eye,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export interface DataSourceView {
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
    onEdit?: () => void
    onDelete?: () => void
    onSelect?: () => void
    onExplore?: () => void
    onReaggregate?: () => void
}

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
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
    onEdit,
    onDelete,
    onSelect,
    onExplore,
}: DataSourceCardProps) {
    const isOverridden = !!ds.projectionMode

    return (
        <div
            className={cn(
                "border rounded-xl transition-all duration-200 group/card",
                isActive
                    ? "border-indigo-500/30 bg-indigo-500/[0.03] dark:bg-indigo-500/[0.05] shadow-sm"
                    : "border-glass-border bg-canvas-elevated hover:border-indigo-500/20 hover:shadow-sm"
            )}
        >
            <div className="p-4">
                {/* ── Header ─────────────────────────────────────────── */}
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

                {/* ── Entity pills ────────────────────────────────── */}
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

                {/* ── Footer: metadata + explore ─────────────────── */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 text-xs text-ink-muted">
                        {ontologyName && <span className="flex items-center gap-1"><GitBranch className="w-3 h-3" />{ontologyName}</span>}
                        {ds.updatedAt && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{new Date(ds.updatedAt).toLocaleDateString()}</span>}
                        {isOverridden && <span className="px-1.5 py-0.5 text-[9px] font-bold rounded bg-amber-500/10 text-amber-500 border border-amber-500/20">OVERRIDE</span>}
                    </div>
                    {onExplore && (
                        <button onClick={onExplore} className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-indigo-500 hover:bg-indigo-500/10 transition-colors opacity-0 group-hover/card:opacity-100">
                            Explore <ExternalLink className="w-3 h-3" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    )
}
