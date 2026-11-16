/**
 * Overview — the platform's versioned graphs at a glance.
 *
 *   posture     one sentence from the live figures and the read mode in force, the switches, then
 *               each category's posture as the server writes it, each a link to its settings
 *   figures     graphs; in memory, unloaded, loading, waiting for room and with no copy yet (the five
 *               add up to the graphs); building; failing; with settings of their own — each defined,
 *               as of when it was read, and a filter of the list below. A figure that couldn't be
 *               read is "—" with why, never 0. On a phone the figures come first, two to a row.
 *   finder      "Something's wrong?", with what happened in the last day where the server counts it
 *   inventory   every graph, its settings a click away
 */
import { useState, type ReactNode } from 'react'
import { useReducedMotion } from 'framer-motion'
import { ArrowRight, Info, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatCount } from '@/lib/units'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { DateTime } from '@/components/ui/DateTime'
import { HoverTip } from '@/components/ui/HoverTip'
import { Skeleton } from '@/components/ui/Skeleton'
import { SymptomFinder, type ResolvedValues, type SettingValue } from '@/components/settings'
import type { GraphProvider, VersionedGraphRow } from '@/services/systemStatusService'
import {
    settingsError, useGraphsSummary, type GraphInventoryFilter, type GraphsSummary, type ServedSchema, type SignalCount,
} from '@/services/settingsService'
import { CategoryIcon } from './CategorySection'
import { GraphInventory } from './GraphInventory'
import type { FeatureSwitches } from './useFeatureSwitches'

const plural = (n: number, one: string, many = `${one}s`) => `${formatCount(n)} ${n === 1 ? one : many}`

/** A link's colour that reads at AA on this page's surfaces, in both themes. */
const LINK = 'text-indigo-700 dark:text-indigo-300'

const MEMORY: Array<{ id: keyof GraphsSummary; label: string; words: string; dot: string; filter?: GraphInventoryFilter }> = [
    { id: 'inMemory', label: 'In memory', words: 'in memory', dot: 'bg-emerald-500' },
    { id: 'unloaded', label: 'Unloaded', words: 'unloaded', dot: 'bg-slate-400 dark:bg-slate-500', filter: { status: 'evicted' } },
    { id: 'loading', label: 'Loading', words: 'loading', dot: 'bg-sky-500', filter: { status: 'rehydrating' } },
    { id: 'waitingForRoom', label: 'Waiting for room', words: 'waiting for room', dot: 'bg-amber-500', filter: { status: 'waiting_capacity' } },
    { id: 'noCopy', label: 'No copy yet', words: 'with no copy yet', dot: 'bg-slate-200 ring-1 ring-inset ring-slate-400 dark:bg-slate-800 dark:ring-slate-500' },
]

/** The lead sentence: the fleet in figures (when they could be read), then what readers get. */
function postureSentence(summary: GraphsSummary | undefined, readsPosture: string | undefined): string {
    const parts: string[] = []
    if (summary) {
        const where = MEMORY.filter((m) => m.id === 'inMemory' || summary[m.id])
            .map((m) => `${formatCount(summary[m.id] as number)} ${m.words}`)
        parts.push(`${plural(summary.graphs, 'versioned graph')}${summary.graphs ? `: ${where.join(', ')}` : ''}.`)
    }
    if (readsPosture) parts.push(readsPosture)
    return parts.join(' ')
}

interface Figure {
    id: string
    label: string
    value: (s: GraphsSummary) => number
    definition: string
    filter?: GraphInventoryFilter
    /** Worth a look when above zero. */
    alarm?: boolean
}

const FIGURES: Figure[] = [
    { id: 'graphs', label: 'Versioned graphs', value: (s) => s.graphs, definition: 'Live versioned graphs on the platform. A fork isn’t counted: it follows the graph it was forked from.', filter: {} },
    { id: 'building', label: 'Building a new version', value: (s) => s.building, definition: 'Graphs whose next version is being built in a second copy while readers keep the current one.', filter: { status: 'building' } },
    { id: 'failing', label: 'Failing', value: (s) => s.failing, definition: 'Graphs whose last update failed. The list below says why for each.', filter: { status: 'failed' }, alarm: true },
    { id: 'own', label: 'With settings of their own', value: (s) => s.withOwnSettings, definition: 'Graphs that chose at least one setting for themselves instead of following their workspace and the platform.', filter: { ownSettings: true } },
]

function Definition({ label, text }: { label: string; text: string }) {
    return (
        <HoverTip label={text} width="data" className="inline-flex">
            <button type="button" aria-label={`What “${label}” counts`} className="grid place-items-center w-5 h-5 rounded text-ink-secondary outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                <Info aria-hidden className="w-3.5 h-3.5" />
            </button>
        </HoverTip>
    )
}

function Tile({ label, definition, children, onClick, action, className }: {
    label: string
    definition: string
    children: ReactNode
    onClick?: () => void
    action?: string
    className?: string
}) {
    return (
        <Card padding="md" className={cn('flex min-w-0 flex-col gap-1', className)}>
            <div className="flex items-start gap-1">
                <p className="min-w-0 text-[12.5px] font-medium text-ink-secondary">{label}</p>
                <Definition label={label} text={definition} />
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

function Figures({ onFilter }: { onFilter: (f: GraphInventoryFilter) => void }) {
    const q = useGraphsSummary()
    const s = q.data
    const failed = q.error ? settingsError(q.error).message : null
    const asOf = q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString() : null
    const value = (n: number | undefined, alarm = false) => (
        n === undefined
            ? <p className="text-3xl font-semibold tracking-tight text-ink-secondary" aria-label="Not known">—</p>
            : <p className={cn('text-3xl font-semibold tracking-tight', alarm && n > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-ink')}>{formatCount(n)}</p>
    )
    const total = s ? MEMORY.reduce((n, m) => n + ((s[m.id] as number | undefined) ?? 0), 0) : 0

    return (
        <section aria-labelledby="figures-title" className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 id="figures-title" className="text-[13px] font-semibold text-ink">The fleet now</h2>
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
                    <Tile label="In memory" definition="Graphs loaded in the graph store, of those that aren’t forks. The rest are unloaded (their next read comes from the database and loads them), being loaded, waiting for room on their node, or have no copy in the graph store yet: together, every graph.">
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
                                                    <button type="button" onClick={() => onFilter(m.filter!)} title={`Show the graphs ${m.words}`}
                                                        className="inline-flex items-start gap-1.5 rounded text-left underline-offset-2 outline-none hover:text-ink hover:underline focus-visible:ring-2 focus-visible:ring-accent-lineage/40">
                                                        {words}
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

export function Overview({ schema, values, switches, signals, signalsUnavailable, providers, onShowSetting, onStage, onOpenSettings, onGoToSettings }: {
    schema: ServedSchema
    /** The platform's values, for the finder; absent while they load. */
    values: ResolvedValues | undefined
    switches: FeatureSwitches
    signals?: SignalCount[]
    /** The server couldn't count the signals: the finder says so. */
    signalsUnavailable?: boolean
    providers: GraphProvider[]
    /** Opens Settings at a setting. */
    onShowSetting: (key: string) => void
    /** Stages a value on the platform (and shows it in Settings). */
    onStage: (key: string, value: SettingValue) => void
    onOpenSettings: (row: VersionedGraphRow) => void
    /** Opens Settings at a category. */
    onGoToSettings: (category?: string) => void
}) {
    const [filter, setFilter] = useState<GraphInventoryFilter>({})
    const summary = useGraphsSummary()
    const reduced = useReducedMotion()
    const categories = [...schema.categories].sort((a, b) => a.order - b.order)
    const reads = categories.find((c) => c.id === 'reads')
    const switchWords = categories.filter((c) => c.masterSwitch).flatMap((c) => {
        const on = switches.on(c.masterSwitch!)
        const name = switches.definition(c.masterSwitch!)?.name
        return on === undefined || !name ? [] : [`${name}: ${on ? 'on' : 'off'}`]
    })
    const showFilter = (f: GraphInventoryFilter) => {
        setFilter(f)
        requestAnimationFrame(() => document.getElementById('inventory-title')?.scrollIntoView({ block: 'start', behavior: reduced ? 'auto' : 'smooth' }))
    }

    return (
        // On a phone the figures lead: the postures that come first on a wide screen run to screens there.
        <div className="flex flex-col gap-10">
            <section aria-labelledby="posture-title" className="rounded-3xl border border-glass-border/50 bg-gradient-to-br from-accent-lineage/[0.06] via-canvas-elevated to-canvas-elevated px-5 py-6 sm:px-8 sm:py-7">
                <h2 id="posture-title" className="text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-secondary">Where things stand</h2>
                <p className="mt-2 max-w-4xl text-lg font-medium leading-relaxed tracking-tight text-ink sm:text-xl">
                    {postureSentence(summary.data, reads?.posture)}
                </p>
                {switchWords.length > 0 && <p className="mt-2 text-[13px] text-ink-secondary">{switchWords.join(' · ')}</p>}
                <ul className="mt-5 grid gap-x-8 gap-y-3 md:grid-cols-2">
                    {categories.filter((c) => c.id !== 'reads').map((c) => {
                        return (
                            <li key={c.id}>
                                <button type="button" onClick={() => onGoToSettings(c.id)}
                                    className="group flex w-full items-start gap-3 rounded-xl px-2 py-1.5 text-left outline-none hover:bg-black/[0.03] focus-visible:ring-2 focus-visible:ring-accent-lineage/40 dark:hover:bg-white/[0.04]">
                                    <CategoryIcon name={c.icon} className="mt-0.5 w-4 h-4 shrink-0 text-ink-muted" />
                                    <span className="min-w-0">
                                        <span className="block text-[13px] font-semibold text-ink">{c.label}<ArrowRight aria-hidden className="ml-1 inline w-3 h-3 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" /></span>
                                        <span className="block text-[12.5px] leading-relaxed text-ink-secondary">{c.posture}</span>
                                    </span>
                                </button>
                            </li>
                        )
                    })}
                </ul>
                <Button className="mt-5 bg-indigo-600 hover:bg-indigo-700 hover:brightness-100" variant="primary" rightIcon={ArrowRight} onClick={() => onGoToSettings()}>Review the settings</Button>
            </section>

            <div className="order-first sm:order-none">
                <Figures onFilter={showFilter} />
            </div>

            {values && (
                <SymptomFinder settings={schema.settings.filter((s) => values[s.key])} values={values}
                    onStage={(k: string, v: SettingValue) => onStage(k, v)} onShow={onShowSetting} {...(signals ? { signals } : {})}
                    signalsUnavailable={signalsUnavailable} />
            )}

            <GraphInventory filter={filter} onFilter={setFilter} onOpenSettings={onOpenSettings} providers={providers} />
        </div>
    )
}
