/**
 * The insight band: what the selection below it adds up to.
 *
 * Every figure here is computed under the same filters as the timeline, so
 * the band describes the list a reader is looking at, not the platform at
 * large. Each leaderboard row is a drill-in: it narrows the whole explorer to
 * that person, source or action rather than opening somewhere else.
 *
 * Numbers before pictures: the four KPIs answer "how much, and is that more
 * than usual"; the volume chart and the punchcard answer "what kind" and
 * "when"; the leaderboards answer "who" and "where"; the reasons answer "why".
 */
import { useMemo } from 'react'
import { Activity, Hand, MessageSquareQuote, Users } from 'lucide-react'

import { KpiCard } from '@/components/analytics/KpiCard'
import { Leaderboard, type LeaderboardRow } from '@/components/analytics/Leaderboard'
import { comparisonLabel } from '@/components/analytics/RangePicker'
import { ChartFrame } from '@/components/analytics/charts/ChartFrame'
import { ChartTable } from '@/components/analytics/charts/ChartTable'
import { PunchcardGrid } from '@/components/analytics/charts/PunchcardGrid'
import { punchcardTable } from '@/components/analytics/charts/punchcard'
import { StackedAreaChart } from '@/components/analytics/charts/StackedAreaChart'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import { Skeleton } from '@/components/ui/Skeleton'
import { compact, exact, percent, shortDate } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import type { ActivitySummary } from '@/services/activityService'

import { CATEGORY_META, cadencePhrase } from './activityMeta'
import type { ActivityParams } from './useActivityParams'

/** The server's delta is a ratio; a KPI card shows percent. */
const pct = (delta: number | null) => (delta === null ? null : delta * 100)

export function ActivityInsightBand({ summary, isLoading, isStale, error, params }: {
    summary?: ActivitySummary
    isLoading: boolean
    isStale: boolean
    error: Error | null
    params: ActivityParams
}) {
    const theme = useChartTheme()

    const totalsByBucket = useMemo(() => {
        if (!summary) return []
        return summary.window.buckets.map((_, i) =>
            summary.volume.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
    }, [summary])

    if (error && !summary) {
        return (
            <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-700 dark:text-red-300">
                The summary could not be loaded: {error.message}
            </p>
        )
    }
    if (isLoading || !summary) {
        return (
            <div aria-busy className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
            </div>
        )
    }

    const { totals, window } = summary
    const vs = comparisonLabel(params.range)
    const weekly = window.granularity === 'week'
    const formatBucket = (b: string) => (weekly ? `Week of ${shortDate(b, true)}` : shortDate(b, true))
    const series = summary.volume.map((v) => ({
        key: v.category,
        label: CATEGORY_META[v.category]?.label ?? v.category,
        values: v.values,
        slot: CATEGORY_META[v.category]?.slot ?? 0,
    }))

    const people: LeaderboardRow[] = summary.topPeople.map((p) => ({
        id: p.id,
        label: <span className={p.name || p.email ? undefined : 'font-mono text-[11px]'}>{p.name || p.email || p.id}</span>,
        meta: p.deleted ? 'Deleted account' : (p.name && p.email ? p.email : undefined),
        value: p.count,
    }))
    const sources: LeaderboardRow[] = summary.handsOnSources.map((s) => ({
        id: s.dataSourceId,
        label: s.name || <span className="font-mono text-[11px]">{s.dataSourceId}</span>,
        meta: s.workspaceName ?? undefined,
        value: s.count,
        detail: [cadencePhrase(s.medianGapHours), `last ${timeAgo(s.lastAt)}`].filter(Boolean).join(' · '),
    }))
    const actions: LeaderboardRow[] = summary.topActions.map((a) => ({
        id: a.type,
        label: a.label,
        meta: CATEGORY_META[a.category]?.label,
        value: a.count,
    }))

    return (
        <section aria-label="Activity insights" className="space-y-4">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Events"
                    value={compact(totals.events.current)}
                    changePct={pct(totals.events.delta)}
                    comparisonLabel={vs}
                    icon={Activity}
                    trend={totalsByBucket}
                    accent="indigo"
                />
                <KpiCard
                    label="People active"
                    value={exact(totals.people.current)}
                    changePct={pct(totals.people.delta)}
                    comparisonLabel={vs}
                    icon={Users}
                    accent="cyan"
                />
                <KpiCard
                    label="Operations by hand"
                    value={exact(totals.operations.current)}
                    changePct={pct(totals.operations.delta)}
                    comparisonLabel={vs}
                    sub="Runs, refreshes and reconciliations people started"
                    icon={Hand}
                    accent="amber"
                    // More manual work is not good news: it is toil.
                    higherIsBetter={false}
                />
                <KpiCard
                    label="Changes with a reason"
                    value={totals.reasons.share === null ? '—' : percent(totals.reasons.share)}
                    sub={totals.reasons.of
                        ? `${exact(totals.reasons.given)} of ${exact(totals.reasons.of)} changes said why`
                        : 'No changes in this range'}
                    icon={MessageSquareQuote}
                    accent="emerald"
                />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="What happened, by kind"
                    subtitle={weekly ? 'Events per week' : 'Events per day'}
                    className="xl:col-span-2"
                    isStale={isStale}
                    isEmpty={totalsByBucket.every((n) => n === 0)}
                    emptyLabel="Nothing recorded in this range."
                    series={series.map((s) => ({
                        key: s.key, label: s.label, color: theme.series[s.slot], shape: 'area' as const,
                    }))}
                    table={(
                        <ChartTable
                            rowLabel={weekly ? 'Week' : 'Day'}
                            rows={window.buckets.map(formatBucket)}
                            columns={series.map((s) => ({ key: s.key, label: s.label, values: s.values }))}
                            caption="Events per bucket, by category"
                        />
                    )}
                >
                    <StackedAreaChart buckets={window.buckets} series={series} formatBucket={formatBucket} height={220} />
                </ChartFrame>

                <ChartFrame
                    title="When it happens"
                    subtitle="Weekday × hour, UTC"
                    isStale={isStale}
                    table={(() => {
                        const t = punchcardTable(summary.punchcard)
                        return <ChartTable {...t} caption="Events per weekday and hour, UTC" />
                    })()}
                >
                    <PunchcardGrid grid={summary.punchcard} />
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <ChartFrame title="Most active people" subtitle="Who did the most — select one to see their activity" isStale={isStale}>
                    <Leaderboard
                        rows={people}
                        unit="events"
                        slot={2}
                        emptyLabel="No one acted in this range."
                        onRowClick={(row) => params.patch({ person: row.id, role: 'actor' })}
                    />
                </ChartFrame>
                <ChartFrame
                    title="Most hands-on sources"
                    subtitle={summary.cadenceCapped
                        ? 'Manual operations per source — from the most recent 10,000'
                        : 'Manual operations per source, and how often'}
                    isStale={isStale}
                >
                    <Leaderboard
                        rows={sources}
                        unit="operations"
                        slot={0}
                        emptyLabel="No one operated a source by hand in this range."
                        onRowClick={(row) => params.patch({ dataSource: row.id })}
                    />
                </ChartFrame>
                <ChartFrame title="Most frequent actions" subtitle="Select one to see every time it happened" isStale={isStale}>
                    <Leaderboard
                        rows={actions}
                        unit="times"
                        emptyLabel="Nothing happened in this range."
                        onRowClick={(row) => params.patch({ types: row.id })}
                    />
                </ChartFrame>
            </div>

            {summary.topReasons.length > 0 && (
                <ChartFrame title="Why, in their words" subtitle="The reasons given most often" isStale={isStale}>
                    <ul className="flex flex-wrap gap-2">
                        {summary.topReasons.map((r) => (
                            <li
                                key={r.reason}
                                className="inline-flex items-center gap-2 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-3 py-1.5"
                            >
                                <span className="text-xs text-ink">“{r.reason}”</span>
                                <span className="text-[10px] font-semibold tabular-nums text-ink-muted">×{exact(r.count)}</span>
                            </li>
                        ))}
                    </ul>
                </ChartFrame>
            )}
        </section>
    )
}
