/**
 * PersonActivityPage — one person's story: when they joined, what they do, when,
 * and everything they did, day by day.
 *
 * At `/analytics/people/:userId` for analytics administrators (anyone) and
 * workspace admins (their workspace's people, `?workspace=` required), and at
 * `/me/activity` for everyone, about themselves. The route is not behind the
 * Analytics guard on purpose: who may see whom is the server's decision, and a
 * refusal renders as a sentence here rather than as a missing page.
 *
 * Everything is in the URL — range, workspace, the open day, the tab — so "what
 * Dana did on the 3rd" is a link.
 */
import { useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import {
    Activity, ArrowLeft, CalendarDays, ChevronLeft, ChevronRight, Clock4, Flame, KeyRound, LogIn,
    MousePointerClick, Route, Search, ShieldAlert, Sparkles, UserX, X,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { compact, exact, percent, shortDate } from '@/lib/formatMetric'
import { useDocumentTitle } from '@/lib/useDocumentTitle'
import { useAuthStore } from '@/store/auth'
import { httpStatusOf } from '@/services/graphRequestFailure'
import type { AnalyticsRangeSelection } from '@/services/analyticsService'
import type {
    ActivityEventRow, FeedKind, PersonDoc,
} from '@/services/peopleActivityService'
import {
    usePersonActivity, usePersonCalendar, usePersonDay, usePersonFeed,
} from '@/hooks/usePeopleActivity'
import { PageContainer } from '@/components/layout/PageContainer'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { DateTime } from '@/components/ui/DateTime'
import { Badge } from '@/components/ui/Badge'
import { Backdrop } from '@/components/ui/Backdrop'
import { EmptyState } from '@/components/ui/EmptyState'
import { Skeleton } from '@/components/ui/Skeleton'
import { KpiCard } from '@/components/analytics/KpiCard'
import { Leaderboard } from '@/components/analytics/Leaderboard'
import { MetricInfo } from '@/components/analytics/MetricInfo'
import { ViewLink, WorkspaceLink } from '@/components/analytics/EntityLink'
import {
    DEFAULT_RANGE_DAYS, RANGE_PRESETS, RangePicker, comparisonLabel, customRangeError, previousLabel,
    rangePhrase,
} from '@/components/analytics/RangePicker'
import { ChartFrame } from '@/components/analytics/charts/ChartFrame'
import { ChartTable } from '@/components/analytics/charts/ChartTable'
import { StackedAreaChart } from '@/components/analytics/charts/StackedAreaChart'
import { TimeSeriesChart } from '@/components/analytics/charts/TimeSeriesChart'
import { StackedShareBar } from '@/components/analytics/charts/StackedShareBar'
import { PunchcardGrid } from '@/components/analytics/charts/PunchcardGrid'
import { punchcardTable } from '@/components/analytics/charts/punchcard'
import { ActivityCalendar } from '@/components/analytics/charts/ActivityCalendar'
import { calendarByMonth, describeDay } from '@/components/analytics/charts/calendar'
import { DayRibbon } from '@/components/analytics/charts/DayRibbon'
import { useChartTheme } from '@/components/analytics/charts/chartTheme'
import {
    KIND_META, kindLabel, kindSlot, kindsFor, minuteLabel, sectionLabel, utcClock,
} from '@/components/analytics/people/activityKinds'
import { CoverageNotice } from '@/components/analytics/people/CoverageNotice'
import { addDays, spanToRange } from '@/components/analytics/people/peopleLinks'

type Tab = 'overview' | 'activity'

function useRange(params: URLSearchParams): AnalyticsRangeSelection {
    const raw = Number(params.get('range'))
    const from = params.get('from')
    const to = params.get('to')
    if (from && to && !customRangeError(from, to)) return { kind: 'custom', from, to }
    return { kind: 'preset', days: RANGE_PRESETS.some((p) => p.days === raw) ? raw : DEFAULT_RANGE_DAYS }
}

export function PersonActivityPage() {
    const { userId } = useParams()
    const meId = useAuthStore((s) => s.user?.id ?? null)
    const [params, setParams] = useSearchParams()
    const id = userId && userId !== meId ? userId : 'me'
    const range = useRange(params)
    const workspaceId = params.get('workspace')
    const day = params.get('day')
    const tab: Tab = params.get('tab') === 'activity' ? 'activity' : 'overview'

    const patch = (next: Record<string, string | null>) => {
        const out = new URLSearchParams(params)
        for (const [k, v] of Object.entries(next)) {
            if (v === null) out.delete(k)
            else out.set(k, v)
        }
        setParams(out, { replace: true })
    }
    const setRange = (next: AnalyticsRangeSelection) => patch(next.kind === 'custom'
        ? { from: next.from, to: next.to, range: null }
        : { range: String(next.days), from: null, to: null })

    const person = usePersonActivity(id, range, workspaceId)
    const calendar = usePersonCalendar(id, workspaceId)
    const data = person.data
    const status = httpStatusOf(person.error)
    useDocumentTitle(data ? `${data.profile.name} · Activity` : 'Activity')

    const backHref = `/analytics?tab=people${workspaceId ? `&pws=${encodeURIComponent(workspaceId)}` : ''}`

    return (
        <div className="absolute inset-0 overflow-x-hidden overflow-y-auto animate-in fade-in duration-500">
            <PageContainer gutter="shell" className="pt-6 pb-20 space-y-5">
                {id !== 'me' && (
                    <Link to={backHref} className="inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted hover:text-ink">
                        <ArrowLeft className="h-3.5 w-3.5" /> People
                    </Link>
                )}

                {status === 403 || status === 404 ? (
                    <EmptyState
                        icon={UserX}
                        title={status === 403 ? 'This activity is not yours to see' : 'Nobody by that id here'}
                        description={status === 403
                            ? 'Analytics administrators can see anyone’s activity, and workspace administrators the people of their own workspace. Your own is always open to you.'
                            : workspaceId
                                ? 'They are not a member of this workspace and have done nothing in it.'
                                : 'There is no account with this id.'}
                    />
                ) : person.error && !data ? (
                    <p className="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-900 dark:text-rose-100">
                        {(person.error as Error).message}
                    </p>
                ) : !data ? (
                    <PageSkeleton />
                ) : (
                    <>
                        <Hero data={data} range={range} onRange={setRange} isFetching={person.isFetching}
                            onClearWorkspace={workspaceId && (data.viewer.privileged || data.viewer.isSelf)
                                ? () => patch({ workspace: null }) : undefined} />

                        <div role="tablist" aria-label="Person activity sections" className="flex items-center gap-1 border-b border-glass-border">
                            {([['overview', 'Overview', Sparkles], ['activity', 'All activity', Activity]] as const).map(([key, label, Icon]) => (
                                <button key={key} type="button" role="tab" aria-selected={tab === key}
                                    onClick={() => patch({ tab: key === 'overview' ? null : key })}
                                    className={cn(
                                        'flex items-center gap-2 border-b-2 px-5 py-2.5 text-sm font-semibold outline-none transition-all focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                        tab === key ? 'border-indigo-500 text-indigo-600 dark:text-indigo-400'
                                            : 'border-transparent text-ink-muted hover:text-ink',
                                    )}>
                                    <Icon className="h-4 w-4" />{label}
                                </button>
                            ))}
                        </div>

                        <div className={cn('space-y-5 transition-opacity', person.isFetching && 'opacity-60')}>
                            <CoverageNotice coverage={data.coverage} window={data.window} lens={data.scope.lens} />
                            {tab === 'overview' ? (
                                <Overview
                                    data={data} range={range} onRange={setRange}
                                    calendar={calendar.data} selectedDay={day}
                                    onSelectDay={(d) => patch({ day: d })}
                                />
                            ) : (
                                <Feed id={id} workspaceId={workspaceId} lens={data.scope.lens}
                                    onOpenDay={(d) => patch({ day: d })} />
                            )}
                        </div>

                        <PersonDayPanel id={id} day={day} workspaceId={workspaceId} today={data.generatedAt.slice(0, 10)}
                            onDay={(d) => patch({ day: d })} onClose={() => patch({ day: null })} />
                    </>
                )}
            </PageContainer>
        </div>
    )
}

function PageSkeleton() {
    return (
        <div className="space-y-5" aria-busy>
            <Skeleton className="h-40 w-full rounded-3xl" />
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
            </div>
            <Skeleton className="h-48 w-full rounded-2xl" />
        </div>
    )
}

function Fact({ label, children, icon: Icon }: {
    label: string; children: React.ReactNode; icon: typeof Clock4
}) {
    return (
        <div className="min-w-[8.5rem] rounded-xl border border-white/40 dark:border-white/[0.08] bg-white/70 dark:bg-white/[0.05] px-3 py-2">
            <p className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
                <Icon className="h-3 w-3" />{label}
            </p>
            <p className="mt-0.5 text-xs font-semibold text-ink">{children}</p>
        </div>
    )
}

function Hero({ data, range, onRange, isFetching, onClearWorkspace }: {
    data: PersonDoc
    range: AnalyticsRangeSelection
    onRange: (r: AnalyticsRangeSelection) => void
    isFetching: boolean
    onClearWorkspace?: () => void
}) {
    const p = data.profile
    const ws = data.scope.workspaceId ? data.workspaces.find((w) => w.workspaceId === data.scope.workspaceId) : null
    const full = data.scope.lens === 'full'
    return (
        <section className="relative overflow-hidden rounded-3xl border border-glass-border bg-canvas-elevated shadow-sm">
            <div aria-hidden className="absolute inset-0 bg-gradient-to-br from-indigo-500/[0.12] via-violet-500/[0.08] to-cyan-500/[0.10]" />
            <div aria-hidden className="absolute -right-20 -top-24 h-64 w-64 rounded-full bg-indigo-500/[0.12] blur-3xl" />
            <div className="relative flex flex-wrap items-start justify-between gap-5 p-6">
                <div className="flex min-w-0 items-center gap-4">
                    <UserAvatar userId={p.userId} name={p.name} className="h-16 w-16 shrink-0 rounded-2xl text-xl shadow-lg ring-4 ring-white/60 dark:ring-white/10" />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <h1 className="truncate text-2xl font-bold text-ink">{p.name}</h1>
                            {data.viewer.isSelf && <Badge tone="accent">You</Badge>}
                            {p.deleted ? <Badge tone="danger">Deleted</Badge>
                                : p.status && p.status !== 'active' ? <Badge tone="warning">{p.status}</Badge> : null}
                        </div>
                        {p.email && <p className="truncate text-xs text-ink-secondary">{p.email}</p>}
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px] text-ink-muted">
                            {ws ? (
                                <span className="inline-flex items-center gap-1 rounded-full border border-glass-border bg-white/50 dark:bg-white/[0.04] px-2 py-0.5 font-semibold text-ink-secondary">
                                    In {ws.name ?? 'this workspace'}
                                    {onClearWorkspace && (
                                        <button type="button" onClick={onClearWorkspace} aria-label="Show activity everywhere" className="ml-0.5 hover:text-ink">
                                            <X className="h-3 w-3" />
                                        </button>
                                    )}
                                </span>
                            ) : <span>Everywhere on the platform</span>}
                            {data.standing && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-indigo-500/10 px-2 py-0.5 font-semibold text-indigo-600 dark:text-indigo-300">
                                    <Flame className="h-3 w-3" />
                                    More active than {data.standing.percentile}% of people · #{data.standing.rank} of {data.standing.of}
                                    <MetricInfo metric="peopleStanding" />
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <RangePicker range={range} onChange={onRange} isFetching={isFetching} />
            </div>
            <div className="relative flex flex-wrap gap-2 px-6 pb-6">
                <Fact label={ws ? 'Joined workspace' : 'Account created'} icon={CalendarDays}>
                    <DateTime at={ws ? ws.joinedAt : p.createdAt} variant="calendar" empty="Not recorded" />
                </Fact>
                <Fact label="First active" icon={Sparkles}>
                    <DateTime at={p.firstActiveAt} variant="calendar" empty="Not indexed yet" />
                </Fact>
                <Fact label={ws ? 'Last active here' : 'Last active'} icon={Activity}>
                    <DateTime at={ws ? ws.lastActiveAt ?? data.totals.lastActiveAt : p.lastActiveAt ?? data.totals.lastActiveAt} empty="Never" />
                </Fact>
                {full && (
                    <Fact label="Last signed in" icon={LogIn}>
                        <DateTime at={p.lastLoginAt} empty="Never" />
                    </Fact>
                )}
                {full && p.lastSeenAt && (
                    <Fact label="Last seen" icon={Clock4}>
                        <DateTime at={p.lastSeenAt} />
                    </Fact>
                )}
            </div>
        </section>
    )
}

function Overview({ data, range, onRange, calendar, selectedDay, onSelectDay }: {
    data: PersonDoc
    range: AnalyticsRangeSelection
    onRange: (r: AnalyticsRangeSelection) => void
    calendar?: { days: string[]; actions: number[]; signIns: number[] | null }
    selectedDay: string | null
    onSelectDay: (d: string) => void
}) {
    const theme = useChartTheme()
    const t = data.totals
    const vs = comparisonLabel(range)
    const full = data.scope.lens === 'full'
    const kinds = data.series.byKind.filter((s) => s.values.some((v) => v > 0))
    const actionsByBucket = data.series.buckets.map((_, i) =>
        data.series.byKind.filter((s) => s.kind !== 'signin').reduce((n, s) => n + (s.values[i] ?? 0), 0))
    const months = calendar ? calendarByMonth(calendar.days, calendar.actions) : null

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-2 lg:grid-cols-6 gap-3">
                <KpiCard label="Active days" metric="activeDays" value={t.activeDays.current} icon={CalendarDays}
                    changePct={t.activeDays.changePct} comparisonLabel={vs}
                    sub={t.currentStreak > 1 ? `On a ${t.currentStreak}-day streak` : `Longest streak ${t.longestStreak} ${t.longestStreak === 1 ? 'day' : 'days'}`}
                    accent="emerald" />
                <KpiCard label="Actions" metric="peopleActions" value={t.actions.current} icon={Sparkles}
                    changePct={t.actions.changePct} comparisonLabel={vs} trend={actionsByBucket} accent="violet" />
                {full && t.signIns ? (
                    <KpiCard label="Sign-ins" value={t.signIns.current} icon={LogIn}
                        changePct={t.signIns.changePct} comparisonLabel={vs}
                        sub={t.idleSignInDays ? `${t.idleSignInDays} ${t.idleSignInDays === 1 ? 'day' : 'days'} with nothing else` : 'Every sign-in led somewhere'}
                        trend={data.series.signedIn ?? undefined} trendTone="slate" accent="cyan" />
                ) : (
                    <KpiCard label="Streak" metric="activityStreak" value={`${t.longestStreak}d`} icon={Flame}
                        sub={t.currentStreak ? `${t.currentStreak} days and counting` : 'No current streak'} accent="cyan" />
                )}
                <KpiCard label="Views opened" value={t.viewsOpened.current} icon={MousePointerClick}
                    changePct={t.viewsOpened.changePct} comparisonLabel={vs}
                    sub={`${exact(t.distinctViews)} different ${t.distinctViews === 1 ? 'view' : 'views'}`} accent="indigo" />
                <KpiCard label="Lineage traces" value={t.traces.current} icon={Route}
                    changePct={t.traces.changePct} comparisonLabel={vs}
                    sub={t.traceEmptyRate == null ? 'No traces yet' : `${percent(1 - t.traceEmptyRate)} found lineage`}
                    accent={t.traceEmptyRate != null && t.traceEmptyRate > 0.3 ? 'pink' : 'amber'} />
                <KpiCard label="Searches" value={t.searches.current} icon={Search}
                    changePct={t.searches.changePct} comparisonLabel={vs}
                    sub={t.searchMissRate == null ? 'No searches yet' : `${percent(1 - t.searchMissRate)} matched`}
                    accent="rose" />
            </div>

            <ChartFrame
                id="chart-person-calendar"
                title="The last year, day by day"
                subtitle="Every day’s actions — pick one to see the whole day"
                isEmpty={!calendar}
                emptyLabel="Loading the year…"
                table={months ? (
                    <ChartTable rowLabel="Month" rows={months.rows} columns={[
                        { key: 'actions', label: 'Actions', values: months.values },
                        { key: 'days', label: 'Active days', values: months.active },
                    ]} />
                ) : undefined}
            >
                {calendar && (
                    <ActivityCalendar days={calendar.days} actions={calendar.actions} signIns={calendar.signIns}
                        selected={selectedDay} onSelectDay={onSelectDay} />
                )}
            </ChartFrame>

            <ChartFrame
                id="chart-person-line"
                title="Activity line"
                subtitle={`Their actions per ${data.window.granularity === 'week' ? 'week' : 'day'} in ${rangePhrase(range)}, against ${previousLabel(range).toLowerCase()}${full ? ', with sign-ins' : ''}`}
                isEmpty={data.series.actions.every((v) => v === 0) && data.series.previousActions.every((v) => v === 0)}
                emptyLabel="They did nothing in this range or the one before."
                ghostLabel={previousLabel(range)}
                series={[
                    { key: 'actions', label: 'Actions', color: theme.series[1], shape: 'area' as const },
                    ...(data.series.signIns ? [{ key: 'signins', label: 'Sign-ins', color: theme.series[0], shape: 'line' as const }] : []),
                ]}
                table={<ChartTable rowLabel="Period" rows={data.series.buckets.map((b) => shortDate(b, true))}
                    columns={[
                        { key: 'actions', label: 'Actions', values: data.series.actions },
                        { key: 'previous', label: previousLabel(range), values: data.series.previousActions },
                        ...(data.series.signIns ? [{ key: 'signins', label: 'Sign-ins', values: data.series.signIns }] : []),
                    ]} />}
            >
                <TimeSeriesChart
                    buckets={data.series.buckets}
                    axisLabels={data.series.buckets.map((b) => shortDate(b))}
                    series={[
                        { key: 'actions', label: 'Actions', values: data.series.actions, slot: 1, area: true,
                          previous: data.series.previousActions },
                        ...(data.series.signIns ? [{ key: 'signins', label: 'Sign-ins', values: data.series.signIns, slot: 0 }] : []),
                    ]}
                />
            </ChartFrame>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="Activity over time"
                    subtitle={`What they did in ${rangePhrase(range)}, by kind — drag to zoom`}
                    className="xl:col-span-2"
                    isEmpty={kinds.length === 0}
                    emptyLabel="Nothing in this range."
                    series={kinds.map((s) => ({
                        key: s.kind, label: kindLabel(s.kind), shape: 'area' as const,
                        color: kindSlot(s.kind) === undefined ? theme.neutralMark : theme.series[kindSlot(s.kind)!],
                    }))}
                    table={<ChartTable rowLabel="Period" rows={data.series.buckets.map((b) => shortDate(b, true))}
                        columns={kinds.map((s) => ({ key: s.kind, label: kindLabel(s.kind), values: s.values }))} />}
                >
                    <StackedAreaChart
                        buckets={data.series.buckets}
                        series={kinds.map((s) => ({
                            key: s.kind, label: kindLabel(s.kind), values: s.values,
                            slot: kindSlot(s.kind) ?? 0, residual: kindSlot(s.kind) === undefined,
                        }))}
                        formatBucket={(b) => shortDate(b, true)}
                        axisLabels={data.series.buckets.map((b) => shortDate(b))}
                        onSelectSpan={(a, b) => onRange(spanToRange(data.series.buckets, data.window.granularity, a, b, data.window.end))}
                    />
                </ChartFrame>
                <ChartFrame
                    title="What they do"
                    subtitle="Share of their activity, and the things they do most"
                    isEmpty={data.kinds.every((k) => k.count === 0)}
                    emptyLabel="Nothing in this range."
                    table={<ChartTable rowLabel="Activity" rows={data.types.map((x) => x.label)}
                        columns={[{ key: 'n', label: 'Times', values: data.types.map((x) => x.count) }]} />}
                >
                    <div className="space-y-4">
                        <StackedShareBar slices={data.kinds.filter((k) => k.count).map((k) => ({ key: k.kind, count: k.count }))}
                            labelOf={kindLabel} slotOf={kindSlot} />
                        <Leaderboard unit="times" unitOne="time"
                            rows={data.types.slice(0, 8).map((x) => ({ id: x.type, label: x.label, meta: kindLabel(x.kind), value: x.count }))} />
                    </div>
                </ChartFrame>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <ChartFrame
                    title="When they work"
                    subtitle="Weekday × hour, UTC"
                    className="xl:col-span-2"
                    isEmpty={data.punchcard.every((r) => r.every((n) => n === 0))}
                    emptyLabel="Nothing in this range."
                    table={<ChartTable {...punchcardTable(data.punchcard)} caption="Actions per weekday and hour, UTC" />}
                >
                    <PunchcardGrid grid={data.punchcard} unit="actions" />
                </ChartFrame>
                <TypicalDay data={data} />
            </div>

            <WorkspaceTimeline data={data} />

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                <ChartFrame title="Most opened views" subtitle={`In ${rangePhrase(range)}`}
                    isEmpty={data.views.length === 0} emptyLabel="They opened no views in this range.">
                    <Leaderboard unit="opens" unitOne="open" slot={1}
                        rows={data.views.map((v) => ({
                            id: v.id ?? '',
                            label: v.locked || !v.name
                                ? <span className="italic text-ink-muted">A view you cannot open</span>
                                : <ViewLink viewId={v.id!} name={v.name} canOpen={v.canOpen} />,
                            meta: v.deleted ? 'Deleted since' : undefined,
                            value: v.opens,
                        }))} />
                </ChartFrame>
                {data.signIns ? <SignInCard data={data} /> : (
                    <ChartFrame title="Where in the app" subtitle="Sections they moved to"
                        isEmpty={data.sections.length === 0} emptyLabel="No section visits recorded in this range.">
                        <Leaderboard unit="visits" unitOne="visit"
                            rows={data.sections.map((s) => ({ id: s.section, label: sectionLabel(s.section), value: s.count }))} />
                    </ChartFrame>
                )}
            </div>
        </div>
    )
}

function TypicalDay({ data }: { data: PersonDoc }) {
    const theme = useChartTheme()
    const { firstMinute, lastMinute, days } = data.typicalDay
    const left = firstMinute == null ? 0 : (firstMinute / 1440) * 100
    const width = firstMinute == null || lastMinute == null ? 0 : Math.max(1, ((lastMinute - firstMinute) / 1440) * 100)
    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 shadow-sm">
            <h2 className="text-sm font-bold text-ink">A typical day</h2>
            <p className="text-[11px] text-ink-muted mb-4">The middle of their first and last action, across {exact(days)} active {days === 1 ? 'day' : 'days'}, UTC</p>
            {firstMinute == null ? <p className="text-xs text-ink-muted">Not enough activity to say.</p> : (
                <>
                    <div className="flex items-end justify-between">
                        <div>
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Starts</p>
                            <p className="text-2xl font-bold tabular-nums text-ink">{minuteLabel(firstMinute)}</p>
                        </div>
                        <div className="text-right">
                            <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Wraps up</p>
                            <p className="text-2xl font-bold tabular-nums text-ink">{minuteLabel(lastMinute)}</p>
                        </div>
                    </div>
                    <div className="relative mt-4 h-3 rounded-full bg-black/[0.05] dark:bg-white/[0.06]">
                        <div className="absolute inset-y-0 rounded-full" style={{ left: `${left}%`, width: `${width}%`, backgroundColor: theme.series[1] }} />
                    </div>
                    <div className="mt-1 flex justify-between text-[10px] tabular-nums text-ink-muted">
                        <span>00</span><span>06</span><span>12</span><span>18</span><span>24</span>
                    </div>
                </>
            )}
        </section>
    )
}

/** Every workspace they belong to or were ever active in, on one time line: from
 *  when they joined, through their first and last activity there, to today. */
function WorkspaceTimeline({ data }: { data: PersonDoc }) {
    const theme = useChartTheme()
    const rows = data.workspaces
    // "Today" is when the document was built: pure, and in step with the figures.
    const now = Date.parse(data.generatedAt)
    const starts = rows.flatMap((r) => [r.joinedAt, r.firstActiveAt]).filter(Boolean).map((s) => Date.parse(s!))
    const origin = starts.length ? Math.min(...starts) : now
    const span = Math.max(1, now - origin)
    const pos = (iso: string | null) => iso ? ((Date.parse(iso) - origin) / span) * 100 : null

    return (
        <ChartFrame
            title="Where they work, and since when"
            subtitle="Each workspace from the day they joined it — first and last activity marked, actions in this range alongside"
            isEmpty={rows.length === 0}
            emptyLabel="They belong to no workspace and have done nothing in one."
            table={<ChartTable rowLabel="Workspace" rows={rows.map((r) => r.name ?? 'A workspace you cannot see')}
                columns={[{ key: 'a', label: 'Actions in range', values: rows.map((r) => r.actions) }]} />}
        >
            <ul className="space-y-3">
                {rows.map((r, i) => {
                    const joined = pos(r.joinedAt)
                    const first = pos(r.firstActiveAt)
                    const last = pos(r.lastActiveAt)
                    const from = joined ?? first ?? 0
                    return (
                        <li key={r.workspaceId ?? i} className="grid grid-cols-[minmax(9rem,14rem)_1fr_auto] items-center gap-4">
                            <div className="min-w-0">
                                {r.workspaceId && r.name
                                    ? <WorkspaceLink workspaceId={r.workspaceId} name={r.name} canOpen={r.canOpen} className="text-xs font-semibold" />
                                    : <span className="text-xs italic text-ink-muted">A workspace you cannot see</span>}
                                <p className="text-[10px] text-ink-muted">
                                    {r.member ? 'Member' : 'No longer a member'}
                                    {r.joinedAt && <> · joined <DateTime at={r.joinedAt} variant="calendar" /></>}
                                </p>
                            </div>
                            <div className="relative h-6" aria-hidden>
                                <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full bg-black/[0.05] dark:bg-white/[0.06] inset-x-0" />
                                <div className="absolute top-1/2 h-1 -translate-y-1/2 rounded-full"
                                    style={{ left: `${from}%`, right: r.member ? '0%' : `${100 - (last ?? from)}%`, backgroundColor: theme.series[1], opacity: 0.35 }} />
                                {first != null && last != null && (
                                    <div className="absolute top-1/2 h-2 -translate-y-1/2 rounded-full"
                                        style={{ left: `${first}%`, width: `${Math.max(0.8, last - first)}%`, backgroundColor: theme.series[1] }} />
                                )}
                                {joined != null && <span className="absolute top-1/2 h-3 w-0.5 -translate-y-1/2 rounded bg-ink" style={{ left: `${joined}%` }} />}
                            </div>
                            <div className="text-right text-[11px]">
                                <p className="font-semibold tabular-nums text-ink">{compact(r.actions)}</p>
                                <p className="text-ink-muted">{r.lastActiveAt ? <DateTime at={r.lastActiveAt} prefix="last " /> : 'never active'}</p>
                            </div>
                        </li>
                    )
                })}
            </ul>
            {rows.length > 0 && (
                <p className="mt-3 flex flex-wrap gap-4 text-[10px] text-ink-muted">
                    <span className="inline-flex items-center gap-1"><span className="h-3 w-0.5 rounded bg-ink" />Joined</span>
                    <span className="inline-flex items-center gap-1"><span className="h-2 w-4 rounded-full" style={{ backgroundColor: theme.series[1] }} />First to last activity</span>
                    <span>From <DateTime at={new Date(origin).toISOString()} variant="calendar" /> to today</span>
                </p>
            )}
        </ChartFrame>
    )
}

function SignInCard({ data }: { data: PersonDoc }) {
    const s = data.signIns!
    return (
        <ChartFrame title="Sign-ins & security" subtitle="How they sign in, and attempts on their account"
            isEmpty={s.methods.length === 0 && s.failed === 0} emptyLabel="No sign-ins in this range.">
            <div className="space-y-4">
                {s.methods.length > 0 && <StackedShareBar slices={s.methods} labelOf={(k) => k === 'local' ? 'Password' : k} />}
                <div className={cn('flex items-center gap-2 rounded-xl border px-3 py-2 text-xs',
                    s.failed ? 'border-amber-500/30 bg-amber-500/10 text-amber-900 dark:text-amber-100' : 'border-glass-border text-ink-secondary')}>
                    {s.failed ? <ShieldAlert className="h-4 w-4" /> : <KeyRound className="h-4 w-4 text-ink-muted" />}
                    {s.failed ? `${exact(s.failed)} failed sign-in ${s.failed === 1 ? 'attempt' : 'attempts'} against this account` : 'No failed sign-in attempts'}
                </div>
                {s.recent.length > 0 && (
                    <ul className="divide-y divide-glass-border text-xs">
                        {s.recent.map((r, i) => (
                            <li key={i} className="flex items-center justify-between py-1.5">
                                <DateTime at={r.at} variant="calendar" />
                                <span className="text-ink-muted">{r.method === 'local' ? 'Password' : r.method}</span>
                            </li>
                        ))}
                    </ul>
                )}
            </div>
        </ChartFrame>
    )
}

function EventRow({ e, onOpenDay }: { e: ActivityEventRow; onOpenDay?: (day: string) => void }) {
    const theme = useChartTheme()
    const meta = KIND_META[e.kind]
    const Icon = meta?.icon ?? Activity
    const colour = meta?.slot === undefined ? theme.neutralMark : theme.series[meta.slot]
    return (
        <li id={`event-${e.id}`} className="group flex items-start gap-3 py-2.5 scroll-mt-24">
            <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                style={{ backgroundColor: `${colour}22`, color: colour }}>
                <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-xs text-ink">
                    <span className="font-semibold">{e.label}</span>
                    {e.view && (e.view.locked || !e.view.name
                        ? <span className="italic text-ink-muted"> · a view you cannot open</span>
                        : <> · <ViewLink viewId={e.view.id!} name={e.view.name} canOpen={e.view.canOpen} /></>)}
                    {!e.view && e.target?.label && <span className="text-ink-secondary"> · {e.target.label}</span>}
                    {e.section && <span className="text-ink-secondary"> · {sectionLabel(e.section)}</span>}
                    {e.outcome && e.outcome !== 'success' && <Badge tone="warning" className="ml-1.5">{e.outcome}</Badge>}
                </p>
                {e.summary && <p className="truncate text-[11px] text-ink-muted">{e.summary}</p>}
                {e.workspace?.name && (
                    <p className="text-[10px] text-ink-muted">in {e.workspace.workspaceId
                        ? <WorkspaceLink workspaceId={e.workspace.workspaceId} name={e.workspace.name} canOpen={e.workspace.canOpen} />
                        : e.workspace.name}</p>
                )}
            </div>
            <span className="shrink-0 text-[11px] tabular-nums text-ink-muted">
                {onOpenDay
                    ? <button type="button" onClick={() => onOpenDay(e.at.slice(0, 10))} className="hover:text-ink hover:underline">{utcClock(e.at)}</button>
                    : utcClock(e.at)}
            </span>
        </li>
    )
}

/** Everything they did, newest first, a page at a time, filterable by kind. */
function Feed({ id, workspaceId, lens, onOpenDay }: {
    id: string; workspaceId: string | null; lens: 'full' | 'workspace'; onOpenDay: (d: string) => void
}) {
    const theme = useChartTheme()
    const [kinds, setKinds] = useState<FeedKind[]>([])
    const feed = usePersonFeed(id, workspaceId, kinds)
    const events = useMemo(() => feed.data?.pages.flatMap((p) => p.events) ?? [], [feed.data])
    const byDay = useMemo(() => {
        const groups: { day: string; events: ActivityEventRow[] }[] = []
        for (const e of events) {
            const d = e.at.slice(0, 10)
            if (groups.at(-1)?.day !== d) groups.push({ day: d, events: [] })
            groups.at(-1)!.events.push(e)
        }
        return groups
    }, [events])
    const options: FeedKind[] = [...kindsFor(lens), 'section']
    const toggle = (k: FeedKind) => setKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k])

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated p-5 shadow-sm">
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <h2 className="mr-2 text-sm font-bold text-ink">Everything they did</h2>
                {options.map((k) => {
                    const meta = KIND_META[k]
                    const on = kinds.includes(k)
                    const colour = meta.slot === undefined ? theme.neutralMark : theme.series[meta.slot]
                    return (
                        <button key={k} type="button" aria-pressed={on} onClick={() => toggle(k)}
                            className={cn('inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
                                on ? 'border-transparent text-white' : 'border-glass-border text-ink-secondary hover:text-ink')}
                            style={on ? { backgroundColor: colour } : undefined}>
                            {!on && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: colour }} />}
                            {meta.label}
                        </button>
                    )
                })}
                {kinds.length > 0 && <button type="button" onClick={() => setKinds([])} className="text-[11px] font-semibold text-ink-muted hover:text-ink">Clear</button>}
            </div>
            {feed.isLoading ? <Skeleton className="h-40 w-full" /> : events.length === 0 ? (
                <EmptyState compact icon={Clock4} title="Nothing to show" description={kinds.length ? 'Nothing of these kinds was recorded.' : 'No activity recorded for this person yet.'} />
            ) : (
                <div className="space-y-5">
                    {byDay.map((g) => (
                        <div key={g.day}>
                            <button type="button" onClick={() => onOpenDay(g.day)}
                                className="sticky top-0 z-[1] mb-1 flex w-full items-center justify-between rounded-lg bg-canvas-elevated py-1 text-left text-[11px] font-bold uppercase tracking-wide text-ink-muted hover:text-ink">
                                <span>{describeDay(g.day)}</span>
                                <span className="font-semibold normal-case tracking-normal">{g.events.length} {g.events.length === 1 ? 'event' : 'events'} · open the day →</span>
                            </button>
                            <ul className="divide-y divide-glass-border">
                                {g.events.map((e) => <EventRow key={e.id} e={e} />)}
                            </ul>
                        </div>
                    ))}
                    {feed.hasNextPage && (
                        <button type="button" onClick={() => feed.fetchNextPage()} disabled={feed.isFetchingNextPage}
                            className="w-full rounded-xl border border-glass-border py-2 text-xs font-semibold text-ink-secondary hover:bg-black/[0.03] dark:hover:bg-white/[0.03] disabled:opacity-50">
                            {feed.isFetchingNextPage ? 'Loading…' : 'Show earlier activity'}
                        </button>
                    )}
                </div>
            )}
        </section>
    )
}

function PersonDayPanel({ id, day, workspaceId, today, onDay, onClose }: {
    id: string; day: string | null; workspaceId: string | null
    /** The last day there can be anything to show. */
    today: string
    onDay: (d: string) => void; onClose: () => void
}) {
    const q = usePersonDay(id, day, workspaceId)
    const open = !!day
    const data = q.data
    const jump = (eventId: string) => document.getElementById(`event-${eventId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })

    const sessions = useMemo(() => {
        if (!data) return []
        return data.sessions.map((s) => ({
            ...s, events: data.events.filter((e) => e.at >= s.start && e.at <= s.end),
        }))
    }, [data])

    return (
        <>
            <Backdrop open={open} onClick={onClose} zClassName="z-40" />
            <aside role="dialog" aria-modal="true" aria-label={day ? `Activity on ${describeDay(day)}` : 'Day'}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}
                className={cn('fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col border-l border-glass-border bg-canvas-elevated shadow-2xl transition-transform duration-300',
                    open ? 'translate-x-0' : 'translate-x-full pointer-events-none')}>
                <header className="flex items-center justify-between gap-3 border-b border-glass-border px-6 py-4">
                    <div className="min-w-0">
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-ink-muted">One day</p>
                        <h2 className="truncate text-lg font-bold text-ink">{day ? describeDay(day) : ''}</h2>
                        {data && (
                            <p className="text-xs text-ink-muted">
                                {exact(data.events.filter((e) => e.kind !== 'section' && e.kind !== 'signin').length)} actions
                                {' · '}{data.sessions.length} {data.sessions.length === 1 ? 'session' : 'sessions'}
                                {data.truncated && ' · first 500 events'}
                            </p>
                        )}
                    </div>
                    <div className="flex items-center gap-1">
                        <button type="button" aria-label="Previous day" onClick={() => day && onDay(addDays(day, -1))}
                            className="rounded-lg p-2 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"><ChevronLeft className="h-4 w-4" /></button>
                        <button type="button" aria-label="Next day" disabled={!day || day >= today} onClick={() => day && onDay(addDays(day, 1))}
                            className="rounded-lg p-2 text-ink-muted hover:bg-black/5 hover:text-ink disabled:opacity-30 dark:hover:bg-white/5"><ChevronRight className="h-4 w-4" /></button>
                        <button type="button" aria-label="Close day" onClick={onClose}
                            className="rounded-lg p-2 text-ink-muted hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"><X className="h-4 w-4" /></button>
                    </div>
                </header>
                <div className={cn('flex-1 space-y-5 overflow-y-auto px-6 py-5 transition-opacity', q.isFetching && 'opacity-60')}>
                    {!data ? <Skeleton className="h-40 w-full" /> : data.events.length === 0 ? (
                        <EmptyState compact icon={Clock4} title="Nothing happened this day" description="No sign-ins, opens or changes were recorded." />
                    ) : (
                        <>
                            <DayRibbon events={data.events} sessions={data.sessions} onSelect={jump} />
                            <StackedShareBar
                                // Section moves are presence, not activity — and both they and
                                // "Other" would take the neutral mark, which may not repeat.
                                slices={Object.entries(data.kinds).filter(([k]) => k !== 'section')
                                    .map(([k, n]) => ({ key: k, count: n ?? 0 }))}
                                labelOf={kindLabel} slotOf={kindSlot} />
                            {sessions.map((s, i) => (
                                <div key={s.start}>
                                    <h3 className="mb-1 flex items-center justify-between text-[11px] font-bold uppercase tracking-wide text-ink-muted">
                                        <span>Session {i + 1}</span>
                                        <span className="font-semibold normal-case tracking-normal tabular-nums">
                                            {utcClock(s.start)}–{utcClock(s.end)} UTC · {s.actions} {s.actions === 1 ? 'action' : 'actions'}
                                        </span>
                                    </h3>
                                    <ul className="divide-y divide-glass-border">
                                        {s.events.map((e) => <EventRow key={e.id} e={e} />)}
                                    </ul>
                                </div>
                            ))}
                        </>
                    )}
                </div>
            </aside>
        </>
    )
}

