/**
 * Small multiples — one panel per type, so a reader can compare them.
 *
 * THE SHARED SCALE IS THE WHOLE POINT. The implementation this replaces gave
 * every panel its own `Math.max`, which makes a type that moved by 3 look
 * exactly as dramatic as one that moved by 30,000. Panels you cannot compare
 * are not small multiples; they are a grid of unrelated sparklines. So the
 * default is one scale across the trellis, with an explicit escape hatch when
 * the question is shape rather than magnitude — and the escape hatch SAYS it
 * is on, because a chart whose axes silently differ is the more dangerous of
 * the two.
 *
 * Ordered by movement, not by size or name: the panel worth looking at is the
 * one that changed, and a trellis sorted alphabetically buries it wherever the
 * alphabet happens to put it.
 */
import { useMemo, useState } from 'react'
import { Maximize2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact } from '@/lib/formatMetric'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import type { ProfilingSeries } from '@/types/profiling'
import { deltaTone, formatBucket, signed } from './shared'

const PANEL_W = 240
const PANEL_H = 52
const PAD_Y = 5

export function TypeTrellis({
    buckets, series, onFocus, className,
}: {
    buckets: string[]
    series: ProfilingSeries[]
    onFocus?: (key: string) => void
    className?: string
}) {
    const theme = useChartTheme()
    const [fitEach, setFitEach] = useState(false)

    const panels = useMemo(() => {
        const built = series.map((s, i) => {
            const values = s.points.map((p) => p.v)
            const first = values[0] ?? 0
            const last = values.at(-1) ?? 0
            return {
                key: s.key,
                label: s.label,
                values,
                first,
                last,
                delta: last - first,
                peak: Math.max(0, ...values),
                // Colour follows the entity's slot in the payload order, never
                // its rank here — re-sorting must not repaint anything.
                color: s.key === '__other__'
                    ? theme.neutralMark
                    : theme.series[i % theme.series.length],
                gone: first > 0 && last === 0,
            }
        })
        return built.sort((a, b) => {
            // Disappearances first whatever their size: a type reaching zero
            // is the finding, and as a share of a large graph it rarely ranks
            // anywhere near the top by magnitude.
            if (a.gone !== b.gone) return a.gone ? -1 : 1
            return Math.abs(b.delta) - Math.abs(a.delta)
        })
    }, [series, theme])

    const sharedMax = Math.max(1, ...panels.map((p) => p.peak))

    if (!panels.length || buckets.length < 2) return null

    return (
        <div className={cn('space-y-3', className)}>
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-muted">
                    {panels.length} {panels.length === 1 ? 'type' : 'types'}, ordered by
                    how much they moved
                    {!fitEach && <> · one shared scale to {compact(sharedMax)}</>}
                </p>
                <label className={cn(
                    'inline-flex items-center gap-2 rounded-xl border px-2.5 py-1.5',
                    'text-xs font-semibold cursor-pointer transition-colors select-none',
                    fitEach
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        : 'border-glass-border bg-canvas text-ink-muted hover:text-ink',
                )}>
                    <input
                        type="checkbox"
                        checked={fitEach}
                        onChange={(e) => setFitEach(e.target.checked)}
                        className="sr-only"
                    />
                    {/* Named for what it costs, not for what it does. "Fit each"
                        sounds like an improvement; the axes stop matching. */}
                    Fit each panel (axes differ)
                </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {panels.map((panel) => (
                    <Panel
                        key={panel.key}
                        panel={panel}
                        buckets={buckets}
                        max={fitEach ? Math.max(1, panel.peak) : sharedMax}
                        scaled={fitEach}
                        onFocus={onFocus ? () => onFocus(panel.key) : undefined}
                    />
                ))}
            </div>
        </div>
    )
}

interface PanelData {
    key: string
    label: string
    values: number[]
    first: number
    last: number
    delta: number
    peak: number
    color: string
    gone: boolean
}

function Panel({
    panel, buckets, max, scaled, onFocus,
}: {
    panel: PanelData
    buckets: string[]
    max: number
    scaled: boolean
    onFocus?: () => void
}) {
    // A panel with no hover can only ever say where the series started and
    // ended. The count AT a bucket — the number someone is pointing at — was
    // unreachable here, which made the trellis the one over-time surface that
    // would not tell you a value.
    const [hover, setHover] = useState<number | null>(null)
    const { values, color } = panel
    const stepX = values.length > 1 ? PANEL_W / (values.length - 1) : PANEL_W
    const y = (v: number) => PANEL_H - PAD_Y - (v / max) * (PANEL_H - PAD_Y * 2)
    const line = values.map((v, i) => `${(i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const area = `${line} ${PANEL_W},${PANEL_H} 0,${PANEL_H}`

    const Tag = onFocus ? 'button' : 'div'

    return (
        <Tag
            {...(onFocus ? { type: 'button' as const, onClick: onFocus } : {})}
            className={cn(
                'group relative rounded-xl border border-glass-border bg-canvas-elevated p-3 text-left w-full',
                onFocus && [
                    'transition-all hover:border-indigo-500/40 hover:shadow-md',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                ],
            )}
        >
            <div className="flex items-center justify-between gap-2 mb-1.5 min-w-0">
                <span className="inline-flex items-center gap-1.5 min-w-0">
                    <span
                        className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ backgroundColor: color }}
                        aria-hidden
                    />
                    <span className="text-xs font-semibold text-ink truncate">
                        {panel.label}
                    </span>
                    {panel.gone && (
                        <span className="text-[10px] font-bold uppercase tracking-wide text-rose-600 dark:text-rose-400 shrink-0">
                            gone
                        </span>
                    )}
                </span>
                <span className="text-xs font-bold text-ink tabular-nums shrink-0">
                    {compact(panel.last)}
                </span>
            </div>

            <svg
                viewBox={`0 0 ${PANEL_W} ${PANEL_H}`}
                className="w-full h-auto overflow-visible"
                onMouseLeave={() => setHover(null)}
                role="img"
                aria-label={
                    `${panel.label}: ${exact(panel.first)} to ${exact(panel.last)}`
                    + `, ${signed(panel.delta)} over the window`
                    + (scaled ? ', drawn on its own scale' : '')
                }
            >
                <polygon points={area} fill={color} fillOpacity={0.12} />
                <polyline
                    points={line} fill="none" stroke={color} strokeWidth={2}
                    strokeLinejoin="round" strokeLinecap="round"
                />
                {/* A band that ended at zero gets its end marked, for the same
                    reason the stacked chart terminates one: a line reaching the
                    axis and a line simply stopping look identical. */}
                {panel.gone && (
                    <circle
                        cx={PANEL_W} cy={y(0)} r={3}
                        fill="currentColor" className="text-rose-500"
                    />
                )}

                {hover !== null && (
                    <>
                        <line
                            x1={hover * stepX} x2={hover * stepX}
                            y1={0} y2={PANEL_H}
                            stroke={color} strokeWidth={1} opacity={0.35}
                        />
                        <circle
                            cx={hover * stepX} cy={y(values[hover] ?? 0)} r={3}
                            fill={color} stroke="currentColor"
                            className="text-canvas-elevated" strokeWidth={1.5}
                        />
                    </>
                )}

                {/* Hit targets wider than the marks they select. */}
                {values.map((_v, i) => (
                    <rect
                        key={i}
                        x={i * stepX - stepX / 2} y={0}
                        width={Math.max(stepX, 8)} height={PANEL_H}
                        fill="transparent"
                        onMouseEnter={() => setHover(i)}
                    />
                ))}
            </svg>

            {/* The footer doubles as the readout. While hovering it answers
                "what was it here"; at rest it answers "where did it start and
                end" — two questions, one row, never both at once. */}
            <div className="mt-1 flex items-center justify-between gap-2 text-[10px] tabular-nums min-h-[15px]">
                {hover === null ? (
                    <>
                        <span className="text-ink-muted">{formatBucket(buckets[0])}</span>
                        <span className={cn('font-semibold', deltaTone(panel.delta))}>
                            {signed(panel.delta)}
                        </span>
                        <span className="text-ink-muted">
                            {formatBucket(buckets[buckets.length - 1])}
                        </span>
                    </>
                ) : (
                    <>
                        <span className="text-ink-muted truncate">
                            {formatBucket(buckets[hover])}
                        </span>
                        <span className="font-bold text-ink shrink-0">
                            {exact(values[hover] ?? 0)}
                        </span>
                    </>
                )}
            </div>

            {onFocus && (
                <Maximize2
                    className="absolute top-2.5 right-2.5 w-3 h-3 text-ink-muted opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-hidden
                />
            )}
        </Tag>
    )
}
