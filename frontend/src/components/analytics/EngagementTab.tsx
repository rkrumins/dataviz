/**
 * EngagementTab — habit, activation, and what people actually do.
 */
import { Activity, Flame, MousePointerClick, Repeat } from 'lucide-react'

import { exact, percent, shortDate } from '@/lib/formatMetric'
import type { AnalyticsSummary } from '@/services/analyticsService'
import { KpiCard } from './KpiCard'
import { Leaderboard } from './Leaderboard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar, humanise } from './charts/StackedShareBar'
import { FunnelStrip } from './charts/FunnelStrip'
import { comparisonLabel, rangeLabel } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function EngagementTab({
    data, days, isStale,
}: {
    data: AnalyticsSummary
    days: number
    isStale: boolean
}) {
    const { totals, series, engagement, breakdowns, leaderboards, coverage } = data
    const vs = comparisonLabel(days)

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Active users" value={totals.activeUsers.current ?? 0} icon={Activity}
                    changePct={totals.activeUsers.changePct} comparisonLabel={vs}
                    trend={series.activeUsers} accent="indigo"
                />
                <KpiCard
                    label="Stickiness" value={percent(engagement.stickiness)} icon={Flame}
                    sub={`${exact(engagement.dau)} daily of ${exact(engagement.mau)} monthly`}
                    accent="amber"
                />
                <KpiCard
                    label="View opens" value={totals.viewOpens.current ?? 0} icon={MousePointerClick}
                    changePct={totals.viewOpens.changePct} comparisonLabel={vs}
                    trend={series.viewOpens} trendTone="emerald" accent="cyan"
                />
                <KpiCard
                    label="Actions taken" value={totals.activity.current ?? 0} icon={Repeat}
                    changePct={totals.activity.changePct} comparisonLabel={vs}
                    trend={series.activityEvents} trendTone="slate" accent="violet"
                />
            </div>

            {/* Open tracking starts when the feature ships. Say so, rather than
                letting a flat line read as "nobody opened anything". */}
            {coverage.viewOpenTrackingSince === null ? (
                <Notice>
                    View-open tracking is on, but nothing has been recorded yet. Opens
                    will start appearing here as soon as someone opens a view.
                </Notice>
            ) : (
                <Notice>
                    View opens have been recorded since{' '}
                    <strong className="font-semibold text-ink">
                        {shortDate(coverage.viewOpenTrackingSince, true)}
                    </strong>
                    . Ranges reaching further back show no opens because none were
                    counted then — not because nobody was reading.
                </Notice>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    title="Active users over time"
                    subtitle="Distinct people who did something, per period"
                    isStale={isStale}
                    isEmpty={series.activeUsers.every((v) => v === 0)}
                    emptyLabel="No recorded activity in this range."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[{ key: 'active', label: 'Active users', values: series.activeUsers }]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[{ key: 'active', label: 'Active users', values: series.activeUsers, slot: 0, area: true }]}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Activation funnel"
                    subtitle={`Everyone who signed up in ${rangeLabel(days).toLowerCase()}`}
                    isStale={isStale}
                    isEmpty={(engagement.funnel[0]?.count ?? 0) === 0}
                    emptyLabel="Nobody signed up in this range."
                >
                    <FunnelStrip stages={engagement.funnel} />
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    title="View opens"
                    subtitle="How often people reached for a view"
                    isStale={isStale}
                    isEmpty={series.viewOpens.every((v) => v === 0)}
                    emptyLabel="No opens recorded in this range."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'opens', label: 'Opens', values: series.viewOpens },
                                { key: 'signins', label: 'Sign-ins', values: series.signIns },
                            ]}
                        />
                    }
                >
                    <BarSeriesChart
                        buckets={series.buckets} values={series.viewOpens}
                        label="opens" slot={2}
                    />
                </ChartFrame>

                <ChartFrame
                    title="What people do"
                    subtitle="Recorded actions by kind"
                    isStale={isStale}
                    isEmpty={breakdowns.activityByAction.length === 0}
                    emptyLabel="No actions recorded in this range."
                >
                    <StackedShareBar slices={breakdowns.activityByAction} labelOf={actionLabel} />
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    title="Sign-ins"
                    subtitle="Sessions started per period"
                    isStale={isStale}
                    isEmpty={series.signIns.every((v) => v === 0)}
                    emptyLabel="No sign-ins recorded in this range."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[{ key: 'signins', label: 'Sign-ins', values: series.signIns }]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[{ key: 'signins', label: 'Sign-ins', values: series.signIns, slot: 4, area: true }]}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Most active people"
                    subtitle={`Ranked across ${rangeLabel(days).toLowerCase()}`}
                    isStale={isStale}
                    isEmpty={leaderboards.topUsers.length === 0}
                    emptyLabel="Nobody has been active in this range."
                >
                    <Leaderboard
                        unit="actions"
                        rows={leaderboards.topUsers.map((u) => ({
                            id: u.userId,
                            label: u.name,
                            meta: u.email ?? undefined,
                            value: u.events,
                            detail: `${exact(u.viewsOpened)} opened · ${exact(u.viewsCreated)} built`,
                        }))}
                    />
                </ChartFrame>
            </div>
        </div>
    )
}

function Notice({ children }: { children: React.ReactNode }) {
    const theme = useChartTheme()
    return (
        <p
            className="rounded-xl border border-glass-border bg-glass-base/30 px-4 py-2.5 text-xs text-ink-secondary"
            style={{ borderLeftColor: theme.series[0], borderLeftWidth: 3 }}
        >
            {children}
        </p>
    )
}

/** Activity-log verbs, said the way a person would say them. */
function actionLabel(key: string): string {
    switch (key) {
        case 'created': return 'Created a view'
        case 'updated': return 'Edited a view'
        case 'visibility_changed': return 'Changed who can see it'
        case 'shared': return 'Shared'
        case 'unshared': return 'Unshared'
        case 'favourited': return 'Favourited'
        case 'unfavourited': return 'Unfavourited'
        case 'deleted': return 'Deleted'
        case 'restored': return 'Restored'
        case 'data_changed': return 'Underlying data changed'
        case 'publish_requested': return 'Asked to publish'
        case 'publish_denied': return 'Publish denied'
        case 'admin_viewed': return 'Admin opened a private view'
        default: return humanise(key)
    }
}
