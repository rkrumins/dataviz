import { Database, Star, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

interface DataSourceGridCardProps {
    ds: DataSourceResponse
    stats?: DataSourceStats
    ontologyName?: string
    ontologyVersion?: number
    ontologyPublished?: boolean
    viewCount: number
    isSelected: boolean
    onSelect: () => void
    onSetPrimary?: () => void
}

function AggregationStatusBadge({ status }: { status: string }) {
    const configs: Record<string, { label: string; dot: string; text: string }> = {
        ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
        running: { label: 'Running', dot: 'bg-indigo-400 animate-pulse', text: 'text-indigo-600 dark:text-indigo-400' },
        pending: { label: 'Pending', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-600 dark:text-amber-400' },
        failed: { label: 'Failed', dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400' },
        skipped: { label: 'Skipped', dot: 'bg-gray-400', text: 'text-ink-muted' },
        none: { label: 'Not Started', dot: 'bg-gray-400', text: 'text-ink-muted' },
    }
    const cfg = configs[status] || configs.none
    return (
        <span className={cn('flex items-center gap-1.5 text-[11px] font-medium', cfg.text)}>
            <span className={cn('w-2 h-2 rounded-full', cfg.dot)} />
            {cfg.label}
        </span>
    )
}

export function DataSourceGridCard({
    ds,
    stats,
    ontologyName,
    ontologyVersion,
    ontologyPublished,
    viewCount,
    isSelected,
    onSelect,
    onSetPrimary,
}: DataSourceGridCardProps) {
    return (
        <div
            onClick={onSelect}
            className={cn(
                'border rounded-xl p-4 cursor-pointer transition-all duration-200 group',
                isSelected
                    ? 'border-indigo-500/40 bg-indigo-500/[0.03] dark:bg-indigo-500/[0.05] shadow-sm ring-1 ring-indigo-500/20'
                    : 'border-glass-border bg-canvas-elevated hover:border-indigo-500/20 hover:shadow-sm',
            )}
        >
            {/* Header */}
            <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3 min-w-0">
                    <div
                        className={cn(
                            'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                            ds.isPrimary
                                ? 'bg-indigo-500/15 text-indigo-500'
                                : 'bg-black/5 dark:bg-white/5 text-ink-muted',
                        )}
                    >
                        <Database className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                        <h4 className="text-sm font-bold text-ink truncate">
                            {ds.label || 'Unnamed Source'}
                        </h4>
                        <p className="text-[10px] text-ink-muted font-mono truncate">
                            {ds.catalogItemId}
                        </p>
                    </div>
                </div>
                {ds.isPrimary && (
                    <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                        <Star className="w-3 h-3" /> Primary
                    </span>
                )}
                {!ds.isPrimary && onSetPrimary && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onSetPrimary()
                        }}
                        className="px-2 py-0.5 text-[10px] font-medium rounded-full text-ink-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors opacity-0 group-hover:opacity-100"
                    >
                        Set Primary
                    </button>
                )}
            </div>

            {/* Status + Ontology */}
            <div className="flex items-center justify-between mb-3">
                <AggregationStatusBadge status={ds.aggregationStatus} />
                {ontologyName && (
                    <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                        <GitBranch className="w-3 h-3" />
                        {ontologyName} v{ontologyVersion}
                        {ontologyPublished ? (
                            <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-emerald-500/10 text-emerald-500">
                                PUB
                            </span>
                        ) : (
                            <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-amber-500/10 text-amber-500">
                                DRAFT
                            </span>
                        )}
                    </span>
                )}
            </div>

            {/* Stats */}
            <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="p-2 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center">
                    <div className="text-sm font-bold text-ink">
                        {stats ? compactNum(stats.nodeCount) : '\u2014'}
                    </div>
                    <div className="text-[9px] text-ink-muted uppercase tracking-wider">Nodes</div>
                </div>
                <div className="p-2 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center">
                    <div className="text-sm font-bold text-ink">
                        {stats ? compactNum(stats.edgeCount) : '\u2014'}
                    </div>
                    <div className="text-[9px] text-ink-muted uppercase tracking-wider">Edges</div>
                </div>
                <div className="p-2 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center">
                    <div className="text-sm font-bold text-ink">{viewCount}</div>
                    <div className="text-[9px] text-ink-muted uppercase tracking-wider">Views</div>
                </div>
            </div>

            {/* Footer */}
            <div className="flex items-center gap-3 text-[10px] text-ink-muted">
                <span>Updated {new Date(ds.updatedAt).toLocaleDateString()}</span>
                {ds.lastAggregatedAt && (
                    <span>
                        &middot; Aggregated{' '}
                        {new Date(ds.lastAggregatedAt).toLocaleDateString()}
                    </span>
                )}
            </div>
        </div>
    )
}
