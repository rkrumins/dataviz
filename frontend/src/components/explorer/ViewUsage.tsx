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
import { compact, exact } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import type { ViewUsage } from '@/services/contentInsightsService'

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

    const lifetime = usage.lifetimeOpens > usage.opens
        ? `${exact(usage.lifetimeOpens)} opens all time`
        : null
    const note = personalNote(usage)
    const title = [
        usage.onlyAuthor
            ? 'Only its author has opened this'
            : usage.opens
                ? `${exact(usage.opens)} opens by ${exact(usage.uniqueViewers)} `
                  + `${usage.uniqueViewers === 1 ? 'person' : 'people'} in the last ${usage.windowDays} days`
                : `Not opened in the last ${usage.windowDays} days`,
        lifetime,
        usage.lastOpenedAt ? `Last opened ${timeAgo(usage.lastOpenedAt)}` : null,
        note,
    ].filter(Boolean).join(' · ')

    return (
        <span
            className={cn('inline-flex items-center gap-2 text-[11px] font-medium text-ink-muted', className)}
            title={title}
        >
            {/* People first even here: it is the number that says whether a
                view is load-bearing, and it costs the same three characters. */}
            <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden />
                {compact(usage.uniqueViewers)}
                <span className="sr-only">
                    {usage.uniqueViewers === 1 ? 'person' : 'people'} in the last {usage.windowDays} days
                </span>
            </span>
            <span className="inline-flex items-center gap-1">
                <Eye className="h-3 w-3" aria-hidden />
                {compact(usage.opens)}
                <span className="sr-only">opens in the last {usage.windowDays} days</span>
            </span>
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
