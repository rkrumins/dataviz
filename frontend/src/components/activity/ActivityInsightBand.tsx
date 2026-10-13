/**
 * The insight band: what the selection below it adds up to.
 *
 * Every figure here is computed under the same filters as the timeline, so
 * the band describes the list a reader is looking at, not the platform at
 * large. Each leaderboard row is a drill-in: it narrows the whole explorer to
 * that person, source or action rather than opening somewhere else.
 *
 * Numbers before pictures: the four KPIs answer "how much, and is that more
 * than usual"; the volume chart and the punchcard answer "what kind" and
 * "when"; the leaderboards answer "who" and "where"; the reasons answer "why".
 */
import { useMemo, useState } from 'react'
import { Activity, Hand, Info, MessageSquareQuote, Undo2, Users } from 'lucide-react'

import { KpiCard } from '@/components/analytics/KpiCard'
import { Leaderboard, type LeaderboardRow } from '@/components/analytics/Leaderboard'
import { comparisonLabel, rangeLabel, todayIso } from '@/components/analytics/RangePicker'
import { ChartFrame } from '@/components/analytics/charts/ChartFrame'
import { ChartTable } from '@/components/analytics/charts/ChartTable'
import { PunchcardGrid } from '@/components/analytics/charts/PunchcardGrid'
import { punchcardTable } from '@/components/analytics/charts/punchcard'
import { StackedAreaChart } from '@/components/analytics/charts/StackedAreaChart'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import { Skeleton } from '@/components/ui/Skeleton'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate } from '@/lib/formatMetric'
import { timeAgo } from '@/lib/timeAgo'
import { describeInstant } from '@/lib/smartTime'
import type { ActivityHandsOnPerson, ActivitySummary } from '@/services/activityService'
import { rangeKey, type AnalyticsRangeSelection } from '@/services/analyticsService'

import { ActivityAttention } from './ActivityAttention'
import { attentionItems } from './attention'
import { CATEGORY_META, cadencePhrase, spanToRange } from './activityMeta'
import type { ActivityParams } from './useActivityParams'

/** The server's delta is a ratio; a KPI card shows percent. */
const pct = (delta: number | null) => (delta === null ? null : delta * 100)

/** Who keeps operating a source: their faces, overlapping, most first. */
function Faces({ people }: { people: ActivityHandsOnPerson[] }) {
    if (people.length === 0) return null
    const names = people.map((p) => p.name || p.email || p.id)
    return (
        <span className="inline-flex shrink-0 -space-x-1" title={names.map((n, i) => `${n} (${people[i].count})`).join(', ')}>
            {people.map((p, i) => (
                <UserAvatar
                    key={p.id} userId={p.id} name={names[i]} avatarId={p.avatarId} hasImage={p.hasImage}
                    className={cn('h-4 w-4 text-[7px] font-bold ring-2 ring-canvas-elevated', p.deleted && 'grayscale')}
                />
            ))}
            <span className="sr-only">Run by {names.join(', ')}</span>
        </span>
    )
}

export function ActivityInsightBand({ summary, isLoading, isStale, error, params }: {
    summary?: ActivitySummary
    isLoading: boolean
    isStale: boolean
    error: Error | null
    params: ActivityParams
}) {
    const theme = useChartTheme()

    const totalsByBucket = useMemo(() => {
        if (!summary) return []
        return summary.window.buckets.map((_, i) =>
            summary.volume.reduce((sum, s) => sum + (s.values[i] ?? 0), 0))
    }, [summary])
    const attention = useMemo(
        () => (summary ? attentionItems(summary, { personFiltered: !!params.person }) : []),
        [summary, params.person],
    )
    // Each zoom from the chart remembers the range it replaced, so Back
    // retraces them. Offered only while the range is still the zoom's own: a
    // range picked some other way has moved on from it.
    const [zooms, setZooms] = useState<{ from: AnalyticsRangeSelection; to: AnalyticsRangeSelection }[]>([])
    const back = zooms.at(-1)
    const canGoBack = !!back && rangeKey(back.to) === rangeKey(params.range)

    if (error && !summary) {
        return (
            <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-xs text-red-700 dark:text-red-300">
                The summary could not be loaded: {error.message}
            </p>
        )
    }
    if (isLoading || !summary) {
        return (
            <div aria-busy className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
            </div>
        )
    }

    const { totals, window } = summary
    const vs = comparisonLabel(params.range)
    const weekly = window.granularity === 'week'
    const formatBucket = (b: string) => (weekly ? `Week of ${shortDate(b, true)}` : shortDate(b, true))
    const lastDay = params.range.kind === 'custom' ? params.range.to : todayIso()
    const spanOf = (first: number, last: number) => spanToRange(window.buckets, window.granularity, first, last, lastDay)
    const zoomTo = (first: number, last: number) => {
        if (first === 0 && last === window.buckets.length - 1) return   // already the whole range
        const next = spanOf(first, last)
        setZooms((z) => [...z, { from: params.range, to: next }])
        params.setRange(next)
    }
    const goBack = () => {
        if (!back) return
        setZooms((z) => z.slice(0, -1))
        params.setRange(back.from)
    }
    const series = summary.volume.map((v) => ({
        key: v.category,
        label: CATEGORY_META[v.category]?.label ?? v.category,
        values: v.values,
        slot: CATEGORY_META[v.category]?.slot ?? 0,
    }))

    const people: LeaderboardRow[] = summary.topPeople.map((p) => ({
        id: p.id,
        label: (
            <span className="flex min-w-0 items-center gap-2">
                {p.name || p.email ? (
                    <UserAvatar
                        userId={p.id} name={p.name || p.email || p.id} avatarId={p.avatarId} hasImage={p.hasImage}
                        className={cn('h-5 w-5 text-[8px] font-bold', p.deleted && 'grayscale opacity-70')}
                    />
                ) : null}
                <span className={cn('truncate', !(p.name || p.email) && 'font-mono text-[11px]')}>
                    {p.name || p.email || p.id}
                </span>
            </span>
        ),
        meta: p.deleted ? 'Deleted account' : (p.name && p.email ? p.email : undefined),
        value: p.count,
    }))
    const sources: LeaderboardRow[] = summary.handsOnSources.map((s) => ({
        id: s.dataSourceId,
        label: s.name || <span className="font-mono text-[11px]">{s.dataSourceId}</span>,
        meta: s.people?.length || s.workspaceName ? (
            <span className="flex min-w-0 items-center gap-1.5">
                <Faces people={s.people ?? []} />
                {s.workspaceName && <span className="truncate">{s.workspaceName}</span>}
            </span>
        ) : undefined,
        value: s.count,
        detail: [cadencePhrase(s.medianGapHours), `last ${timeAgo(s.lastAt)}`].filter(Boolean).join(' · '),
    }))
    const actions: LeaderboardRow[] = summary.topActions.map((a) => ({
        id: a.type,
        label: a.label,
        meta: CATEGORY_META[a.category]?.label,
        value: a.count,
    }))

    return (
        <section aria-label="Activity insights" className="space-y-4">
            <ActivityAttention items={attention} onShow={params.patch} />

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                <KpiCard
                    label="Events"
                    value={compact(totals.events.current)}
                    changePct={pct(totals.events.delta)}
                    comparisonLabel={vs}
                    icon={Activity}
                    trend={totalsByBucket}
                    accent="indigo"
                />
                <KpiCard
                    label="People active"
                    value={exact(totals.people.current)}
                    changePct={pct(totals.people.delta)}
                    comparisonLabel={vs}
                    icon={Users}
                    accent="cyan"
                />
                <KpiCard
                    label="Operations by hand"
                    value={exact(totals.operations.current)}
                    changePct={pct(totals.operations.delta)}
                    comparisonLabel={vs}
                    sub="Runs, refreshes and reconciliations people started"
                    icon={Hand}
                    accent="amber"
                    // More manual work is not good news: it is toil.
                    higherIsBetter={false}
                />
                <KpiCard
                    label="Changes with a reason"
                    value={totals.reasons.share === null ? '—' : percent(totals.reasons.share)}
                    sub={totals.reasons.of
                        ? `${exact(totals.reasons.given)} of ${exact(totals.reasons.of)} changes said why`
                        : 'No changes in this range'}
                    icon={MessageSquareQuote}
                    accent="emerald"
                />
            </div>
            {window.keptFrom && (
                <p className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                    <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    No change is shown: the log keeps activity from {describeInstant(new Date(window.keptFrom)).utcDate} on,
                    so the period before this one is incomplete.
                </p>
            )}

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="What happened, by kind"
                    subtitle={`${weekly ? 'Events per week' : 'Events per day'} · drag across it to zoom in`}
                    className="xl:col-span-2"
                    isStale={isStale}
                    action={canGoBack ? (
                        <button
                            type="button"
                            onClick={goBack}
                            className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border px-2.5 py-1 text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <Undo2 className="h-3 w-3" aria-hidden />
                            Back to {rangeLabel(back!.from).replace(/^Last/, 'the last')}
                        </button>
                    ) : undefined}
                    isEmpty={totalsByBucket.every((n) => n === 0)}
                    emptyLabel="Nothing recorded in this range."
                    series={series.map((s) => ({
                        key: s.key, label: s.label, color: theme.series[s.slot], shape: 'area' as const,
                    }))}
                    table={(
                        <ChartTable
                            rowLabel={weekly ? 'Week' : 'Day'}
                            rows={window.buckets.map(formatBucket)}
                            columns={series.map((s) => ({ key: s.key, label: s.label, values: s.values }))}
                            caption="Events per bucket, by category"
                        />
                    )}
                >
                    <StackedAreaChart
                        buckets={window.buckets} series={series} formatBucket={formatBucket} height={220}
                        onSelectSpan={zoomTo}
                        formatSpan={(first, last) => {
                            const { from, to } = spanOf(first, last)
                            return from === to ? shortDate(from, true) : `${shortDate(from)} – ${shortDate(to, true)}`
                        }}
                    />
                </ChartFrame>

                <ChartFrame
                    title="When it happens"
                    subtitle="Weekday × hour, UTC"
                    isStale={isStale}
                    table={(() => {
                        const t = punchcardTable(summary.punchcard)
                        return <ChartTable {...t} caption="Events per weekday and hour, UTC" />
                    })()}
                >
                    <PunchcardGrid grid={summary.punchcard} />
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <ChartFrame title="Most active people" subtitle="Who did the most — select one to see their activity" isStale={isStale}>
                    <Leaderboard
                        rows={people}
                        unit="events"
                        slot={2}
                        emptyLabel="No one acted in this range."
                        onRowClick={(row) => params.patch({ person: row.id, role: 'actor' })}
                    />
                </ChartFrame>
                <ChartFrame
                    title="Most hands-on sources"
                    subtitle={summary.cadenceCapped
                        ? 'Manual operations per source — from the most recent 10,000'
                        : 'Manual operations per source, and how often'}
                    isStale={isStale}
                >
                    <Leaderboard
                        rows={sources}
                        unit="operations"
                        slot={0}
                        emptyLabel="No one operated a source by hand in this range."
                        onRowClick={(row) => params.patch({ dataSource: row.id })}
                    />
                </ChartFrame>
                <ChartFrame title="Most frequent actions" subtitle="Select one to see every time it happened" isStale={isStale}>
                    <Leaderboard
                        rows={actions}
                        unit="times"
                        emptyLabel="Nothing happened in this range."
                        onRowClick={(row) => params.patch({ types: row.id })}
                    />
                </ChartFrame>
            </div>

            {summary.topReasons.length > 0 && (
                <ChartFrame title="Why, in their words" subtitle="The reasons given most often" isStale={isStale}>
                    <ul className="flex flex-wrap gap-2">
                        {summary.topReasons.map((r) => (
                            <li
                                key={r.reason}
                                className="inline-flex items-center gap-2 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.03] px-3 py-1.5"
                            >
                                <span className="text-xs text-ink">“{r.reason}”</span>
                                <span className="text-[10px] font-semibold tabular-nums text-ink-muted">×{exact(r.count)}</span>
                            </li>
                        ))}
                    </ul>
                </ChartFrame>
            )}
        </section>
    )
}
