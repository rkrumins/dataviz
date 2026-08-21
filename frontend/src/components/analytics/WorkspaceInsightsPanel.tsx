/**
 * WorkspaceInsightsPanel — one workspace's full analytics, in a slide-over.
 *
 * A panel rather than a route: the reader arrives from a table row, compares a
 * couple of workspaces, and goes back. Pushing a route for that loses their
 * sort order and scroll position on the way back.
 */
import { useEffect, useRef } from 'react'
import { Activity, LayoutGrid, MousePointerClick, Users, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { viewTypeLabel, visibilityLabel } from '@/lib/domainLabels'
import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import { timeAgo } from '@/lib/timeAgo'
import { exact, shortDate } from '@/lib/formatMetric'
import { Backdrop } from '@/components/ui/Backdrop'
import { useWorkspaceAnalyticsDetail } from '@/hooks/useAnalytics'
import { ViewLink } from './EntityLink'
import { WithheldPanel } from './Redacted'
import { KpiCard } from './KpiCard'
import { Leaderboard } from './Leaderboard'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { BarSeriesChart } from './charts/BarSeriesChart'
import { StackedShareBar } from './charts/StackedShareBar'
import { comparisonLabel, rangePhrase } from './RangePicker'
import { useChartTheme } from './charts/chartTheme'

export function WorkspaceInsightsPanel({
    workspaceId, range, onClose,
}: {
    workspaceId: string | null
    range: AnalyticsRangeSelection
    onClose: () => void
}) {
    const theme = useChartTheme()
    const { data, isLoading, isFetching, error } = useWorkspaceAnalyticsDetail(workspaceId, range)
    const closeRef = useRef<HTMLButtonElement>(null)

    useEffect(() => {
        if (!workspaceId) return
        closeRef.current?.focus()
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [workspaceId, onClose])

    const open = !!workspaceId

    return (
        <>
            <Backdrop open={open} onClick={onClose} zClassName="z-40" />
            <aside
                role="dialog"
                aria-modal="true"
                aria-label={data ? `${data.name} analytics` : 'Workspace analytics'}
                className={cn(
                    'fixed inset-y-0 right-0 z-50 w-full max-w-3xl border-l border-glass-border bg-canvas-elevated shadow-2xl transition-transform duration-300 flex flex-col',
                    open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
                )}
            >
                <header className="shrink-0 flex items-start justify-between gap-4 border-b border-glass-border px-6 py-4">
                    <div className="min-w-0">
                        <h2 className="text-lg font-bold text-ink truncate">
                            {data?.name ?? 'Workspace'}
                        </h2>
                        <p className="text-xs text-ink-muted truncate">
                            {data?.description
                                || (data ? `Created ${timeAgo(data.createdAt)}` : 'Loading insights…')}
                        </p>
                    </div>
                    <button
                        ref={closeRef}
                        type="button"
                        onClick={onClose}
                        aria-label="Close workspace analytics"
                        className="shrink-0 p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    >
                        <X className="w-4 h-4" />
                    </button>
                </header>

                <div className="flex-1 overflow-y-auto px-6 py-5">
                    {error ? (
                        <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
                            {error.message}
                        </p>
                    ) : isLoading || !data ? (
                        <PanelSkeleton />
                    ) : (
                        <div className={cn('space-y-4 transition-opacity', isFetching && 'opacity-60')}>
                            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                                <KpiCard
                                    label="Views" metric="views" value={data.totals.views.total} icon={LayoutGrid}
                                    changePct={data.totals.views.changePct}
                                    comparisonLabel={comparisonLabel(range)}
                                    sub={`${exact(data.totals.views.current ?? 0)} new in range`}
                                    accent="indigo"
                                />
                                <KpiCard
                                    label="View opens" metric="viewOpens" value={data.totals.viewOpens.total}
                                    icon={MousePointerClick}
                                    changePct={data.totals.viewOpens.changePct}
                                    comparisonLabel={comparisonLabel(range)}
                                    accent="cyan"
                                />
                                <KpiCard
                                    label="Active users" metric="activeUsers" value={data.totals.activeUsers.current ?? 0}
                                    icon={Users}
                                    changePct={data.totals.activeUsers.changePct}
                                    comparisonLabel={comparisonLabel(range)}
                                    sub={`${exact(data.totals.members.total)} members`}
                                    accent="emerald"
                                />
                                <KpiCard
                                    label="Actions" metric="actionsTaken" value={data.totals.activity.current ?? 0}
                                    icon={Activity}
                                    changePct={data.totals.activity.changePct}
                                    comparisonLabel={comparisonLabel(range)}
                                    accent="violet"
                                />
                            </div>

                            <ChartFrame
                                title="Activity over time"
                                subtitle={`Actions and active people across ${rangePhrase(range)}`}
                                series={[
                                    { key: 'actions', label: 'Actions', color: theme.series[0], shape: 'line' },
                                    { key: 'people', label: 'Active people', color: theme.series[1], shape: 'line' },
                                ]}
                                isEmpty={data.series.activityEvents.every((v) => v === 0)
                                    && data.series.activeUsers.every((v) => v === 0)}
                                emptyLabel="Nothing happened here in this range."
                                table={
                                    <ChartTable
                                        rowLabel="Date"
                                        rows={data.series.buckets.map((b) => shortDate(b, true))}
                                        columns={[
                                            { key: 'actions', label: 'Actions', values: data.series.activityEvents },
                                            { key: 'people', label: 'Active people', values: data.series.activeUsers },
                                        ]}
                                    />
                                }
                            >
                                <TimeSeriesChart
                                    buckets={data.series.buckets}
                                    height={180}
                                    series={[
                                        { key: 'actions', label: 'Actions', values: data.series.activityEvents, slot: 0 },
                                        { key: 'people', label: 'Active people', values: data.series.activeUsers, slot: 1 },
                                    ]}
                                />
                            </ChartFrame>

                            <ChartFrame
                                title="Views created"
                                subtitle="New views per period"
                                isEmpty={data.series.viewsCreated.every((v) => v === 0)}
                                emptyLabel="No views created here in this range."
                                table={
                                    <ChartTable
                                        rowLabel="Date"
                                        rows={data.series.buckets.map((b) => shortDate(b, true))}
                                        columns={[{ key: 'created', label: 'Views', values: data.series.viewsCreated }]}
                                    />
                                }
                            >
                                <BarSeriesChart
                                    buckets={data.series.buckets}
                                    values={data.series.viewsCreated}
                                    label="views"
                                    height={160}
                                />
                            </ChartFrame>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <ChartFrame
                                    title="Who can see what"
                                    isEmpty={data.breakdowns.viewsByVisibility.length === 0}
                                >
                                    <StackedShareBar slices={data.breakdowns.viewsByVisibility} labelOf={visibilityLabel} />
                                </ChartFrame>
                                <ChartFrame
                                    title="Kinds of view"
                                    isEmpty={data.breakdowns.viewsByType.length === 0}
                                >
                                    <StackedShareBar slices={data.breakdowns.viewsByType} labelOf={viewTypeLabel} />
                                </ChartFrame>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <ChartFrame
                                    title="Most opened here"
                                    isEmpty={data.topViews.length === 0}
                                    emptyLabel="No views opened here in this range."
                                >
                                    <Leaderboard
                                        unit="opens"
                                        slot={1}
                                        rows={data.topViews.map((v) => ({
                                            id: v.viewId,
                                            label: <ViewLink viewId={v.viewId} name={v.name} canOpen={v.canOpen} />,
                                            meta: v.viewType,
                                            value: v.opens,
                                            detail: `${exact(v.uniqueViewers)} ${v.uniqueViewers === 1 ? 'person' : 'people'}`,
                                        }))}
                                    />
                                </ChartFrame>
                                {/* An empty roster and a WITHHELD one render
                                    identically unless we say which, and "nobody
                                    has contributed here" is a false statement to
                                    make to someone who simply may not see who
                                    did. */}
                                {data.redaction?.applied && !data.redaction.showsPeople ? (
                                    <WithheldPanel
                                        title="Contributors are hidden"
                                        reason={data.redaction.member
                                            ? 'Who did what in this workspace is visible to administrators and auditors. The activity totals above count everyone.'
                                            : 'You are not a member of this workspace, so the people in it are not named here. The activity totals above count everyone.'}
                                    />
                                ) : (
                                <ChartFrame
                                    title="Top contributors"
                                    isEmpty={data.topContributors.length === 0}
                                    emptyLabel="Nobody has contributed here in this range."
                                >
                                    <Leaderboard
                                        unit="actions"
                                        rows={data.topContributors.map((c) => ({
                                            id: c.userId,
                                            label: c.name,
                                            meta: c.email ?? undefined,
                                            value: c.events,
                                        }))}
                                    />
                                </ChartFrame>
                                )}
                            </div>

                            <ChartFrame title="Graph scale" subtitle="Across this workspace's data sources">
                                <dl className="grid grid-cols-2 md:grid-cols-4 gap-3">
                                    <PanelStat label="Nodes" value={data.graph.nodes} />
                                    <PanelStat label="Edges" value={data.graph.edges} />
                                    <PanelStat label="Entity types" value={data.graph.entityTypes} />
                                    <PanelStat label="Data sources" value={data.totals.dataSources.total} />
                                </dl>
                            </ChartFrame>
                        </div>
                    )}
                </div>
            </aside>
        </>
    )
}

function PanelStat({ label, value }: { label: string; value: number }) {
    return (
        <div className="rounded-xl border border-glass-border bg-glass-base/30 p-3">
            <dt className="text-[10px] text-ink-muted">{label}</dt>
            <dd className="mt-0.5 text-lg font-bold text-ink">{exact(value)}</dd>
        </div>
    )
}

function PanelSkeleton() {
    return (
        <div className="space-y-4" aria-hidden>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {[0, 1, 2, 3].map((i) => (
                    <div key={i} className="h-28 rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] animate-pulse" />
                ))}
            </div>
            <div className="h-56 rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] animate-pulse" />
            <div className="h-48 rounded-2xl border border-glass-border bg-black/[0.03] dark:bg-white/[0.04] animate-pulse" />
        </div>
    )
}
