/**
 * NeedsAttention — what needs attention on the platform (`attention.ts`), the most important first,
 * each with the one thing to do about it:
 *
 *   failing graphs           Show them (the list below, filtered)
 *   graphs waiting for room  Show them, and a link to the memory settings
 *   a problem past its mark  See what to change: the finder, opened at that problem
 *   changes not saved        Review
 *   an adjusted value        its fix, as its row offers it: a switch asks first, a setting is staged
 *   an ignored deployment    Show the setting
 *
 * A viewer who may only read gets no fix: the setting instead. Six at a time, then "Show all N".
 * What couldn't be checked is said, so an empty list is never a guess; when nothing needs
 * attention, one calm line says what was checked.
 */
import { useId, useState, type ComponentType, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { Activity, ArrowRight, ChevronDown, CircleCheck, Hourglass, OctagonAlert, PencilLine, ServerCog, Stethoscope, TriangleAlert, Wand2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { MOTION } from '@/lib/motion'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { StatusBadge, type WhyFix } from '@/components/settings'
import type { AttentionItem } from './attention'
import { useRise } from './rise'

/** Shown before "Show all N". */
const CAP = 6

/** A link's colour that reads at AA on this page's surfaces, in both themes. */
const LINK = 'text-indigo-700 dark:text-indigo-300'

type Tone = 'critical' | 'warning' | 'info'

const TILE: Record<Tone, string> = {
    critical: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    warning: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
    info: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-300',
}

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`

/** How serious each kind is: what readers feel now, what keeps happening, then what to tidy. */
function toneOf(item: AttentionItem): Tone {
    if (item.kind === 'failing') return 'critical'
    if (item.kind === 'staged' || item.kind === 'env') return 'info'
    return 'warning'
}

/** A button whose visible words start its name, and say what it is for to a screen reader. */
function Act({ label, what, icon, onClick }: { label: string; what: string; icon?: ComponentType<{ className?: string }>; onClick: () => void }) {
    return (
        <Button size="sm" variant="secondary" leftIcon={icon} rightIcon={icon ? undefined : ArrowRight} onClick={onClick} className="border-glass-border/80">
            {label}<span className="sr-only">: {what}</span>
        </Button>
    )
}

export interface AttentionActions {
    /** Filters the list of graphs to the failing ones, or those waiting for room. */
    showGraphs: (which: 'failing' | 'waiting') => void
    /** Opens Settings at a category. */
    goToCategory: (id: string) => void
    /** Opens the finder at a problem. */
    seeWhatToChange: (symptom: string) => void
    /** Opens Settings at a setting. */
    showSetting: (key: string) => void
    /** Applies a why's fix: a switch through its confirmation, a setting staged. */
    fix: (fix: WhyFix) => void
    /** The staged changes' review (or, with some to fix first, the settings). */
    review: () => void
}

export function NeedsAttention({ items, checking, gaps, signalsCounted, readOnly, fixLabel, memory, on, titleId }: {
    items: AttentionItem[]
    /** The figures, the values or the signals are still being read: nothing is said yet. */
    checking: boolean
    /** What couldn't be checked, in words: said, so no empty list reads as "all clear". */
    gaps: string[]
    /** The server counted what happened, so the calm line can say nothing reached its mark. */
    signalsCounted: boolean
    /** A viewer who may only read: no fixes, the setting instead. */
    readOnly: boolean
    fixLabel: (fix: WhyFix) => string
    /** The memory category, for "Graphs waiting for room": its name and where it is. */
    memory?: { id: string; label: string }
    on: AttentionActions
    /** The heading's id: the hero's pill brings it into view. */
    titleId: string
}) {
    const listId = useId()
    const [all, setAll] = useState(false)
    const rise = useRise(MOTION.cardStagger, MOTION.cardEntry, MOTION.cardY)
    const shown = all ? items : items.slice(0, CAP)
    const calm = items.length === 0 && gaps.length === 0

    const view = (a: AttentionItem): { icon: ComponentType<{ className?: string }>; title: ReactNode; detail: ReactNode; actions: ReactNode } => {
        const showSetting = (key: string, label: string) => <Act label="Show the setting" what={label} onClick={() => on.showSetting(key)} />
        switch (a.kind) {
            case 'failing':
                return {
                    icon: OctagonAlert,
                    title: `${plural(a.count, 'graph is', 'graphs are')} failing`,
                    detail: a.count === 1
                        ? 'Its last update failed, so its readers fall behind or are read from the database until it updates again.'
                        : 'Their last update failed, so their readers fall behind or are read from the database until they update again.',
                    actions: <Act label="Show them" what="the failing graphs" onClick={() => on.showGraphs('failing')} />,
                }
            case 'waiting':
                return {
                    icon: Hourglass,
                    title: `${plural(a.count, 'graph is', 'graphs are')} waiting for room`,
                    detail: a.count === 1
                        ? 'Its node’s memory is full, so it is read from the database until there is room to load it.'
                        : 'Their nodes’ memory is full, so they are read from the database until there is room to load them.',
                    actions: (
                        <>
                            <Act label="Show them" what="the graphs waiting for room" onClick={() => on.showGraphs('waiting')} />
                            {memory && (
                                <button type="button" onClick={() => on.goToCategory(memory.id)}
                                    className={cn('inline-flex items-center gap-1 rounded text-[12.5px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40', LINK)}>
                                    {memory.label} settings <ArrowRight aria-hidden className="w-3.5 h-3.5" />
                                </button>
                            )}
                        </>
                    ),
                }
            case 'signal':
                return {
                    icon: Activity,
                    title: a.symptom,
                    detail: `${a.happened.map((h) => `${h.signal.label}: ${formatCount(h.count, h.signal.unit)} in the last 24 hours (worth a look from ${formatCount(h.signal.warnAt ?? 0)})`).join('; ')}.`,
                    actions: <Act label="See what to change" what={a.symptom} icon={Stethoscope} onClick={() => on.seeWhatToChange(a.symptom)} />,
                }
            case 'staged':
                return {
                    icon: PencilLine,
                    title: `${plural(a.count, 'change')} not saved`,
                    detail: !a.problems ? `Staged on Settings: nothing changes until ${a.count === 1 ? 'it is' : 'they are'} reviewed and saved.`
                        : a.count === 1 ? 'It needs a fix before it can be reviewed.'
                            : `${formatCount(a.problems)} of them ${a.problems === 1 ? 'needs' : 'need'} a fix before they can be reviewed.`,
                    actions: <Act label="Review" what={`${plural(a.count, 'change')} not saved`} onClick={on.review} />,
                }
            case 'fix':
                return {
                    icon: Wand2,
                    title: <>{a.setting.label} <StatusBadge status={a.resolved.status} /></>,
                    detail: a.why.text,
                    actions: readOnly ? showSetting(a.setting.key, a.setting.label) : (
                        <Button size="sm" variant="secondary" leftIcon={Wand2} onClick={() => on.fix(a.fix)} className="border-glass-border/80">
                            {fixLabel(a.fix)}<span className="sr-only">: {a.setting.label}</span>
                        </Button>
                    ),
                }
            case 'env':
                return {
                    icon: ServerCog,
                    title: <>{a.setting.label} <StatusBadge status={a.resolved.status} /></>,
                    detail: a.why.text,
                    actions: showSetting(a.setting.key, a.setting.label),
                }
        }
    }

    return (
        <section aria-labelledby={titleId} aria-busy={checking || undefined}
            className="rounded-2xl border border-glass-border/50 bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-none">
            <div className="flex items-center gap-3 px-5 pt-4 sm:px-6">
                {calm && !checking && (
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                        <CircleCheck aria-hidden className="w-4 h-4" />
                    </span>
                )}
                <h2 id={titleId} tabIndex={-1} className="flex min-w-0 items-center gap-2 rounded text-[15px] font-semibold tracking-tight text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                    {checking || items.length ? 'Needs attention' : calm ? 'Nothing needs attention' : 'Nothing found that needs attention'}
                    {!checking && items.length > 0 && (
                        <span className="rounded-full bg-black/[0.05] px-2 text-[12px] font-semibold tabular-nums text-ink-secondary dark:bg-white/[0.08]">
                            {formatCount(items.length)}
                        </span>
                    )}
                </h2>
            </div>

            {checking ? (
                <div aria-label="Checking what needs attention" className="space-y-3 px-5 pb-5 pt-4 sm:px-6">
                    {[0, 1].map((i) => (
                        <div key={i} className="flex items-start gap-3.5">
                            <Skeleton className="h-9 w-9 shrink-0 rounded-xl" />
                            <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                                <Skeleton className="h-4 w-56 max-w-full rounded" />
                                <Skeleton className="h-3.5 w-full max-w-lg rounded" />
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <>
                    {gaps.length > 0 && (
                        <ul className={cn('mt-2 space-y-1 px-5 sm:px-6', items.length === 0 && 'pb-4')}>
                            {gaps.map((g) => (
                                <li key={g} className="flex items-start gap-1.5 text-[12.5px] leading-snug text-ink-secondary">
                                    <TriangleAlert aria-hidden className="mt-0.5 w-3.5 h-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
                                    {g}
                                </li>
                            ))}
                        </ul>
                    )}
                    {calm ? (
                        <p className="pb-4 pl-[4.25rem] pr-5 pt-0.5 text-[13px] leading-relaxed text-ink-secondary sm:pl-[4.5rem] sm:pr-6">
                            {/* Only what was checked: the signals are claimed when the server counted them. */}
                            {signalsCounted
                                ? 'No graph is failing or waiting for room, nothing counted in the last 24 hours reached its mark, and no setting needs a fix.'
                                : 'No graph is failing or waiting for room, and no setting needs a fix.'}
                        </p>
                    ) : items.length > 0 ? (
                        <ul id={listId} className="mt-2 divide-y divide-glass-border/50 border-t border-glass-border/50">
                            {shown.map((a, i) => {
                                const v = view(a)
                                return (
                                    <motion.li key={a.id} {...rise(i)} className="flex flex-wrap items-start gap-x-3.5 gap-y-2.5 px-5 py-4 sm:flex-nowrap sm:px-6">
                                        <span className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-xl', TILE[toneOf(a)])}>
                                            <v.icon aria-hidden className="w-4 h-4" />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13.5px] font-semibold leading-snug text-ink">{v.title}</div>
                                            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-secondary">{v.detail}</p>
                                        </div>
                                        <div className="flex w-full flex-wrap items-center gap-x-3 gap-y-2 pl-[3.125rem] sm:w-auto sm:shrink-0 sm:justify-end sm:pl-0">{v.actions}</div>
                                    </motion.li>
                                )
                            })}
                        </ul>
                    ) : null}
                    {items.length > CAP && (
                        <div className="border-t border-glass-border/50 px-5 py-2.5 sm:px-6">
                            <button type="button" aria-expanded={all} aria-controls={listId} onClick={() => setAll((x) => !x)}
                                className={cn('inline-flex items-center gap-1 rounded text-[12.5px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40', LINK)}>
                                {all ? 'Show fewer' : `Show all ${formatCount(items.length)}`}
                                <ChevronDown aria-hidden className={cn('w-3.5 h-3.5 transition-transform motion-reduce:transition-none', all && 'rotate-180')} />
                            </button>
                        </div>
                    )}
                </>
            )}
        </section>
    )
}
