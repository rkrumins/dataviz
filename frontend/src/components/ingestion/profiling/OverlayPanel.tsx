/**
 * The rolled-up lineage overlay, for one source: how much of it there is,
 * how much there should be, and what to do when those disagree.
 *
 * Profiling answers "what happened and when" — the Aggregated series on the
 * chart above is the history, and it is the only place a drop and its
 * recovery are both visible. What it could not answer is "is this a problem
 * right now, and what do I press". That lived entirely in the Freshness
 * cockpit, which has no link from here and no history of its own.
 *
 * So this is the seam, and it is deliberately thin: the reconcile verdict and
 * the observed-vs-expected meter are the cockpit's own components rendered
 * against the cockpit's own document. Nothing is re-derived here, and the
 * actions stay where they already are rather than becoming a second, subtly
 * different trigger button.
 */
import { Link } from 'react-router-dom'
import { ArrowRight, Layers } from 'lucide-react'

import { cn } from '@/lib/utils'
import { DriftStateBadge, REASON_LABEL } from '@/components/admin/Freshness/DriftStateBadge'
import { OverlayIntegrityMeter } from '@/components/admin/Freshness/OverlayIntegrityMeter'
import { useSourceFreshness } from '@/components/admin/Freshness/useFreshness'

/** Verdicts that mean the overlay itself is the problem — the ones where the
 *  answer is a rebuild rather than "watch it". `drifting` is deliberately not
 *  here: the RAW data moved, which a rebuild follows rather than fixes. */
const OVERLAY_AT_FAULT = new Set(['overlayMissing', 'neverBuilt'])

export function OverlayPanel({
    dataSourceId, className,
}: {
    dataSourceId: string
    className?: string
}) {
    // The cockpit's own document, on its own cache key — so opening this
    // drawer warms the one the cockpit reads, and neither can disagree with
    // the other about what the store currently holds. `probe: false`: this is
    // a read, never a reason to go and hit the graph store.
    const { data: doc, error } = useSourceFreshness(dataSourceId, false)

    // Silently absent rather than an error block. The cockpit needs a
    // permission this page does not, and a profiling reader who cannot see
    // freshness should get the history they came for, not a red box about a
    // panel they never asked about.
    if (error || !doc) return null

    const atFault = OVERLAY_AT_FAULT.has(doc.driftState ?? '')
    const reason = doc.lastFindingReason
        ? REASON_LABEL[doc.lastFindingReason] ?? doc.lastFindingReason
        : null

    return (
        <section
            className={cn(
                'rounded-xl border border-glass-border bg-canvas-elevated p-4',
                atFault && 'border-rose-500/30',
                className,
            )}
        >
            <header className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-ink-primary">
                    <Layers className="w-4 h-4 text-ink-muted" aria-hidden />
                    Aggregated lineage
                </h3>
                <DriftStateBadge state={doc.driftState} />
            </header>

            <p className="mt-1 max-w-prose text-[11px] text-ink-muted leading-relaxed">
                The rolled-up lineage this platform builds and maintains — not
                relationships anyone ingested. A rebuild wipes and rewrites it,
                so the Aggregated line above dips and recovers on its own; a dip
                that does not recover is what this panel is for.
            </p>

            <OverlayIntegrityMeter
                className="mt-3"
                observed={doc.observedAggregatedEdges}
                expected={doc.expectedAggregatedEdges}
                statsAsOf={doc.statsAsOf}
                unobservable={doc.driftState === 'unobservable'}
            />

            {reason && (
                <p className="mt-2 text-[11px] text-ink-secondary">
                    Last finding: <span className="font-medium">{reason}</span>
                </p>
            )}

            {/* The verb lives in the cockpit, which already carries "Rebuild
                lineage now", "Reconcile this source" and the permission checks
                behind them. A second trigger here would be a second thing to
                keep correct. */}
            <Link
                to={`/ingestion?tab=freshness&fds=${encodeURIComponent(dataSourceId)}`}
                className={cn(
                    'mt-3 inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5',
                    'text-xs font-medium transition-colors',
                    atFault
                        ? 'border-rose-500/30 text-rose-700 hover:bg-rose-500/[0.06] dark:text-rose-300'
                        : 'border-glass-border text-ink-secondary hover:bg-canvas-sunken hover:text-ink-primary',
                )}
            >
                {atFault ? 'Rebuild the rollups' : 'Check or rebuild the rollups'}
                <ArrowRight className="w-3.5 h-3.5" aria-hidden />
            </Link>
        </section>
    )
}
