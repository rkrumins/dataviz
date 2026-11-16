/**
 * TradeoffCompass — what the settings in force trade, on seven dimensions at once: Consistency,
 * Availability, Read speed, Update speed, Memory, Database load, Cost. Further out is better.
 *
 * The solid shape is the settings in force. Staged changes draw a dashed outline in the accent,
 * so the trade is visible before saving: reads get faster, memory gets worse. The scores come from
 * the registry's own verdicts and weights (`compass.ts`).
 *
 * Beside it, each dimension in words with a diverging bar (worse ← balanced → better) and the
 * staged score marked: the compass's table view, and its keyboard way in. Focusing or hovering a
 * dimension highlights its axis and lists the settings that drive it.
 */
import { useId, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'
import { compassMoves, compassScores, scoreWords, type CompassPoint } from '../compass'
import type { DimensionInfo, Setting, Values } from '../types'
import { useCalmMotion } from './motion'
import { LegendKey, VisualFrame } from './VisualFrame'

// Wider than tall: the labels ("Database load") need room either side of the radar.
const W = 420
const H = 290
const CX = W / 2
const CY = H / 2
const R = 102
/** Radius for a score: never collapses to the centre; balanced sits at the middle ring. */
const rad = (score: number) => R * (0.18 + 0.82 * ((score + 1) / 2))
const angle = (i: number, n: number) => -Math.PI / 2 + (i * 2 * Math.PI) / n
const at = (i: number, n: number, r: number) => [CX + r * Math.cos(angle(i, n)), CY + r * Math.sin(angle(i, n))] as const
const shape = (pts: CompassPoint[]) => pts.map((p, i) => at(i, pts.length, rad(p.score)).map((v) => v.toFixed(1)).join(',')).join(' ')

function DivergingBar({ score, ghost }: { score: number; ghost?: number }) {
    const half = (s: number) => `${Math.abs(s) * 50}%`
    return (
        <span aria-hidden className="relative block h-1.5 w-full rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
            <span className="absolute inset-y-0 left-1/2 w-px bg-ink-muted/40" />
            <span
                className={cn('absolute inset-y-0 rounded-full', score >= 0 ? 'left-1/2 bg-emerald-500/70' : 'right-1/2 bg-amber-500/80')}
                style={{ width: half(score) }}
            />
            {ghost !== undefined && (
                <span className="absolute -top-1 h-3.5 w-0.5 -translate-x-1/2 rounded-full bg-accent-lineage" style={{ left: `${50 + ghost * 50}%` }} />
            )}
        </span>
    )
}

export function TradeoffCompass({ dimensions, settings, current, next, inactive, title = 'What your settings trade', className }: {
    dimensions: DimensionInfo[]
    settings: Setting[]
    /** The values in force. */
    current: Values
    /** The values with staged changes applied. */
    next?: Values
    /** Keys that have no effect now (dormant or not used): left out. */
    inactive?: string[]
    title?: string
    className?: string
}) {
    const id = useId()
    const { transition } = useCalmMotion()
    const [focus, setFocus] = useState<number | null>(null)
    const skip = useMemo(() => new Set(inactive ?? []), [inactive])
    const points = useMemo(() => compassScores(dimensions, settings, current, skip), [dimensions, settings, current, skip])
    const ghost = useMemo(() => (next ? compassScores(dimensions, settings, next, skip) : null), [dimensions, settings, next, skip])
    const moved = ghost !== null && compassMoves(points, ghost)
    const n = points.length
    const picked = focus !== null ? points[focus] : null

    const sentence = points.map((p, i) => {
        const g = moved && ghost ? ghost[i] : null
        const change = g && Math.abs(g.score - p.score) > 0.005 ? `, ${scoreWords(g.score)} with your changes` : ''
        return `${p.label} ${p.touched ? scoreWords(p.score) : 'not affected'}${change}`
    }).join('; ')

    return (
        <VisualFrame
            eyebrow="Trade-off compass"
            title={title}
            className={className}
            legend={(
                <>
                    <LegendKey kind="line" className="border-ink-secondary">In force</LegendKey>
                    {moved && <LegendKey kind="dashed" className="border-accent-lineage">With your changes</LegendKey>}
                </>
            )}
            caption={picked ? (
                <>
                    <span className="font-semibold text-ink">{picked.label}: {picked.touched ? scoreWords(picked.score) : 'no setting here affects it'}.</span>{' '}
                    {picked.drivers.length > 0 && <>Driven by {picked.drivers.slice(0, 3).map((d) => `${d.label} (${d.contribution > 0 ? 'better' : d.contribution < 0 ? 'worse' : 'no change'}: ${d.text.replace(/\.$/, '')})`).join('; ')}.</>}
                </>
            ) : (
                <>Further out is better. {moved ? 'The dashed outline is where your staged changes would leave each dimension.' : 'Stage a change to see the trade before you save.'} Focus a dimension to see what drives it.</>
            )}
        >
            {/* Stacked: the card it sits in decides its width, not the window, so a side-by-side
                split keyed to the viewport would squeeze the list in a narrow card. */}
            <div className="space-y-5">
                <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Trade-off compass. ${sentence}.`} className="mx-auto block w-full max-w-[420px]">
                    {[0.18, 0.59, 1].map((f) => (
                        <polygon
                            key={f}
                            points={points.map((_, i) => at(i, n, R * f).join(',')).join(' ')}
                            className={cn('fill-none', f === 0.59 ? 'stroke-ink-muted/40' : 'stroke-ink-muted/20')}
                            strokeWidth={1}
                        />
                    ))}
                    {points.map((p, i) => {
                        const [x, y] = at(i, n, R)
                        return (
                            <line key={p.dimension} x1={CX} y1={CY} x2={x} y2={y} strokeWidth={focus === i ? 1.5 : 1}
                                className={focus === i ? 'stroke-ink-secondary' : 'stroke-ink-muted/20'} />
                        )
                    })}
                    <motion.polygon
                        data-series="in-force"
                        initial={false}
                        animate={{ points: shape(points) }}
                        transition={transition}
                        className="fill-ink-secondary/[0.07] stroke-ink-secondary"
                        strokeWidth={2}
                        strokeLinejoin="round"
                    />
                    {moved && ghost && (
                        <motion.polygon
                            data-series="staged"
                            initial={{ points: shape(points), opacity: 0 }}
                            animate={{ points: shape(ghost), opacity: 1 }}
                            transition={transition}
                            className="fill-accent-lineage/[0.08] stroke-accent-lineage"
                            strokeWidth={2}
                            strokeDasharray="5 4"
                            strokeLinejoin="round"
                        />
                    )}
                    {points.map((p, i) => {
                        const [x, y] = at(i, n, rad(p.score))
                        return (
                            <motion.circle key={p.dimension} initial={false} animate={{ cx: x, cy: y }} transition={transition} r={focus === i ? 5 : 4}
                                className={cn(p.touched ? 'fill-ink-secondary' : 'fill-canvas-elevated stroke-ink-muted/60', 'stroke-[2px]')}
                                style={{ stroke: p.touched ? 'var(--nx-bg-elevated)' : undefined }} />
                        )
                    })}
                    {points.map((p, i) => {
                        const [x, y] = at(i, n, R + 16)
                        const cos = Math.cos(angle(i, n))
                        return (
                            <text key={p.dimension} x={x} y={y} dominantBaseline="middle"
                                textAnchor={Math.abs(cos) < 0.2 ? 'middle' : cos > 0 ? 'start' : 'end'}
                                className={cn('text-[11px]', focus === i ? 'fill-ink font-semibold' : 'fill-ink-secondary')}>
                                {p.label}
                            </text>
                        )
                    })}
                    {/* Hover targets, bigger than the marks. */}
                    {points.map((p, i) => {
                        const [x, y] = at(i, n, R * 0.8)
                        return <circle key={p.dimension} cx={x} cy={y} r={26} className="fill-transparent" onPointerEnter={() => setFocus(i)} onPointerLeave={() => setFocus(null)} />
                    })}
                </svg>

                <ul aria-label="Each dimension, in words" className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                    {points.map((p, i) => {
                        const g = moved && ghost ? ghost[i] : null
                        const delta = g ? g.score - p.score : 0
                        return (
                            <li key={p.dimension}>
                                <button
                                    type="button"
                                    aria-describedby={`${id}-${p.dimension}`}
                                    onFocus={() => setFocus(i)}
                                    onBlur={() => setFocus(null)}
                                    onPointerEnter={() => setFocus(i)}
                                    onPointerLeave={() => setFocus(null)}
                                    className={cn(
                                        'grid w-full grid-cols-[minmax(0,1fr)_5.5rem] items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1.5 text-left',
                                        'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                        focus === i ? 'bg-black/[0.04] dark:bg-white/[0.05]' : '',
                                    )}
                                >
                                    <span className="text-xs font-medium text-ink">{p.label}</span>
                                    <DivergingBar score={p.score} ghost={g && Math.abs(delta) > 0.005 ? g.score : undefined} />
                                    <span id={`${id}-${p.dimension}`} className="col-span-2 text-[11px] text-ink-muted">
                                        {p.touched ? scoreWords(p.score) : 'Not affected by these settings'}
                                        {g && Math.abs(delta) > 0.005 && (
                                            <span className="font-semibold text-accent-lineage">
                                                {' '}→ {scoreWords(g.score) !== scoreWords(p.score) ? scoreWords(g.score) : delta > 0 ? 'a shade better' : 'a shade worse'}
                                                <span className="sr-only"> with your changes</span>
                                            </span>
                                        )}
                                    </span>
                                </button>
                            </li>
                        )
                    })}
                </ul>
            </div>
        </VisualFrame>
    )
}
