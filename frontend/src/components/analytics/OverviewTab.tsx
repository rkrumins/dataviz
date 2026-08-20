/**
 * OverviewTab — the one screen that answers "how are we doing?".
 *
 * Leads with a single hero figure (active users), then the KPI row, then the
 * two charts that carry the growth story, then who and what is driving it.
 * Everything deeper lives in its own tab; this one is the summary a business
 * reader can take in without scrolling twice.
 */
import {
    Activity, Boxes, Database, Eye, LayoutGrid, MousePointerClick, TrendingUp, Users,
} from 'lucide-react'

import { compact, exact, percent } from '@/lib/formatMetric'
import type { AnalyticsSummary } from '@/services/analyticsService'
import { HeroFigure, KpiCard } from './KpiCard'
import { Leaderboard } from './Leaderboard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { comparisonLabel, rangeLabel } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'
import { shortDate } from '@/lib/formatMetric'

interface Props {
    data: AnalyticsSummary
    days: number
    isStale: boolean
    onWorkspaceClick: (workspaceId: string) => void
}

export function OverviewTab({ data, days, isStale, onWorkspaceClick }: Props) {
    const theme = useChartTheme()
    const { totals, series, engagement, leaderboards, graph } = data
    const vs = comparisonLabel(days)

    return (
        <div className="space-y-5">
            {/* Hero + headline stats. Exactly one hero figure per view; the
                vanity totals sit beside it as ordinary tiles. */}
            <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-6">
                    <HeroFigure
                        label={`Active users · ${rangeLabel(days).toLowerCase()}`}
                        value={totals.activeUsers.current ?? 0}
                        changePct={totals.activeUsers.changePct}
                        comparisonLabel={vs}
                        sub={`${exact(totals.users.total)} accounts in total`}
                    />
                    <dl className="flex flex-wrap gap-x-8 gap-y-3">
                        <Figure label="Daily active" value={engagement.dau} />
                        <Figure label="Weekly active" value={engagement.wau} />
                        <Figure label="Monthly active" value={engagement.mau} />
                        <Figure
                            label="Stickiness"
                            value={engagement.stickiness}
                            format={(v) => percent(v)}
                            hint="DAU ÷ MAU — how much of the monthly audience shows up on a given day"
                        />
                    </dl>
                </div>
            </section>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Total users" value={totals.users.total} icon={Users}
                    changePct={totals.users.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.users.current ?? 0)} new in range`}
                    trend={series.signups} accent="indigo"
                />
                <KpiCard
                    label="Workspaces" value={totals.workspaces.total} icon={Boxes}
                    changePct={totals.workspaces.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.workspaces.current ?? 0)} new in range`}
                    trend={series.workspacesCreated} trendTone="amber" accent="amber"
                />
                <KpiCard
                    label="Views" value={totals.views.total} icon={LayoutGrid}
                    changePct={totals.views.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.views.current ?? 0)} created in range`}
                    trend={series.viewsCreated} trendTone="emerald" accent="cyan"
                />
                <KpiCard
                    label="View opens" value={totals.viewOpens.total} icon={MousePointerClick}
                    changePct={totals.viewOpens.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.viewOpens.current ?? 0)} in range`}
                    trend={series.viewOpens} trendTone="indigo" accent="pink"
                />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {/* Cumulative and new are the same measure at two scales, so
                    they get two charts — never two y-axes on one plot. */}
                <ChartFrame
                    title="User growth"
                    subtitle={`Total accounts over ${rangeLabel(days).toLowerCase()}`}
                    isStale={isStale}
                    isEmpty={series.cumulativeUsers.every((v) => v === 0)}
                    emptyLabel="No accounts yet."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'total', label: 'Total users', values: series.cumulativeUsers },
                                { key: 'new', label: 'New', values: series.signups },
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[{ key: 'users', label: 'Total users', values: series.cumulativeUsers, slot: 0, area: true }]}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Engagement"
                    subtitle="Distinct people who did something, per period"
                    isStale={isStale}
                    isEmpty={series.activeUsers.every((v) => v === 0)}
                    emptyLabel="No recorded activity in this range."
                    series={[
                        { key: 'active', label: 'Active users', color: theme.series[0], shape: 'line' },
                        { key: 'opens', label: 'View opens', color: theme.series[1], shape: 'line' },
                    ]}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'active', label: 'Active users', values: series.activeUsers },
                                { key: 'opens', label: 'View opens', values: series.viewOpens },
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[
                            { key: 'active', label: 'Active users', values: series.activeUsers, slot: 0 },
                            { key: 'opens', label: 'View opens', values: series.viewOpens, slot: 1 },
                        ]}
                    />
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="Most active people"
                    subtitle={`Ranked by everything they did in ${rangeLabel(days).toLowerCase()}`}
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
                            detail: `${compact(u.viewsOpened)} opened · ${compact(u.viewsCreated)} built`,
                        }))}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Most popular views"
                    subtitle="Opens, with the audience behind them"
                    isStale={isStale}
                    isEmpty={leaderboards.topViews.length === 0}
                    emptyLabel="No views opened in this range."
                >
                    <Leaderboard
                        unit="opens"
                        slot={1}
                        rows={leaderboards.topViews.map((v) => ({
                            id: v.viewId,
                            label: v.name,
                            meta: `${v.viewType} · ${v.visibility}`,
                            value: v.opens,
                            detail: `${compact(v.uniqueViewers)} ${v.uniqueViewers === 1 ? 'person' : 'people'}`,
                        }))}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Busiest workspaces"
                    subtitle="Edits and opens combined"
                    isStale={isStale}
                    isEmpty={leaderboards.topWorkspaces.length === 0}
                    emptyLabel="No workspace activity in this range."
                >
                    <Leaderboard
                        unit="events"
                        slot={2}
                        onRowClick={(row) => onWorkspaceClick(row.id)}
                        rows={leaderboards.topWorkspaces.map((w) => ({
                            id: w.workspaceId,
                            label: w.name,
                            value: w.activity + w.opens,
                            detail: `${compact(w.opens)} opens`,
                        }))}
                    />
                </ChartFrame>
            </div>

            <ChartFrame
                title="Platform scale"
                subtitle="What has been onboarded, all time"
                isStale={isStale}
            >
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
                    <ScaleTile label="Graph nodes" value={graph.nodes} icon={Activity} />
                    <ScaleTile label="Graph edges" value={graph.edges} icon={TrendingUp} />
                    <ScaleTile label="Entity types" value={graph.entityTypes} icon={LayoutGrid} />
                    <ScaleTile label="Data sources" value={totals.dataSources.total} icon={Database} />
                    <ScaleTile label="Semantic layers" value={totals.ontologies.total} icon={Eye} />
                    <ScaleTile label="Context models" value={totals.contextModels.total} icon={Boxes} />
                </div>
            </ChartFrame>

            <ChartFrame
                title="Data sources onboarded"
                subtitle="New connections per period"
                isStale={isStale}
                isEmpty={series.dataSourcesOnboarded.every((v) => v === 0)}
                emptyLabel="No sources onboarded in this range."
                table={
                    <ChartTable
                        rowLabel="Date"
                        rows={series.buckets.map((b) => shortDate(b, true))}
                        columns={[{ key: 'ds', label: 'Data sources', values: series.dataSourcesOnboarded }]}
                    />
                }
            >
                <BarSeriesChart
                    buckets={series.buckets}
                    values={series.dataSourcesOnboarded}
                    label="data sources"
                    slot={5}
                />
            </ChartFrame>
        </div>
    )
}

function Figure({
    label, value, format, hint,
}: {
    label: string
    value: number | null
    format?: (v: number | null) => string
    hint?: string
}) {
    return (
        <div title={hint}>
            <dt className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted">
                {label}
            </dt>
            <dd className="mt-0.5 text-xl font-bold text-ink">
                {format ? format(value) : compact(value)}
            </dd>
        </div>
    )
}

function ScaleTile({
    label, value, icon: Icon,
}: {
    label: string
    value: number
    icon: React.ComponentType<{ className?: string }>
}) {
    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3">
            <Icon className="w-3.5 h-3.5 text-ink-muted mb-2" aria-hidden />
            <p className="text-lg font-bold text-ink leading-none" title={exact(value)}>
                {compact(value)}
            </p>
            <p className="mt-1 text-[10px] text-ink-muted">{label}</p>
        </div>
    )
}
