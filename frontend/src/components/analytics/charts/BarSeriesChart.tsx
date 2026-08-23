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
 * A previous period is drawn as a PAIRED COLUMN, not as a reference tick. The
 * tick was cheaper in ink and it was wrong: on a sparse window — most buckets
 * zero, which is the common case for "things created per day" — the surviving
 * ticks read as a field of floating dashes with one real bar among them, and
 * the chart looks broken rather than quiet. In a bar chart every value is a
 * bar, including last period's.
 *
 * The two columns differ in THREE ways at once, not one: now is solid, before
 * is hatched, outlined and pale. Opacity alone was not enough — a dimmer copy
 * of the same shape reads as "disabled", not as "earlier", and at a glance the
 * two are still the same mark. Hatching is a categorical difference that
 * survives greyscale, low contrast and every kind of colour blindness, because
 * it is not carried by colour at all. The outline is what makes the pale
 * column MEASURABLE: a 16%-alpha fill has no top edge to read off the axis.
 *
 * The hatch is dropped below ~7px of column width, where the stripes stop
 * being a texture and start being noise; the tint and outline carry it alone.
 */
import { useId, useMemo, useState } from 'react'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact, niceTicks, shortDate, signedPercent } from '@/lib/formatMetric'
import { MARK, useChartTheme, useChartWidth } from './chartTheme'

interface Props {
    buckets: string[]
    values: number[]
    label: string
    /**
     * The same measure over the previous period, aligned by bucket index.
     *
     * Drawn as a faded column beside each current one. The pair shares the
     * band, so each column is narrower than a lone one would be — the cost of
     * a comparison that can actually be read off the axis.
     */
    previous?: number[]
    /** Slot into the categorical palette. One series → one colour for every
     *  bar; darkening bars by value would double-encode height as hue. */
    slot?: number
    height?: number
    className?: string
}

const PAD = { top: 12, right: 12, bottom: 22, left: 44 }

export function BarSeriesChart({
    buckets, values, label, previous, slot = 0, height = 200, className,
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

    // Only trust a comparison that lines up with this axis exactly.
    const ghost = previous?.length === buckets.length ? previous : undefined

    const { max, ticks } = useMemo(() => {
        // The ghost is inside the scale: a previous period taller than this one
        // must not be clipped, or a decline would render as a flat ceiling.
        const peak = Math.max(1, ...values, ...(ghost ?? []))
        const t = niceTicks(peak)
        return { max: Math.max(peak, t[t.length - 1] ?? peak), ticks: t }
    }, [values, ghost])

    const band = buckets.length ? plotW / buckets.length : plotW

    // An all-zero comparison gets no column of its own — reserving half the
    // band for a series that draws nothing would thin the bars that DO carry
    // data, in exchange for air.
    const paired = Boolean(ghost?.some((v) => v > 0))
    const columns = paired ? 2 : 1
    const groupW = Math.max(2, Math.min(
        MARK.maxBarWidth * columns + MARK.surfaceGap * (columns - 1),
        band - MARK.surfaceGap * 2,
    ))
    // The gap yields before the bars do: at a dense window a fixed 2px would
    // eat a column that is only 2px wide to begin with.
    const innerGap = paired ? Math.min(MARK.surfaceGap, groupW / 6) : 0
    const barW = Math.max(1, (groupW - innerGap * (columns - 1)) / columns)
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 7))

    // Stripes need room to read as stripes. Under about seven pixels they are
    // just a dirty edge, so the tint and the outline carry the distinction.
    const hatched = paired && barW >= 7
    const ghostStroke = Math.min(1.25, barW / 3)

    /** A column's top edge, and 0 height for a bucket with nothing in it — a
     *  2px stub for a real value, so a 1 next to a 400 is still visible. */
    const columnTop = (v: number) => (v > 0 ? Math.max(2, plotH * (v / max)) : 0)

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
                {hatched && (
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
                    const pv = paired ? (ghost?.[i] ?? 0) : 0
                    const h = columnTop(v)
                    const ph = columnTop(pv)
                    const groupX = PAD.left + i * band + (band - groupW) / 2
                    const isHover = hover === i
                    // Non-hovered columns step back so the hovered pair reads
                    // as the selected one; the ghost keeps its share of that.
                    const dim = hover === null || isHover ? 1 : 0.55
                    return (
                        <g key={b}>
                            {h > 0 && (
                                <path
                                    d={roundedTopBar(groupX, PAD.top + plotH - h, barW, h, MARK.barRadius)}
                                    fill={color}
                                    opacity={dim}
                                    className="transition-opacity duration-150"
                                />
                            )}
                            {/* Previous period: same hue, different MARK.
                                Same hue because a second colour would say
                                these are different measures rather than the
                                same one, earlier — identity stays with the
                                series. Different mark because that is what
                                makes the pair legible at a glance. */}
                            {ph > 0 && (
                                <path
                                    d={roundedTopBar(
                                        groupX + barW + innerGap,
                                        PAD.top + plotH - ph, barW, ph, MARK.barRadius,
                                    )}
                                    fill={hatched ? `url(#${hatchId})` : color}
                                    fillOpacity={hatched ? 1 : 0.16}
                                    stroke={color}
                                    strokeOpacity={0.5}
                                    strokeWidth={ghostStroke}
                                    opacity={dim}
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
                                    `${shortDate(b, true)}: ${exact(v)} ${label}`
                                    + (ghost ? `, previously ${exact(ghost[i] ?? 0)}` : '')
                                }
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
                    {/* Two columns are plotted, so two numbers are read off
                        them — plus the one the reader actually came for, which
                        is the difference between them. Making someone do that
                        arithmetic against an axis is the whole reason a
                        comparison chart feels like work.

                        The direction is an arrow, never a colour: this chart
                        does not know whether up is good. A falling
                        time-to-value is progress; a falling signup count is
                        not, and only the caller knows which it is holding. */}
                    {ghost && (
                        <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-ink-muted tabular-nums">
                            {(() => {
                                const prev = ghost[hover] ?? 0
                                const now = values[hover] ?? 0
                                const Icon = now === prev ? Minus
                                    : now > prev ? ArrowUpRight : ArrowDownRight
                                const pct = prev > 0
                                    ? signedPercent(((now - prev) / prev) * 100)
                                    : null
                                return (
                                    <>
                                        <Icon className="w-3 h-3 shrink-0" aria-hidden />
                                        <span>{exact(prev)} previously{pct ? ` · ${pct}` : ''}</span>
                                    </>
                                )
                            })()}
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
