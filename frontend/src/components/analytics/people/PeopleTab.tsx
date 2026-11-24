/**
 * PeopleTab — who did what, and when: everyone in a scope, a day at a time.
 *
 * One component for two places. In Analytics it reports on the platform or any
 * workspace the reader may report on; on a workspace page it is fixed to that
 * workspace for its admins. The server decides what each reader is told (the
 * `full` lens for analytics administrators, the `workspace` lens — no sign-ins,
 * no addresses — for a workspace admin), and this page draws only what came back:
 * a withheld figure arrives as `null` and is left out, never drawn as a zero.
 */
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
    Activity, ArrowDownUp, CalendarDays, Clock4, LogIn, MoonStar, Search, Sparkles, UserPlus, Users, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate, signedPercent } from '@/lib/formatMetric'
import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import type { PeopleDoc, PeopleSort, PersonRow } from '@/services/peopleActivityService'
import { usePeopleRoster } from '@/hooks/usePeopleActivity'
import { httpStatusOf } from '@/services/graphRequestFailure'
import { PersonChip } from '@/components/ui/PersonChip'
import { DateTime } from '@/components/ui/DateTime'
import { Backdrop } from '@/components/ui/Backdrop'
import { EmptyState } from '@/components/ui/EmptyState'
import { Sparkline } from '@/components/ui/Sparkline'
import { KpiCard } from '../KpiCard'
import { Leaderboard } from '../Leaderboard'
import { InsightStrip } from '../InsightStrip'
import { WithheldPanel } from '../Redacted'
import { AnalyticsSkeleton } from '../AnalyticsSkeleton'
import { ChartFrame } from '../charts/ChartFrame'
import { ChartTable } from '../charts/ChartTable'
import { StackedAreaChart } from '../charts/StackedAreaChart'
import { StackedShareBar } from '../charts/StackedShareBar'
import { TimeSeriesChart } from '../charts/TimeSeriesChart'
import { PulseMatrix } from '../charts/PulseMatrix'
import { PunchcardGrid } from '../charts/PunchcardGrid'
import { punchcardTable } from '../charts/punchcard'
import { useChartTheme } from '../charts/chartTheme'
import { comparisonLabel, rangePhrase } from '../RangePicker'
import { KIND_META, kindLabel, kindSlot, sectionLabel } from './activityKinds'
import { CoverageNotice } from './CoverageNotice'
import { personActivityHref, spanToRange } from './peopleLinks'

const PAGE = 25

export interface PeopleScopeOption {
    id: string | null
    name: string
}

export function PeopleTab({
    range, onRangeChange, workspaceId, scopes, onScopeChange, className,
}: {
    range: AnalyticsRangeSelection
    onRangeChange: (next: AnalyticsRangeSelection) => void
    /** The workspace reported on; `null` for the platform. */
    workspaceId: string | null
    /** What the reader may switch between. Omitted where the scope is fixed. */
    scopes?: PeopleScopeOption[]
    onScopeChange?: (workspaceId: string | null) => void
    className?: string
}) {
    const [q, setQ] = useState('')
    const [sort, setSort] = useState<PeopleSort>('actions')
    const [order, setOrder] = useState<'asc' | 'desc'>('desc')
    const [page, setPage] = useState(0)
    const [day, setDay] = useState<number | null>(null)

    const query = { workspaceId, q: q.trim() || undefined, sort, order, offset: page * PAGE, limit: PAGE }
    const roster = usePeopleRoster(range, query)
    const data = roster.data
    const status = httpStatusOf(roster.error)

    const setSortKey = (key: PeopleSort) => {
        if (key === sort) setOrder(order === 'desc' ? 'asc' : 'desc')
        else { setSort(key); setOrder(key === 'name' ? 'asc' : 'desc') }
        setPage(0)
    }

    return (
        <div className={cn('space-y-5', className)}>
            <ScopeBar
                scopes={scopes} workspaceId={workspaceId}
                onScopeChange={(ws) => { onScopeChange?.(ws); setPage(0); setDay(null) }}
                q={q} onQ={(v) => { setQ(v); setPage(0) }}
                generatedAt={data?.generatedAt}
            />

            {status === 403 ? (
                <WithheldPanel
                    title="People activity is not open to you here"
                    reason="Analytics administrators see everyone's activity. Workspace administrators see their own workspace's people — pick one of your workspaces above. Your own activity is always yours to see."
                    action={<Link to="/me/activity" className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">See your own activity →</Link>}
                />
            ) : roster.error && !data ? (
                <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
                    {(roster.error as Error).message}
                </p>
            ) : !data ? (
                <AnalyticsSkeleton />
            ) : (
                <PeopleBody
                    data={data} range={range} onRangeChange={onRangeChange}
                    isStale={roster.isFetching} workspaceId={workspaceId}
                    sort={sort} order={order} onSort={setSortKey}
                    page={page} onPage={setPage}
                    onOpenDay={setDay}
                />
            )}

            {data && (
                <ScopeDayPanel
                    data={data} index={day} range={range} workspaceId={workspaceId}
                    onClose={() => setDay(null)}
                />
            )}
        </div>
    )
}

function ScopeBar({ scopes, workspaceId, onScopeChange, q, onQ, generatedAt }: {
    scopes?: PeopleScopeOption[]
    workspaceId: string | null
    onScopeChange: (ws: string | null) => void
    q: string
    onQ: (v: string) => void
    generatedAt?: string
}) {
    return (
        <div className="flex flex-wrap items-center gap-3">
            {scopes && scopes.length > 0 && (
                <label className="inline-flex items-center gap-2 text-xs text-ink-muted">
                    <Users className="h-3.5 w-3.5" />
                    <span className="sr-only">Report on</span>
                    <select
                        value={workspaceId ?? ''}
                        onChange={(e) => onScopeChange(e.target.value || null)}
                        className="rounded-lg border border-glass-border bg-canvas-elevated px-2.5 py-1.5 text-xs font-semibold text-ink outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    >
                        {scopes.map((s) => <option key={s.id ?? 'all'} value={s.id ?? ''}>{s.name}</option>)}
                    </select>
                </label>
            )}
            <label className="relative flex-1 min-w-[12rem] max-w-sm">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-muted" />
                <span className="sr-only">Find a person</span>
                <input
                    type="search" value={q} onChange={(e) => onQ(e.target.value)}
                    placeholder="Find a person…"
                    className="w-full rounded-lg border border-glass-border bg-canvas-elevated py-1.5 pl-8 pr-3 text-xs text-ink placeholder:text-ink-muted outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                />
            </label>
            {generatedAt && (
                <span className="ml-auto text-[11px] text-ink-muted">
                    <DateTime at={generatedAt} prefix="As of " />
                </span>
            )}
        </div>
    )
}

function PeopleBody({
    data, range, onRangeChange, isStale, workspaceId, sort, order, onSort, page, onPage, onOpenDay,
}: {
    data: PeopleDoc
    range: AnalyticsRangeSelection
    onRangeChange: (next: AnalyticsRangeSelection) => void
    isStale: boolean
    workspaceId: string | null
    sort: PeopleSort
    order: 'asc' | 'desc'
    onSort: (key: PeopleSort) => void
    page: number
    onPage: (p: number) => void
    onOpenDay: (index: number) => void
}) {
    const theme = useChartTheme()
    const { totals, series, window: w, scope } = data
    const full = scope.lens === 'full'
    const vs = comparisonLabel(range)
    const buckets = series.buckets
    const actionsByBucket = useMemo(
        () => buckets.map((_, i) => series.byKind
            .filter((s) => s.kind !== 'signin')
            .reduce((sum, s) => sum + (s.values[i] ?? 0), 0)),
        [buckets, series.byKind],
    )
    const daily = w.granularity === 'day'
    const openBucket = (i: number) => {
        if (daily) onOpenDay(i)
        else onRangeChange(spanToRange(buckets, w.granularity, i, i, w.end))
    }
    const kindSeries = series.byKind.filter((s) => s.values.some((v) => v > 0))

    return (
        <div className={cn('space-y-5 transition-opacity', isStale && 'opacity-60')}>
            <CoverageNotice coverage={data.coverage} window={w} lens={scope.lens} scoped={!!workspaceId} />

            {data.insights.length > 0 && (
                <InsightStrip insights={data.insights} rangeLabel={rangePhrase(range)} />
            )}

            <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                <KpiCard
                    label="Active people" metric="peopleActive" value={totals.activePeople.current}
                    icon={Activity} changePct={totals.activePeople.changePct} comparisonLabel={vs}
                    trend={series.activePeople} accent="indigo"
                />
                {full && totals.signedIn ? (
                    <KpiCard
                        label="Signed in" metric="peopleSignedIn" value={totals.signedIn.current}
                        icon={LogIn} changePct={totals.signedIn.changePct} comparisonLabel={vs}
                        trend={series.signedIn ?? undefined} trendTone="slate" accent="cyan"
                    />
                ) : (
                    <KpiCard
                        label="Members" value={totals.members ?? '—'} icon={Users}
                        sub={totals.members != null ? `${exact(totals.members - totals.quiet)} active here` : undefined}
                        accent="cyan"
                    />
                )}
                <KpiCard
                    label="Actions" metric="peopleActions" value={totals.actions.current}
                    icon={Sparkles} changePct={totals.actions.changePct} comparisonLabel={vs}
                    trend={actionsByBucket} trendTone="emerald" accent="violet"
                />
                <KpiCard
                    label="Active days per person" metric="activeDays"
                    value={totals.avgActiveDays == null ? '—' : totals.avgActiveDays.toFixed(1)}
                    icon={CalendarDays}
                    sub={`of ${exact(w.days)} ${w.days === 1 ? 'day' : 'days'}`}
                    accent="emerald"
                />
                {full && totals.idleSignIns ? (
                    <KpiCard
                        label="Idle sign-ins" metric="idleSignIns"
                        value={totals.idleSignIns.rate == null ? '—' : percent(totals.idleSignIns.rate)}
                        icon={MoonStar} higherIsBetter={false}
                        sub={`${exact(totals.idleSignIns.days)} of ${exact(totals.idleSignIns.signInDays)} sign-in days`}
                        accent={totals.idleSignIns.rate != null && totals.idleSignIns.rate >= 0.25 ? 'amber' : 'emerald'}
                    />
                ) : (
                    <KpiCard
                        label="Quiet members" metric="quietMembers" value={totals.quiet}
                        icon={MoonStar} higherIsBetter={false}
                        sub={totals.newcomers ? `${exact(totals.newcomers)} new and active` : 'Members who did nothing here'}
                        accent={totals.quiet ? 'amber' : 'emerald'}
                    />
                )}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    id="chart-people-activity"
                    title="Activity over time"
                    subtitle={`Everything people did, by kind — drag across to zoom in`}
                    className="xl:col-span-2"
                    isStale={isStale}
                    isEmpty={kindSeries.length === 0}
                    emptyLabel="Nobody did anything in this range."
                    series={kindSeries.map((s) => ({
                        key: s.kind, label: kindLabel(s.kind), shape: 'area' as const,
                        color: kindSlot(s.kind) === undefined ? theme.neutralMark : theme.series[kindSlot(s.kind)!],
                    }))}
                    table={
                        <ChartTable
                            rowLabel="Period"
                            rows={buckets.map((b) => shortDate(b, true))}
                            columns={kindSeries.map((s) => ({ key: s.kind, label: kindLabel(s.kind), values: s.values }))}
                        />
                    }
                >
                    <StackedAreaChart
                        buckets={buckets}
                        series={kindSeries.map((s) => ({
                            key: s.kind, label: kindLabel(s.kind), values: s.values,
                            slot: kindSlot(s.kind) ?? 0, residual: kindSlot(s.kind) === undefined,
                        }))}
                        formatBucket={(b) => shortDate(b, true)}
                        axisLabels={buckets.map((b) => shortDate(b))}
                        onSelectSpan={(first, last) => onRangeChange(spanToRange(buckets, w.granularity, first, last, w.end))}
                        formatSpan={(first, last) => `${shortDate(buckets[first])} – ${shortDate(buckets[last])}`}
                    />
                </ChartFrame>

                <ChartFrame
                    title="What people do"
                    subtitle={`Share of everything recorded in ${rangePhrase(range)}`}
                    isStale={isStale}
                    isEmpty={data.kinds.every((k) => k.count === 0)}
                    emptyLabel="Nothing recorded in this range."
                    table={
                        <ChartTable
                            rowLabel="Activity"
                            rows={data.types.map((t) => t.label)}
                            columns={[{ key: 'n', label: 'Events', values: data.types.map((t) => t.count) }]}
                        />
                    }
                >
                    <div className="space-y-4">
                        <StackedShareBar
                            slices={data.kinds.filter((k) => k.count > 0).map((k) => ({ key: k.kind, count: k.count }))}
                            labelOf={kindLabel} slotOf={kindSlot}
                        />
                        <Leaderboard
                            unit="events" unitOne="event"
                            rows={data.types.slice(0, 8).map((t) => ({
                                id: t.type, label: t.label, meta: kindLabel(t.kind), value: t.count,
                            }))}
                        />
                    </div>
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    title="Active and signed-in people"
                    subtitle={full ? 'Distinct people per period: who did something, and who signed in' : 'Distinct people who did something here, per period'}
                    isStale={isStale}
                    isEmpty={series.activePeople.every((v) => v === 0) && !(series.signedIn ?? []).some((v) => v > 0)}
                    emptyLabel="Nobody was around in this range."
                    series={[
                        { key: 'active', label: 'Active', color: theme.series[1], shape: 'line' },
                        ...(series.signedIn ? [{ key: 'signed', label: 'Signed in', color: theme.series[0], shape: 'line' as const }] : []),
                    ]}
                    table={
                        <ChartTable
                            rowLabel="Period"
                            rows={buckets.map((b) => shortDate(b, true))}
                            columns={[
                                { key: 'active', label: 'Active', values: series.activePeople },
                                ...(series.signedIn ? [{ key: 'signed', label: 'Signed in', values: series.signedIn }] : []),
                            ]}
                        />
                    }
                >
                    <TimeSeriesChart
                        buckets={buckets}
                        series={[
                            { key: 'active', label: 'Active', values: series.activePeople, slot: 1, area: true },
                            ...(series.signedIn ? [{ key: 'signed', label: 'Signed in', values: series.signedIn, slot: 0 }] : []),
                        ]}
                    />
                </ChartFrame>

                <ChartFrame
                    title="When people work"
                    subtitle={`Actions in ${rangePhrase(range)}, weekday × hour, UTC`}
                    isStale={isStale}
                    isEmpty={data.punchcard.every((r) => r.every((n) => n === 0))}
                    emptyLabel="Nothing recorded in this range."
                    table={<ChartTable {...punchcardTable(data.punchcard)} caption="Actions per weekday and hour, UTC" />}
                >
                    <PunchcardGrid grid={data.punchcard} unit="actions" />
                </ChartFrame>
            </div>

            <ChartFrame
                id="chart-people-matrix"
                title="Who's active, day by day"
                subtitle={daily
                    ? 'Each person’s actions per day, on one scale — pick a day to see who was around'
                    : 'Each person’s actions per week — pick a week to zoom into its days'}
                isStale={isStale}
                isEmpty={data.people.length === 0}
                emptyLabel={data.page.total === 0 ? 'Nobody did anything in this range.' : 'Nobody on this page.'}
                action={<SortToggle sort={sort} order={order} onSort={onSort} />}
                table={
                    <ChartTable
                        rowLabel="Person"
                        rows={data.people.map((p) => p.name)}
                        columns={buckets.map((b, i) => ({
                            key: b, label: shortDate(b), values: data.people.map((p) => p.values[i] ?? 0),
                        }))}
                    />
                }
            >
                <PulseMatrix
                    buckets={buckets}
                    rowHeader="Person"
                    unit="actions"
                    onSelectBucket={openBucket}
                    rows={data.people.map((p) => ({
                        id: p.userId,
                        title: p.name,
                        total: p.actions,
                        values: p.values,
                        label: (
                            <Link to={personActivityHref(p.userId, { workspaceId, range })}
                                className="hover:text-indigo-600 dark:hover:text-indigo-400 hover:underline">
                                {p.name}
                            </Link>
                        ),
                    }))}
                />
            </ChartFrame>

            <RosterTable
                data={data} range={range} workspaceId={workspaceId}
                sort={sort} order={order} onSort={onSort} page={page} onPage={onPage}
            />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame
                    title="Where in the app"
                    subtitle="Which parts of the product people moved to"
                    isStale={isStale}
                    isEmpty={data.sections.length === 0}
                    emptyLabel={data.coverage.sectionsSince
                        ? 'Nobody moved between sections in this range.'
                        : 'Section visits are recorded from this release on; none yet.'}
                    table={
                        <ChartTable
                            rowLabel="Section"
                            rows={data.sections.map((s) => sectionLabel(s.section))}
                            columns={[
                                { key: 'visits', label: 'Visits', values: data.sections.map((s) => s.count) },
                                { key: 'people', label: 'People', values: data.sections.map((s) => s.people) },
                            ]}
                        />
                    }
                >
                    <Leaderboard
                        unit="visits" unitOne="visit" slot={1}
                        rows={data.sections.map((s) => ({
                            id: s.section, label: sectionLabel(s.section), value: s.count,
                            detail: `${exact(s.people)} ${s.people === 1 ? 'person' : 'people'}`,
                        }))}
                    />
                </ChartFrame>

                <QuietMembers data={data} range={range} workspaceId={workspaceId} />
            </div>
        </div>
    )
}

function SortToggle({ sort, order, onSort }: {
    sort: PeopleSort; order: 'asc' | 'desc'; onSort: (k: PeopleSort) => void
}) {
    const options: { key: PeopleSort; label: string }[] = [
        { key: 'actions', label: 'Most active' },
        { key: 'activeDays', label: 'Most days' },
        { key: 'lastActiveAt', label: 'Most recent' },
        { key: 'change', label: 'Biggest change' },
    ]
    return (
        <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-muted">
            <ArrowDownUp className="h-3 w-3" />
            <span className="sr-only">Sort people by</span>
            <select
                value={sort}
                onChange={(e) => onSort(e.target.value as PeopleSort)}
                className="rounded-md border border-glass-border bg-transparent px-1.5 py-0.5 text-[11px] font-semibold text-ink-secondary outline-none"
            >
                {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
            </select>
            <span className="sr-only">{order === 'desc' ? 'descending' : 'ascending'}</span>
        </label>
    )
}

function SortHeader({ label, k, sort, order, onSort, className }: {
    label: string; k: PeopleSort; sort: PeopleSort; order: 'asc' | 'desc'
    onSort: (k: PeopleSort) => void; className?: string
}) {
    const active = sort === k
    return (
        <th scope="col" aria-sort={active ? (order === 'desc' ? 'descending' : 'ascending') : 'none'}
            className={cn('px-3 py-2 font-semibold', className)}>
            <button type="button" onClick={() => onSort(k)}
                className={cn('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}>
                {label}
                {active && <span aria-hidden>{order === 'desc' ? '↓' : '↑'}</span>}
            </button>
        </th>
    )
}

function RosterTable({ data, range, workspaceId, sort, order, onSort, page, onPage }: {
    data: PeopleDoc
    range: AnalyticsRangeSelection
    workspaceId: string | null
    sort: PeopleSort
    order: 'asc' | 'desc'
    onSort: (k: PeopleSort) => void
    page: number
    onPage: (p: number) => void
}) {
    const full = data.scope.lens === 'full'
    const maxDays = Math.max(1, data.window.days)
    const pages = Math.max(1, Math.ceil(data.page.total / PAGE))
    const head = { sort, order, onSort }

    return (
        <section aria-labelledby="people-roster" className="rounded-2xl border border-glass-border bg-canvas-elevated shadow-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-5 pt-4 pb-3">
                <div>
                    <h2 id="people-roster" className="text-sm font-bold text-ink">Everyone, in detail</h2>
                    <p className="text-[11px] text-ink-muted">
                        {exact(data.page.total)} {data.page.total === 1 ? 'person' : 'people'} active in {rangePhrase(range)}
                        {workspaceId ? ' in this workspace' : ''} · open a name for their whole story
                    </p>
                </div>
            </div>
            <div className="overflow-x-auto">
                <table className="w-full text-xs">
                    <thead className="border-y border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-left text-[11px] text-ink-muted">
                        <tr>
                            <SortHeader label="Person" k="name" {...head} />
                            <th scope="col" className="px-3 py-2 font-semibold">Joined</th>
                            {full && <SortHeader label="Last signed in" k="signIns" {...head} />}
                            <SortHeader label="Last active" k="lastActiveAt" {...head} />
                            <SortHeader label="Active days" k="activeDays" {...head} />
                            <SortHeader label="Actions" k="actions" {...head} className="text-right" />
                            <th scope="col" className="px-3 py-2 font-semibold">Mostly</th>
                            <th scope="col" className="px-3 py-2 font-semibold">Trend</th>
                            <SortHeader label="Change" k="change" {...head} className="text-right" />
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-glass-border">
                        {data.people.map((p) => (
                            <RosterRow key={p.userId} p={p} full={full} maxDays={maxDays} range={range} workspaceId={workspaceId} />
                        ))}
                    </tbody>
                </table>
            </div>
            {pages > 1 && (
                <div className="flex items-center justify-between px-5 py-3 text-[11px] text-ink-muted">
                    <span>Page {page + 1} of {pages}</span>
                    <div className="flex gap-1.5">
                        <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)}
                            className="rounded-md border border-glass-border px-2 py-1 font-semibold text-ink-secondary disabled:opacity-40">Previous</button>
                        <button type="button" disabled={page + 1 >= pages} onClick={() => onPage(page + 1)}
                            className="rounded-md border border-glass-border px-2 py-1 font-semibold text-ink-secondary disabled:opacity-40">Next</button>
                    </div>
                </div>
            )}
        </section>
    )
}

function RosterRow({ p, full, maxDays, range, workspaceId }: {
    p: PersonRow; full: boolean; maxDays: number; range: AnalyticsRangeSelection; workspaceId: string | null
}) {
    const theme = useChartTheme()
    const top = p.topKind ? KIND_META[p.topKind] : null
    const delta = signedPercent(p.changePct)
    return (
        <tr className="hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">
            <td className="px-3 py-2">
                <Link to={personActivityHref(p.userId, { workspaceId, range })} className="block min-w-[10rem]">
                    <PersonChip id={p.userId} size="sm" link={false}
                        person={{ name: p.name, email: p.email, deleted: p.deleted }}
                        caption={p.joinedInWindow ? 'New this period' : (p.email ?? undefined)} />
                </Link>
            </td>
            <td className="px-3 py-2 text-ink-secondary whitespace-nowrap"><DateTime at={p.joinedAt} variant="calendar" /></td>
            {full && (
                <td className="px-3 py-2 text-ink-secondary whitespace-nowrap">
                    <DateTime at={p.lastSignInAt} />
                    {p.idleSignInDays ? <span className="ml-1 text-[10px] text-amber-600 dark:text-amber-400">· {p.idleSignInDays} idle</span> : null}
                </td>
            )}
            <td className="px-3 py-2 text-ink-secondary whitespace-nowrap"><DateTime at={p.lastActiveAt ?? p.lastActiveEverAt} /></td>
            <td className="px-3 py-2">
                <div className="flex items-center gap-2 min-w-[7rem]">
                    <div className="h-1.5 flex-1 rounded-full bg-black/[0.05] dark:bg-white/[0.06]">
                        <div className="h-1.5 rounded-full" style={{ width: `${Math.min(100, (p.activeDays / maxDays) * 100)}%`, backgroundColor: theme.series[1] }} />
                    </div>
                    <span className="tabular-nums text-ink-secondary">{p.activeDays}</span>
                </div>
            </td>
            <td className="px-3 py-2 text-right font-semibold tabular-nums text-ink">{compact(p.actions)}</td>
            <td className="px-3 py-2">
                {top ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-glass-border px-2 py-0.5 text-[10px] font-semibold text-ink-secondary">
                        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: top.slot === undefined ? theme.neutralMark : theme.series[top.slot] }} />
                        {top.label}
                    </span>
                ) : <span className="text-ink-muted">Signed in only</span>}
            </td>
            <td className="px-3 py-2 w-24"><Sparkline points={p.values} label={`${p.name}, actions per period`} /></td>
            <td className={cn('px-3 py-2 text-right tabular-nums font-semibold',
                p.changePct == null ? 'text-ink-muted' : p.changePct >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                {delta ?? '—'}
            </td>
        </tr>
    )
}

function QuietMembers({ data, range, workspaceId }: {
    data: PeopleDoc; range: AnalyticsRangeSelection; workspaceId: string | null
}) {
    const { quiet } = data
    return (
        <ChartFrame
            title={workspaceId ? 'Quiet members' : 'Quiet accounts'}
            subtitle={workspaceId
                ? `Members who did nothing here in ${rangePhrase(range)} — last active here, and when they joined`
                : `Live accounts that did nothing in ${rangePhrase(range)}, most recently seen first`}
            isEmpty={quiet.count === 0}
            emptyLabel="Everyone with access did something. Nobody has gone quiet."
        >
            <div className="space-y-2">
                <p className="text-[11px] text-ink-muted">
                    <span className="font-semibold text-ink-secondary tabular-nums">{exact(quiet.count)}</span>{' '}
                    {quiet.count === 1 ? 'person' : 'people'}
                    {quiet.people.length < quiet.count && ` · showing the ${exact(quiet.people.length)} most recently seen`}
                </p>
                <ul className="divide-y divide-glass-border max-h-80 overflow-y-auto pr-1">
                    {quiet.people.map((q) => (
                        <li key={q.userId} className="flex items-center justify-between gap-3 py-2">
                            <Link to={personActivityHref(q.userId, { workspaceId, range })} className="min-w-0">
                                <PersonChip id={q.userId} size="sm" link={false}
                                    person={{ name: q.name, email: q.email }} caption={q.email ?? undefined} />
                            </Link>
                            <div className="shrink-0 text-right text-[11px] text-ink-muted">
                                <div>{q.lastActiveAt ? <DateTime at={q.lastActiveAt} prefix="Last active " /> : 'Never active here'}</div>
                                {q.joinedAt && <div className="text-[10px]"><DateTime at={q.joinedAt} prefix={<UserPlus className="inline h-3 w-3 mr-0.5" />} variant="calendar" /></div>}
                            </div>
                        </li>
                    ))}
                </ul>
            </div>
        </ChartFrame>
    )
}

/**
 * One day, for everyone in the scope: who was around, how much each did, and what
 * the day was made of. Opened from a column of the day-by-day matrix.
 */
function ScopeDayPanel({ data, index, range, workspaceId, onClose }: {
    data: PeopleDoc
    index: number | null
    range: AnalyticsRangeSelection
    workspaceId: string | null
    onClose: () => void
}) {
    const theme = useChartTheme()
    const open = index !== null && index >= 0 && index < data.series.buckets.length
    const day = open ? data.series.buckets[index!] : null
    // The 100 most active people of the window — cached server-side with the
    // roster, so this costs nothing — filtered to who was around that day.
    const wide = usePeopleRoster(range, { workspaceId, sort: 'actions', order: 'desc', offset: 0, limit: 100 }, open)
    const people = (wide.data?.people ?? [])
        .map((p) => ({ p, n: p.values[index ?? 0] ?? 0 }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n)
    const kinds = open
        ? data.series.byKind.map((s) => ({ key: s.kind, count: s.values[index!] ?? 0 })).filter((s) => s.count > 0)
        : []

    return (
        <>
            <Backdrop open={open} onClick={onClose} zClassName="z-40" />
            <aside
                role="dialog" aria-modal="true" aria-label={day ? `Activity on ${shortDate(day, true)}` : 'Day'}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
                className={cn(
                    'fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l border-glass-border bg-canvas-elevated shadow-2xl transition-transform duration-300',
                    open ? 'translate-x-0' : 'translate-x-full pointer-events-none',
                )}
            >
                <header className="flex items-start justify-between gap-4 border-b border-glass-border px-6 py-4">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">One day</p>
                        <h2 className="text-lg font-bold text-ink">{day ? shortDate(day, true) : ''}</h2>
                        <p className="text-xs text-ink-muted">
                            {exact(data.series.activePeople[index ?? 0] ?? 0)} active
                            {data.series.signedIn && <> · {exact(data.series.signedIn[index ?? 0] ?? 0)} signed in</>}
                        </p>
                    </div>
                    <button type="button" onClick={onClose} aria-label="Close day"
                        className="rounded-lg p-2 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5">
                        <X className="h-4 w-4" />
                    </button>
                </header>
                <div className="flex-1 space-y-5 overflow-y-auto px-6 py-5">
                    {kinds.length > 0 && (
                        <div>
                            <h3 className="mb-2 text-xs font-bold text-ink">What the day was made of</h3>
                            <StackedShareBar slices={kinds} labelOf={kindLabel} slotOf={kindSlot} />
                        </div>
                    )}
                    <div>
                        <h3 className="mb-2 text-xs font-bold text-ink">Who was around</h3>
                        {wide.isLoading ? (
                            <p className="text-xs text-ink-muted">Loading…</p>
                        ) : people.length === 0 ? (
                            <EmptyState compact icon={Clock4} title="Nobody did anything this day" description="Sign-ins alone are not counted as activity." />
                        ) : (
                            <ul className="space-y-1.5">
                                {people.map(({ p, n }) => {
                                    const top = p.topKind ? KIND_META[p.topKind] : null
                                    return (
                                        <li key={p.userId}>
                                            <Link
                                                to={personActivityHref(p.userId, { workspaceId, range, day: day ?? undefined })}
                                                className="flex items-center justify-between gap-3 rounded-xl border border-glass-border px-3 py-2 hover:border-indigo-500/40 hover:bg-indigo-500/[0.04]"
                                            >
                                                <PersonChip id={p.userId} size="sm" link={false}
                                                    person={{ name: p.name, email: p.email, deleted: p.deleted }}
                                                    caption={top ? `Mostly ${top.gerund}` : undefined} />
                                                <span className="flex items-center gap-2 text-xs">
                                                    <span className="font-semibold tabular-nums text-ink">{exact(n)}</span>
                                                    <span className="text-ink-muted">{n === 1 ? 'action' : 'actions'}</span>
                                                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: theme.series[1] }} />
                                                </span>
                                            </Link>
                                        </li>
                                    )
                                })}
                            </ul>
                        )}
                        {(wide.data?.page.total ?? 0) > 100 && (
                            <p className="mt-2 text-[11px] text-ink-muted">Showing who was around among the 100 most active people this period.</p>
                        )}
                    </div>
                </div>
            </aside>
        </>
    )
}
