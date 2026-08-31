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
 * THE TIPS ARE THE CATALOGUE'S TIPS, not a second set. Sharing the phrase
 * helpers was not enough: `UsageTip` — the figure/caption/footnote card — was
 * private to `ViewUsage.tsx`, so this surface could only pass a phrase, and
 * the same two numbers were explained with a rich card in the Explorer and one
 * line of grey prose here. Both now render the same component; this file owns
 * nothing but presentation.
 *
 * It renders nothing at all while loading or on failure — a usage figure is
 * not worth a spinner, and certainly not worth an error state on someone
 * else's page.
 */
import { Activity, Eye, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact } from '@/lib/formatMetric'
import { HoverTip } from '@/components/ui/HoverTip'
import { Sparkline } from '@/components/ui/Sparkline'
import {
    OpensUsageTip, PeopleUsageTip, TIP_ACCENT, UsageTip,
} from '@/components/explorer/ViewUsage'
import { USAGE_WINDOW_DAYS, useViewUsage } from '@/hooks/useContentInsights'

/** The separator between two facts on one line. */
function Dot() {
    return <span aria-hidden className="text-ink-muted">·</span>
}

/** "3 days ago", in the register the rest of the bar uses. */
function daysAgoPhrase(daysAgo: number): string {
    if (daysAgo <= 0) return 'today'
    if (daysAgo === 1) return 'yesterday'
    return `${daysAgo} days ago`
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

    const trend = usage.trend
    const showTrend = trend.length >= 3 && trend.some(v => v > 0)
    const peak = showTrend ? Math.max(...trend) : 0
    // The LAST peak, not the first: on a flat-ish series the recent one is the
    // one a reader is looking at.
    const peakAgo = showTrend ? trend.length - 1 - trend.lastIndexOf(peak) : 0
    const quietDays = showTrend ? trend.filter(v => v === 0).length : 0

    return (
        <span className={cn(
            'inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary',
            className,
        )}>
            {/* A tip PER FIGURE, not one for the row: a reader hovering the
                people count must not be told about opens. */}
            <HoverTip className="inline-flex" label={<PeopleUsageTip usage={usage} />}>
                <span className="inline-flex items-center gap-1">
                    <Users className="h-3 w-3 shrink-0 text-indigo-500" aria-hidden />
                    <span className="font-bold tabular-nums text-ink">
                        {compact(usage.uniqueViewers)}
                    </span>{' '}
                    {usage.uniqueViewers === 1 ? 'person' : 'people'}
                </span>
            </HoverTip>
            <Dot />
            <HoverTip className="inline-flex" label={<OpensUsageTip usage={usage} />}>
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
            {showTrend && (
                <HoverTip
                    className="ml-1 hidden items-center gap-1.5 lg:inline-flex"
                    label={(
                        <UsageTip
                            icon={Activity}
                            accent={TIP_ACCENT.trend}
                            figure={`${compact(peak)} ${peak === 1 ? 'open' : 'opens'} on the busiest day`}
                            caption={`${daysAgoPhrase(peakAgo)}, in the last ${USAGE_WINDOW_DAYS} days`}
                            footnote={quietDays > 0
                                ? `No opens at all on ${quietDays} of those ${trend.length} days`
                                : `Opened on every one of those ${trend.length} days`}
                        />
                    )}
                >
                    {/* A LANE FOR THE DOT. Sparkline draws the current point as
                        an r=4 circle at the very end of the plot and sets
                        `overflow-visible`, so at this size (52×13, 30 points)
                        it paints 4px outside the SVG's own box at both ends —
                        straight into the "o" of "opens per day" on the right,
                        and into "last 30 days" when the first point is hovered.
                        The reserved lane lives HERE, at the call site, because
                        the bleed is a property of this size; Sparkline's seven
                        other callers are unaffected and must stay that way. */}
                    <span className="block px-1 leading-none">
                        <Sparkline
                            points={trend}
                            tone="indigo"
                            width={52}
                            height={13}
                            className="block shrink-0"
                        />
                    </span>
                    <span className="text-[10px] text-ink-muted">opens per day</span>
                    {/* No `label` on the Sparkline: its accessible name would be
                        the thirty plotted values as a comma list, and it would
                        render them in an OS pill on top of the card above. The
                        chart is a shape — the sentence is here, and the detail
                        is in the tip. */}
                    <span className="sr-only">
                        Opens per day over the last {USAGE_WINDOW_DAYS} days:
                        {' '}busiest day {compact(peak)}, {daysAgoPhrase(peakAgo)}
                    </span>
                </HoverTip>
            )}
        </span>
    )
}
