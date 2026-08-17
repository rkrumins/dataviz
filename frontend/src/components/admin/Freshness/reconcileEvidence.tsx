/**
 * The evidence behind an automatic reconciliation — "why did this rebuild
 * happen", in the operator's own units.
 *
 * Two surfaces reach the same fact from opposite ends: the Freshness drawer's
 * activity trail (a finding, which may name a job) and Job History (a job,
 * which may name a finding). They must never disagree about what the numbers
 * mean, so the derivation lives here once and each surface presents it at the
 * density it has room for.
 */
import { ArrowRight, ShieldAlert, ShieldCheck } from 'lucide-react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { REASON_LABEL } from './DriftStateBadge'
import { DETECTORS } from './automationCopy'

export type ReconcileEvidence = Record<string, unknown> | null | undefined

/** The before → after pairs worth showing, in a fixed order. Pairs where
 *  nothing moved are dropped: an unchanged count is not evidence, and listing
 *  it buries the one line that is. */
export function reconcileEvidenceRows(
    evidence: ReconcileEvidence,
): { label: string; before: number; after: number }[] {
    if (!evidence) return []
    const num = (k: string) => {
        const v = evidence[k]
        return typeof v === 'number' ? v : null
    }
    const out: { label: string; before: number; after: number }[] = []

    // Rollups first — always shown when a prior build existed, INCLUDING when
    // both sides are equal, because "expected 1.2M, observed 1.2M" is still
    // the number the shrink detector measured against.
    const expected = num('expectedAggregatedEdges')
    const observed = num('observedAggregatedEdges')
    if (expected !== null && observed !== null && expected > 0) {
        out.push({ label: 'Rolled-up edges', before: expected, after: observed })
    }

    for (const [label, b, a] of [
        ['Nodes', 'rawNodeCountBefore', 'rawNodeCountAfter'],
        ['Edges', 'rawEdgeCountBefore', 'rawEdgeCountAfter'],
    ] as const) {
        const before = num(b)
        const after = num(a)
        if (before !== null && after !== null && before !== after) {
            out.push({ label, before, after })
        }
    }
    return out
}

export function reconcileReasonLabel(reason?: string | null): string | null {
    if (!reason) return null
    return REASON_LABEL[reason] ?? reason
}

/** The same detector, named for a condition that is STILL TRUE.
 *
 *  ``REASON_LABEL`` is past tense ("Rollups were missing") because Job History
 *  explains a rebuild that already ran; an open finding has not been acted on,
 *  so it takes the ``DETECTORS`` label the Automation modal offers ("Rollups
 *  went missing") — one detector, one name, across all three surfaces. */
function findingLabel(reason?: string | null): string | null {
    if (!reason) return null
    return DETECTORS.find(d => d.key === reason)?.label ?? reason
}

/** A before → after pair. Counts are `tabular-nums` so digits line up
 *  vertically across rows, and the delta carries the direction. */
export function EvidencePair({
    before, after, className,
}: { before: number; after: number; className?: string }) {
    const delta = after - before
    return (
        <span className={cn('inline-flex items-center gap-1.5 font-mono text-[11px]', className)}>
            <span className="tabular-nums text-ink-secondary">{before.toLocaleString()}</span>
            <ArrowRight className="w-3 h-3 shrink-0 text-ink-muted" />
            <span className={cn(
                'tabular-nums font-semibold',
                delta < 0 ? 'text-red-600 dark:text-red-400'
                    : delta > 0 ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-ink',
            )}>
                {after.toLocaleString()}
            </span>
            {delta !== 0 && (
                <span className="text-[10px] text-ink-muted tabular-nums">
                    ({delta > 0 ? '+' : ''}{delta.toLocaleString()})
                </span>
            )}
        </span>
    )
}

/**
 * The evidence card, at either of the two densities the audit trail needs.
 *
 * ``queued`` (the default, Job History): "why was this job queued", answered
 * without leaving the row, handing the reader through to the cockpit that can
 * explain the source's current state.
 *
 * ``open`` (the Freshness drawer's ② Check): the SAME numbers for a finding
 * that has NOT been acted on — a source can be drifting while automation is
 * off, snoozed or capped. The default copy would state, in that case, that a
 * rebuild was queued and run, which is the one thing that did not happen; the
 * tone and the tense are the whole difference, so they branch here rather than
 * in a second component that would be free to disagree about the numbers.
 */
export function ReconcileWhy({
    reason, evidence, dataSourceId, mode = 'queued', foundAt, className,
}: {
    reason?: string | null
    evidence?: ReconcileEvidence
    dataSourceId?: string
    /** ``open`` = the condition is still true and nothing has acted on it. */
    mode?: 'queued' | 'open'
    /** When the sweep last recorded this finding. ``open`` only. */
    foundAt?: string | null
    className?: string
}) {
    const rows = reconcileEvidenceRows(evidence)
    const open = mode === 'open'
    const label = open ? findingLabel(reason) : reconcileReasonLabel(reason)
    const hint = open ? DETECTORS.find(d => d.key === reason)?.hint : null
    const statsAsOf = typeof evidence?.statsAsOf === 'string' ? evidence.statsAsOf : null

    return (
        <div className={cn(
            'rounded-xl border p-3',
            open
                ? 'border-amber-500/25 bg-amber-500/[0.05]'
                : 'border-sky-500/20 bg-sky-500/[0.04]',
            className,
        )}>
            <div className="flex items-start gap-2.5">
                <div className={cn(
                    'w-9 h-9 rounded-xl flex items-center justify-center shrink-0',
                    open ? 'bg-amber-500/10' : 'bg-sky-500/10',
                )}>
                    {open
                        ? <ShieldAlert className="w-4 h-4 text-amber-500" />
                        : <ShieldCheck className="w-4 h-4 text-sky-500" />}
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-ink">
                        {open
                            ? (label ?? 'Something changed outside this app')
                            : `Queued automatically${label ? ` — ${label.toLowerCase()}` : ''}`}
                    </p>
                    <p className="text-[10px] text-ink-muted">
                        {open
                            ? (hint ?? 'The rolled-up lineage no longer matches the data.')
                            : 'No one started this. Automatic reconciliation found the rolled-up '
                              + 'lineage out of step with the source and rebuilt it.'}
                    </p>

                    {rows.length > 0 && (
                        <dl className="mt-2 space-y-1">
                            {rows.map(r => (
                                <div key={r.label} className="flex items-baseline justify-between gap-3">
                                    <dt className="text-[11px] text-ink-muted shrink-0">{r.label}</dt>
                                    <dd><EvidencePair before={r.before} after={r.after} /></dd>
                                </div>
                            ))}
                        </dl>
                    )}

                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                        {foundAt && (
                            <span className="text-[10px] text-ink-muted">
                                Found {new Date(foundAt).toLocaleString()}
                            </span>
                        )}
                        {statsAsOf && (
                            <span className="text-[10px] text-ink-muted">
                                Measured from statistics taken{' '}
                                {new Date(statsAsOf).toLocaleString()}
                            </span>
                        )}
                        {dataSourceId && (
                            <Link
                                to={`/ingestion?tab=freshness&fds=${encodeURIComponent(dataSourceId)}`}
                                className="text-[11px] font-semibold text-sky-600 dark:text-sky-400 hover:underline"
                            >
                                Open in Freshness
                            </Link>
                        )}
                    </div>
                </div>
            </div>
        </div>
    )
}
