/**
 * ContentTab — the views themselves: what exists, what gets read, who builds it.
 */
import { useState } from 'react'
import { Eye, EyeOff, LayoutGrid, PenLine, Share2 } from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate } from '@/lib/formatMetric'
import type {
    AnalyticsRangeSelection, AnalyticsSummary,
} from '@/services/analyticsService'
import { viewTypeLabel, visibilityLabel } from '@/lib/domainLabels'
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
import { comparisonLabel, previousLabel, rangePhrase } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function ContentTab({
    data, range, isStale,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
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

