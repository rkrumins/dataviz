/**
 * Activity lines — one person's actions over the window as a line, small enough to sit in a
 * table row or a grid tile.
 *
 * Every line on a page shares ONE y-scale (`max`), so a taller line means more activity and
 * shapes can be compared across rows: two people's lines drawn each to their own peak would
 * look alike however different their volumes. The scale is stated beside the grid.
 *
 * Hovering a line names the period under the pointer and its count; the card's table twin
 * carries every value.
 */
import { useState } from 'react'
import { Link } from 'react-router-dom'

import { cn } from '@/lib/utils'
import { compact, exact, shortDate } from '@/lib/formatMetric'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

const PAD_Y = 3

export function ActivityLine({
    values, max, buckets, width, height = 28, slot = 1, label, className,
}: {
    values: number[]
    /** The shared scale's top. */
    max: number
    buckets: string[]
    /** Fixed width; omit to fill the container. */
    width?: number
    height?: number
    slot?: number
    /** Names the line for screen readers. */
    label: string
    className?: string
}) {
    const theme = useChartTheme()
    const [wrapRef, measured] = useChartWidth()
    const w = width ?? measured
    const [hover, setHover] = useState<number | null>(null)
    const colour = theme.series[slot % theme.series.length]
    const n = values.length
    const x = (i: number) => (n <= 1 ? w / 2 : (i / (n - 1)) * (w - 2) + 1)
    const y = (v: number) => height - PAD_Y - (max > 0 ? (v / max) * (height - 2 * PAD_Y) : 0)
    const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const total = values.reduce((a, b) => a + b, 0)

    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
        const box = e.currentTarget.getBoundingClientRect()
        const i = Math.round(((e.clientX - box.left) / Math.max(1, box.width)) * (n - 1))
        setHover(Math.max(0, Math.min(n - 1, i)))
    }

    return (
        <div ref={width ? undefined : wrapRef} className={cn('relative', className)}
            style={width ? { width } : undefined}>
            {w > 0 && (
                <svg width={w} height={height} role="img" onMouseMove={onMove} onMouseLeave={() => setHover(null)}
                    aria-label={`${label}: ${exact(total)} actions${n ? `, from ${shortDate(buckets[0])} to ${shortDate(buckets[n - 1])}` : ''}`}
                    className="block overflow-visible">
                    <line x1={0} x2={w} y1={height - PAD_Y} y2={height - PAD_Y} stroke={theme.grid} strokeWidth={1} />
                    {total > 0 && (
                        <>
                            <polygon
                                points={`${x(0)},${height - PAD_Y} ${points} ${x(n - 1)},${height - PAD_Y}`}
                                fill={colour} opacity={0.12} />
                            <polyline points={points} fill="none" stroke={colour}
                                strokeWidth={MARK.lineWidth * 0.75} strokeLinejoin="round" strokeLinecap="round" />
                        </>
                    )}
                    {hover !== null && (
                        <>
                            <line x1={x(hover)} x2={x(hover)} y1={0} y2={height} stroke={theme.muted} strokeWidth={1} />
                            <circle cx={x(hover)} cy={y(values[hover] ?? 0)} r={2.5} fill={colour} />
                        </>
                    )}
                </svg>
            )}
            {hover !== null && (
                <span className="pointer-events-none absolute -top-5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[10px] font-semibold text-canvas-elevated tabular-nums shadow">
                    {shortDate(buckets[hover])} · {exact(values[hover] ?? 0)}
                </span>
            )}
        </div>
    )
}

export interface SmallMultipleRow {
    id: string
    name: string
    values: number[]
    total: number
    href: string
    caption?: string
}

/** A grid of activity lines, one per person, on one scale. */
export function SmallMultiples({ buckets, rows, className }: {
    buckets: string[]
    rows: SmallMultipleRow[]
    className?: string
}) {
    const max = Math.max(0, ...rows.flatMap((r) => r.values))
    return (
        <div className={cn('space-y-2', className)}>
            <p className="text-[11px] text-ink-muted">
                One scale for every line: the tallest peak is {exact(max)} actions in a period.
            </p>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
                {rows.map((r) => (
                    <li key={r.id}>
                        <Link to={r.href}
                            className="group block rounded-xl border border-glass-border px-3 pb-2 pt-2.5 transition-colors hover:border-indigo-500/40 hover:bg-indigo-500/[0.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-indigo-500">
                            <div className="mb-1.5 flex items-baseline justify-between gap-2">
                                <span className="truncate text-xs font-semibold text-ink group-hover:text-indigo-600 dark:group-hover:text-indigo-400">{r.name}</span>
                                <span className="shrink-0 text-[11px] font-semibold tabular-nums text-ink-secondary">{compact(r.total)}</span>
                            </div>
                            <ActivityLine values={r.values} max={max} buckets={buckets} height={44} label={r.name} />
                            <div className="mt-1 flex justify-between text-[9px] tabular-nums text-ink-muted">
                                <span>{buckets.length ? shortDate(buckets[0]) : ''}</span>
                                {r.caption && <span className="truncate px-1">{r.caption}</span>}
                                <span>{buckets.length ? shortDate(buckets[buckets.length - 1]) : ''}</span>
                            </div>
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    )
}
