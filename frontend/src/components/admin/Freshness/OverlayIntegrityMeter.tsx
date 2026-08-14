/**
 * OverlayIntegrityMeter — observed vs expected rolled-up edges.
 *
 * A meter, deliberately not a ring. There are already three donut
 * implementations in this app and a fourth would be one too many, but the
 * stronger reason is that a ring answers the wrong question: what matters
 * here is the magnitudes (1,204,318 → 0), and a percentage arc buries them.
 * A single ratio against a limit is a meter's job.
 *
 * The bar idiom is the one FreshnessStatBand already uses for cache coverage
 * — a tinted track with a same-hue fill — generalised so the fill carries
 * severity and the counts are direct-labelled beside it rather than inside.
 *
 * "Expected" is what the last successful build reported writing; "observed"
 * is what the statistics scan last counted in the graph. They are measured at
 * different instants, so the two being slightly apart is normal and the
 * thresholds allow for it.
 */
import { cn } from '@/lib/utils'

function compact(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`
    return String(n)
}

/** Severity by how much of the expected rollup is actually present. Mirrors
 *  ``coverageColor`` in CoverageVisuals — same thresholds, same reading. */
function tone(ratio: number) {
    if (ratio >= 0.9) {
        return {
            fill: 'bg-emerald-500',
            track: 'bg-emerald-500/15',
            value: 'text-emerald-600 dark:text-emerald-400',
        }
    }
    if (ratio >= 0.5) {
        return {
            fill: 'bg-amber-500',
            track: 'bg-amber-500/15',
            value: 'text-amber-600 dark:text-amber-400',
        }
    }
    return {
        fill: 'bg-red-500',
        track: 'bg-red-500/15',
        value: 'text-red-600 dark:text-red-400',
    }
}

export function OverlayIntegrityMeter({
    observed, expected, statsAsOf, unobservable, className,
}: {
    observed?: number | null
    expected?: number | null
    statsAsOf?: string | null
    /** A dedicated projection writes its rollups to a graph the statistics
     *  scan never reads, so there is no honest number to show. */
    unobservable?: boolean
    className?: string
}) {
    if (unobservable) {
        return (
            <p className={cn('text-[11px] text-ink-muted leading-relaxed', className)}>
                This source projects its rollups into a separate graph, so their
                size is not visible to the statistics scan. Drift in the raw
                data is still detected.
            </p>
        )
    }
    if (observed == null || expected == null) {
        return (
            <p className={cn('text-[11px] text-ink-muted', className)}>
                No rollup counts yet — the statistics service has not profiled
                this source.
            </p>
        )
    }

    // A source that legitimately has no rollups (containment only) reads as
    // whole, not as empty: there is nothing missing.
    const ratio = expected > 0 ? Math.min(1, observed / expected) : 1
    const t = tone(ratio)
    // Never paint a non-zero value as an empty bar — a hairline is the honest
    // rendering of "some, but very few".
    const width = observed > 0 ? Math.max(2, ratio * 100) : 0

    return (
        <div className={className}>
            <div className="flex items-baseline justify-between gap-3 mb-1.5">
                <span className="text-[10px] uppercase tracking-wide text-ink-muted">
                    Rolled-up edges
                </span>
                <span className="text-xs tabular-nums text-ink-secondary">
                    <span className={cn('font-bold', t.value)}>
                        {observed.toLocaleString()}
                    </span>
                    <span className="text-ink-muted"> / {expected.toLocaleString()}</span>
                </span>
            </div>
            <div
                role="meter"
                aria-valuenow={observed}
                aria-valuemin={0}
                aria-valuemax={Math.max(expected, observed)}
                aria-label={`${observed.toLocaleString()} of ${expected.toLocaleString()} rolled-up edges present`}
                className={cn('h-2 rounded-full overflow-hidden', t.track)}
            >
                <div
                    className={cn(
                        'h-full rounded-full transition-[width] duration-700 ease-out',
                        t.fill,
                    )}
                    style={{ width: `${width}%` }}
                />
            </div>
            <p className="mt-1.5 text-[10px] text-ink-muted">
                {observed === 0 && expected > 0
                    ? `Expected ${compact(expected)} — none found`
                    : `${Math.round(ratio * 100)}% of the last successful build`}
                {statsAsOf && ' · counted '}
                {statsAsOf && (
                    <time dateTime={statsAsOf}>
                        {new Date(statsAsOf).toLocaleString()}
                    </time>
                )}
            </p>
        </div>
    )
}
