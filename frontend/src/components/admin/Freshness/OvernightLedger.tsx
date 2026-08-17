/**
 * OvernightLedger — last pass as a report, earlier passes as a timeline
 * you open on purpose. The newest sweep is never a collapsed header.
 */
import { useState } from 'react'
import { ArrowUpRight, ChevronDown, History } from 'lucide-react'
import { Link } from 'react-router-dom'
import { jobHistoryPath } from '../job-history/shared'
import { TimeStamp } from '@/components/ui/TimeStamp'
import { cn } from '@/lib/utils'
import type { ReconcileActivityItem } from '@/services/freshnessService'
import { DRIFT_SPEC, REASON_LABEL } from './DriftStateBadge'
import { groupLedgerBySweep, type LedgerGroup } from './reconcileHealth'

/** Why a finding was not acted on, in the ①②③ vocabulary the rest of this
 *  surface speaks: Detect reads counts, Check compares them against the
 *  rollups, Act rebuilds. The two verdict words come from the shared spec
 *  rather than being spelled out again here. ``paused`` was missing entirely,
 *  so an operator snooze printed the raw backend code. */
const SKIP_LABEL: Record<string, string> = {
    deleted: 'Deleted',
    platform_mastered: DRIFT_SPEC.managed.label,
    no_ontology: 'No ontology assigned',
    no_stats: 'No counts to check yet',
    stats_stale: 'Counts too old to check',
    stats_unhealthy: 'Counts could not be read',
    in_flight: 'Rebuild already running',
    already_marked: 'Already queued for rebuild',
    cooldown: 'Within the minimum time between rebuilds',
    paused: 'Rebuilds paused by an operator',
    failed_backoff: 'Backing off after a failed rebuild',
    opted_out: 'Automation off for this source',
    disabled: 'Automation off',
    suspended: DRIFT_SPEC.suspended.label,
    seeded: 'First check — baseline recorded',
    in_sync: DRIFT_SPEC.inSync.label,
    cap: 'Rebuilds-per-check limit reached',
}

const MODE_LABEL: Record<string, string> = {
    auto: 'Automatic',
    manual: 'Check now',
}

function outcomeLabel(item: ReconcileActivityItem): string {
    if (item.outcome === 'rebuilt') return 'Rebuilt'
    if (item.outcome === 'failed') return 'Failed'
    const skip = item.skip ? (SKIP_LABEL[item.skip] ?? item.skip) : null
    return skip ? `Held (${skip})` : 'Held'
}

function tallyCounts(items: ReconcileActivityItem[]) {
    let rebuilt = 0
    let held = 0
    let failed = 0
    for (const item of items) {
        if (item.outcome === 'rebuilt') rebuilt += 1
        else if (item.outcome === 'failed') failed += 1
        else held += 1
    }
    return { rebuilt, held, failed, n: items.length }
}

function passHeadline(items: ReconcileActivityItem[]): string {
    const { rebuilt, held, failed, n } = tallyCounts(items)
    const bits: string[] = []
    if (rebuilt) bits.push(`${rebuilt.toLocaleString()} rebuilt`)
    if (failed) bits.push(`${failed.toLocaleString()} failed`)
    if (held) bits.push(`${held.toLocaleString()} held`)
    if (bits.length === 0) {
        bits.push(`${n.toLocaleString()} ${n === 1 ? 'finding' : 'findings'}`)
    }
    return bits.join(' · ')
}

function outcomeTone(item: ReconcileActivityItem): string {
    if (item.outcome === 'rebuilt') {
        return 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
    }
    if (item.outcome === 'failed') {
        return 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
    }
    return 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20'
}

function FindingTicket({
    item, onOpenSource,
}: {
    item: ReconcileActivityItem
    onOpenSource: (id: string) => void
}) {
    const rail =
        item.outcome === 'rebuilt' ? 'border-l-emerald-500/70'
        : item.outcome === 'failed' ? 'border-l-red-500/70'
        : 'border-l-slate-400/60'

    return (
        <li>
            <div className={cn(
                'flex items-start gap-3 rounded-lg border border-glass-border/70 bg-canvas px-3 py-2.5',
                'border-l-2', rail,
            )}>
                <button
                    type="button"
                    onClick={() => onOpenSource(item.dataSourceId)}
                    className="min-w-0 flex-1 text-left rounded-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                >
                    <span className="block text-sm font-semibold text-ink truncate hover:text-indigo-600 dark:hover:text-indigo-400">
                        {item.name || item.dataSourceId}
                    </span>
                    <span className="block text-[12px] text-ink-muted mt-0.5 truncate">
                        {REASON_LABEL[item.reason ?? ''] ?? item.reason ?? 'Finding'}
                    </span>
                </button>
                <div className="flex items-center gap-2 shrink-0 pt-0.5">
                    <span
                        className={cn(
                            'inline-flex items-center px-1.5 py-0.5 rounded-full border',
                            'text-[10px] font-semibold',
                            outcomeTone(item),
                        )}
                    >
                        {outcomeLabel(item)}
                    </span>
                    {item.outcome === 'rebuilt' && (
                        <Link
                            to={item.jobId
                                ? jobHistoryPath({ search: item.jobId })
                                : jobHistoryPath({ triggerSource: 'reconcile' })}
                            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                        >
                            job
                            <ArrowUpRight className="w-3 h-3" />
                        </Link>
                    )}
                </div>
            </div>
        </li>
    )
}

function FindingList({
    items, onOpenSource,
}: {
    items: ReconcileActivityItem[]
    onOpenSource: (id: string) => void
}) {
    return (
        <ul className="space-y-1.5">
            {items.map((item, i) => (
                <FindingTicket
                    key={`${item.runId}:${item.dataSourceId}:${i}`}
                    item={item}
                    onOpenSource={onOpenSource}
                />
            ))}
        </ul>
    )
}

function LastPassStage({
    group, onOpenSource,
}: {
    group: LedgerGroup
    onOpenSource: (id: string) => void
}) {
    const mode = MODE_LABEL[group.mode] ?? group.mode
    return (
        <section
            aria-labelledby="reconcile-last-pass-heading"
            className="rounded-xl border border-indigo-500/20 bg-indigo-500/[0.05] overflow-hidden"
        >
            <header className="flex items-start justify-between gap-3 px-3.5 pt-3 pb-2.5">
                <div className="min-w-0">
                    <h4
                        id="reconcile-last-pass-heading"
                        className="text-[10px] font-semibold uppercase tracking-wide text-indigo-600 dark:text-indigo-400"
                    >
                        Last pass
                    </h4>
                    <p className="mt-0.5 text-[12px] text-ink-muted">
                        {mode}
                        {group.startedAt && (
                            <>
                                {' · '}
                                <TimeStamp at={group.startedAt} icon={null} colorByAge={false} />
                            </>
                        )}
                    </p>
                </div>
                <p className="text-sm font-semibold text-ink tabular-nums shrink-0">
                    {passHeadline(group.items)}
                </p>
            </header>
            <div className="px-2.5 pb-2.5">
                <FindingList items={group.items} onOpenSource={onOpenSource} />
            </div>
        </section>
    )
}

function EarlierTimeline({
    groups, onOpenSource,
}: {
    groups: LedgerGroup[]
    onOpenSource: (id: string) => void
}) {
    const [archiveOpen, setArchiveOpen] = useState(false)
    const [openRunId, setOpenRunId] = useState<string | null>(null)
    const n = groups.length
    const rebuilt = groups.reduce((sum, g) => sum + tallyCounts(g.items).rebuilt, 0)

    return (
        <div>
            <button
                type="button"
                aria-expanded={archiveOpen}
                aria-controls="reconcile-earlier-passes"
                aria-label={`${n.toLocaleString()} earlier ${n === 1 ? 'pass' : 'passes'}`}
                onClick={() => setArchiveOpen(v => !v)}
                className={cn(
                    'w-full flex items-center gap-2 rounded-xl border border-glass-border bg-canvas',
                    'px-3 py-2.5 text-left outline-none transition-colors',
                    'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                    'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                )}
            >
                <History className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden="true" />
                <span className="text-[12px] font-semibold text-ink">
                    {n.toLocaleString()} earlier {n === 1 ? 'pass' : 'passes'}
                </span>
                {rebuilt > 0 && (
                    <span className="text-[11px] text-ink-muted tabular-nums">
                        · {rebuilt.toLocaleString()} rebuilt
                    </span>
                )}
                <ChevronDown
                    className={cn(
                        'w-3.5 h-3.5 text-ink-muted shrink-0 ml-auto transition-transform duration-200 motion-reduce:transition-none',
                        !archiveOpen && '-rotate-90',
                    )}
                    aria-hidden="true"
                />
            </button>
            {archiveOpen && (
                <ol
                    id="reconcile-earlier-passes"
                    className="relative mt-2 ml-3 pl-4 border-l border-glass-border max-h-80 overflow-y-auto motion-reduce:animate-none animate-in fade-in slide-in-from-top-1 duration-100"
                >
                    {groups.map(group => {
                        const open = openRunId === group.runId
                        const mode = MODE_LABEL[group.mode] ?? group.mode
                        const when = group.startedAt ? undefined : 'Sweep'
                        return (
                            <li key={group.runId} className="relative pb-3 last:pb-1">
                                <span
                                    className={cn(
                                        'absolute -left-[21px] top-3 w-2 h-2 rounded-full ring-2 ring-canvas',
                                        open ? 'bg-indigo-500' : 'bg-ink-muted/40',
                                    )}
                                    aria-hidden="true"
                                />
                                <button
                                    type="button"
                                    aria-expanded={open}
                                    aria-label={`Earlier pass, ${mode}, ${passHeadline(group.items)}`}
                                    onClick={() => setOpenRunId(open ? null : group.runId)}
                                    className={cn(
                                        'w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left',
                                        'outline-none hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                        'focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                    )}
                                >
                                    {group.startedAt
                                        ? <TimeStamp at={group.startedAt} icon={null} colorByAge={false} />
                                        : <span className="text-[11px] font-medium text-ink-muted">{when}</span>}
                                    <span className="text-[11px] text-ink-muted truncate">{mode}</span>
                                    <span className="ml-auto text-[11px] text-ink-secondary tabular-nums shrink-0">
                                        {passHeadline(group.items)}
                                    </span>
                                    <ChevronDown
                                        className={cn(
                                            'w-3.5 h-3.5 text-ink-muted/70 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                                            !open && '-rotate-90',
                                        )}
                                        aria-hidden="true"
                                    />
                                </button>
                                {open && (
                                    <div className="mt-1.5 pl-1">
                                        <FindingList items={group.items} onOpenSource={onOpenSource} />
                                    </div>
                                )}
                            </li>
                        )
                    })}
                </ol>
            )}
        </div>
    )
}

export function OvernightLedger({
    items, isError, isLoading, onOpenSource,
    emptyLabel = 'Nothing to report overnight — no findings in the last 24 hours.',
}: {
    items: ReconcileActivityItem[]
    isError: boolean
    isLoading: boolean
    onOpenSource: (id: string) => void
    emptyLabel?: string
}) {
    if (isError) {
        return (
            <p role="alert" className="px-1 py-2 text-[12px] text-red-700 dark:text-red-300">
                Could not load overnight activity.
            </p>
        )
    }
    if (isLoading) {
        return (
            <div className="space-y-2 animate-pulse py-1" aria-hidden="true">
                <div className="h-28 rounded-xl bg-black/5 dark:bg-white/5" />
                <div className="h-10 rounded-xl bg-black/5 dark:bg-white/5" />
            </div>
        )
    }
    if (items.length === 0) {
        return (
            <div className="flex items-center gap-2 py-3 text-[12px] text-ink-muted">
                <History className="w-3.5 h-3.5 shrink-0" />
                {emptyLabel}
            </div>
        )
    }

    const [last, ...earlier] = groupLedgerBySweep(items)
    if (!last) return null

    return (
        <div className="space-y-2">
            <LastPassStage group={last} onOpenSource={onOpenSource} />
            {earlier.length > 0 && (
                <EarlierTimeline groups={earlier} onOpenSource={onOpenSource} />
            )}
        </div>
    )
}
