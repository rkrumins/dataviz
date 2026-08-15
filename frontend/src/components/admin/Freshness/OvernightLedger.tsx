/**
 * OvernightLedger — what automation did in the last 24 hours, grouped by
 * sweep, joined to the job each rebuilt finding produced.
 */
import { ArrowUpRight, History } from 'lucide-react'
import { Link } from 'react-router-dom'
import { jobHistoryPath } from '../job-history/shared'
import { TimeStamp } from '@/components/ui/TimeStamp'
import type { ReconcileActivityItem } from '@/services/freshnessService'
import { REASON_LABEL } from './DriftStateBadge'
import { groupLedgerBySweep } from './reconcileHealth'

const SKIP_LABEL: Record<string, string> = {
    deleted: 'Deleted',
    platform_mastered: 'Version controlled',
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
    cap: 'Cap',
}

const MODE_LABEL: Record<string, string> = {
    auto: 'Automatic',
    manual: 'Manual',
}

function outcomeLabel(item: ReconcileActivityItem): string {
    if (item.outcome === 'rebuilt') return 'Rebuilt'
    if (item.outcome === 'failed') return 'Failed'
    const skip = item.skip ? (SKIP_LABEL[item.skip] ?? item.skip) : null
    return skip ? `Held (${skip})` : 'Held'
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
            <div className="space-y-2 animate-pulse py-2" aria-hidden="true">
                {[0, 1, 2].map(i => (
                    <div key={i} className="h-6 rounded-lg bg-black/5 dark:bg-white/5" />
                ))}
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

    const groups = groupLedgerBySweep(items)
    return (
        <div className="space-y-3">
            {groups.map(group => (
                <section key={group.runId}>
                    <h3 className="flex items-center gap-2 text-[10px] uppercase tracking-wide text-ink-muted mb-1">
                        {group.startedAt
                            ? <TimeStamp at={group.startedAt} icon={null} colorByAge={false} />
                            : 'Sweep'}
                        <span>· {MODE_LABEL[group.mode] ?? group.mode}</span>
                        <span className="tabular-nums">
                            · {group.items.length.toLocaleString()}{' '}
                            {group.items.length === 1 ? 'finding' : 'findings'}
                        </span>
                    </h3>
                    <ul className="space-y-0.5">
                        {group.items.map((item, i) => (
                            <li key={`${item.runId}:${item.dataSourceId}:${i}`}>
                                <div className="w-full flex items-center gap-3 px-1.5 py-1.5 rounded-lg text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.03]">
                                    <button
                                        type="button"
                                        onClick={() => onOpenSource(item.dataSourceId)}
                                        className="min-w-0 flex-1 flex items-center gap-3 text-left"
                                    >
                                        <span className="text-[11px] text-ink-muted w-12 shrink-0 tabular-nums">
                                            {item.ts
                                                ? new Date(item.ts).toLocaleTimeString([], {
                                                    hour: '2-digit', minute: '2-digit', hour12: false,
                                                })
                                                : '—'}
                                        </span>
                                        <span className="text-[12px] font-semibold text-ink truncate min-w-0">
                                            {item.name || item.dataSourceId}
                                        </span>
                                        <span className="text-[11px] text-ink-secondary truncate hidden sm:inline">
                                            {REASON_LABEL[item.reason ?? ''] ?? item.reason ?? 'Finding'}
                                        </span>
                                        <span className="ml-auto text-[11px] text-ink-muted shrink-0">
                                            {MODE_LABEL[item.mode] ?? item.mode}
                                        </span>
                                        <span className="text-[11px] font-semibold text-ink shrink-0">
                                            {outcomeLabel(item)}
                                        </span>
                                    </button>
                                    {item.outcome === 'rebuilt' && (
                                        <Link
                                            to={item.jobId
                                                ? jobHistoryPath({ search: item.jobId })
                                                : jobHistoryPath({ triggerSource: 'reconcile' })}
                                            className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                                            onClick={e => e.stopPropagation()}
                                        >
                                            job
                                            <ArrowUpRight className="w-3 h-3" />
                                        </Link>
                                    )}
                                </div>
                            </li>
                        ))}
                    </ul>
                </section>
            ))}
        </div>
    )
}
