/**
 * PulseMatrix — each workspace, period by period: how alive is it?
 *
 * Workspaces down the side, busiest first; the window's periods across. Each
 * cell is that workspace's activity in that period, on the ordinal ramp and
 * SNAPPED to its steps, relative to the busiest cell on the grid — so a team
 * that went quiet in week three shows as a gap in its own row, which a total
 * per workspace would average away.
 *
 * Colour is not the only channel: every cell carries its count in a tooltip,
 * each row ends with its total, and the frame's table twin holds the grid.
 */
import { cn } from '@/lib/utils'
import { compact, exact, shortDate } from '@/lib/formatMetric'
import { useChartTheme } from './chartTheme'

export interface PulseMatrixRow {
    id: string
    /** The name, as a node so it can be a link or a locked name. */
    label: React.ReactNode
    /** The name as text, for cell tooltips. */
    title: string
    values: number[]
    total: number
}

/** Past this many periods only every other column is labelled. */
const DENSE = 16

export function PulseMatrix({ buckets, rows, unit = 'events', className }: {
    buckets: string[]
    rows: PulseMatrixRow[]
    /** Names the count, e.g. "events". */
    unit?: string
    className?: string
}) {
    const theme = useChartTheme()
    const max = Math.max(0, ...rows.flatMap((r) => r.values))
    const every = buckets.length > DENSE ? Math.ceil(buckets.length / 8) : 1

    return (
        <div className={cn('overflow-x-auto', className)}>
            <table className="w-full border-separate border-spacing-[2px] text-[10px]">
                <thead>
                    <tr>
                        <th scope="col" className="text-left font-semibold text-ink-muted pr-2 pb-1">Workspace</th>
                        {buckets.map((b, i) => (
                            <th key={b} scope="col" className="font-semibold text-ink-muted pb-1 whitespace-nowrap">
                                {i % every === 0 ? shortDate(b) : <span className="sr-only">{shortDate(b)}</span>}
                            </th>
                        ))}
                        <th scope="col" className="text-right font-semibold text-ink-muted pl-2 pb-1">Total</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.id}>
                            <th scope="row" className="text-left font-medium text-ink-secondary pr-2">
                                {/* Truncated inside a block: table cells ignore max-width. */}
                                <span className="block max-w-[12rem] truncate">{row.label}</span>
                            </th>
                            {buckets.map((b, i) => {
                                const count = row.values[i] ?? 0
                                const step = max > 0
                                    ? Math.min(theme.ramp.length - 1, Math.floor((count / max) * theme.ramp.length))
                                    : 0
                                return (
                                    <td
                                        key={b}
                                        title={`${row.title}, ${shortDate(b, true)}: ${exact(count)} ${unit}`}
                                        className={cn(
                                            'h-5 min-w-[12px] rounded-[3px]',
                                            count === 0 && 'bg-black/[0.035] dark:bg-white/[0.04]',
                                        )}
                                        style={count > 0 ? { backgroundColor: theme.ramp[step] } : undefined}
                                    />
                                )
                            })}
                            <td className="pl-2 text-right font-semibold tabular-nums text-ink-secondary">
                                {compact(row.total)}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
