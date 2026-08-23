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
 * THE SECOND LINE IS ABOUT YOU, and it is whichever fact is most notable
 * rather than the same field every time. "New to you" on something your
 * colleagues use is worth more than a zero; your own count is worth more than
 * a repeat of the platform's. A card with nothing notable to say says nothing.
 */
import { Eye, Sparkles, UserRound, Users } from 'lucide-react'

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

export function ViewUsageLine({ usage, className }: {
    usage: ViewUsage | undefined
    className?: string
}) {
    if (!usage) return null

    const note = personalNote(usage)
    const lifetime = usage.lifetimeOpens > usage.opens
        ? `${exact(usage.lifetimeOpens)} opens all time`
        : null
    const title = [
        usage.opens
            ? `${exact(usage.opens)} opens by ${exact(usage.uniqueViewers)} `
              + `${usage.uniqueViewers === 1 ? 'person' : 'people'} in the last ${usage.windowDays} days`
            : `Not opened in the last ${usage.windowDays} days`,
        lifetime,
        usage.lastOpenedAt ? `Last opened ${timeAgo(usage.lastOpenedAt)}` : null,
    ].filter(Boolean).join(' · ')

    return (
        <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-1', className)} title={title}>
            {usage.opens === 0 ? (
                // Nothing in the window is a FINDING, not an empty state. "0
                // opens" reads as a broken counter; this reads as an answer.
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                    <Eye className="h-3 w-3 shrink-0" aria-hidden />
                    Not opened in {usage.windowDays} days
                </span>
            ) : usage.onlyAuthor ? (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-ink-muted">
                    <UserRound className="h-3 w-3 shrink-0" aria-hidden />
                    Only its author has opened this
                </span>
            ) : (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-secondary">
                    <Users className="h-3 w-3 shrink-0" aria-hidden />
                    {compact(usage.uniqueViewers)}
                    {usage.uniqueViewers === 1 ? ' person' : ' people'}
                    <span className="font-medium text-ink-muted">
                        · {compact(usage.opens)} opens
                    </span>
                </span>
            )}

            {note && (
                <span className={cn(
                    'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-semibold',
                    note === 'New to you'
                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                        : 'text-ink-muted',
                )}>
                    {note === 'New to you' && <Sparkles className="h-2.5 w-2.5" aria-hidden />}
                    {note}
                </span>
            )}
        </div>
    )
}
