/**
 * ReconciliationRunsPanel — "when did the drift check last run, and what did
 * it find".
 *
 * One row per sweep, not per data source: a fleet of 500 checked hourly would
 * otherwise bury the answer under 12,000 rows a day. Per-source outcomes that
 * actually acted are in each source's own history, in the drawer.
 *
 * Collapsed, this is a single honest line — last checked, scanned, findings,
 * actions. Expanded, it explains the shape of each pass: which detectors
 * fired, and why sources were passed over, which is the difference between
 * "nothing drifted" and "every statistics row was too stale to trust".
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronRight, History, Loader2, RefreshCw, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import { usePermission } from '@/store/auth'
import { useToast } from '@/components/ui/toast'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { Sparkline } from '@/components/ui/Sparkline'
import type { ReconcileRun } from '@/services/freshnessService'
import { REASON_LABEL } from './DriftStateBadge'
import { useReconcileNow, useReconciliation } from './useFreshness'

/** Plain-language names for the sweep's skip codes. Mirrors
 *  ``reconcile.SKIP_REASONS``; anything unmapped shows its raw code rather
 *  than being dropped, so a new detector is visible before it is pretty. */
const SKIP_LABEL: Record<string, string> = {
    deleted: 'Deleted',
    no_ontology: 'No ontology assigned',
    no_stats: 'Never profiled',
    stats_stale: 'Statistics too old to trust',
    stats_unhealthy: 'Statistics polling unhealthy',
    in_flight: 'Rebuild already running',
    already_marked: 'Already queued for rebuild',
    cooldown: 'Within the rebuild cooldown',
    failed_backoff: 'Backing off after a failure',
    opted_out: 'Aggregation skipped',
    disabled: 'Automation off',
    suspended: 'Reconciliation suspended',
    seeded: 'First check — baseline recorded',
    in_sync: 'In sync',
}

const MODE_LABEL: Record<string, string> = {
    auto: 'Scheduled',
    manual: 'Manual',
    preview: 'Preview',
}

/** scanned → findings → actions as one proportional bar. Reads as a funnel:
 *  how much of what we looked at turned out to need something. */
function OutcomeBar({ run }: { run: ReconcileRun }) {
    const quiet = Math.max(0, run.scanned - run.findings)
    const acted = run.actions
    const held = Math.max(0, run.findings - run.actions)
    if (run.scanned === 0) return null
    const bands: [string, number, string][] = [
        ['bg-emerald-500/40', quiet, `${quiet.toLocaleString()} in sync`],
        ['bg-amber-500/70', held, `${held.toLocaleString()} found, not acted on`],
        ['bg-indigo-500', acted, `${acted.toLocaleString()} reconciled`],
    ]
    return (
        <div
            className="flex gap-0.5 h-1.5 w-28 shrink-0"
            role="img"
            aria-label={bands.map(([, n, l]) => n > 0 && l).filter(Boolean).join(', ')}
        >
            {bands.map(([tone, n, title]) => n > 0 && (
                <div key={tone} title={title} style={{ flexGrow: n }}
                    className={cn('rounded-full', tone)} />
            ))}
        </div>
    )
}

function RunRow({ run }: { run: ReconcileRun }) {
    const [open, setOpen] = useState(false)
    const reasons = Object.entries(run.byReason).sort((a, b) => b[1] - a[1])
    const skips = Object.entries(run.bySkip).sort((a, b) => b[1] - a[1])
    const hasDetail = reasons.length > 0 || skips.length > 0

    return (
        <li>
            <button
                type="button"
                onClick={() => hasDetail && setOpen(v => !v)}
                aria-expanded={hasDetail ? open : undefined}
                className={cn(
                    'w-full flex items-center gap-3 px-2 py-1.5 rounded-lg text-left',
                    hasDetail && 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                )}
            >
                <motion.span
                    animate={{ rotate: open ? 90 : 0 }}
                    transition={{ duration: 0.15 }}
                    className={cn('shrink-0 text-ink-muted/40', !hasDetail && 'opacity-0')}
                >
                    <ChevronRight className="w-3.5 h-3.5" />
                </motion.span>
                <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted w-16 shrink-0">
                    {MODE_LABEL[run.mode] ?? run.mode}
                </span>
                <OutcomeBar run={run} />
                <span className="text-[11px] text-ink-secondary tabular-nums min-w-0 truncate">
                    {run.scanned.toLocaleString()} checked
                    {run.findings > 0 && ` · ${run.findings.toLocaleString()} found`}
                    {run.actions > 0 && ` · ${run.actions.toLocaleString()} reconciled`}
                    {run.errors > 0 && ` · ${run.errors.toLocaleString()} failed`}
                </span>
                <span className="ml-auto shrink-0">
                    {run.startedAt && (
                        <TimeStamp at={run.startedAt} icon={null} colorByAge={false} />
                    )}
                </span>
            </button>
            <AnimatePresence initial={false}>
                {open && hasDetail && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={MOTION.collapse}
                        className="overflow-hidden"
                    >
                        <div className="ml-8 mb-2 pl-3 border-l border-glass-border grid sm:grid-cols-2 gap-x-6 gap-y-1 pt-1">
                            {reasons.length > 0 && (
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-ink-muted mb-0.5">Found</p>
                                    {reasons.map(([reason, n]) => (
                                        <div key={reason} className="flex items-baseline justify-between gap-3">
                                            <span className="text-[11px] text-ink-secondary">
                                                {REASON_LABEL[reason] ?? reason}
                                            </span>
                                            <span className="text-[11px] tabular-nums text-ink">{n}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {skips.length > 0 && (
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-ink-muted mb-0.5">Passed over</p>
                                    {skips.map(([skip, n]) => (
                                        <div key={skip} className="flex items-baseline justify-between gap-3">
                                            <span className="text-[11px] text-ink-secondary">
                                                {SKIP_LABEL[skip] ?? skip}
                                            </span>
                                            <span className="text-[11px] tabular-nums text-ink">{n}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </li>
    )
}

function Skeleton() {
    return (
        <div className="space-y-2 animate-pulse" aria-hidden="true">
            {[0, 1, 2].map(i => (
                <div key={i} className="h-6 rounded-lg bg-black/5 dark:bg-white/5" />
            ))}
        </div>
    )
}

export function ReconciliationRunsPanel({ onOpenSettings }: {
    onOpenSettings?: () => void
}) {
    const [open, setOpen] = useState(false)
    const isAdmin = usePermission('system:admin')
    const { showToast } = useToast()
    const { data, isLoading, isError } = useReconciliation()
    const reconcileNow = useReconcileNow()

    const runs = data?.runs ?? []
    const latest = runs[0]
    const policy = data?.policy
    const enabled = policy?.enabled ?? policy?.envEnabled ?? true
    // Oldest-first, so the trend reads left to right like every other chart.
    const trend = runs.slice(0, 12).map(r => r.findings).reverse()

    const runNow = () => {
        reconcileNow.mutate({}, {
            onSuccess: (res) => showToast(
                'success',
                res.skipped ? 'A sweep is already running.'
                    : `Checked ${res.run?.scanned ?? 0} source${res.run?.scanned === 1 ? '' : 's'} — ${res.run?.actions ?? 0} reconciled.`,
            ),
            onError: (e) => showToast('error', e.message || 'Could not run reconciliation.'),
        })
    }

    if (isError) return null   // a missing history must not break the cockpit

    return (
        <section className="rounded-xl border border-glass-border bg-canvas-elevated">
            <div className="flex items-center gap-3 px-3.5 py-2.5">
                <button
                    type="button"
                    onClick={() => setOpen(v => !v)}
                    aria-expanded={open}
                    className="flex items-center gap-2 min-w-0 text-left rounded-lg"
                >
                    <motion.span
                        animate={{ rotate: open ? 90 : 0 }}
                        transition={{ duration: 0.15 }}
                        className="shrink-0 text-ink-muted/50"
                    >
                        <ChevronRight className="w-4 h-4" />
                    </motion.span>
                    <ShieldCheck className={cn(
                        'w-4 h-4 shrink-0',
                        enabled ? 'text-emerald-500' : 'text-slate-400',
                    )} />
                    <span className="text-sm font-semibold text-ink shrink-0">
                        Automatic reconciliation
                    </span>
                    <span className="text-[11px] text-ink-muted truncate">
                        {!enabled
                            ? 'Off — drift is detected and shown, but nothing is rebuilt'
                            : latest
                                ? <>Last checked <TimeStamp at={latest.startedAt ?? ''} icon={null} colorByAge={false} /> · {latest.scanned.toLocaleString()} sources</>
                                : 'No checks recorded yet'}
                    </span>
                </button>

                <div className="ml-auto flex items-center gap-2 shrink-0">
                    {trend.length >= 3 && (
                        <Sparkline
                            points={trend} tone="amber" width={72} height={20}
                            label="Findings per check"
                        />
                    )}
                    {isAdmin && (
                        <>
                            <button
                                onClick={runNow}
                                disabled={reconcileNow.isPending}
                                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-xs font-semibold text-indigo-600 dark:text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/10 transition-colors disabled:opacity-50"
                            >
                                {reconcileNow.isPending
                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                    : <RefreshCw className="w-3.5 h-3.5" />}
                                Check now
                            </button>
                            {onOpenSettings && (
                                <button
                                    onClick={onOpenSettings}
                                    className="inline-flex items-center h-7 px-2.5 rounded-lg text-xs font-semibold text-ink-muted border border-glass-border hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                                >
                                    Settings
                                </button>
                            )}
                        </>
                    )}
                </div>
            </div>

            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={MOTION.collapse}
                        className="overflow-hidden"
                    >
                        <div className="px-3.5 pb-3 pt-0.5 border-t border-glass-border/60">
                            {isLoading ? <Skeleton /> : runs.length === 0 ? (
                                <div className="flex flex-col items-center text-center py-6">
                                    <div className="w-10 h-10 rounded-full bg-black/[0.04] dark:bg-white/[0.05] flex items-center justify-center mb-3">
                                        <History className="w-4 h-4 text-ink-muted" />
                                    </div>
                                    <p className="text-[13px] text-ink-muted max-w-sm">
                                        No checks have run yet. The first one records a
                                        baseline for every source and reconciles nothing.
                                    </p>
                                </div>
                            ) : (
                                <ul className="mt-1 space-y-0.5">
                                    {runs.map(run => <RunRow key={run.id} run={run} />)}
                                </ul>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </section>
    )
}
