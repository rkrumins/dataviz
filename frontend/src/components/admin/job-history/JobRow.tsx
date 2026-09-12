import { memo, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Loader2, AlertCircle, ChevronRight, RotateCcw, StopCircle, Play, Trash2,
    AlertTriangle, Server, FolderOpen, ShieldCheck, ChevronDown, Gauge,
} from 'lucide-react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'
import type { AdaptedRunState, AggregationJobResponse, AggregationTuning, JobLimitsPatch } from '@/services/aggregationService'
import { useJob } from '@/hooks/useJob'
import { getProviderLogo } from '../ProviderLogos'
import {
    formatDuration, timeAgo, triggerLabel, STATUS_CONFIG, type DataSourceMeta,
    PHASES, PHASE_BANDS, PhaseStepper, phaseLabel,
} from './shared'
import { RunSettingsPanel } from './RunSettingsPanel'
import { steadyLoadFromSnapshot, steadyLoadLine } from './steadyLoad'
import { presetForRun } from './runSettings'
import { AdjustRunningJob } from './AdjustRunningJob'
// One vocabulary for the detector codes across Job History and the Freshness
// cockpit — they must never disagree about what "overlay_missing" is called,
// nor about what its evidence means.
import { REASON_LABEL as RECONCILE_REASON_LABEL } from '../Freshness/DriftStateBadge'
import { ReconcileWhy } from '../Freshness/reconcileEvidence'
import { remainingSecsFromLedger } from './runSteps'

/**
 * History-informed ETA: uses the PREVIOUS completed run's durations
 * (persisted run_stats) for this data source — remaining time = the
 * unfinished part of the current stage plus the full duration of every later
 * stage, at the rates this graph actually exhibited last time. Falls back to
 * null (caller uses the backend's linear phase-weighted estimate) when there
 * is no usable history.
 *
 * Prefers the two runs' step ledgers when both have one: they carry each
 * stage's real unit of work, and the two stages either side of the pipeline
 * that the four-phase projection could not see at all.
 */
function historicalEta(
    job: AggregationJobResponse,
    previousJob: AggregationJobResponse | undefined,
): string | null {
    if (job.status !== 'running') return null
    const stats = previousJob?.status === 'completed' ? previousJob.runStats : null
    if (!stats) return null
    // A verified/no-change previous run has near-zero reconcile+apply
    // durations — projecting the CURRENT run from it yields an absurd
    // "finishing now". Only writing runs are predictive, ledger or not.
    if (stats.writes === 0 && stats.deletes === 0) return null
    const fromLedger = remainingSecsFromLedger(job.runStats?.steps, stats.steps, Date.now())
    if (fromLedger != null) {
        return new Date(Date.now() + fromLedger * 1000).toISOString()
    }
    if (!job.currentPhase) return null
    const idx = PHASES.findIndex(p => p.id === job.currentPhase)
    const band = PHASE_BANDS[job.currentPhase]
    if (idx < 0 || !band) return null
    const prevTotal = PHASES.reduce((acc, p) => {
        const v = stats[p.statKey]
        return acc + (typeof v === 'number' ? v : 0)
    }, 0)
    if (prevTotal < 5) return null   // previous run too fast to be signal
    const cur = stats[PHASES[idx].statKey]
    if (typeof cur !== 'number') return null
    const frac = Math.min(1, Math.max(0, (job.progress - band[0]) / (band[1] - band[0])))
    let remaining = cur * (1 - frac)
    for (let i = idx + 1; i < PHASES.length; i++) {
        const v = stats[PHASES[i].statKey]
        if (typeof v === 'number') remaining += v
    }
    if (!isFinite(remaining) || remaining <= 0) return null
    return new Date(Date.now() + remaining * 1000).toISOString()
}

// ── Tooltip ──────────────────────────────────────────────────────────

export function Tip({ children, label }: { children: React.ReactNode; label: string }) {
    return (
        <TooltipPrimitive.Provider delayDuration={300}>
            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                        side="top"
                        sideOffset={6}
                        className="z-50 px-2.5 py-1.5 rounded-lg bg-ink text-canvas text-[11px] font-medium shadow-lg animate-in fade-in zoom-in-95 duration-150"
                    >
                        {label}
                        <TooltipPrimitive.Arrow className="fill-ink" />
                    </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
    )
}

// ── StatCell ─────────────────────────────────────────────────────────

export function StatCell({ label, value, capitalize }: { label: string; value: React.ReactNode; capitalize?: boolean }) {
    return (
        <div className="rounded-lg bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2">
            <span className="block text-[9px] text-ink-muted/60 uppercase tracking-wider font-bold mb-1">{label}</span>
            <span className={cn('text-[12px] font-semibold text-ink tabular-nums', capitalize && 'capitalize')}>{value}</span>
        </div>
    )
}

// ── KpiCard ──────────────────────────────────────────────────────────

export function KpiCard({ icon: Icon, label, value, accent, iconBg }: {
    icon: typeof AlertCircle; label: string; value: string; accent: string; iconBg: string
}) {
    return (
        <div className="group relative rounded-xl border border-glass-border/60 bg-canvas px-4 py-3 flex items-center gap-3 overflow-hidden transition-all hover:border-glass-border hover:shadow-sm">
            <div className={cn('absolute inset-0 opacity-[0.03] group-hover:opacity-[0.06] transition-opacity', iconBg.replace('/10', '/100'))} />
            <div className={cn('relative w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0', iconBg)}>
                <Icon className="w-4 h-4" />
            </div>
            <div className="relative">
                <p className={cn('text-xl font-bold tabular-nums leading-none tracking-tight', accent)}>{value}</p>
                <p className="text-[10px] text-ink-muted/70 uppercase tracking-wider font-bold mt-1">{label}</p>
            </div>
        </div>
    )
}

// ── Job Row ──────────────────────────────────────────────────────────

export interface JobRowProps {
    job: AggregationJobResponse
    meta?: DataSourceMeta
    expanded: boolean
    // Takes the row's job id so the parent can pass a stable callback that
    // doesn't re-create per row (which would defeat React.memo on JobRow).
    onToggle: (jobId: string) => void
    onCancel: (job: AggregationJobResponse) => void
    onResume: (job: AggregationJobResponse) => void
    onRetrigger: (job: AggregationJobResponse) => void
    onDelete: (job: AggregationJobResponse) => void
    onPurge: (job: AggregationJobResponse) => void
    purgeConfirm: string | null
    setPurgeConfirm: (id: string | null) => void
    actionLoading: boolean
    compact?: boolean
    previousJob?: AggregationJobResponse
    /** The fleet Defaults row, so a run's value that equals it reads "Fleet default". */
    storedGlobal?: AggregationTuning | null
    /** Raise a pending or running job's time limits without cancelling it. */
    onExtend?: (job: AggregationJobResponse, patch: JobLimitsPatch) => void | Promise<void>
}

export const JobRow = memo(function JobRow({ job: jobFromList, meta, expanded, onToggle, onCancel, onResume, onRetrigger, onDelete, onPurge, purgeConfirm, setPurgeConfirm, actionLoading, compact, previousJob, storedGlobal, onExtend }: JobRowProps) {
    // Open the SSE stream only for actively-running jobs so terminal
    // rows (the bulk of Job History) don't open dead EventSources.
    // Phase 3's useJobsLive(scope) consolidates this to one connection
    // per workspace; for Phase 1 we accept N connections per visible
    // running row (HTTP/1.1 caps at 6, sufficient in practice).
    const isActive = jobFromList.status === 'running' || jobFromList.status === 'pending'
    const liveOverlay = useJob(
        jobFromList.dataSourceId,
        jobFromList.id,
        isActive,
    )

    // Merge the live snapshot onto the polling-derived job so the
    // rest of the component reads from a single ``job`` object. The
    // snapshot only carries fields that landed in events; any field
    // it doesn't touch falls through to the polling value. After a
    // ``terminal`` event lands, defer entirely to the polling-fetched
    // row (DB is the source of truth post-terminal).
    const job: AggregationJobResponse =
        isActive && !liveOverlay.terminal && Object.keys(liveOverlay.snapshot).length > 0
            ? {
                ...jobFromList,
                processedEdges: liveOverlay.snapshot.processed_edges ?? jobFromList.processedEdges,
                totalEdges: liveOverlay.snapshot.total_edges ?? jobFromList.totalEdges,
                createdEdges: liveOverlay.snapshot.created_edges ?? jobFromList.createdEdges,
                progress: liveOverlay.snapshot.progress ?? jobFromList.progress,
                lastCursor: liveOverlay.snapshot.last_cursor ?? jobFromList.lastCursor,
                lastCheckpointAt: liveOverlay.snapshot.last_heartbeat_at ?? jobFromList.lastCheckpointAt,
                currentPhase: liveOverlay.snapshot.currentPhase ?? jobFromList.currentPhase,
            }
            : jobFromList

    // Live write/reconcile counters only exist on the SSE stream — they are
    // not part of the polled job row, so read them off the snapshot directly.
    const liveWrites = isActive && !liveOverlay.terminal ? liveOverlay.snapshot.writes : undefined
    const liveDeletes = isActive && !liveOverlay.terminal ? liveOverlay.snapshot.deletes : undefined
    // What the pressure ladder has changed so far: the live scalars from the
    // stream while the job runs, else the polled record (written at every
    // coalesced checkpoint, so it is at most seconds behind).
    const snap = liveOverlay.snapshot
    const liveAdapted = useMemo<Partial<AdaptedRunState> | null>(() => {
        if (!isActive || liveOverlay.terminal) return null
        const out: Partial<AdaptedRunState> = {}
        if (snap.adapted_scan_width !== undefined) out.scan_width = snap.adapted_scan_width
        if (snap.adapted_scan_width_min !== undefined) out.scan_width_min = snap.adapted_scan_width_min
        if (snap.adapted_scan_shrinks !== undefined) out.scan_shrinks = snap.adapted_scan_shrinks
        if (snap.adapted_extract_concurrency !== undefined) out.extract_concurrency = snap.adapted_extract_concurrency
        if (snap.adapted_reconcile_strategy !== undefined) out.reconcile_strategy = snap.adapted_reconcile_strategy
        if (snap.adapted_write_batch !== undefined) out.write_batch = snap.adapted_write_batch
        if (snap.adapted_delete_chunk !== undefined) out.delete_chunk = snap.adapted_delete_chunk
        if (snap.adapted_timeout_retries !== undefined) out.timeout_retries = snap.adapted_timeout_retries
        if (snap.adapted_memory_flushes !== undefined) out.memory_flushes = snap.adapted_memory_flushes
        if (snap.adapted_rss_high_water_mb !== undefined) out.rss_high_water_mb = snap.adapted_rss_high_water_mb
        if (snap.adapted_mem_limit_mb !== undefined) out.mem_limit_mb = snap.adapted_mem_limit_mb
        const live: NonNullable<AdaptedRunState['live']> = {}
        if (snap.adapted_live_scan_timeout_s !== undefined) live.scan_timeout_s = snap.adapted_live_scan_timeout_s
        if (snap.adapted_live_write_timeout_s !== undefined) live.write_timeout_s = snap.adapted_live_write_timeout_s
        if (snap.adapted_live_write_pacing_ratio !== undefined) live.write_pacing_ratio = snap.adapted_live_write_pacing_ratio
        if (snap.adapted_live_extract_concurrency !== undefined) live.extract_concurrency = snap.adapted_live_extract_concurrency
        if (snap.adapted_live_scan_width !== undefined) live.scan_width = snap.adapted_live_scan_width
        if (Object.keys(live).length > 0) out.live = live
        return Object.keys(out).length > 0 ? out : null
    }, [isActive, liveOverlay.terminal, snap.adapted_scan_width, snap.adapted_scan_width_min, snap.adapted_scan_shrinks,
        snap.adapted_extract_concurrency, snap.adapted_reconcile_strategy, snap.adapted_write_batch,
        snap.adapted_delete_chunk, snap.adapted_timeout_retries, snap.adapted_memory_flushes,
        snap.adapted_rss_high_water_mb, snap.adapted_mem_limit_mb, snap.adapted_live_scan_timeout_s,
        snap.adapted_live_write_timeout_s, snap.adapted_live_write_pacing_ratio,
        snap.adapted_live_extract_concurrency, snap.adapted_live_scan_width])
    const adaptedNow: Partial<AdaptedRunState> | null = liveAdapted ?? jobFromList.runStats?.adapted ?? null
    // What the rebuild is doing to the graph store right now — only ever from
    // the live stream: the batch shape, the duty cycle, a hold and its reason.
    const steady = useMemo(() => {
        if (!isActive || liveOverlay.terminal) return null
        const now = steadyLoadFromSnapshot(snap)
        return now ? steadyLoadLine(now) : null
    }, [isActive, liveOverlay.terminal, snap])
    const narrowing = jobFromList.status === 'running' && !!adaptedNow && (
        adaptedNow.scan_width != null || adaptedNow.extract_concurrency != null
        || adaptedNow.reconcile_strategy === 'keys_only' || adaptedNow.write_batch != null
    )
    const [showSettings, setShowSettings] = useState(false)
    const presetLabel = useMemo(() => presetForRun(jobFromList.runStats?.effective_tuning), [jobFromList.runStats?.effective_tuning])

    // The stage the run is on, off its own step ledger. ``currentPhase`` can
    // only ever name the pipeline's four phases — the worker's two bookends
    // (indexes + identity stamping before the first checkpoint, the
    // after-fingerprint and state rows after the last) never reach it, and on
    // a large graph those are minutes at each end of the run.
    const openStepId = useMemo(
        () => (jobFromList.runStats?.steps ?? []).find(
            s => s.state === 'running' || s.state === 'waiting',
        )?.id,
        [jobFromList.runStats?.steps],
    )
    const hasSteps = (jobFromList.runStats?.steps?.length ?? 0) > 0

    const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending
    const StatusIcon = cfg.icon
    const isRunning = job.status === 'running'
    const isPending = job.status === 'pending'
    const canCancel = isPending || isRunning
    const canResume = job.resumable
    const isTerminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
    const isPurging = purgeConfirm === job.id
    const dsName = meta?.label || job.dataSourceLabel || job.dataSourceId
    const wsName = meta?.workspaceName || job.workspaceName
    const provType = meta?.providerType
    const ProviderLogoIcon = getProviderLogo(provType ?? '')

    // This run's actual write/delete counts (diff apply). Present on
    // every pipeline run; absent only on legacy rows.
    const statWrites = typeof job.runStats?.writes === 'number' ? job.runStats.writes : null
    const statDeletes = typeof job.runStats?.deletes === 'number' ? job.runStats.deletes : null
    // Storage regime this run decided (durable in run_stats): 'cube' =
    // every ancestor combination materialized; 'boundary' = canonical
    // depth-diagonal stored, finer granularities served on demand. The
    // over-budget fallback must never be silent.
    const statRegime = typeof job.runStats?.regime === 'string' ? job.runStats.regime : null
    const statCubeEstimate = typeof job.runStats?.cube_estimate === 'number' ? job.runStats.cube_estimate : null
    const statBudget = typeof job.runStats?.materialize_budget === 'number' ? job.runStats.materialize_budget : null
    // Conformance advisories (identity / casing gaps) recorded in run_stats.
    // Advisory-only backend signal — a completed run can still carry these,
    // so surface them here instead of leaving a green row that scanned zero.
    const advisories = (Array.isArray((job.runStats as { advisories?: unknown } | null | undefined)?.advisories)
        ? (job.runStats as unknown as { advisories: Array<{ kind: string; severity?: string; message: string }> }).advisories
        : [])
    const isNoopRun = job.status === 'completed' && statWrites === 0 && statDeletes === 0
    // Purge rows carry the post-purge mode on their tuning payload.
    const purgeStaysEmpty = job.triggerSource === 'purge'
        && Boolean((job.tuning as Record<string, unknown> | null)?.['skip_reaggregate'])

    // Diff-to-previous computations
    const edgeDelta = previousJob && job.status === 'completed' && previousJob.status === 'completed'
        ? job.createdEdges - previousJob.createdEdges : null
    const durationDelta = previousJob && job.durationSeconds != null && previousJob.durationSeconds != null
        ? job.durationSeconds - previousJob.durationSeconds : null

    const colSpan = compact ? 8 : 9

    return (
        <>
            <tr
                onClick={() => onToggle(jobFromList.id)}
                className={cn(
                    'group border-b border-glass-border/40 cursor-pointer transition-all duration-200',
                    'hover:bg-gradient-to-r hover:from-transparent hover:via-black/[0.02] hover:to-transparent',
                    'dark:hover:via-white/[0.02]',
                    expanded && 'bg-black/[0.025] dark:bg-white/[0.025]',
                    isRunning && 'border-l-2 border-l-indigo-500/60',
                    isPending && 'border-l-2 border-l-amber-500/60',
                    job.status === 'failed' && 'border-l-2 border-l-red-500/40',
                    isTerminal && job.status !== 'failed' && 'border-l-2 border-l-transparent',
                )}
            >
                {/* Status */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    <div className="flex items-center gap-2">
                        <motion.span
                            animate={{ rotate: expanded ? 90 : 0 }}
                            transition={{ duration: 0.15 }}
                            className="flex items-center justify-center w-4 h-4 text-ink-muted/50 group-hover:text-ink-muted transition-colors"
                        >
                            <ChevronRight className="w-3 h-3" />
                        </motion.span>
                        <span className={cn(
                            'inline-flex items-center gap-1.5 px-2 py-1 rounded-md border text-[11px] font-semibold',
                            cfg.bg, cfg.color,
                        )}>
                            <StatusIcon className={cn('w-3 h-3', isRunning && 'animate-spin')} />
                            {cfg.label}
                        </span>
                    </div>
                </td>

                {/* Data Source + Provider + Workspace — hidden in compact mode */}
                {!compact && (
                    <td className="px-4 py-3">
                        <div className="space-y-1.5">
                            <div className="flex items-center gap-1.5">
                                {provType && <ProviderLogoIcon className="w-3.5 h-3.5 flex-shrink-0" />}
                                <span className="text-[13px] font-semibold text-ink leading-none truncate">
                                    {dsName}
                                </span>
                            </div>
                            <div className="flex items-center gap-1.5 text-[10px] text-ink-muted">
                                {meta?.providerName && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04]">
                                        <Server className="w-2.5 h-2.5 text-ink-muted/50" />
                                        <span className="font-medium truncate max-w-[100px]">{meta.providerName}</span>
                                    </span>
                                )}
                                {wsName && wsName !== meta?.providerName && (
                                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04]">
                                        <FolderOpen className="w-2.5 h-2.5 text-ink-muted/50" />
                                        <span className="truncate max-w-[100px]">{wsName}</span>
                                    </span>
                                )}
                            </div>
                        </div>
                    </td>
                )}

                {/* Mode */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    {(job.projectionMode ?? meta?.projectionMode) ? (
                        <span className="text-[11px] text-ink-muted font-medium">
                            {(job.projectionMode ?? meta?.projectionMode) === 'in_source' ? 'In-Source' : 'Dedicated'}
                        </span>
                    ) : <span className="text-[10px] text-ink-muted/40">{'\u2014'}</span>}
                </td>

                {/* Trigger */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    {job.triggerSource === 'purge' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-400">
                            <Trash2 className="w-3 h-3" /> Purge
                        </span>
                    ) : job.triggerSource === 'reconcile' ? (
                        // An automatic rebuild says WHY on the row itself. The
                        // reason is the whole reason this trigger source
                        // exists — "Reconciliation" alone just relocates the
                        // question.
                        <span
                            className="inline-flex items-center gap-1 text-[11px] font-semibold text-sky-600 dark:text-sky-400"
                            title={job.reconcileReason
                                ? `Automatic reconciliation — ${RECONCILE_REASON_LABEL[job.reconcileReason] ?? job.reconcileReason}`
                                : 'Queued by automatic reconciliation'}
                        >
                            <ShieldCheck className="w-3 h-3 shrink-0" />
                            <span className="truncate">
                                {job.reconcileReason
                                    ? RECONCILE_REASON_LABEL[job.reconcileReason] ?? 'Reconciliation'
                                    : 'Reconciliation'}
                            </span>
                        </span>
                    ) : (
                        <span className="text-[11px] text-ink-muted">{triggerLabel(job.triggerSource)}</span>
                    )}
                </td>

                {/* Progress */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    {job.triggerSource === 'purge' ? (
                        <span className="text-[11px] text-ink-muted/40">{'\u2014'}</span>
                    ) : isRunning && job.totalEdges > 0 ? (
                        <div className="w-20">
                            <div className="flex items-center justify-between mb-0.5">
                                <span className="text-[10px] font-bold text-indigo-400 tabular-nums">{job.progress}%</span>
                            </div>
                            <div className="w-full h-1.5 bg-indigo-500/10 rounded-full overflow-hidden">
                                <motion.div
                                    className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full"
                                    animate={{ width: `${Math.min(100, job.progress)}%` }}
                                    transition={{ duration: 0.6, ease: 'easeOut' }}
                                />
                            </div>
                        </div>
                    ) : job.edgeCoveragePct != null ? (
                        <span className={cn(
                            'text-[11px] font-semibold tabular-nums',
                            job.edgeCoveragePct >= 100 ? 'text-emerald-500' : job.edgeCoveragePct >= 50 ? 'text-amber-500' : 'text-ink-muted',
                        )}>
                            {job.edgeCoveragePct}%
                        </span>
                    ) : <span className="text-[11px] text-ink-muted/40">{'\u2014'}</span>}
                </td>

                {/* Edges */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    {job.triggerSource === 'purge' ? (
                        <span className="text-[11px] text-red-400/80 font-medium tabular-nums">
                            {job.processedEdges.toLocaleString()} purged
                        </span>
                    ) : (
                        <div className="space-y-0.5">
                            <span className="text-[11px] text-ink tabular-nums font-medium block">
                                {job.processedEdges.toLocaleString()}{job.totalEdges > 0 ? ` / ${job.totalEdges.toLocaleString()}` : ''}
                            </span>
                            {job.status === 'completed' && (
                                statWrites != null || statDeletes != null ? (
                                    isNoopRun ? (
                                        <Tip label={`Graph already matched the computed result — ${job.createdEdges.toLocaleString()} aggregated edges verified, nothing rewritten`}>
                                            <span className="text-[10px] text-emerald-500/80 font-medium block">
                                                verified · no changes
                                            </span>
                                        </Tip>
                                    ) : (
                                        <Tip label={`${job.createdEdges.toLocaleString()} aggregated edges in graph after this run`}>
                                            <span className="block space-x-1.5">
                                                {statWrites != null && statWrites > 0 && (
                                                    <span className="text-[10px] text-emerald-500 font-semibold tabular-nums">
                                                        +{statWrites.toLocaleString()} written
                                                    </span>
                                                )}
                                                {statDeletes != null && statDeletes > 0 && (
                                                    <span className="text-[10px] text-amber-500 font-semibold tabular-nums">
                                                        {'\u2212'}{statDeletes.toLocaleString()} removed
                                                    </span>
                                                )}
                                            </span>
                                        </Tip>
                                    )
                                ) : job.createdEdges > 0 ? (
                                    <span className="text-[10px] text-emerald-500 font-semibold block tabular-nums">
                                        +{job.createdEdges.toLocaleString()} materialized
                                    </span>
                                ) : null
                            )}
                            {isRunning && liveWrites != null && liveWrites > 0 && (
                                <span className="text-[10px] text-emerald-500 font-semibold block tabular-nums">
                                    +{liveWrites.toLocaleString()} written
                                </span>
                            )}
                            {isRunning && liveDeletes != null && liveDeletes > 0 && (
                                <span className="text-[10px] text-amber-500 font-semibold block tabular-nums">
                                    {'−'}{liveDeletes.toLocaleString()} reconciled
                                </span>
                            )}
                        </div>
                    )}
                </td>

                {/* Duration */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    <span className="text-[11px] text-ink-muted tabular-nums">{formatDuration(job.durationSeconds)}</span>
                </td>

                {/* Started */}
                <td className={cn('px-4', compact ? 'py-2' : 'py-3')}>
                    <span className="text-[11px] text-ink-muted" title={job.startedAt ? new Date(job.startedAt).toLocaleString() : job.createdAt}>
                        {timeAgo(job.startedAt ?? job.createdAt)}
                    </span>
                </td>

                {/* Actions */}
                <td className={cn('px-4 text-right', compact ? 'py-1.5' : 'py-2.5')}>
                    <div className="flex items-center justify-end gap-0.5" onClick={e => e.stopPropagation()}>
                        {canCancel && (
                            <Tip label="Cancel job">
                                <button onClick={() => onCancel(job)} disabled={actionLoading}
                                    className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                                    {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
                                </button>
                            </Tip>
                        )}
                        {canResume && (
                            <Tip label="Resume from checkpoint">
                                <button onClick={() => onResume(job)} disabled={actionLoading}
                                    className="p-1.5 rounded-lg text-indigo-400 hover:bg-indigo-500/10 transition-colors disabled:opacity-40">
                                    {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                </button>
                            </Tip>
                        )}
                        {isTerminal && (
                            <>
                                <Tip label="Re-trigger aggregation">
                                    <button onClick={() => onRetrigger(job)} disabled={actionLoading}
                                        className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40">
                                        {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                    </button>
                                </Tip>
                                <Tip label="Delete from history">
                                    <button onClick={() => onDelete(job)} disabled={actionLoading}
                                        className="p-1.5 rounded-lg text-ink-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                                        {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                    </button>
                                </Tip>
                            </>
                        )}
                    </div>
                </td>
            </tr>

            {/* Expanded detail panel */}
            <AnimatePresence>
                {expanded && (
                    <tr>
                        <td colSpan={colSpan} className="p-0">
                            <motion.div
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.25, ease: [0.4, 0, 0.2, 1] }}
                                className="overflow-hidden"
                            >
                                <div className={cn(
                                    'mx-3 my-2 rounded-2xl border overflow-hidden',
                                    'bg-gradient-to-b from-canvas to-canvas-elevated',
                                    job.status === 'failed' ? 'border-red-500/20' :
                                    isRunning ? 'border-indigo-500/20' :
                                    job.status === 'completed' ? 'border-emerald-500/15' :
                                    'border-glass-border/60',
                                )}>
                                    <div className={cn(
                                        'h-0.5',
                                        job.status === 'failed' ? 'bg-gradient-to-r from-red-500/80 via-red-500/40 to-transparent' :
                                        isRunning ? 'bg-gradient-to-r from-indigo-500/80 via-violet-500/40 to-transparent' :
                                        job.status === 'completed' ? 'bg-gradient-to-r from-emerald-500/80 via-emerald-500/40 to-transparent' :
                                        'bg-gradient-to-r from-zinc-500/30 to-transparent',
                                    )} />

                                    <div className="p-5 space-y-4">
                                        {/* Header row */}
                                        <div className="flex items-start justify-between">
                                            <div className="space-y-1.5">
                                                <div className="flex items-center gap-1.5">
                                                    <ProviderLogoIcon className="w-4 h-4 flex-shrink-0" />
                                                    <h3 className="text-sm font-bold text-ink">{dsName}</h3>
                                                </div>
                                                <div className="flex items-center gap-1.5 text-[10px] text-ink-muted">
                                                    {meta?.providerName && (
                                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04]">
                                                            <Server className="w-2.5 h-2.5 text-ink-muted/50" />
                                                            <span className="font-medium">{meta.providerName}</span>
                                                        </span>
                                                    )}
                                                    {wsName && wsName !== meta?.providerName && (
                                                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-black/[0.03] dark:bg-white/[0.04]">
                                                            <FolderOpen className="w-2.5 h-2.5 text-ink-muted/50" />
                                                            <span>{wsName}</span>
                                                        </span>
                                                    )}
                                                    {meta?.graphName && (
                                                        <span className="font-mono text-ink-muted/50">{meta.graphName}</span>
                                                    )}
                                                </div>
                                            </div>
                                            <span className="font-mono text-[10px] text-ink-muted/50 select-all">{job.id}</span>
                                        </div>

                                        {/* Progress bar (running / pending) */}
                                        {(isRunning || isPending) && (job.totalEdges > 0 || hasSteps) && (
                                            <div className="space-y-2">
                                                <div className="flex items-center justify-between">
                                                    <div className="flex items-center gap-2">
                                                        <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                                        <span className="text-[11px] font-semibold text-ink">
                                                            {isRunning ? phaseLabel(openStepId ?? job.currentPhase) : 'Queued'}
                                                        </span>
                                                    </div>
                                                    <span className="text-[12px] font-bold text-indigo-400 tabular-nums">
                                                        {job.progress}%
                                                    </span>
                                                </div>
                                                <div className="w-full h-2 bg-indigo-500/[0.07] rounded-full overflow-hidden">
                                                    <motion.div
                                                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 via-violet-500 to-indigo-400"
                                                        initial={{ width: 0 }}
                                                        animate={{ width: `${Math.min(100, job.progress)}%` }}
                                                        transition={{ duration: 0.8, ease: 'easeOut' }}
                                                    />
                                                </div>
                                                <div className="flex items-center justify-between text-[10px] text-ink-muted">
                                                    <span className="tabular-nums">
                                                        {job.totalEdges > 0 && (
                                                            job.currentPhase === 'extracting' || !job.currentPhase ? (
                                                                <>{job.processedEdges.toLocaleString()} / {job.totalEdges.toLocaleString()} edges scanned</>
                                                            ) : (
                                                                <>{job.totalEdges.toLocaleString()} edges scanned</>
                                                            )
                                                        )}
                                                        {(liveWrites ?? 0) > 0 && (
                                                            <span className="text-emerald-500 ml-1.5">
                                                                +{(liveWrites as number).toLocaleString()} written
                                                            </span>
                                                        )}
                                                        {(liveDeletes ?? 0) > 0 && (
                                                            <span className="text-amber-500 ml-1.5">
                                                                {'\u2212'}{(liveDeletes as number).toLocaleString()} removed
                                                            </span>
                                                        )}
                                                    </span>
                                                    {(() => {
                                                        const hist = historicalEta(job, previousJob)
                                                        const eta = hist ?? job.estimatedCompletionAt
                                                        if (!eta) return null
                                                        return (
                                                            <Tip label={hist
                                                                ? 'Projected from the previous run\u2019s per-phase durations on this data source'
                                                                : 'Linear projection from phase-weighted progress'}>
                                                                <span>
                                                                    est. finish {new Date(eta).toLocaleTimeString()}
                                                                    {hist && narrowing && adaptedNow?.scan_width != null && (
                                                                        <span className="text-amber-500"> {'\u2014'} slower than last time: the scans narrowed</span>
                                                                    )}
                                                                </span>
                                                            </Tip>
                                                        )
                                                    })()}
                                                </div>
                                                {(isRunning || hasSteps) && (
                                                    <PhaseStepper
                                                        currentPhase={openStepId ?? job.currentPhase}
                                                        runStats={job.runStats}
                                                        status={job.status}
                                                    />
                                                )}
                                                {isRunning && steady && (
                                                    <div
                                                        data-testid="steady-load"
                                                        className={cn(
                                                            'rounded-xl border px-4 py-3',
                                                            steady.tone === 'steady'
                                                                ? 'bg-black/[0.02] dark:bg-white/[0.02] border-glass-border'
                                                                : 'bg-amber-500/[0.05] border-amber-500/15',
                                                        )}
                                                    >
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <Gauge className={cn('w-3.5 h-3.5', steady.tone === 'steady' ? 'text-ink-muted' : 'text-amber-400')} aria-hidden="true" />
                                                            <span className={cn('text-[10px] font-bold uppercase tracking-wider', steady.tone === 'steady' ? 'text-ink-muted' : 'text-amber-500/90')}>
                                                                {steady.title}
                                                            </span>
                                                        </div>
                                                        <p className={cn('text-[11px] leading-relaxed', steady.tone === 'steady' ? 'text-ink-secondary' : 'text-amber-500/90')}>
                                                            {steady.detail}
                                                        </p>
                                                    </div>
                                                )}
                                                {narrowing && adaptedNow && (
                                                    <div
                                                        data-testid="narrowing-state"
                                                        className="rounded-xl bg-amber-500/[0.05] border border-amber-500/15 px-4 py-3"
                                                    >
                                                        <div className="flex items-center gap-2 mb-1">
                                                            <Gauge className="w-3.5 h-3.5 text-amber-400" aria-hidden="true" />
                                                            <span className="text-[10px] font-bold text-amber-500/90 uppercase tracking-wider">Going slower to fit the graph store</span>
                                                        </div>
                                                        <p className="text-[11px] text-amber-500/90 leading-relaxed">
                                                            {[
                                                                adaptedNow.scan_width != null ? `scans narrowed to ${adaptedNow.scan_width.toLocaleString()} rows` : null,
                                                                adaptedNow.extract_concurrency != null ? `reading ${adaptedNow.extract_concurrency === 1 ? 'serially' : `${adaptedNow.extract_concurrency} at a time`}` : null,
                                                                adaptedNow.reconcile_strategy === 'keys_only' ? 'keys-only reconcile' : null,
                                                                adaptedNow.write_batch != null ? `write batch ${adaptedNow.write_batch.toLocaleString()}` : null,
                                                                adaptedNow.timeout_retries ? `${adaptedNow.timeout_retries} timeout ${adaptedNow.timeout_retries === 1 ? 'retry' : 'retries'}` : null,
                                                            ].filter(Boolean).join(' \u00b7 ')}
                                                        </p>
                                                        <p className="mt-1 text-[10px] text-ink-muted">
                                                            The store refused a query for size or time, so the rebuild reads less per query until each one fits. It keeps going — only a single row too large for the per-query ceiling can stop it.
                                                        </p>
                                                    </div>
                                                )}
                                            </div>
                                        )}

                                        {/* Why an automatic reconciliation queued
                                            this — the counts that justified it,
                                            in the operator's own units. This is
                                            the same evidence the Freshness
                                            drawer shows, reached from the other
                                            end of the trail. */}
                                        {job.triggerSource === 'reconcile' && (
                                            <ReconcileWhy
                                                reason={job.reconcileReason}
                                                evidence={job.reconcileEvidence}
                                                dataSourceId={job.dataSourceId}
                                            />
                                        )}

                                        {/* Stat grid */}
                                        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
                                            <StatCell
                                                label="Trigger"
                                                value={triggerLabel(job.triggerSource)}
                                            />
                                            <StatCell label="Settings" value={
                                                job.triggerSource === 'purge' ? '\u2014' : (
                                                    <button
                                                        type="button"
                                                        onClick={(e) => { e.stopPropagation(); setShowSettings(s => !s) }}
                                                        aria-expanded={showSettings}
                                                        aria-controls={`run-settings-${job.id}`}
                                                        className="inline-flex items-center gap-1 text-left hover:text-indigo-500 transition-colors"
                                                    >
                                                        <span className="truncate">
                                                            {presetLabel ?? (job.runStats?.effective_tuning ? 'Custom' : job.tuning ? 'Self-tuning' : job.batchSize.toLocaleString())}
                                                        </span>
                                                        <ChevronDown className={cn('w-3 h-3 flex-shrink-0 transition-transform', showSettings && 'rotate-180')} aria-hidden="true" />
                                                    </button>
                                                )
                                            } />
                                            <StatCell label="Worker" value={
                                                job.workerId
                                                    ? <span className="block truncate" title={job.workerId}>{job.workerId}</span>
                                                    : '\u2014'
                                            } />
                                            <StatCell label="Duration" value={
                                                <span className="flex items-center gap-1">
                                                    {formatDuration(job.durationSeconds)}
                                                    {durationDelta != null && durationDelta !== 0 && (
                                                        <span className={cn('text-[9px] font-bold', durationDelta > 0 ? 'text-red-400' : 'text-emerald-400')}>
                                                            {durationDelta > 0 ? '+' : ''}{formatDuration(durationDelta)}
                                                        </span>
                                                    )}
                                                </span>
                                            } />
                                            {job.triggerSource !== 'purge' && (
                                                <StatCell label="Retries" value={
                                                    <span className="flex items-center gap-1.5">
                                                        {job.retryCount}
                                                        {job.resumable && (
                                                            <span className="px-1 py-0.5 rounded bg-indigo-500/10 text-[8px] font-bold text-indigo-400 uppercase leading-none">
                                                                resumable
                                                            </span>
                                                        )}
                                                    </span>
                                                } />
                                            )}
                                            <StatCell
                                                label={job.triggerSource === 'purge' ? 'Purged' : 'In graph'}
                                                value={
                                                    job.triggerSource === 'purge'
                                                        ? <span className="text-red-400">{job.processedEdges.toLocaleString()}</span>
                                                        : job.createdEdges > 0
                                                            ? <span className="flex items-center gap-1">
                                                                <span className="text-emerald-400">{job.createdEdges.toLocaleString()}</span>
                                                                {edgeDelta != null && edgeDelta !== 0 && (
                                                                    <span className={cn('text-[9px] font-bold', edgeDelta > 0 ? 'text-emerald-400' : 'text-red-400')}>
                                                                        {edgeDelta > 0 ? '+' : ''}{edgeDelta.toLocaleString()}
                                                                    </span>
                                                                )}
                                                              </span>
                                                            : job.status === 'completed' ? '0' : '\u2014'
                                                }
                                            />
                                            {job.triggerSource !== 'purge' && job.status === 'completed'
                                                && (statWrites != null || statDeletes != null) && (
                                                <StatCell
                                                    label="This run"
                                                    value={
                                                        isNoopRun
                                                            ? <span className="text-emerald-500/80">verified {'\u00b7'} no changes</span>
                                                            : <span className="space-x-1.5">
                                                                {statWrites != null && statWrites > 0 && (
                                                                    <span className="text-emerald-400">+{statWrites.toLocaleString()}</span>
                                                                )}
                                                                {statDeletes != null && statDeletes > 0 && (
                                                                    <span className="text-amber-400">{'\u2212'}{statDeletes.toLocaleString()}</span>
                                                                )}
                                                              </span>
                                                    }
                                                />
                                            )}
                                            {job.triggerSource === 'purge' && (
                                                <StatCell
                                                    label="After purge"
                                                    value={
                                                        purgeStaysEmpty
                                                            ? <span className="text-amber-400">Stays empty</span>
                                                            : <span className="text-indigo-400">Auto re-aggregate</span>
                                                    }
                                                />
                                            )}
                                            {job.triggerSource !== 'purge' && statRegime && (
                                                <StatCell
                                                    label="Storage"
                                                    value={
                                                        <Tip label={
                                                            statRegime === 'cube'
                                                                ? 'Every ancestor combination is materialized — all canvas granularities answer from storage.'
                                                                : `Full detail would be ~${(statCubeEstimate ?? 0).toLocaleString()} edges — over the cube ceiling, or more than the ${(statBudget ?? 0).toLocaleString()} new edges the graph-store shard had room for, so only the canonical depth-diagonal is stored and finer granularities are derived on demand. Force full detail in Advanced tuning to pre-create everything; it fails loudly if the shard cannot hold it.`
                                                        }>
                                                            {statRegime === 'cube'
                                                                ? <span className="text-emerald-400">Full detail</span>
                                                                : <span className="text-amber-400">Diagonal {'·'} on-demand</span>}
                                                        </Tip>
                                                    }
                                                />
                                            )}
                                        </div>

                                        {/* More time, or a gentler shape, for a job that is still going */}
                                        {(isRunning || isPending) && onExtend && job.triggerSource !== 'purge' && (
                                            <AdjustRunningJob job={job} onAdjust={onExtend} busy={actionLoading} />
                                        )}

                                        {/* What this run ran with, and what it adapted to */}
                                        {showSettings && job.triggerSource !== 'purge' && (
                                            <div id={`run-settings-${job.id}`}>
                                                <RunSettingsPanel job={job} storedGlobal={storedGlobal} live={liveAdapted} />
                                            </div>
                                        )}

                                        {/* What the run did, stage by stage. A FAILED or CANCELLED
                                            run gets this too now: its ledger names the stage it died
                                            in and what that stage had got through, which is the first
                                            question anyone asks of a failure. */}
                                        {isTerminal && job.runStats
                                            && (hasSteps || PHASES.some(p => job.runStats?.[p.statKey] != null)) && (
                                            <div className="rounded-lg bg-black/[0.02] dark:bg-white/[0.02] px-3 py-2.5">
                                                <PhaseStepper
                                                    currentPhase={null}
                                                    runStats={job.runStats}
                                                    status={job.status}
                                                />
                                            </div>
                                        )}

                                        {/* Conformance advisories — why a run scanned/wrote fewer
                                            edges than expected (identity or edge-type casing gap). */}
                                        {advisories.length > 0 && (
                                            <div className="space-y-1.5">
                                                {advisories.map((adv, i) => {
                                                    const isError = adv.severity === 'error'
                                                    return (
                                                        <div
                                                            key={`${adv.kind}-${i}`}
                                                            className={cn(
                                                                'flex items-start gap-2 rounded-lg px-3 py-2 border',
                                                                isError
                                                                    ? 'bg-red-500/[0.06] border-red-500/20'
                                                                    : 'bg-amber-500/[0.06] border-amber-500/20',
                                                            )}
                                                        >
                                                            {isError
                                                                ? <AlertCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0 mt-0.5" />
                                                                : <AlertTriangle className="w-3.5 h-3.5 text-amber-500 flex-shrink-0 mt-0.5" />}
                                                            <p className={cn(
                                                                'text-[11px] leading-relaxed',
                                                                isError
                                                                    ? 'text-red-600/90 dark:text-red-400/90'
                                                                    : 'text-amber-600/90 dark:text-amber-400/90',
                                                            )}>
                                                                {adv.message}
                                                            </p>
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        )}

                                        {/* Timeline */}
                                        <div className="flex items-center gap-3 text-[10px] text-ink-muted border-t border-glass-border/30 pt-3">
                                            <span>Created {new Date(job.createdAt).toLocaleString()}</span>
                                            {job.startedAt && (
                                                <>
                                                    <span className="text-ink-muted/20">{'\u2192'}</span>
                                                    <span>Started {new Date(job.startedAt).toLocaleString()}</span>
                                                </>
                                            )}
                                            {job.completedAt && (
                                                <>
                                                    <span className="text-ink-muted/20">{'\u2192'}</span>
                                                    <span>
                                                        {job.status === 'completed' ? 'Completed' :
                                                         job.status === 'failed' ? 'Failed' : 'Ended'}{' '}
                                                        {new Date(job.completedAt).toLocaleString()}
                                                    </span>
                                                </>
                                            )}
                                            {job.lastCheckpointAt && isRunning && (
                                                <span className="ml-auto flex items-center gap-1">
                                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                                                    Checkpoint {timeAgo(job.lastCheckpointAt)}
                                                </span>
                                            )}
                                        </div>

                                        {/* Waiting (routine park on a running job — not a failure) */}
                                        {job.errorMessage && isRunning && job.errorMessage.startsWith('Quiesce') && (
                                            <div className="rounded-xl bg-amber-500/[0.05] border border-amber-500/15 p-4">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                                                    <span className="text-[10px] font-bold text-amber-500/90 uppercase tracking-wider">Waiting for the graph</span>
                                                </div>
                                                <p className="text-[11px] text-amber-500/90 leading-relaxed">
                                                    {job.errorMessage}
                                                </p>
                                                <p className="mt-1.5 text-[10px] text-ink-muted">
                                                    Writes to one graph are serialized across the fleet. This job resumes automatically when the current writer finishes; a lease whose job has already ended is broken automatically.
                                                </p>
                                            </div>
                                        )}
                                        {/* Error */}
                                        {job.errorMessage && !(isRunning && job.errorMessage.startsWith('Quiesce')) && (
                                            <div className="rounded-xl bg-red-500/[0.04] border border-red-500/10 p-4">
                                                <div className="flex items-center gap-2 mb-2">
                                                    <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                                                    <span className="text-[10px] font-bold text-red-400/80 uppercase tracking-wider">Error Detail</span>
                                                </div>
                                                <pre className="text-[11px] font-mono text-red-400/80 break-words whitespace-pre-wrap leading-relaxed">
                                                    {job.errorMessage}
                                                </pre>
                                                {job.errorMessage.includes('Max retries exceeded') && (
                                                    <p className="mt-2 text-[10px] text-amber-400/80 flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                                        Likely caused by server restarts during processing, not a job logic failure.
                                                    </p>
                                                )}
                                                {job.errorMessage.includes('write budget:') && (
                                                    <p className="mt-2 text-[10px] text-amber-400/80 flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                                        The rebuild measured the graph-store shard that owns this graph and refused before writing: the rollups would not fit. The message above names the shard, what they need, what was free and the shortfall — deterministic, so the job was not retried. Set Rollup storage to Auto, free or add memory on that shard, or adjust Shard memory reserve, Bytes per rollup edge or the Edge ceiling in tuning if the headroom is real.
                                                    </p>
                                                )}
                                                {job.errorMessage.includes('write lease held') && (
                                                    <p className="mt-2 text-[10px] text-amber-400/80 flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                                        Another job was writing to the same graph — this job parked and retried automatically. If the named holder is stale, its lease expires on its own.
                                                    </p>
                                                )}
                                                {job.errorMessage.includes('mem consumption exceeded') && (
                                                    <p className="mt-2 text-[10px] text-amber-400/80 flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                                        One query asked the graph store for more than a single query may hold{typeof job.runStats?.query_mem_capacity === 'number' ? ` (${(job.runStats.query_mem_capacity / 2 ** 20).toFixed(0)} MB)` : ''}. The store is healthy — this is not an outage. The rebuild had already dropped to serial reads, switched strategy and narrowed to a single row, so that one row is larger than the per-query ceiling. Raise QUERY_MEM_CAPACITY together with the container memory limit; the Gentle profile and Auto rollup storage lighten every query before this point but cannot shrink one row.
                                                    </p>
                                                )}
                                                {job.errorMessage.includes('treating as a graph-store outage') && (
                                                    <p className="mt-2 text-[10px] text-amber-400/80 flex items-center gap-1.5">
                                                        <AlertTriangle className="w-3 h-3 flex-shrink-0" />
                                                        The graph store stopped answering: the narrowest scan kept timing out through every backoff retry. Check the store, then Resume from the checkpoint. If it is merely slow, raise the scan timeout in Advanced tuning (the store caps it at its TIMEOUT_MAX), or re-trigger with the Gentle profile.
                                                    </p>
                                                )}
                                            </div>
                                        )}

                                        {/* Purge action */}
                                        {isTerminal && job.createdEdges > 0 && job.triggerSource !== 'purge' && (
                                            <div className="border-t border-glass-border/30 pt-3">
                                                {!isPurging ? (
                                                    <button
                                                        onClick={() => setPurgeConfirm(job.id)}
                                                        className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted/60 hover:text-red-400 transition-colors duration-200"
                                                    >
                                                        <Trash2 className="w-3 h-3" />
                                                        Purge {job.createdEdges.toLocaleString()} aggregated edges from graph
                                                    </button>
                                                ) : (
                                                    <motion.div
                                                        initial={{ opacity: 0, y: -4 }}
                                                        animate={{ opacity: 1, y: 0 }}
                                                        className="flex items-center gap-3 p-3 rounded-xl bg-red-500/[0.04] border border-red-500/15"
                                                    >
                                                        <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0" />
                                                        <span className="text-[11px] text-red-400 flex-1">
                                                            Remove all materialized edges? A re-aggregation job starts automatically when the purge completes (use the Assets tab purge for a stay-empty option).
                                                        </span>
                                                        <button
                                                            onClick={() => onPurge(job)}
                                                            disabled={actionLoading}
                                                            className="px-3 py-1.5 rounded-lg text-[11px] font-bold bg-red-500 text-white hover:bg-red-600 transition-all shadow-sm shadow-red-500/20 disabled:opacity-40"
                                                        >
                                                            {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm Purge'}
                                                        </button>
                                                        <button onClick={() => setPurgeConfirm(null)} className="text-[11px] text-ink-muted hover:text-ink transition-colors">
                                                            Cancel
                                                        </button>
                                                    </motion.div>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </motion.div>
                        </td>
                    </tr>
                )}
            </AnimatePresence>
        </>
    )
})
