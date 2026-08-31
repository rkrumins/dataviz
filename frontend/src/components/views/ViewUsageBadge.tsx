/**
 * "Is anyone actually using this?" — answered on the view itself, IN WORDS.
 *
 * The platform knew this all along and only ever said it on the Analytics
 * dashboard, which the person who built the view has no reason to open and
 * often no permission to. A view that nobody opens is the single most useful
 * thing its author can learn, and it was the one place the number never
 * appeared.
 *
 * EVERY FIGURE CARRIES ITS UNIT AND ITS WINDOW ON THE SURFACE. This used to
 * render `👁 160  👤 1` and put "160 opens by 1 person in the last 30 days"
 * in a native `title` — so the two numbers on screen meant nothing until you
 * hovered them, and the sparkline beside them said what it plotted nowhere at
 * all. A metric that needs a tooltip to be legible is not a metric, it is a
 * riddle; the tooltip is for the detail BEYOND the fact (lifetime opens, when
 * it was last opened), never for the fact itself.
 *
 * PEOPLE LEAD, opens follow — the order `ViewUsage.tsx` and the backend's own
 * docstring both call for, and the one this component used to invert. 340
 * opens by one person is somebody's scratchpad; 340 by twelve is something a
 * team relies on, and the raw total cannot tell them apart.
 *
 * The prose is NOT re-written here: `peoplePhrase` / `opensPhrase` come from
 * the Explorer's `ViewUsage`, so the catalogue and the view page cannot drift
 * into describing the same number two different ways. This file owns nothing
 * but presentation.
 *
 * It renders nothing at all while loading or on failure — a usage figure is
 * not worth a spinner, and certainly not worth an error state on someone
 * else's page.
 */
import { Eye, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import { HoverTip } from '@/components/ui/HoverTip'
import { Sparkline } from '@/components/ui/Sparkline'
import { opensPhrase, peoplePhrase } from '@/components/explorer/ViewUsage'
import { USAGE_WINDOW_DAYS, useViewUsage } from '@/hooks/useContentInsights'

/** The separator between two facts on one line. */
function Dot() {
    return <span aria-hidden className="text-ink-muted">·</span>
}

export function ViewUsageBadge({ viewId, className }: {
    viewId: string
    className?: string
}) {
    const { data } = useViewUsage([viewId])
    const usage = data?.[viewId]
    if (!usage) return null

    // Nothing at all in the window is a FINDING, not an empty state — say it
    // plainly rather than showing "0 opens", which reads as a broken counter.
    // It still names the window: "not opened recently" left the reader to
    // guess whether that meant a week or a year.
    if (usage.opens === 0) {
        return (
            <span className={cn(
                'inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-muted',
                className,
            )}>
                <Eye className="h-3 w-3 shrink-0" aria-hidden />
                Not opened in the last {USAGE_WINDOW_DAYS} days
            </span>
        )
    }

    return (
        <span className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary',
            className,
        )}>
            {/* A tip PER FIGURE, not one for the row: a reader hovering the
                people count must not be told about opens. `HoverTip` rather
                than `title` — the native one waits a second and renders in OS
                chrome that belongs to no part of this product. */}
            <HoverTip className="inline-flex" label={peoplePhrase(usage)}>
                <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3 shrink-0 text-indigo-500" aria-hidden />
                    <span className="font-bold tabular-nums text-ink">
                        {compact(usage.uniqueViewers)}
                    </span>{' '}
                    {usage.uniqueViewers === 1 ? 'person' : 'people'}
                </span>
            </HoverTip>
            <Dot />
            <HoverTip className="inline-flex" label={opensPhrase(usage)}>
                <span className="inline-flex items-center gap-1">
                    <Eye className="h-3 w-3 shrink-0 text-cyan-500" aria-hidden />
                    <span className="font-bold tabular-nums text-ink">
                        {compact(usage.opens)}
                    </span>{' '}
                    {usage.opens === 1 ? 'open' : 'opens'}
                </span>
            </HoverTip>
            <Dot />
            <span className="whitespace-nowrap text-ink-muted">
                last {USAGE_WINDOW_DAYS} days
            </span>

            {/* The shape matters as much as the total: 1,800 opens could be a
                steady habit or one burst six months ago, and the count alone
                cannot tell them apart. Captioned — an unlabelled line beside
                two other numbers is a decoration, not a chart. */}
            {usage.trend.length >= 3 && usage.trend.some((v) => v > 0) && (
                <span className="ml-0.5 hidden items-center gap-1 lg:inline-flex">
                    <Sparkline
                        points={usage.trend}
                        tone="indigo"
                        label={`Opens per day over the last ${USAGE_WINDOW_DAYS} days`}
                        width={52}
                        height={13}
                        className="shrink-0"
                    />
                    <span className="text-[10px] text-ink-muted">opens per day</span>
                </span>
            )}
        </span>
    )
}
