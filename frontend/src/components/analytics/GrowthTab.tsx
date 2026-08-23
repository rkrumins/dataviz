/**
 * GrowthTab — where new accounts come from, and whether they stay.
 */
import { useMemo } from 'react'
import { CalendarClock, UserPlus, Users, Boxes } from 'lucide-react'

import { exact, percent, shortDate } from '@/lib/formatMetric'
import type {
    AnalyticsRangeSelection, AnalyticsSummary,
} from '@/services/analyticsService'
import { signupSourceLabel } from '@/lib/domainLabels'
import { KpiCard } from './KpiCard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar } from './charts/StackedShareBar'
import { HeatmapGrid } from './charts/HeatmapGrid'
import { comparisonLabel, previousLabel, rangePhrase, rangeSpanDays } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function GrowthTab({
    data, range, isStale,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const theme = useChartTheme()
    const { totals, series, engagement, breakdowns } = data

    // Three cumulative totals whose magnitudes differ by more than an order of
    // magnitude — users in the thousands, workspaces in the tens. On a shared
    // axis the smallest is a flat line on the baseline, which reads as "no
    // growth" when it may be the fastest-growing of the three. Indexing every
    // line to 100 at the start of the window is the standard answer, and it is
    // the one that matches the question the frame asks: which is pulling ahead?
    // The table keeps the absolute counts beside the index so nothing is lost.
    const indexed = useMemo(() => {
        const toIndex = (values: number[]) => {
            const base = values.find((v) => v > 0) ?? 0
            return base === 0 ? values.map(() => 0) : values.map((v) => Math.round((v / base) * 100))
        }
        return {
            users: toIndex(series.cumulativeUsers),
            workspaces: toIndex(series.cumulativeWorkspaces),
            views: toIndex(series.cumulativeViews),
        }
    }, [series.cumulativeUsers, series.cumulativeWorkspaces, series.cumulativeViews])
    const vs = comparisonLabel(range)
    const growth = engagement.growthAccounting

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="New accounts" value={totals.users.current ?? 0} icon={UserPlus}
                    changePct={totals.users.changePct} comparisonLabel={vs}
                    trend={series.signups} accent="indigo"
                />
                <KpiCard
                    label="New workspaces" value={totals.workspaces.current ?? 0} icon={Boxes}
                    changePct={totals.workspaces.changePct} comparisonLabel={vs}
                    trend={series.workspacesCreated} trendTone="amber" accent="amber"
                />
                <KpiCard
                    label="Activation rate"
                    metric="activation"
                    value={percent(engagement.activationRate)}
                    icon={Users}
                    sub="new accounts that traced lineage"
                    accent="emerald"
                />
                <KpiCard
                    label="Time to first view"
                    metric="timeToValue"
                    value={engagement.medianDaysToFirstView === null
                        ? '—'
                        : `${engagement.medianDaysToFirstView}d`}
                    icon={CalendarClock}
                    sub="median, signup → first view"
                    higherIsBetter={false}
                    accent="cyan"
                />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    title="New accounts"
                    subtitle={`Signups per period over ${rangePhrase(range)}`}
                    isStale={isStale}
                    isEmpty={
                        // Both periods, not just this one: a chart that hid
                        // itself when the current window is flat would hide
                        // the very comparison explaining WHY it is flat.
                        series.signups.every((v) => v === 0)
                        && series.previous.signups.every((v) => v === 0)
                    }
                    emptyLabel="No signups in this range."
                    series={[{ key: 'signups', label: 'Signups', color: theme.series[0], shape: 'bar' }]}
                    ghostLabel={previousLabel(range)}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'signups', label: 'Signups', values: series.signups },
                                { key: 'prev', label: previousLabel(range), values: series.previous.signups },
                            ]}
                        />
                    }
                >
                    <BarSeriesChart
                        buckets={series.buckets} values={series.signups}
                        previous={series.previous.signups} label="signups"
                    />
                </ChartFrame>

                <ChartFrame
                    title="Cumulative growth, indexed"
                    subtitle="Each line starts at 100 — the question is which is pulling ahead"
                    isStale={isStale}
                    isEmpty={series.cumulativeUsers.every((v) => v === 0)}
                    series={[
                        { key: 'users', label: 'Users', color: theme.series[0], shape: 'line' },
                        { key: 'workspaces', label: 'Workspaces', color: theme.series[1], shape: 'line' },
                        { key: 'views', label: 'Views', color: theme.series[2], shape: 'line' },
                    ]}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'usersIdx', label: 'Users (index)', values: indexed.users },
                                { key: 'workspacesIdx', label: 'Workspaces (index)', values: indexed.workspaces },
                                { key: 'viewsIdx', label: 'Views (index)', values: indexed.views },
                                { key: 'users', label: 'Users', values: series.cumulativeUsers },
                                { key: 'workspaces', label: 'Workspaces', values: series.cumulativeWorkspaces },
                                { key: 'views', label: 'Views', values: series.cumulativeViews },
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[
                            { key: 'users', label: 'Users', values: indexed.users, slot: 0 },
                            { key: 'workspaces', label: 'Workspaces', values: indexed.workspaces, slot: 1 },
                            { key: 'views', label: 'Views', values: indexed.views, slot: 2 },
                        ]}
                        baseline={100}
                    />
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="How people arrive"
                    subtitle="Signup source across all accounts"
                    isStale={isStale}
                    isEmpty={breakdowns.usersBySignupSource.length === 0}
                >
                    <StackedShareBar slices={breakdowns.usersBySignupSource} labelOf={signupSourceLabel} />
                </ChartFrame>

                <ChartFrame
                    title="Account status"
                    subtitle="Where accounts sit in their lifecycle"
                    isStale={isStale}
                    isEmpty={breakdowns.usersByStatus.length === 0}
                >
                    <StackedShareBar slices={breakdowns.usersByStatus} />
                </ChartFrame>

                <ChartFrame
                    title="Growth accounting"
                    subtitle={`Where this period's active users came from`}
                    isStale={isStale}
                    isEmpty={
                        growth.new + growth.returning + growth.resurrected + growth.dormant === 0
                    }
                    emptyLabel="No activity to account for in this range."
                >
                    <dl className="space-y-2.5">
                        <GrowthRow label="New" hint="Signed up and were active in this period"
                                   value={growth.new} tone="emerald" />
                        <GrowthRow label="Returning" hint="Active in this period and the last one"
                                   value={growth.returning} tone="indigo" />
                        <GrowthRow label="Resurrected" hint="Back after sitting out the previous period"
                                   value={growth.resurrected} tone="cyan" />
                        <GrowthRow label="Went dormant" hint="Active last period, silent in this one"
                                   value={growth.dormant} tone="rose" />
                    </dl>
                </ChartFrame>
            </div>

            <ChartFrame
                title="Retention by signup cohort"
                subtitle="Share of each week's signups still active, week by week"
                isStale={isStale}
                isEmpty={engagement.cohorts.length === 0}
                emptyLabel={
                    rangeSpanDays(range) < 28
                        ? 'Cohort retention needs a longer range — try 30 days or more.'
                        : 'No signups in this range to follow.'
                }
                table={
                    <ChartTable
                        rowLabel="Cohort"
                        rows={engagement.cohorts.map((c) => shortDate(c.cohort, true))}
                        columns={Array.from(
                            { length: Math.max(1, ...engagement.cohorts.map((c) => c.weeks.length)) },
                            (_, i) => ({
                                key: `w${i}`,
                                label: `Week ${i}`,
                                values: engagement.cohorts.map(
                                    (c) => percent(c.weeks.find((w) => w.week === i)?.rate ?? null),
                                ),
                            }),
                        )}
                    />
                }
            >
                <HeatmapGrid cohorts={engagement.cohorts} />
            </ChartFrame>
        </div>
    )
}

const GROWTH_TONES = {
    emerald: 'bg-emerald-500',
    indigo: 'bg-indigo-500',
    cyan: 'bg-cyan-500',
    rose: 'bg-rose-500',
} as const

function GrowthRow({
    label, hint, value, tone,
}: {
    label: string
    hint: string
    value: number
    tone: keyof typeof GROWTH_TONES
}) {
    return (
        <div className="flex items-center gap-2.5" title={hint}>
            <span aria-hidden className={`w-2 h-2 rounded-full shrink-0 ${GROWTH_TONES[tone]}`} />
            <dt className="flex-1 min-w-0 text-xs text-ink-secondary truncate">{label}</dt>
            <dd className="text-sm font-bold text-ink tabular-nums">{exact(value)}</dd>
        </div>
    )
}

/** The raw enum values read like column names; these are what they mean. */
