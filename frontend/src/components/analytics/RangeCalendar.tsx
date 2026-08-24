/**
 * RangeCalendar — two months side by side, click a start then an end.
 *
 * The picker this replaces was two `<input type="date">` boxes. They work, but
 * they answer the wrong question: a range is a SHAPE — how long, where it sits
 * against today, whether it straddles a month boundary — and a pair of text
 * fields shows none of it. A grid does, and the days between the ends being
 * painted is the whole point.
 *
 * There is no internal "anchor" state. A half-made range IS `from` with an
 * empty `to`, which is the same value the popover's Apply button already reads
 * to decide whether it is complete. One source of truth, no way for the paint
 * and the summary to disagree.
 *
 * Weeks start on Monday, matching the retention cohorts, which bucket on
 * Python's `weekday()`. Everything here is UTC, matching the day buckets the
 * server slices with `substr(created_at, 1, 10)` — a calendar that quietly
 * used local midnight would offer people a day the server has no data for.
 */
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'

import { cn } from '@/lib/utils'

const DAY_MS = 86_400_000

/** Monday-first initials. Two of them are "T" and two are "S", so the key is
 *  the index — the label is not unique and was never meant to be. */
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

interface Month { y: number; m: number }

function ms(iso: string): number {
    return Date.parse(`${iso}T00:00:00Z`)
}

function isoOf(t: number): string {
    return new Date(t).toISOString().slice(0, 10)
}

function shift(iso: string, days: number): string {
    return isoOf(ms(iso) + days * DAY_MS)
}

function spanOf(a: string, b: string): number {
    return Math.abs(ms(b) - ms(a)) / DAY_MS + 1
}

export function monthOf(iso: string): Month {
    return { y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) - 1 }
}

export function addMonths({ y, m }: Month, n: number): Month {
    const total = y * 12 + m + n
    return { y: Math.floor(total / 12), m: ((total % 12) + 12) % 12 }
}

/** First and last day of a month, as ISO strings. */
export function monthBounds({ y, m }: Month): { from: string; to: string } {
    return { from: isoOf(Date.UTC(y, m, 1)), to: isoOf(Date.UTC(y, m + 1, 0)) }
}

function monthTitle({ y, m }: Month): string {
    return new Date(Date.UTC(y, m, 1)).toLocaleDateString(undefined, {
        month: 'long', year: 'numeric', timeZone: 'UTC',
    })
}

function ordinal({ y, m }: Month): number {
    return y * 12 + m
}

/** Weeks of a month as 7-cell rows, `null` where the row runs past the month. */
function weeksOf({ y, m }: Month): (string | null)[][] {
    const lead = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7
    const length = new Date(Date.UTC(y, m + 1, 0)).getUTCDate()
    const cells: (string | null)[] = Array<null>(lead).fill(null)
    for (let d = 1; d <= length; d += 1) cells.push(isoOf(Date.UTC(y, m, d)))
    while (cells.length % 7 !== 0) cells.push(null)
    const rows: (string | null)[][] = []
    for (let i = 0; i < cells.length; i += 7) rows.push(cells.slice(i, i + 7))
    return rows
}

/** Whether there is room for two months. Below the breakpoint the second pane
 *  is not rendered at all — and the month that is left has to be the CURRENT
 *  one, or a narrow viewport opens on a calendar that cannot reach today. */
function useTwoUp(): boolean {
    const query = '(min-width: 640px)'
    const [twoUp, setTwoUp] = useState(
        () => typeof window !== 'undefined' && window.matchMedia(query).matches,
    )
    useEffect(() => {
        const mq = window.matchMedia(query)
        const sync = () => setTwoUp(mq.matches)
        mq.addEventListener('change', sync)
        return () => mq.removeEventListener('change', sync)
    }, [])
    return twoUp
}

export function RangeCalendar({
    from, to, today, maxSpanDays, onSelect,
}: {
    from: string
    to: string
    today: string
    maxSpanDays: number
    onSelect: (from: string, to: string) => void
}) {
    const twoUp = useTwoUp()
    const panes = twoUp ? 2 : 1

    // Today sits in the LAST pane, where the eye expects "now". An existing
    // selection wins over that: landing on a calendar that does not show the
    // range you already picked is disorienting.
    const [focus, setFocus] = useState<string>(() => to || from || today)
    const [leftState, setLeft] = useState<Month>(
        () => addMonths(monthOf(to || from || today), -(panes - 1)),
    )
    const [hover, setHover] = useState<string | null>(null)
    const gridRef = useRef<HTMLDivElement>(null)

    // The last pane never runs past the current month — a pane of days that
    // cannot be picked is a pane of nothing. Clamped on the way OUT rather
    // than on the way in, so losing a pane to a resize cannot strand the view
    // in the future either.
    const maxLeft = addMonths(monthOf(today), -(panes - 1))
    const left = ordinal(leftState) > ordinal(maxLeft) ? maxLeft : leftState

    const pending = Boolean(from) && !to
    const right = addMonths(left, 1)
    const lastPane = ordinal(left) + panes - 1
    const atToday = lastPane >= ordinal(monthOf(today))

    // While half-made, the range paints to wherever the cursor is, so its
    // length is visible BEFORE the click that commits it.
    const drift = pending ? (hover ?? from) : to
    const lo = pending && drift < from ? drift : from
    const hi = pending && drift < from ? from : drift

    const isBlocked = (day: string) =>
        day > today || (pending && spanOf(from, day) > maxSpanDays)

    const pick = (day: string) => {
        if (isBlocked(day)) return
        if (!pending) onSelect(day, '')
        else if (day < from) onSelect(day, from)
        else onSelect(from, day)
    }

    // Roving focus: the grid holds one tab stop and the arrows move it. The
    // inputs this replaces were reachable without a mouse, and a grid that is
    // not would be a regression dressed up as a redesign.
    const moveTo = (day: string) => {
        if (day > today) return
        setFocus(day)
        const o = ordinal(monthOf(day))
        if (o < ordinal(left)) setLeft(monthOf(day))
        else if (o > lastPane) setLeft(addMonths(monthOf(day), -(panes - 1)))
    }
    // Paging must carry the tab stop with it, or the grid loses its only one.
    const goMonth = (step: number) => {
        const next = addMonths(left, step)
        setLeft(next)
        const o = ordinal(monthOf(focus))
        if (o < ordinal(next) || o > ordinal(next) + panes - 1) {
            const start = monthBounds(next).from
            setFocus(start > today ? today : start)
        }
    }
    const onKeyDown = (e: React.KeyboardEvent) => {
        const by: Record<string, number> = {
            ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7,
        }
        if (e.key in by) { e.preventDefault(); moveTo(shift(focus, by[e.key])); return }
        if (e.key === 'PageUp' || e.key === 'PageDown') {
            e.preventDefault()
            const step = e.key === 'PageUp' ? -1 : 1
            const { y, m } = addMonths(monthOf(focus), step)
            const day = Math.min(
                Number(focus.slice(8, 10)),
                new Date(Date.UTC(y, m + 1, 0)).getUTCDate(),
            )
            moveTo(isoOf(Date.UTC(y, m, day)))
            return
        }
        if (e.key === 'Home') { e.preventDefault(); moveTo(shift(focus, -((new Date(ms(focus)).getUTCDay() + 6) % 7))) }
        if (e.key === 'End') { e.preventDefault(); moveTo(shift(focus, 6 - ((new Date(ms(focus)).getUTCDay() + 6) % 7))) }
    }

    // Only chase the focus ring when focus is already inside the grid —
    // otherwise arriving at the popover would yank focus off the close button.
    useEffect(() => {
        const root = gridRef.current
        if (!root || !root.contains(document.activeElement)) return
        root.querySelector<HTMLButtonElement>(`[data-day="${focus}"]`)?.focus()
        // `left` is a fresh object every render; `lastPane` is the number that
        // actually changes when the visible months do.
    }, [focus, lastPane])

    return (
        <div>
            <div className="flex items-center justify-between gap-2 mb-2">
                <NavButton
                    label="Previous month"
                    onClick={() => goMonth(-1)}
                    icon={ChevronLeft}
                />
                <div className={cn('flex-1 grid gap-4 text-center', twoUp ? 'grid-cols-2' : 'grid-cols-1')}>
                    <span className="text-xs font-bold text-ink">{monthTitle(left)}</span>
                    {twoUp && <span className="text-xs font-bold text-ink">{monthTitle(right)}</span>}
                </div>
                <NavButton
                    label="Next month"
                    onClick={() => goMonth(1)}
                    icon={ChevronRight}
                    disabled={atToday}
                />
            </div>

            <div
                ref={gridRef}
                role="group"
                aria-label="Choose a start and end date"
                onKeyDown={onKeyDown}
                onMouseLeave={() => setHover(null)}
                className={cn('grid gap-4', twoUp ? 'grid-cols-2' : 'grid-cols-1')}
            >
                <MonthGrid
                    month={left} lo={lo} hi={hi} today={today} focus={focus}
                    isBlocked={isBlocked} onPick={pick} onHover={setHover}
                />
                {twoUp && (
                    <MonthGrid
                        month={right} lo={lo} hi={hi} today={today} focus={focus}
                        isBlocked={isBlocked} onPick={pick} onHover={setHover}
                    />
                )}
            </div>
        </div>
    )
}

function NavButton({
    label, onClick, icon: Icon, disabled,
}: {
    label: string
    onClick: () => void
    icon: React.ComponentType<{ className?: string }>
    disabled?: boolean
}) {
    return (
        <button
            type="button" onClick={onClick} disabled={disabled} aria-label={label} title={label}
            className="w-7 h-7 shrink-0 rounded-lg border border-glass-border flex items-center justify-center text-ink-muted transition-colors hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:pointer-events-none outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
        >
            <Icon className="w-3.5 h-3.5" />
        </button>
    )
}

function MonthGrid({
    month, lo, hi, today, focus, isBlocked, onPick, onHover,
}: {
    month: Month
    lo: string
    hi: string
    today: string
    focus: string
    isBlocked: (day: string) => boolean
    onPick: (day: string) => void
    onHover: (day: string | null) => void
}) {
    return (
        <div>
            <div className="grid grid-cols-7 mb-1" aria-hidden>
                {WEEKDAYS.map((d, i) => (
                    <span key={i} className="text-center text-[10px] font-semibold uppercase text-ink-muted">
                        {d}
                    </span>
                ))}
            </div>
            <div className="grid grid-cols-7 gap-y-0.5">
                {weeksOf(month).flat().map((day, i) => {
                    if (!day) return <span key={`gap-${i}`} />
                    const inRange = Boolean(lo) && Boolean(hi) && day >= lo && day <= hi
                    const isEnd = day === lo || day === hi
                    const blocked = isBlocked(day)
                    const weekday = i % 7
                    return (
                        <span
                            key={day}
                            className={cn(
                                'relative h-8',
                                // The track is what makes a range look like a
                                // range. It runs edge to edge between the caps
                                // and rounds off at the ends of the week, so a
                                // range that wraps a Sunday still reads as one
                                // band rather than as two.
                                inRange && !isEnd && 'bg-indigo-500/10 dark:bg-indigo-400/10',
                                inRange && !isEnd && weekday === 0 && 'rounded-l-lg',
                                inRange && !isEnd && weekday === 6 && 'rounded-r-lg',
                            )}
                        >
                            {/* Half the track under a cap, so the band meets the
                                pill instead of stopping a pixel short of it. */}
                            {isEnd && lo !== hi && (
                                <span
                                    aria-hidden
                                    className={cn(
                                        'absolute inset-y-0 w-1/2 bg-indigo-500/10 dark:bg-indigo-400/10',
                                        day === lo ? 'right-0' : 'left-0',
                                    )}
                                />
                            )}
                            <button
                                type="button"
                                data-day={day}
                                tabIndex={day === focus ? 0 : -1}
                                disabled={blocked}
                                aria-pressed={isEnd}
                                aria-label={new Date(ms(day)).toLocaleDateString(undefined, {
                                    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
                                })}
                                onClick={() => onPick(day)}
                                onMouseEnter={() => onHover(day)}
                                onFocus={() => onHover(day)}
                                className={cn(
                                    'relative z-10 w-full h-full rounded-lg text-[11px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/60',
                                    // `opacity`, not an alpha on the token: the
                                    // ink colours are bare `var()`s, so a `/40`
                                    // modifier compiles to a colour the browser
                                    // drops — leaving future days LOUDER than the
                                    // days you can actually pick.
                                    blocked && 'text-ink-muted opacity-40 pointer-events-none',
                                    !blocked && !inRange && 'text-ink-secondary hover:bg-black/5 dark:hover:bg-white/10',
                                    !blocked && inRange && !isEnd && 'text-indigo-700 dark:text-indigo-200',
                                    isEnd && 'bg-gradient-to-br from-indigo-500 to-violet-600 text-white shadow-sm',
                                    // Today gets a ring, not a fill: it is a
                                    // landmark for finding your place, not a
                                    // third kind of selection.
                                    day === today && !isEnd && 'ring-1 ring-inset ring-indigo-500/50',
                                )}
                            >
                                {Number(day.slice(8, 10))}
                            </button>
                        </span>
                    )
                })}
            </div>
        </div>
    )
}
