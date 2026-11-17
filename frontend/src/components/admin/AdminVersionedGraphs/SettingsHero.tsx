/**
 * The top of a settings page: where its settings stand, and the ways in.
 *
 *   SettingsHero   the DashboardHero pattern, in a card with a contained halo: an eyebrow (the
 *                  page and the level), a headline counted from the values ("5 of 46 settings
 *                  changed from the default"), the server's reads posture under it, a pill while
 *                  changes are staged (to Review), a chip for what this platform's facts suggest,
 *                  the page's actions (or, for a viewer who may only read, why not), the compass at
 *                  a glance, and the search with "Changed only". Its parts rise in, one after
 *                  another, unless the person asked for calm.
 *   CompassSummary the trade-off compass folded to a tile: the dimensions the settings lean on most,
 *                  and how staged changes move them; opened, the whole compass, full width.
 *   TaskCards      "What do you want to do?": the GuideHome pattern, each card a business setting's
 *                  own question (no copy of its own), linking to that setting's row.
 */
import { useId, useMemo, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { motion, type Transition } from 'framer-motion'
import { ArrowRight, ChevronDown, Eye, SlidersHorizontal, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MOTION } from '@/lib/motion'
import {
    TradeoffCompass, compassMoves, compassScores, scoreWords, settingAnchor,
    type CompassPoint, type DimensionInfo, type Setting, type Values,
} from '@/components/settings'
import { useCalmMotion } from '@/components/settings/visuals/motion'
import { CategoryIcon } from './CategorySection'

/** Seven axes on a tile: the compass at a glance, beside its one-line summary. */
function MiniRadar({ points, ghost }: { points: CompassPoint[]; ghost: CompassPoint[] | null }) {
    const n = points.length || 1
    const at = (i: number, score: number) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / n
        const r = 15 * (0.18 + 0.82 * ((score + 1) / 2))
        return `${(18 + r * Math.cos(a)).toFixed(1)},${(18 + r * Math.sin(a)).toFixed(1)}`
    }
    return (
        <svg aria-hidden viewBox="0 0 36 36" className="w-9 h-9 shrink-0">
            <polygon points={points.map((_, i) => at(i, 1)).join(' ')} className="fill-none stroke-ink-muted/25" strokeWidth={1} />
            <polygon points={points.map((p, i) => at(i, p.score)).join(' ')} className="fill-ink-secondary/10 stroke-ink-secondary" strokeWidth={1.5} strokeLinejoin="round" />
            {ghost && <polygon points={ghost.map((p, i) => at(i, p.score)).join(' ')} className="fill-none stroke-accent-lineage" strokeWidth={1.5} strokeDasharray="3 2" strokeLinejoin="round" />}
        </svg>
    )
}

/** The compass, folded to a line: the dimensions it leans on most, and how staged changes move them. */
export function CompassSummary({ dimensions, settings, current, next, inactive, open, onToggle }: {
    dimensions: DimensionInfo[]
    settings: Setting[]
    current: Values
    next: Values
    inactive: string[]
    open: boolean
    onToggle: () => void
}) {
    const id = useId()
    const skip = useMemo(() => new Set(inactive), [inactive])
    const points = useMemo(() => compassScores(dimensions, settings, current, skip), [dimensions, settings, current, skip])
    const ghost = useMemo(() => compassScores(dimensions, settings, next, skip), [dimensions, settings, next, skip])
    const moved = compassMoves(points, ghost)
    const lead = points.filter((p) => p.touched && Math.abs(p.score) >= 0.1).sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 3)
    const shifted = moved ? points.filter((p, i) => Math.abs(p.score - ghost[i].score) > 0.005).length : 0
    return (
        <div className={cn('rounded-2xl border border-glass-border/50 bg-canvas-elevated', open && 'col-span-full')}>
            <button type="button" aria-expanded={open} aria-controls={`${id}-panel`} onClick={onToggle}
                className="flex w-full items-center gap-3 rounded-2xl px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <MiniRadar points={points} ghost={moved ? ghost : null} />
                <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold text-ink">What your settings trade</span>
                    <span className="block text-xs text-ink-secondary">
                        {lead.length ? lead.map((p) => `${p.label} ${scoreWords(p.score)}`).join(' · ') : 'Balanced on every dimension'}
                        {shifted > 0 && <span className="font-semibold text-indigo-700 dark:text-indigo-300"> · your changes move {shifted}</span>}
                    </span>
                </span>
                <ChevronDown aria-hidden className={cn('w-4 h-4 shrink-0 text-ink-muted transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
            </button>
            <div id={`${id}-panel`} hidden={!open} className="px-4 pb-4">
                {open && <TradeoffCompass dimensions={dimensions} settings={settings} current={current} next={next} inactive={inactive} className="border-0 bg-transparent p-0 sm:p-0" />}
            </div>
        </div>
    )
}

/** A rise into place, one part after another; nothing moves for a person who asked for calm. */
function useRise(stagger: number, entry: Transition, y: number) {
    const { reduced } = useCalmMotion()
    return (i: number) => (reduced ? { initial: false as const } : {
        initial: { opacity: 0, y },
        animate: { opacity: 1, y: 0 },
        transition: { ...entry, delay: Math.min(i, MOTION.staggerMax) * stagger },
    })
}

/** The headline: a number, drawn large, between the words around it. */
export interface Headline {
    before?: string
    count: number
    after: string
}

export function SettingsHero({
    eyebrow, headline, posture, staged, problems, onReview, suggestions, onSuggestions, readOnlyNote, actions, compass, compassOpen, tools,
}: {
    /** The page and the level: "Settings · the platform", "Defaults · Finance". */
    eyebrow: string
    headline: Headline
    /** The server's reads posture: what readers get. */
    posture: ReactNode
    /** Changes staged here, and how many need a fix before they can be reviewed. */
    staged: number
    problems: number
    onReview: () => void
    /** What this platform's facts suggest that isn't in force (system admins); 0: no chip. */
    suggestions: number
    onSuggestions: () => void
    /** For a viewer who may only read: said before what they can still do (the finder). */
    readOnlyNote: string | null
    actions: ReactNode
    /** The compass at a glance (`CompassSummary`): beside the headline, full width once opened. */
    compass: ReactNode
    compassOpen: boolean
    /** The search and "Changed only". */
    tools: ReactNode
}) {
    const titleId = useId()
    const rise = useRise(MOTION.sectionStagger, MOTION.sectionEntry, MOTION.sectionY)
    const changes = `${staged} ${staged === 1 ? 'change' : 'changes'} not saved`
    return (
        <section aria-labelledby={titleId} className="relative rounded-3xl border border-glass-border/50 bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-none">
            {/* The halo, held inside the card: the search's list opens past its edge, the glow never does. */}
            <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
                <div className="absolute -left-24 -top-36 h-72 w-[40rem] max-w-[95%] rounded-full bg-indigo-500/12 blur-[90px] dark:bg-indigo-400/12" />
                <div className="absolute -right-20 -top-28 h-60 w-[22rem] max-w-[60%] rounded-full bg-violet-500/10 blur-[90px] dark:bg-violet-400/10" />
            </div>
            <div className="relative grid gap-x-8 gap-y-5 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,21rem)]">
                <div className="min-w-0">
                    <motion.p {...rise(0)} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-700 dark:text-indigo-300">
                        <SlidersHorizontal aria-hidden className="w-3.5 h-3.5" /> {eyebrow}
                    </motion.p>
                    <motion.h2 {...rise(1)} id={titleId} className="mt-2.5 font-display text-[26px] font-bold leading-[1.15] tracking-tight text-ink sm:text-[30px]">
                        {headline.before}
                        {/* inline-block and a hair of padding: a clipped gradient crops the last glyph without it. */}
                        <span className="inline-block bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text pr-0.5 tabular-nums text-transparent dark:from-indigo-300 dark:to-violet-300">
                            {headline.count}
                        </span>
                        {headline.after}
                    </motion.h2>
                    {posture && <motion.p {...rise(2)} className="mt-2.5 max-w-2xl text-[13.5px] leading-relaxed text-ink-secondary sm:text-sm">{posture}</motion.p>}
                    {(staged > 0 || suggestions > 0) && (
                        <motion.div {...rise(3)} className="mt-4 flex flex-wrap items-center gap-2">
                            {staged > 0 && (problems > 0 ? (
                                <span className="inline-flex items-center gap-2 rounded-full border border-rose-500/25 bg-rose-500/[0.06] px-3 py-1 text-[12.5px] font-semibold text-rose-700 dark:text-rose-300">
                                    <span aria-hidden className="h-2 w-2 rounded-full bg-rose-500" />
                                    {changes} · {problems} to fix
                                </span>
                            ) : (
                                <button type="button" onClick={onReview}
                                    className="group inline-flex items-center gap-2 rounded-full border border-indigo-500/25 bg-indigo-500/[0.06] px-3 py-1 text-[12.5px] font-semibold text-indigo-700 outline-none transition-colors hover:bg-indigo-500/10 focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:border-indigo-400/30 dark:text-indigo-300">
                                    {/* Still: a ping isn't quieted by the app's calm mode. */}
                                    <span aria-hidden className="h-2 w-2 rounded-full bg-indigo-600 dark:bg-indigo-400" />
                                    {changes} · Review
                                    <ArrowRight aria-hidden className="w-3.5 h-3.5" />
                                </button>
                            ))}
                            {suggestions > 0 && (
                                <button type="button" onClick={onSuggestions}
                                    className="inline-flex items-center gap-1.5 rounded-full border border-glass-border/70 bg-canvas-elevated px-3 py-1 text-[12.5px] font-medium text-ink-secondary outline-none transition-colors hover:border-violet-500/35 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                    <Sparkles aria-hidden className="w-3.5 h-3.5 text-violet-600 dark:text-violet-300" />
                                    {suggestions} {suggestions === 1 ? 'suggestion' : 'suggestions'} for your platform
                                </button>
                            )}
                        </motion.div>
                    )}
                    <motion.div {...rise(4)} className="mt-5 space-y-3">
                        {readOnlyNote && (
                            <p role="note" className="flex items-start gap-2 rounded-2xl border border-glass-border/60 bg-black/[0.02] px-4 py-3 text-[13px] text-ink-secondary dark:bg-white/[0.03]">
                                <Eye aria-hidden className="mt-0.5 w-4 h-4 shrink-0 text-ink-secondary" />
                                {readOnlyNote}
                            </p>
                        )}
                        <div className="flex flex-wrap items-center gap-2.5">{actions}</div>
                    </motion.div>
                </div>
                {/* The search stays put when the compass opens: the compass takes the row under it. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-3 border-t border-glass-border/50 pt-5 lg:col-span-2">{tools}</div>
                <div className={cn('min-w-0', compassOpen ? 'lg:col-span-2' : 'lg:col-start-2 lg:row-start-1 lg:self-start')}>{compass}</div>
            </div>
        </section>
    )
}

/** "What do you want to do?": the GuideHome pattern, each card a business setting's own question, linking to its row. */
export function TaskCards({ tasks, icons, search, current, onAgain }: {
    tasks: Setting[]
    /** Each category's icon name, by id. */
    icons: Record<string, string>
    /** The page's query, kept when a card is followed. */
    search: string
    /** The setting the page is at: following its card again scrolls back to it. */
    current: string | null
    onAgain: (key: string) => void
}) {
    const titleId = useId()
    const { reduced } = useCalmMotion()
    const rise = useRise(MOTION.cardStagger, MOTION.cardEntry, MOTION.cardY)
    if (!tasks.length) return null
    return (
        <section aria-labelledby={titleId}>
            <h2 id={titleId} className="text-[15px] font-semibold tracking-tight text-ink">What do you want to do?</h2>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {tasks.map((s, i) => (
                    <motion.li key={s.key} {...rise(i)} className="min-w-0">
                        <Link
                            to={{ search, hash: settingAnchor(s.key) }}
                            replace
                            onClick={(e) => {
                                // Already there: the link changes nothing, so go back to the row by hand.
                                if (current !== s.key) return
                                e.preventDefault()
                                onAgain(s.key)
                            }}
                            className={cn(
                                'group flex h-full items-start gap-3 rounded-2xl border border-glass-border/50 bg-canvas-elevated p-4 outline-none',
                                'transition-[transform,box-shadow,border-color] duration-200 hover:border-indigo-500/30 hover:shadow-glass',
                                'focus-visible:ring-2 focus-visible:ring-accent-lineage/40',
                                !reduced && 'hover:-translate-y-0.5',
                            )}
                        >
                            <span className="mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-md shadow-indigo-500/20">
                                <CategoryIcon name={icons[s.category] ?? ''} className="h-5 w-5" />
                            </span>
                            <span className="min-w-0">
                                <span className="block text-[13.5px] font-semibold leading-snug text-ink transition-colors group-hover:text-indigo-700 dark:group-hover:text-indigo-300">
                                    {s.question}
                                    <ArrowRight aria-hidden className="ml-1 inline h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                                </span>
                                <span className="mt-1 block text-[12.5px] leading-relaxed text-ink-secondary">{s.guidance.summary}</span>
                            </span>
                        </Link>
                    </motion.li>
                ))}
            </ul>
        </section>
    )
}
