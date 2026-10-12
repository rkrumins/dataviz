/**
 * DateTime — an instant, readable at a glance and exact on hover.
 *
 * The label says what is most useful at its age (`smartTime`): "12 min ago",
 * "Today 09:41", "Mon 18:02", "12 Oct". Hovering spells the instant out every
 * way an investigation needs: how long ago, the reader's local time and zone,
 * UTC, and ISO. Every label on a page moves on one shared clock (`useNow`), so
 * "just now" does not stay "just now" for an hour.
 *
 * In a list already grouped by day, `variant="clock"` drops the day the
 * heading already says: "12 min ago", then "09:41". In a sequence of moments
 * (a run's timeline), `variant="calendar"` is never relative: "Today 09:41".
 *
 * The hover card is built only when it opens, so a page of a few hundred
 * times costs a few hundred short labels, not a few hundred cards.
 *
 * `DateTimeTile` is the same instant for a detail view, where the time is the
 * subject rather than a column: large, with its zone, its date, UTC, and the
 * ISO form one click from the clipboard.
 */
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import { calendarTime, clockTime, describeInstant, relativeLong, smartTime, toUtcDate, type Instant } from '@/lib/smartTime'
import { useNow } from '@/lib/useNow'

import { CopyButton } from './CopyButton'
import { HoverTip } from './HoverTip'

/** The hover card's lead: how long ago, in words. */
function TipLead({ date }: { date: Date }) {
    const now = useNow()
    return <span className="block first-letter:uppercase">{relativeLong(date, now)}</span>
}

/** The hover card's rows: local, UTC and ISO, aligned. */
function TipRows({ date }: { date: Date }) {
    const instant: Instant = describeInstant(date)
    return (
        <span className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
            <span className="text-ink-muted">Local</span>
            <span className="text-ink">
                {instant.time} <span className="text-ink-muted">{instant.zone}</span> · {instant.date}
            </span>
            <span className="text-ink-muted">UTC</span>
            <span className="text-ink">{instant.utcTime} · {instant.utcDate}</span>
            <span className="text-ink-muted">ISO</span>
            <span className="font-mono text-[10px] text-ink-secondary">{instant.iso}</span>
        </span>
    )
}

export function DateTime({ at, prefix, variant = 'smart', className, empty = '—' }: {
    at: string | null | undefined
    /** Read before the label, e.g. "Started ". */
    prefix?: ReactNode
    /** `clock` for a list grouped by day: the time, without the day.
     *  `calendar` for a sequence of moments: the day and time, never "ago". */
    variant?: 'smart' | 'clock' | 'calendar'
    className?: string
    /** Shown when there is no instant to show. */
    empty?: ReactNode
}) {
    const now = useNow()
    const date = toUtcDate(at)
    if (!date) return <span className={cn('text-ink-muted', className)}>{empty}</span>
    return (
        <HoverTip width="data" label={<TipLead date={date} />} detail={<TipRows date={date} />}>
            <time
                dateTime={date.toISOString()}
                className={cn('whitespace-nowrap tabular-nums', className)}
            >
                {prefix}{variant === 'clock' ? clockTime(date, now)
                    : variant === 'calendar' ? calendarTime(date, now) : smartTime(date, now)}
            </time>
        </HoverTip>
    )
}

const SECTION = 'text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted'

export function DateTimeTile({ at, label, footnote, className }: {
    at: string | null | undefined
    label: string
    /** A line under the instant: what else is true of it ("Logged 2 s later"). */
    footnote?: ReactNode
    className?: string
}) {
    const now = useNow()
    const date = toUtcDate(at)
    return (
        <div className={cn(
            'rounded-xl border border-black/[0.06] dark:border-white/[0.08]',
            'bg-gradient-to-br from-black/[0.015] to-transparent dark:from-white/[0.03]',
            'px-3.5 py-3',
            className,
        )}>
            <p className={SECTION}>{label}</p>
            {!date ? (
                <p className="mt-1 text-sm text-ink-muted">—</p>
            ) : (() => {
                const instant = describeInstant(date)
                return (
                    <>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
                            <time dateTime={instant.iso} className="text-xl font-semibold tracking-tight tabular-nums text-ink">
                                {instant.time}
                            </time>
                            {instant.zone && (
                                <span className="text-[11px] font-semibold text-ink-muted" title={instant.offset}>
                                    {instant.zone}
                                </span>
                            )}
                            <span className="ml-auto rounded-full bg-accent-lineage/10 px-2 py-0.5 text-[10px] font-semibold text-accent-lineage first-letter:uppercase">
                                {relativeLong(date, now)}
                            </span>
                        </div>
                        <p className="text-xs text-ink-secondary">{instant.date}</p>
                        <div className="mt-2 flex items-center gap-1.5 border-t border-black/[0.05] pt-2 text-[11px] tabular-nums text-ink-muted dark:border-white/[0.06]">
                            <span className="min-w-0 truncate">{instant.utcTime} · {instant.utcDate}</span>
                            <CopyButton value={instant.iso} label={`Copy ${label.toLowerCase()} as ISO 8601`} className="ml-auto" />
                        </div>
                        {footnote && <p className="mt-1 text-[11px] text-ink-muted">{footnote}</p>}
                    </>
                )
            })()}
        </div>
    )
}
