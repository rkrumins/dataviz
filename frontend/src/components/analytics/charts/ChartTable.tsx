/**
 * ChartTable — the WCAG-clean twin of a chart.
 *
 * Rendered from the same arrays the marks were drawn from, so it cannot drift
 * from what is plotted. Numbers align in columns, so this is the one place
 * `tabular-nums` belongs (a large standalone figure uses proportional digits —
 * equal-width digits make `121` look loose at display size).
 */
import { exact } from '@/lib/formatMetric'

interface Props {
    /** Row header column — bucket dates, category names, whatever the x is. */
    rowLabel: string
    rows: string[]
    columns: { key: string; label: string; values: (number | string | null)[] }[]
    caption?: string
}

export function ChartTable({ rowLabel, rows, columns, caption }: Props) {
    return (
        <div className="max-h-72 overflow-auto rounded-xl border border-glass-border">
            <table className="w-full text-xs">
                {caption && <caption className="sr-only">{caption}</caption>}
                <thead className="sticky top-0 bg-canvas-elevated">
                    <tr className="border-b border-glass-border">
                        <th scope="col" className="text-left font-semibold text-ink-secondary px-3 py-2">
                            {rowLabel}
                        </th>
                        {columns.map((c) => (
                            <th key={c.key} scope="col"
                                className="text-right font-semibold text-ink-secondary px-3 py-2">
                                {c.label}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={`${row}-${i}`} className="border-b border-glass-border last:border-b-0">
                            <th scope="row" className="text-left font-medium text-ink-secondary px-3 py-1.5 whitespace-nowrap">
                                {row}
                            </th>
                            {columns.map((c) => (
                                <td key={c.key} className="text-right tabular-nums text-ink px-3 py-1.5">
                                    {typeof c.values[i] === 'number'
                                        ? exact(c.values[i] as number)
                                        : (c.values[i] ?? '—')}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}
