/**
 * IntegrityPulse — the Freshness tab's briefing: is watching alive, what is
 * the schedule, does anyone need to act, and when did drift last happen.
 *
 * The whole card goes amber when sweeps have stopped, because a frozen
 * verdict looks current. Overnight history is one sentence — the blotter
 * opens on click. Cadence opens from the spoken "every N minutes".
 */
import type { ReactNode } from 'react'
import {
    AlertTriangle, ChevronRight, CircleDashed, Eye, Loader2, RefreshCw, ShieldCheck, Unplug,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TimeStamp } from '@/components/ui/TimeStamp'
import type { FreshnessSummary, ReconcilePolicy, ReconcileRun } from '@/services/freshnessService'
import type { StatusFacet } from './freshnessTriage'
import { DRIFT_SPEC } from './DriftStateBadge'
import {
    formatCheckInterval, formatClockTime, formatHorizon, lastPassBrief,
    nextCheckAt, policyWord, sweepsHaveStopped,
    type RepeatOffender,
} from './reconcileHealth'

export function IntegrityPulse({
    summary, policy, latestRun, lastPassRun, isError, isLoading, isAdmin,
    onCheckNow, checking, onPreview, onFacet, activeFacet, onOpenCadence,
    lastDriftAt: lastDriftIso, historyOpen, onToggleHistory, historyPanel,
    offenders, onOpenSource,
}: {
    summary: FreshnessSummary | null | undefined
    policy: ReconcilePolicy | undefined
    /** Newest run of any kind — empty ticks prove the sweeper is alive. */
    latestRun: ReconcileRun | undefined
    /** Last run that scanned someone — drives "last / next" and the pass line. */
    lastPassRun?: ReconcileRun | undefined
    isError: boolean
    isLoading: boolean
    isAdmin: boolean
    onCheckNow: () => void
    checking: boolean
    onPreview: () => void
    onFacet: (facet: StatusFacet) => void
    activeFacet: StatusFacet
    /** Opens Cadence — only for admins; the schedule sentence is still visible. */
    onOpenCadence?: () => void
    /** Newest finding in the week, or null when none. */
    lastDriftAt?: string | null
    historyOpen?: boolean
    onToggleHistory?: () => void
    /** Expanded blotter — rendered under the recency line when open. */
    historyPanel?: ReactNode
    /** Repeat rebuilds this week — shown only while history is closed. */
    offenders?: RepeatOffender[]
    onOpenSource?: (id: string) => void
}) {
    const enabled = policy?.enabled ?? policy?.envEnabled ?? true
    const interval = policy?.checkIntervalSecs ?? policy?.envCheckIntervalSecs ?? 3600
    // Liveness (stopped?) uses any tick; "next in" uses the last real pass.
    const aliveAt = latestRun?.startedAt
    const passAt = lastPassRun?.startedAt ?? aliveAt
    const stopped = enabled && sweepsHaveStopped(aliveAt, interval)
    const next = nextCheckAt(passAt, interval)
    const nextMs = next ? next.getTime() - Date.now() : null
    const drifting = summary?.drifting ?? 0
    const suspended = summary?.suspended ?? 0
    // Shown only when it is non-zero: a permanent third zero would dilute a
    // line that is read at a glance, and this state is rare and red.
    const stalled = summary?.projectionStalled ?? 0
    const word = policyWord(policy?.enabled, policy?.envEnabled ?? true)
    const intervalLabel = formatCheckInterval(interval)
    const brief = lastPassRun ? lastPassBrief(lastPassRun) : null
    const showOffenders = !historyOpen && (offenders?.length ?? 0) > 0
    const topOffenders = (offenders ?? []).slice(0, 2)
    const moreOffenders = Math.max(0, (offenders?.length ?? 0) - topOffenders.length)

    if (isError) {
        return (
            <div
                role="alert"
                className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300"
            >
                Could not load overlay integrity. The fleet table below may still be current.
            </div>
        )
    }

    return (
        <div
            className={cn(
                'rounded-xl border px-4 py-3.5',
                stopped
                    ? 'border-amber-500/40 bg-amber-500/[0.07]'
                    : 'border-glass-border/80 bg-canvas',
            )}
        >
            <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
                <ShieldCheck className={cn(
                    'w-4 h-4 shrink-0 mt-0.5',
                    stopped ? 'text-amber-600 dark:text-amber-400'
                        : enabled ? 'text-emerald-500' : 'text-slate-400',
                )} />
                <div className="min-w-0 flex-1 space-y-1">
                    <p className="text-sm font-semibold text-ink">{word}</p>
                    {enabled ? (
                        <p className="text-[13px] text-ink-secondary leading-snug">
                            Checks{' '}
                            {onOpenCadence ? (
                                <button
                                    type="button"
                                    onClick={onOpenCadence}
                                    className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                                >
                                    every {intervalLabel}
                                </button>
                            ) : (
                                <span className="font-semibold text-ink">every {intervalLabel}</span>
                            )}
                            .
                            {passAt ? (
                                <>
                                    {' '}Last check{' '}
                                    <TimeStamp at={passAt} icon={null} colorByAge={false} className="text-[13px] text-ink-secondary" />
                                    .
                                </>
                            ) : (
                                <> Not yet run.</>
                            )}
                            {next && nextMs != null && nextMs > 0 && !stopped && (
                                <>
                                    {' '}Next at {formatClockTime(next)}{' '}
                                    <span className="text-ink-muted">(in {formatHorizon(nextMs)})</span>.
                                </>
                            )}
                        </p>
                    ) : (
                        <p className="text-[13px] text-ink-secondary leading-snug">
                            Not watching. Drift is still detected; nothing is rebuilt automatically.
                            {passAt && (
                                <>
                                    {' '}Last check{' '}
                                    <TimeStamp at={passAt} icon={null} colorByAge={false} className="text-[13px] text-ink-secondary" />
                                    .
                                </>
                            )}
                        </p>
                    )}
                </div>

                {stopped && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                        <AlertTriangle className="w-3 h-3 shrink-0" /> Sweeps have stopped
                    </span>
                )}
                {enabled && !passAt && !isLoading && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20">
                        <CircleDashed className="w-3 h-3 shrink-0" /> Not yet run
                    </span>
                )}

                {isAdmin && (
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                        <button
                            type="button"
                            onClick={onCheckNow}
                            disabled={checking}
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 transition-colors disabled:opacity-50"
                        >
                            {checking
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <RefreshCw className="w-3.5 h-3.5" />}
                            Check now
                        </button>
                        <button
                            type="button"
                            onClick={onPreview}
                            className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                        >
                            <Eye className="w-3.5 h-3.5" />
                            Preview
                        </button>
                    </div>
                )}
            </div>

            <div className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[13px] text-ink-secondary">
                <button
                    type="button"
                    aria-pressed={activeFacet === 'drifting'}
                    onClick={() => onFacet(activeFacet === 'drifting' ? '' : 'drifting')}
                    className={cn(
                        'rounded-md px-1 -mx-1 font-semibold tabular-nums',
                        drifting > 0 ? 'text-rose-700 dark:text-rose-300' : 'text-ink-secondary',
                        activeFacet === 'drifting' && 'underline',
                    )}
                >
                    {drifting.toLocaleString()} drifting now
                </button>
                <button
                    type="button"
                    aria-pressed={activeFacet === 'suspended'}
                    onClick={() => onFacet(activeFacet === 'suspended' ? '' : 'suspended')}
                    className={cn(
                        'rounded-md px-1 -mx-1 font-semibold tabular-nums',
                        suspended > 0 ? 'text-amber-800 dark:text-amber-300' : 'text-ink-secondary',
                        activeFacet === 'suspended' && 'underline',
                    )}
                >
                    {suspended.toLocaleString()} held by the breaker
                </button>
                {stalled > 0 && (
                    <button
                        type="button"
                        aria-pressed={activeFacet === 'projectionStalled'}
                        onClick={() => onFacet(activeFacet === 'projectionStalled' ? '' : 'projectionStalled')}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-md px-1 -mx-1 font-semibold tabular-nums',
                            'text-red-700 dark:text-red-300',
                            activeFacet === 'projectionStalled' && 'underline',
                        )}
                    >
                        <Unplug className="w-3.5 h-3.5 shrink-0" />
                        {stalled.toLocaleString()} with {DRIFT_SPEC.projectionStalled.label.toLowerCase()}
                    </button>
                )}
                {brief && (
                    <span className="text-ink-muted tabular-nums">{brief}</span>
                )}
            </div>

            {onToggleHistory && (
                <div className="mt-2.5">
                    <button
                        type="button"
                        aria-expanded={historyOpen ?? false}
                        aria-controls="drift-history-panel"
                        onClick={onToggleHistory}
                        className={cn(
                            'inline-flex items-center gap-1 rounded-md px-1 -mx-1 text-[13px]',
                            'text-indigo-600 dark:text-indigo-400 font-medium',
                            'outline-none hover:underline',
                            'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                        )}
                    >
                        {lastDriftIso ? (
                            <>
                                Last drift{' '}
                                <TimeStamp at={lastDriftIso} icon={null} colorByAge={false} className="text-[13px] font-medium text-indigo-600 dark:text-indigo-400" />
                            </>
                        ) : (
                            'No drift in 7 days'
                        )}
                        <ChevronRight
                            className={cn(
                                'w-3.5 h-3.5 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                                historyOpen && 'rotate-90',
                            )}
                            aria-hidden="true"
                        />
                    </button>
                    {showOffenders && (
                        <p className="mt-1.5 text-[12px] text-ink-muted leading-snug px-1">
                            {topOffenders.map((o, i) => (
                                <span key={o.dataSourceId}>
                                    {i > 0 && <span className="text-ink-muted/50"> · </span>}
                                    <button
                                        type="button"
                                        onClick={() => onOpenSource?.(o.dataSourceId)}
                                        className="font-semibold text-ink hover:text-indigo-600 dark:hover:text-indigo-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                                    >
                                        {o.name}
                                    </button>
                                    {i === 0 && o.rebuilt >= 2 && (
                                        <span> rebuilt {o.rebuilt.toLocaleString()} times this week</span>
                                    )}
                                </span>
                            ))}
                            {moreOffenders > 0 && onToggleHistory && (
                                <>
                                    <span className="text-ink-muted/50"> · </span>
                                    <button
                                        type="button"
                                        onClick={onToggleHistory}
                                        className="font-semibold text-indigo-600 dark:text-indigo-400 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                                    >
                                        {moreOffenders.toLocaleString()} more
                                    </button>
                                </>
                            )}
                        </p>
                    )}
                    {historyOpen && historyPanel != null && (
                        <div
                            id="drift-history-panel"
                            className="mt-2.5 motion-reduce:animate-none animate-in fade-in slide-in-from-top-1 duration-100"
                        >
                            {historyPanel}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}
