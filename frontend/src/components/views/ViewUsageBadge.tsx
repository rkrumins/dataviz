/**
 * "Is anyone actually using this?" — answered on the view itself.
 *
 * The platform knew this all along and only ever said it on the Analytics
 * dashboard, which the person who built the view has no reason to open and
 * often no permission to. A view that nobody opens is the single most useful
 * thing its author can learn, and it was the one place the number never
 * appeared.
 *
 * Deliberately a BADGE, not a panel. This is a glance on a page whose job is
 * the canvas; anyone who wants the full picture has Activity beside it and the
 * dashboard beyond that. It renders nothing at all while loading or on
 * failure — a usage figure is not worth a spinner, and certainly not worth an
 * error state on someone else's page.
 */
import { Eye, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import { Sparkline } from '@/components/ui/Sparkline'
import { USAGE_WINDOW_DAYS, useViewUsage } from '@/hooks/useContentInsights'

export function ViewUsageBadge({ viewId, className }: {
    viewId: string
    className?: string
}) {
    const { data } = useViewUsage([viewId])
    const usage = data?.[viewId]
    if (!usage) return null

    // Nothing at all in the window is a FINDING, not an empty state — say it
    // plainly rather than showing "0 opens", which reads as a broken counter.
    if (usage.opens === 0) {
        return (
            <span
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border border-glass-border px-2 py-0.5 text-[10px] font-medium text-ink-muted',
                    className,
                )}
                title={`Nobody has opened this view in the last ${USAGE_WINDOW_DAYS} days.`}
            >
                <Eye className="h-3 w-3" aria-hidden />
                Not opened recently
            </span>
        )
    }

    const people = `${compact(usage.uniqueViewers)} ${usage.uniqueViewers === 1 ? 'person' : 'people'}`
    return (
        <span
            className={cn(
                'inline-flex items-center gap-2 rounded-full border border-glass-border px-2 py-0.5 text-[10px] font-medium text-ink-secondary',
                className,
            )}
            title={[
                `${usage.opens.toLocaleString()} opens by ${people} in the last ${USAGE_WINDOW_DAYS} days`,
                usage.lastOpenedAt ? `Last opened ${timeAgo(usage.lastOpenedAt)}` : null,
            ].filter(Boolean).join(' · ')}
        >
            <span className="inline-flex items-center gap-1">
                <Eye className="h-3 w-3" aria-hidden />
                {compact(usage.opens)}
            </span>
            <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" aria-hidden />
                {compact(usage.uniqueViewers)}
            </span>
            {/* The shape matters as much as the total: 1,800 opens could be a
                steady habit or one burst six months ago, and the count alone
                cannot tell them apart. */}
            {usage.trend.length >= 3 && usage.trend.some((v) => v > 0) && (
                <Sparkline
                    points={usage.trend}
                    tone="indigo"
                    label={`Opens over the last ${USAGE_WINDOW_DAYS} days`}
                    width={44}
                    height={12}
                    className="shrink-0"
                />
            )}
        </span>
    )
}
