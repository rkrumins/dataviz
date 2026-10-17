/**
 * HealthTab — the things that block growth but never show on a growth chart.
 *
 * Three questions a rising line cannot answer:
 *
 *   1. Is the data people are reading actually fresh? A platform whose sources
 *      quietly stop refreshing shows rising view opens right up until someone
 *      notices the lineage is a month stale.
 *   2. Can people get IN? Every pending access request and unredeemed invite is
 *      somebody who wanted to use this and could not — throttled upstream of
 *      anything the activation funnel can see.
 *   3. Is the differentiator switched on? A source with no semantic layer shows
 *      raw technical metadata, which is the product without its point.
 *
 * Each of these reads a table the dashboard previously ignored entirely.
 */
import {
    AlertTriangle, Bot, CheckCircle2, Clock, DatabaseZap, Hand, Layers, MailCheck,
    Percent, ShieldQuestion, Timer,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate } from '@/lib/formatMetric'
import { humaniseKey, runOriginLabel } from '@/lib/domainLabels'
import { timeAgo } from '@/lib/timeAgo'
import type {
    AnalyticsRangeSelection, AnalyticsSummary, AnalyticsUsageDoc,
} from '@/services/analyticsService'
import type { AnalyticsUsageState } from '@/hooks/useAnalytics'
import { cadencePhrase } from '@/components/activity/activityMeta'
import { KpiCard } from './KpiCard'
import { Leaderboard } from './Leaderboard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { StackedShareBar } from './charts/StackedShareBar'
import { StackedAreaChart } from './charts/StackedAreaChart'
import { WithheldPanel } from './Redacted'
import { comparisonLabel, rangePhrase } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'
import { UsageSection } from './UsageSection'
import { RUN_ORIGIN_SLOT } from './slots'

export function HealthTab({
    data, range, isStale, usage,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
    /** How ingestion is driven, from the usage document. */
    usage?: AnalyticsUsageState
}) {
    const theme = useChartTheme()
    const { reliability, access, semanticLayer } = data.health
    const window = `in ${rangePhrase(range)}`

    return (
        <div className={cn('space-y-6 transition-opacity', isStale && 'opacity-50')}>
            {/* ── Data trust ───────────────────────────────────────────
                Withheld for non-privileged viewers: refresh failures name
                which sources are unreliable, which is an operator's business.

                The HEADING and its description stay for everyone, and only the
                figures are withheld. A reader who cannot see the numbers should
                still learn that the platform tracks this and what it is for —
                hiding the section wholesale teaches them nothing and makes the
                page a different page depending on who opens it. */}
            <section aria-labelledby="health-reliability">
                <h2 id="health-reliability" className="text-sm font-bold text-ink mb-1">
                    Data freshness
                </h2>
                <p className="text-[11px] text-ink-muted mb-3">
                    Rising usage on stale data is the worst kind of good news.
                </p>

                {!reliability ? (
                <WithheldPanel
                    title="Refresh outcomes are hidden"
                    shape="stats"
                    reason="How often each source refreshes, and how often it fails, is visible to administrators and auditors. Ask one of them if you need to know how current a data source is."
                />
                ) : (
                <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <KpiCard
                        label="Refresh success" metric="refreshSuccess"
                        value={reliability.successRate == null
                            ? '—' : percent(reliability.successRate)}
                        sub={reliability.refreshes
                            ? `${exact(reliability.refreshes)} refreshes ${window}`
                            : 'No refreshes recorded'}
                        icon={CheckCircle2}
                        accent={reliability.successRate != null && reliability.successRate < 0.95
                            ? 'pink' : 'emerald'}
                    />
                    <KpiCard
                        label="Failed refreshes"
                        value={compact(reliability.failures)}
                        sub={reliability.failures ? 'Investigate before trusting lineage' : 'Nothing failed'}
                        icon={AlertTriangle}
                        accent={reliability.failures ? 'pink' : 'emerald'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Sources refreshed"
                        value={compact(reliability.sourcesRefreshed)}
                        sub={`of ${exact(semanticLayer.sourcesTotal)} live sources`}
                        icon={DatabaseZap}
                        accent="cyan"
                    />
                    <KpiCard
                        label="Never refreshed" metric="neverRefreshed"
                        value={compact(reliability.sourcesUntouched)}
                        sub={`No activity ${window} — staleness hides here`}
                        icon={Clock}
                        accent={reliability.sourcesUntouched ? 'amber' : 'emerald'}
                        higherIsBetter={false}
                    />
                </div>

                {reliability.byOutcome.length > 0 && (
                    <ChartFrame
                        title="Refresh outcomes"
                        subtitle={`Every refresh ${window}, by how it ended`}
                        className="mt-3"
                        isStale={isStale}
                        isEmpty={reliability.refreshes === 0}
                        emptyLabel="No refresh activity in this range."
                        series={reliability.byOutcome.map((row, i) => ({
                            key: row.key,
                            label: humaniseKey(row.key),
                            color: row.key === 'Other' ? theme.neutralMark : theme.series[i % theme.series.length],
                            shape: 'bar' as const,
                        }))}
                        table={
                            <ChartTable
                                rowLabel="Outcome"
                                rows={reliability.byOutcome.map((r) => humaniseKey(r.key))}
                                columns={[{
                                    key: 'count', label: 'Refreshes',
                                    values: reliability.byOutcome.map((r) => r.count),
                                }]}
                            />
                        }
                    >
                        <StackedShareBar slices={reliability.byOutcome} labelOf={humaniseKey} />
                    </ChartFrame>
                )}
                </>
                )}
            </section>

            {/* ── How ingestion is driven ──────────────────────────────
                Withheld below the posture that shows operations, like refresh
                outcomes: how often people rebuild a source says how reliable
                it is. Heading kept, as above. */}
            {usage && (
                <section aria-labelledby="health-ingestion">
                    <h2 id="health-ingestion" className="text-sm font-bold text-ink mb-1">
                        How ingestion is driven
                    </h2>
                    <p className="text-[11px] text-ink-muted mb-3">
                        Every run a person starts is one that automation did not.
                    </p>
                    <UsageSection usage={usage}>
                        {(u) => (u.health ? (
                            <IngestionDriven health={u.health} range={range} isStale={usage.isFetching} />
                        ) : (
                            <WithheldPanel
                                title="Who starts ingestion runs is hidden"
                                shape="stats"
                                reason="How often people rebuild each source by hand, and how often runs fail, is visible to administrators and auditors."
                            />
                        ))}
                    </UsageSection>
                </section>
            )}

            {/* ── Access friction ──────────────────────────────────────
                Withheld likewise: pending requests and invite acceptance
                identify people by implication. Heading kept, as above. */}
            <section aria-labelledby="health-access">
                <h2 id="health-access" className="text-sm font-bold text-ink mb-1">
                    Access friction
                </h2>
                <p className="text-[11px] text-ink-muted mb-3">
                    Every row here is a person who wanted in and is still waiting.
                </p>

                {!access ? (
                <WithheldPanel
                    title="Access requests are hidden"
                    shape="stats"
                    reason="Who is waiting for access, and how quickly requests are answered, is visible to administrators and auditors."
                />
                ) : (
                <>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <KpiCard
                        label="Pending requests"
                        value={compact(access.pending)}
                        sub={access.oldestPendingDays == null
                            ? 'Nothing waiting'
                            : `Oldest waiting ${access.oldestPendingDays.toFixed(0)} days`}
                        icon={ShieldQuestion}
                        accent={access.pending ? 'amber' : 'emerald'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Median time to approve"
                        value={access.medianHoursToApprove == null
                            ? '—'
                            : `${access.medianHoursToApprove.toFixed(0)}h`}
                        sub={`${exact(access.requests)} requests ${window}`}
                        icon={Timer}
                        accent="violet"
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Invite acceptance" metric="inviteAcceptance"
                        value={access.acceptanceRate == null
                            ? '—' : percent(access.acceptanceRate)}
                        sub={`${exact(access.invitesRedeemed)} of ${exact(access.invitesSent)} redeemed`}
                        icon={MailCheck}
                        accent={access.acceptanceRate != null && access.acceptanceRate < 0.5
                            ? 'amber' : 'emerald'}
                    />
                    <KpiCard
                        label="Invites sent"
                        value={compact(access.invitesSent)}
                        sub={`Sent ${window}`}
                        icon={MailCheck}
                        accent="indigo"
                    />
                </div>
                </>
                )}
            </section>

            {/* ── Semantic layer adoption ──────────────────────────────
                Shown to everyone: it is a platform fact, not an operational
                one, and names nothing. */}
            <section aria-labelledby="health-semantic">
                <h2 id="health-semantic" className="text-sm font-bold text-ink mb-1">
                    Semantic layer coverage
                </h2>
                <p className="text-[11px] text-ink-muted mb-3">
                    A source with no ontology shows raw technical metadata — the
                    product without the thing that differentiates it.
                </p>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <KpiCard
                        label="Sources with a semantic layer" metric="semanticCoverage"
                        value={semanticLayer.coverage == null
                            ? '—' : percent(semanticLayer.coverage)}
                        sub={`${exact(semanticLayer.sourcesWithOntology)} of ${exact(semanticLayer.sourcesTotal)} sources`}
                        icon={Layers}
                        accent={semanticLayer.coverage != null && semanticLayer.coverage < 0.5
                            ? 'amber' : 'emerald'}
                    />
                    <KpiCard
                        label="Sources drifting" metric="sourcesDrifting"
                        value={compact(semanticLayer.sourcesDrifting)}
                        sub="Schema moved since the mapping was written"
                        icon={AlertTriangle}
                        accent={semanticLayer.sourcesDrifting ? 'pink' : 'emerald'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Entity types modelled" metric="entityTypes"
                        value={compact(data.graph.entityTypes)}
                        sub={`${compact(data.graph.nodes)} nodes · ${compact(data.graph.edges)} edges`}
                        icon={Layers}
                        accent="cyan"
                    />
                </div>
            </section>
        </div>
    )
}

function IngestionDriven({
    health, range, isStale,
}: {
    health: NonNullable<AnalyticsUsageDoc['health']>
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const theme = useChartTheme()
    const window = `in ${rangePhrase(range)}`
    const total = Object.values(health.totals).reduce((a, b) => a + b, 0)
    const bands = health.runs.map((r) => ({
        key: r.key,
        label: runOriginLabel(r.key),
        values: r.values,
        slot: RUN_ORIGIN_SLOT[r.key] ?? 5,
        residual: RUN_ORIGIN_SLOT[r.key] === undefined,
    }))

    return (
        <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <KpiCard
                    label="Runs started by hand" metric="runsByHand" icon={Hand} accent="amber"
                    value={health.byHand.current ?? 0}
                    changePct={health.byHand.changePct} comparisonLabel={comparisonLabel(range)}
                    // More manual runs is not good news: it is toil.
                    higherIsBetter={false}
                />
                <KpiCard
                    label="Share started by hand" icon={Percent} accent="violet"
                    value={percent(health.manualShare)}
                    sub={total ? `of ${exact(total)} runs ${window}` : `No runs ${window}`}
                    higherIsBetter={false}
                />
                <KpiCard
                    label="Run failure rate" metric="ingestionFailureRate" icon={AlertTriangle}
                    accent={health.failureRate != null && health.failureRate > 0.1 ? 'pink' : 'emerald'}
                    value={percent(health.failureRate, 1)}
                    sub="Of runs that finished"
                    higherIsBetter={false}
                />
                <KpiCard
                    label="Automatic runs" icon={Bot} accent="indigo"
                    value={compact(health.totals.automatic)}
                    sub={`${exact(health.totals.onboarding)} onboarding · ${exact(health.totals.other)} other`}
                />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="Runs, by who started them"
                    subtitle={`Every aggregation run ${window}`}
                    className="xl:col-span-2"
                    isStale={isStale}
                    isEmpty={total === 0}
                    emptyLabel="No aggregation runs in this range."
                    series={bands.map((b) => ({
                        key: b.key, label: b.label, shape: 'area' as const,
                        color: b.residual ? theme.neutralMark : theme.series[b.slot],
                    }))}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={health.buckets.map((b) => shortDate(b, true))}
                            columns={bands.map((b) => ({ key: b.key, label: b.label, values: b.values }))}
                        />
                    }
                >
                    <StackedAreaChart
                        buckets={health.buckets} series={bands} height={220}
                        formatBucket={(b) => shortDate(b, true)}
                        axisLabels={health.buckets.map((b) => shortDate(b))}
                    />
                </ChartFrame>
                <ChartFrame
                    title="Most hands-on sources"
                    subtitle="Operations people ran by hand, and how often"
                    isStale={isStale}
                >
                    <Leaderboard
                        unit="operations"
                        slot={1}
                        emptyLabel="Nobody operated a source by hand in this range."
                        rows={health.handsOnSources.map((s, i) => ({
                            id: s.dataSourceId ?? `hidden-${i}`,
                            label: s.redacted
                                ? <span className="italic text-ink-muted">A source you cannot see</span>
                                : s.name ?? <span className="font-mono text-[11px]">{s.dataSourceId}</span>,
                            meta: cadencePhrase(s.medianGapHours) ?? undefined,
                            value: s.count,
                            detail: `last ${timeAgo(s.lastAt)}`,
                        }))}
                    />
                </ChartFrame>
            </div>
        </div>
    )
}
