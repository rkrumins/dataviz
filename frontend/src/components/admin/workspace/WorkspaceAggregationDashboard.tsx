/**
 * WorkspaceAggregationDashboard — Aggregation overview tab for the workspace detail page.
 *
 * Shows per-data-source aggregation status with:
 * - Real-time polling when any job is pending/running
 * - Interactive status filter chips
 * - Inline active-job progress bars
 * - Loading states on action buttons with toast feedback
 * - Drift detection indicators
 */

import { useState, useMemo, useEffect, useCallback } from 'react'
import {
    Database, Settings2, Trash2, AlertTriangle, Loader2,
    CheckCircle2, Clock, AlertCircle, XCircle, SkipForward, CircleDot,
    RefreshCw, Activity,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import { aggregationService, type DataSourceReadinessResponse } from '@/services/aggregationService'
import { AggregationHistory } from '../AggregationHistory'

// ─── Types ─────────────────────────────────────────────────────────────

interface WorkspaceAggregationDashboardProps {
    dataSources: DataSourceResponse[]
    readinessMap: Record<string, DataSourceReadinessResponse>
    onReaggregate: (ds: DataSourceResponse) => Promise<void>
    onPurge: (ds: DataSourceResponse) => Promise<void>
}

type StatusFilter = 'all' | 'ready' | 'running' | 'pending' | 'failed' | 'skipped' | 'none'

// ─── Status Config ─────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, {
    label: string
    icon: typeof CheckCircle2
    dotColor: string
    textColor: string
    bgColor: string
    borderColor: string
}> = {
    ready:   { label: 'Ready',       icon: CheckCircle2, dotColor: 'bg-emerald-400',               textColor: 'text-emerald-600 dark:text-emerald-400', bgColor: 'bg-emerald-500/10', borderColor: 'border-emerald-500/20' },
    running: { label: 'Running',     icon: Loader2,      dotColor: 'bg-indigo-400 animate-pulse',   textColor: 'text-indigo-600 dark:text-indigo-400',   bgColor: 'bg-indigo-500/10',  borderColor: 'border-indigo-500/20' },
    pending: { label: 'Pending',     icon: Clock,        dotColor: 'bg-amber-400 animate-pulse',    textColor: 'text-amber-600 dark:text-amber-400',     bgColor: 'bg-amber-500/10',   borderColor: 'border-amber-500/20' },
    failed:  { label: 'Failed',      icon: AlertCircle,  dotColor: 'bg-red-400',                    textColor: 'text-red-600 dark:text-red-400',         bgColor: 'bg-red-500/10',     borderColor: 'border-red-500/20' },
    skipped: { label: 'Skipped',     icon: SkipForward,  dotColor: 'bg-gray-400',                   textColor: 'text-ink-muted',                         bgColor: 'bg-gray-500/10',    borderColor: 'border-gray-500/20' },
    none:    { label: 'Not Started', icon: CircleDot,    dotColor: 'bg-gray-400',                   textColor: 'text-ink-muted',                         bgColor: 'bg-gray-500/10',    borderColor: 'border-gray-500/20' },
}

// ─── Helpers ───────────────────────────────────────────────────────────

function relativeTime(dateStr: string): string {
    const diffMs = Date.now() - new Date(dateStr).getTime()
    const diffMin = Math.floor(diffMs / 60_000)
    if (diffMin < 1) return 'just now'
    if (diffMin < 60) return `${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    const diffD = Math.floor(diffH / 24)
    return `${diffD}d ago`
}

/** Resolve the current aggregation status for a DS, preferring readiness API data. */
function resolveStatus(ds: DataSourceResponse, readiness?: DataSourceReadinessResponse): string {
    return readiness?.aggregationStatus ?? ds.aggregationStatus ?? 'none'
}

// ─── Component ─────────────────────────────────────────────────────────

export function WorkspaceAggregationDashboard({
    dataSources,
    readinessMap,
    onReaggregate,
    onPurge,
}: WorkspaceAggregationDashboardProps) {
    const [activeFilter, setActiveFilter] = useState<StatusFilter>('all')
    const [confirmPurgeId, setConfirmPurgeId] = useState<string | null>(null)
    const [purging, setPurging] = useState<string | null>(null)
    const [triggering, setTriggering] = useState<string | null>(null)
    const [expandedId, setExpandedId] = useState<string | null>(null)

    // Live readiness state — starts from parent's map, then polled locally
    const [liveReadiness, setLiveReadiness] = useState<Record<string, DataSourceReadinessResponse>>(readinessMap)

    // Sync when parent provides fresh data
    useEffect(() => {
        setLiveReadiness(prev => ({ ...prev, ...readinessMap }))
    }, [readinessMap])

    // Poll readiness every 4s when any DS is pending/running
    const hasActiveJobs = useMemo(() => {
        return dataSources.some(ds => {
            const s = resolveStatus(ds, liveReadiness[ds.id])
            return s === 'pending' || s === 'running'
        })
    }, [dataSources, liveReadiness])

    const pollReadiness = useCallback(async () => {
        const updates: Record<string, DataSourceReadinessResponse> = {}
        await Promise.all(
            dataSources.map(async ds => {
                try {
                    const r = await aggregationService.getReadiness(ds.id)
                    updates[ds.id] = r
                } catch { /* ignore */ }
            })
        )
        if (Object.keys(updates).length > 0) {
            setLiveReadiness(prev => ({ ...prev, ...updates }))
        }
    }, [dataSources])

    useEffect(() => {
        if (!hasActiveJobs) return
        const interval = setInterval(pollReadiness, 4000)
        return () => clearInterval(interval)
    }, [hasActiveJobs, pollReadiness])

    // Compute status counts from live data
    const statusCounts = useMemo(() => {
        const counts: Record<string, number> = { ready: 0, running: 0, pending: 0, failed: 0, none: 0, skipped: 0 }
        dataSources.forEach(ds => {
            const s = resolveStatus(ds, liveReadiness[ds.id])
            counts[s] = (counts[s] || 0) + 1
        })
        return counts
    }, [dataSources, liveReadiness])

    // Filter data sources
    const filteredSources = useMemo(() => {
        if (activeFilter === 'all') return dataSources
        return dataSources.filter(ds => resolveStatus(ds, liveReadiness[ds.id]) === activeFilter)
    }, [dataSources, activeFilter, liveReadiness])

    // Action handlers with loading states
    const handleReaggregate = async (ds: DataSourceResponse) => {
        setTriggering(ds.id)
        try {
            await onReaggregate(ds)
            // Immediately poll for new status
            setTimeout(pollReadiness, 500)
        } finally {
            setTriggering(null)
        }
    }

    const handlePurge = async (ds: DataSourceResponse) => {
        setPurging(ds.id)
        try {
            await onPurge(ds)
            setTimeout(pollReadiness, 500)
        } finally {
            setPurging(null)
            setConfirmPurgeId(null)
        }
    }

    const totalCount = dataSources.length

    return (
        <div className="space-y-5">
            {/* ─── Header ───────────────────────────────────────────── */}
            <div className="flex items-center justify-between">
                <h3 className="text-lg font-bold text-ink">Aggregation Overview</h3>
                {hasActiveJobs && (
                    <span className="flex items-center gap-1.5 text-[11px] font-medium text-indigo-600 dark:text-indigo-400">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        Live — polling every 4s
                    </span>
                )}
            </div>

            {/* ─── Summary chips (interactive filters) ──────────────── */}
            <div className="flex flex-wrap items-center gap-2">
                <button
                    onClick={() => setActiveFilter('all')}
                    className={cn(
                        'px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all',
                        activeFilter === 'all'
                            ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                            : 'border-glass-border text-ink-muted hover:border-indigo-500/20'
                    )}
                >
                    All {totalCount}
                </button>
                {Object.entries(STATUS_CONFIG).map(([key, cfg]) => {
                    const count = statusCounts[key] || 0
                    if (count === 0) return null
                    return (
                        <button
                            key={key}
                            onClick={() => setActiveFilter(activeFilter === key ? 'all' : key as StatusFilter)}
                            className={cn(
                                'px-3 py-1.5 text-xs font-semibold rounded-lg border transition-all flex items-center gap-1.5',
                                activeFilter === key
                                    ? `${cfg.borderColor} ${cfg.bgColor} ${cfg.textColor}`
                                    : 'border-glass-border text-ink-muted hover:border-glass-border-hover'
                            )}
                        >
                            <span className={cn('w-2 h-2 rounded-full', cfg.dotColor)} />
                            {count} {cfg.label}
                        </button>
                    )
                })}
            </div>

            {/* ─── Data Source Cards ─────────────────────────────────── */}
            {filteredSources.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 border-2 border-dashed border-glass-border rounded-xl">
                    <Activity className="w-8 h-8 text-ink-muted mb-3" />
                    <p className="text-sm font-medium text-ink-muted">
                        No data sources match this filter
                    </p>
                    <button
                        onClick={() => setActiveFilter('all')}
                        className="text-xs text-indigo-500 hover:underline mt-1"
                    >
                        Show all
                    </button>
                </div>
            ) : (
                <div className="space-y-3">
                    {filteredSources.map(ds => {
                        const readiness = liveReadiness[ds.id]
                        const status = resolveStatus(ds, readiness)
                        const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.none
                        const drift = readiness?.driftDetected ?? false
                        const activeJob = readiness?.activeJob
                        const isExpanded = expandedId === ds.id
                        const isTriggering = triggering === ds.id
                        const isPurging = purging === ds.id
                        const edgeCount = readiness?.aggregationEdgeCount ?? ds.aggregationEdgeCount ?? 0
                        const lastAgg = readiness?.lastAggregatedAt ?? ds.lastAggregatedAt

                        return (
                            <div
                                key={ds.id}
                                className={cn(
                                    'border rounded-xl overflow-hidden transition-colors',
                                    cfg.borderColor,
                                    'bg-canvas-elevated',
                                )}
                            >
                                {/* ── Card Body ────────────────────────────── */}
                                <div className="p-4 space-y-3">
                                    {/* Row 1: Identity + Status */}
                                    <div className="flex items-center gap-3">
                                        <div className={cn(
                                            'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                                            cfg.bgColor,
                                        )}>
                                            <Database className={cn('w-4 h-4', cfg.textColor)} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-2">
                                                <span className="text-sm font-bold text-ink truncate">
                                                    {ds.label || 'Unnamed Source'}
                                                </span>
                                                <span className={cn(
                                                    'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-bold',
                                                    cfg.bgColor, cfg.textColor,
                                                )}>
                                                    <span className={cn('w-1.5 h-1.5 rounded-full', cfg.dotColor)} />
                                                    {cfg.label}
                                                </span>
                                            </div>
                                            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-ink-muted">
                                                <span>
                                                    <strong className="text-ink-secondary font-medium">
                                                        {edgeCount.toLocaleString()}
                                                    </strong>{' '}aggregated edges
                                                </span>
                                                {lastAgg && (
                                                    <span>
                                                        Last: {relativeTime(lastAgg)}
                                                    </span>
                                                )}
                                                {ds.projectionMode && ds.projectionMode !== 'in_source' && (
                                                    <span className="px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 text-[9px] font-bold uppercase">
                                                        {ds.projectionMode}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Active job progress (live) */}
                                    {activeJob && (status === 'running' || status === 'pending') && (
                                        <div className={cn(
                                            'rounded-lg border p-3 space-y-2',
                                            cfg.bgColor, cfg.borderColor,
                                        )}>
                                            <div className="flex items-center justify-between text-[11px]">
                                                <span className={cn('font-semibold flex items-center gap-1.5', cfg.textColor)}>
                                                    {status === 'running' ? (
                                                        <Loader2 className="w-3 h-3 animate-spin" />
                                                    ) : (
                                                        <Clock className="w-3 h-3" />
                                                    )}
                                                    {status === 'running' ? 'Aggregation in progress' : 'Job queued'}
                                                </span>
                                                <span className={cn('font-bold tabular-nums', cfg.textColor)}>
                                                    {Math.round(activeJob.progress || 0)}%
                                                </span>
                                            </div>
                                            <div className="w-full h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden">
                                                <div
                                                    className={cn(
                                                        'h-full rounded-full transition-all duration-700',
                                                        status === 'running' ? 'bg-indigo-500' : 'bg-amber-500',
                                                    )}
                                                    style={{ width: `${Math.min(100, Math.round(activeJob.progress || 0))}%` }}
                                                />
                                            </div>
                                            {activeJob.processedEdges > 0 && (
                                                <div className="text-[10px] text-ink-muted">
                                                    {activeJob.processedEdges.toLocaleString()} / {activeJob.totalEdges.toLocaleString()} edges processed
                                                </div>
                                            )}
                                        </div>
                                    )}

                                    {/* Drift Warning */}
                                    {drift && (
                                        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.06]">
                                            <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />
                                            <p className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">
                                                Drift detected — source data has changed since last aggregation. Re-trigger to reconcile.
                                            </p>
                                        </div>
                                    )}

                                    {/* Failed error */}
                                    {status === 'failed' && readiness?.activeJob?.errorMessage && (
                                        <div className="flex items-start gap-2 px-3 py-2 rounded-lg border border-red-500/20 bg-red-500/[0.06]">
                                            <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                                            <p className="text-[11px] text-red-600 dark:text-red-400 font-mono break-all">
                                                {readiness.activeJob.errorMessage}
                                            </p>
                                        </div>
                                    )}

                                    {/* Actions */}
                                    <div className="flex items-center gap-2 pt-1">
                                        <button
                                            onClick={() => handleReaggregate(ds)}
                                            disabled={isTriggering || status === 'running' || status === 'pending'}
                                            className={cn(
                                                'inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors',
                                                isTriggering || status === 'running' || status === 'pending'
                                                    ? 'bg-indigo-500/5 text-indigo-400/50 cursor-not-allowed'
                                                    : 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/20'
                                            )}
                                        >
                                            {isTriggering ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <Settings2 className="w-3.5 h-3.5" />
                                            )}
                                            {isTriggering ? 'Triggering...' : (status === 'running' || status === 'pending') ? 'Job Active' : 'Re-trigger'}
                                        </button>

                                        {status === 'ready' && (
                                            <>
                                                {confirmPurgeId === ds.id ? (
                                                    <div className="inline-flex items-center gap-2">
                                                        <span className="text-[11px] text-red-500 font-medium">
                                                            Purge all edges?
                                                        </span>
                                                        <button
                                                            onClick={() => handlePurge(ds)}
                                                            disabled={isPurging}
                                                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-bold rounded-lg bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50"
                                                        >
                                                            {isPurging ? (
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
                                                        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-colors"
                                                    >
                                                        <Trash2 className="w-3.5 h-3.5" />
                                                        Purge
                                                    </button>
                                                )}
                                            </>
                                        )}

                                        {/* Expand/collapse history toggle */}
                                        <button
                                            onClick={() => setExpandedId(isExpanded ? null : ds.id)}
                                            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                        >
                                            <RefreshCw className={cn('w-3 h-3', isExpanded && 'text-indigo-500')} />
                                            {isExpanded ? 'Hide History' : 'Job History'}
                                        </button>
                                    </div>
                                </div>

                                {/* ── Expandable History ────────────────────── */}
                                {isExpanded && (
                                    <div className="border-t border-glass-border px-4 py-3 bg-black/[0.01] dark:bg-white/[0.01]">
                                        <AggregationHistory dataSourceId={ds.id} />
                                    </div>
                                )}
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
