/**
 * Overview — the platform's versioned graphs at a glance.
 *
 *   hero        the DashboardHero pattern, held in a card as the Settings hero is: the fleet in figures
 *               as the headline (when they could be read) and what readers get as the server says it;
 *               whether anything needs attention, a pill that leads there; the feature switches; and
 *               the ways in: "Set up with a guide" (or "Continue setup") for an editor, "Review the
 *               settings" for everyone
 *   attention   what needs attention, the most important first, each with its one action
 *               (`NeedsAttention`, from `attention.ts`), built only from what this page reads anyway
 *   figures     graphs; in memory, unloaded, loading, waiting for room and with no copy yet (the five
 *               add up to the graphs); building; failing; with settings of their own — each defined
 *               on a tap, as of when it was read, counting up to its value (at once for a person who
 *               asked for calm), and a filter of the list below. A figure that couldn't be read is
 *               "—" with why, never 0. On a phone they come two to a row.
 *   categories  each other category's posture as the server writes it, a link to its settings; folded
 *               on a phone, so what needs attention and the figures come first
 *   finder      "Something's wrong?", with what happened in the last day where the server counts it;
 *               "See what to change" opens it at that problem
 *   inventory   every graph, its settings a click away
 *
 * The figures aren't read again over staged changes, as on Settings: once read, they wait for the
 * save or the discard.
 */
import { useId, useMemo, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import { ArrowDown, ArrowRight, ChevronDown, CircleCheck, LayoutDashboard, RotateCw, Route } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { MOTION } from '@/lib/motion'
import { useCountUp } from '@/hooks/useCountUp'
import { MetricInfo } from '@/components/analytics/MetricInfo'
import type { MetricDefinition } from '@/components/analytics/metricDefinitions'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DateTime } from '@/components/ui/DateTime'
import { Skeleton } from '@/components/ui/Skeleton'
import {
    CATALOGUE, FEATURE_NAMES, SymptomFinder, describeFix, type ResolvedValues, type SettingValue, type WhyFix,
} from '@/components/settings'
import type { GraphProvider, VersionedGraphRow } from '@/services/systemStatusService'
import {
    settingsError, settingsKeys, useGraphsSummary, type GraphInventoryFilter, type GraphsSummary, type ServedSchema, type SignalCount,
} from '@/services/settingsService'
import { needsAttention, type AttentionItem } from './attention'
import { CategoryIcon } from './CategorySection'
import { GraphInventory } from './GraphInventory'
import { NeedsAttention } from './NeedsAttention'
import { useRise } from './rise'
import type { FeatureSwitches } from './useFeatureSwitches'

/** A link's colour that reads at AA on this page's surfaces, in both themes. */
const LINK = 'text-indigo-700 dark:text-indigo-300'

const MEMORY: Array<{ id: keyof GraphsSummary; label: string; words: string; dot: string; filter?: GraphInventoryFilter }> = [
    { id: 'inMemory', label: 'In memory', words: 'in memory', dot: 'bg-emerald-500' },
    { id: 'unloaded', label: 'Unloaded', words: 'unloaded', dot: 'bg-slate-400 dark:bg-slate-500', filter: { status: 'evicted' } },
    { id: 'loading', label: 'Loading', words: 'loading', dot: 'bg-sky-500', filter: { status: 'rehydrating' } },
    { id: 'waitingForRoom', label: 'Waiting for room', words: 'waiting for room', dot: 'bg-amber-500', filter: { status: 'waiting_capacity' } },
    { id: 'noCopy', label: 'No copy yet', words: 'with no copy yet', dot: 'bg-slate-200 ring-1 ring-inset ring-slate-400 dark:bg-slate-800 dark:ring-slate-500' },
]

/** Where the fleet's graphs are, in words: every state with graphs in it, and always those in memory. */
function whereWords(summary: GraphsSummary): string {
    return MEMORY.filter((m) => m.id === 'inMemory' || summary[m.id])
        .map((m) => `${formatCount(summary[m.id] as number)} ${m.words}`).join(', ')
}

/** A figure's definition, titled by its tile: what it counts, how, and why it matters. */
type Explained = Omit<MetricDefinition, 'title'>

interface Figure {
    id: string
    label: string
    value: (s: GraphsSummary) => number
    definition: Explained
    filter?: GraphInventoryFilter
    /** Worth a look when above zero. */
    alarm?: boolean
}

const FIGURES: Figure[] = [
    {
        id: 'graphs', label: 'Versioned graphs', value: (s) => s.graphs, filter: {},
        definition: {
            what: 'Live versioned graphs on the platform. A fork isn’t counted: it follows the graph it was forked from.',
            how: 'Every graph under version control that isn’t in the trash, counted in the database when the figures were read. Forks are left out.',
            why: 'It is how far a platform change reaches: each of these graphs follows the platform’s values unless it or its workspace chose its own.',
        },
    },
    {
        id: 'building', label: 'Building a new version', value: (s) => s.building, filter: { status: 'building' },
        definition: {
            what: 'Graphs whose next version is being built in a second copy while readers keep the current one.',
            how: 'Graphs with a new-version build under way, at any step: waiting to start, copying, building from the database, catching up or switching.',
            why: 'Each build holds a second copy of its graph while it runs, so it needs that much free memory on its node. Readers move to the new version only once it is built and checked.',
        },
    },
    {
        id: 'failing', label: 'Failing', value: (s) => s.failing, filter: { status: 'failed' }, alarm: true,
        definition: {
            what: 'Graphs whose last update failed. The list below says why for each.',
            how: 'Graphs with an error recorded against their copy: their last update failed, or they are rebuilding on their own after a failure. Each drops out once it updates again.',
            why: 'A failing graph’s copy stops taking new versions, so its readers fall behind or are read from the database, as its read mode says.',
        },
    },
    {
        id: 'own', label: 'With settings of their own', value: (s) => s.withOwnSettings, filter: { ownSettings: true },
        definition: {
            what: 'Graphs that chose at least one setting for themselves instead of following their workspace and the platform.',
            how: 'Graphs with at least one setting saved for the graph itself. Forks are left out: a fork has no settings of its own.',
            why: 'A platform or workspace change doesn’t reach a value a graph set for itself, unless the platform locks it, so these are the graphs to look at after one.',
        },
    },
]

/** The list's filters for what needs attention: the same as the figures' own links. */
const SHOW: Record<'failing' | 'waiting', GraphInventoryFilter> = {
    failing: FIGURES.find((f) => f.id === 'failing')!.filter!,
    waiting: MEMORY.find((m) => m.id === 'waitingForRoom')!.filter!,
}

const IN_MEMORY: Explained = {
    what: 'Graphs loaded in the graph store, of those that aren’t forks. The rest are unloaded (their next read comes from the database and loads them), being loaded, waiting for room on their node, or have no copy in the graph store yet: together, every graph.',
    how: 'Each graph counts once, by the state of its copy now: in memory, loading (its copy is being written from the database), unloaded, waiting for room on its node, or no copy yet. So the five add up to the versioned graphs.',
    why: 'A graph in memory is read from the graph store, fast. An unloaded one is read from the database, more slowly, until it is loaded again; graphs waiting for room mean a node’s memory is full.',
}

/** A figure, counting up to its value; exactly its value at once for a person who asked for calm. */
function Count({ n, alarm = false }: { n: number; alarm?: boolean }) {
    const shown = useCountUp(n, { from: 0 })
    return (
        <p className={cn('text-3xl font-semibold tracking-tight tabular-nums', alarm && n > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-ink')}>
            {formatCount(shown)}
        </p>
    )
}

function Tile({ label, definition, children, onClick, action, className }: {
    label: string
    definition: Explained
    children: ReactNode
    onClick?: () => void
    action?: string
    className?: string
}) {
    return (
        <Card padding="md" className={cn('flex min-w-0 flex-col gap-1', className)}>
            <div className="flex items-start gap-1">
                <p className="min-w-0 text-[12.5px] font-medium text-ink-secondary">{label}</p>
                <MetricInfo definition={{ title: label, ...definition }} className="mt-px" />
            </div>
            {children}
            {onClick && action && (
                <button type="button" onClick={onClick} className={cn('mt-auto inline-flex w-fit items-center gap-1 pt-1 text-[11.5px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40', LINK)}>
                    {action}<span className="sr-only">: {label}</span> <ArrowRight aria-hidden className="w-3 h-3" />
                </button>
            )}
        </Card>
    )
}

function Figures({ q, onFilter }: { q: UseQueryResult<GraphsSummary>; onFilter: (f: GraphInventoryFilter) => void }) {
    const s = q.data
    const failed = q.error ? settingsError(q.error).message : null
    const asOf = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null
    const value = (n: number | undefined, alarm = false) => (
        n === undefined
            ? <p className="text-3xl font-semibold tracking-tight text-ink-secondary" aria-label="Not known">—</p>
            : <Count n={n} alarm={alarm} />
    )
    const total = s ? MEMORY.reduce((n, m) => n + ((s[m.id] as number | undefined) ?? 0), 0) : 0

    return (
        <section aria-labelledby="figures-title" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="figures-title" className="text-[15px] font-semibold tracking-tight text-ink">The fleet now</h2>
                {!failed && (
                    <p className="text-[11.5px] text-ink-secondary">
                        {asOf ? <DateTime at={asOf} prefix="As of " /> : 'Reading the figures…'}
                    </p>
                )}
            </div>
            {failed && (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-2xl border border-rose-500/25 bg-rose-500/[0.05] px-4 py-3">
                    <p className="min-w-0 flex-1 text-[13px] text-rose-700 dark:text-rose-300">Couldn’t read the figures: {failed}. Each shows “—” until they are read.</p>
                    <Button size="sm" leftIcon={RotateCw} onClick={() => void q.refetch()}>Try again</Button>
                </div>
            )}
            {q.isPending ? (
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}</div>
            ) : (
                <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
                    {FIGURES.slice(0, 1).map((f) => (
                        <Tile key={f.id} label={f.label} definition={f.definition}>{value(s && f.value(s))}</Tile>
                    ))}
                    <Tile label="In memory" definition={IN_MEMORY}>
                        {value(s?.inMemory)}
                        {s && total > 0 && (
                            <>
                                <div role="img" aria-label={MEMORY.map((m) => `${m.label}: ${formatCount(s[m.id] as number)}`).join(', ')}
                                    className="mt-1 flex h-2 w-full gap-0.5 overflow-hidden rounded-full">
                                    {MEMORY.filter((m) => (s[m.id] as number) > 0).map((m) => (
                                        <span key={m.id} className={cn('h-full first:rounded-l-full last:rounded-r-full', m.dot)} style={{ width: `${((s[m.id] as number) / total) * 100}%` }} />
                                    ))}
                                </div>
                                <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-ink-secondary">
                                    {MEMORY.map((m) => {
                                        // The dot sits on the first line when a narrow tile wraps the words.
                                        const words = <><span aria-hidden className={cn('mt-[0.3125rem] h-2 w-2 shrink-0 rounded-full', m.dot)} /><span>{formatCount(s[m.id] as number)} {m.words}</span></>
                                        return (
                                            <li key={m.id}>
                                                {m.filter && (s[m.id] as number) > 0 ? (
                                                    <button type="button" onClick={() => onFilter(m.filter!)}
                                                        className="inline-flex items-start gap-1.5 rounded text-left underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                                        {words}<span className="sr-only">: show them</span>
                                                    </button>
                                                ) : <span className="inline-flex items-start gap-1.5">{words}</span>}
                                            </li>
                                        )
                                    })}
                                </ul>
                            </>
                        )}
                    </Tile>
                    {FIGURES.slice(1).map((f) => (
                        <Tile key={f.id} label={f.label} definition={f.definition}
                            onClick={f.filter && s && f.value(s) > 0 ? () => onFilter(f.filter!) : undefined} action="Show them">
                            {value(s && f.value(s), f.alarm)}
                        </Tile>
                    ))}
                </div>
            )}
        </section>
    )
}

/** Whether anything needs attention, as the hero's pill says it. */
type Standing = { state: 'checking' } | { state: 'some'; count: number; failing: boolean } | { state: 'none' } | { state: 'unsure' }

function StandingPill({ standing, onShow }: { standing: Standing; onShow: () => void }) {
    const pill = 'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[12.5px] font-semibold'
    const button = 'outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent-lineage/40'
    if (standing.state === 'checking') return <Skeleton className="h-7 w-52 rounded-full" />
    if (standing.state === 'none') {
        return (
            <span className={cn(pill, 'border-emerald-500/25 bg-emerald-500/[0.07] text-emerald-800 dark:border-emerald-400/30 dark:text-emerald-300')}>
                <CircleCheck aria-hidden className="w-3.5 h-3.5" /> Nothing needs attention
            </span>
        )
    }
    if (standing.state === 'unsure') {
        return (
            <button type="button" onClick={onShow} className={cn(pill, button, 'border-glass-border/80 bg-canvas-elevated text-ink-secondary hover:text-ink')}>
                Not everything could be checked <ArrowDown aria-hidden className="w-3.5 h-3.5" />
            </button>
        )
    }
    const dot = standing.failing ? 'bg-rose-500' : 'bg-amber-500'
    return (
        <button type="button" onClick={onShow} className={cn(pill, button, standing.failing
            ? 'border-rose-500/25 bg-rose-500/[0.06] text-rose-700 hover:bg-rose-500/10 dark:border-rose-400/30 dark:text-rose-300'
            : 'border-amber-500/30 bg-amber-500/[0.07] text-amber-800 hover:bg-amber-500/[0.12] dark:border-amber-400/30 dark:text-amber-300')}>
            {/* A ping, held still in calm mode (globals.css) as by the OS's reduced motion. */}
            <span aria-hidden className="relative flex h-2 w-2 shrink-0">
                <span className={cn('absolute inline-flex h-full w-full rounded-full opacity-60 animate-ping', dot)} />
                <span className={cn('relative inline-flex h-2 w-2 rounded-full', dot)} />
            </span>
            {formatCount(standing.count)} {standing.count === 1 ? 'thing needs' : 'things need'} attention
            <ArrowDown aria-hidden className="w-3.5 h-3.5" />
        </button>
    )
}

function Hero({ summary, readsPosture, standing, onShowAttention, switches, actions }: {
    summary: UseQueryResult<GraphsSummary>
    /** The server's reads posture: what readers get. */
    readsPosture: string | undefined
    standing: Standing
    onShowAttention: () => void
    /** Each category's switch: its name, and whether it is on. */
    switches: Array<{ key: string; name: string; on: boolean }>
    actions: ReactNode
}) {
    const titleId = useId()
    const switchesId = useId()
    const rise = useRise(MOTION.sectionStagger, MOTION.sectionEntry, MOTION.sectionY)
    const s = summary.data
    return (
        <section aria-labelledby={titleId} className="relative rounded-3xl border border-glass-border/50 bg-canvas-elevated shadow-[0_1px_2px_rgba(15,23,42,0.04)] dark:shadow-none">
            {/* The halo, held inside the card, as on Settings. */}
            <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden rounded-3xl">
                <div className="absolute -left-24 -top-36 h-72 w-[40rem] max-w-[95%] rounded-full bg-indigo-500/12 blur-[90px] dark:bg-indigo-400/12" />
                <div className="absolute -right-20 -top-28 h-60 w-[22rem] max-w-[60%] rounded-full bg-violet-500/10 blur-[90px] dark:bg-violet-400/10" />
            </div>
            <div className="relative grid gap-x-8 gap-y-5 p-5 sm:p-7 lg:grid-cols-[minmax(0,1fr)_minmax(15rem,19rem)]">
                <div className="min-w-0">
                    <motion.p {...rise(0)} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-indigo-700 dark:text-indigo-300">
                        <LayoutDashboard aria-hidden className="w-3.5 h-3.5" /> Where things stand
                    </motion.p>
                    {/* The fleet in figures, from the server's count; with none read, it says so, never 0. */}
                    {s ? (
                        <motion.h2 {...rise(1)} id={titleId} className="mt-2.5 max-w-4xl font-display text-[26px] font-bold leading-[1.15] tracking-tight text-ink sm:text-[30px]">
                            {/* inline-block and a hair of padding: a clipped gradient crops the last glyph without it. */}
                            <span className="inline-block bg-gradient-to-r from-indigo-600 to-violet-600 bg-clip-text pr-0.5 tabular-nums text-transparent dark:from-indigo-300 dark:to-violet-300">
                                {formatCount(s.graphs)}
                            </span>
                            {' '}{s.graphs === 1 ? 'versioned graph' : 'versioned graphs'}
                            {s.graphs > 0 ? (
                                <>
                                    {/* Read as one sentence: the space outside the spans, where a name keeps it. */}
                                    <span className="sr-only">:</span>{' '}
                                    <span className="mt-1.5 block text-[16px] font-semibold leading-snug tracking-normal text-ink-secondary sm:text-[18px]">{whereWords(s)}.</span>
                                </>
                            ) : '.'}
                        </motion.h2>
                    ) : summary.isPending ? (
                        <>
                            <h2 id={titleId} className="sr-only">Reading the fleet’s figures</h2>
                            <div aria-hidden className="mt-3 space-y-2.5">
                                <Skeleton className="h-8 w-72 max-w-full rounded-lg" />
                                <Skeleton className="h-5 w-[28rem] max-w-full rounded" />
                            </div>
                        </>
                    ) : (
                        <h2 id={titleId} className="mt-2.5 text-[20px] font-semibold leading-snug tracking-tight text-ink-secondary">The fleet’s figures couldn’t be read</h2>
                    )}
                    {readsPosture && <motion.p {...rise(2)} className="mt-3 max-w-3xl text-[13.5px] leading-relaxed text-ink-secondary sm:text-sm">{readsPosture}</motion.p>}
                    <motion.div {...rise(3)} className="mt-4">
                        <StandingPill standing={standing} onShow={onShowAttention} />
                    </motion.div>
                    <motion.div {...rise(4)} className="mt-5 flex flex-wrap items-center gap-2.5">{actions}</motion.div>
                </div>
                {/* Where the Settings hero has its compass: whether each category's switch is on. */}
                {switches.length > 0 && (
                    <motion.div {...rise(3)} className="min-w-0 rounded-2xl border border-glass-border/50 bg-canvas-elevated px-4 py-3 lg:self-start">
                        <p id={switchesId} className="text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-secondary">Feature switches</p>
                        <ul aria-labelledby={switchesId} className="mt-1.5 divide-y divide-glass-border/50">
                            {switches.map((w) => (
                                <li key={w.key} className="flex items-center gap-2.5 py-2 text-[13px] text-ink">
                                    <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full', w.on ? 'bg-emerald-500' : 'bg-slate-400 dark:bg-slate-500')} />
                                    <span className="min-w-0 flex-1 font-medium">{w.name}<span className="sr-only">:</span></span>{' '}
                                    <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-[11.5px] font-semibold',
                                        w.on ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' : 'bg-black/[0.05] text-ink-secondary dark:bg-white/[0.08]')}>
                                        {w.on ? 'On' : 'Off'}
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </motion.div>
                )}
            </div>
        </section>
    )
}

/** Each category but reads (the hero's), as the server writes its posture: on a phone, folded. */
function Postures({ categories, onGoToSettings }: { categories: ServedSchema['categories']; onGoToSettings: (category?: string) => void }) {
    const id = useId()
    const [open, setOpen] = useState(false)
    return (
        <section aria-labelledby={`${id}-title`}>
            <div className="flex items-center justify-between gap-3">
                <h2 id={`${id}-title`} className="text-[15px] font-semibold tracking-tight text-ink">How each category is set</h2>
                {/* Only a phone folds them: the list is open from `sm` up, and this button is gone. */}
                <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}
                    className={cn('inline-flex items-center gap-1 rounded text-[12.5px] font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40 sm:hidden', LINK)}>
                    {open ? 'Hide' : 'Show'}{' '}<span className="sr-only">how each category is set</span>
                    <ChevronDown aria-hidden className={cn('w-3.5 h-3.5 transition-transform motion-reduce:transition-none', open && 'rotate-180')} />
                </button>
            </div>
            <ul id={id} className={cn('mt-3 gap-3 md:grid-cols-2', open ? 'grid' : 'hidden sm:grid')}>
                {categories.map((c) => (
                    <li key={c.id} className="min-w-0">
                        <button type="button" onClick={() => onGoToSettings(c.id)}
                            className="group flex h-full w-full items-start gap-3 rounded-2xl border border-glass-border/50 bg-canvas-elevated p-4 text-left outline-none transition-colors hover:border-indigo-500/30 focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-black/[0.04] text-ink-secondary dark:bg-white/[0.06]">
                                <CategoryIcon name={c.icon} className="w-4 h-4" />
                            </span>
                            <span className="min-w-0">
                                <span className="block text-[13.5px] font-semibold text-ink transition-colors group-hover:text-indigo-700 dark:group-hover:text-indigo-300">
                                    {c.label}<ArrowRight aria-hidden className="ml-1 inline w-3.5 h-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
                                </span>
                                <span className="mt-0.5 block text-[12.5px] leading-relaxed text-ink-secondary">{c.posture}</span>
                            </span>
                        </button>
                    </li>
                ))}
            </ul>
        </section>
    )
}

const ATTENTION_TITLE = 'attention-title'

export function Overview({
    schema, values, valuesFailed = false, readOnly, switches, signals, signalsUnavailable = false, signalsPending = false, staged, problems, providers,
    onShowSetting, onStage, onReview, onOpenSettings, onGoToSettings, setup,
}: {
    schema: ServedSchema
    /** The platform's values, for the finder and what needs attention; absent while they load. */
    values: ResolvedValues | undefined
    /** The platform's values couldn't be read: what needs attention says it couldn't check them. */
    valuesFailed?: boolean
    /** A viewer who may only read the settings: no fixes. */
    readOnly: boolean
    switches: FeatureSwitches
    signals?: SignalCount[]
    /** The server couldn't count the signals: the finder and what needs attention say so. */
    signalsUnavailable?: boolean
    /** The signals are still being counted: what needs attention waits for them. */
    signalsPending?: boolean
    /** Changes staged on the platform (on Settings, or by the guide), and how many need a fix first. */
    staged: number
    problems: number
    providers: GraphProvider[]
    /** Opens Settings at a setting. */
    onShowSetting: (key: string) => void
    /** Stages a value on the platform (and shows it in Settings). */
    onStage: (key: string, value: SettingValue) => void
    /** The staged changes' review. */
    onReview: () => void
    onOpenSettings: (row: VersionedGraphRow) => void
    /** Opens Settings at a category. */
    onGoToSettings: (category?: string) => void
    /** The guided setup, for an editor: "Set up with a guide", or "Continue setup". */
    setup?: { label: string; onStart: () => void }
}) {
    const [filter, setFilter] = useState<GraphInventoryFilter>({})
    const qc = useQueryClient()
    // Not read again over staged changes, as on Settings: once read, the figures wait for the save or the discard.
    const summary = useGraphsSummary(staged === 0 || qc.getQueryData(settingsKeys.summary()) === undefined)
    const reduced = useReducedMotion()
    const categories = useMemo(() => [...schema.categories].sort((a, b) => a.order - b.order), [schema.categories])
    const reads = categories.find((c) => c.id === 'reads')
    const switchStates = categories.filter((c) => c.masterSwitch).flatMap((c) => {
        const on = switches.on(c.masterSwitch!)
        const name = switches.definition(c.masterSwitch!)?.name
        return on === undefined || !name ? [] : [{ key: c.masterSwitch!, name, on }]
    })
    const showFilter = (f: GraphInventoryFilter) => {
        setFilter(f)
        requestAnimationFrame(() => document.getElementById('inventory-title')?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' }))
    }

    // What needs attention, from what this page reads anyway.
    const definitions = schema.signals ?? CATALOGUE.signals
    const items: AttentionItem[] = useMemo(() => needsAttention({
        summary: summary.data, signals, definitions, settings: schema.settings, values, staged, problems,
    }), [summary.data, signals, definitions, schema.settings, values, staged, problems])
    const checking = summary.isPending || (values === undefined && !valuesFailed) || signalsPending
    const gaps = [
        summary.isError && !summary.data ? 'The fleet’s figures couldn’t be read, so failing graphs and graphs waiting for room can’t be listed.' : null,
        signalsUnavailable ? 'How often problems happened can’t be counted right now, so none of them is listed.' : null,
        valuesFailed ? 'The platform’s settings couldn’t be read, so none of them is checked.' : null,
    ].filter((g): g is string => g !== null)
    const standing: Standing = checking ? { state: 'checking' }
        : items.length ? { state: 'some', count: items.length, failing: items.some((a) => a.kind === 'failing') }
            : gaps.length ? { state: 'unsure' } : { state: 'none' }
    const showAttention = () => {
        const title = document.getElementById(ATTENTION_TITLE)
        title?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
        title?.focus({ preventScroll: true })
    }

    const byKey = useMemo(() => Object.fromEntries(schema.settings.map((s) => [s.key, s])), [schema.settings])
    const featureNames = useMemo(() => ({ ...FEATURE_NAMES, ...switches.names }), [switches.names])
    const fix = (f: WhyFix) => {
        // As a row's fix does: a switch asks first (the page's confirmations); a setting is staged, never saved.
        if (f.feature) switches.request(f.feature, f.to !== false)
        else if (f.setting) onStage(f.setting, f.to)
    }

    // "See what to change": the finder, opened afresh at that problem (a new key), then brought into view.
    const [finderAt, setFinderAt] = useState<{ symptom: string; n: number } | null>(null)
    const finderBox = useRef<HTMLDivElement>(null)
    const seeWhatToChange = (symptom: string) => {
        setFinderAt((at) => ({ symptom, n: (at?.n ?? 0) + 1 }))
        requestAnimationFrame(() => {
            const box = finderBox.current
            box?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' })
            // The problem it opened at; its search, if that problem has no chip of its own.
            const at = box?.querySelector<HTMLElement>('[aria-pressed="true"]') ?? box?.querySelector<HTMLElement>('input')
            at?.focus({ preventScroll: true })
        })
    }

    return (
        <div className="flex flex-col gap-10">
            <Hero summary={summary} readsPosture={reads?.posture} standing={standing} onShowAttention={showAttention} switches={switchStates}
                actions={(
                    <>
                        {setup && (
                            // The page's first step: filled, in the app's indigo-to-violet.
                            <Button variant="primary" leftIcon={Route} onClick={setup.onStart}
                                className="bg-indigo-600 bg-gradient-to-r from-indigo-600 to-violet-600 shadow-indigo-600/25">
                                {setup.label}
                            </Button>
                        )}
                        {/* Beside the guide, the second way in; alone (a viewer who may only read), the page's one. Its edge a
                            divider's: the plain glass edge is white, invisible on the card. */}
                        <Button variant={setup ? 'secondary' : 'primary'} rightIcon={ArrowRight} onClick={() => onGoToSettings()}
                            className={setup ? 'border-glass-border/80' : 'bg-indigo-600 hover:bg-indigo-700 hover:brightness-100'}>
                            Review the settings
                        </Button>
                    </>
                )} />

            <NeedsAttention items={items} checking={checking} gaps={gaps} signalsCounted={signals !== undefined} readOnly={readOnly}
                fixLabel={(f) => describeFix(f, { settings: byKey, featureNames })}
                memory={categories.find((c) => c.id === 'residency')}
                titleId={ATTENTION_TITLE}
                on={{
                    showGraphs: (which) => showFilter(SHOW[which]),
                    goToCategory: onGoToSettings,
                    seeWhatToChange,
                    showSetting: onShowSetting,
                    fix,
                    review: onReview,
                }} />

            <Figures q={summary} onFilter={showFilter} />

            <Postures categories={categories.filter((c) => c.id !== 'reads')} onGoToSettings={onGoToSettings} />

            {values && (
                <div ref={finderBox} className="scroll-mt-6">
                    <SymptomFinder key={finderAt?.n ?? 0} initialSymptom={finderAt?.symptom}
                        settings={schema.settings.filter((s) => values[s.key])} values={values}
                        onStage={(k: string, v: SettingValue) => onStage(k, v)} onShow={onShowSetting} {...(signals ? { signals } : {})}
                        signalsUnavailable={signalsUnavailable} signalDefinitions={definitions} />
                </div>
            )}

            <GraphInventory filter={filter} onFilter={setFilter} onOpenSettings={onOpenSettings} providers={providers} />
        </div>
    )
}
