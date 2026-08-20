/**
 * BarSeriesChart — columns over time (things created, opened, done per bucket).
 *
 * On bars the MARK is the hit target — no crosshair. Each column carries its
 * own hover/focus tooltip and lifts slightly so the reader sees it respond.
 *
 * Columns are capped at 24px and never fill their band: the leftover space is
 * deliberate air, and the 2px gap between neighbours is the surface doing the
 * separating. A stroke drawn around a bar to "separate" it is data-weight ink
 * that carries no data.
 */
import { useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { exact, niceTicks, shortDate } from '@/lib/formatMetric'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

interface Props {
    buckets: string[]
    values: number[]
    label: string
    /** Slot into the categorical palette. One series → one colour for every
     *  bar; darkening bars by value would double-encode height as hue. */
    slot?: number
    height?: number
    className?: string
}

const PAD = { top: 12, right: 12, bottom: 22, left: 44 }

export function BarSeriesChart({
    buckets, values, label, slot = 0, height = 200, className,
}: Props) {
    const theme = useChartTheme()
    const [hover, setHover] = useState<number | null>(null)
    const [wrapRef, width] = useChartWidth()

    const plotW = Math.max(1, width - PAD.left - PAD.right)
    const plotH = height - PAD.top - PAD.bottom
    const color = theme.series[slot % theme.series.length]

    const { max, ticks } = useMemo(() => {
        const peak = Math.max(1, ...values)
        const t = niceTicks(peak)
        return { max: Math.max(peak, t[t.length - 1] ?? peak), ticks: t }
    }, [values])

    const band = buckets.length ? plotW / buckets.length : plotW
    const barW = Math.min(MARK.maxBarWidth, Math.max(2, band - MARK.surfaceGap * 2))
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 7))

    return (
        <div ref={wrapRef} className={cn('relative', className)}>
            <svg
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="overflow-visible"
                role="img"
                aria-label={`${label} per period`}
                onMouseLeave={() => setHover(null)}
            >
                {ticks.map((t) => {
                    const ty = PAD.top + plotH * (1 - t / max)
                    return (
                        <g key={t}>
                            <line x1={PAD.left} y1={ty} x2={width - PAD.right} y2={ty}
                                  stroke={theme.grid} strokeWidth={1} />
                            <text x={PAD.left - 8} y={ty} dy="0.32em" textAnchor="end"
                                  className="fill-ink-muted tabular-nums" style={{ fontSize: 10 }}>
                                {exact(t)}
                            </text>
                        </g>
                    )
                })}

                {buckets.map((b, i) => {
                    const v = values[i] ?? 0
                    const h = Math.max(v > 0 ? 2 : 0, plotH * (v / max))
                    const bx = PAD.left + i * band + (band - barW) / 2
                    const by = PAD.top + plotH - h
                    const isHover = hover === i
                    return (
                        <g key={b}>
                            {h > 0 && (
                                <path
                                    d={roundedTopBar(bx, by, barW, h, MARK.barRadius)}
                                    fill={color}
                                    opacity={hover === null || isHover ? 1 : 0.55}
                                    className="transition-opacity duration-150"
                                />
                            )}
                            {/* Hit area spans the whole band and the full plot
                                height, so a 2px bar is still easy to reach. */}
                            <rect
                                x={PAD.left + i * band} y={PAD.top}
                                width={band} height={plotH}
                                fill="transparent"
                                tabIndex={0}
                                role="button"
                                aria-label={`${shortDate(b, true)}: ${exact(v)} ${label}`}
                                onMouseEnter={() => setHover(i)}
                                onFocus={() => setHover(i)}
                                className="outline-none focus-visible:fill-black/[0.03] dark:focus-visible:fill-white/[0.04]"
                            />
                        </g>
                    )
                })}

                {buckets.map((b, i) => (
                    i % labelEvery === 0 ? (
                        <text key={`x-${b}`} x={PAD.left + i * band + band / 2} y={height - 6}
                              textAnchor="middle" className="fill-ink-muted" style={{ fontSize: 10 }}>
                            {shortDate(b)}
                        </text>
                    ) : null
                ))}
            </svg>

            {hover !== null && (
                <div
                    className="pointer-events-none absolute top-2 z-10 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 shadow-lg"
                    style={{
                        left: `${((PAD.left + hover * band + band / 2 - PAD.left) / plotW) * 100}%`,
                        transform: hover / Math.max(buckets.length - 1, 1) > 0.6
                            ? 'translateX(-100%) translateX(-12px)' : 'translateX(12px)',
                    }}
                >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                        {shortDate(buckets[hover], true)}
                    </p>
                    <p className="text-sm font-bold text-ink tabular-nums">
                        {exact(values[hover] ?? 0)}
                        <span className="ml-1.5 text-[11px] font-medium text-ink-secondary">{label}</span>
                    </p>
                </div>
            )}
        </div>
    )
}

/** Rounded at the data end, square at the baseline — a column grows FROM the
 *  axis, so rounding the foot would detach it from the line it measures against. */
function roundedTopBar(x: number, y: number, w: number, h: number, r: number): string {
    const radius = Math.min(r, w / 2, h)
    return [
        `M ${x} ${y + h}`,
        `L ${x} ${y + radius}`,
        `Q ${x} ${y} ${x + radius} ${y}`,
        `L ${x + w - radius} ${y}`,
        `Q ${x + w} ${y} ${x + w} ${y + radius}`,
        `L ${x + w} ${y + h}`,
        'Z',
    ].join(' ')
}
