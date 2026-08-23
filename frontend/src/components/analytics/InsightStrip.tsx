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
import {
    AlertTriangle, ArrowRight, ChevronDown, Info, Sparkles, TrendingUp,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Insight } from '@/services/analyticsService'

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

/** Tally order: worst first. Fixed, so the chips do not move between renders. */
const TALLY_ORDER = ['bad', 'watch', 'good', 'neutral'] as const

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

    // Follow the preference when another tab changes it — two Analytics tabs
    // disagreeing about their own chrome is a small thing that reads as a bug.
    useEffect(() => {
        const sync = (e: StorageEvent) => {
            if (e.key === STORAGE_KEY) setCollapsed(readCollapsed())
        }
        window.addEventListener('storage', sync)
        return () => window.removeEventListener('storage', sync)
    }, [])

    if (!insights.length) return null

    // Worst first, and always in this order — a tally that reshuffled as the
    // numbers moved would be unscannable. Severity leads because the reason to
    // glance at a folded strip is to find out whether anything is on fire.
    const tally = TALLY_ORDER
        .map((key) => ({ key, tone: TONES[key], count: insights.filter((i) => i.tone === key).length }))
        .filter((t) => t.count > 0)

    // The server ranks by significance, so the first one is the one to lead
    // with when there is only room for one.
    const lead = insights[0]
    const panelId = 'what-changed-panel'

    const toggle = () => {
        const next = !collapsed
        setCollapsed(next)
        writeCollapsed(next)
    }

    return (
        <section aria-label="What changed" className={cn('mb-6', className)}>
            <div className="flex items-center justify-between gap-3 mb-3">
                <button
                    type="button"
                    onClick={toggle}
                    aria-expanded={!collapsed}
                    aria-controls={panelId}
                    className="group flex min-w-0 items-center gap-2 rounded-lg py-0.5 pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                >
                    <ChevronDown
                        aria-hidden
                        className={cn(
                            'h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform',
                            collapsed && '-rotate-90',
                        )}
                    />
                    <h2 className="shrink-0 text-sm font-bold text-ink">What changed</h2>

                    {/* The tally rides on the header in BOTH states. Collapsed
                        it is the whole signal; expanded it is a count of what
                        is below, which is what a disclosure ought to say. */}
                    <span className="flex shrink-0 items-center gap-1" aria-hidden>
                        {tally.map(({ key, tone, count }) => (
                            <span
                                key={key}
                                title={`${count} ${tone.label.toLowerCase()}`}
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

                    {/* Folded away, the most significant finding still reads.
                        Hiding "three things need attention" behind the word
                        "expand" is how a dashboard grows an unread alarm. */}
                    {collapsed && (
                        <span className="truncate text-[11px] text-ink-muted">
                            · {lead.headline}
                        </span>
                    )}
                </button>

                <p className="shrink-0 text-[11px] text-ink-muted">
                    Ranked by significance · {rangeLabel.toLowerCase()}
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
                {insights.map((insight) => {
                    const tone = TONES[insight.tone] ?? TONES.neutral
                    const Icon = tone.icon
                    const canNavigate = !!(insight.tab && onNavigate)

                    // A card that goes somewhere is a button; one that doesn't
                    // is a div. Rendering an inert button would promise an
                    // interaction the keyboard then can't deliver.
                    const Tag = canNavigate ? 'button' : 'div'

                    return (
                        <Tag
                            key={insight.key}
                            {...(canNavigate
                                ? {
                                    type: 'button' as const,
                                    onClick: () => onNavigate?.(insight.tab as string),
                                }
                                : {})}
                            className={cn(
                                'group relative flex gap-3 overflow-hidden rounded-xl border border-glass-border bg-canvas-elevated p-3.5 text-left shadow-sm transition-all',
                                canNavigate &&
                                    'hover:border-indigo-500/30 hover:shadow-md outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                            )}
                        >
                            {/* A hairline of tone colour, not a tinted card.
                                Large saturated blocks read loud at this
                                density; a rule carries the same signal. */}
                            <span
                                aria-hidden
                                className={cn(
                                    'absolute inset-y-0 left-0 w-[3px]', tone.rule,
                                )}
                            />

                            <span
                                className={cn(
                                    'ml-1 mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border',
                                    tone.chip,
                                )}
                            >
                                <Icon className="h-3.5 w-3.5" />
                            </span>

                            <span className="min-w-0 flex-1">
                                {/* The tone is named, not just coloured —
                                    identity is never colour alone. */}
                                <span className="sr-only">{tone.label}: </span>
                                <span className="block text-[13px] font-bold leading-snug text-ink">
                                    {insight.headline}
                                </span>
                                <span className="mt-1 block text-[11px] leading-relaxed text-ink-muted">
                                    {insight.detail}
                                </span>
                            </span>

                            {canNavigate && (
                                <ArrowRight
                                    aria-hidden
                                    className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-muted transition-transform group-hover:translate-x-0.5 group-hover:text-indigo-500"
                                />
                            )}
                        </Tag>
                    )
                })}
            </div>
        </section>
    )
}
