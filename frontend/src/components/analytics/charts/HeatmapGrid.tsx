/**
 * HeatmapGrid — signup-week × weeks-active retention cohorts.
 *
 * A grid of magnitude, so it takes the ordinal ramp: one hue, deepening with
 * retention. Colour is never the only channel — every cell shows its own
 * percentage, and the table twin behind `ChartFrame` carries the whole grid as
 * text.
 *
 * Cells are separated by the surface, not by borders, and each carries a
 * `title` so a pointer anywhere in the cell reveals the underlying counts.
 */
import { cn } from '@/lib/utils'
import { exact, percent, shortDate } from '@/lib/formatMetric'
import { useChartTheme } from './chartTheme'

export interface Cohort {
    cohort: string
    size: number
    weeks: { week: number; active: number; rate: number | null }[]
}

/** Ink that clears contrast against a filled cell. */
function inkOn(hex: string): string {
    const n = parseInt(hex.slice(1), 16)
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
        const v = c / 255
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return luminance > 0.4 ? '#0f172a' : '#ffffff'
}

export function HeatmapGrid({ cohorts, className }: { cohorts: Cohort[]; className?: string }) {
    const theme = useChartTheme()
    const span = Math.max(1, ...cohorts.map((c) => c.weeks.length))

    return (
        <div className={cn('overflow-x-auto', className)}>
            <table className="border-separate border-spacing-0.5 text-[10px]">
                <thead>
                    <tr>
                        <th scope="col" className="text-left font-semibold text-ink-muted pr-3 pb-1 whitespace-nowrap">
                            Cohort
                        </th>
                        <th scope="col" className="text-right font-semibold text-ink-muted pr-3 pb-1">
                            Size
                        </th>
                        {Array.from({ length: span }, (_, i) => (
                            <th key={i} scope="col" className="font-semibold text-ink-muted pb-1 w-11">
                                W{i}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {cohorts.map((c) => (
                        <tr key={c.cohort}>
                            <th scope="row" className="text-left font-medium text-ink-secondary pr-3 whitespace-nowrap">
                                {shortDate(c.cohort, true)}
                            </th>
                            <td className="text-right text-ink-secondary tabular-nums pr-3">
                                {exact(c.size)}
                            </td>
                            {Array.from({ length: span }, (_, i) => {
                                const cell = c.weeks.find((w) => w.week === i)
                                if (!cell) {
                                    return <td key={i} className="h-7 rounded-md bg-black/[0.02] dark:bg-white/[0.02]" />
                                }
                                const rate = cell.rate ?? 0
                                // Snap the rate onto a ramp step — discrete
                                // levels stay distinguishable where a continuous
                                // interpolation blurs adjacent cells together.
                                const step = Math.min(
                                    theme.ramp.length - 1,
                                    Math.floor(rate * theme.ramp.length),
                                )
                                const fill = theme.ramp[step]
                                return (
                                    <td
                                        key={i}
                                        title={`${shortDate(c.cohort, true)} · week ${i}: ${exact(cell.active)} of ${exact(c.size)} active (${percent(rate)})`}
                                        className="h-7 rounded-md text-center tabular-nums font-semibold"
                                        style={{
                                            backgroundColor: rate > 0 ? fill : undefined,
                                            // Chosen from the fill's actual
                                            // luminance, not its index: the two
                                            // ramps run in opposite directions,
                                            // so any index rule is wrong in one
                                            // mode.
                                            color: rate > 0 ? inkOn(fill) : undefined,
                                        }}
                                    >
                                        <span className={rate > 0 ? undefined : 'text-ink-muted'}>
                                            {percent(rate)}
                                        </span>
                                    </td>
                                )
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
