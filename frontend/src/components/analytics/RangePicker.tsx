/**
 * RangePicker — the one filter above everything it scopes.
 *
 * Presets as a segmented row, not a calendar: nobody wants to fight a date grid
 * for "last 30 days". These are the intervals people actually ask for, and they
 * scope EVERY chart, stat and table on the page, so the numbers always agree
 * with each other.
 *
 * Deliberately not per-chart. A chart that needs its own range is a different
 * dashboard.
 */
import { cn } from '@/lib/utils'

export const RANGE_PRESETS = [
    { days: 7, label: '7d', title: 'Last 7 days' },
    { days: 14, label: '14d', title: 'Last 14 days' },
    { days: 30, label: '30d', title: 'Last 30 days' },
    { days: 90, label: '90d', title: 'Last 90 days' },
    { days: 180, label: '6m', title: 'Last 6 months' },
    { days: 365, label: '1y', title: 'Last 12 months' },
] as const

export const DEFAULT_RANGE_DAYS = 30

export function rangeLabel(days: number): string {
    return RANGE_PRESETS.find((p) => p.days === days)?.title ?? `Last ${days} days`
}

/** "vs previous 30 days" — names what a delta is measured against. */
export function comparisonLabel(days: number): string {
    return `vs previous ${days} days`
}

export function RangePicker({
    days, onChange, isFetching, className,
}: {
    days: number
    onChange: (days: number) => void
    isFetching?: boolean
    className?: string
}) {
    return (
        <div className={cn('flex items-center gap-2', className)}>
            <div
                role="group"
                aria-label="Date range"
                className="inline-flex items-center rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-sm"
            >
                {RANGE_PRESETS.map((preset) => {
                    const active = preset.days === days
                    return (
                        <button
                            key={preset.days}
                            type="button"
                            onClick={() => onChange(preset.days)}
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
