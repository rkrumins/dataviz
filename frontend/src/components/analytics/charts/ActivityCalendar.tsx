/**
 * ActivityCalendar — a person's year, one cell a day.
 *
 * Weeks run left to right and weekdays top to bottom, Monday first, the way a
 * year reads on a wall calendar. Each cell is that UTC day's actions on the
 * ordinal ramp, SNAPPED to its steps relative to the busiest day, so a quiet
 * month is a visible gap rather than a slightly paler stretch. A day they only
 * signed in on is outlined and left unfilled: they were here and did nothing,
 * which is neither "active" nor "absent".
 *
 * Colour is not the only channel. The readout above names the day under the
 * pointer or the keyboard in words, every cell is a labelled button, and the
 * frame's table twin carries the same year by month.
 *
 * Keyboard: the grid is one tab stop; arrows move a day (up/down) or a week
 * (left/right), Home/End jump to the ends, Enter opens the day.
 */
import { useEffect, useMemo, useRef, useState } from 'react'

import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { useChartTheme } from './chartTheme'
import { MONTHS, describeDay } from './calendar'

const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun']

function weekdayOf(iso: string): number {
    // Monday = 0. Parsed as UTC so a reader west of Greenwich does not shift it.
    return (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7
}

export interface CalendarCell {
    day: string
    actions: number
    signIns: number
    /** Index into the input arrays. */
    index: number
}

export function ActivityCalendar({
    days, actions, signIns, selected, onSelectDay, unit = 'actions', className,
}: {
    /** Oldest first, one entry per consecutive UTC day. */
    days: string[]
    actions: number[]
    /** `null` when the lens withholds sign-ins. */
    signIns?: number[] | null
    selected?: string | null
    onSelectDay?: (day: string) => void
    unit?: string
    className?: string
}) {
    const theme = useChartTheme()
    const [focus, setFocus] = useState<number | null>(null)
    const gridRef = useRef<HTMLDivElement>(null)
    const scrollRef = useRef<HTMLDivElement>(null)

    // Where the grid is wider than its card (a phone), open on the most recent
    // weeks: today is the end of the year a reader came to look at.
    useEffect(() => {
        const el = scrollRef.current
        if (el) el.scrollLeft = el.scrollWidth
    }, [days.length])

    const { weeks, monthTicks, max } = useMemo(() => {
        const lead = days.length ? weekdayOf(days[0]) : 0
        const cols: (CalendarCell | null)[][] = []
        const ticks: { col: number; label: string }[] = []
        let peak = 0
        days.forEach((day, i) => {
            const slot = i + lead
            const col = Math.floor(slot / 7)
            const row = slot % 7
            if (!cols[col]) cols[col] = Array.from({ length: 7 }, () => null)
            const n = actions[i] ?? 0
            peak = Math.max(peak, n)
            cols[col][row] = { day, actions: n, signIns: signIns?.[i] ?? 0, index: i }
            if (day.endsWith('-01') || i === 0) {
                const label = MONTHS[Number(day.slice(5, 7)) - 1]
                // The first, partial month only gets a label if it has room.
                if (i !== 0 || Number(day.slice(8, 10)) < 20) ticks.push({ col, label })
            }
        })
        return { weeks: cols, monthTicks: ticks, max: peak }
    }, [days, actions, signIns])

    const focusIndex = focus ?? (selected ? days.indexOf(selected) : -1)
    const active = focusIndex >= 0 ? {
        day: days[focusIndex], actions: actions[focusIndex] ?? 0, signIns: signIns?.[focusIndex] ?? 0,
    } : null

    const totals = useMemo(() => ({
        actions: actions.reduce((a, b) => a + b, 0),
        activeDays: actions.filter((n) => n > 0).length,
        signInOnly: signIns ? days.filter((_, i) => (actions[i] ?? 0) === 0 && (signIns[i] ?? 0) > 0).length : 0,
    }), [actions, signIns, days])

    const step = (n: number) => (max > 0
        ? Math.min(theme.ramp.length - 1, Math.floor((n / max) * theme.ramp.length))
        : 0)

    const move = (to: number) => {
        const next = Math.max(0, Math.min(days.length - 1, to))
        setFocus(next)
        const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-index="${next}"]`)
        el?.focus()
    }

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (focusIndex < 0) return
        const map: Record<string, number> = {
            ArrowUp: -1, ArrowDown: 1, ArrowLeft: -7, ArrowRight: 7,
        }
        if (e.key in map) { e.preventDefault(); move(focusIndex + map[e.key]) }
        else if (e.key === 'Home') { e.preventDefault(); move(0) }
        else if (e.key === 'End') { e.preventDefault(); move(days.length - 1) }
    }

    // One tab stop: the selected day, else the most recent.
    const tabStop = selected && days.includes(selected) ? days.indexOf(selected) : days.length - 1

    return (
        <div className={cn('space-y-3', className)}>
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 min-h-[2.25rem]" aria-live="polite">
                {active ? (
                    <div className="text-xs">
                        <span className="font-semibold text-ink">{describeDay(active.day)}</span>
                        <span className="text-ink-muted"> · </span>
                        <span className="tabular-nums font-semibold text-ink-secondary">{exact(active.actions)} {unit}</span>
                        {signIns && active.signIns > 0 && (
                            <span className="text-ink-muted"> · signed in {active.signIns === 1 ? 'once' : `${exact(active.signIns)} times`}</span>
                        )}
                    </div>
                ) : (
                    <div className="text-xs text-ink-muted">
                        <span className="tabular-nums font-semibold text-ink-secondary">{exact(totals.actions)}</span> {unit} on{' '}
                        <span className="tabular-nums font-semibold text-ink-secondary">{exact(totals.activeDays)}</span> days in the last year
                        {totals.signInOnly > 0 && <> · {exact(totals.signInOnly)} days signed in and did nothing</>}
                    </div>
                )}
                {onSelectDay && <p className="text-[11px] text-ink-muted">Pick a day to see everything that happened</p>}
            </div>

            <div ref={scrollRef} className="overflow-x-auto pb-1">
                <div className="inline-grid min-w-full grid-cols-[auto_1fr] gap-x-2">
                    <div />
                    {/* Month ticks, positioned on the week grid. */}
                    <div className="relative h-4 text-[10px] font-semibold text-ink-muted"
                        style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, minmax(10px, 1fr))` }}>
                        {monthTicks.map((t) => (
                            <span key={`${t.col}-${t.label}`} style={{ gridColumnStart: t.col + 1 }} className="whitespace-nowrap">
                                {t.label}
                            </span>
                        ))}
                    </div>
                    <div className="grid grid-rows-7 gap-[3px] text-[9px] font-semibold text-ink-muted pr-1" aria-hidden>
                        {WEEKDAY_LABELS.map((l, i) => <span key={i} className="h-full flex items-center">{l}</span>)}
                    </div>
                    <div
                        ref={gridRef}
                        role="group"
                        aria-label={`Daily ${unit} over the last year. Arrow keys move between days.`}
                        onKeyDown={onKeyDown}
                        onMouseLeave={() => setFocus(null)}
                        className="grid gap-[3px]"
                        style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(10px, 1fr))` }}
                    >
                        {weeks.map((col, c) => (
                            <div key={c} className="grid grid-rows-7 gap-[3px]">
                                {col.map((cell, r) => cell ? (
                                    <button
                                        key={cell.day}
                                        type="button"
                                        data-index={cell.index}
                                        tabIndex={cell.index === tabStop ? 0 : -1}
                                        aria-pressed={cell.day === selected}
                                        aria-label={`${describeDay(cell.day)}: ${exact(cell.actions)} ${unit}${cell.signIns ? `, signed in ${cell.signIns}×` : ''}`}
                                        onMouseEnter={() => setFocus(cell.index)}
                                        onFocus={() => setFocus(cell.index)}
                                        onClick={() => onSelectDay?.(cell.day)}
                                        className={cn(
                                            'aspect-square w-full min-w-[10px] rounded-[3px] outline-none transition-transform duration-100',
                                            'focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas-elevated',
                                            onSelectDay && 'hover:scale-125 cursor-pointer',
                                            cell.actions === 0 && 'bg-black/[0.035] dark:bg-white/[0.05]',
                                            cell.actions === 0 && cell.signIns > 0 && 'ring-1 ring-inset ring-indigo-400/60',
                                            cell.day === selected && 'ring-2 ring-ink ring-offset-1 ring-offset-canvas-elevated',
                                        )}
                                        style={cell.actions > 0 ? { backgroundColor: theme.ramp[step(cell.actions)] } : undefined}
                                    />
                                ) : <span key={`pad-${r}`} aria-hidden />)}
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[10px] text-ink-muted">
                <span className="inline-flex items-center gap-1">
                    Less
                    <span className="h-2.5 w-2.5 rounded-[2px] bg-black/[0.035] dark:bg-white/[0.05]" />
                    {theme.ramp.map((c) => <span key={c} className="h-2.5 w-2.5 rounded-[2px]" style={{ backgroundColor: c }} />)}
                    More
                </span>
                {signIns && (
                    <span className="inline-flex items-center gap-1">
                        <span className="h-2.5 w-2.5 rounded-[2px] ring-1 ring-inset ring-indigo-400/60" />
                        Signed in, did nothing
                    </span>
                )}
                <span>Days in UTC</span>
            </div>
        </div>
    )
}
