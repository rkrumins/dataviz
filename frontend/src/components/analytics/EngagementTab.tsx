/**
 * EngagementTab — habit, activation, and what people actually do.
 */
import { Activity, Flame, MousePointerClick, Repeat, Route, Search } from 'lucide-react'

import { exact, percent, shortDate } from '@/lib/formatMetric'
import type {
    AnalyticsRangeSelection, AnalyticsSummary,
} from '@/services/analyticsService'
import { viewActionLabel } from '@/lib/domainLabels'
import { KpiCard } from './KpiCard'
import { Leaderboard } from './Leaderboard'
import { WithheldPanel } from './Redacted'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar } from './charts/StackedShareBar'
import { FunnelStrip } from './charts/FunnelStrip'
import { comparisonLabel, previousLabel, rangePhrase } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function EngagementTab({
    data, range, isStale,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const theme = useChartTheme()
    const { totals, series, engagement, breakdowns, leaderboards, coverage } = data
    const value = data.valueMoments
    const vs = comparisonLabel(range)

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Active users" metric="activeUsers" value={totals.activeUsers.current ?? 0} icon={Activity}
                    changePct={totals.activeUsers.changePct} comparisonLabel={vs}
                    trend={series.activeUsers} accent="indigo"
                />
                <KpiCard
                    label="Stickiness" metric="stickiness" value={percent(engagement.stickiness)} icon={Flame}
                    sub={`${exact(engagement.dau)} daily of ${exact(engagement.mau)} monthly`}
                    accent="amber"
                />
                <KpiCard
                    label="View opens" metric="viewOpens" value={totals.viewOpens.current ?? 0} icon={MousePointerClick}
                    changePct={totals.viewOpens.changePct} comparisonLabel={vs}
                    trend={series.viewOpens} trendTone="emerald" accent="cyan"
                />
                <KpiCard
                    label="Actions taken" metric="actionsTaken" value={totals.activity.current ?? 0} icon={Repeat}
                    changePct={totals.activity.changePct} comparisonLabel={vs}
                    trend={series.activityEvents} trendTone="slate" accent="violet"
                />
            </div>

            {/* ── Did the product answer the question it was asked? ──────
                A trace that returns no lineage is a FAILED value moment: the
                user asked the platform's core question and got nothing back.
                No other number here can see that — view opens, activity and
                stickiness all count it as engagement. */}
            <section
                aria-labelledby="value-moments"
                className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 shadow-sm"
            >
                <div className="flex items-baseline justify-between gap-3 mb-1">
                    <h2 id="value-moments" className="text-sm font-bold text-ink">
                        Value moments
                    </h2>
                    <p className="text-[11px] text-ink-muted">
                        Asking is engagement. Getting an answer is value.
                    </p>
                </div>
                <p className="text-[11px] text-ink-muted mb-4">
                    Tracing lineage is what this platform is for — these are the
                    only numbers that say whether it worked.
                </p>

                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <KpiCard
                        label="Traces run" value={value.traces} icon={Route}
                        sub={value.tracedBy
                            ? `by ${exact(value.tracedBy)} ${value.tracedBy === 1 ? 'person' : 'people'}`
                            : 'Nobody has traced yet'}
                        accent="indigo"
                    />
                    <KpiCard
                        label="Traces that found lineage" metric="traceSuccess"
                        value={value.traceSuccessRate == null
                            ? '—' : percent(value.traceSuccessRate)}
                        icon={Route}
                        sub={value.tracesEmpty
                            ? `${exact(value.tracesEmpty)} came back empty`
                            : 'No empty traces'}
                        accent={value.traceSuccessRate != null && value.traceSuccessRate < 0.7
                            ? 'pink' : 'emerald'}
                    />
                    <KpiCard
                        label="Graph searches" value={value.searches} icon={Search}
                        sub={value.searchMisses
                            ? `${exact(value.searchMisses)} found nothing`
                            : 'Every search matched'}
                        accent="cyan"
                    />
                    <KpiCard
                        label="Searches that matched" metric="searchHit"
                        value={value.searchHitRate == null
                            ? '—' : percent(value.searchHitRate)}
                        icon={Search}
                        sub="Misses say what people expected to find"
                        accent={value.searchHitRate != null && value.searchHitRate < 0.7
                            ? 'amber' : 'emerald'}
                    />
                </div>

                {/* A rate with no basis is not zero — say which it is. */}
                {value.traces === 0 && value.searches === 0 && (
                    <p className="mt-3 text-[11px] text-ink-muted">
                        No traces or searches recorded in this range. These signals
                        start accruing from the day instrumentation ships, so an
                        older range shows none because none were counted.
                    </p>
                )}
            </section>

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
                    isEmpty={
                        // Both periods, not just this one: a chart that hid
                        // itself when the current window is flat would hide
                        // the very comparison explaining WHY it is flat.
                        series.activeUsers.every((v) => v === 0)
                        && series.previous.activeUsers.every((v) => v === 0)
                    }
                    emptyLabel="No recorded activity in this range."
                    series={[{ key: 'active', label: 'Active users', color: theme.series[0], shape: 'area' }]}
                    ghostLabel={previousLabel(range)}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'active', label: 'Active users', values: series.activeUsers },
                                { key: 'prev', label: previousLabel(range), values: series.previous.activeUsers },
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[{
                            key: 'active', label: 'Active users',
                            values: series.activeUsers, slot: 0, area: true,
                            previous: series.previous.activeUsers,
                        }]}
                        annotations={data.annotations}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Activation funnel"
                    subtitle={`Everyone who signed up in ${rangePhrase(range)}`}
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
                    <StackedShareBar slices={breakdowns.activityByAction} labelOf={viewActionLabel} />
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

                {/* Keyed on showsPeople, not on `applied`: `applied` is
                    true for every non-privileged reader, so keying on it
                    hid colleagues at the level that exists to show them. */}
                {data.redaction && !data.redaction.showsPeople ? (
                    <WithheldPanel
                        title="Individual activity is hidden"
                        reason="Who did what is visible to administrators and auditors only. Every count on this page still includes everyone's activity."
                    />
                ) : (
                <ChartFrame
                    title="Most active people"
                    subtitle={`Ranked across ${rangePhrase(range)}`}
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
                )}
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
