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
 */
import { AlertTriangle, ArrowRight, Info, Sparkles, TrendingUp } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Insight } from '@/services/analyticsService'

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
    if (!insights.length) return null

    return (
        <section aria-label="What changed" className={cn('mb-6', className)}>
            <div className="flex items-baseline justify-between mb-3">
                <h2 className="text-sm font-bold text-ink">What changed</h2>
                <p className="text-[11px] text-ink-muted">
                    Ranked by significance · {rangeLabel.toLowerCase()}
                </p>
            </div>

            <div className="grid gap-2 md:grid-cols-2 wide:grid-cols-3">
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
