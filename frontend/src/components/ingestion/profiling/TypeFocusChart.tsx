/**
 * One type, at full size, with its own axis.
 *
 * The trellis answers "which type moved" by keeping every panel on one scale.
 * This answers the next question — "so what did THAT one do" — and to do that
 * it has to abandon the shared scale entirely: a type holding 12 of a graph's
 * 40,000 entities is a flat line at the bottom of any comparable axis, and its
 * whole story lives in the range the trellis deliberately flattens.
 *
 * So the two are not redundant. One is for comparing, one is for reading, and
 * each is wrong for the other job.
 */
import { useMemo } from 'react'

import { exact } from '@/lib/formatMetric'
import { ChartTable } from '@/components/analytics/charts/ChartTable'
import { TimeSeriesChart } from '@/components/analytics/charts/TimeSeriesChart'
import { axisLabels, deltaTone, formatBucketUtc, metricNoun, signed } from './shared'
import { cn } from '@/lib/utils'

export function TypeFocusChart({
    label, buckets, values, kind,
}: {
    label: string
    buckets: string[]
    values: number[]
    kind: 'nodes' | 'edges'
}) {
    const first = values[0] ?? 0
    const last = values.at(-1) ?? 0
    const delta = last - first
    const peak = Math.max(0, ...values)
    const trough = Math.min(...values, 0)

    const series = useMemo(() => [{
        key: label,
        label,
        values,
        slot: 0,
        area: true,
    }], [label, values])

    if (buckets.length < 2) {
        return (
            <p className="text-xs text-ink-muted py-3">
                {label} has one observation so far — {exact(last)}{' '}
                {metricNoun(kind, last)}. There is nothing to plot until the next
                capture gives it something to move against.
            </p>
        )
    }

    return (
        // `min-w-0` + `overflow-hidden`: the chart draws at its measured
        // container width and falls back to 720px until the observer fires.
        // Inside a table cell that transient width would push the whole
        // table past the drawer; contained, it simply resolves.
        <div className="rounded-xl border border-glass-border bg-canvas-elevated p-4 min-w-0 overflow-hidden">
            <div className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
                <div>
                    <h4 className="text-sm font-bold text-ink">{label} over time</h4>
                    <p className="text-xs text-ink-muted mt-0.5">
                        Its own axis — the trellis shares one so panels compare;
                        this one fits so the shape reads.
                    </p>
                </div>
                <dl className="flex items-baseline gap-4 text-xs tabular-nums">
                    <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink-muted">Start</dt>
                        <dd className="font-semibold text-ink-secondary">{exact(first)}</dd>
                    </div>
                    <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink-muted">Now</dt>
                        <dd className="font-semibold text-ink">{exact(last)}</dd>
                    </div>
                    <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink-muted">Peak</dt>
                        <dd className="font-semibold text-ink-secondary">{exact(peak)}</dd>
                    </div>
                    <div>
                        <dt className="text-[10px] uppercase tracking-wide text-ink-muted">Change</dt>
                        <dd className={cn('font-semibold', deltaTone(delta))}>{signed(delta)}</dd>
                    </div>
                </dl>
            </div>

            <TimeSeriesChart
                buckets={buckets.map(formatBucketUtc)}
                axisLabels={axisLabels(buckets)}
                series={series}
                height={180}
            />

            {last === 0 && first > 0 && (
                <p className="mt-3 text-xs text-rose-600 dark:text-rose-400">
                    This type is gone. It held {exact(first)} {metricNoun(kind, first)} at
                    the start of the window and none at the end.
                </p>
            )}

            <details className="mt-3">
                <summary className="text-xs font-semibold text-ink-secondary cursor-pointer hover:text-ink">
                    Show the numbers
                </summary>
                <div className="mt-2">
                    <ChartTable
                        rowLabel="Bucket"
                        rows={buckets.map(formatBucketUtc)}
                        columns={[{ key: label, label, values }]}
                        caption={`${label} over time`}
                    />
                </div>
            </details>

            <span className="sr-only">
                {label} ranged from {exact(trough)} to {exact(peak)} across the window.
            </span>
        </div>
    )
}
