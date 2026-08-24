/**
 * StackedAreaChart — composition over time.
 *
 * The chart system had lines, bars, a share bar and a heatmap, but nothing
 * that answers "what is this made of, and how did the mix change". That is the
 * whole question a data source's profile asks, so it belongs here beside the
 * others rather than in the surface that first needed it — same theme, same
 * frame, same table twin.
 *
 * TWO DECISIONS SPECIFIC TO THIS MARK
 *
 * **Bands are ordered by size, largest at the baseline.** A stacked area is
 * read from the axis up, and the band touching the axis is the only one whose
 * thickness a reader can judge without subtracting. Putting the biggest there
 * means the value people most want is the one they can actually see.
 *
 * **A band that reaches zero gets a terminator.** This is the point of the
 * whole component. On an ordinary stacked chart a category disappearing looks
 * exactly like a category shrinking — the band simply thins until it is gone,
 * and on a chart with eight bands nobody notices. A type reaching zero is the
 * clearest evidence something deleted data, so it is drawn as a MARK: a rule
 * at the moment it happened, in the band's own colour, with the type named.
 * An absence becomes an event.
 */
import { useId, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { compact, exact } from '@/lib/formatMetric'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

export interface StackedSeries {
    key: string
    label: string
    values: number[]
    /** Slot into the validated categorical palette. Follows the ENTITY, never
     *  the rank, so a filter cannot repaint the survivors. */
    slot: number
    /** The residual bucket. Painted with the neutral mark rather than a
     *  categorical slot: "Other" is not a category, and spending a palette
     *  colour on it makes the real classes harder to tell apart. */
    residual?: boolean
}

interface Props {
    buckets: string[]
    series: StackedSeries[]
    height?: number
    /** Formats a bucket key for the readout and the tooltip — read alone, so
     *  it must carry the whole date. */
    formatBucket?: (bucket: string) => string
    /** Compact labels for the x-axis, where a tick may elide whatever the
     *  previous one already said. Falls back to `formatBucket`. */
    axisLabels?: string[]
    /**
     * Normalise every bucket to 100%.
     *
     * Absolute counts hide a mix change: a graph that doubled uniformly and
     * one that doubled because a single type exploded draw almost the same
     * stack. Share answers "did the composition drift" independently of size,
     * which is a different question with a different answer — and the same
     * mark, which is why it lives here rather than in a second component.
     *
     * A bucket whose total is zero has no shares to draw. It renders as a gap
     * rather than as an even split, because an even split is a claim.
     */
    share?: boolean
    className?: string
}

const PAD = { top: 14, right: 16, bottom: 24, left: 48 }

function niceMax(value: number): number {
    if (value <= 0) return 1
    const magnitude = 10 ** Math.floor(Math.log10(value))
    return Math.ceil(value / magnitude) * magnitude
}

export function StackedAreaChart({
    buckets, series, height = 260, formatBucket, axisLabels, share, className,
}: Props) {
    const theme = useChartTheme()
    const clipId = useId()
    const [wrapRef, width] = useChartWidth()
    const [hover, setHover] = useState<number | null>(null)

    const plotW = Math.max(1, width - PAD.left - PAD.right)
    const plotH = height - PAD.top - PAD.bottom

    const { ordered, stacks, max, terminators, totals } = useMemo(() => {
        // Largest band at the baseline; the residual is always last, whatever
        // its size, because it is not a peer of the named classes.
        const peak = (s: StackedSeries) => Math.max(0, ...s.values)
        const ranked = [...series].sort((a, b) => {
            if (a.residual !== b.residual) return a.residual ? 1 : -1
            return peak(b) - peak(a)
        })

        // Bucket totals first: share mode divides by them, and the absolute
        // mode's ceiling is their peak.
        const bucketTotals = buckets.map((_b, i) => ranked.reduce(
            (sum, s) => sum + Math.max(0, s.values[i] || 0), 0,
        ))

        // Cumulative tops, so each band is drawn between its own running total
        // and the one below it.
        const running = new Array(buckets.length).fill(0)
        const tops: number[][] = []
        for (const s of ranked) {
            const top = s.values.map((v, i) => {
                running[i] += Math.max(0, v || 0)
                if (!share) return running[i]
                // A zero-total bucket has no shares. Carrying the previous
                // band's top would draw a split that was never observed.
                return bucketTotals[i] ? (running[i] / bucketTotals[i]) * 100 : 0
            })
            tops.push([...top])
        }
        const total = share
            ? 100
            : (running.length ? Math.max(...running) : 0)

        // A band terminates where it goes from present to zero and stays
        // there. "Stays there" matters: a nightly rebuild that drops and
        // recreates a type is not a disappearance, and marking it would train
        // people to ignore the mark.
        const ends: { index: number; series: StackedSeries; from: number }[] = []
        ranked.forEach((s) => {
            if (s.residual) return
            for (let i = 1; i < s.values.length; i += 1) {
                const before = s.values[i - 1] || 0
                if (before > 0 && !s.values[i] && s.values.slice(i).every((v) => !v)) {
                    ends.push({ index: i, series: s, from: before })
                    break
                }
            }
        })

        return {
            ordered: ranked,
            stacks: tops,
            max: share ? 100 : niceMax(total),
            terminators: ends,
            totals: bucketTotals,
        }
    }, [series, buckets, share])

    if (!buckets.length || !series.length) return null

    const x = (i: number) => (
        buckets.length === 1
            ? PAD.left + plotW / 2
            : PAD.left + (i / (buckets.length - 1)) * plotW
    )
    const y = (v: number) => PAD.top + plotH - (v / max) * plotH

    const label = (b: string) => (formatBucket ? formatBucket(b) : b)
    const active = hover ?? buckets.length - 1

    // Axis ticks: at most six, always including both ends.
    const tickStep = Math.max(1, Math.ceil(buckets.length / 6))
    const tickIndexes = buckets
        .map((_, i) => i)
        .filter((i) => i % tickStep === 0 || i === buckets.length - 1)

    return (
        <div ref={wrapRef} className={cn('relative w-full', className)}>
            <svg
                width={width} height={height} role="img"
                aria-label={
                    share
                        ? `Composition share over ${buckets.length} buckets, `
                          + `${ordered.length} series`
                        : `Composition over ${buckets.length} buckets, `
                          + `${ordered.length} series, peak ${exact(max)}`
                }
                onMouseLeave={() => setHover(null)}
            >
                <defs>
                    <clipPath id={clipId}>
                        <rect
                            x={PAD.left} y={PAD.top}
                            width={plotW} height={plotH}
                        />
                    </clipPath>
                </defs>

                {[0, 0.5, 1].map((f) => (
                    <line
                        key={f}
                        x1={PAD.left} x2={PAD.left + plotW}
                        y1={y(max * f)} y2={y(max * f)}
                        stroke={theme.grid} strokeWidth={1}
                    />
                ))}
                {[0, 0.5, 1].map((f) => (
                    <text
                        key={`t${f}`} x={PAD.left - 8} y={y(max * f) + 4}
                        textAnchor="end" fontSize={10} fill="currentColor"
                        className="text-ink-muted tabular-nums"
                    >
                        {share ? `${Math.round(max * f)}%` : compact(max * f)}
                    </text>
                ))}

                <g clipPath={`url(#${clipId})`}>
                    {ordered.map((s, si) => {
                        const top = stacks[si]
                        const bottom = si === 0
                            ? new Array(buckets.length).fill(0)
                            : stacks[si - 1]
                        const forward = top
                            .map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`)
                            .join('')
                        const back = [...bottom]
                            .map((v, i) => ({ v, i }))
                            .reverse()
                            .map(({ v, i }) => `L${x(i)},${y(v)}`)
                            .join('')
                        const colour = s.residual
                            ? theme.neutralMark
                            : theme.series[s.slot % theme.series.length]
                        return (
                            <path
                                key={s.key}
                                d={`${forward}${back}Z`}
                                fill={colour}
                                fillOpacity={s.residual ? 0.45 : 0.78}
                                stroke={colour}
                                strokeWidth={1}
                            />
                        )
                    })}
                </g>

                {/* The signature mark: a type that reached zero, named. */}
                {terminators.map(({ index, series: s, from }) => {
                    const colour = theme.series[s.slot % theme.series.length]
                    return (
                        <g key={`end-${s.key}`}>
                            <line
                                x1={x(index)} x2={x(index)}
                                y1={PAD.top} y2={PAD.top + plotH}
                                stroke={colour} strokeWidth={1.5}
                                strokeDasharray="3 3" opacity={0.85}
                            />
                            <circle
                                cx={x(index)} cy={PAD.top + plotH}
                                r={4} fill={colour}
                                stroke={theme.surface} strokeWidth={MARK.surfaceGap}
                            />
                            <title>
                                {`${s.label} reached zero at ${label(buckets[index])} `
                                    + `(was ${exact(from)})`}
                            </title>
                        </g>
                    )
                })}

                {hover !== null && (
                    <line
                        x1={x(hover)} x2={x(hover)}
                        y1={PAD.top} y2={PAD.top + plotH}
                        stroke={theme.muted} strokeWidth={1}
                    />
                )}

                {tickIndexes.map((i) => (
                    <text
                        key={`x${i}`} x={x(i)} y={height - 6}
                        textAnchor={
                            i === 0 ? 'start'
                                : i === buckets.length - 1 ? 'end' : 'middle'
                        }
                        fontSize={10} fill="currentColor"
                        className="text-ink-muted"
                    >
                        {axisLabels?.[i] ?? label(buckets[i])}
                    </text>
                ))}

                {/* Full-height hit targets, wider than any mark they select. */}
                {buckets.map((b, i) => (
                    <rect
                        key={`hit-${b}-${i}`}
                        x={x(i) - Math.max(MARK.minHitTarget, plotW / buckets.length) / 2}
                        y={PAD.top}
                        width={Math.max(MARK.minHitTarget, plotW / buckets.length)}
                        height={plotH}
                        fill="transparent"
                        onMouseEnter={() => setHover(i)}
                    />
                ))}
            </svg>

            {/*
              BOTH, and each does a job the other cannot.

              The floating tooltip puts the number where the reader is already
              looking, which is what a line chart in this system does and what
              made the stacked one feel like it was withholding the figure. The
              fixed readout below stays because a tooltip ENHANCES a chart and
              must never gate it: on touch, and for anyone reading with a
              keyboard, a hover-only value is no value at all.
            */}
            {hover !== null && (
                <StackedTooltip
                    bucket={label(buckets[hover])}
                    total={totals[hover] || 0}
                    share={share}
                    rows={ordered
                        .map((s) => ({
                            label: s.label,
                            value: s.values[hover] || 0,
                            color: s.residual
                                ? theme.neutralMark
                                : theme.series[s.slot % theme.series.length],
                        }))
                        .filter((r) => r.value > 0)}
                    leftPct={(x(hover) / Math.max(1, width)) * 100}
                />
            )}
            <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs">
                <span className="font-semibold text-ink tabular-nums">
                    {label(buckets[active])}
                </span>
                {/* The sum. Eight bands stacked to 568,091 is a number a
                    reader can only get by adding them up by hand. */}
                <span className="inline-flex items-baseline gap-1.5">
                    <span className="text-ink-muted">Total</span>
                    <span className="text-ink font-bold tabular-nums">
                        {exact(totals[active] || 0)}
                    </span>
                </span>
                {ordered.map((s) => {
                    const value = s.values[active] || 0
                    if (!value) return null
                    const bucketTotal = totals[active] || 0
                    const pct = bucketTotal ? (value / bucketTotal) * 100 : 0
                    const colour = s.residual
                        ? theme.neutralMark
                        : theme.series[s.slot % theme.series.length]
                    return (
                        <span key={s.key} className="inline-flex items-center gap-1.5">
                            <span
                                className="w-2 h-2 rounded-sm shrink-0"
                                style={{ backgroundColor: colour }}
                                aria-hidden
                            />
                            <span className="text-ink-secondary">{s.label}</span>
                            <span className="text-ink font-semibold tabular-nums">
                                {exact(value)}
                            </span>
                            {/* Share without the count answers "how much of
                                the whole" and hides "how much". Both, always. */}
                            {share && (
                                <span className="text-ink-muted tabular-nums">
                                    {pct.toFixed(1)}%
                                </span>
                            )}
                        </span>
                    )
                })}
            </div>
        </div>
    )
}


/** Value leads, label follows — the reader already has the series and wants
 *  the number. Mirrors `TimeSeriesChart`'s tooltip so the two marks in this
 *  system answer a hover the same way. */
function StackedTooltip({
    bucket, rows, total, share, leftPct,
}: {
    bucket: string
    rows: { label: string; value: number; color: string }[]
    total: number
    share?: boolean
    leftPct: number
}) {
    const flip = leftPct > 60
    return (
        <div
            className="pointer-events-none absolute top-2 z-10 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 shadow-lg min-w-[11rem] max-w-[16rem]"
            style={{
                left: `${Math.min(Math.max(leftPct, 0), 100)}%`,
                transform: flip ? 'translateX(-100%) translateX(-12px)' : 'translateX(12px)',
            }}
        >
            <p className="flex items-baseline justify-between gap-3 text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
                <span>{bucket}</span>
                <span className="text-ink tabular-nums normal-case">{exact(total)}</span>
            </p>
            <ul className="space-y-1">
                {rows.slice(0, 10).map((r) => (
                    <li key={r.label} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 min-w-0">
                            <span aria-hidden className="w-3 h-[2px] rounded-full shrink-0"
                                  style={{ backgroundColor: r.color }} />
                            <span className="text-[11px] text-ink-secondary truncate">{r.label}</span>
                        </span>
                        <span className="flex items-baseline gap-1.5 shrink-0">
                            <span className="text-xs font-bold text-ink tabular-nums">
                                {exact(r.value)}
                            </span>
                            {share && total > 0 && (
                                <span className="text-[10px] text-ink-muted tabular-nums">
                                    {((r.value / total) * 100).toFixed(1)}%
                                </span>
                            )}
                        </span>
                    </li>
                ))}
                {rows.length > 10 && (
                    <li className="text-[10px] text-ink-muted pt-0.5">
                        and {rows.length - 10} more
                    </li>
                )}
            </ul>
        </div>
    )
}
