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
import { cn } from '@/lib/utils'
import { viewMeta } from './viewMeta'
import type {
    AnalyticsRangeSelection, AnalyticsSummary,
} from '@/services/analyticsService'
import { HeroFigure, KpiCard } from './KpiCard'
import { InsightStrip } from './InsightStrip'
import { MetricInfo } from './MetricInfo'
import { FirstRun, isFirstRun } from './FirstRun'
import { WithheldPanel } from './Redacted'
import { ViewLink, WorkspaceLink } from './EntityLink'
import { AdoptionMatrix } from './AdoptionMatrix'
import { Leaderboard } from './Leaderboard'
import { ContactLink } from './ContactLink'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { comparisonLabel, previousLabel, rangeLabel, rangePhrase } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'
import { shortDate } from '@/lib/formatMetric'

interface Props {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
    onWorkspaceClick: (workspaceId: string) => void
    /** Jump to the tab that explains an insight in depth. */
    onNavigateTab?: (tab: string) => void
}

export function OverviewTab({
    data, range, isStale, onWorkspaceClick, onNavigateTab,
}: Props) {
    const theme = useChartTheme()
    const { totals, series, engagement, leaderboards, graph } = data
    // Whether OTHER people may be named. Not `redaction.applied` — that is
    // true for every non-privileged reader, including at the privacy levels
    // whose whole purpose is to show colleagues.
    const peopleHidden = !!data.redaction && !data.redaction.showsPeople
    const vs = comparisonLabel(range)

    return (
        <div className="space-y-5">
            {/* What changed, in sentences, before any chart. A reader who only
                has ten seconds should still leave with the finding. Renders
                nothing at all when there is nothing worth saying. */}
            <InsightStrip
                insights={data.insights}
                rangeLabel={rangeLabel(range)}
                onNavigate={onNavigateTab}
            />

            {/* A brand-new deployment gets an explanation and the two or three
                actions that fill this page, rather than six panels each saying
                "no activity in this range". The charts below stay: they show
                the shape the page will take. */}
            {isFirstRun(data) && <FirstRun />}

            {/* Hero + headline stats. Exactly one hero figure per view; the
                vanity totals sit beside it as ordinary tiles. */}
            <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-6 shadow-sm">
                <div className="flex flex-wrap items-end justify-between gap-6">
                    <HeroFigure
                        label={`Active users · ${rangeLabel(range).toLowerCase()}`}
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
                    label="Total users" metric="totalUsers" value={totals.users.total} icon={Users}
                    changePct={totals.users.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.users.current ?? 0)} new in ${rangePhrase(range)}`}
                    trend={series.signups} accent="indigo"
                />
                <KpiCard
                    label="Workspaces" metric="workspaces" value={totals.workspaces.total} icon={Boxes}
                    changePct={totals.workspaces.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.workspaces.current ?? 0)} new in ${rangePhrase(range)}`}
                    trend={series.workspacesCreated} trendTone="amber" accent="amber"
                />
                <KpiCard
                    label="Views" metric="views" value={totals.views.total} icon={LayoutGrid}
                    changePct={totals.views.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.views.current ?? 0)} created in ${rangePhrase(range)}`}
                    trend={series.viewsCreated} trendTone="emerald" accent="cyan"
                />
                <KpiCard
                    label="View opens" metric="viewOpens" value={totals.viewOpens.total} icon={MousePointerClick}
                    changePct={totals.viewOpens.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.viewOpens.current ?? 0)} opens in ${rangePhrase(range)}`}
                    trend={series.viewOpens} trendTone="indigo" accent="pink"
                />
            </div>

            {/* Three measures, three frames. Accounts, people and opens differ
                by an order of magnitude each — on one plot the smallest of
                them is a flat line along the baseline, which is not a finding,
                it is a rendering artefact. Never two y-axes; never two
                magnitudes sharing one. */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="User growth"
                    subtitle={`Total accounts over ${rangePhrase(range)}`}
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
                        annotations={data.annotations}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Active users"
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
                    series={[{ key: 'active', label: 'Active users', color: theme.series[0], shape: 'line' }]}
                    ghostLabel={previousLabel(range)}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'active', label: 'Active users', values: series.activeUsers },
                                { key: 'prev', label: 'Previous period', values: series.previous.activeUsers },
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[{
                            key: 'active', label: 'Active users',
                            values: series.activeUsers, slot: 0,
                            previous: series.previous.activeUsers,
                        }]}
                        annotations={data.annotations}
                    />
                </ChartFrame>

                <ChartFrame
                    title="View opens"
                    subtitle="How many times a saved view was opened"
                    isStale={isStale}
                    isEmpty={
                        // Both periods, not just this one: a chart that hid
                        // itself when the current window is flat would hide
                        // the very comparison explaining WHY it is flat.
                        series.viewOpens.every((v) => v === 0)
                        && series.previous.viewOpens.every((v) => v === 0)
                    }
                    emptyLabel="No views opened in this range."
                    series={[{ key: 'opens', label: 'View opens', color: theme.series[1], shape: 'line' }]}
                    ghostLabel={previousLabel(range)}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'opens', label: 'View opens', values: series.viewOpens },
                                { key: 'prev', label: 'Previous period', values: series.previous.viewOpens },
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={series.buckets}
                        series={[{
                            key: 'opens', label: 'View opens',
                            values: series.viewOpens, slot: 1,
                            previous: series.previous.viewOpens,
                        }]}
                        annotations={data.annotations}
                    />
                </ChartFrame>
            </div>

            {/* Which features anyone actually uses. Sits above the
                leaderboards because "what gets used" outranks "who used it". */}
            <AdoptionMatrix
                rows={data.adoption}
                subtitle={`Feature usage across ${rangePhrase(range)}`}
            />

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                {/* An empty leaderboard and a WITHHELD one look identical
                    unless we say which. "Nobody has been active" is a false
                    statement to make to someone who simply may not see who
                    was. */}
                {peopleHidden ? (
                    <WithheldPanel
                        title="Individual activity is hidden"
                        reason="Who did what is visible to administrators and auditors only. The platform-wide counts above include everyone."
                    />
                ) : (
                <ChartFrame
                    title="Most active people"
                    subtitle={`Ranked by everything they did in ${rangePhrase(range)}`}
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
                )}

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
                            label: <ViewLink viewId={v.viewId} name={v.name} canOpen={v.canOpen} />,
                            // What it is, and — where the server sent one —
                            // the person behind it. Finding a useful view and
                            // wanting to ask its author about it is the whole
                            // reason contact details exist on this page. The
                            // type and visibility stay either way: they say
                            // what the row IS, which no address replaces.
                            meta: (
                                <span className="flex items-center gap-1.5 truncate">
                                    <span className="shrink-0">{viewMeta(v)}</span>
                                    <ContactLink email={v.createdByEmail} name={v.createdByName} />
                                </span>
                            ),
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
                            label: <WorkspaceLink workspaceId={w.workspaceId} name={w.name} canOpen={w.canOpen} />,
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
                {/* Three across rather than six: each tile now says what its
                    number MEANS, and a sentence needs room to be read. Six
                    columns of bare figures was a scoreboard nobody could act
                    on — "4.1M" is not information until you know 4.1M of
                    what, and whether that is a lot. */}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <ScaleTile
                        label="Graph nodes" value={graph.nodes} icon={Activity} accent="indigo"
                        meaning="Every table, column, dashboard and job the platform knows about."
                        context={graph.entityTypes
                            ? `across ${exact(graph.entityTypes)} kinds of thing`
                            : undefined}
                    />
                    <ScaleTile
                        label="Graph edges" value={graph.edges} icon={TrendingUp} accent="violet"
                        meaning="Connections between them. Each one is a hop somebody can trace."
                        context={graph.nodes
                            ? `${(graph.edges / graph.nodes).toFixed(1)} per node`
                            : undefined}
                    />
                    <ScaleTile
                        label="Entity types" value={graph.entityTypes} icon={LayoutGrid} accent="cyan"
                        metric="entityTypes"
                        meaning="How much of the estate is described. Two types is a table list; lineage gets useful as the things around the tables are modelled too."
                    />
                    <ScaleTile
                        label="Data sources" value={totals.dataSources.total} icon={Database} accent="amber"
                        meaning="Systems connected to the platform. Everything above is built from these."
                        context={totals.dataSources.current
                            ? `${exact(totals.dataSources.current)} added in ${rangePhrase(range)}`
                            : undefined}
                    />
                    <ScaleTile
                        label="Semantic layers" value={totals.ontologies.total} icon={Eye} accent="emerald"
                        metric="semanticLayers"
                        meaning="Ontologies that give raw technical metadata a business meaning."
                        context={totals.dataSources.total
                            ? `for ${exact(totals.dataSources.total)} sources`
                            : undefined}
                    />
                    <ScaleTile
                        label="Context models" value={totals.contextModels.total} icon={Boxes} accent="pink"
                        meaning="Reusable shapes of the graph — the starting points people build views from."
                    />
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

const SCALE_ACCENTS = {
    indigo: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    cyan: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/20',
    pink: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/20',
    violet: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
} as const

/**
 * One dimension of the estate, with the sentence that makes the number mean
 * something.
 *
 * The figure alone was the whole tile once, and it answered nothing: "4.1M" is
 * not information until the reader knows 4.1M of what, built out of what, and
 * whether it is a lot. `meaning` says what is being counted; `context` relates
 * it to another number on the same page so the size has a reference.
 */
function ScaleTile({
    label, value, icon: Icon, accent = 'indigo', meaning, context, metric,
}: {
    label: string
    value: number
    icon: React.ComponentType<{ className?: string }>
    accent?: keyof typeof SCALE_ACCENTS
    /** What this counts, in a sentence. */
    meaning: string
    /** Relates the figure to another one — "3.1 per node", "of 34 sources". */
    context?: string
    /** Key into METRICS, where a fuller definition already exists. */
    metric?: string
}) {
    return (
        <div className="group flex gap-3 rounded-xl border border-glass-border bg-canvas-elevated p-4 shadow-sm transition-colors hover:border-indigo-500/25">
            <span
                aria-hidden
                className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border',
                    SCALE_ACCENTS[accent],
                )}
            >
                <Icon className="h-4 w-4" />
            </span>
            <div className="min-w-0">
                <p className="flex items-baseline gap-2">
                    <span className="text-xl font-bold leading-none text-ink" title={exact(value)}>
                        {compact(value)}
                    </span>
                    {context && (
                        <span className="truncate text-[11px] font-medium text-ink-muted">
                            {context}
                        </span>
                    )}
                </p>
                <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-ink-secondary">
                    {label}
                    {metric && <MetricInfo metric={metric} />}
                </p>
                <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
                    {meaning}
                </p>
            </div>
        </div>
    )
}
