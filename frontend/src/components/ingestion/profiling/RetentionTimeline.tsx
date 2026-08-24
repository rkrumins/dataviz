/**
 * What the policy MEANS, drawn.
 *
 * Retention is not four numbers — it is how far back you can see and at what
 * resolution, and those two facts are what someone actually came to check.
 * Three nested bars on one axis say it in a glance, and they move as the
 * numbers change, so the control explains itself instead of being explained.
 *
 * SQUARE-ROOT SCALE, not linear. On a linear axis 7 days against 400 is 1.75%
 * of the width — the raw tier becomes a hairline and the most-read tier is the
 * one you cannot see. Not logarithmic either: log flatters the short end so
 * hard that 7 and 45 days look comparable, which is the opposite lie. Root
 * keeps the ordering honest while leaving every tier legible.
 */
import { cn } from '@/lib/utils'

export interface Tiers {
    rawDays: number
    hourlyDays: number
    dailyDays: number
}

const TIERS = [
    {
        key: 'raw' as const, label: 'Every observation',
        bar: 'bg-indigo-500', text: 'text-indigo-600 dark:text-indigo-400',
    },
    {
        key: 'hourly' as const, label: 'Hourly',
        bar: 'bg-cyan-500', text: 'text-cyan-600 dark:text-cyan-400',
    },
    {
        key: 'daily' as const, label: 'Daily',
        bar: 'bg-violet-400', text: 'text-violet-600 dark:text-violet-400',
    },
]

function span(days: number, max: number): number {
    if (max <= 0) return 0
    return Math.max(2, Math.min(100, (Math.sqrt(days) / Math.sqrt(max)) * 100))
}

export function RetentionTimeline({ tiers }: { tiers: Tiers }) {
    const widest = Math.max(tiers.dailyDays, tiers.hourlyDays, tiers.rawDays, 1)
    const value = {
        raw: tiers.rawDays, hourly: tiers.hourlyDays, daily: tiers.dailyDays,
    }

    return (
        <figure className="rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3.5">
            <figcaption className="sr-only">
                Retention by tier: raw {tiers.rawDays} days, hourly{' '}
                {tiers.hourlyDays} days, daily {tiers.dailyDays} days
            </figcaption>

            <div className="flex items-baseline justify-between text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-2">
                <span>Now</span>
                <span>{widest.toLocaleString()} days back</span>
            </div>

            <div className="space-y-1.5">
                {TIERS.map((tier) => {
                    const days = value[tier.key]
                    return (
                        <div key={tier.key} className="flex items-center gap-2.5">
                            <span className="w-28 shrink-0 text-[11px] font-medium text-ink-secondary">
                                {tier.label}
                            </span>
                            <span className="flex-1 h-2.5 rounded-full bg-glass-border/60 overflow-hidden">
                                <span
                                    className={cn('block h-full rounded-full transition-all duration-300', tier.bar)}
                                    style={{ width: `${span(days, widest)}%` }}
                                />
                            </span>
                            <span className={cn(
                                'w-16 shrink-0 text-right text-[11px] font-bold tabular-nums',
                                tier.text,
                            )}>
                                {days.toLocaleString()}d
                            </span>
                        </div>
                    )
                })}
            </div>

            {/* The bars are drawn on a root scale so every tier stays legible.
                Saying so keeps the picture honest — an axis a reader assumes is
                linear is a chart that lies quietly. */}
            <p className="mt-2.5 text-[10px] text-ink-muted">
                Bars are scaled to keep short tiers legible; the numbers are exact.
            </p>
        </figure>
    )
}

/**
 * The policy as a sentence.
 *
 * The bars show the shape; this says what it BUYS. "You can investigate the
 * last 45 days at hourly resolution" is the thing an operator wants confirmed,
 * and it is not derivable from four labelled boxes without doing the reasoning
 * themselves.
 */
export function RetentionSummary({ tiers }: { tiers: Tiers }) {
    return (
        <p className="text-xs text-ink-secondary leading-relaxed">
            You can investigate the last{' '}
            <strong className="font-semibold text-ink">{tiers.rawDays} days</strong>{' '}
            observation by observation,{' '}
            <strong className="font-semibold text-ink">{tiers.hourlyDays} days</strong>{' '}
            hour by hour, and{' '}
            <strong className="font-semibold text-ink">
                {tiers.dailyDays.toLocaleString()} days
            </strong>{' '}
            day by day.
        </p>
    )
}

/**
 * What it will cost, before you save it.
 *
 * Measured at ~1 kB per row across both tables on a live estate. The rollup
 * tiers are bounded by BUCKETS rather than observations — an hour bucket is
 * one row however often the source was sampled — which is why widening the
 * capture cadence barely moves this and widening the daily tier moves it less
 * still. Showing the arithmetic is what stops retention being set by folklore.
 */
const BYTES_PER_ROW = 1024

export function StorageEstimate({
    tiers, heartbeatSecs, maxRowsPerSource, sources,
}: {
    tiers: Tiers
    heartbeatSecs: number
    maxRowsPerSource: number
    sources: number
}) {
    const perDay = heartbeatSecs > 0 ? 86_400 / heartbeatSecs : 0
    // The cap is a real bound, not a footnote: a source at the ceiling keeps
    // fewer raw rows than its age cutoff would allow.
    const uncapped = perDay * tiers.rawDays
    const rawRows = Math.min(uncapped, maxRowsPerSource)
    const capped = uncapped > maxRowsPerSource
    const rows = rawRows + 24 * tiers.hourlyDays + tiers.dailyDays
    const perSource = rows * BYTES_PER_ROW

    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-[11px] font-semibold text-ink">Estimated storage</span>
                <span className="text-sm font-bold text-ink tabular-nums">
                    {formatBytes(perSource)}
                    <span className="text-[11px] font-normal text-ink-muted"> / source</span>
                </span>
            </div>
            {sources > 0 && (
                <p className="mt-1 text-[11px] text-ink-muted tabular-nums">
                    ≈ {formatBytes(perSource * sources)} across {sources.toLocaleString()}{' '}
                    {sources === 1 ? 'source' : 'sources'} reporting today
                </p>
            )}
            {capped && (
                <p className="mt-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                    The row cap bites before the age cutoff — a source capturing this
                    often keeps about {Math.floor(maxRowsPerSource / perDay)} days of raw,
                    not {tiers.rawDays}. Its hourly and daily buckets still cover the
                    full window.
                </p>
            )}
        </div>
    )
}

function formatBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
    return `${Math.max(1, Math.round(bytes / 1024))} kB`
}
