/**
 * Sparkline — hand-rolled SVG polyline trend hint (no chart lib in this app;
 * precedent: SchemaHealthRing).
 *
 * Moved here from AdminInfrastructure so more than one surface can use it.
 * Same shape as before — de-emphasis stroke with the current point in the
 * accent, per the stat-tile trend spec — with three additions the original
 * did not need but a second caller does:
 *
 *   * a `tone`, since indigo was hard-coded,
 *   * a hover layer, so a reader can find out what a point actually was,
 *   * an accessible name, replacing a bare `aria-hidden`.
 *
 * Defaults reproduce the original exactly, so existing callers are unchanged.
 *
 * One series only. It needs no legend — whatever labels the section names it.
 */
import { useId, useState } from 'react'
import { cn } from '@/lib/utils'

export type SparklineTone = 'indigo' | 'emerald' | 'amber' | 'red' | 'slate'

const TONES: Record<SparklineTone, { line: string; dot: string }> = {
    indigo: {
        line: 'stroke-indigo-300/60 dark:stroke-indigo-400/40',
        dot: 'fill-indigo-500 dark:fill-indigo-400',
    },
    emerald: {
        line: 'stroke-emerald-300/60 dark:stroke-emerald-400/40',
        dot: 'fill-emerald-500 dark:fill-emerald-400',
    },
    amber: {
        line: 'stroke-amber-300/70 dark:stroke-amber-400/50',
        dot: 'fill-amber-500 dark:fill-amber-400',
    },
    red: {
        line: 'stroke-red-300/70 dark:stroke-red-400/50',
        dot: 'fill-red-500 dark:fill-red-400',
    },
    slate: {
        line: 'stroke-slate-300/70 dark:stroke-slate-500/50',
        dot: 'fill-slate-500 dark:fill-slate-400',
    },
}

interface Props {
    points: number[]
    width?: number
    height?: number
    className?: string
    tone?: SparklineTone
    /** Names the series for screen readers and the hover tooltip. */
    label?: string
    /** Formats a value in the tooltip. Defaults to a locale integer. */
    format?: (v: number) => string
}

export function Sparkline({
    points, width = 96, height = 24, className,
    tone = 'indigo', label, format,
}: Props) {
    const [hover, setHover] = useState<number | null>(null)
    const titleId = useId()
    if (points.length < 3) return null

    const min = Math.min(...points)
    const max = Math.max(...points)
    const span = max - min || 1
    const step = width / (points.length - 1)
    const pad = 2
    const y = (v: number) => pad + (height - 2 * pad) * (1 - (v - min) / span)
    const path = points.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(' ')
    const fmt = format ?? ((v: number) => v.toLocaleString())
    const t = TONES[tone]

    const active = hover ?? points.length - 1
    const accessibleName = label
        ? `${label}: ${points.map(fmt).join(', ')}`
        : undefined

    return (
        <svg
            width={width} height={height} viewBox={`0 0 ${width} ${height}`}
            className={cn('overflow-visible', className)}
            role={accessibleName ? 'img' : undefined}
            aria-labelledby={accessibleName ? titleId : undefined}
            aria-hidden={accessibleName ? undefined : true}
            onMouseLeave={() => setHover(null)}
        >
            {accessibleName && <title id={titleId}>{accessibleName}</title>}
            <polyline
                points={path}
                fill="none"
                strokeWidth="2"
                strokeLinejoin="round"
                strokeLinecap="round"
                className={t.line}
            />
            {/* Crosshair on the hovered point. */}
            {hover != null && (
                <line
                    x1={hover * step} y1={0} x2={hover * step} y2={height}
                    strokeWidth="1"
                    className="stroke-ink-muted/30"
                />
            )}
            <circle
                cx={active * step} cy={y(points[active])} r="4"
                className={t.dot}
            />
            {/* Hit targets, deliberately wider than the marks. Rendered last
                so they sit above the line; invisible but pointer-active.

                The per-point <title> is the NATIVE tooltip and it is tied to
                `label`, exactly like the accessible name above: a caller that
                names its series has opted into OS chrome, and one that does
                not is either decorative (`aria-hidden`) or — as in
                ViewUsageBadge — already wrapped in a HoverTip, where a second
                pill would paint a bare number over the card. */}
            {points.map((v, i) => (
                <rect
                    key={i}
                    x={i * step - step / 2} y={0}
                    width={step} height={height}
                    fill="transparent"
                    onMouseEnter={() => setHover(i)}
                >
                    {label && <title>{`${label}: ${fmt(v)}`}</title>}
                </rect>
            ))}
        </svg>
    )
}
