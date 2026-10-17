/**
 * ContentTab — the views themselves: what exists, what gets read, who builds it.
 */
import { useState } from 'react'
import { Eye, EyeOff, LayoutGrid, MailOpen, PenLine, Share2, Timer, Users } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate, waitPhrase } from '@/lib/formatMetric'
import type {
    AnalyticsRangeSelection, AnalyticsSummary, AnalyticsUsageDoc, BuiltVsOpened,
} from '@/services/analyticsService'
import type { AnalyticsUsageState } from '@/hooks/useAnalytics'
import { viewTypeLabel, visibilityLabel } from '@/lib/domainLabels'
import { ControlGroup } from '@/components/ingestion/profiling/BoardFilters'
import { ViewLink } from './EntityLink'
import { viewMeta } from './viewMeta'
import { KpiCard } from './KpiCard'
import { WithheldPanel } from './Redacted'
import { Leaderboard } from './Leaderboard'
import { ContactLink } from './ContactLink'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { comparedSeries } from './comparedSeries'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar } from './charts/StackedShareBar'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { comparisonLabel, previousLabel, rangePhrase } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'
import { UsageSection } from './UsageSection'

export function ContentTab({
    data, range, isStale, usage,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
    /** Who reads what, from the usage document. */
    usage?: AnalyticsUsageState
}) {
    const theme = useChartTheme()
    const { totals, series, breakdowns, leaderboards } = data

    // `null` when the previous period has no dates to sit on — an
    // older cached document, mostly. The chart then draws this period
    // alone rather than guessing where the earlier bars belong.
    const beforeCreated = comparedSeries(
        series.previous.buckets, series.previous.viewsCreated)
    // Restricted rows stay by DEFAULT so the ranking agrees with the opens
    // total above it — "the most-opened thing here is something you cannot
    // see" is itself worth knowing. But a reader who can act on none of them
    // should be able to get them out of the way in one click.
    const [hideRestricted, setHideRestricted] = useState(false)
    const restrictedCount = leaderboards.topViews.filter((v) => v.redacted).length
    const shownViews = hideRestricted
        ? leaderboards.topViews.filter((v) => !v.redacted)
        : leaderboards.topViews
    const vs = comparisonLabel(range)

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <KpiCard
                    label="Views" metric="views" value={totals.views.total} icon={LayoutGrid}
                    changePct={totals.views.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.views.current ?? 0)} created in ${rangePhrase(range)}`}
                    trend={series.viewsCreated} accent="indigo"
                />
                <KpiCard
                    label="Shared openly" metric="collaboration" value={percent(breakdowns.collaborationRate)} icon={Share2}
                    sub="views visible beyond their author"
                    accent="emerald"
                />
                <KpiCard
                    label="Top-10 share" metric="concentration" value={percent(breakdowns.contentConcentration)} icon={Eye}
                    sub="of opens going to ten views"
                    higherIsBetter={false}
                    accent="amber"
                />
                {/* Sits beside Top-10 share on purpose: they are two halves of
                    the same question, and the concentration figure alone reads
                    as good news ("people know what they want") until you see
                    how much of the catalogue is getting nothing. */}
                <KpiCard
                    label="Not opened" metric="notOpened"
                    value={breakdowns.viewsNotOpenedShare == null
                        ? compact(breakdowns.viewsNotOpened)
                        : percent(breakdowns.viewsNotOpenedShare)}
                    icon={EyeOff}
                    sub={`${exact(breakdowns.viewsNotOpened)} of ${exact(totals.views.total)} views, in ${rangePhrase(range)}`}
                    higherIsBetter={false}
                    accent={(breakdowns.viewsNotOpenedShare ?? 0) > 0.5 ? 'amber' : 'cyan'}
                />
                <KpiCard
                    label="Semantic layers" metric="semanticLayers" value={totals.ontologies.total} icon={PenLine}
                    changePct={totals.ontologies.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.contextModels.total)} context models`}
                    accent="violet"
                />
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="Who can see what"
                    subtitle="View visibility across the platform"
                    isStale={isStale}
                    isEmpty={breakdowns.viewsByVisibility.length === 0}
                >
                    <StackedShareBar slices={breakdowns.viewsByVisibility} labelOf={visibilityLabel} />
                </ChartFrame>

                <ChartFrame
                    title="Kinds of view"
                    subtitle="What people build"
                    isStale={isStale}
                    isEmpty={breakdowns.viewsByType.length === 0}
                >
                    <StackedShareBar slices={breakdowns.viewsByType} labelOf={viewTypeLabel} />
                </ChartFrame>

                {/* Keyed on showsPeople, not on `applied`: `applied` is
                    true for every non-privileged reader, so keying on it
                    hid colleagues at the level that exists to show them. */}
                {data.redaction && !data.redaction.showsPeople ? (
                    <WithheldPanel
                        title="Top builders is hidden"
                        reason="Per-person contribution is visible to administrators and auditors only. The view counts above include everyone's work."
                    />
                ) : (
                <ChartFrame
                    title="Top builders"
                    subtitle={`Views created in ${rangePhrase(range)}`}
                    isStale={isStale}
                    isEmpty={leaderboards.topCreators.length === 0}
                    emptyLabel="Nobody created a view in this range."
                >
                    <Leaderboard
                        unit="views"
                        slot={4}
                        rows={leaderboards.topCreators.map((c) => ({
                            id: c.userId,
                            label: c.name,
                            value: c.viewsCreated,
                        }))}
                    />
                </ChartFrame>
                )}
            </div>

            <UsageSection usage={usage}>
                {(u) => <Readers content={u.content} range={range} isStale={!!usage?.isFetching} />}
            </UsageSection>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    id="chart-views-created"
                    title="Views created"
                    // The axis carries BOTH periods, so it says so: someone
                    // picking "30 days" and seeing 60 on the axis deserves to
                    // read why rather than work it out.
                    subtitle={`New views per bucket, against ${previousLabel(range).toLowerCase()}`}
                    isStale={isStale}
                    isEmpty={
                        // Both periods, not just this one: a chart that hid
                        // itself when the current window is flat would hide
                        // the very comparison explaining WHY it is flat.
                        series.viewsCreated.every((v) => v === 0)
                        && (beforeCreated?.values ?? []).every((v) => v === 0)
                    }
                    emptyLabel="No views created in this range."
                    series={[{ key: 'created', label: 'Views created', color: theme.series[0], shape: 'bar' }]}
                    ghostLabel={beforeCreated ? previousLabel(range) : undefined}
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={[...(beforeCreated?.buckets ?? []), ...series.buckets]
                                .map((b) => shortDate(b, true))}
                            columns={[
                                {
                                    key: 'created', label: 'Views created',
                                    values: [...(beforeCreated?.values ?? []), ...series.viewsCreated],
                                },
                                // The chart puts both periods on one axis, so the
                                // table does too — a twin that disagreed with the
                                // marks would be the wrong kind of twin.
                                {
                                    key: 'period', label: 'Period',
                                    values: [
                                        ...(beforeCreated?.buckets ?? []).map(() => previousLabel(range)),
                                        ...series.buckets.map(() => 'This period'),
                                    ],
                                },
                            ]}
                        />
                    }
                >
                    <BarSeriesChart
                        buckets={series.buckets} values={series.viewsCreated}
                        previous={beforeCreated ?? undefined}
                        previousLabel={previousLabel(range)}
                        label="views" slot={0}
                    />
                </ChartFrame>

                <ChartFrame
                    id="chart-popular-views"
                    title="Most popular views"
                    subtitle="Opens, and how many distinct people did the opening"
                    isStale={isStale}
                    isEmpty={shownViews.length === 0}
                    emptyLabel={hideRestricted && restrictedCount
                        ? 'Every view in this ranking is one you cannot open.'
                        : 'No views opened in this range.'}
                    action={restrictedCount > 0 ? (
                        <button
                            type="button"
                            onClick={() => setHideRestricted((v) => !v)}
                            aria-pressed={hideRestricted}
                            title={hideRestricted
                                ? `Show the ${restrictedCount} view${restrictedCount === 1 ? '' : 's'} you cannot open`
                                : `Hide the ${restrictedCount} view${restrictedCount === 1 ? '' : 's'} you cannot open`}
                            className={cn(
                                'inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                hideRestricted
                                    ? 'border-indigo-500/30 bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                                    : 'border-glass-border text-ink-muted hover:text-ink',
                            )}
                        >
                            {hideRestricted ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
                            {hideRestricted ? 'Showing yours only' : `Hide ${restrictedCount} restricted`}
                        </button>
                    ) : undefined}
                    table={
                        <ChartTable
                            rowLabel="View"
                            rows={shownViews.map((v) => v.name)}
                            columns={[
                                { key: 'opens', label: 'Opens', values: shownViews.map((v) => v.opens) },
                                { key: 'people', label: 'People', values: shownViews.map((v) => v.uniqueViewers) },
                                { key: 'favs', label: 'Favourites', values: shownViews.map((v) => v.favourites) },
                            ]}
                        />
                    }
                >
                    <Leaderboard
                        unit="opens"
                        slot={1}
                        rows={shownViews.map((v) => ({
                            id: v.viewId,
                            label: <ViewLink viewId={v.viewId} name={v.name} canOpen={v.canOpen} />,
                            meta: (
                                <span className="flex items-center gap-1.5 truncate">
                                    <span className="shrink-0">{viewMeta(v)}</span>
                                    <ContactLink email={v.createdByEmail} name={v.createdByName} />
                                </span>
                            ),
                            value: v.opens,
                            detail: `${exact(v.uniqueViewers)} ${v.uniqueViewers === 1 ? 'person' : 'people'}`,
                        }))}
                    />
                </ChartFrame>
            </div>
        </div>
    )
}

type BuiltBy = 'type' | 'visibility'

const BUILT_BY: { key: BuiltBy; label: string }[] = [
    { key: 'type', label: 'Kind' },
    { key: 'visibility', label: 'Who can see it' },
]

/**
 * Who reads, and what. The opens and views above count activity; these count
 * PEOPLE and REACH — a hundred opens by one person is not an audience.
 */
function Readers({
    content, range, isStale,
}: {
    content: AnalyticsUsageDoc['content']
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const theme = useChartTheme()
    const [builtBy, setBuiltBy] = useState<BuiltBy>('type')
    const { viewers, firstOpen } = content
    const readShare = firstOpen.built ? firstOpen.opened / firstOpen.built : null
    const builtRows = builtBy === 'type' ? content.byType : content.byVisibility
    const labelOf = builtBy === 'type' ? viewTypeLabel : visibilityLabel

    return (
        <section aria-labelledby="content-readers" className="space-y-3">
            <div>
                <h2 id="content-readers" className="text-sm font-bold text-ink mb-1">Readers</h2>
                <p className="text-[11px] text-ink-muted">
                    Who opens views, how far each one travels, and whether new work finds an audience.
                </p>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <KpiCard
                    label="Viewers" metric="uniqueViewers" icon={Users} accent="cyan"
                    value={viewers.current ?? 0}
                    changePct={viewers.changePct} comparisonLabel={comparisonLabel(range)}
                    sub={`${exact(content.viewsOpened)} ${content.viewsOpened === 1 ? 'view' : 'views'} opened`}
                    trend={content.uniqueViewers}
                />
                <KpiCard
                    label="New views read by others" icon={MailOpen}
                    accent={readShare != null && readShare < 0.5 ? 'amber' : 'emerald'}
                    value={readShare == null ? '—' : percent(readShare)}
                    sub={firstOpen.built
                        ? `${exact(firstOpen.opened)} of ${exact(firstOpen.built)} built in ${rangePhrase(range)}`
                        : `No views built in ${rangePhrase(range)}`}
                />
                <KpiCard
                    label="Time to first open" metric="firstOpen" icon={Timer} accent="violet"
                    value={waitPhrase(firstOpen.medianHours)}
                    sub={firstOpen.opened
                        ? `${exact(firstOpen.withinWeek)} opened within a week`
                        : 'No new view has been opened by someone else yet'}
                    higherIsBetter={false}
                />
            </div>
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="Viewers over time"
                    subtitle="Distinct people who opened a view, per period"
                    isStale={isStale}
                    isEmpty={content.uniqueViewers.every((v) => v === 0)}
                    emptyLabel="Nobody opened a view in this range."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={content.buckets.map((b) => shortDate(b, true))}
                            columns={[{ key: 'viewers', label: 'Viewers', values: content.uniqueViewers }]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={content.buckets} height={200}
                        series={[{ key: 'viewers', label: 'Viewers', values: content.uniqueViewers, slot: 2, area: true }]}
                    />
                </ChartFrame>
                <ChartFrame
                    title="How far views reach"
                    subtitle="Views opened in the range, by how many people opened each"
                    isStale={isStale}
                    isEmpty={content.viewsOpened === 0}
                    emptyLabel="No views opened in this range."
                    table={
                        <ChartTable
                            rowLabel="Opened by"
                            rows={content.reach.map((r) => reachLabel(r.key))}
                            columns={[{ key: 'views', label: 'Views', values: content.reach.map((r) => r.count) }]}
                        />
                    }
                >
                    <StackedShareBar slices={content.reach} labelOf={reachLabel} />
                </ChartFrame>
                <ChartFrame
                    title="Built against opened"
                    subtitle={`New views and opens in ${rangePhrase(range)}`}
                    isStale={isStale}
                    isEmpty={builtRows.length === 0}
                    emptyLabel="Nothing built or opened in this range."
                    toolbar={(
                        <ControlGroup
                            label="By" options={BUILT_BY}
                            value={builtBy} onChange={setBuiltBy}
                        />
                    )}
                >
                    <BuiltVsOpenedTable
                        rows={builtRows} labelOf={labelOf}
                        builtColor={theme.series[0]} opensColor={theme.series[2]}
                        caption={builtBy === 'type' ? 'Kind of view' : 'Who can see it'}
                    />
                </ChartFrame>
            </div>
        </section>
    )
}

/** "2–5" → "2–5 people". */
function reachLabel(band: string): string {
    return band === '1' ? '1 person' : `${band} people`
}

/**
 * Two columns, each scaled to its own largest value: built and opened are
 * different units, and one shared scale would flatten the smaller to nothing.
 * What reads off it is the MISMATCH — a kind people build a lot of and
 * rarely open, or the reverse.
 */
function BuiltVsOpenedTable({
    rows, labelOf, builtColor, opensColor, caption,
}: {
    rows: BuiltVsOpened[]
    labelOf: (key: string) => string
    builtColor: string
    opensColor: string
    caption: string
}) {
    const maxBuilt = Math.max(1, ...rows.map((r) => r.built))
    const maxOpens = Math.max(1, ...rows.map((r) => r.opens))
    return (
        <table className="w-full text-xs">
            <caption className="sr-only">Views built and opened, by {caption.toLowerCase()}</caption>
            <thead>
                <tr className="text-[10px] text-ink-muted">
                    <th scope="col" className="pb-2 text-left font-semibold">{caption}</th>
                    <th scope="col" className="pb-2 pl-3 text-left font-semibold">Built</th>
                    <th scope="col" className="pb-2 pl-3 text-left font-semibold">Opens</th>
                </tr>
            </thead>
            <tbody>
                {rows.map((r) => (
                    <tr key={r.key}>
                        <th scope="row" className="max-w-[8rem] truncate py-1.5 pr-1 text-left font-medium text-ink-secondary">
                            {labelOf(r.key)}
                        </th>
                        <td className="w-[38%] py-1.5 pl-3"><Meter value={r.built} max={maxBuilt} color={builtColor} /></td>
                        <td className="w-[38%] py-1.5 pl-3"><Meter value={r.opens} max={maxOpens} color={opensColor} /></td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

function Meter({ value, max, color }: { value: number; max: number; color: string }) {
    return (
        <span className="flex items-center gap-2" title={exact(value)}>
            <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-black/[0.05] dark:bg-white/[0.06]">
                {value > 0 && (
                    <span
                        className="block h-full rounded-full"
                        style={{ width: `${Math.max(3, (value / max) * 100)}%`, backgroundColor: color }}
                    />
                )}
            </span>
            <span className="w-9 text-right font-semibold tabular-nums text-ink">{compact(value)}</span>
        </span>
    )
}
