import { useState, useMemo } from 'react'
import { Database, Settings2, Trash2, AlertTriangle, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceReadinessResponse } from '@/services/aggregationService'
import { AggregationHistory } from '../AggregationHistory'

interface WorkspaceAggregationDashboardProps {
    dataSources: DataSourceResponse[]
    readinessMap: Record<string, DataSourceReadinessResponse>
    onReaggregate: (ds: DataSourceResponse) => void
    onPurge: (ds: DataSourceResponse) => Promise<void>
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

function relativeTime(dateStr: string): string {
    const now = Date.now()
    const then = new Date(dateStr).getTime()
    const diffMs = now - then
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    const diffD = Math.floor(diffH / 24)
    return `${diffD}d ago`
}

const summaryBadgeStyles: Record<string, { bg: string; text: string; label: string }> = {
    ready: { bg: 'bg-emerald-500/10', text: 'text-emerald-600 dark:text-emerald-400', label: 'Ready' },
    running: { bg: 'bg-indigo-500/10', text: 'text-indigo-600 dark:text-indigo-400', label: 'Running' },
    pending: { bg: 'bg-amber-500/10', text: 'text-amber-600 dark:text-amber-400', label: 'Pending' },
    failed: { bg: 'bg-red-500/10', text: 'text-red-600 dark:text-red-400', label: 'Failed' },
    none: { bg: 'bg-gray-500/10', text: 'text-ink-muted', label: 'Not Started' },
    skipped: { bg: 'bg-gray-500/10', text: 'text-ink-muted', label: 'Skipped' },
}

export function WorkspaceAggregationDashboard({
    dataSources,
    readinessMap,
    onReaggregate,
    onPurge,
}: WorkspaceAggregationDashboardProps) {
    const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)
    const [purging, setPurging] = useState<string | null>(null)

    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = { ready: 0, running: 0, pending: 0, failed: 0, none: 0, skipped: 0 }
        dataSources.forEach(ds => { counts[ds.aggregationStatus] = (counts[ds.aggregationStatus] || 0) + 1 })
        return counts
    }, [dataSources])

    const handlePurge = async (ds: DataSourceResponse) => {
        setPurging(ds.id)
        try {
            await onPurge(ds)
        } finally {
            setPurging(null)
            setConfirmPurgeId(null)
        }
    }

    return (
        <div className="space-y-6">
            {/* Heading */}
            <h3 className="text-lg font-bold text-ink">Aggregation Overview</h3>

            {/* Summary bar */}
            <div className="flex flex-wrap items-center gap-2">
                {Object.entries(summaryBadgeStyles).map(([key, style]) => (
                    <span
                        key={key}
                        className={cn(
                            'px-2.5 py-1 text-xs font-semibold rounded-lg',
                            style.bg,
                            style.text,
                        )}
                    >
                        {statusCounts[key] || 0} {style.label}
                    </span>
                ))}
            </div>

            {/* Per-source cards */}
            <div className="space-y-4">
                {dataSources.map(ds => {
                    const readiness = readinessMap[ds.id]
                    const drift = readiness?.driftDetected ?? false

                    return (
                        <div
                            key={ds.id}
                            className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden"
                        >
                            {/* Card header */}
                            <div className="p-4 space-y-3">
                                {/* Row 1: label + status + last agg */}
                                <div className="flex items-center gap-3 flex-wrap">
                                    <div className="w-8 h-8 rounded-lg bg-black/5 dark:bg-white/5 flex items-center justify-center text-ink-muted shrink-0">
                                        <Database className="w-4 h-4" />
                                    </div>
                                    <span className="text-sm font-bold text-ink">
                                        {ds.label || 'Unnamed Source'}
                                    </span>
                                    <AggregationStatusBadge status={ds.aggregationStatus} />
                                    {ds.lastAggregatedAt && (
                                        <span className="text-[10px] text-ink-muted ml-auto">
                                            Last agg: {new Date(ds.lastAggregatedAt).toLocaleDateString()}{' '}
                                            <span className="text-ink-muted/70">{relativeTime(ds.lastAggregatedAt)}</span>
                                        </span>
                                    )}
                                </div>

                                {/* Row 2: edge count */}
                                <div className="text-xs text-ink-muted">
                                    <strong className="text-ink-secondary font-medium">
                                        {ds.aggregationEdgeCount.toLocaleString()}
                                    </strong>{' '}
                                    aggregated edges
                                </div>

                                {/* Row 3: drift */}
                                <div className="flex items-center gap-2 text-xs">
                                    {drift ? (
                                        <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400 font-medium">
                                            <AlertTriangle className="w-3.5 h-3.5" />
                                            Drift detected — source data has changed since last aggregation
                                        </span>
                                    ) : (
                                        <span className="text-ink-muted">Drift: None detected</span>
                                    )}
                                </div>

                                {/* Row 4: actions */}
                                <div className="flex items-center gap-2">
                                    <button
                                        onClick={() => onReaggregate(ds)}
                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20 transition-colors"
                                    >
                                        <Settings2 className="w-3.5 h-3.5" />
                                        Re-trigger
                                    </button>

                                    {ds.aggregationStatus === 'ready' && (
                                        <>
                                            {confirmPurgeId === ds.id ? (
                                                <div className="inline-flex items-center gap-2">
                                                    <span className="text-[11px] text-red-500 font-medium">
                                                        Purge all aggregated data?
                                                    </span>
                                                    <button
                                                        onClick={() => handlePurge(ds)}
                                                        disabled={purging === ds.id}
                                                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                                                    >
                                                        {purging === ds.id ? (
                                                            <Loader2 className="w-3 h-3 animate-spin" />
                                                        ) : (
                                                            <Trash2 className="w-3 h-3" />
                                                        )}
                                                        Confirm
                                                    </button>
                                                    <button
                                                        onClick={() => setConfirmPurgeId(null)}
                                                        className="px-2 py-1 text-[11px] font-medium rounded-lg text-ink-muted hover:text-ink transition-colors"
                                                    >
                                                        Cancel
                                                    </button>
                                                </div>
                                            ) : (
                                                <button
                                                    onClick={() => setConfirmPurgeId(ds.id)}
                                                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
                                                >
                                                    <Trash2 className="w-3.5 h-3.5" />
                                                    Purge
                                                </button>
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>

                            {/* Embedded aggregation history */}
                            <div className="border-t border-glass-border px-4 py-3 bg-black/[0.01] dark:bg-white/[0.01]">
                                <AggregationHistory dataSourceId={ds.id} />
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
