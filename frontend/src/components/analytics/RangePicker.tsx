/**
 * RangePicker — the one filter above everything it scopes.
 *
 * Presets as a segmented row, because nobody wants to fight a date grid for
 * "last 30 days", plus a custom range for the questions presets cannot ask:
 * "how did March compare to April". They scope EVERY chart, stat and table on
 * the page, so the numbers always agree with each other.
 *
 * Deliberately not per-chart. A chart that needs its own range is a different
 * dashboard.
 */
import { useEffect, useRef, useState } from 'react'
import { CalendarRange, Check, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import { RangeCalendar, addMonths, monthBounds, monthOf } from './RangeCalendar'

export const RANGE_PRESETS = [
    { days: 7, label: '7d', title: 'Last 7 days' },
    { days: 14, label: '14d', title: 'Last 14 days' },
    { days: 30, label: '30d', title: 'Last 30 days' },
    { days: 90, label: '90d', title: 'Last 90 days' },
    { days: 180, label: '6m', title: 'Last 6 months' },
    { days: 365, label: '1y', title: 'Last 12 months' },
] as const

// Two weeks. Long enough that a quiet Tuesday does not swing the trend, short
// enough that "what changed" is still about now rather than about last month —
// and it opens on a window most people can hold in their head.
export const DEFAULT_RANGE_DAYS = 14

/** Matches the server's cap on a custom range. */
export const MAX_RANGE_DAYS = 365

export function todayIso(): string {
    return new Date().toISOString().slice(0, 10)
}

function daysBetween(from: string, to: string): number {
    const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)
    return Math.round(ms / 86_400_000) + 1
}

/** How many days the slice spans — for rules that need a length rather than a
 *  name (e.g. "cohorts need at least four weeks"). */
export function rangeSpanDays(range: AnalyticsRangeSelection): number {
    return range.kind === 'custom' ? daysBetween(range.from, range.to) : range.days
}

/** Human name for the current slice — used in headings and delta captions. */
export function rangeLabel(range: AnalyticsRangeSelection): string {
    if (range.kind === 'custom') return `${range.from} → ${range.to}`
    return RANGE_PRESETS.find((p) => p.days === range.days)?.title
        ?? `Last ${range.days} days`
}

/** The PREPOSITIONAL form of the same slice: "the last 30 days", so a sentence
 *  can say "in {rangePhrase(range)}" instead of the ungrammatical "in last 30
 *  days". A custom range is already a phrase and takes no article. */
export function rangePhrase(range: AnalyticsRangeSelection): string {
    if (range.kind === 'custom') return rangeLabel(range)
    return `the ${rangeLabel(range).toLowerCase()}`
}

/** "Previous 30 days" — the ghost line's own name in a chart legend. */
export function previousLabel(range: AnalyticsRangeSelection): string {
    const span = rangeSpanDays(range)
    return `Previous ${span} day${span === 1 ? '' : 's'}`
}

/** "vs previous 30 days" — names what a delta is measured against. A delta with
 *  no stated baseline is a number people quietly invent a baseline for. */
export function comparisonLabel(range: AnalyticsRangeSelection): string {
    const span = range.kind === 'custom'
        ? daysBetween(range.from, range.to)
        : range.days
    return `vs previous ${span} day${span === 1 ? '' : 's'}`
}

/** Why a custom range is refused, or `null` when it is fine. Mirrors the
 *  server's rules so the user is told before the request goes out. */
export function customRangeError(from: string, to: string): string | null {
    if (!from || !to) return 'Pick both a start and an end date.'
    if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
        return 'Those dates could not be read.'
    }
    if (Date.parse(to) < Date.parse(from)) return 'The end date is before the start.'
    if (daysBetween(from, to) > MAX_RANGE_DAYS) {
        return `A range can span at most ${MAX_RANGE_DAYS} days.`
    }
    if (Date.parse(from) > Date.now()) return 'That range starts in the future.'
    return null
}

export function RangePicker({
    range, onChange, isFetching, className,
}: {
    range: AnalyticsRangeSelection
    onChange: (next: AnalyticsRangeSelection) => void
    isFetching?: boolean
    className?: string
}) {
    const [open, setOpen] = useState(false)
    const popoverRef = useRef<HTMLDivElement>(null)
    const custom = range.kind === 'custom'

    return (
        <div className={cn('flex items-center gap-2', className)}>
            <div
                role="group"
                aria-label="Date range"
                className="inline-flex items-center rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-sm"
            >
                {RANGE_PRESETS.map((preset) => {
                    const active = !custom && preset.days === range.days
                    return (
                        <button
                            key={preset.days}
                            type="button"
                            onClick={() => onChange({ kind: 'preset', days: preset.days })}
                            aria-pressed={active}
                            title={preset.title}
                            className={cn(
                                'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                active
                                    ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-sm'
                                    : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                            )}
                        >
                            {preset.label}
                        </button>
                    )
                })}

                {/* Hairline before the custom range, so the presets read as one
                    set and this reads as the escape hatch from it. */}
                <span className="mx-1 h-5 w-px bg-glass-border" aria-hidden />

                <div className="relative">
                    <button
                        type="button"
                        onClick={() => setOpen((v) => !v)}
                        aria-expanded={open}
                        aria-haspopup="dialog"
                        title="Custom date range"
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                            custom
                                ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-sm'
                                : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                    >
                        <CalendarRange className="w-3.5 h-3.5" />
                        {custom ? `${range.from} → ${range.to}` : 'Custom'}
                    </button>

                    {open && (
                        <CustomRangePopover
                            ref={popoverRef}
                            initial={custom ? range : null}
                            onClose={() => setOpen(false)}
                            onApply={(from, to) => {
                                onChange({ kind: 'custom', from, to })
                                setOpen(false)
                            }}
                        />
                    )}
                </div>
            </div>

            {/* A refetch holds the previous render; this ring is the only cue
                that anything is happening, so charts never flash a skeleton. */}
            {isFetching && (
                <span
                    role="status"
                    aria-label="Refreshing"
                    className="w-3.5 h-3.5 rounded-full border-2 border-indigo-500/60 border-t-transparent animate-spin"
                />
            )}
        </div>
    )
}

function fmtDay(iso: string): string {
    return new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, {
        day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
    })
}

function quarterBounds(anchor: { y: number; m: number }): { from: string; to: string } {
    const start = { y: anchor.y, m: Math.floor(anchor.m / 3) * 3 }
    return { from: monthBounds(start).from, to: monthBounds(addMonths(start, 2)).to }
}

/** Named periods the trailing-N-day presets structurally cannot express. The
 *  presets all end today; "how did March compare to April" ends in the past,
 *  and typing both boundaries by hand was the only way to ask it. Longest of
 *  these is a quarter, so none can breach `MAX_RANGE_DAYS`. */
function shortcutsFor(today: string): { label: string; from: string; to: string }[] {
    const here = monthOf(today)
    const clamp = (r: { from: string; to: string }) => ({
        from: r.from, to: r.to > today ? today : r.to,
    })
    return [
        { label: 'This month', ...clamp(monthBounds(here)) },
        { label: 'Last month', ...clamp(monthBounds(addMonths(here, -1))) },
        { label: 'This quarter', ...clamp(quarterBounds(here)) },
        { label: 'Last quarter', ...clamp(quarterBounds(addMonths(here, -3))) },
    ]
}

function CustomRangePopover({
    ref, initial, onApply, onClose,
}: {
    ref: React.RefObject<HTMLDivElement | null>
    initial: { from: string; to: string } | null
    onApply: (from: string, to: string) => void
    onClose: () => void
}) {
    const today = todayIso()
    const [from, setFrom] = useState(initial?.from ?? '')
    const [to, setTo] = useState(initial?.to ?? '')
    // A half-made range cannot be invalid — it is unfinished, and the footer
    // says so. Only a complete pair is worth an error, and the cap is the only
    // one the grid does not already prevent.
    const error = from && to ? customRangeError(from, to) : null
    const complete = Boolean(from && to && !error)

    // Escape closes, and a click anywhere outside does too — the same two exits
    // every other popover in the app offers.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        const onDown = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('keydown', onKey)
        document.addEventListener('mousedown', onDown)
        return () => {
            document.removeEventListener('keydown', onKey)
            document.removeEventListener('mousedown', onDown)
        }
    }, [onClose, ref])

    const select = (nextFrom: string, nextTo: string) => {
        setFrom(nextFrom)
        setTo(nextTo)
    }

    return (
        <div
            ref={ref}
            role="dialog"
            aria-label="Custom date range"
            className="absolute right-0 top-full z-50 mt-2 w-[20.5rem] sm:w-[34rem] rounded-2xl border border-glass-border bg-canvas-elevated p-4 shadow-xl animate-in fade-in slide-in-from-top-1 duration-150"
        >
            <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-bold text-ink">Custom range</h3>
                <button
                    type="button" onClick={onClose} aria-label="Close"
                    className="p-1 rounded-lg text-ink-muted hover:bg-black/5 dark:hover:bg-white/5"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="flex flex-wrap gap-1.5 mb-3">
                {shortcutsFor(today).map((s) => {
                    const active = s.from === from && s.to === to
                    return (
                        <button
                            key={s.label}
                            type="button"
                            aria-pressed={active}
                            onClick={() => select(s.from, s.to)}
                            className={cn(
                                'rounded-lg border px-2 py-1 text-[11px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                active
                                    ? 'border-indigo-500/40 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300'
                                    : 'border-glass-border bg-black/[0.03] dark:bg-white/[0.04] text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/10',
                            )}
                        >
                            {s.label}
                        </button>
                    )
                })}
            </div>

            <RangeCalendar
                from={from} to={to} today={today}
                maxSpanDays={MAX_RANGE_DAYS}
                onSelect={select}
            />

            <div className="mt-3 pt-3 border-t border-glass-border">
                {/* The readout is the picker's own state in words. A grid can
                    show a band without ever saying how long it is, and "how
                    long" is usually the reason someone opened this. */}
                <p className="text-[11px] font-semibold text-ink" aria-live="polite">
                    {complete
                        ? `${fmtDay(from)} → ${fmtDay(to)}`
                        : from
                            ? `${fmtDay(from)} → pick the end date`
                            : 'Pick a start date'}
                </p>
                <p className="mt-0.5 text-[11px] text-ink-muted">
                    {complete
                        ? `${daysBetween(from, to)} days, both included · compared against the ${daysBetween(from, to)} days before`
                        : 'Both dates are included in the range.'}
                </p>
            </div>

            {error && (
                <p role="alert" className="mt-2 text-[11px] font-medium text-rose-600 dark:text-rose-400">
                    {error}
                </p>
            )}

            <button
                type="button"
                disabled={!complete}
                onClick={() => onApply(from, to)}
                className="mt-3 w-full flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 px-3 py-2 text-xs font-semibold text-white shadow-sm transition-opacity disabled:opacity-40 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
            >
                <Check className="w-3.5 h-3.5" /> Apply range
            </button>
        </div>
    )
}
