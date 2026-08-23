/**
 * ChartFrame — the chrome every Analytics chart wears.
 *
 * Title, subtitle, legend, and the table-view toggle live here so no chart has
 * to re-invent them and none can quietly ship without them.
 *
 * The table toggle is not a nicety. A tooltip ENHANCES a chart, it must never
 * GATE it: colour-only encoding on a continuous scale is unreadable for some
 * people and unreachable for a screen reader, so every chart carries a
 * WCAG-clean twin one click away. `ChartTable` renders it from the same data
 * the marks were drawn from, so the two cannot disagree.
 *
 * A legend is present whenever there are two or more series. One series gets
 * none — the title already names it, and a box with a single swatch just
 * restates the heading.
 */
import { useId, useState } from 'react'
import { BarChart3, Table2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { MARK } from './chartTheme'

export interface ChartSeriesMeta {
    key: string
    label: string
    color: string
    /** Legends mirror the mark: a rule for lines, a swatch for bars/areas. */
    shape?: 'line' | 'area' | 'bar'
}

interface Props {
    title: string
    subtitle?: string
    series?: ChartSeriesMeta[]
    /** Rendered when there is genuinely nothing to plot. */
    isEmpty?: boolean
    emptyLabel?: string
    /** The accessible table twin. Omit only for charts that are already text. */
    table?: React.ReactNode
    /**
     * Names the faded previous-period line, for charts that draw one.
     *
     * Without it a single-series chart showing a ghost puts two lines on the
     * plot and no key beside them, which is a puzzle rather than a comparison.
     * The swatch is derived here — from the first series' colour at the ghost's
     * own opacity — so the legend and the mark cannot drift apart.
     */
    ghostLabel?: string
    /** Held at reduced opacity while a new range loads — never a skeleton. */
    isStale?: boolean
    action?: React.ReactNode
    className?: string
    children: React.ReactNode
}

export function ChartFrame({
    title, subtitle, series = [], isEmpty, emptyLabel, table, ghostLabel,
    isStale, action, className, children,
}: Props) {
    const [showTable, setShowTable] = useState(false)
    const headingId = useId()
    const legend: (ChartSeriesMeta & { faded?: boolean })[] = ghostLabel && series[0]
        ? [...series, {
            key: '__ghost', label: ghostLabel, color: series[0].color,
            // The ghost mirrors whatever it is a comparison FOR: a hatched
            // chip beside bars, a faint rule beside anything drawn as a line —
            // which is what an AREA chart's ghost is too.
            shape: series[0].shape === 'bar' ? 'bar' : 'line', faded: true,
        }]
        : series

    return (
        <section
            aria-labelledby={headingId}
            className={cn(
                'rounded-2xl border border-glass-border bg-canvas-elevated p-5 shadow-sm',
                className,
            )}
        >
            <header className="flex items-start justify-between gap-4 mb-4">
                <div className="min-w-0">
                    <h3 id={headingId} className="text-sm font-bold text-ink leading-tight">
                        {title}
                    </h3>
                    {subtitle && (
                        <p className="text-xs text-ink-muted mt-0.5">{subtitle}</p>
                    )}
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                    {action}
                    {table && (
                        <button
                            type="button"
                            onClick={() => setShowTable((v) => !v)}
                            aria-pressed={showTable}
                            title={showTable ? 'Show chart' : 'Show data table'}
                            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                        >
                            {showTable
                                ? <BarChart3 className="w-3.5 h-3.5" />
                                : <Table2 className="w-3.5 h-3.5" />}
                            <span className="sr-only">
                                {showTable ? 'Show chart' : 'Show data table'}
                            </span>
                        </button>
                    )}
                </div>
            </header>

            {/* Two or more MARKS always get a legend — identity is never colour
                alone, and a ghost is a mark like any other. The swatch mirrors
                the mark it stands for. */}
            {legend.length > 1 && !showTable && (
                <ul className="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-3">
                    {legend.map((s) => (
                        <li key={s.key} className="flex items-center gap-1.5">
                            <span
                                aria-hidden
                                className={cn(
                                    'shrink-0',
                                    s.shape === 'line'
                                        ? 'w-3.5 h-[2px] rounded-full'
                                        : 'w-2.5 h-2.5 rounded-[3px]',
                                )}
                                style={
                                    // A faded BAR is drawn hatched and outlined
                                    // on the plot, so its key is too. A solid
                                    // chip at low opacity would be a key for a
                                    // mark that is not on the chart.
                                    s.faded && s.shape === 'bar'
                                        ? {
                                            border: `1px solid ${s.color}`,
                                            backgroundImage: `repeating-linear-gradient(45deg, ${s.color} 0 1.5px, transparent 1.5px 4px)`,
                                            opacity: 0.55,
                                        }
                                        : { backgroundColor: s.color, opacity: s.faded ? MARK.ghostOpacity : 1 }
                                }
                            />
                            <span className={cn(
                                'text-[11px] font-medium',
                                s.faded ? 'text-ink-muted' : 'text-ink-secondary',
                            )}>
                                {s.label}
                            </span>
                        </li>
                    ))}
                </ul>
            )}

            <div className={cn('transition-opacity duration-200', isStale && 'opacity-50')}>
                {isEmpty
                    ? <ChartEmpty label={emptyLabel} />
                    : showTable && table
                        ? table
                        : children}
            </div>
        </section>
    )
}

export function ChartEmpty({ label }: { label?: string }) {
    return (
        <div className="h-40 flex flex-col items-center justify-center text-center gap-1.5">
            <div className="w-9 h-9 rounded-xl bg-black/5 dark:bg-white/5 flex items-center justify-center">
                <BarChart3 className="w-4 h-4 text-ink-muted" />
            </div>
            <p className="text-xs text-ink-muted max-w-[22rem]">
                {label ?? 'Nothing recorded in this range yet.'}
            </p>
        </div>
    )
}
