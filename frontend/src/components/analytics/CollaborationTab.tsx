/**
 * CollaborationTab — the questions people ask about views and data sources.
 *
 * Three questions, in the order a reader asks them:
 *
 *   1. Are questions getting answered, and how fast? Asked against answered,
 *      the wait for a first reply and for an accepted answer, and how many
 *      have waited over a week.
 *   2. What are people asking about? The views and sources with the most
 *      said about them, and the workspaces asking most.
 *   3. Who answers, and who is still waiting? The people the platform leans
 *      on (privileged readers only) and the oldest open questions.
 *
 * Reads its own document, so it neither waits on nor fails with the summary.
 * A deployment with questions switched off, or with none asked yet, says so
 * rather than drawing ten empty panels.
 */
import { Link } from 'react-router-dom'
import {
    BadgeCheck, CheckCircle2, Hourglass, Lock, MessageCircleQuestion, MessagesSquare,
    Reply, UserCheck, Users,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { exact, percent, shortDate, waitPhrase } from '@/lib/formatMetric'
import { useFeature } from '@/store/features'
import type {
    AnalyticsCollaborationDoc, AnalyticsRangeSelection, DiscussedSource, DiscussedView,
    WaitingQuestion,
} from '@/services/analyticsService'
import { KpiCard } from './KpiCard'
import { Leaderboard, type LeaderboardRow } from './Leaderboard'
import { MetricInfo } from './MetricInfo'
import { WithheldPanel } from './Redacted'
import { QuestionLink, SourceLink, ViewLink, WorkspaceLink } from './EntityLink'
import { ChartFrame } from './charts/ChartFrame'
import { ChartTable } from './charts/ChartTable'
import { TimeSeriesChart } from './charts/TimeSeriesChart'
import { useChartTheme } from './charts/chartTheme'
import { comparisonLabel, rangePhrase } from './RangePicker'

/** The guide page that explains asking, answering and accepting. */
export const ASKING_GUIDE = '/guide/asking-questions'

export function CollaborationTab({
    data, range, isStale, onWorkspaceClick,
}: {
    data: AnalyticsCollaborationDoc
    range: AnalyticsRangeSelection
    isStale: boolean
    /** Open a workspace's drill-in. */
    onWorkspaceClick?: (workspaceId: string) => void
}) {
    const theme = useChartTheme()
    const conversations = useFeature('conversationsEnabled')
    const { kpis, series, leaderboards } = data
    const vs = comparisonLabel(range)
    const phrase = rangePhrase(range)
    const redacted = !!data.redaction?.applied

    if (kpis.asked.total === 0) {
        return <NothingAsked off={!conversations} />
    }

    const asked = kpis.asked.current ?? 0
    const rate = kpis.answerRate
    const dates = series.buckets.map((b) => shortDate(b, true))

    return (
        <div className={cn('space-y-6 transition-opacity', isStale && 'opacity-50')}>
            {!conversations && (
                <p role="note" className="flex items-start gap-2 rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3 text-[11px] leading-relaxed text-ink-muted">
                    <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span>
                        Questions are switched off on this deployment, so nobody can ask new ones.
                        What is below is what was asked while they were on.
                    </span>
                </p>
            )}

            {/* ── Are questions answered? ──────────────────────────────── */}
            <section aria-labelledby="collab-answered" className="space-y-3">
                <div>
                    <h2 id="collab-answered" className="text-sm font-bold text-ink mb-1">Questions and answers</h2>
                    <p className="text-[11px] text-ink-muted">
                        Asked about a view or a data source in {phrase}, and how quickly someone answered.
                    </p>
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
                    <KpiCard
                        label="Questions asked" metric="questionsAsked" icon={MessageCircleQuestion} accent="indigo"
                        value={asked} changePct={kpis.asked.changePct} comparisonLabel={vs}
                        sub={`${exact(kpis.asked.total)} counted in all`}
                        trend={series.asked}
                    />
                    <KpiCard
                        label="Answer rate" metric="answerRate" icon={CheckCircle2}
                        accent={rate.current != null && rate.current < 0.5 ? 'amber' : 'emerald'}
                        value={percent(rate.current)}
                        sub={asked
                            ? `${exact(rate.answered)} of ${exact(asked)}${rate.previous == null ? '' : ` · was ${percent(rate.previous)}`}`
                            : `Nothing asked in ${phrase}`}
                    />
                    <KpiCard
                        label="Time to first reply" metric="firstResponse" icon={Reply} accent="cyan"
                        value={waitPhrase(kpis.firstResponseHours.current)}
                        changePct={kpis.firstResponseHours.changePct} comparisonLabel={vs}
                        sub={kpis.firstResponseHours.measured
                            ? `middle of ${exact(kpis.firstResponseHours.measured)} replied to`
                            : 'No question here has a reply yet'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Time to an accepted answer" metric="timeToAnswer" icon={BadgeCheck} accent="violet"
                        value={waitPhrase(kpis.answerHours.current)}
                        changePct={kpis.answerHours.changePct} comparisonLabel={vs}
                        sub={kpis.answerHours.measured
                            ? `middle of ${exact(kpis.answerHours.measured)} answered`
                            : 'No answer accepted yet'}
                        higherIsBetter={false}
                    />
                    <KpiCard
                        label="Waiting over a week" metric="waitingOverWeek" icon={Hourglass}
                        accent={kpis.waitingOverWeek.total ? 'amber' : 'emerald'}
                        value={exact(kpis.waitingOverWeek.total)}
                        sub={`${exact(kpis.open.total)} open now`}
                        higherIsBetter={false}
                    />
                </div>
                <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <KpiCard
                        label="People asking" metric="peopleAsking" icon={Users} accent="indigo"
                        value={kpis.askers.current ?? 0}
                        changePct={kpis.askers.changePct} comparisonLabel={vs}
                    />
                    <KpiCard
                        label="People answering" metric="peopleAnswering" icon={UserCheck} accent="emerald"
                        value={kpis.answerers.current ?? 0}
                        changePct={kpis.answerers.changePct} comparisonLabel={vs}
                    />
                    <KpiCard
                        label="Replies posted" metric="repliesPosted" icon={MessagesSquare} accent="cyan"
                        value={kpis.replies.current ?? 0}
                        changePct={kpis.replies.changePct} comparisonLabel={vs}
                    />
                    <KpiCard
                        label="Asked privately" metric="askedPrivately" icon={Lock} accent="pink"
                        value={percent(kpis.privateShare.current)}
                        sub={kpis.privateShare.previous == null
                            ? `of questions in ${phrase}`
                            : `was ${percent(kpis.privateShare.previous)} the period before`}
                    />
                </div>

                <ChartFrame
                    title="Asked and answered"
                    subtitle="Questions asked each period, and how many of them have an accepted answer now"
                    isStale={isStale}
                    isEmpty={series.asked.every((v) => v === 0)}
                    emptyLabel={`No questions were asked in ${phrase}.`}
                    series={[
                        { key: 'asked', label: 'Asked', color: theme.series[0], shape: 'line' },
                        { key: 'answered', label: 'Answered', color: theme.series[2], shape: 'line' },
                    ]}
                    table={(
                        <ChartTable
                            rowLabel="Date" rows={dates}
                            columns={[
                                { key: 'asked', label: 'Asked', values: series.asked },
                                { key: 'answered', label: 'Answered', values: series.answered },
                            ]}
                        />
                    )}
                >
                    <TimeSeriesChart
                        buckets={series.buckets} height={200}
                        series={[
                            { key: 'asked', label: 'Asked', values: series.asked, slot: 0 },
                            { key: 'answered', label: 'Answered', values: series.answered, slot: 2 },
                        ]}
                    />
                </ChartFrame>
            </section>

            {/* ── What people ask about ─────────────────────────────────── */}
            <section aria-labelledby="collab-about" className="space-y-3">
                <div>
                    <h2 id="collab-about" className="text-sm font-bold text-ink mb-1">What people ask about</h2>
                    <p className="text-[11px] text-ink-muted">
                        Ranked by questions asked plus replies posted in {phrase}.
                    </p>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <ChartFrame
                        id="chart-most-discussed"
                        title="Most discussed views"
                        subtitle="Questions and replies on each view"
                        action={<MetricInfo metric="mostDiscussed" />}
                        isStale={isStale}
                        isEmpty={leaderboards.views.length === 0}
                        emptyLabel={`Nobody asked about a view in ${phrase}.`}
                    >
                        <Leaderboard unit="messages" unitOne="message" slot={0} rows={leaderboards.views.map(viewRow)} />
                    </ChartFrame>
                    <ChartFrame
                        title="Data sources with the most questions"
                        subtitle="Questions and replies on each source — opens its Questions tab"
                        action={<MetricInfo metric="mostDiscussed" />}
                        isStale={isStale}
                        isEmpty={leaderboards.sources.length === 0}
                        emptyLabel={`Nobody asked about a data source in ${phrase}.`}
                    >
                        <Leaderboard unit="messages" unitOne="message" slot={4} rows={leaderboards.sources.map(sourceRow)} />
                    </ChartFrame>
                </div>
                <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    <ChartFrame
                        title="Workspaces asking most"
                        subtitle="Questions about each workspace's views and sources"
                        isStale={isStale}
                        isEmpty={leaderboards.workspaces.length === 0}
                        emptyLabel={`No questions in ${phrase}.`}
                    >
                        <Leaderboard
                            unit="questions" unitOne="question" slot={2}
                            onRowClick={onWorkspaceClick ? (row) => onWorkspaceClick(row.id) : undefined}
                            rows={leaderboards.workspaces.map((w) => ({
                                id: w.workspaceId,
                                label: <WorkspaceLink workspaceId={w.workspaceId} name={w.name} canOpen={w.canOpen} />,
                                meta: w.firstResponseHours == null
                                    ? 'No replies yet'
                                    : `First reply in ${waitPhrase(w.firstResponseHours)}`,
                                value: w.questions,
                                detail: `${percent(w.answerRate)} answered`,
                            }))}
                        />
                    </ChartFrame>
                    {redacted ? (
                        <WithheldPanel
                            title="People who answer most is hidden"
                            reason="Who answers, who asked and what they asked are visible to administrators and auditors only. The counts above include everyone's questions and replies."
                        />
                    ) : (
                        <ChartFrame
                            title="People who answer most"
                            subtitle={`Accepted answers, then replies to other people's questions, in ${phrase}`}
                            action={<MetricInfo metric="topAnswerers" />}
                            isStale={isStale}
                            isEmpty={leaderboards.answerers.length === 0}
                            emptyLabel={`Nobody answered someone else's question in ${phrase}.`}
                        >
                            <Leaderboard
                                unit="accepted" slot={1}
                                rows={leaderboards.answerers.map((p) => ({
                                    id: p.userId,
                                    label: p.name,
                                    value: p.accepted,
                                    detail: `${exact(p.replies)} ${p.replies === 1 ? 'reply' : 'replies'}`,
                                }))}
                            />
                        </ChartFrame>
                    )}
                </div>
            </section>

            {/* ── Who is still waiting ──────────────────────────────────── */}
            <ChartFrame
                id="chart-longest-waiting"
                title="Longest-waiting questions"
                subtitle={`Open, oldest first, as of now · ${exact(kpis.waitingOverWeek.total)} waited over a week`}
                action={<MetricInfo metric="longestWaiting" />}
                isStale={isStale}
                isEmpty={leaderboards.waiting.length === 0}
                emptyLabel="No question is waiting for an answer."
            >
                <Leaderboard unit="days" unitOne="day" slot={3} rows={leaderboards.waiting.map(waitingRow)} />
                {redacted && leaderboards.waiting.length > 0 && (
                    <p className="mt-2 text-[10px] text-ink-muted">
                        What was asked, and by whom, is shown to administrators and auditors only.
                    </p>
                )}
            </ChartFrame>
        </div>
    )
}

function counts(row: DiscussedView | DiscussedSource): Pick<LeaderboardRow, 'value' | 'detail'> {
    return {
        value: row.messages,
        detail: `${exact(row.questions)} asked · ${exact(row.open)} open`,
    }
}

function viewRow(v: DiscussedView, i: number): LeaderboardRow {
    return {
        id: v.viewId ?? `hidden-view-${i}`,
        label: <ViewLink viewId={v.viewId ?? ''} name={v.name} canOpen={!v.redacted && v.canOpen} />,
        meta: `${v.workspaceName ?? '—'} · ${exact(v.answered)} answered`,
        ...counts(v),
    }
}

function sourceRow(s: DiscussedSource, i: number): LeaderboardRow {
    return {
        id: s.dataSourceId ?? `hidden-source-${i}`,
        label: s.dataSourceId && s.workspaceId
            ? <SourceLink workspaceId={s.workspaceId} dataSourceId={s.dataSourceId} name={s.name} canOpen={s.canOpen} />
            : <span className="text-ink-muted">{s.name}</span>,
        meta: `${s.workspaceName ?? '—'} · ${exact(s.answered)} answered`,
        ...counts(s),
    }
}

function waitingRow(q: WaitingQuestion, i: number): LeaderboardRow {
    const replies = q.replies ? `${exact(q.replies)} ${q.replies === 1 ? 'reply' : 'replies'}` : 'No reply yet'
    if (q.redacted || !q.discussionId || !q.subjectId) {
        return {
            id: `hidden-question-${i}`,
            label: (
                <span className="font-normal italic text-ink-muted">
                    {q.private
                        ? 'A private question'
                        : `On a ${q.subjectType === 'view' ? 'view' : 'source'} you cannot see`}
                </span>
            ),
            meta: q.workspaceName ?? undefined,
            value: q.ageDays ?? 0,
            detail: replies,
        }
    }
    const where = q.subjectType === 'view' ? 'view' : 'data source'
    return {
        id: q.discussionId,
        label: (
            <QuestionLink
                subjectType={q.subjectType} subjectId={q.subjectId} workspaceId={q.workspaceId}
                discussionId={q.discussionId} name={q.subjectName ?? 'Untitled'} canOpen={q.canOpen}
            />
        ),
        meta: q.private
            ? `Private question · ${q.workspaceName ?? where}`
            : q.excerpt
                ? `“${q.excerpt}”${q.askedByName ? ` — ${q.askedByName}` : ''}`
                : `${q.workspaceName ?? '—'} · ${where}`,
        value: q.ageDays ?? 0,
        detail: replies,
    }
}

/** No questions at all: say why, and where to read about asking one. */
function NothingAsked({ off }: { off: boolean }) {
    return (
        <div role="status" className="rounded-2xl border border-glass-border bg-canvas-elevated p-8 flex flex-col items-center text-center">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-indigo-500/20 bg-indigo-500/10">
                <MessagesSquare className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            </div>
            <h2 className="text-base font-bold text-ink mb-1">
                {off ? 'Questions are switched off' : 'No questions yet'}
            </h2>
            <p className="max-w-md text-sm text-ink-muted">
                {off
                    ? 'Asking about a view or a data source is off on this deployment, so there is nothing to count. An administrator can turn on Questions and conversations in Administration → Features.'
                    : 'When someone asks about a view or a data source, it is counted here: how many were answered, how fast, what people ask about most, and which questions are still waiting.'}
            </p>
            <Link
                to={ASKING_GUIDE}
                className="mt-4 text-xs font-semibold text-indigo-600 hover:underline dark:text-indigo-400 outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50 rounded"
            >
                How asking questions works
            </Link>
        </div>
    )
}
