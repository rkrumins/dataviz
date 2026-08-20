/**
 * TimeSeriesChart — multi-series line (optionally area-filled) over time.
 *
 * ONE Y-AXIS, ALWAYS. Two measures of different magnitude get two charts, never
 * two scales on one plot: the alignment between two y-axes is arbitrary, so a
 * dual-axis chart invents a correlation the data does not contain. If a caller
 * wants users and sessions together, that is two `TimeSeriesChart`s.
 *
 * The hover layer is part of the chart, not an upgrade on it. A vertical
 * crosshair snaps to the nearest bucket and ONE tooltip lists every series at
 * that x, so the pointer never has to land on a 2px line to read a value. The
 * hit targets are full-height column bands — the reader aims at a date.
 */
import { useId, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { exact, niceTicks, shortDate } from '@/lib/formatMetric'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

export interface Series {
    key: string
    label: string
    values: number[]
    /** Slot index into the validated categorical palette. Follows the ENTITY —
     *  never reassigned by rank, so filtering cannot repaint the survivors. */
    slot: number
    /** A single-series chart reads better with a wash under the line. */
    area?: boolean
}

interface Props {
    buckets: string[]
    series: Series[]
    height?: number
    /** Label the last point of each series. Off past ~4 series, where end
     *  labels collide and detach from their lines. */
    labelEnds?: boolean
    className?: string
}

// The right gutter holds the end labels. Without room reserved for them they
// paint outside the plot and get clipped by the card.
const PAD = { top: 12, right: 16, bottom: 22, left: 44 }
const LABEL_GUTTER = 52

export function TimeSeriesChart({
    buckets, series, height = 220, labelEnds = true, className,
}: Props) {
    const theme = useChartTheme()
    const gradientId = useId()
    const [hover, setHover] = useState<number | null>(null)
    const [wrapRef, width] = useChartWidth()

    const showEndLabels = labelEnds && series.length <= 4
    const padRight = showEndLabels ? LABEL_GUTTER : PAD.right
    const plotW = Math.max(1, width - PAD.left - padRight)
    const plotH = height - PAD.top - PAD.bottom

    const { max, ticks } = useMemo(() => {
        const peak = Math.max(1, ...series.flatMap((s) => s.values))
        const t = niceTicks(peak)
        return { max: Math.max(peak, t[t.length - 1] ?? peak), ticks: t }
    }, [series])

    const stepX = buckets.length > 1 ? plotW / (buckets.length - 1) : 0
    const x = (i: number) => PAD.left + (buckets.length > 1 ? i * stepX : plotW / 2)
    const y = (v: number) => PAD.top + plotH * (1 - v / max)

    // Show at most ~7 x labels; past that they collide and stop being readable.
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 7))
    const active = hover

    return (
        <div ref={wrapRef} className={cn('relative', className)}>
            <svg
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="overflow-visible"
                role="img"
                aria-label={`${series.map((s) => s.label).join(', ')} over time`}
                onMouseLeave={() => setHover(null)}
            >
                <defs>
                    {series.filter((s) => s.area).map((s) => (
                        <linearGradient key={s.key} id={`${gradientId}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                            {/* A wash, never a saturated block. */}
                            <stop offset="0%" stopColor={theme.series[s.slot % theme.series.length]} stopOpacity={0.16} />
                            <stop offset="100%" stopColor={theme.series[s.slot % theme.series.length]} stopOpacity={0} />
                        </linearGradient>
                    ))}
                </defs>

                {/* Gridlines: hairline, SOLID, one step off the surface. Dashing
                    reads as "threshold" when it is only a grid. */}
                {ticks.map((t) => (
                    <g key={t}>
                        <line
                            x1={PAD.left} y1={y(t)} x2={width - padRight} y2={y(t)}
                            stroke={theme.grid} strokeWidth={1}
                        />
                        <text
                            x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end"
                            className="fill-ink-muted tabular-nums"
                            style={{ fontSize: 10 }}
                        >
                            {exact(t)}
                        </text>
                    </g>
                ))}

                {buckets.map((b, i) => (
                    i % labelEvery === 0 ? (
                        <text
                            key={b} x={x(i)} y={height - 6} textAnchor="middle"
                            className="fill-ink-muted" style={{ fontSize: 10 }}
                        >
                            {shortDate(b)}
                        </text>
                    ) : null
                ))}

                {active !== null && (
                    <line
                        x1={x(active)} y1={PAD.top} x2={x(active)} y2={PAD.top + plotH}
                        stroke={theme.muted} strokeWidth={1}
                    />
                )}

                {series.map((s) => {
                    const color = theme.series[s.slot % theme.series.length]
                    const points = s.values.map((v, i) => `${x(i)},${y(v)}`).join(' ')
                    return (
                        <g key={s.key}>
                            {s.area && buckets.length > 1 && (
                                <polygon
                                    points={`${PAD.left},${PAD.top + plotH} ${points} ${x(s.values.length - 1)},${PAD.top + plotH}`}
                                    fill={`url(#${gradientId}-${s.key})`}
                                />
                            )}
                            <polyline
                                points={points}
                                fill="none"
                                stroke={color}
                                strokeWidth={MARK.lineWidth}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                            />
                            {/* End marker carries a surface ring so it stays
                                legible where series overlap. */}
                            {s.values.length > 0 && (
                                <circle
                                    cx={x(s.values.length - 1)}
                                    cy={y(s.values[s.values.length - 1])}
                                    r={MARK.dotRadius}
                                    fill={color}
                                    stroke={theme.surface}
                                    strokeWidth={MARK.surfaceGap}
                                />
                            )}
                            {active !== null && (
                                <circle
                                    cx={x(active)} cy={y(s.values[active] ?? 0)}
                                    r={MARK.dotRadius} fill={color}
                                    stroke={theme.surface} strokeWidth={MARK.surfaceGap}
                                />
                            )}
                        </g>
                    )
                })}

                {/* Direct labels, sparingly: the endpoint only, and only while
                    series are few enough that the labels don't converge. */}
                {showEndLabels && series.map((s) => {
                    const last = s.values[s.values.length - 1]
                    if (last === undefined) return null
                    return (
                        <text
                            key={`end-${s.key}`}
                            x={x(s.values.length - 1) + 8}
                            y={y(last)} dy="0.32em"
                            className="fill-ink font-semibold tabular-nums"
                            style={{ fontSize: 10 }}
                        >
                            {exact(last)}
                        </text>
                    )
                })}

                {/* Hit bands — full plot height, one per bucket, wider than any
                    mark. The reader aims at a date, not at a line. */}
                {buckets.map((b, i) => (
                    <rect
                        key={`hit-${b}`}
                        x={x(i) - (stepX || plotW) / 2} y={PAD.top}
                        width={stepX || plotW} height={plotH}
                        fill="transparent"
                        onMouseEnter={() => setHover(i)}
                        onFocus={() => setHover(i)}
                        tabIndex={0}
                        role="button"
                        aria-label={`${shortDate(b, true)}: ${series.map((s) => `${s.label} ${exact(s.values[i] ?? 0)}`).join(', ')}`}
                        className="outline-none focus-visible:fill-black/[0.03] dark:focus-visible:fill-white/[0.04]"
                    />
                ))}
            </svg>

            {active !== null && (
                <Tooltip
                    bucket={buckets[active]}
                    rows={series.map((s) => ({
                        label: s.label,
                        value: s.values[active] ?? 0,
                        color: theme.series[s.slot % theme.series.length],
                    }))}
                    leftPct={((x(active) - PAD.left) / plotW) * 100}
                />
            )}
        </div>
    )
}

/** Value leads, label follows — here the reader already has the series and
 *  wants the number. Series are keyed with a short rule, not a filled box:
 *  at tooltip density a swatch is data-weight ink doing a label's job. */
function Tooltip({
    bucket, rows, leftPct,
}: {
    bucket: string
    rows: { label: string; value: number; color: string }[]
    leftPct: number
}) {
    const flip = leftPct > 60
    return (
        <div
            className="pointer-events-none absolute top-2 z-10 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 shadow-lg min-w-[9rem]"
            style={{
                left: `${Math.min(Math.max(leftPct, 0), 100)}%`,
                transform: flip ? 'translateX(-100%) translateX(-12px)' : 'translateX(12px)',
            }}
        >
            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted mb-1.5">
                {shortDate(bucket, true)}
            </p>
            <ul className="space-y-1">
                {rows.map((r) => (
                    <li key={r.label} className="flex items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5 min-w-0">
                            <span aria-hidden className="w-3 h-[2px] rounded-full shrink-0"
                                  style={{ backgroundColor: r.color }} />
                            <span className="text-[11px] text-ink-secondary truncate">{r.label}</span>
                        </span>
                        <span className="text-xs font-bold text-ink tabular-nums">
                            {exact(r.value)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    )
}
