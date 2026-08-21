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
    AlertTriangle, CheckCircle2, Clock, DatabaseZap, Layers, MailCheck,
    ShieldQuestion, Timer,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent } from '@/lib/formatMetric'
import { humaniseKey } from '@/lib/domainLabels'
import type { AnalyticsRangeSelection, AnalyticsSummary } from '@/services/analyticsService'
import { KpiCard } from './KpiCard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { StackedShareBar } from './charts/StackedShareBar'
import { WithheldPanel } from './Redacted'
import { rangeLabel } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function HealthTab({
    data, range, isStale,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const theme = useChartTheme()
    const { reliability, access, semanticLayer } = data.health
    const window = rangeLabel(range).toLowerCase()

    return (
        <div className={cn('space-y-6 transition-opacity', isStale && 'opacity-50')}>
            {/* ── Data trust ───────────────────────────────────────────
                Withheld for non-privileged viewers: refresh failures name
                which sources are unreliable, which is an operator's business.
                The panel still occupies the space so the page does not reflow
                into a different layout depending on who is reading it. */}
            {!reliability ? (
                <WithheldPanel
                    title="Data freshness is hidden"
                    reason="Refresh outcomes are visible to administrators and auditors. Ask one of them if you need to know how current a data source is."
                />
            ) : (
            <section aria-labelledby="health-reliability">
                <h2 id="health-reliability" className="text-sm font-bold text-ink mb-1">
                    Data freshness
                </h2>
                <p className="text-[11px] text-ink-muted mb-3">
                    Rising usage on stale data is the worst kind of good news.
                </p>

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
                        label="Never refreshed"
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
            </section>

            )}

            {/* ── Access friction ──────────────────────────────────────
                Withheld likewise: pending requests and invite acceptance
                identify people by implication. */}
            {!access ? (
                <WithheldPanel
                    title="Access requests are hidden"
                    reason="Who is waiting for access, and how quickly requests are answered, is visible to administrators and auditors."
                />
            ) : (
            <section aria-labelledby="health-access">
                <h2 id="health-access" className="text-sm font-bold text-ink mb-1">
                    Access friction
                </h2>
                <p className="text-[11px] text-ink-muted mb-3">
                    Every row here is a person who wanted in and is still waiting.
                </p>

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
            </section>

            )}

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
                        label="Sources drifting"
                        value={compact(semanticLayer.sourcesDrifting)}
                        sub="Schema moved since the mapping was written"
                        icon={AlertTriangle}
                        accent={semanticLayer.sourcesDrifting ? 'pink' : 'emerald'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Entity types modelled"
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
