/**
 * AdoptionMatrix — which features anyone actually uses.
 *
 * The rows are ordered value-first: tracing lineage is what this platform is
 * FOR, so it leads, and a reader scanning top-to-bottom sees the core action
 * before the peripheral ones.
 *
 * ONE colour for every bar. Ranking bars by a colour ramp double-encodes the
 * length as hue, burns the only free channel on information the bar already
 * carries, and fails colour-vision separation by construction — these are
 * nominal categories, not an ordered scale.
 *
 * A feature with no instrumentation history says so ("not measured yet")
 * rather than rendering a zero. Zero and unmeasured look identical on a chart
 * and mean opposite things: one is "nobody wants this", the other is "we
 * haven't been counting".
 */
import { CircleDashed } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, percent, signedPercent } from '@/lib/formatMetric'
import { useChartTheme } from './charts/chartTheme'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import type { AdoptionRow } from '@/services/analyticsService'

export function AdoptionMatrix({
    rows, subtitle, className,
}: {
    rows: AdoptionRow[]
    subtitle?: string
    className?: string
}) {
    const theme = useChartTheme()
    const peak = Math.max(1, ...rows.map((r) => r.events))
    const measured = rows.filter((r) => r.since !== null)

    return (
        <ChartFrame
            title="Feature adoption"
            subtitle={subtitle ?? 'What people actually do, not just where they land'}
            className={className}
            table={
                <ChartTable
                    rowLabel="Feature"
                    rows={rows.map((r) => r.label)}
                    caption="Feature usage over the selected range."
                    columns={[
                        { key: 'events', label: 'Uses', values: rows.map((r) => r.events) },
                        { key: 'users', label: 'People', values: rows.map((r) => r.users) },
                        {
                            key: 'reach', label: 'Reach',
                            values: rows.map((r) => r.reach == null ? '—' : percent(r.reach)),
                        },
                        {
                            key: 'change', label: 'Change',
                            values: rows.map((r) => r.since === null
                                ? 'not measured'
                                : (signedPercent(r.changePct) ?? '—')),
                        },
                    ]}
                />
            }
        >
            {measured.length === 0 ? (
                <p className="py-6 text-center text-xs text-ink-muted">
                    No feature usage recorded yet. Signals start accruing from the
                    day instrumentation ships.
                </p>
            ) : (
                <ul className="space-y-2.5">
                    {rows.map((row) => {
                        const unmeasured = row.since === null
                        const width = unmeasured
                            ? 0
                            : Math.max(2, (row.events / peak) * 100)
                        const delta = signedPercent(row.changePct)
                        return (
                            <li key={row.key}>
                                <div className="flex items-baseline justify-between gap-3 mb-1">
                                    <span className="text-xs font-semibold text-ink truncate">
                                        {row.label}
                                    </span>
                                    <span className="flex items-baseline gap-2 shrink-0">
                                        {unmeasured ? (
                                            <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                                                <CircleDashed className="h-3 w-3" />
                                                not measured yet
                                            </span>
                                        ) : (
                                            <>
                                                <span className="text-xs font-bold text-ink tabular-nums">
                                                    {compact(row.events)}
                                                </span>
                                                <span className="text-[11px] text-ink-muted tabular-nums">
                                                    {compact(row.users)}{' '}
                                                    {row.users === 1 ? 'person' : 'people'}
                                                    {row.reach != null && ` · ${percent(row.reach)} reach`}
                                                </span>
                                                {delta && (
                                                    <span
                                                        className={cn(
                                                            'text-[11px] font-semibold tabular-nums',
                                                            (row.changePct ?? 0) > 0
                                                                ? 'text-emerald-600 dark:text-emerald-400'
                                                                : 'text-rose-600 dark:text-rose-400',
                                                        )}
                                                    >
                                                        {delta}
                                                    </span>
                                                )}
                                            </>
                                        )}
                                    </span>
                                </div>
                                <div className="h-2 w-full overflow-hidden rounded-full bg-black/[0.04] dark:bg-white/[0.06]">
                                    {!unmeasured && (
                                        <div
                                            className="h-full rounded-full transition-[width] duration-500"
                                            style={{
                                                width: `${width}%`,
                                                // One colour for every bar — see
                                                // the note at the top of the file.
                                                background: theme.series[0],
                                            }}
                                        />
                                    )}
                                </div>
                            </li>
                        )
                    })}
                </ul>
            )}
        </ChartFrame>
    )
}
