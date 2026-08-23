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
 *
 * ── The previous period ──────────────────────────────────────────────
 *
 * It is drawn on the SAME axis, in chronological position, immediately to the
 * left of the current period. One chart, one time axis, every bar sitting on
 * the date it actually happened.
 *
 * It was drawn two other ways first, and both misled. As a hairline tick
 * across each column it vanished into a field of floating dashes on a sparse
 * window. As a paired column beside each current one it was legible — but it
 * was placed by bucket INDEX against an axis labelled with the CURRENT
 * period's dates, so a bar for the 4th of July sat on the 3rd of August and
 * the axis quietly lied about it. A reader asking "what am I looking at?" was
 * asking the right question, and no amount of styling was going to answer it.
 *
 * Laid out chronologically the question does not arise: the left half is
 * before, the right half is now, the divider is the boundary, and the
 * comparison is the shape of one half against the other. A hatch marks the
 * earlier half so it stays distinguishable when a screenshot is cropped or the
 * legend is out of view — a texture, not a colour, so it survives greyscale
 * and every kind of colour blindness.
 *
 * The cost is a doubled x-range: pick "30 days" and the axis spans 60. That is
 * stated in the subtitle and in the in-plot captions rather than left to be
 * discovered, and it buys an axis that tells the truth.
 */
import { useId, useMemo, useState } from 'react'

import { cn } from '@/lib/utils'
import { exact, niceTicks, shortDate } from '@/lib/formatMetric'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

interface Props {
    buckets: string[]
    values: number[]
    label: string
    /**
     * The same measure over the previous period, WITH the dates it happened
     * on — the dates are what let it be drawn in chronological position
     * rather than stacked against this period's axis by index.
     */
    previous?: { buckets: string[]; values: number[] }
    /** Names the earlier half in the plot, e.g. "Previous 30 days". */
    previousLabel?: string
    /** Slot into the categorical palette. One series → one colour for every
     *  bar; darkening bars by value would double-encode height as hue. */
    slot?: number
    height?: number
    className?: string
}

const PAD = { top: 12, right: 12, bottom: 22, left: 44 }

/** Below this, an in-plot caption has nowhere to sit without colliding. */
const CAPTION_MIN_WIDTH = 96

export function BarSeriesChart({
    buckets, values, label, previous, previousLabel = 'Previous period',
    slot = 0, height = 200, className,
}: Props) {
    const theme = useChartTheme()
    const [hover, setHover] = useState<number | null>(null)
    const [wrapRef, width] = useChartWidth()
    // Patterns live in the document, not the component, so two charts on one
    // page must not share an id. The colons React puts in `useId` are stripped:
    // an XML name may not start with one, and this id is dereferenced as
    // `url(#…)`, where a browser is within its rights to refuse it.
    const hatchId = `hatch${useId().replace(/:/g, '')}`

    const plotW = Math.max(1, width - PAD.left - PAD.right)
    const plotH = height - PAD.top - PAD.bottom
    const color = theme.series[slot % theme.series.length]

    // Only trust a comparison that carries a date for every value.
    const ghost = previous && previous.buckets.length === previous.values.length
        && previous.buckets.length > 0
        ? previous
        : undefined

    // The two periods laid end to end, oldest first. From here on there is one
    // series and one axis; `before` is the only thing that distinguishes them.
    const { days, series, before } = useMemo(() => ({
        days: [...(ghost?.buckets ?? []), ...buckets],
        series: [...(ghost?.values ?? []), ...values],
        before: ghost?.buckets.length ?? 0,
    }), [ghost, buckets, values])

    const { max, ticks } = useMemo(() => {
        const peak = Math.max(1, ...series)
        const t = niceTicks(peak)
        return { max: Math.max(peak, t[t.length - 1] ?? peak), ticks: t }
    }, [series])

    const band = days.length ? plotW / days.length : plotW
    const barW = Math.min(MARK.maxBarWidth, Math.max(1, band - MARK.surfaceGap * 2))
    const labelEvery = Math.max(1, Math.ceil(days.length / 7))

    // Stripes need room to read as stripes. Under about five pixels they are
    // just a dirty edge, and the pale fill carries the distinction alone.
    const hatched = barW >= 5
    const boundary = PAD.left + before * band
    const beforeWidth = before * band
    const afterWidth = plotW - beforeWidth

    return (
        <div ref={wrapRef} className={cn('relative', className)}>
            <svg
                width={width}
                height={height}
                viewBox={`0 0 ${width} ${height}`}
                className="overflow-visible"
                role="img"
                aria-label={before
                    ? `${label} per period, this period and the one before it`
                    : `${label} per period`}
                onMouseLeave={() => setHover(null)}
            >
                {hatched && before > 0 && (
                    <defs>
                        <pattern
                            id={hatchId} width={6} height={6}
                            patternUnits="userSpaceOnUse" patternTransform="rotate(45)"
                        >
                            <rect width={6} height={6} fill={color} fillOpacity={0.12} />
                            <line x1={0} y1={0} x2={0} y2={6} stroke={color}
                                  strokeOpacity={0.45} strokeWidth={2} />
                        </pattern>
                    </defs>
                )}

                {/* The earlier half gets a wash and a boundary rule, so the two
                    periods read as periods even before a single bar is looked
                    at — and so a bar near the divider cannot be mistaken for
                    being on the other side of it. */}
                {before > 0 && (
                    <>
                        {/* A dark surface swallows a 4% wash, so it gets a
                            little more. The wash is what makes the halves read
                            as REGIONS before a single bar is looked at. */}
                        <rect
                            x={PAD.left} y={PAD.top} width={beforeWidth} height={plotH}
                            fill={color} fillOpacity={theme.isDark ? 0.09 : 0.045}
                        />
                        <line
                            x1={boundary} x2={boundary} y1={PAD.top} y2={PAD.top + plotH}
                            stroke={theme.grid} strokeWidth={1} strokeDasharray="3 3"
                        />
                    </>
                )}

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

                {/* Direct labels beat a legend when the question is "which half
                    am I looking at": the answer sits on the half itself. */}
                {before > 0 && beforeWidth >= CAPTION_MIN_WIDTH && (
                    <text x={PAD.left + 6} y={PAD.top - 2}
                          className="fill-ink-muted" style={{ fontSize: 10 }}>
                        {previousLabel}
                    </text>
                )}
                {before > 0 && afterWidth >= CAPTION_MIN_WIDTH && (
                    <text x={boundary + 6} y={PAD.top - 2}
                          className="fill-ink-secondary font-semibold" style={{ fontSize: 10 }}>
                        This period
                    </text>
                )}

                {days.map((day, i) => {
                    const v = series[i] ?? 0
                    // A 2px stub for a real value, so a 1 beside a 400 is still
                    // visible; nothing at all for a bucket that is empty.
                    const h = v > 0 ? Math.max(2, plotH * (v / max)) : 0
                    const bx = PAD.left + i * band + (band - barW) / 2
                    const isHover = hover === i
                    const earlier = i < before
                    return (
                        <g key={day}>
                            {h > 0 && (
                                <path
                                    d={roundedTopBar(bx, PAD.top + plotH - h, barW, h, MARK.barRadius)}
                                    fill={earlier && hatched ? `url(#${hatchId})` : color}
                                    fillOpacity={earlier && !hatched ? 0.3 : 1}
                                    stroke={earlier ? color : undefined}
                                    strokeOpacity={earlier ? 0.5 : undefined}
                                    strokeWidth={earlier ? Math.min(1.25, barW / 3) : undefined}
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
                                aria-label={
                                    `${shortDate(day, true)}: ${exact(v)} ${label}`
                                    + (earlier ? ` (${previousLabel.toLowerCase()})` : '')
                                }
                                onMouseEnter={() => setHover(i)}
                                onFocus={() => setHover(i)}
                                className="outline-none focus-visible:fill-black/[0.03] dark:focus-visible:fill-white/[0.04]"
                            />
                        </g>
                    )
                })}

                {days.map((day, i) => (
                    i % labelEvery === 0 ? (
                        <text key={`x-${day}`} x={PAD.left + i * band + band / 2} y={height - 6}
                              textAnchor="middle" className="fill-ink-muted" style={{ fontSize: 10 }}>
                            {shortDate(day)}
                        </text>
                    ) : null
                ))}
            </svg>

            {hover !== null && (
                <div
                    className="pointer-events-none absolute top-2 z-10 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2 shadow-lg"
                    style={{
                        left: `${((hover * band + band / 2) / plotW) * 100}%`,
                        transform: hover / Math.max(days.length - 1, 1) > 0.6
                            ? 'translateX(-100%) translateX(-12px)' : 'translateX(12px)',
                    }}
                >
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                        {shortDate(days[hover], true)}
                    </p>
                    <p className="text-sm font-bold text-ink tabular-nums">
                        {exact(series[hover] ?? 0)}
                        <span className="ml-1.5 text-[11px] font-medium text-ink-secondary">{label}</span>
                    </p>
                    {/* Which side of the divider this bar is on, in words. The
                        wash and the hatch say it visually; a reader hovering a
                        bar near the boundary deserves it said outright. */}
                    {before > 0 && (
                        <p className="mt-0.5 text-[11px] font-medium text-ink-muted">
                            {hover < before ? previousLabel : 'This period'}
                        </p>
                    )}
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
