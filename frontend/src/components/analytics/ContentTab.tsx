/**
 * ContentTab — the views themselves: what exists, what gets read, who builds it.
 */
import { Eye, LayoutGrid, PenLine, Share2 } from 'lucide-react'

import { exact, percent, shortDate } from '@/lib/formatMetric'
import type {
    AnalyticsRangeSelection, AnalyticsSummary,
} from '@/services/analyticsService'
import { viewTypeLabel, visibilityLabel } from '@/lib/domainLabels'
import { KpiCard } from './KpiCard'
import { WithheldPanel } from './Redacted'
import { Leaderboard } from './Leaderboard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar } from './charts/StackedShareBar'
import { comparisonLabel, rangeLabel } from './RangePicker'

export function ContentTab({
    data, range, isStale,
}: {
    data: AnalyticsSummary
    range: AnalyticsRangeSelection
    isStale: boolean
}) {
    const { totals, series, breakdowns, leaderboards } = data
    const vs = comparisonLabel(range)

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Views" value={totals.views.total} icon={LayoutGrid}
                    changePct={totals.views.changePct} comparisonLabel={vs}
                    sub={`${exact(totals.views.current ?? 0)} created in range`}
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
                <KpiCard
                    label="Semantic layers" value={totals.ontologies.total} icon={PenLine}
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

                {data.redaction?.applied ? (
                    <WithheldPanel
                        title="Top builders is hidden"
                        reason="Per-person contribution is visible to administrators and auditors only. The view counts above include everyone's work."
                    />
                ) : (
                <ChartFrame
                    title="Top builders"
                    subtitle={`Views created in ${rangeLabel(range).toLowerCase()}`}
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
                    title="Views created"
                    subtitle="New views per period"
                    isStale={isStale}
                    isEmpty={series.viewsCreated.every((v) => v === 0)}
                    emptyLabel="No views created in this range."
                    table={
                        <ChartTable
                            rowLabel="Date"
                            rows={series.buckets.map((b) => shortDate(b, true))}
                            columns={[{ key: 'created', label: 'Views created', values: series.viewsCreated }]}
                        />
                    }
                >
                    <BarSeriesChart
                        buckets={series.buckets} values={series.viewsCreated}
                        previous={series.previous.viewsCreated}
                        label="views" slot={0}
                    />
                </ChartFrame>

                <ChartFrame
                    title="Most popular views"
                    subtitle="Opens, and how many distinct people did the opening"
                    isStale={isStale}
                    isEmpty={leaderboards.topViews.length === 0}
                    emptyLabel="No views opened in this range."
                    table={
                        <ChartTable
                            rowLabel="View"
                            rows={leaderboards.topViews.map((v) => v.name)}
                            columns={[
                                { key: 'opens', label: 'Opens', values: leaderboards.topViews.map((v) => v.opens) },
                                { key: 'people', label: 'People', values: leaderboards.topViews.map((v) => v.uniqueViewers) },
                                { key: 'favs', label: 'Favourites', values: leaderboards.topViews.map((v) => v.favourites) },
                            ]}
                        />
                    }
                >
                    <Leaderboard
                        unit="opens"
                        slot={1}
                        rows={leaderboards.topViews.map((v) => ({
                            id: v.viewId,
                            label: v.name,
                            meta: `${viewTypeLabel(v.viewType)} · ${visibilityLabel(v.visibility)}`,
                            value: v.opens,
                            detail: `${exact(v.uniqueViewers)} ${v.uniqueViewers === 1 ? 'person' : 'people'}`,
                        }))}
                    />
                </ChartFrame>
            </div>
        </div>
    )
}

