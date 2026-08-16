/**
 * IntegrityPulse — the Freshness tab's identity: are the overlays intact,
 * is the sweep alive, and what still needs a person.
 *
 * Distinctiveness is structure, not a new palette. The whole card goes
 * amber when sweeps have stopped, because a frozen verdict looks current.
 */
import {
    AlertTriangle, CircleDashed, Eye, Loader2, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { TimeStamp } from '@/components/ui/TimeStamp'
import type { FreshnessSummary, ReconcilePolicy, ReconcileRun } from '@/services/freshnessService'
import type { StatusFacet } from './freshnessTriage'
import {
    formatHorizon, lastPassLabel, nextCheckAt, policyWord, sweepsHaveStopped,
} from './reconcileHealth'

export function IntegrityPulse({
    summary, policy, latestRun, lastPassRun, isError, isLoading, isAdmin,
    onCheckNow, checking, onPreview, onFacet, activeFacet,
}: {
    summary: FreshnessSummary | null | undefined
    policy: ReconcilePolicy | undefined
    /** Newest run — drives "last / next" liveness, including empty auto ticks. */
    latestRun: ReconcileRun | undefined
    /** Run described by "last pass …". Omit the sentence when undefined. */
    lastPassRun?: ReconcileRun | undefined
    isError: boolean
    isLoading: boolean
    isAdmin: boolean
    onCheckNow: () => void
    checking: boolean
    onPreview: () => void
    onFacet: (facet: StatusFacet) => void
    activeFacet: StatusFacet
}) {
    const enabled = policy?.enabled ?? policy?.envEnabled ?? true
    const interval = policy?.checkIntervalSecs ?? policy?.envCheckIntervalSecs ?? 3600
    const lastAt = latestRun?.startedAt
    const stopped = enabled && sweepsHaveStopped(lastAt, interval)
    const next = nextCheckAt(lastAt, interval)
    const nextMs = next ? next.getTime() - Date.now() : null
    const drifting = summary?.drifting ?? 0
    const suspended = summary?.suspended ?? 0
    const word = policyWord(policy?.enabled, policy?.envEnabled ?? true)

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
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <ShieldCheck className={cn(
                    'w-4 h-4 shrink-0',
                    stopped ? 'text-amber-600 dark:text-amber-400'
                        : enabled ? 'text-emerald-500' : 'text-slate-400',
                )} />
                <p className="text-sm font-semibold text-ink">
                    {word}
                    {lastAt ? (
                        <>
                            <span className="font-normal text-ink-muted"> · last </span>
                            <TimeStamp at={lastAt} icon={null} colorByAge={false} />
                        </>
                    ) : (
                        <span className="font-normal text-ink-muted"> · not yet run</span>
                    )}
                    {enabled && nextMs != null && nextMs > 0 && !stopped && (
                        <span className="font-normal text-ink-muted">
                            {' '}· next in {formatHorizon(nextMs)}
                        </span>
                    )}
                </p>

                {stopped && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                        <AlertTriangle className="w-3 h-3 shrink-0" /> Sweeps have stopped
                    </span>
                )}
                {enabled && !lastAt && !isLoading && (
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
                    {drifting.toLocaleString()} drifting
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
                {lastPassRun && (
                    <span className="text-ink-muted tabular-nums">
                        last pass {lastPassLabel(lastPassRun, summary?.total)}
                    </span>
                )}
            </div>
        </div>
    )
}
