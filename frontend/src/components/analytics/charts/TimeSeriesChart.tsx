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
import { useCallback, useId, useMemo, useState } from 'react'

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
    /**
     * The same measure over the previous period, aligned by bucket INDEX.
     *
     * Drawn as a recessive "ghost" behind the live line. The KPI delta already
     * says a number moved; this says what SHAPE the move was — steady growth,
     * a single spike, or a collapse late in the period all produce the same
     * percentage and look completely different here.
     *
     * Deliberately the same hue as its series at low opacity, not a separate
     * categorical colour: it is the same entity at a different time, and giving
     * it its own slot would spend a palette colour saying "past".
     */
    previous?: number[]
}

interface Props {
    buckets: string[]
    series: Series[]
    height?: number
    /** Label the last point of each series. Off past ~4 series, where end
     *  labels collide and detach from their lines. */
    labelEnds?: boolean
    /** Draw the previous period behind each series that supplies one. */
    showPrevious?: boolean
    /**
     * Dated events to mark on the timeline — a release, an announcement.
     *
     * A spike with no explanation is a mystery; a spike with "v2.1 shipped"
     * beside it is a finding. Drawn as a recessive vertical rule so it reads as
     * chrome, never as data: an annotation is context ABOUT the series, and
     * giving it a mark's weight would put it in competition with the values.
     */
    annotations?: { bucket: string; title: string }[]
    /**
     * Anchor the y-axis here instead of at zero.
     *
     * Only for measures DEFINED relative to a value — an index where 100 means
     * "unchanged since the start of the window". For a count, zero is the
     * baseline and anything else exaggerates the shape, so this stays
     * undefined. Clamped to the data so it can never clip a series.
     */
    baseline?: number
    className?: string
}

// The right gutter holds the end labels. Without room reserved for them they
// paint outside the plot and get clipped by the card.
const PAD = { top: 12, right: 16, bottom: 22, left: 44 }
const LABEL_GUTTER = 52

export function TimeSeriesChart({
    buckets, series, height = 220, labelEnds = true, showPrevious = true,
    annotations, baseline, className,
}: Props) {
    const theme = useChartTheme()
    const gradientId = useId()
    const [hover, setHover] = useState<number | null>(null)
    const [wrapRef, width] = useChartWidth()

    const showEndLabels = labelEnds && series.length <= 4
    const padRight = showEndLabels ? LABEL_GUTTER : PAD.right
    const plotW = Math.max(1, width - PAD.left - padRight)
    const plotH = height - PAD.top - PAD.bottom

    // Memoised: a fresh array each render would re-run the scale computation
    // below on every pointer move, since `ghosted` is one of its dependencies.
    const ghosted = useMemo(
        () => (showPrevious
            ? series.filter((s) => s.previous?.length === buckets.length)
            : []),
        [showPrevious, series, buckets.length],
    )

    const { min, max, ticks } = useMemo(() => {
        // The ghost is inside the scale on purpose: leaving it out would let a
        // previous period larger than this one run off the top of the plot,
        // which reads as "we were doing fine" rather than "we shrank".
        const all = [
            ...series.flatMap((s) => s.values),
            ...ghosted.flatMap((s) => s.previous ?? []),
        ]
        const peak = Math.max(1, ...all)
        if (baseline === undefined) {
            const t = niceTicks(peak)
            return { min: 0, max: Math.max(peak, t[t.length - 1] ?? peak), ticks: t }
        }
        // An anchored scale: `baseline` is the value the measure is defined
        // relative to, so the axis starts there rather than at zero. Never
        // above the data — a floor that clipped a series would be a lie, not a
        // zoom.
        const floor = Math.min(baseline, ...all)
        const span = niceTicks(Math.max(1, peak - floor))
        const step = span[1] ?? 1
        const top = floor + (span[span.length - 1] ?? 1)
        return {
            min: floor,
            max: Math.max(top, peak),
            ticks: span.map((t) => floor + t).filter((t) => t <= Math.max(top, peak) + step * 0.001),
        }
    }, [series, ghosted, baseline])

    // The scales are `useCallback`ed rather than recreated per render, so the
    // memoised layers below can depend on them HONESTLY. Left as plain arrow
    // functions they would be new on every hover, and the memos would either
    // invalidate constantly (no saving) or omit them from the dependency list
    // and quietly hold a stale scale after a resize.
    const stepX = buckets.length > 1 ? plotW / (buckets.length - 1) : 0
    const x = useCallback(
        (i: number) => PAD.left + (buckets.length > 1 ? i * stepX : plotW / 2),
        [buckets.length, stepX, plotW],
    )
    const y = useCallback(
        (v: number) => PAD.top + plotH * (1 - (v - min) / Math.max(1, max - min)),
        [plotH, max, min],
    )

    // Show at most ~7 x labels; past that they collide and stop being readable.
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 7))
    const active = hover

    // ── Static layers ────────────────────────────────────────────────
    // Hover lives in this component's state, so every pointer move re-runs
    // the whole render. Memoising the layers that do NOT depend on it means
    // React reuses the identical element trees and skips reconciling them —
    // a mousemove repaints a crosshair, two dots and a tooltip instead of
    // every gridline, polyline and axis label in the chart.
    //
    // `series`, `buckets` and `theme` are all referentially stable across a
    // hover change (they come from props and a memoised hook, and the parent
    // does not re-render on hover), so these memos genuinely hold.
    const staticGrid = useMemo(() => (
        <>
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
        </>
    ), [ticks, buckets, labelEvery, width, padRight, theme, height, x, y])

    // Only the annotations that land on a bucket in this window — the plot and
    // the key below it must name exactly the same set.
    const marked = useMemo(
        () => (annotations ?? []).filter((a) => buckets.includes(a.bucket)),
        [annotations, buckets],
    )

    const staticMarks = useMemo(() => (
        <>
                {/* Annotations sit under the crosshair and under every mark:
                    they explain the data, they are not part of it. */}
                {marked.map((a) => {
                    const i = buckets.indexOf(a.bucket)
                    return (
                        <g key={`${a.bucket}-${a.title}`}>
                            <line
                                x1={x(i)} y1={PAD.top} x2={x(i)} y2={PAD.top + plotH}
                                stroke={theme.muted} strokeWidth={1}
                            />
                            {/* A small flag rather than inline text: the label
                                would collide with the marks at this density. */}
                            <circle
                                cx={x(i)} cy={PAD.top} r={3}
                                fill={theme.neutralMark}
                                stroke={theme.surface} strokeWidth={MARK.surfaceGap}
                            >
                                <title>{a.title}</title>
                            </circle>
                        </g>
                    )
                })}
                {/* Ghosts first, so the live lines paint over them. Thinner
                    and faded: a comparison should never out-shout the thing it
                    is a comparison FOR. No end dot, no label — the reader is
                    meant to see a shape, not read values off it. */}
                {ghosted.map((s) => (
                    <polyline
                        key={`ghost-${s.key}`}
                        points={(s.previous ?? []).map((v, i) => `${x(i)},${y(v)}`).join(' ')}
                        fill="none"
                        stroke={theme.series[s.slot % theme.series.length]}
                        strokeWidth={1.5}
                        strokeOpacity={MARK.ghostOpacity}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                    />
                ))}

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
                        </g>
                    )
                })}
        </>
    ), [marked, buckets, ghosted, series, gradientId, plotH, theme, x, y])

    const staticTail = useMemo(() => (
        <>
                {/* Direct labels, sparingly: the endpoint only, and only while
                    series are few enough that the labels don't converge.

                    "Few enough" was a COUNT, which is the wrong test: three
                    series whose endpoints land within a few pixels of each
                    other overprint into an unreadable smudge however few they
                    are. Endpoints closer than a line-height to one already
                    placed are dropped — the tooltip and the table still carry
                    the exact values. */}
                {showEndLabels && (() => {
                    const placed: number[] = []
                    return series.map((s) => {
                    const last = s.values[s.values.length - 1]
                    if (last === undefined) return null
                    const at = y(last)
                    if (placed.some((p) => Math.abs(p - at) < 11)) return null
                    placed.push(at)
                    return (
                        <text
                            key={`end-${s.key}`}
                            x={x(s.values.length - 1) + 8}
                            y={at} dy="0.32em"
                            className="fill-ink font-semibold tabular-nums"
                            style={{ fontSize: 10 }}
                        >
                            {exact(last)}
                        </text>
                    )
                    })
                })()}

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
                        aria-label={`${shortDate(b, true)}: ${series.map((s) => {
                            const now = `${s.label} ${exact(s.values[i] ?? 0)}`
                            const was = showPrevious && s.previous?.length === buckets.length
                                ? `, previously ${exact(s.previous[i] ?? 0)}` : ''
                            return now + was
                        }).join(', ')}`}
                        className="outline-none focus-visible:fill-black/[0.03] dark:focus-visible:fill-white/[0.04]"
                    />
                ))}
        </>
    ), [showEndLabels, series, buckets, plotH, plotW, stepX, showPrevious, x, y])

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

                {staticGrid}

                {active !== null && (
                    <line
                        x1={x(active)} y1={PAD.top} x2={x(active)} y2={PAD.top + plotH}
                        stroke={theme.muted} strokeWidth={1}
                    />
                )}

                {staticMarks}

                {/* Hover dots live OUTSIDE the marks layer above. Inside it,
                    every pointer move would invalidate the memo and repaint
                    every polyline in the chart; out here only these few
                    circles change. */}
                {active !== null && series.map((s) => (
                    <circle
                        key={`hover-${s.key}`}
                        cx={x(active)} cy={y(s.values[active] ?? 0)}
                        r={MARK.dotRadius}
                        fill={theme.series[s.slot % theme.series.length]}
                        stroke={theme.surface} strokeWidth={MARK.surfaceGap}
                    />
                ))}

                {staticTail}
            </svg>

            {active !== null && (
                <Tooltip
                    bucket={buckets[active]}
                    rows={series.map((s) => ({
                        label: s.label,
                        value: s.values[active] ?? 0,
                        color: theme.series[s.slot % theme.series.length],
                        // The ghost is drawn but never labelled on the plot, so
                        // the tooltip is where its value becomes readable —
                        // otherwise the comparison is a shape you cannot check.
                        previous: showPrevious && s.previous?.length === buckets.length
                            ? s.previous[active] ?? 0
                            : undefined,
                    }))}
                    leftPct={((x(active) - PAD.left) / plotW) * 100}
                />
            )}

            {/* The annotation KEY. The flag on the plot carries an SVG
                `<title>`, which is a hover tooltip and nothing else: it does
                not print, does not survive a screenshot, and cannot be reached
                by keyboard — so an unexplained vertical rule reads as a
                rendering artefact. Naming each mark once, below the plot,
                costs a line and cannot collide with anything. */}
            {marked.length > 0 && (
                <ul className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                    {marked.map((a) => (
                        <li key={`${a.bucket}-${a.title}`} className="flex items-center gap-1.5 text-[11px]">
                            <span
                                aria-hidden
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{ backgroundColor: theme.neutralMark }}
                            />
                            {/* No year: the key must read as the same date the
                                axis prints, and "Jun 8, 26" also scans as a
                                range rather than as one day. */}
                            <span className="font-semibold text-ink-secondary tabular-nums">
                                {shortDate(a.bucket)}
                            </span>
                            <span className="text-ink-muted">{a.title}</span>
                        </li>
                    ))}
                </ul>
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
    rows: {
        label: string; value: number; color: string; previous?: number
    }[]
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
                        <span className="flex items-baseline gap-1.5 shrink-0">
                            <span className="text-xs font-bold text-ink tabular-nums">
                                {exact(r.value)}
                            </span>
                            {r.previous !== undefined && (
                                <span
                                    className="text-[10px] text-ink-muted tabular-nums"
                                    title="Same point in the previous period"
                                >
                                    was {exact(r.previous)}
                                </span>
                            )}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    )
}
