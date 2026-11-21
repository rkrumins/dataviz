/**
 * DataTab — what the platform holds, how it got there, and how it is kept.
 *
 * Three questions the other tabs cannot answer, because they count people:
 *
 *   1. How much is there to trace, and is it growing? Entities and
 *      relationships as they stood at the end of every period, overall, per
 *      workspace and per kind of source — and which sources moved most.
 *   2. What was connected, and how quickly did it become usable? Sources
 *      onboarded, versioned against external, and the wait for a first build.
 *   3. How much of it is under version control, and kept how?
 *   4. Do the sources say what they are — a description, tags, someone to
 *      ask, whether to trust them — and who is waiting for data or a
 *      workspace? (The requests are an operator's view, withheld below the
 *      posture that shows operations.)
 *
 * Entity counts are levels, not flows: a bucket shows what was held at its
 * end, so the line can fall — a source deleted, a graph pruned — and that fall
 * is information the dashboard used to have no way to show.
 */
import {
    ArrowDownRight, ArrowUpRight, Boxes, CheckCircle2, Clock, Database, FileText, GitBranch, Hourglass,
    Inbox, Network, PlugZap, ShieldCheck, Tags, UserCheck,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate, waitPhrase } from '@/lib/formatMetric'
import { humaniseKey, providerTypeLabel, versionKindLabel } from '@/lib/domainLabels'
import type { AnalyticsDataDoc, AnalyticsRangeSelection, DataMover } from '@/services/analyticsService'
import { KpiCard } from './KpiCard'
import { Leaderboard } from './Leaderboard'
import { MetricInfo } from './MetricInfo'
import { WithheldPanel } from './Redacted'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { StackedAreaChart, type StackedSeries } from './charts/StackedAreaChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar } from './charts/StackedShareBar'
import { useChartTheme } from './charts/chartTheme'
import { classificationLabel, classificationSlot, providerSlot, trustLabel, trustSlot } from './slots'
import { WorkspaceLink } from './EntityLink'
import { comparisonLabel, rangePhrase } from './RangePicker'

/** `+1,204`, `−30` — a true minus, which a hyphen only resembles. */
function signed(n: number): string {
    return `${n > 0 ? '+' : n < 0 ? '−' : ''}${exact(Math.abs(n))}`
}

export function DataTab({
    data, range, isStale,
}: {
    data: AnalyticsDataDoc
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const theme = useChartTheme()
    const { growth, onboarding, versionControl, coverage } = data
    const phrase = rangePhrase(range)
    const dates = growth.buckets.map((b) => shortDate(b, true))
    // The axis can drop the year the readout keeps: ticks are read in a row.
    const axis = growth.buckets.map((b) => shortDate(b))
    const vc = versionControl.available ? versionControl : null
    const share = vc && vc.share.total ? vc.share.versioned / vc.share.total : null
    // History that starts inside the window: earlier buckets are "no data",
    // which the chart alone would draw exactly like an empty platform.
    const historyFrom = coverage.entitiesSince && coverage.entitiesSince > data.range.from.slice(0, 10)
        ? coverage.entitiesSince : null

    const workspaceBands = bandsByWorkspace(growth.byWorkspace)
    const typeBands: StackedSeries[] = growth.byProviderType.map((b) => ({
        key: b.key,
        label: providerTypeLabel(b.key),
        values: b.entities,
        slot: providerSlot(b.key) ?? 5,
        residual: b.key === 'unknown',
    }))
    const legendOf = (bands: StackedSeries[]) => bands.map((b) => ({
        key: b.key, label: b.label, shape: 'area' as const,
        color: b.residual ? theme.neutralMark : theme.series[b.slot],
    }))
    const onboardedTotal = onboarding.total.reduce((a, b) => a + b, 0)
    const adoptedPerBucket = vc
        ? vc.adopted.buckets.map((_, i) => vc.adopted.series.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
        : []

    return (
        <div className={cn('space-y-8 transition-opacity', isStale && 'opacity-50')}>
            {/* ── What the platform holds ─────────────────────────────── */}
            <section aria-labelledby="data-holds" className="space-y-4">
                <div>
                    <h2 id="data-holds" className="text-sm font-bold text-ink mb-1">What the platform holds</h2>
                    <p className="text-[11px] text-ink-muted">
                        Every connected source, as it stood at the end of each period.
                        {historyFrom && <> History begins {shortDate(historyFrom, true)}; earlier periods have no data, not zero.</>}
                    </p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                    <KpiCard
                        label="Entities" metric="entities" icon={Boxes} accent="indigo"
                        value={compact(growth.totals.entities.end)}
                        changePct={growth.totals.entities.changePct}
                        comparisonLabel="since the range began"
                        sub={`${signed(growth.totals.entities.change)} in ${phrase}`}
                        trend={growth.entities}
                    />
                    <KpiCard
                        label="Relationships" metric="relationships" icon={Network} accent="violet"
                        value={compact(growth.totals.relationships.end)}
                        changePct={growth.totals.relationships.changePct}
                        comparisonLabel="since the range began"
                        sub={`${signed(growth.totals.relationships.change)} in ${phrase}`}
                        trend={growth.relationships}
                    />
                    <KpiCard
                        label="Sources onboarded" metric="sourcesOnboarded" icon={Database} accent="amber"
                        value={exact(onboarding.totals.sources.current ?? 0)}
                        changePct={onboarding.totals.sources.changePct}
                        comparisonLabel="vs the period before"
                        sub={`${exact(onboarding.totals.sources.total)} connected now`}
                    />
                    <KpiCard
                        label="Under version control" metric="versionControlShare" icon={GitBranch} accent="emerald"
                        value={share == null ? '—' : percent(share)}
                        sub={vc
                            ? `${exact(vc.share.versioned)} of ${exact(vc.share.total)} sources`
                            : 'Version control could not be read just now'}
                    />
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <ChartFrame
                        title="Entities" subtitle="Held at the end of each period"
                        isStale={isStale}
                        isEmpty={growth.entities.every((v) => v === 0)}
                        emptyLabel="No profiled sources in this range yet."
                        table={<ChartTable rowLabel="Date" rows={dates}
                            columns={[{ key: 'entities', label: 'Entities', values: growth.entities }]} />}
                    >
                        <TimeSeriesChart buckets={growth.buckets}
                            series={[{ key: 'entities', label: 'Entities', values: growth.entities, slot: 0, area: true }]} />
                    </ChartFrame>
                    <ChartFrame
                        title="Relationships" subtitle="Held at the end of each period, lineage rollup included"
                        isStale={isStale}
                        isEmpty={growth.relationships.every((v) => v === 0)}
                        emptyLabel="No profiled sources in this range yet."
                        table={<ChartTable rowLabel="Date" rows={dates}
                            columns={[{ key: 'relationships', label: 'Relationships', values: growth.relationships }]} />}
                    >
                        <TimeSeriesChart buckets={growth.buckets}
                            series={[{ key: 'relationships', label: 'Relationships', values: growth.relationships, slot: 4, area: true }]} />
                    </ChartFrame>
                </div>

                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <ChartFrame
                        title="Entities by workspace" subtitle="The largest workspaces; the rest as Other"
                        isStale={isStale}
                        isEmpty={workspaceBands.length === 0}
                        emptyLabel="No profiled sources in this range yet."
                        series={legendOf(workspaceBands)}
                        table={<ChartTable rowLabel="Date" rows={dates}
                            columns={workspaceBands.map((b) => ({ key: b.key, label: b.label, values: b.values }))} />}
                    >
                        <StackedAreaChart buckets={growth.buckets} series={workspaceBands}
                            formatBucket={(b) => shortDate(b, true)} axisLabels={axis} />
                    </ChartFrame>
                    <ChartFrame
                        title="Entities by kind of source" subtitle="Graph stores and catalogues"
                        isStale={isStale}
                        isEmpty={typeBands.length === 0}
                        emptyLabel="No profiled sources in this range yet."
                        series={legendOf(typeBands)}
                        table={<ChartTable rowLabel="Date" rows={dates}
                            columns={typeBands.map((b) => ({ key: b.key, label: b.label, values: b.values }))} />}
                    >
                        <StackedAreaChart buckets={growth.buckets} series={typeBands}
                            formatBucket={(b) => shortDate(b, true)} axisLabels={axis} />
                    </ChartFrame>
                </div>

                <ChartFrame
                    title="Biggest movers" subtitle={`Sources whose entity count changed most in ${phrase}`}
                    isStale={isStale}
                    isEmpty={growth.movers.length === 0}
                    emptyLabel="No source changed size in this range."
                    table={<ChartTable rowLabel="Source" rows={growth.movers.map((m) => m.name)}
                        columns={[
                            { key: 'start', label: 'At the start', values: growth.movers.map((m) => m.start) },
                            { key: 'end', label: 'At the end', values: growth.movers.map((m) => m.end) },
                            { key: 'change', label: 'Change', values: growth.movers.map((m) => m.change) },
                        ]} />}
                >
                    <ol className="divide-y divide-glass-border">
                        {growth.movers.map((m) => <MoverRow key={`${m.dataSourceId ?? m.name}:${m.start}`} mover={m} />)}
                    </ol>
                </ChartFrame>
            </section>

            {/* ── Onboarding ─────────────────────────────────────────── */}
            <section aria-labelledby="data-onboarding" className="space-y-4">
                <div>
                    <h2 id="data-onboarding" className="text-sm font-bold text-ink mb-1">Onboarding</h2>
                    <p className="text-[11px] text-ink-muted">
                        What was connected, from where, and how long it took to become usable.
                    </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                    <KpiCard
                        label="Time to first build" metric="firstBuild" icon={Clock} accent="cyan"
                        caveat={coverage.jobsKeptDays === null ? undefined
                            : `Aggregation runs are kept for ${coverage.jobsKeptDays} days, and each source's latest runs whatever their age: a source connected earlier may have lost the run that built it first.`}
                        value={waitPhrase(onboarding.firstBuild.medianHours)}
                        sub={onboarding.firstBuild.measured
                            ? `middle of ${exact(onboarding.firstBuild.measured)} · slowest tenth ${waitPhrase(onboarding.firstBuild.p90Hours)}`
                            : 'No new source finished a build in this range'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Awaiting a first build" icon={Hourglass}
                        accent={onboarding.firstBuild.awaiting ? 'amber' : 'emerald'}
                        value={exact(onboarding.firstBuild.awaiting)}
                        sub={onboarding.firstBuild.awaiting
                            ? 'Connected in this range, lineage not built yet'
                            : 'Every new source has been built'}
                    />
                    <div className="rounded-2xl border border-glass-border bg-canvas-elevated p-4 space-y-3">
                        <p className="text-[11px] font-semibold text-ink-muted">Where they came from</p>
                        {onboardedTotal === 0 ? (
                            <p className="text-xs text-ink-muted">Nothing was connected in {phrase}.</p>
                        ) : (
                            <>
                                {onboarding.versioned && onboarding.external && (
                                    <div>
                                        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Kept how</p>
                                        <StackedShareBar
                                            slices={[
                                                { key: 'versioned', count: onboarding.versioned.reduce((a, b) => a + b, 0) },
                                                { key: 'external', count: onboarding.external.reduce((a, b) => a + b, 0) },
                                            ]}
                                            labelOf={(k) => (k === 'versioned' ? 'Under version control' : 'External')}
                                        />
                                    </div>
                                )}
                                <div>
                                    <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Kind of source</p>
                                    <StackedShareBar
                                        slices={onboarding.byProviderType}
                                        labelOf={providerTypeLabel} slotOf={providerSlot}
                                    />
                                </div>
                            </>
                        )}
                    </div>
                </div>
                <ChartFrame
                    title="Sources onboarded" subtitle="New connections per period"
                    isStale={isStale}
                    isEmpty={onboardedTotal === 0}
                    emptyLabel="No sources connected in this range."
                    table={<ChartTable rowLabel="Date" rows={onboarding.buckets.map((b) => shortDate(b, true))}
                        columns={[
                            { key: 'total', label: 'Sources', values: onboarding.total },
                            ...(onboarding.versioned ? [{ key: 'versioned', label: 'Under version control', values: onboarding.versioned }] : []),
                            ...(onboarding.external ? [{ key: 'external', label: 'External', values: onboarding.external }] : []),
                        ]} />}
                >
                    <BarSeriesChart buckets={onboarding.buckets} values={onboarding.total} label="sources" slot={5} />
                </ChartFrame>
            </section>

            {/* ── Version control ────────────────────────────────────── */}
            <section aria-labelledby="data-versioning" className="space-y-4">
                <div>
                    <h2 id="data-versioning" className="text-sm font-bold text-ink mb-1">Version control</h2>
                    <p className="text-[11px] text-ink-muted">
                        Graphs kept with drafts, reviews and a full history of change.
                    </p>
                </div>
                {!vc ? (
                    <div role="status" className="rounded-xl border border-glass-border bg-canvas-elevated px-4 py-6 text-center text-xs text-ink-muted">
                        Version control could not be read just now. The rest of this page is unaffected — try again in a few minutes.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                        <ChartFrame title="How they are kept" subtitle="Versioned graphs today, by kind" isStale={isStale}
                            isEmpty={vc.byKind.every((k) => k.count === 0)}
                            emptyLabel="No graph is under version control yet."
                            table={<ChartTable rowLabel="Kind" rows={vc.byKind.map((k) => versionKindLabel(k.key))}
                                columns={[{ key: 'n', label: 'Graphs', values: vc.byKind.map((k) => k.count) }]} />}
                        >
                            <StackedShareBar slices={vc.byKind.filter((k) => k.count > 0)} labelOf={versionKindLabel} />
                        </ChartFrame>
                        <ChartFrame title="Put under version control" subtitle="Graphs per period" isStale={isStale}
                            className="xl:col-span-2"
                            isEmpty={adoptedPerBucket.every((v) => v === 0)}
                            emptyLabel={`No graph was put under version control in ${phrase}.`}
                            table={<ChartTable rowLabel="Date" rows={vc.adopted.buckets.map((b) => shortDate(b, true))}
                                columns={vc.adopted.series.map((s) => ({ key: s.key, label: versionKindLabel(s.key), values: s.values }))} />}
                        >
                            <BarSeriesChart buckets={vc.adopted.buckets} values={adoptedPerBucket} label="graphs" slot={2} />
                        </ChartFrame>
                    </div>
                )}
            </section>

            {/* Both absent from a document built before they existed. */}
            {data.details && <SourceDetails details={data.details} isStale={isStale} />}
            {data.requests ? (
                <Requests requests={data.requests} range={range} />
            ) : data.redaction?.applied && (
                <section aria-labelledby="data-requests" className="space-y-4">
                    <RequestsHeading />
                    <WithheldPanel
                        title="Requests are hidden"
                        shape="stats"
                        reason="Who is waiting for data or for a workspace, and how quickly requests are answered, is visible to administrators and auditors."
                    />
                </section>
            )}
        </div>
    )
}

/** A share, or `null` when there is nothing to divide. */
function share(part: number, whole: number): number | null {
    return whole ? part / whole : null
}

function SourceDetails({
    details, isStale,
}: {
    details: NonNullable<AnalyticsDataDoc['details']>
    isStale: boolean
}) {
    const { sources } = details
    const count = (rows: { key: string; count: number }[], key: string) =>
        rows.find((r) => r.key === key)?.count ?? 0
    const certified = count(details.trust, 'certified')
    const tags = details.topTags.slice(0, 10)
    const of = (n: number) => `${exact(n)} of ${exact(sources)} sources`

    return (
        <section aria-labelledby="data-details" className="space-y-4">
            <div>
                <h2 id="data-details" className="text-sm font-bold text-ink mb-1">How sources are described</h2>
                <p className="text-[11px] text-ink-muted">
                    Whether each connected source says what it is, how it is labelled, who to ask about it, and whether to trust it.
                </p>
            </div>
            <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                <KpiCard
                    label="Described" metric="sourcesDescribed" icon={FileText} accent="indigo"
                    value={percent(share(details.described, sources))} sub={of(details.described)}
                />
                <KpiCard
                    label="Tagged" metric="sourcesTagged" icon={Tags} accent="violet"
                    value={percent(share(details.tagged, sources))} sub={of(details.tagged)}
                />
                <KpiCard
                    label="Named contacts" metric="sourcesWithContacts" icon={UserCheck} accent="emerald"
                    value={percent(share(details.withContacts, sources))} sub={of(details.withContacts)}
                />
                <KpiCard
                    label="Certified" metric="trustStatus" icon={ShieldCheck} accent="cyan"
                    value={percent(share(certified, sources))}
                    sub={`${exact(count(details.trust, 'in_review'))} in review · ${exact(count(details.trust, 'deprecated'))} deprecated`}
                />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="Trust" subtitle="Every connected source, by how it is marked"
                    action={<MetricInfo metric="trustStatus" />}
                    isStale={isStale} isEmpty={sources === 0}
                    emptyLabel="No sources are connected yet."
                    table={<ChartTable rowLabel="Trust" rows={details.trust.map((t) => trustLabel(t.key))}
                        columns={[{ key: 'n', label: 'Sources', values: details.trust.map((t) => t.count) }]} />}
                >
                    <StackedShareBar slices={details.trust} labelOf={trustLabel} slotOf={trustSlot} />
                </ChartFrame>
                <ChartFrame
                    title="Classification" subtitle="How sensitive their data is marked to be"
                    action={<MetricInfo metric="classification" />}
                    isStale={isStale} isEmpty={sources === 0}
                    emptyLabel="No sources are connected yet."
                    table={<ChartTable rowLabel="Classification" rows={details.classification.map((c) => classificationLabel(c.key))}
                        columns={[{ key: 'n', label: 'Sources', values: details.classification.map((c) => c.count) }]} />}
                >
                    <StackedShareBar slices={details.classification} labelOf={classificationLabel} slotOf={classificationSlot} />
                </ChartFrame>
                <ChartFrame
                    title="Most used tags" subtitle="Tags on the most sources"
                    action={<MetricInfo metric="topTags" />}
                    isStale={isStale} isEmpty={tags.length === 0}
                    emptyLabel="No source has a tag yet."
                >
                    <Leaderboard
                        unit="sources" unitOne="source" slot={5}
                        rows={tags.map((t) => ({ id: t.key, label: t.key, value: t.count }))}
                    />
                </ChartFrame>
            </div>
            {details.byWorkspace.length > 0 && (
                <ChartFrame
                    title="By workspace" subtitle="The workspaces with the most sources"
                    isStale={isStale}
                >
                    <CoverageTable rows={details.byWorkspace} />
                </ChartFrame>
            )}
        </section>
    )
}

function CoverageTable({ rows }: { rows: NonNullable<AnalyticsDataDoc['details']>['byWorkspace'] }) {
    const cell = (part: number, whole: number) => (
        <td className="px-3 py-1.5 text-right tabular-nums text-ink" title={`${exact(part)} of ${exact(whole)}`}>
            {percent(share(part, whole))}
        </td>
    )
    return (
        <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] text-xs">
                <caption className="sr-only">How the sources in each workspace are described</caption>
                <thead>
                    <tr className="border-b border-glass-border text-[10px] text-ink-muted">
                        <th scope="col" className="px-3 py-2 text-left font-semibold">Workspace</th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">Sources</th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">Described</th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">Tagged</th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">Named contacts</th>
                        <th scope="col" className="px-3 py-2 text-right font-semibold">Certified</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={r.workspaceId ?? `hidden-${i}`} className="border-b border-glass-border last:border-b-0">
                            <th scope="row" className="max-w-[14rem] truncate px-3 py-1.5 text-left font-medium text-ink-secondary">
                                {r.workspaceId
                                    ? <WorkspaceLink workspaceId={r.workspaceId} name={r.name} canOpen={r.canOpen} />
                                    : <span className="text-ink-muted">{r.name}</span>}
                            </th>
                            <td className="px-3 py-1.5 text-right tabular-nums text-ink">{exact(r.sources)}</td>
                            {cell(r.described, r.sources)}
                            {cell(r.tagged, r.sources)}
                            {cell(r.withContacts, r.sources)}
                            {cell(r.certified, r.sources)}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

function RequestsHeading() {
    return (
        <div>
            <h2 id="data-requests" className="text-sm font-bold text-ink mb-1">Requests</h2>
            <p className="text-[11px] text-ink-muted">
                Data people asked to have connected, and workspaces people asked for — and how long they waited.
            </p>
        </div>
    )
}

const URGENCY_LABEL: Record<string, string> = {
    this_week: 'this week', this_month: 'this month', no_rush: 'no rush',
}

function Requests({
    requests, range,
}: {
    requests: NonNullable<AnalyticsDataDoc['requests']>
    range: AnalyticsRangeSelection
}) {
    const { data, workspaces } = requests
    const vs = comparisonLabel(range)
    const phrase = rangePhrase(range)
    return (
        <section aria-labelledby="data-requests" className="space-y-4">
            <RequestsHeading />
            <div className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Data requests</h3>
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                    <KpiCard
                        label="Asked for" metric="dataRequests" icon={Inbox} accent="indigo"
                        value={data.asked.current ?? 0} changePct={data.asked.changePct} comparisonLabel={vs}
                        sub={`${exact(data.asked.total)} in all`}
                    />
                    <KpiCard
                        label="Connected" icon={PlugZap} accent="emerald"
                        value={data.connected} sub={`${exact(data.declined)} declined in ${phrase}`}
                    />
                    <KpiCard
                        label="Open now" icon={Hourglass} accent={data.open ? 'amber' : 'emerald'}
                        value={data.open} higherIsBetter={false}
                        sub={data.open
                            ? data.openByUrgency.filter((u) => u.count).map((u) => `${exact(u.count)} ${URGENCY_LABEL[u.key] ?? humaniseKey(u.key)}`).join(' · ')
                            : 'Nothing waiting'}
                    />
                    <KpiCard
                        label="Time to connect" metric="timeToConnect" icon={Clock} accent="violet"
                        value={waitPhrase(data.medianHoursToConnect)} higherIsBetter={false}
                        sub={data.connected ? `middle of ${exact(data.connected)} connected` : `None connected in ${phrase}`}
                    />
                </div>
            </div>
            <div className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">Workspace requests</h3>
                <div className="grid gap-3 grid-cols-2 lg:grid-cols-4">
                    <KpiCard
                        label="Submitted" metric="workspaceRequests" icon={Inbox} accent="indigo"
                        value={workspaces.submitted.current ?? 0} changePct={workspaces.submitted.changePct}
                        comparisonLabel={vs} sub={`${exact(workspaces.submitted.total)} in all`}
                    />
                    <KpiCard
                        label="Approved" icon={CheckCircle2} accent="emerald"
                        value={workspaces.approved} sub={`${exact(workspaces.declined)} declined in ${phrase}`}
                    />
                    <KpiCard
                        label="Open now" icon={Hourglass} accent={workspaces.open ? 'amber' : 'emerald'}
                        value={workspaces.open} higherIsBetter={false}
                        sub={workspaces.changesRequested
                            ? `${exact(workspaces.changesRequested)} waiting on the person who asked`
                            : workspaces.open ? 'All waiting on an approver' : 'Nothing waiting'}
                    />
                    <KpiCard
                        label="Time to a decision" metric="timeToDecision" icon={Clock} accent="violet"
                        value={waitPhrase(workspaces.medianHoursToDecision)} higherIsBetter={false}
                        sub={workspaces.approved + workspaces.declined
                            ? `middle of ${exact(workspaces.approved + workspaces.declined)} decided`
                            : `None decided in ${phrase}`}
                    />
                </div>
            </div>
        </section>
    )
}

/**
 * One band per workspace, except those the reader cannot see: every one of
 * them is called "Restricted workspace", and a legend listing the same name
 * twice in two colours is a puzzle. They share one band, which takes the
 * slot of the first of them so the named bands keep theirs.
 */
function bandsByWorkspace(rows: AnalyticsDataDoc['growth']['byWorkspace']): StackedSeries[] {
    const bands: StackedSeries[] = []
    let hidden: StackedSeries | null = null
    rows.forEach((b, i) => {
        if (b.redacted) {
            if (hidden) {
                hidden.values = hidden.values.map((v, j) => v + (b.entities[j] ?? 0))
            } else {
                hidden = { key: 'hidden', label: 'Workspaces you are not in', values: [...b.entities], slot: i }
                bands.push(hidden)
            }
            return
        }
        bands.push({
            key: b.workspaceId ?? 'other',
            label: b.name ?? 'Unnamed workspace',
            values: b.entities,
            slot: i,
            residual: b.workspaceId === null,
        })
    })
    return bands
}

function MoverRow({ mover }: { mover: DataMover }) {
    const up = mover.change > 0
    const Arrow = up ? ArrowUpRight : ArrowDownRight
    return (
        <li className="flex items-center gap-3 py-2.5">
            <span
                aria-hidden
                className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-lg',
                    up ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
                )}
            >
                <Arrow className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-sm', mover.redacted ? 'text-ink-muted' : 'font-semibold text-ink')}>
                    {mover.name}
                </span>
                <span className="block truncate text-[11px] text-ink-muted">
                    {mover.workspaceId && mover.workspaceName
                        ? <WorkspaceLink workspaceId={mover.workspaceId} name={mover.workspaceName} canOpen={mover.canOpen} />
                        : mover.workspaceName ?? '—'}
                </span>
            </span>
            <span className="shrink-0 text-right tabular-nums">
                <span className={cn('block text-sm font-semibold', up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {signed(mover.change)}
                </span>
                <span className="block text-[11px] text-ink-muted">{compact(mover.start)} → {compact(mover.end)}</span>
            </span>
        </li>
    )
}
