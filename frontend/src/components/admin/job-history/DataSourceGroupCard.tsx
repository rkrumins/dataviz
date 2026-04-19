import { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
    ChevronRight, Play, Trash2, Activity, Server, FolderOpen,
    MoreHorizontal, TrendingUp, TrendingDown, Minus,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { AggregationJobResponse } from '@/services/aggregationService'
import type { DataSourceResponse } from '@/services/workspaceService'
import { getProviderLogo } from '../ProviderLogos'
import { formatDuration, timeAgo, useClickOutside, type DataSourceMeta } from './shared'
import { JobRow } from './JobRow'

// ── Types ────────────────────────────────────────────────────────────

export interface DataSourceGroup {
    dataSourceId: string
    meta: DataSourceMeta
    dsResponse?: DataSourceResponse
    jobs: AggregationJobResponse[]
    totalRuns: number
    successRate: number | null
    avgDuration: number | null
    lastRunAt: string | null
    lastStatus: string | null
    failedCount: number
    isActive: boolean
    sparklineData: string[]
    durationTrend: 'up' | 'down' | 'stable' | null
}

export function buildGroups(
    jobs: AggregationJobResponse[],
    dsLookup: Map<string, DataSourceMeta>,
    allDataSources: DataSourceResponse[],
): DataSourceGroup[] {
    const dsMap = new Map<string, DataSourceResponse>()
    for (const ds of allDataSources) dsMap.set(ds.id, ds)

    const grouped = new Map<string, AggregationJobResponse[]>()
    for (const job of jobs) {
        const list = grouped.get(job.dataSourceId) ?? []
        list.push(job)
        grouped.set(job.dataSourceId, list)
    }

    const groups: DataSourceGroup[] = []
    for (const [dsId, dsJobs] of grouped) {
        const sorted = dsJobs.sort((a, b) =>
            new Date(b.startedAt ?? b.createdAt).getTime() - new Date(a.startedAt ?? a.createdAt).getTime()
        )
        const meta = dsLookup.get(dsId) ?? {
            label: sorted[0]?.dataSourceLabel ?? dsId,
            workspaceId: sorted[0]?.workspaceId ?? '',
            workspaceName: sorted[0]?.workspaceName ?? '',
            providerId: '', providerName: '', providerType: 'unknown',
            graphName: '', projectionMode: 'in_source',
        }
        const dsResponse = dsMap.get(dsId)
        const completed = sorted.filter(j => j.status === 'completed')
        const failed = sorted.filter(j => j.status === 'failed')
        const totalFinished = completed.length + failed.length
        const successRate = totalFinished > 0 ? Math.round((completed.length / totalFinished) * 100) : null
        const durations = completed.filter(j => j.durationSeconds != null).map(j => j.durationSeconds!)
        const avgDuration = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null
        const lastJob = sorted[0]
        const sparklineData = sorted.slice(0, 10)
            .filter(j => j.status === 'completed' || j.status === 'failed' || j.status === 'cancelled')
            .map(j => j.status)
            .reverse()

        // Duration trend: compare last 3 vs prior 3
        let durationTrend: 'up' | 'down' | 'stable' | null = null
        if (durations.length >= 4) {
            const recent = durations.slice(0, 3).reduce((a, b) => a + b, 0) / 3
            const prior = durations.slice(3, 6).reduce((a, b) => a + b, 0) / Math.min(3, durations.slice(3, 6).length)
            const pctChange = ((recent - prior) / prior) * 100
            if (pctChange > 20) durationTrend = 'up'
            else if (pctChange < -20) durationTrend = 'down'
            else durationTrend = 'stable'
        }

        groups.push({
            dataSourceId: dsId,
            meta,
            dsResponse,
            jobs: sorted,
            totalRuns: sorted.length,
            successRate,
            avgDuration,
            lastRunAt: lastJob?.startedAt ?? lastJob?.createdAt ?? null,
            lastStatus: lastJob?.status ?? null,
            failedCount: failed.length,
            isActive: sorted.some(j => j.status === 'pending' || j.status === 'running'),
            sparklineData,
            durationTrend,
        })
    }

    return groups
}

export type GroupSortKey = 'attention' | 'alpha' | 'recent' | 'runs' | 'success-rate'

export function sortGroups(groups: DataSourceGroup[], sortKey: GroupSortKey): DataSourceGroup[] {
    const sorted = [...groups]
    switch (sortKey) {
        case 'attention':
            sorted.sort((a, b) => {
                if (a.isActive !== b.isActive) return a.isActive ? -1 : 1
                if ((a.lastStatus === 'failed') !== (b.lastStatus === 'failed'))
                    return a.lastStatus === 'failed' ? -1 : 1
                return (new Date(b.lastRunAt ?? 0).getTime()) - (new Date(a.lastRunAt ?? 0).getTime())
            })
            break
        case 'alpha':
            sorted.sort((a, b) => a.meta.label.localeCompare(b.meta.label))
            break
        case 'recent':
            sorted.sort((a, b) => (new Date(b.lastRunAt ?? 0).getTime()) - (new Date(a.lastRunAt ?? 0).getTime()))
            break
        case 'runs':
            sorted.sort((a, b) => b.totalRuns - a.totalRuns)
            break
        case 'success-rate':
            sorted.sort((a, b) => (a.successRate ?? 100) - (b.successRate ?? 100))
            break
    }
    return sorted
}

// ── Sparkline ────────────────────────────────────────────────────────

function JobSparkline({ data }: { data: string[] }) {
    if (data.length === 0) return null
    return (
        <svg width={data.length * 8} height={12} className="inline-block align-middle">
            {data.map((status, i) => (
                <circle
                    key={i}
                    cx={i * 8 + 4}
                    cy={6}
                    r={3}
                    className={
                        status === 'completed' ? 'fill-emerald-500' :
                        status === 'failed' ? 'fill-red-500' :
                        'fill-zinc-400'
                    }
                />
            ))}
        </svg>
    )
}

// ── Duration Trend ───────────────────────────────────────────────────

function DurationTrend({ trend }: { trend: 'up' | 'down' | 'stable' | null }) {
    if (!trend || trend === 'stable') return <Minus className="w-3 h-3 text-ink-muted/40" />
    if (trend === 'up') return <TrendingUp className="w-3 h-3 text-red-400" />
    return <TrendingDown className="w-3 h-3 text-emerald-400" />
}

// ── Actions Dropdown (portal) ────────────────────────────────────────

function ActionsDropdown({
    anchorRef,
    onTrigger,
    onPurge,
}: {
    anchorRef: React.RefObject<HTMLDivElement | null>
    onTrigger: () => void
    onPurge: () => void
}) {
    const rect = anchorRef.current?.getBoundingClientRect()
    if (!rect) return null

    return createPortal(
        <div
            className="fixed z-[9999]"
            style={{ top: rect.bottom + 4, left: rect.right - 192 }}
        >
            <div className="w-48 bg-canvas border border-glass-border rounded-xl shadow-xl">
                <div className="py-1">
                    <button
                        onClick={onTrigger}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                    >
                        <Play className="w-3.5 h-3.5 text-emerald-500" />
                        Trigger Aggregation
                    </button>
                    <button
                        onClick={onPurge}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                    >
                        <Trash2 className="w-3.5 h-3.5 text-red-400" />
                        Purge Aggregated Edges
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    )
}

// ── Group Card ───────────────────────────────────────────────────────

const INITIAL_VISIBLE_JOBS = 5

interface DataSourceGroupCardProps {
    group: DataSourceGroup
    expanded: boolean
    onToggle: () => void
    onCancel: (job: AggregationJobResponse) => void
    onResume: (job: AggregationJobResponse) => void
    onRetrigger: (job: AggregationJobResponse) => void
    onDelete: (job: AggregationJobResponse) => void
    onPurge: (job: AggregationJobResponse) => void
    onTriggerAggregation: (dataSourceId: string) => void
    onPurgeDataSource: (dataSourceId: string) => void
    onShowAllJobs: (dataSourceId: string) => void
    expandedRowId: string | null
    setExpandedRowId: (id: string | null) => void
    purgeConfirm: string | null
    setPurgeConfirm: (id: string | null) => void
    actionLoading: string | null
}

export function DataSourceGroupCard({
    group,
    expanded,
    onToggle,
    onCancel,
    onResume,
    onRetrigger,
    onDelete,
    onPurge,
    onTriggerAggregation,
    onPurgeDataSource,
    onShowAllJobs,
    expandedRowId,
    setExpandedRowId,
    purgeConfirm,
    setPurgeConfirm,
    actionLoading,
}: DataSourceGroupCardProps) {
    const [showAll, setShowAll] = useState(false)
    const [showActions, setShowActions] = useState(false)
    const actionsRef = useRef<HTMLDivElement>(null)
    useClickOutside(actionsRef, useCallback(() => setShowActions(false), []))

    const { meta, dsResponse, jobs, totalRuns, successRate, avgDuration, lastRunAt, isActive, sparklineData, durationTrend } = group
    const edgeCount = dsResponse?.aggregationEdgeCount ?? 0
    const activeJob = isActive ? jobs.find(j => j.status === 'running' || j.status === 'pending') : undefined
    const visibleJobs = showAll ? jobs : jobs.slice(0, INITIAL_VISIBLE_JOBS)
    const ProviderLogo = getProviderLogo(meta.providerType)

    // Derive effective status: prefer dsResponse, fall back to latest job status
    const rawStatus = dsResponse?.aggregationStatus ?? 'none'
    const effectiveStatus = rawStatus !== 'none'
        ? rawStatus
        : group.lastStatus === 'completed' ? 'ready'
        : group.lastStatus === 'running' ? 'running'
        : group.lastStatus === 'pending' ? 'pending'
        : group.lastStatus === 'failed' ? 'failed'
        : 'none'

    const STATUS_STYLE_MAP: Record<string, { accent: string; pill: string; dot: string; label: string; pulse: boolean }> = {
        ready:   { accent: 'bg-gradient-to-r from-emerald-500/80 via-emerald-500/40 to-transparent', pill: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-500', dot: 'bg-emerald-500', label: 'Ready', pulse: false },
        running: { accent: 'bg-gradient-to-r from-indigo-500/80 via-indigo-500/40 to-transparent', pill: 'bg-indigo-500/10 border-indigo-500/20 text-indigo-500', dot: 'bg-indigo-500', label: 'Running', pulse: true },
        pending: { accent: 'bg-gradient-to-r from-amber-500/80 via-amber-500/40 to-transparent', pill: 'bg-amber-500/10 border-amber-500/20 text-amber-500', dot: 'bg-amber-500', label: 'Pending', pulse: true },
        failed:  { accent: 'bg-gradient-to-r from-red-500/80 via-red-500/40 to-transparent', pill: 'bg-red-500/10 border-red-500/20 text-red-500', dot: 'bg-red-500', label: 'Failed', pulse: false },
        skipped: { accent: 'bg-gradient-to-r from-zinc-500/30 to-transparent', pill: 'bg-zinc-500/10 border-zinc-500/20 text-zinc-400', dot: 'bg-zinc-400', label: 'Skipped', pulse: false },
    }
    const statusStyles = STATUS_STYLE_MAP[effectiveStatus] ?? { accent: 'bg-gradient-to-r from-zinc-500/30 to-transparent', pill: 'bg-zinc-500/10 border-zinc-500/20 text-zinc-400', dot: 'bg-zinc-400', label: 'Not Started', pulse: false }

    return (
        <div
            className={cn(
                'glass-panel rounded-xl border transition-all duration-200',
                effectiveStatus === 'failed' ? 'border-red-500/20' :
                effectiveStatus === 'running' ? 'border-indigo-500/20' :
                effectiveStatus === 'ready' ? 'border-emerald-500/15' :
                'border-glass-border/60',
            )}
        >
            {/* Accent bar */}
            <div className={cn('h-0.5 rounded-t-xl', statusStyles.accent)} />

            {/* Header */}
            <div
                onClick={onToggle}
                className="w-full px-4 py-3.5 flex items-start gap-3 text-left cursor-pointer hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors group"
                role="button"
                tabIndex={0}
                onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle() } }}
            >
                <motion.span
                    animate={{ rotate: expanded ? 90 : 0 }}
                    transition={{ duration: 0.15 }}
                    className="flex items-center justify-center w-5 h-5 mt-0.5 text-ink-muted/40 group-hover:text-ink-muted transition-colors"
                >
                    <ChevronRight className="w-4 h-4" />
                </motion.span>

                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                        <ProviderLogo className="w-4 h-4 flex-shrink-0" />
                        <span className="text-sm font-bold text-ink truncate">{meta.label}</span>
                        <span className={cn(
                            'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-semibold flex-shrink-0',
                            statusStyles.pill,
                        )}>
                            <span className={cn(
                                'w-1.5 h-1.5 rounded-full',
                                statusStyles.dot,
                                statusStyles.pulse && 'animate-pulse',
                            )} />
                            {statusStyles.label}
                        </span>
                    </div>

                    <div className="flex items-center gap-1.5 text-[10px] text-ink-muted mb-2 flex-wrap">
                        {/* Provider badge */}
                        {meta.providerName && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04]">
                                <Server className="w-2.5 h-2.5 text-ink-muted/50" />
                                <span className="font-medium truncate max-w-[140px]">{meta.providerName}</span>
                            </span>
                        )}
                        {/* Workspace badge — skip if same as provider name */}
                        {meta.workspaceName && meta.workspaceName !== meta.providerName && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04]">
                                <FolderOpen className="w-2.5 h-2.5 text-ink-muted/50" />
                                <span className="truncate max-w-[140px]">{meta.workspaceName}</span>
                            </span>
                        )}
                        {/* Graph name */}
                        {meta.graphName && (
                            <span className="font-mono text-ink-muted/50 truncate max-w-[120px]">{meta.graphName}</span>
                        )}
                        {edgeCount > 0 && (
                            <>
                                <span className="text-ink-muted/20 mx-0.5">·</span>
                                <span className="tabular-nums font-medium">{edgeCount.toLocaleString()} edges</span>
                            </>
                        )}
                    </div>

                    {/* Active job progress bar */}
                    {activeJob && activeJob.totalEdges > 0 && (
                        <div className="mb-2">
                            <div className="flex items-center gap-2 mb-1">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                <span className="text-[10px] font-semibold text-ink">
                                    {activeJob.status === 'running' ? 'Processing' : 'Queued'}
                                </span>
                                <span className="text-[10px] font-bold text-indigo-400 tabular-nums ml-auto">
                                    {activeJob.progress}%
                                </span>
                            </div>
                            <div className="w-full h-1.5 bg-indigo-500/[0.07] rounded-full overflow-hidden">
                                <motion.div
                                    className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
                                    animate={{ width: `${Math.min(100, activeJob.progress)}%` }}
                                    transition={{ duration: 0.6, ease: 'easeOut' }}
                                />
                            </div>
                        </div>
                    )}

                    {/* Summary metrics strip */}
                    <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                        <JobSparkline data={sparklineData} />
                        <span className="tabular-nums font-medium">{totalRuns} run{totalRuns !== 1 ? 's' : ''}</span>
                        {successRate != null && (
                            <span className={cn(
                                'tabular-nums font-semibold',
                                successRate >= 90 ? 'text-emerald-500' :
                                successRate >= 70 ? 'text-amber-500' :
                                'text-red-500',
                            )}>
                                {successRate}% success
                            </span>
                        )}
                        {avgDuration != null && (
                            <span className="flex items-center gap-1 tabular-nums">
                                avg {formatDuration(avgDuration)}
                                <DurationTrend trend={durationTrend} />
                            </span>
                        )}
                        {lastRunAt && (
                            <span className="ml-auto text-ink-muted/60">{timeAgo(lastRunAt)}</span>
                        )}
                    </div>
                </div>

                {/* Actions overflow */}
                <div
                    ref={actionsRef}
                    className="relative flex-shrink-0"
                    onClick={e => e.stopPropagation()}
                >
                    <button
                        onClick={() => setShowActions(p => !p)}
                        className="p-1.5 rounded-lg text-ink-muted/40 hover:text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.04] transition-colors"
                    >
                        <MoreHorizontal className="w-4 h-4" />
                    </button>
                    {showActions && <ActionsDropdown
                        anchorRef={actionsRef}
                        onTrigger={() => { onTriggerAggregation(group.dataSourceId); setShowActions(false) }}
                        onPurge={() => { onPurgeDataSource(group.dataSourceId); setShowActions(false) }}
                    />}
                </div>
            </div>

            {/* Expanded job list */}
            <AnimatePresence>
                {expanded && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="border-t border-glass-border/40">
                            {jobs.length === 0 ? (
                                <div className="py-8 text-center">
                                    <Activity className="w-6 h-6 text-ink-muted/30 mx-auto mb-2" />
                                    <p className="text-xs text-ink-muted">No aggregation history yet</p>
                                    <button
                                        onClick={() => onTriggerAggregation(group.dataSourceId)}
                                        className="mt-2 text-xs text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
                                    >
                                        Trigger Aggregation
                                    </button>
                                </div>
                            ) : (
                                <div className="overflow-x-auto">
                                    <table className="w-full min-w-[700px]">
                                        <thead>
                                            <tr className="border-b border-glass-border/40 bg-black/[0.02] dark:bg-white/[0.01]">
                                                {['Status', 'Mode', 'Trigger', 'Progress', 'Edges', 'Duration', 'Started', ''].map((h, i) => (
                                                    <th key={h || 'actions'} className={cn(
                                                        'text-[10px] font-bold text-ink-muted uppercase tracking-wider px-4 py-2',
                                                        i === 7 ? 'text-right' : 'text-left'
                                                    )}>
                                                        {h}
                                                    </th>
                                                ))}
                                            </tr>
                                        </thead>
                                        <tbody>
                                            {visibleJobs.map((job) => {
                                                const prevCompleted = jobs
                                                    .filter(j => j.status === 'completed')
                                                const jobIdx = prevCompleted.indexOf(job)
                                                const previousJob = jobIdx >= 0 && jobIdx < prevCompleted.length - 1
                                                    ? prevCompleted[jobIdx + 1] : undefined

                                                return (
                                                    <JobRow
                                                        key={job.id}
                                                        job={job}
                                                        meta={group.meta}
                                                        expanded={expandedRowId === job.id}
                                                        onToggle={() => setExpandedRowId(expandedRowId === job.id ? null : job.id)}
                                                        onCancel={onCancel}
                                                        onResume={onResume}
                                                        onRetrigger={onRetrigger}
                                                        onDelete={onDelete}
                                                        onPurge={onPurge}
                                                        purgeConfirm={purgeConfirm}
                                                        setPurgeConfirm={setPurgeConfirm}
                                                        actionLoading={actionLoading === job.id}
                                                        compact
                                                        previousJob={previousJob}
                                                    />
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            )}

                            {/* Show all / show less */}
                            {jobs.length > INITIAL_VISIBLE_JOBS && (
                                <div className="px-4 py-2 border-t border-glass-border/30 flex items-center justify-between">
                                    <button
                                        onClick={() => setShowAll(p => !p)}
                                        className="text-[11px] font-medium text-indigo-400 hover:text-indigo-300 transition-colors"
                                    >
                                        {showAll ? 'Show fewer' : `Show all ${jobs.length} jobs`}
                                    </button>
                                    <button
                                        onClick={() => onShowAllJobs(group.dataSourceId)}
                                        className="text-[11px] text-ink-muted hover:text-ink transition-colors"
                                    >
                                        View in flat list {'\u2192'}
                                    </button>
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
