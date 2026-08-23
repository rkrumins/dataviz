/**
 * CountTimeline — the counts-over-time chart.
 *
 * Hand-rolled SVG, following the house rule this app states outright in
 * `ui/Sparkline.tsx`: *"no chart lib in this app; precedent: SchemaHealthRing"*.
 * Everything here is one `<svg>`, the same invisible-`<rect>` hit-target
 * technique `Sparkline` uses, and Tailwind tokens for anything not a series
 * colour.
 *
 * Three modes, because "what changed" has three different shapes:
 *
 *   * **Composition** — a stacked area per label. The default, because a label
 *     appearing or vanishing is the thing this whole feature exists to make
 *     visible, and only a stacked view shows it without hunting.
 *   * **Total** — one line. For "is this growing", where per-label detail is
 *     noise.
 *   * **Compare** — small multiples, one mini-chart per label on its own
 *     scale. A label with 400 rows is invisible beside one with 4 million in a
 *     stack; here it isn't.
 *
 * Two details that are not decoration:
 *
 *   * The **min/max band** behind the line at hour/day grain. Downsampling
 *     keeps one value per bucket, so a drop that happened and recovered inside
 *     a bucket would vanish — precisely the event a reader came for.
 *   * The **drop markers**. A material negative movement gets a marker on the
 *     axis, so "when did something delete data" is answered by looking rather
 *     than by scrubbing.
 */
import { useId, useMemo, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { HistoryPoint } from '@/types/insights'
import {
    OTHER_COLOR, axisLabel, clockUtc, compactNum, laneMeta, seriesColor,
    severityMeta, signedNum,
} from './shared'

export type TimelineMode = 'composition' | 'total' | 'compare'

/** Labels drawn individually before the rest collapse into "Other". Eight is
 *  where a stack stops being readable — beyond it the bands are thinner than
 *  their own borders. */
const TOP_LABELS = 8

const PAD = { top: 16, right: 12, bottom: 26, left: 48 }

export interface CountTimelineProps {
    points: HistoryPoint[]
    grain: string
    mode: TimelineMode
    /** `entity_type_counts` (nodes) or `edge_type_counts` (relationships). */
    field?: 'entity_type_counts' | 'edge_type_counts'
    height?: number
    /** Called when a drop marker is activated, so the page can reveal the
     *  matching entry in the change ledger. */
    onDropSelect?: (at: string) => void
    className?: string
}

interface Series {
    label: string
    color: string
    values: number[]
}

/** Top-N labels by peak value, with the remainder summed into "Other".
 *
 *  Ranked by peak rather than by final value on purpose: a label that was
 *  large and is now zero is the single most interesting series on the page,
 *  and ranking by "last" would bury it in Other. */
function buildSeries(points: HistoryPoint[], field: CountTimelineProps['field']): Series[] {
    const key = field ?? 'entity_type_counts'
    const peaks = new Map<string, number>()
    for (const point of points) {
        for (const [label, count] of Object.entries(point[key] || {})) {
            peaks.set(label, Math.max(peaks.get(label) ?? 0, Number(count) || 0))
        }
    }
    const ranked = [...peaks.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l)
    const top = ranked.slice(0, TOP_LABELS)
    const rest = new Set(ranked.slice(TOP_LABELS))

    const series: Series[] = top.map((label, i) => ({
        label,
        color: seriesColor(i),
        values: points.map((p) => Number((p[key] || {})[label] ?? 0) || 0),
    }))
    if (rest.size) {
        series.push({
            label: `Other (${rest.size})`,
            color: OTHER_COLOR,
            values: points.map((p) =>
                [...rest].reduce((sum, l) => sum + (Number((p[key] || {})[l] ?? 0) || 0), 0),
            ),
        })
    }
    return series
}

/** A "nice" axis maximum — 1/2/5 × 10ⁿ at or above the peak, so the gridlines
 *  land on numbers a person would have chosen. */
function niceMax(value: number): number {
    if (value <= 0) return 1
    const magnitude = 10 ** Math.floor(Math.log10(value))
    const normalized = value / magnitude
    const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
    return step * magnitude
}

export function CountTimeline({
    points, grain, mode, field = 'entity_type_counts',
    height = 260, onDropSelect, className,
}: CountTimelineProps) {
    const clipId = useId()
    const [hover, setHover] = useState<number | null>(null)

    const series = useMemo(() => buildSeries(points, field), [points, field])
    const totals = useMemo(
        () => points.map((p) => (field === 'edge_type_counts' ? p.edge_count : p.node_count)),
        [points, field],
    )

    // Below three points there is no trend to draw — the same floor Sparkline
    // uses. The caller renders its own "history starts here" state.
    if (points.length < 2) return null

    if (mode === 'compare') {
        return <SmallMultiples series={series} points={points} grain={grain} className={className} />
    }

    const width = 1000 // viewBox units; the SVG scales to its container
    const innerW = width - PAD.left - PAD.right
    const innerH = height - PAD.top - PAD.bottom
    const stepX = points.length > 1 ? innerW / (points.length - 1) : innerW

    const bandLows = points.map((p, i) => p.node_min ?? totals[i])
    const bandHighs = points.map((p, i) => p.node_max ?? totals[i])
    const showBand =
        grain !== 'raw' &&
        field === 'entity_type_counts' &&
        bandHighs.some((high, i) => high > bandLows[i])

    const peak = mode === 'total'
        ? Math.max(...totals, ...(showBand ? bandHighs : []), 1)
        : Math.max(...points.map((_, i) => series.reduce((s, ser) => s + ser.values[i], 0)), 1)
    const max = niceMax(peak)

    const x = (i: number) => PAD.left + i * stepX
    const y = (v: number) => PAD.top + innerH * (1 - v / max)

    // Stacked bands, bottom-up: each area is its own upper edge plus the
    // reversed edge below it.
    const stacked: Array<{ label: string; color: string; path: string }> = []
    if (mode === 'composition') {
        const running = new Array(points.length).fill(0)
        for (const ser of series) {
            const upper = ser.values.map((v, i) => running[i] + v)
            const top = upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
            const bottom = running
                .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
                .reverse()
            stacked.push({
                label: ser.label,
                color: ser.color,
                path: `M${top.join('L')}L${bottom.join('L')}Z`,
            })
            for (let i = 0; i < running.length; i += 1) running[i] = upper[i]
        }
    }

    const totalPath = totals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const bandPath = showBand
        ? `M${bandHighs.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('L')}` +
          `L${bandLows.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse().join('L')}Z`
        : null

    // Marked because the server judged the movement unusual FOR THIS SOURCE
    // — the median absolute delta in the window, not a share of the axis. A
    // fixed fraction marked every nightly rebuild on a churning source and
    // nothing at all on a large one losing a small label.
    const marked = points
        .map((p, i) => ({ point: p, index: i }))
        .filter(({ point }) => point.significance !== 'normal')

    const gridValues = [0, 0.25, 0.5, 0.75, 1].map((f) => max * f)
    const tickEvery = Math.max(1, Math.ceil(points.length / 6))
    const active = hover ?? points.length - 1

    return (
        <div className={cn('relative', className)}>
            <svg
                viewBox={`0 0 ${width} ${height}`}
                className="w-full h-auto overflow-visible"
                role="img"
                aria-label={
                    `Entity counts over time: ${points.length} observations, ` +
                    `${compactNum(totals[0])} to ${compactNum(totals[totals.length - 1])}`
                }
                onMouseLeave={() => setHover(null)}
            >
                <defs>
                    <clipPath id={clipId}>
                        <rect x={PAD.left} y={PAD.top} width={innerW} height={innerH} />
                    </clipPath>
                </defs>

                {/* Gridlines + value axis */}
                {gridValues.map((v) => (
                    <g key={v}>
                        <line
                            x1={PAD.left} x2={width - PAD.right}
                            y1={y(v)} y2={y(v)}
                            className="stroke-black/[0.07] dark:stroke-white/[0.07]"
                            strokeWidth="1"
                        />
                        <text
                            x={PAD.left - 8} y={y(v) + 3.5}
                            textAnchor="end"
                            className="fill-ink-muted text-[10px] tabular-nums"
                        >
                            {compactNum(v)}
                        </text>
                    </g>
                ))}

                <g clipPath={`url(#${clipId})`}>
                    {mode === 'composition' && stacked.map((band) => (
                        <path
                            key={band.label}
                            d={band.path}
                            fill={band.color}
                            fillOpacity={0.72}
                            stroke={band.color}
                            strokeWidth="1"
                            strokeOpacity={0.9}
                        />
                    ))}

                    {mode === 'total' && (
                        <>
                            {bandPath && (
                                <path d={bandPath} fill="#6366f1" fillOpacity={0.14} />
                            )}
                            <polyline
                                points={totalPath}
                                fill="none"
                                strokeWidth="2.5"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                className="stroke-indigo-500"
                            />
                        </>
                    )}
                </g>

                {/* Time axis */}
                {points.map((p, i) => (
                    i % tickEvery === 0 || i === points.length - 1 ? (
                        <text
                            key={`${p.at}-tick`}
                            x={x(i)} y={height - 8}
                            textAnchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}
                            className="fill-ink-muted text-[10px]"
                        >
                            {axisLabel(p.at, grain)}
                        </text>
                    ) : null
                ))}

                {/* Markers. Buttons, not decoration — activating one reveals
                    the matching entry in the change ledger. Red for a loss,
                    amber for an unusual gain: a runaway loader duplicating
                    every node is as much a failure as a deletion, and marking
                    only drops would miss it entirely. */}
                {marked.map(({ point, index }) => {
                    const lost = (point.node_delta ?? 0) < 0
                    // Rank, not equality — `critical` is the tier above
                    // `severe`, and marking only `severe` at full strength
                    // draws a wipe more faintly than a dip.
                    const meta = severityMeta(point.significance)
                    const loud = meta.rank >= 2
                    return (
                        <g
                            key={`${point.at}-marker`}
                            role={onDropSelect ? 'button' : undefined}
                            tabIndex={onDropSelect ? 0 : undefined}
                            aria-label={
                                `${meta.label} ` +
                                `${lost ? 'drop' : 'rise'} of ${signedNum(point.node_delta)} ` +
                                `at ${axisLabel(point.at, grain)}`
                            }
                            className={onDropSelect ? 'cursor-pointer' : undefined}
                            onClick={() => onDropSelect?.(point.at)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') onDropSelect?.(point.at)
                            }}
                        >
                            <line
                                x1={x(index)} x2={x(index)}
                                y1={PAD.top} y2={PAD.top + innerH}
                                className={lost ? 'stroke-red-500/35' : 'stroke-amber-500/35'}
                                strokeWidth="1"
                                strokeDasharray="3 3"
                            />
                            <polygon
                                points={`${x(index) - 5},${PAD.top - 9} ${x(index) + 5},${PAD.top - 9} ${x(index)},${PAD.top - 1}`}
                                className={cn(
                                    lost ? 'fill-red-500' : 'fill-amber-500',
                                    !loud && 'opacity-60',
                                )}
                            />
                            <title>
                                {`${signedNum(point.node_delta)} at ${axisLabel(point.at, grain)} — ${point.significance}`}
                            </title>
                        </g>
                    )
                })}

                {/* Crosshair */}
                {hover != null && (
                    <line
                        x1={x(hover)} x2={x(hover)}
                        y1={PAD.top} y2={PAD.top + innerH}
                        className="stroke-ink-muted/40"
                        strokeWidth="1"
                    />
                )}
                {hover != null && mode === 'total' && (
                    <circle cx={x(hover)} cy={y(totals[hover])} r="4" className="fill-indigo-500" />
                )}

                {/* Hit targets, wider than the marks and drawn last. */}
                {points.map((p, i) => (
                    <rect
                        key={`${p.at}-hit`}
                        x={x(i) - stepX / 2} y={PAD.top}
                        width={Math.max(stepX, 1)} height={innerH}
                        fill="transparent"
                        onMouseEnter={() => setHover(i)}
                    />
                ))}
            </svg>

            <TimelineTooltip
                point={points[active]}
                series={series}
                index={active}
                grain={grain}
                isHovering={hover != null}
            />
        </div>
    )
}

/** The read-out beneath the chart. Deliberately not a floating tooltip: at
 *  this density a follow-the-cursor box covers the very bands it describes,
 *  and a fixed panel can hold the full breakdown without clipping. */
function TimelineTooltip({ point, series, index, grain, isHovering }: {
    point: HistoryPoint
    series: Series[]
    index: number
    grain: string
    isHovering: boolean
}) {
    if (!point) return null
    const lane = laneMeta(point.lane)
    const shown = series.filter((s) => s.values[index] > 0).slice(0, TOP_LABELS + 1)

    return (
        <div className="mt-3 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-xs font-bold text-ink tabular-nums">
                        {axisLabel(point.at, grain)}
                    </span>
                    {grain === 'raw' && (
                        <span className="text-[11px] text-ink-muted tabular-nums">
                            {clockUtc(point.at)} UTC
                        </span>
                    )}
                    <span className={cn(
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md',
                        'text-[10px] font-semibold uppercase tracking-wide', lane.tint,
                    )} title={lane.hint}>
                        <lane.icon className="w-3 h-3" />{lane.label}
                    </span>
                    {point.capture_reason === 'heartbeat' && (
                        <span
                            className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted"
                            title="A continuity observation — nothing had changed since the previous one"
                        >
                            no change
                        </span>
                    )}
                </div>
                <div className="flex items-center gap-3 text-xs tabular-nums">
                    <span className="text-ink">
                        <span className="text-ink-muted">nodes </span>
                        <span className="font-bold">{point.node_count.toLocaleString()}</span>
                    </span>
                    <span className="text-ink">
                        <span className="text-ink-muted">edges </span>
                        <span className="font-bold">{point.edge_count.toLocaleString()}</span>
                    </span>
                    {point.node_delta != null && point.node_delta !== 0 && (
                        <span className={cn(
                            'font-bold',
                            point.node_delta > 0
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-red-600 dark:text-red-400',
                        )}>
                            {signedNum(point.node_delta)}
                        </span>
                    )}
                </div>
            </div>

            <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
                {shown.map((s) => (
                    <span key={s.label} className="inline-flex items-center gap-1.5 min-w-0">
                        <span
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ backgroundColor: s.color }}
                        />
                        <span className="text-[11px] text-ink-secondary truncate max-w-[10rem]">
                            {s.label}
                        </span>
                        <span className="text-[11px] font-semibold text-ink tabular-nums">
                            {compactNum(s.values[index])}
                        </span>
                    </span>
                ))}
            </div>

            {!isHovering && (
                <p className="mt-2 text-[10px] text-ink-muted">
                    Showing the latest observation — hover the chart to inspect any point.
                </p>
            )}
        </div>
    )
}

/** Per-label small multiples. Each on its OWN scale, which is the point: a
 *  label with 400 rows and one with 4 million cannot share an axis and both
 *  stay readable, and the shape of each label's arc is what this mode is for. */
function SmallMultiples({ series, points, grain, className }: {
    series: Series[]
    points: HistoryPoint[]
    grain: string
    className?: string
}) {
    return (
        <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)}>
            {series.map((s) => {
                const max = Math.max(...s.values, 1)
                const last = s.values[s.values.length - 1]
                const first = s.values[0]
                const w = 240
                const h = 56
                const stepX = s.values.length > 1 ? w / (s.values.length - 1) : w
                const path = s.values
                    .map((v, i) => `${(i * stepX).toFixed(1)},${(h - (v / max) * (h - 6) - 3).toFixed(1)}`)
                    .join(' ')
                return (
                    <div
                        key={s.label}
                        className="rounded-xl border border-glass-border bg-canvas-elevated p-3"
                    >
                        <div className="flex items-center justify-between gap-2 mb-1.5 min-w-0">
                            <span className="inline-flex items-center gap-1.5 min-w-0">
                                <span
                                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                                    style={{ backgroundColor: s.color }}
                                />
                                <span className="text-xs font-semibold text-ink truncate">
                                    {s.label}
                                </span>
                            </span>
                            <span className="text-xs font-bold text-ink tabular-nums shrink-0">
                                {compactNum(last)}
                            </span>
                        </div>
                        <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" aria-hidden="true">
                            <polyline
                                points={path}
                                fill="none"
                                strokeWidth="2"
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                stroke={s.color}
                            />
                        </svg>
                        <div className="mt-1 flex items-center justify-between text-[10px] text-ink-muted tabular-nums">
                            <span>{axisLabel(points[0].at, grain)}</span>
                            <span className={cn(
                                'font-semibold',
                                last > first
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : last < first
                                        ? 'text-red-600 dark:text-red-400'
                                        : 'text-ink-muted',
                            )}>
                                {signedNum(last - first)}
                            </span>
                            <span>{axisLabel(points[points.length - 1].at, grain)}</span>
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

/** Legend + mode switch, hoisted out so the page owns the layout around the
 *  chart rather than the chart owning its own chrome. */
export function TimelineLegend({ points, field = 'entity_type_counts', className }: {
    points: HistoryPoint[]
    field?: CountTimelineProps['field']
    className?: string
}) {
    const series = useMemo(() => buildSeries(points, field), [points, field])
    if (!series.length) return null
    return (
        <div className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
            {series.map((s) => {
                const last = s.values[s.values.length - 1]
                const first = s.values[0]
                return (
                    <span key={s.label} className="inline-flex items-center gap-1.5 min-w-0">
                        <span
                            className="w-2.5 h-2.5 rounded-sm shrink-0"
                            style={{ backgroundColor: s.color }}
                        />
                        <span className="text-[11px] text-ink-secondary truncate max-w-[12rem]">
                            {s.label}
                        </span>
                        {first === 0 && last > 0 && (
                            <span className="text-[9px] font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                                new
                            </span>
                        )}
                        {first > 0 && last === 0 && (
                            <span className="inline-flex items-center gap-0.5 text-[9px] font-bold uppercase tracking-wide text-red-600 dark:text-red-400">
                                <AlertTriangle className="w-2.5 h-2.5" />gone
                            </span>
                        )}
                    </span>
                )
            })}
        </div>
    )
}
