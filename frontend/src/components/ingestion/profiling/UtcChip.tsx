/**
 * The zone, stated once for a list of times.
 *
 * Every instant on this surface is UTC, because the buckets are: a day bucket
 * IS a UTC day, so localising its hours would put an observation on a
 * different date from the bucket containing it. That consistency is only
 * useful if the reader knows about it — an unlabelled 21:32 is read in
 * whatever zone the reader happens to live in, and is wrong by that offset.
 *
 * A chip rather than a suffix on every row: forty consecutive rows ending in
 * "UTC" is texture, and a header is where someone's eye already is before they
 * start reading times. Isolated readings — tooltips, an alert timestamp, a
 * coverage line — carry the suffix themselves, because they get copied
 * elsewhere and have to survive the trip.
 */
import { cn } from '@/lib/utils'

import { TIME_ZONE_LABEL } from './shared'

export function UtcChip({ className }: { className?: string }) {
    return (
        <span
            title="All times on this surface are UTC"
            className={cn(
                'inline-flex items-center rounded-md border border-glass-border',
                'px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                'text-ink-muted bg-canvas',
                className,
            )}
        >
            {TIME_ZONE_LABEL}
        </span>
    )
}
