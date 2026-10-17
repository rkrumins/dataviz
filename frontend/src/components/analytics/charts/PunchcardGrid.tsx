/**
 * PunchcardGrid — weekday × hour, how much happened when.
 *
 * Magnitude, so it takes the ordinal ramp like the cohort heatmap: one hue,
 * deepening with volume, each count SNAPPED to a ramp step so neighbouring
 * cells stay distinguishable. Colour is not the only channel: every cell
 * carries its count in a tooltip, the busiest slot is named in words beneath
 * the grid, and `punchcardTable` gives the card its table twin.
 *
 * Hours are UTC, and the grid says so: a team spread across time zones reads
 * "14:00" differently, and only one of those readings is the data.
 */
import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { useChartTheme } from './chartTheme'
import { WEEKDAYS, busiestSlot, hourLabel } from './punchcard'

export function PunchcardGrid({ grid, unit = 'events', className }: {
    grid: number[][]
    /** Names the count, e.g. "events". */
    unit?: string
    className?: string
}) {
    const theme = useChartTheme()
    const max = Math.max(0, ...grid.flat())
    const best = busiestSlot(grid)

    return (
        <div className={cn('space-y-2', className)}>
            <div className="overflow-x-auto">
                <table className="w-full border-separate border-spacing-[2px] text-[10px]">
                    <thead>
                        <tr>
                            {/* The corner names the clock the hours are on. */}
                            <th scope="col" className="w-9 text-left text-[9px] font-bold tracking-wide text-ink-muted">
                                UTC<span className="sr-only"> hour, by weekday</span>
                            </th>
                            {Array.from({ length: 24 }, (_, h) => (
                                <th key={h} scope="col" className="font-semibold text-ink-muted pb-0.5 tabular-nums">
                                    {/* Every third hour labelled; the rest stay
                                        legible as positions between them. */}
                                    {h % 3 === 0 ? String(h).padStart(2, '0') : <span className="sr-only">{hourLabel(h)}</span>}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {WEEKDAYS.map((day, d) => (
                            <tr key={day}>
                                <th scope="row" className="text-left font-medium text-ink-secondary pr-1 whitespace-nowrap">
                                    {day.slice(0, 3)}
                                </th>
                                {Array.from({ length: 24 }, (_, h) => {
                                    const count = grid[d]?.[h] ?? 0
                                    const step = max > 0
                                        ? Math.min(theme.ramp.length - 1, Math.floor((count / max) * theme.ramp.length))
                                        : 0
                                    return (
                                        <td
                                            key={h}
                                            title={`${day} ${hourLabel(h)}–${hourLabel((h + 1) % 24)} UTC: ${exact(count)} ${unit}`}
                                            className={cn(
                                                'h-4 min-w-[10px] rounded-[3px]',
                                                count === 0 && 'bg-black/[0.035] dark:bg-white/[0.04]',
                                            )}
                                            style={count > 0 ? { backgroundColor: theme.ramp[step] } : undefined}
                                        />
                                    )
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <p className="text-[11px] text-ink-muted">
                {best
                    ? <>Busiest: <span className="font-semibold text-ink-secondary">{WEEKDAYS[best.day]} {hourLabel(best.hour)} UTC</span> · {exact(best.count)} {unit}</>
                    : 'Nothing recorded in this range.'}
            </p>
        </div>
    )
}
