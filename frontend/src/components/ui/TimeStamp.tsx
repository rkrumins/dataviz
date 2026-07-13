/**
 * TimeStamp — a timestamp you can read at a glance.
 *
 * The Explorer's view cards had the good version and kept it to themselves: an
 * icon, a relative age ("2h ago"), and — the part that actually does the work —
 * a COLOUR THAT ENCODES STALENESS (emerald within a week, amber within a month,
 * red beyond). You never read the number; you read the colour, and only look
 * closer when it isn't green.
 *
 * Everywhere else printed flat grey text, so "updated 1 minute ago" and "updated
 * 8 months ago" looked identical and the reader had to parse every one. This is
 * that Explorer chip, lifted out so the workspace cards and list can use it too,
 * rather than each surface inventing its own.
 *
 * The exact instant always lives in the tooltip. Relative time is for scanning;
 * when someone actually needs to know *when*, they need the real timestamp, and
 * "3 months ago" cannot answer that.
 */
import type { ElementType } from 'react'
import { RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'

const DAY_MS = 1000 * 60 * 60 * 24

/** Fresh / ageing / stale. The same thresholds the Explorer has always used. */
export function freshnessColor(iso: string): string {
    const t = new Date(iso).getTime()
    if (Number.isNaN(t)) return 'text-ink-muted'
    const days = (Date.now() - t) / DAY_MS
    if (days <= 7) return 'text-emerald-500'
    if (days <= 30) return 'text-amber-500'
    return 'text-red-500'
}

export function TimeStamp({
    at,
    icon: Icon = RefreshCw,
    /** Extra tooltip lines — who did it, what the other timestamp says. */
    tooltipLines,
    /** Off for timestamps where age is context, not health (e.g. "created"). */
    colorByAge = true,
    /** Rendered before the relative time, e.g. "Updated". */
    prefix,
    className,
    iconClassName,
}: {
    at: string
    icon?: ElementType | null
    tooltipLines?: (string | false | null | undefined)[]
    colorByAge?: boolean
    prefix?: string
    className?: string
    iconClassName?: string
}) {
    const exact = new Date(at)
    const valid = !Number.isNaN(exact.getTime())

    // The tooltip always ends with the real instant. Relative time is a summary,
    // not an answer — nobody can act on "3 months ago".
    const title = [
        ...(tooltipLines ?? []).filter(Boolean),
        valid ? exact.toLocaleString() : null,
    ].filter(Boolean).join('\n')

    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 text-[11px] font-medium whitespace-nowrap',
                colorByAge && valid ? freshnessColor(at) : 'text-ink-muted',
                className,
            )}
            title={title}
        >
            {Icon && <Icon className={cn('w-3 h-3 shrink-0', iconClassName)} />}
            {prefix && <span className="text-ink-muted font-normal">{prefix}</span>}
            {valid ? timeAgo(at) : '—'}
        </span>
    )
}
