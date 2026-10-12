/**
 * "Is this workspace alive, and what do people come here for?"
 *
 * Two facts, because they answer different halves of one question. A name, a
 * member count and a data-source list say what a workspace CONTAINS; none of
 * them say whether anybody has been here this month, and the second is the
 * part that decides whether it is worth opening.
 *
 * The top view is the more useful half. "12 people · 340 opens" tells you the
 * place is busy; "mostly: Revenue lineage" tells you what it is FOR, which is
 * the thing a stranger to the workspace cannot get any other way.
 *
 * Counts follow the content, so this covers only the views the reader may
 * read. Two people can therefore see different totals for one workspace —
 * that is the access rule showing through, and the alternative would quote a
 * figure that includes content the reader is not allowed to know exists.
 */
import { Link } from 'react-router-dom'
import { Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact } from '@/lib/formatMetric'
import type { WorkspaceUsage } from '@/services/contentInsightsService'

export function WorkspaceUsageLine({ usage, className }: {
    usage: WorkspaceUsage | undefined
    className?: string
}) {
    // Nothing to show is not the same as nothing to say — but a workspace with
    // no readable views at all has genuinely nothing here, and inventing a
    // "0 opens" for it would read as a broken counter rather than an answer.
    if (!usage || usage.views === 0) return null

    if (usage.opens === 0) {
        return (
            <p
                className={cn('text-[11px] font-medium text-ink-muted', className)}
                title={`None of the ${exact(usage.views)} views here were opened in the last ${usage.windowDays} days.`}
            >
                Quiet — nothing opened in {usage.windowDays} days
            </p>
        )
    }

    return (
        <div className={cn('flex flex-wrap items-center gap-x-2 gap-y-0.5', className)}>
            <span
                className="inline-flex items-center gap-1 text-[11px] font-semibold text-ink-secondary"
                title={`${exact(usage.opens)} opens by ${exact(usage.uniqueViewers)} `
                    + `${usage.uniqueViewers === 1 ? 'person' : 'people'} across `
                    + `${exact(usage.views)} views in the last ${usage.windowDays} days`}
            >
                <Users className="h-3 w-3 shrink-0" aria-hidden />
                {compact(usage.uniqueViewers)}
                {usage.uniqueViewers === 1 ? ' person' : ' people'}
                <span className="font-medium text-ink-muted">
                    · {compact(usage.opens)} opens
                </span>
            </span>

            {usage.topView && (
                <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-ink-muted">
                    mostly
                    {/* A link, because the answer to "what is this workspace
                        for" should be one click from the question. */}
                    <Link
                        to={`/views/${usage.topView.viewId}`}
                        onClick={(e) => e.stopPropagation()}
                        className="truncate font-medium text-indigo-600 hover:underline dark:text-indigo-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
                        title={`${usage.topView.name} — ${exact(usage.topView.opens)} opens`}
                    >
                        {usage.topView.name}
                    </Link>
                </span>
            )}
        </div>
    )
}
