/**
 * The punchcard's arithmetic, apart from its drawing: a 7 × 24 grid of counts,
 * Monday first, hours in UTC — the shape the server sends.
 */
/** Monday first, matching the server. */
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const

export const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`

/** The busiest weekday/hour, or null when nothing happened. */
export function busiestSlot(grid: number[][]): { day: number; hour: number; count: number } | null {
    let best: { day: number; hour: number; count: number } | null = null
    for (let day = 0; day < grid.length; day++) {
        for (let hour = 0; hour < (grid[day]?.length ?? 0); hour++) {
            const count = grid[day][hour]
            if (count > 0 && (best === null || count > best.count)) best = { day, hour, count }
        }
    }
    return best
}

/** Rows and columns for `ChartTable`: weekdays down, hours across. */
export function punchcardTable(grid: number[][]) {
    return {
        rowLabel: 'Weekday (UTC)',
        rows: WEEKDAYS.map((d) => d),
        columns: Array.from({ length: 24 }, (_, h) => ({
            key: String(h),
            label: hourLabel(h),
            values: WEEKDAYS.map((_, d) => grid[d]?.[h] ?? 0),
        })),
    }
}
