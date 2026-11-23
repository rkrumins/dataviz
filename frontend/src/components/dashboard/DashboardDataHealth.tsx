/**
 * DashboardDataHealth — what the Technical view leads the Dashboard with: how the
 * data behind the reader's workspaces is doing.
 *
 *   * every source they can read, in one of five states (failed, behind, being
 *     built, never built, healthy) — counted, then the ones that need a look,
 *     worst first, each with the one place to see why (and fix it, for whoever may);
 *   * what is being built right now, and how far along;
 *   * the connections to the graph databases behind them, for people who may read
 *     providers, and the run record, for platform administrators;
 *   * what changed lately: connections rebuilt, sources added.
 *
 * Almost all of it comes from the workspace list the Dashboard already holds. The
 * extra reads are bounded and cheap: projection health for a dozen ready sources
 * (is it behind?), and readiness for the few failed or running ones (the error, the
 * progress). Nothing here renders for someone who can't read a data source.
 */
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { useQueries, useQuery } from '@tanstack/react-query'
import type { ComponentType } from 'react'
import {
    Activity, AlertOctagon, ArrowRight, CheckCircle2, Clock, Hammer, HeartPulse, History, Loader2, PlusCircle,
    RefreshCw, Server, TimerReset,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { timeAgo } from '@/lib/timeAgo'
import { aggregationService } from '@/services/aggregationService'
import { useAnyWorkspacePermission, useNavPermission, usePermission, usePermissionClaims } from '@/store/auth'
import { useSidebarSpec } from '@/store/navCatalogue'
import { useAllProviderStatuses } from '@/store/providerStatus'
import { useWorkspacesStore } from '@/store/workspaces'
import {
    healthOf, readableSources, recentDataChanges, summarizeDataHealth, type RatedSource, type SourceHealth,
} from './dataHealth'

/** How many ready sources to ask "are you behind?" — the read is cached server-side, but bounded all the same. */
const PROJECTION_CHECKS = 12
/** How many failed or running sources to read the last run of. */
const RUN_CHECKS = 6
const SHOWN = 6

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const STATE: Record<SourceHealth, { icon: ComponentType<{ className?: string }>; chip: string; label: string }> = {
    failed: { icon: AlertOctagon, chip: 'bg-rose-500/10 text-rose-500 border-rose-500/20', label: 'Last build failed' },
    behind: { icon: TimerReset, chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20', label: 'Behind its changes' },
    'not-built': { icon: Hammer, chip: 'bg-slate-500/10 text-ink-secondary border-slate-500/20', label: 'Never built' },
    processing: { icon: Loader2, chip: 'bg-sky-500/10 text-sky-500 border-sky-500/20', label: 'Building now' },
    healthy: { icon: CheckCircle2, chip: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20', label: 'Healthy' },
}

const processingHref = (s: RatedSource) => `/workspaces/${s.workspaceId}?tab=data&section=processing`

export function DashboardDataHealth() {
    const claims = usePermissionClaims()
    const workspaces = useWorkspacesStore(s => s.workspaces)
    const sources = useMemo(() => readableSources(workspaces, claims), [workspaces, claims])

    // A ready source can still be behind its latest published changes — the one thing the list can't say.
    const ready = sources.filter(s => s.status === 'ready').slice(0, PROJECTION_CHECKS)
    const projections = useQueries({
        queries: ready.map(s => ({
            queryKey: ['dashboard', 'projection-health', s.id],
            queryFn: () => aggregationService.getProjectionHealth(s.id),
            staleTime: 60_000,
            retry: false,
        })),
    })
    const projectionOf = new Map(ready.map((s, i) => [s.id, projections[i]?.data]))
    const rated: RatedSource[] = sources.map(s => {
        const p = projectionOf.get(s.id)
        return { ...s, health: healthOf(s, p), behindBy: p?.projectionCommitsBehind }
    })
    const summary = summarizeDataHealth(rated)

    // The failed and running ones: their last run says what went wrong, or how far along it is.
    const runs = [...summary.attention.filter(s => s.health === 'failed'), ...summary.processing].slice(0, RUN_CHECKS)
    const readiness = useQueries({
        queries: runs.map(s => ({
            queryKey: ['dashboard', 'readiness', s.id],
            queryFn: () => aggregationService.getReadiness(s.id),
            staleTime: 15_000,
            retry: false,
            refetchInterval: s.health === 'processing' ? 10_000 : (false as const),
        })),
    })
    const runOf = new Map(runs.map((s, i) => [s.id, readiness[i]?.data?.activeJob]))

    const ingestionVisible = useNavPermission(useSidebarSpec('ingestion'))
    const needLook = summary.counts.failed + summary.counts.behind
    const verdict = summary.attention.length > 0
        ? `${plural(summary.attention.length, 'source needs', 'sources need')} a look`
        : summary.processing.length > 0 ? 'Nothing needs a look — some are building' : 'Everything is healthy'

    const tiles = [
        { label: 'Failed or behind', value: needLook, detail: needLook ? `${summary.counts.failed} failed · ${summary.counts.behind} behind` : 'Every build finished, all caught up', tone: 'rose' },
        { label: 'Building', value: summary.counts.processing, detail: 'Working out connections now', tone: 'sky' },
        { label: 'Never built', value: summary.counts['not-built'], detail: 'Connections not worked out yet', tone: 'amber' },
        { label: 'Healthy', value: summary.counts.healthy, detail: 'Built and up to date', tone: 'emerald' },
    ] as const

    return (
        <section aria-labelledby="data-health-title" className="mb-14 px-4 md:px-0">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/20">
                        <HeartPulse className="h-5 w-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                        <h2 id="data-health-title" className="text-lg font-bold text-ink">Data health</h2>
                        <p className="text-xs text-ink-muted">
                            {verdict} · {plural(rated.length, 'source')} across {plural(summary.workspaces, 'workspace')} you can see
                        </p>
                    </div>
                </div>
                {ingestionVisible && (
                    <Link to="/ingestion" className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">
                        Open Ingestion <ArrowRight className="h-3.5 w-3.5" aria-hidden />
                    </Link>
                )}
            </div>

            <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
                {tiles.map(t => <StatTile key={t.label} label={t.label} value={t.value} detail={t.detail} tone={t.tone} />)}
            </div>

            <div className="grid gap-4 lg:grid-cols-5">
                <div className="space-y-4 min-w-0 lg:col-span-3">
                    <Panel icon={AlertOctagon} tone={summary.attention.length ? 'text-rose-500 bg-rose-500/10' : 'text-emerald-500 bg-emerald-500/10'}
                        title="Sources that need a look" count={summary.attention.length || undefined}>
                        {summary.attention.length === 0 ? (
                            <p className="flex items-center gap-2 px-4 py-4 text-sm text-ink-muted">
                                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden />
                                Every source you can see built cleanly and is up to date.
                            </p>
                        ) : (
                            <ul className="divide-y divide-glass-border">
                                {summary.attention.slice(0, SHOWN).map(s => (
                                    <SourceRow key={s.id} source={s} detail={attentionDetail(s, runOf.get(s.id)?.errorMessage)}
                                        action={<Link to={processingHref(s)} className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10">{s.canManage ? 'Fix it' : 'See why'}</Link>} />
                                ))}
                                {summary.attention.length > SHOWN && (
                                    <li className="px-4 py-2.5 text-xs text-ink-muted">And {plural(summary.attention.length - SHOWN, 'more')} in your workspaces.</li>
                                )}
                            </ul>
                        )}
                        {summary.attention.length > 0 && (
                            <p className="border-t border-glass-border/60 px-4 py-2.5 text-[11px] text-ink-muted">
                                Worst first: failed builds, then sources behind their published changes, then ones never built.
                            </p>
                        )}
                    </Panel>

                    {summary.processing.length > 0 && (
                        <Panel icon={Activity} tone="text-sky-500 bg-sky-500/10" title="Building now" count={summary.processing.length}>
                            <ul className="divide-y divide-glass-border">
                                {summary.processing.slice(0, SHOWN).map(s => {
                                    const job = runOf.get(s.id)
                                    const pct = job ? Math.min(100, Math.round(job.progress || 0)) : null
                                    return (
                                        <SourceRow key={s.id} source={s}
                                            detail={pct !== null ? `${pct}%${job?.currentPhase ? ` · ${job.currentPhase}` : ''}${job?.startedAt ? ` · started ${timeAgo(job.startedAt)}` : ''}` : s.status === 'pending' ? 'Waiting its turn' : 'Working out connections'}
                                            progress={pct}
                                            action={<Link to={processingHref(s)} className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:bg-indigo-500/10">Watch</Link>} />
                                    )
                                })}
                            </ul>
                        </Panel>
                    )}
                </div>

                <div className="space-y-4 min-w-0 lg:col-span-2">
                    <ConnectionsPanel />
                    <RunsPanel />
                    <Panel icon={History} tone="text-violet-500 bg-violet-500/10" title="Recent data changes">
                        <RecentChanges sources={rated} />
                    </Panel>
                </div>
            </div>
        </section>
    )
}

function attentionDetail(s: RatedSource, error?: string): string {
    if (s.health === 'failed') return error || 'Its last build didn’t finish, so its connections may be out of date.'
    if (s.health === 'behind') {
        return s.behindBy ? `${plural(s.behindBy, 'published change')} not in its connections yet` : 'Its connections are catching up with published changes'
    }
    return 'Its connections have never been worked out — lineage on it reads slowly, or not at all.'
}

const TILE_TONE = {
    rose: { ring: 'border-rose-500/20', value: 'text-rose-600 dark:text-rose-400', dot: 'bg-rose-500' },
    sky: { ring: 'border-sky-500/20', value: 'text-sky-600 dark:text-sky-400', dot: 'bg-sky-500' },
    amber: { ring: 'border-amber-500/20', value: 'text-amber-600 dark:text-amber-400', dot: 'bg-amber-500' },
    emerald: { ring: 'border-emerald-500/20', value: 'text-emerald-600 dark:text-emerald-400', dot: 'bg-emerald-500' },
}

function StatTile({ label, value, detail, tone }: { label: string; value: number; detail: string; tone: keyof typeof TILE_TONE }) {
    const t = TILE_TONE[tone]
    return (
        <div className={cn('glass-panel rounded-2xl border p-4', value > 0 ? t.ring : 'border-glass-border')}>
            <div className="flex items-center gap-1.5 text-xs font-semibold text-ink-secondary">
                <span aria-hidden className={cn('h-1.5 w-1.5 rounded-full', value > 0 ? t.dot : 'bg-ink-muted/40')} />
                {label}
            </div>
            <div className={cn('mt-2 text-3xl font-black leading-none tracking-tight tabular-nums', value > 0 ? t.value : 'text-ink-muted')}>{value}</div>
            <div className="mt-1 truncate text-[11px] text-ink-muted">{detail}</div>
        </div>
    )
}

function Panel({ icon: Icon, tone, title, count, action, children }: {
    icon: ComponentType<{ className?: string }>
    tone: string
    title: string
    count?: number
    action?: React.ReactNode
    children: React.ReactNode
}) {
    return (
        <section aria-label={title} className="glass-panel overflow-hidden rounded-2xl border border-glass-border">
            <div className="flex items-center justify-between gap-3 border-b border-glass-border px-4 py-3">
                <h3 className="flex items-center gap-2 text-sm font-bold text-ink">
                    <span className={cn('flex h-7 w-7 items-center justify-center rounded-lg', tone)}><Icon className="h-3.5 w-3.5" aria-hidden /></span>
                    {title}
                    {count !== undefined && <span className="rounded-full bg-black/[0.05] px-2 py-0.5 text-[11px] font-semibold tabular-nums text-ink-secondary dark:bg-white/[0.06]">{count}</span>}
                </h3>
                {action}
            </div>
            {children}
        </section>
    )
}

function SourceRow({ source, detail, action, progress }: { source: RatedSource; detail: string; action: React.ReactNode; progress?: number | null }) {
    const st = STATE[source.health]
    return (
        <li className="flex items-center gap-3 px-4 py-3">
            <span className={cn('flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border', st.chip)} title={st.label}>
                <st.icon className={cn('h-4 w-4', source.health === 'processing' && 'animate-spin')} aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-baseline gap-x-2">
                    <span className="truncate text-sm font-semibold text-ink">{source.label}</span>
                    <span className="text-xs text-ink-muted">in {source.workspaceName}</span>
                </span>
                <span className="mt-0.5 block truncate text-xs text-ink-secondary" title={detail}>
                    <span className="font-medium">{st.label}</span> · {detail}
                </span>
                {progress !== undefined && progress !== null && (
                    <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                        <span className="block h-full rounded-full bg-gradient-to-r from-sky-500 to-indigo-500" style={{ width: `${progress}%` }} />
                    </span>
                )}
            </span>
            {action}
        </li>
    )
}

/** The graph databases behind the sources, as the status poll last saw them — for people who may read providers. */
function ConnectionsPanel() {
    const isAdmin = usePermission('system:admin')
    const canRead = useAnyWorkspacePermission('workspace:provider:read')
    const statuses = useAllProviderStatuses()
    if (!isAdmin && !canRead) return null
    const down = statuses.filter(s => s.status === 'unavailable')
    const up = statuses.filter(s => s.status === 'ready').length
    const shown = [...down, ...statuses.filter(s => s.status !== 'unavailable')].slice(0, 4)
    return (
        <Panel icon={Server} tone={down.length ? 'text-rose-500 bg-rose-500/10' : 'text-indigo-500 bg-indigo-500/10'} title="Connections"
            action={<Link to="/ingestion?tab=providers" className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Providers</Link>}>
            {statuses.length === 0 ? (
                <p className="px-4 py-4 text-sm text-ink-muted">No connection has reported in yet.</p>
            ) : (
                <>
                    <p className="px-4 pt-3 text-xs text-ink-secondary">
                        {down.length ? `${plural(down.length, 'connection')} unavailable · ${up} reachable` : `All ${plural(statuses.length, 'connection')} reachable`}
                    </p>
                    <ul className="px-4 pb-3 pt-2 space-y-1.5">
                        {shown.map(s => (
                            <li key={s.id} className="flex items-center gap-2 text-xs">
                                <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full',
                                    s.status === 'ready' ? 'bg-emerald-500' : s.status === 'unavailable' ? 'bg-rose-500' : 'bg-slate-400')} />
                                <span className="truncate font-medium text-ink">{s.name}</span>
                                <span className="ml-auto shrink-0 text-ink-muted" title={s.error}>
                                    {s.status === 'ready' ? 'Reachable' : s.status === 'unavailable' ? 'Unavailable' : 'Not checked yet'}
                                </span>
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </Panel>
    )
}

/** How builds have been going, across the platform — the run record is a platform administrator's. */
function RunsPanel() {
    const isAdmin = usePermission('system:admin')
    const { data } = useQuery({
        queryKey: ['dashboard', 'aggregation-jobs-summary'],
        queryFn: () => aggregationService.getJobsSummary(),
        enabled: isAdmin,
        staleTime: 60_000,
        retry: false,
    })
    if (!isAdmin || !data) return null
    const failed = data.byStatus?.failed ?? 0
    const avg = data.avgDurationSeconds
    return (
        <Panel icon={RefreshCw} tone="text-sky-500 bg-sky-500/10" title="Builds"
            action={<Link to="/ingestion?tab=jobs" className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline">Job history</Link>}>
            <dl className="grid grid-cols-3 gap-2 px-4 py-3">
                <Fact label="Runs" value={String(data.total)} />
                <Fact label="Succeeded" value={data.successRate !== null ? `${data.successRate}%` : '—'} warn={data.successRate !== null && data.successRate < 90} />
                <Fact label="Typical run" value={avg !== null ? (avg >= 90 ? `${Math.round(avg / 60)} min` : `${Math.round(avg)} s`) : '—'} />
            </dl>
            {failed > 0 && <p className="px-4 pb-3 -mt-1 text-[11px] text-ink-muted">{plural(failed, 'run')} failed on record.</p>}
        </Panel>
    )
}

function Fact({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
    return (
        <div>
            <dt className="text-[11px] text-ink-muted">{label}</dt>
            <dd className={cn('text-lg font-bold tabular-nums', warn ? 'text-amber-600 dark:text-amber-400' : 'text-ink')}>{value}</dd>
        </div>
    )
}

function RecentChanges({ sources }: { sources: RatedSource[] }) {
    const changes = recentDataChanges(sources)
    if (changes.length === 0) return <p className="px-4 py-4 text-sm text-ink-muted">Nothing has changed yet.</p>
    return (
        <ol className="px-4 py-2">
            {changes.map(c => {
                const Icon = c.kind === 'rebuilt' ? RefreshCw : PlusCircle
                return (
                    <li key={c.key} className="flex items-start gap-2.5 py-2">
                        <span className={cn('mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg',
                            c.kind === 'rebuilt' ? 'bg-sky-500/10 text-sky-500' : 'bg-emerald-500/10 text-emerald-500')}>
                            <Icon className="h-3 w-3" aria-hidden />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs text-ink">
                                <span className="font-semibold">{c.source.label}</span>
                                {c.kind === 'rebuilt' ? ' — connections rebuilt' : ` added to ${c.source.workspaceName}`}
                            </span>
                            <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                                <Clock className="h-3 w-3" aria-hidden /> {timeAgo(c.at)}
                                {c.kind === 'rebuilt' && <> · <Link to={`/workspaces/${c.source.workspaceId}?tab=data`} className="hover:text-ink hover:underline">{c.source.workspaceName}</Link></>}
                            </span>
                        </span>
                    </li>
                )
            })}
        </ol>
    )
}
