/**
 * Leaderboard — a ranked list with a proportional bar behind each row.
 *
 * EVERY BAR IS THE SAME COLOUR. Shading them by value would double-encode the
 * bar's length as hue, burning the only free channel on information the length
 * already carries — and these categories (people, views, workspaces) have no
 * natural order to justify a ramp in the first place.
 *
 * The bar is a proportion of the leader, so the shape answers "how far ahead is
 * first?" at a glance; the exact numbers sit in the row, not on the bar.
 */
import { cn } from '@/lib/utils'
import { exact } from '@/lib/formatMetric'
import { useChartTheme } from './charts/chartTheme'

export interface LeaderboardRow {
    id: string
    /**
     * The name. Pass a node rather than a string to make it a link — see
     * `EntityLink`, which decides linkability from the same `canOpen` the
     * server computed, so a link can never point somewhere the app refuses.
     */
    label: React.ReactNode
    /** Secondary line — email, workspace, view type. */
    meta?: string
    value: number
    /** Extra columns, e.g. "12 opens · 3 created". */
    detail?: string
}

interface Props {
    rows: LeaderboardRow[]
    /** Names the number, e.g. "events". */
    unit: string
    /** Categorical slot for the bar. One slot for the whole list. */
    slot?: number
    emptyLabel?: string
    onRowClick?: (row: LeaderboardRow) => void
    className?: string
}

export function Leaderboard({
    rows, unit, slot = 0, emptyLabel, onRowClick, className,
}: Props) {
    const theme = useChartTheme()
    const max = Math.max(1, ...rows.map((r) => r.value))
    const color = theme.series[slot % theme.series.length]

    if (rows.length === 0) {
        return (
            <p className="py-8 text-center text-xs text-ink-muted">
                {emptyLabel ?? `Nothing to rank in this range yet.`}
            </p>
        )
    }

    return (
        <ol className={cn('space-y-0.5', className)}>
            {rows.map((row, i) => {
                const Tag = onRowClick ? 'button' : 'div'
                return (
                    <li key={row.id}>
                        <Tag
                            {...(onRowClick
                                ? { type: 'button' as const, onClick: () => onRowClick(row) }
                                : {})}
                            className={cn(
                                'relative w-full overflow-hidden rounded-lg px-2.5 py-2 text-left transition-colors',
                                onRowClick && 'hover:bg-black/[0.03] dark:hover:bg-white/[0.04] outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                            )}
                        >
                            <span
                                aria-hidden
                                className="absolute inset-y-0 left-0 rounded-lg opacity-[0.13]"
                                style={{
                                    width: `${Math.max((row.value / max) * 100, 1.5)}%`,
                                    backgroundColor: color,
                                }}
                            />
                            <span className="relative flex items-center gap-2.5">
                                <span className="w-4 shrink-0 text-[10px] font-bold text-ink-muted tabular-nums">
                                    {i + 1}
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-xs font-semibold text-ink">
                                        {row.label}
                                    </span>
                                    {row.meta && (
                                        <span className="block truncate text-[10px] text-ink-muted">
                                            {row.meta}
                                        </span>
                                    )}
                                </span>
                                <span className="shrink-0 text-right">
                                    <span className="block text-xs font-bold text-ink tabular-nums">
                                        {exact(row.value)}
                                        <span className="ml-1 text-[10px] font-medium text-ink-muted">
                                            {unit}
                                        </span>
                                    </span>
                                    {row.detail && (
                                        <span className="block text-[10px] text-ink-muted">
                                            {row.detail}
                                        </span>
                                    )}
                                </span>
                            </span>
                        </Tag>
                    </li>
                )
            })}
        </ol>
    )
}
