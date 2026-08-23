/**
 * InsightStrip — "what changed", stated in sentences.
 *
 * A dashboard's failure mode is a wall of correct charts that nobody reads.
 * This does the first pass of interpretation a reader would otherwise do by
 * eye: what moved, by how much, and whether it is good news.
 *
 * The rules live on the SERVER (``analytics_repo._narrative``) and run over the
 * finished summary document, so an observation here can never contradict the
 * chart beneath it. This component only renders them.
 *
 * It renders NOTHING when there are no insights. A young install has nothing
 * to say, and a strip that manufactures five findings from three users teaches
 * people to ignore it — which costs more than showing nothing at all.
 *
 * It COLLAPSES, and remembers that it was collapsed. A reader who visits daily
 * has read these by the third day and wants the charts higher up the page; one
 * who visits monthly wants them open. Neither should have to keep saying so.
 *
 * Collapsing must not cost the signal, so the collapsed header carries the
 * tally by tone AND the single most significant headline. A disclosure that
 * hides "three things need attention" behind the word "expand" is how a
 * dashboard ends up with an unread alarm on it.
 */
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import {
    AlertTriangle, ArrowRight, ArrowUpRight, ChevronDown, Info,
    Sparkles, TrendingUp, Undo2, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Sparkline } from '@/components/ui/Sparkline'
import { checkNavPermission, usePermissionClaims } from '@/store/auth'
import type { Insight } from '@/services/analyticsService'
import { INSIGHT_TARGETS, revealChart } from './insightTargets'

/** Per-browser, like the other view preferences in this app: which sections a
 *  person keeps folded is a navigation convenience, not account data. */
const STORAGE_KEY = 'nexus.analytics.whatChanged.collapsed'

function readCollapsed(): boolean {
    if (typeof window === 'undefined') return false
    try {
        return window.localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
        // Private windows and blocked site-data throw on read. Open is the
        // right default: it is the state that shows the reader everything.
        return false
    }
}

function writeCollapsed(collapsed: boolean) {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
        // Ignore — the preference degrades to per-session.
    }
}

const DISMISSED_KEY = 'nexus.analytics.whatChanged.dismissed'

/**
 * A dismissal is keyed by the key AND the headline, so it lapses the moment
 * the finding changes.
 *
 * "7 access requests pending" dismissed on Monday should NOT keep "23 access
 * requests pending" quiet on Friday. Keying on the sentence means a finding
 * whose numbers move comes back on its own, without anyone having to remember
 * to un-dismiss it.
 */
function dismissalId(insight: Insight): string {
    return `${insight.key}::${insight.headline}`
}

function readDismissed(): string[] {
    if (typeof window === 'undefined') return []
    try {
        const parsed = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]')
        return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : []
    } catch {
        return []
    }
}

function writeDismissed(ids: string[]) {
    if (typeof window === 'undefined') return
    try {
        // Bounded: headlines change as the numbers do, so without a cap this
        // list would grow one entry per distinct sentence, forever.
        window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)))
    } catch {
        // Ignore.
    }
}

/**
 * Tone → colour, icon, and what it means.
 *
 * These are STATUS colours, deliberately drawn from the app's semantic accents
 * rather than the categorical chart palette. An insight is a judgement about
 * state (good / needs attention / wrong), never a series identity, and reusing
 * a series hue here would make "slot 4" and "this is fine" the same colour.
 *
 * Every tone ships an icon as well as a colour, so the judgement survives
 * greyscale, colour-blindness and forced-colors mode.
 */
const TONES = {
    good: {
        icon: TrendingUp,
        chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        rule: 'bg-emerald-500',
        label: 'Good news',
    },
    watch: {
        icon: Info,
        chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        rule: 'bg-amber-500',
        label: 'Worth watching',
    },
    bad: {
        icon: AlertTriangle,
        chip: 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20',
        rule: 'bg-rose-500',
        label: 'Needs attention',
    },
    neutral: {
        icon: Sparkles,
        chip: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
        rule: 'bg-indigo-500',
        label: 'Context',
    },
} as const

type ToneKey = keyof typeof TONES

/** Tally order: worst first. Fixed, so the chips do not move between renders. */
const TALLY_ORDER: readonly ToneKey[] = ['bad', 'watch', 'good', 'neutral']

export function InsightStrip({
    insights, rangeLabel, onNavigate, className,
}: {
    insights: Insight[]
    /** Names the slice these observations were drawn from. */
    rangeLabel: string
    /** Jump to the tab that explains an insight in depth. */
    onNavigate?: (tab: string) => void
    className?: string
}) {
    const [collapsed, setCollapsed] = useState(readCollapsed)
    const [dismissed, setDismissed] = useState<string[]>(readDismissed)
    const [showDismissed, setShowDismissed] = useState(false)
    const [toneFilter, setToneFilter] = useState<ToneKey | null>(null)
    const claims = usePermissionClaims()

    // Follow the preference when another tab changes it — two Analytics tabs
    // disagreeing about their own chrome is a small thing that reads as a bug.
    useEffect(() => {
        const sync = (e: StorageEvent) => {
            if (e.key === STORAGE_KEY) setCollapsed(readCollapsed())
            if (e.key === DISMISSED_KEY) setDismissed(readDismissed())
        }
        window.addEventListener('storage', sync)
        return () => window.removeEventListener('storage', sync)
    }, [])

    if (!insights.length) return null

    const isDismissed = (i: Insight) => dismissed.includes(dismissalId(i))
    const live = insights.filter((i) => !isDismissed(i))
    const hidden = insights.filter(isDismissed)

    // Worst first, and always in this order — a tally that reshuffled as the
    // numbers moved would be unscannable. Severity leads because the reason to
    // glance at a folded strip is to find out whether anything is on fire.
    //
    // Counted over what is actually SHOWING. A tally that kept counting things
    // the reader has cleared would be a number they cannot reconcile with the
    // cards in front of them.
    const tally = TALLY_ORDER
        .map((key) => ({ key, tone: TONES[key], count: live.filter((i) => i.tone === key).length }))
        .filter((t) => t.count > 0)

    const shown = toneFilter ? live.filter((i) => i.tone === toneFilter) : live

    // The server ranks by significance, so the first one is the one to lead
    // with when there is only room for one.
    const lead = live[0] ?? insights[0]
    const panelId = 'what-changed-panel'

    const toggle = () => {
        const next = !collapsed
        setCollapsed(next)
        writeCollapsed(next)
    }

    const setDismissal = (insight: Insight, gone: boolean) => {
        const id = dismissalId(insight)
        const next = gone
            ? [...dismissed.filter((d) => d !== id), id]
            : dismissed.filter((d) => d !== id)
        setDismissed(next)
        writeDismissed(next)
    }

    const go = (insight: Insight) => {
        const anchor = INSIGHT_TARGETS[insight.key]?.anchor
        if (insight.tab && onNavigate) onNavigate(insight.tab)
        if (anchor) revealChart(anchor)
    }

    return (
        <section aria-label="What changed" className={cn('mb-6', className)}>
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 mb-3">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <button
                        type="button"
                        onClick={toggle}
                        aria-expanded={!collapsed}
                        aria-controls={panelId}
                        className="group flex min-w-0 items-center gap-2 rounded-lg py-0.5 pr-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    >
                        <ChevronDown
                            aria-hidden
                            className={cn(
                                'h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform',
                                collapsed && '-rotate-90',
                            )}
                        />
                        <h2 className="shrink-0 text-sm font-bold text-ink">What changed</h2>

                        {/* Folded, the tally is a SUMMARY and rides inside the
                            disclosure — filtering a list nobody can see would
                            be a control with nothing to control, and a button
                            inside a button is not markup at all. Unfolded, the
                            same chips become the filter below. */}
                        {collapsed && (
                            <>
                                <span className="flex shrink-0 items-center gap-1" aria-hidden>
                                    {tally.map(({ key, tone, count }) => (
                                        <span
                                            key={key}
                                            className={cn(
                                                'inline-flex items-center gap-0.5 rounded-md border px-1.5 py-0.5 text-[10px] font-bold',
                                                tone.chip,
                                            )}
                                        >
                                            <tone.icon className="h-2.5 w-2.5" />
                                            {count}
                                        </span>
                                    ))}
                                </span>
                                <span className="sr-only">
                                    {tally.map(({ tone, count }) => `${count} ${tone.label.toLowerCase()}`).join(', ')}
                                </span>
                                {/* Folded away, the most significant finding
                                    still reads. Hiding "three things need
                                    attention" behind the word "expand" is how a
                                    dashboard grows an unread alarm. */}
                                <span className="truncate text-[11px] text-ink-muted">
                                    · {lead.headline}
                                </span>
                            </>
                        )}
                    </button>

                    {/* Unfolded, each chip filters to its tone. Clicking the
                        live one clears it, so the control is its own undo. */}
                    {!collapsed && tally.map(({ key, tone, count }) => {
                        const on = toneFilter === key
                        return (
                            <button
                                key={key}
                                type="button"
                                aria-pressed={on}
                                onClick={() => setToneFilter(on ? null : key)}
                                title={`Show only: ${tone.label.toLowerCase()}`}
                                className={cn(
                                    'inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold transition-all outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                    tone.chip,
                                    on ? 'ring-1 ring-current' : 'opacity-80 hover:opacity-100',
                                )}
                            >
                                <tone.icon className="h-2.5 w-2.5" aria-hidden />
                                {count}
                                <span className="sr-only">{tone.label}</span>
                            </button>
                        )
                    })}
                </div>

                <p className="shrink-0 text-[11px] text-ink-muted">
                    {toneFilter
                        ? `Filtered · ${TONES[toneFilter].label.toLowerCase()}`
                        : `Ranked by significance · ${rangeLabel.toLowerCase()}`}
                </p>
            </div>

            {/* Both the attribute and the class, and neither is redundant.
                The ATTRIBUTE is the semantics — it is what a screen reader and
                a stylesheet-less render honour. The CLASS is what actually
                wins in the browser: `[hidden]` is `display: none` from the UA
                sheet, which any display class on the element outranks, so
                leaving `grid` on it would have shown the cards with the
                attribute set. That was the first cut of this, and it looked
                exactly like a collapse that did nothing. */}
            <div
                id={panelId}
                hidden={collapsed}
                className={cn(
                    'gap-2 md:grid-cols-2 wide:grid-cols-3',
                    collapsed ? 'hidden' : 'grid',
                )}
            >
                {shown.map((insight) => (
                    <InsightCard
                        key={insight.key}
                        insight={insight}
                        claims={claims}
                        canNavigate={!!(insight.tab && onNavigate) || !!INSIGHT_TARGETS[insight.key]?.anchor}
                        onOpen={() => go(insight)}
                        onDismiss={() => setDismissal(insight, true)}
                    />
                ))}
            </div>

            {/* Cleared findings are COUNTED, never vanished. An alarm you
                silenced and can no longer find is worse than one you never
                silenced, and this is also the only way back. */}
            {!collapsed && hidden.length > 0 && (
                <div className="mt-2">
                    <button
                        type="button"
                        onClick={() => setShowDismissed((v) => !v)}
                        aria-expanded={showDismissed}
                        className="text-[11px] font-medium text-ink-muted hover:text-ink outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                    >
                        {hidden.length} cleared · {showDismissed ? 'hide' : 'show'}
                    </button>

                    {showDismissed && (
                        <ul className="mt-1.5 flex flex-col gap-1">
                            {hidden.map((insight) => (
                                <li
                                    key={insight.key}
                                    className="flex items-center gap-2 rounded-lg border border-glass-border bg-canvas-elevated px-3 py-1.5"
                                >
                                    <span className="min-w-0 flex-1 truncate text-[11px] text-ink-muted">
                                        {insight.headline}
                                    </span>
                                    <button
                                        type="button"
                                        onClick={() => setDismissal(insight, false)}
                                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                                    >
                                        <Undo2 className="h-3 w-3" aria-hidden />
                                        Restore
                                        <span className="sr-only">: {insight.headline}</span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </section>
    )
}

/**
 * One finding.
 *
 * The card is a DIV, not a button. It carries a dismiss control and often an
 * action link, and a button inside a button is not markup — it is a guess
 * about what the browser will do. The headline is the button, stretched over
 * the card with `after:inset-0` so the whole surface still opens the chart,
 * and the controls sit above it on their own stacking layer.
 */
function InsightCard({
    insight, claims, canNavigate, onOpen, onDismiss,
}: {
    insight: Insight
    claims: ReturnType<typeof usePermissionClaims>
    canNavigate: boolean
    onOpen: () => void
    onDismiss: () => void
}) {
    const tone = TONES[insight.tone] ?? TONES.neutral
    const Icon = tone.icon
    const target = INSIGHT_TARGETS[insight.key]
    // An action the reader cannot reach is worse than none: a door that turns
    // you away reads as a broken product rather than as a scoped one.
    const action = target?.action && checkNavPermission(claims, target.action.requires)
        ? target.action
        : null
    const spark = insight.spark && insight.spark.length >= 3
        && insight.spark.some((v) => v !== 0)
        ? insight.spark
        : null

    return (
        <div
            className={cn(
                'group relative flex gap-3 overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-3.5 text-left shadow-sm transition-all',
                canNavigate && 'hover:border-indigo-500/30 hover:shadow-md',
            )}
        >
            {/* A hairline of tone colour, not a tinted card. Large saturated
                blocks read loud at this density; a rule carries the same
                signal. */}
            <span aria-hidden className={cn('absolute inset-y-0 left-0 w-[3px]', tone.rule)} />

            <span
                className={cn(
                    'ml-1 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                    tone.chip,
                )}
            >
                <Icon className="h-3.5 w-3.5" />
            </span>

            <div className="min-w-0 flex-1">
                <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                        {/* The tone is named, not just coloured — identity is
                            never colour alone. */}
                        <span className="sr-only">{tone.label}: </span>
                        {canNavigate ? (
                            <button
                                type="button"
                                onClick={onOpen}
                                className="block text-left text-[13px] font-bold leading-snug text-ink outline-none after:absolute after:inset-0 after:rounded-xl focus-visible:after:ring-2 focus-visible:after:ring-indigo-500/50"
                            >
                                {insight.headline}
                            </button>
                        ) : (
                            <span className="block text-[13px] font-bold leading-snug text-ink">
                                {insight.headline}
                            </span>
                        )}
                        <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">
                            {insight.detail}
                        </span>
                    </div>

                    {/* The shape behind the claim. "Up 35%" is a summary of a
                        line, and steady growth, one spike and a late collapse
                        all produce the same percentage. */}
                    {spark && (
                        <Sparkline
                            points={spark}
                            tone={SPARK_TONES[insight.tone] ?? 'indigo'}
                            label={insight.headline}
                            width={64}
                            height={22}
                            className="relative z-10 mt-0.5 shrink-0"
                        />
                    )}

                    <button
                        type="button"
                        onClick={onDismiss}
                        title="Clear this finding"
                        // Revealed on hover so five X's do not clutter the
                        // strip at rest — but always visible where there IS no
                        // hover, because a control a touch user cannot find is
                        // a control they do not have.
                        className="relative z-10 -mr-1 -mt-1 shrink-0 rounded-md p-1 text-ink-muted opacity-60 transition-opacity hover:bg-black/5 hover:text-ink focus-visible:opacity-100 dark:hover:bg-white/5 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 sm:opacity-0 sm:group-hover:opacity-100"
                    >
                        <X className="h-3 w-3" aria-hidden />
                        <span className="sr-only">Clear: {insight.headline}</span>
                    </button>
                </div>

                <div className="mt-2 flex items-center gap-3">
                    {/* An observation is half a dashboard. This is the other
                        half: the screen where something can be done about it. */}
                    {action && (
                        <Link
                            to={action.href}
                            className="relative z-10 inline-flex items-center gap-1 rounded-md text-[11px] font-semibold text-indigo-600 hover:underline dark:text-indigo-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            {action.label}
                            <ArrowUpRight className="h-3 w-3" aria-hidden />
                        </Link>
                    )}
                    {canNavigate && (
                        <span className="ml-auto inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted transition-colors group-hover:text-indigo-500">
                            {target?.anchor ? 'See the chart' : 'Investigate'}
                            <ArrowRight
                                aria-hidden
                                className="h-3 w-3 transition-transform group-hover:translate-x-0.5"
                            />
                        </span>
                    )}
                </div>
            </div>
        </div>
    )
}

/** Sparkline tone per insight tone — the same judgement the card already makes. */
const SPARK_TONES: Record<string, 'indigo' | 'emerald' | 'amber' | 'red'> = {
    good: 'emerald', watch: 'amber', bad: 'red', neutral: 'indigo',
}
