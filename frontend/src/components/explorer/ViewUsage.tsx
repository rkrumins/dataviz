/**
 * "Is anyone using this, and how many different people?"
 *
 * The question somebody asks about a view they have never opened, and the one
 * the catalogue could not answer. A name, an owner and a date say nothing
 * about whether a view is load-bearing or abandoned.
 *
 * DISTINCT PEOPLE LEADS, opens follow. 340 opens by one person is somebody's
 * scratchpad; 340 by twelve is something a team relies on. The raw total
 * cannot tell them apart, so it is the second number here, not the first —
 * and "only its author has opened this" gets said outright, because two opens
 * by two people and two opens by the author are both "2".
 *
 * LIFETIME IS IN THE TOOLTIP. It is a fair question and a poor headline: how
 * many times a view has EVER been opened is largely a proxy for how long it
 * has existed, so leading with it would rank the catalogue by age and bury
 * every good new view under whatever was built first.
 *
 * TWO FORMS, because a card has two registers. `ViewUsageCounters` is terse
 * and lives in the footer beside the favourite count, where a number reads as
 * a number. `ViewUsageNote` is a sentence and appears only when there is
 * something about YOU worth interrupting a scan for — which, on most cards,
 * there is not.
 */
import { Eye, Sparkles, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { compact, exact } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewUsage } from '@/services/contentInsightsService'

/** How many people, said as a sentence. */
export function peoplePhrase(usage: ViewUsage): string {
    if (usage.onlyAuthor) return 'Only its author has opened this'
    if (usage.uniqueViewers === 0) {
        return `Nobody has opened this in the last ${usage.windowDays} days`
    }
    return `${exact(usage.uniqueViewers)} `
        + `${usage.uniqueViewers === 1 ? 'person has' : 'different people have'} `
        + `opened this in the last ${usage.windowDays} days`
}

/** What is true BEYOND the window — lifetime, and when it was last touched.
 *  Split out because the details panel prints the window figure in its first
 *  line and must not say it twice. */
export function opensTail(usage: ViewUsage): string {
    return [
        usage.lifetimeOpens > usage.opens
            ? `${exact(usage.lifetimeOpens)} opens all time`
            : null,
        usage.lastOpenedAt ? `last opened ${timeAgo(usage.lastOpenedAt)}` : null,
    ].filter(Boolean).join(' · ')
}

/** How many times, said as a sentence that can stand alone — which the eye
 *  icon's tooltip needs, since nothing else is on screen to complete it. */
export function opensPhrase(usage: ViewUsage): string {
    const window = usage.opens === 0
        ? `Not opened in the last ${usage.windowDays} days`
        : `Opened ${exact(usage.opens)} ${usage.opens === 1 ? 'time' : 'times'} `
          + `in the last ${usage.windowDays} days`
    return [window, opensTail(usage)].filter(Boolean).join(' · ')
}

/** The personal note, or null when there is nothing worth adding. */
function personalNote(usage: ViewUsage): string | null {
    // Others use it and you never have. The most useful thing this component
    // can tell somebody, because it is the case they cannot see for themselves.
    if (usage.yourOpens === 0 && !usage.yourLastOpenedAt && usage.uniqueViewers > 0) {
        return 'New to you'
    }
    if (usage.yourOpens > 0) {
        return usage.yourOpens === 1
            ? 'You opened it once'
            : `You opened it ${exact(usage.yourOpens)} times`
    }
    // Opened before, but not lately — the reason `yourLastOpenedAt` reaches
    // back past the window.
    if (usage.yourLastOpenedAt) {
        return `You last opened it ${timeAgo(usage.yourLastOpenedAt)}`
    }
    return null
}

/**
 * The footer form: two counters, sitting beside the favourite count.
 *
 * The sentence form said "Not opened in 30 days" on its own line on every
 * card, which on a shelf of mostly-quiet views was the loudest text on the
 * page — a repeated non-event out-shouting the names. Beside a `♡ 0` the same
 * fact reads as a counter rather than an announcement, and "0 opens" stops
 * looking like a broken widget because the terse row around it sets the
 * register.
 *
 * The full sentence survives in the tooltip, where somebody who wants it can
 * find it and nobody else has to read it.
 */
export function ViewUsageCounters({ usage, className }: {
    usage: ViewUsage | undefined
    className?: string
}) {
    if (!usage) return null

    const note = personalNote(usage)
    return (
        <span className={cn('inline-flex items-center gap-2 text-[11px] font-medium text-ink-muted', className)}>
            {/* A tip PER ICON, not one for the pair. A row of small glyphs with
                a single shared description leaves somebody hovering the wrong
                half of it and learning nothing — and `0 0` explains itself to
                nobody. `HoverTip` rather than `title`: the native one waits a
                second, renders in OS chrome, and on a card that swaps in hover
                controls it frequently never appears at all. */}
            <HoverTip label={[peoplePhrase(usage), note].filter(Boolean).join(' · ')}>
                <span className="inline-flex items-center gap-1">
                    {/* People first even here: it is the number that says
                        whether a view is load-bearing. */}
                    <Users className="h-3 w-3" aria-hidden />
                    {compact(usage.uniqueViewers)}
                    <span className="sr-only">{peoplePhrase(usage)}</span>
                </span>
            </HoverTip>
            <HoverTip label={opensPhrase(usage)}>
                <span className="inline-flex items-center gap-1">
                    <Eye className="h-3 w-3" aria-hidden />
                    {compact(usage.opens)}
                    <span className="sr-only">{opensPhrase(usage)}</span>
                </span>
            </HoverTip>
        </span>
    )
}

/**
 * The chip form: shown only when there is something notable to say about YOU.
 *
 * Kept out of the footer because it is a sentence, not a counter, and because
 * it is the one thing here that is worth interrupting a scan for — a view your
 * colleagues rely on and you have never opened is a fact you cannot get any
 * other way. Most cards show nothing.
 */
export function ViewUsageNote({ usage, className }: {
    usage: ViewUsage | undefined
    className?: string
}) {
    if (!usage) return null
    // Only the discovery case earns a chip. "You opened it 4 times" is true,
    // unsurprising, and already in the footer tooltip.
    if (usage.yourOpens > 0 || usage.yourLastOpenedAt) return null
    if (usage.uniqueViewers === 0 || usage.onlyAuthor) return null

    return (
        <span className={cn(
            'inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-600 dark:text-indigo-400',
            className,
        )}>
            <Sparkles className="h-2.5 w-2.5" aria-hidden />
            New to you
        </span>
    )
}

/**
 * The details form: the whole picture, where there is room for it.
 *
 * The counters answer "is this used" in three characters. Somebody who opened
 * the details panel is asking the longer version — how many people, how often,
 * when last, and whether they themselves have ever been here — so this says
 * all of it in words rather than making them hover four separate glyphs.
 */
export function ViewUsageDetails({ usage }: { usage: ViewUsage | undefined }) {
    if (!usage) return null

    const note = personalNote(usage)
    // The first line already says nobody has opened it, so the second must not
    // repeat it — a panel that tells you the same fact twice reads as filler
    // and teaches people to skim past the part that is not.
    const secondary = usage.opens === 0 ? opensTail(usage) : opensPhrase(usage)
    return (
        <div className="space-y-1">
            <p className="text-sm font-medium text-ink">{peoplePhrase(usage)}</p>
            {secondary && <p className="text-xs text-ink-muted">{secondary}</p>}
            {note && (
                <p className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
                    {note}
                </p>
            )}
        </div>
    )
}
