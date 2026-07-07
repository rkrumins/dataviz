/**
 * AdminInfrastructure — the super-admin single pane of glass over every
 * backing service: Postgres (management + GraphVer), Redis (bus + cache),
 * FalkorDB, the aggregation control plane + worker fleet, the stats
 * service, graph-service, and viz-service itself — plus the data-plane
 * truth: projection lag, stream depth/lag, DLQs, and the outbox relay.
 *
 * Read-only observability (v1): verdicts come from work signals in shared
 * state, so the page is equally truthful on docker-compose and GKE.
 */
import { Activity, AlertTriangle, CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { OverviewSection, SystemStatusSnapshot } from '@/services/systemStatusService'
import { useSystemStatus } from './useSystemStatus'
import { ServiceTile } from './ServiceTile'
import { ProjectionPanel } from './ProjectionPanel'
import { StreamsPanel } from './StreamsPanel'
import { GraphProvidersPanel } from './GraphProvidersPanel'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { compactNum, formatAgeMs } from './meta'

function OverviewStrip({ overview }: { overview: OverviewSection | null }) {
    if (!overview) return null
    const items: { label: string; value: string | number | undefined; sub?: string }[] = [
        { label: 'Workspaces', value: overview.workspaces },
        { label: 'Data sources', value: overview.dataSources },
        { label: 'Providers', value: overview.providers ? `${overview.providers.active}/${overview.providers.total}` : undefined, sub: 'active / total' },
        {
            label: 'Versioned graphs', value: overview.versionedGraphs,
            sub: overview.orphanedGraphs ? `${compactNum(overview.orphanedGraphs)} orphaned` : undefined,
        },
        { label: 'Open reviews', value: overview.openReviews },
        { label: 'Commits', value: overview.commits },
    ]
    const shown = items.filter(i => i.value != null)
    if (!shown.length) return null
    return (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {shown.map(i => (
                <div key={i.label} className="border border-glass-border rounded-xl bg-canvas-elevated px-4 py-3">
                    <p className="text-xl font-bold text-ink tabular-nums">
                        {typeof i.value === 'number' ? compactNum(i.value) : i.value}
                    </p>
                    <p className="text-[10px] text-ink-muted mt-0.5 uppercase tracking-wide">{i.label}</p>
                    {i.sub && <p className="text-[10px] text-ink-muted/70 mt-0.5">{i.sub}</p>}
                </div>
            ))}
        </div>
    )
}

const HERO = {
    healthy: {
        cls: 'border-emerald-500/30 bg-emerald-500/5',
        icon: CheckCircle2,
        iconCls: 'text-emerald-500',
        title: 'All systems operational',
    },
    degraded: {
        cls: 'border-amber-500/30 bg-amber-500/5',
        icon: AlertTriangle,
        iconCls: 'text-amber-500',
        title: 'Some components need attention',
    },
    down: {
        cls: 'border-red-500/30 bg-red-500/5',
        icon: XCircle,
        iconCls: 'text-red-500',
        title: 'Core database unreachable',
    },
} as const

function heroSentence(snap: SystemStatusSnapshot): string {
    const down = snap.services.filter(s => s.status === 'down').length
    const degraded = snap.services.filter(s => s.status === 'degraded').length
    const healthy = snap.services.filter(s => s.status === 'healthy').length
    if (snap.status === 'healthy') {
        return `${healthy} of ${snap.services.length} services healthy — queues draining, projections in sync.`
    }
    const parts: string[] = []
    if (down) parts.push(`${down} down`)
    if (degraded) parts.push(`${degraded} degraded`)
    return `${healthy} of ${snap.services.length} services healthy, ${parts.join(', ')}. Details below.`
}

function WorkloadTile({ label, value, sub, tone }: {
    label: string
    value: string
    sub?: string | null
    tone?: 'warn' | 'bad' | null
}) {
    return (
        <div className="relative overflow-hidden border border-glass-border rounded-xl p-4 bg-canvas-elevated">
            <p className={cn('text-2xl font-bold',
                tone === 'bad' ? 'text-red-600 dark:text-red-400'
                    : tone === 'warn' ? 'text-amber-600 dark:text-amber-400'
                        : 'text-ink')}>
                {value}
            </p>
            <p className="text-xs text-ink-muted mt-1">{label}</p>
            {sub && <p className="text-[10px] text-ink-muted mt-0.5 truncate">{sub}</p>}
        </div>
    )
}

function Skeleton() {
    return (
        <div className="space-y-6 animate-pulse">
            <div className="h-20 rounded-xl bg-black/5 dark:bg-white/10" />
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
                {Array.from({ length: 10 }).map((_, i) => (
                    <div key={i} className="h-28 rounded-xl bg-black/5 dark:bg-white/10" />
                ))}
            </div>
            <div className="h-48 rounded-xl bg-black/5 dark:bg-white/10" />
            <div className="h-56 rounded-xl bg-black/5 dark:bg-white/10" />
        </div>
    )
}

export function AdminInfrastructure() {
    const { data, error, isLoading, isFetching, dataUpdatedAt, refetch, history } = useSystemStatus()

    const hero = data ? HERO[data.status] : null
    const HeroIcon = hero?.icon ?? Loader2
    const updatedAgo = dataUpdatedAt ? formatAgeMs(Date.now() - dataUpdatedAt) : null

    const jobs = data?.aggregationJobs
    const polling = data?.statsPolling

    return (
        <div className="max-w-[1440px] mx-auto p-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between mb-8">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                        <Activity className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink">Infrastructure</h1>
                        <p className="text-sm text-ink-muted mt-1">
                            Live health, performance, and data-plane lag across every backing service.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-3">
                    {updatedAgo && (
                        <span className="text-[11px] text-ink-muted">
                            Updated {updatedAgo} ago · refreshes every 10s
                        </span>
                    )}
                    <button
                        onClick={() => refetch()}
                        disabled={isFetching}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2 disabled:opacity-60"
                    >
                        <RefreshCw className={cn('w-4 h-4', isFetching && 'animate-spin')} /> Refresh
                    </button>
                </div>
            </div>

            {isLoading ? (
                <Skeleton />
            ) : error && !data ? (
                <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-6 flex items-center gap-3">
                    <XCircle className="w-6 h-6 text-red-500 shrink-0" />
                    <div>
                        <p className="text-sm font-semibold text-ink">Could not load the infrastructure snapshot</p>
                        <p className="text-xs text-ink-muted mt-0.5 font-mono">{error instanceof Error ? error.message : String(error)}</p>
                    </div>
                </div>
            ) : data && hero ? (
                <div className="space-y-6">
                    {/* Status hero */}
                    <div className={cn('border rounded-xl p-5 flex items-center gap-4', hero.cls)}>
                        <HeroIcon className={cn('w-8 h-8 shrink-0', hero.iconCls)} />
                        <div className="min-w-0">
                            <h2 className="text-lg font-bold text-ink">{hero.title}</h2>
                            <p className="text-xs text-ink-muted mt-0.5">{heroSentence(data)}</p>
                        </div>
                        <span className="ml-auto text-[10px] text-ink-muted shrink-0 text-right">
                            snapshot {formatAgeMs(data.cacheAgeMs) ?? '0s'} old
                            <br />shared across viewers
                        </span>
                    </div>

                    {/* System at a glance — inventory of the key components */}
                    <OverviewStrip overview={data.overview} />

                    {/* Service grid */}
                    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-4">
                        {data.services.map(svc => (
                            <ServiceTile key={svc.key} svc={svc} history={history.get(`latency:${svc.key}`)} />
                        ))}
                    </div>

                    {/* Graph data providers (any type — FalkorDB, Neo4j, …) */}
                    <GraphProvidersPanel providers={data.graphProviders} />

                    {/* Workload KPIs — is the work getting done, and how fast */}
                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
                        <WorkloadTile
                            label="Aggregation success rate"
                            value={jobs?.successRate != null ? `${jobs.successRate}%` : '—'}
                            sub={jobs?.total != null ? `${compactNum(jobs.total)} jobs · ${jobs.byStatus?.failed ?? 0} failed` : null}
                            tone={jobs?.successRate != null && jobs.successRate < 90 ? 'warn' : null}
                        />
                        <WorkloadTile
                            label="Avg job duration"
                            value={jobs?.avgDurationSeconds != null ? `${jobs.avgDurationSeconds}s` : '—'}
                            sub="last 50 completed"
                        />
                        <WorkloadTile
                            label="Stuck jobs"
                            value={jobs?.stuckJobs != null ? String(jobs.stuckJobs) : '—'}
                            sub="running with no executor heartbeat"
                            tone={(jobs?.stuckJobs ?? 0) > 0 ? 'bad' : null}
                        />
                        <WorkloadTile
                            label="Overdue data sources"
                            value={polling ? String(polling.overdue) : '—'}
                            sub="not polled within 2× their interval"
                            tone={(polling?.overdue ?? 0) > 0 ? 'warn' : null}
                        />
                    </div>

                    {/* Diagnostics & remediation — what's wrong, why, how to fix */}
                    <DiagnosticsPanel snapshot={data} />

                    <ProjectionPanel projection={data.projection} providers={data.graphProviders} />
                    <StreamsPanel streams={data.streams} outbox={data.outbox} history={history} />
                </div>
            ) : null}
        </div>
    )
}
