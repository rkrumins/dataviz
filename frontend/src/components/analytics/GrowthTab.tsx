/**
 * GrowthTab — where new accounts come from, and whether they stay.
 */
import { CalendarClock, UserPlus, Users, Boxes } from 'lucide-react'

import { exact, percent, shortDate } from '@/lib/formatMetric'
import type { AnalyticsSummary } from '@/services/analyticsService'
import { KpiCard } from './KpiCard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar, humanise } from './charts/StackedShareBar'
import { HeatmapGrid } from './charts/HeatmapGrid'
import { comparisonLabel, rangeLabel } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function GrowthTab({
    data, days, isStale,
}: {
    data: AnalyticsSummary
    days: number
    isStale: boolean
}) {
    const theme = useChartTheme()
    const { totals, series, engagement, breakdowns } = data
    const vs = comparisonLabel(days)
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
                    value={percent(engagement.activationRate)}
                    icon={Users}
                    sub="new accounts that built a view"
                    accent="emerald"
                />
                <KpiCard
                    label="Time to first view"
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
                    subtitle={`Signups per period over ${rangeLabel(days).toLowerCase()}`}
                    isStale={isStale}
                    isEmpty={series.signups.every((v) => v === 0)}
                    emptyLabel="No signups in this range."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[{ key: 'signups', label: 'Signups', values: series.signups }]}
                        />
                    }
                >
                    <BarSeriesChart buckets={series.buckets} values={series.signups} label="signups" />
                </ChartFrame>

                <ChartFrame
                    title="Cumulative growth"
                    subtitle="Users, workspaces and views, all rising together or not"
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
                            { key: 'users', label: 'Users', values: series.cumulativeUsers, slot: 0 },
                            { key: 'workspaces', label: 'Workspaces', values: series.cumulativeWorkspaces, slot: 1 },
                            { key: 'views', label: 'Views', values: series.cumulativeViews, slot: 2 },
                        ]}
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
                    <StackedShareBar slices={breakdowns.usersBySignupSource} labelOf={sourceLabel} />
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
                    days < 28
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
function sourceLabel(key: string): string {
    switch (key) {
        case 'local_signup': return 'Signed up directly'
        case 'sso_jit': return 'Provisioned by SSO'
        case 'invite': return 'Invited'
        case 'admin_created': return 'Created by an admin'
        case 'admin_linked': return 'Linked by an admin'
        default: return humanise(key)
    }
}
