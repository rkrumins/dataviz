/**
 * BatchResultsList — the per-source outcome list shared by the provider and
 * fleet refresh dialogs.
 *
 * It exists because "Refresh complete · 31/31" over a list of ds_ ids is not
 * an operator-usable report: it hides what was done, and it reads as "31
 * rebuilds finished" when the truth is "24 rebuilds were QUEUED". One
 * component so the two dialogs cannot drift.
 */
import { Link } from 'react-router-dom'
import { ArrowUpRight, CheckCircle2, Clock, XCircle } from 'lucide-react'
import type { BatchItemResult } from '@/services/freshnessService'
import { jobHistoryPath } from '../job-history/shared'

/** Raw action ids → operator language. Unknown ids are humanized, never
 *  hidden: a silently-dropped action is how a report starts lying. */
const ACTION_COPY: Record<string, string> = {
    // Verified against refresh_source in aggregation/service.py — these are
    // the literal strings it appends, not a paraphrase of them.
    content_cleared: 'cache cleared',
    hierarchy_invalidated: 'cached views invalidated',
    aggregated_lkg_purged: 'fallback snapshot dropped',
    stats_nudged: 'figures refreshed',
    marker_set: 'flagged as changed',
    marker_cleared: 'stale flag cleared',
    invalidated: 'caches invalidated',
    rebuild_queued: 'rebuild queued',
    rebuild_deferred: 'rebuild deferred',
    rebuild_conflict: 'rebuild already running',
    rebuild_error: 'rebuild could not be queued',
}

export function describeActions(actions: string[]): string {
    if (actions.length === 0) return 'no changes needed'
    return actions.map(a => ACTION_COPY[a] ?? a.replace(/_/g, ' ')).join(' · ')
}

export function BatchResultsList({ results }: { results: BatchItemResult[] }) {
    if (results.length === 0) return null

    const queued = results.filter(r => r.outcome === 'done' && r.jobId).length
    const deferred = results.filter(r => r.outcome === 'done' && r.deferred).length
    const failed = results.filter(r => r.outcome === 'error').length

    return (
        <>
            <ul className="max-h-48 overflow-y-auto space-y-1 mb-3">
                {results.map((r) => (
                    <li key={r.dataSourceId} className="flex items-center gap-2 text-xs text-ink-secondary">
                        {r.outcome === 'error'
                            ? <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
                            : r.deferred
                                ? <Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                                : <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500 shrink-0" />}
                        <span className="truncate font-medium text-ink">{r.name || r.dataSourceId}</span>
                        <span className="truncate text-ink-muted">
                            {r.outcome === 'error'
                                ? 'failed to start'
                                : r.deferred
                                    ? 'deferred — in cooldown, no rebuild queued'
                                    : r.actions?.length ? describeActions(r.actions) : r.jobId ? 'rebuild queued' : 'no changes needed'}
                        </span>
                        {r.jobId && (
                            <Link
                                to={jobHistoryPath({ dataSourceId: r.dataSourceId })}
                                className="ml-auto inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400 hover:underline shrink-0"
                            >
                                View job<ArrowUpRight className="w-3 h-3" />
                            </Link>
                        )}
                    </li>
                ))}
            </ul>
            <div className="flex items-center justify-between text-[11px] text-ink-muted mb-4">
                <span>
                    {results.length} source{results.length === 1 ? '' : 's'}
                    {queued > 0 && ` · ${queued} rebuild${queued === 1 ? '' : 's'} queued`}
                    {deferred > 0 && ` · ${deferred} deferred`}
                    {failed > 0 && ` · ${failed} failed`}
                </span>
                {queued > 0 && (
                    <Link
                        to={jobHistoryPath({ status: ['running', 'pending'] })}
                        className="inline-flex items-center gap-0.5 text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        View all jobs<ArrowUpRight className="w-3 h-3" />
                    </Link>
                )}
            </div>
        </>
    )
}
