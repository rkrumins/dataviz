/**
 * AdminAudit — RBAC + user lifecycle audit log lens.
 *
 * Phase 7. Backs `/admin/audit`. Reads from the
 * `GET /api/v1/admin/audit` endpoint with filter + cursor pagination.
 *
 * Visual language mirrors AdminUsers / AdminPermissions: gradient
 * hero, KPI strip (counts by category), filter chips, table view.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
    Activity, AlertCircle, ChevronRight, Filter, History, Loader2,
    RefreshCw, X, Shield, UserCog, KeyRound,
} from 'lucide-react'
import { auditService, type AuditEvent, type AuditFilters } from '@/services/auditService'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'


// Category buckets for the KPI strip + colour coding. Each maps to
// one or more event-type prefixes the backend emits.
const CATEGORIES = [
    {
        key: 'workspace',
        label: 'Workspace bindings',
        prefix: 'rbac.workspace.',
        icon: UserCog,
        accent: 'text-sky-600 dark:text-sky-400',
        iconBg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    },
    {
        key: 'role',
        label: 'Role lifecycle',
        prefix: 'rbac.role.',
        icon: Shield,
        accent: 'text-violet-600 dark:text-violet-400',
        iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
    },
    {
        key: 'permission',
        label: 'Permissions',
        prefix: 'rbac.permission.',
        icon: KeyRound,
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    },
    {
        key: 'user',
        label: 'User lifecycle',
        prefix: 'user.',
        icon: Activity,
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    },
] as const


function formatRelative(iso: string): string {
    const then = new Date(iso).getTime()
    const diff = Date.now() - then
    if (diff < 60_000) return 'just now'
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
    return `${Math.floor(diff / 86_400_000)}d ago`
}


export function AdminAudit() {
    const canViewAudit = usePermission('system:admin')

    const [events, setEvents] = useState<AuditEvent[]>([])
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [nextCursor, setNextCursor] = useState<string | null>(null)
    const [loadingMore, setLoadingMore] = useState(false)

    // Filter state. All optional; passing `undefined` removes the
    // filter from the request.
    const [activeCategory, setActiveCategory] = useState<string | null>(null)
    const [actorFilter, setActorFilter] = useState('')
    const [targetUserFilter, setTargetUserFilter] = useState('')
    // Phase 9: three-mode scope picker. Security (default) hides
    // chatty operational events but keeps logins / logouts; activity
    // adds password / signup chrome for support work; everything is
    // the unfiltered firehose for debugging.
    const [scope, setScope] = useState<'security' | 'activity' | 'all'>('security')
    // Phase 8: time window. ``7d`` is the default — wide enough to
    // cover a typical incident review, narrow enough to keep the
    // result set scannable. ``all`` removes the lower bound.
    const [timeRange, setTimeRange] = useState<'24h' | '7d' | '30d' | 'all'>('7d')
    const { showToast } = useToast()

    const fromTs = useMemo(() => {
        if (timeRange === 'all') return undefined
        const ms = { '24h': 86_400_000, '7d': 7 * 86_400_000, '30d': 30 * 86_400_000 }[timeRange]
        return new Date(Date.now() - ms).toISOString()
    }, [timeRange])

    const activeFilters: AuditFilters = useMemo(() => {
        const cat = CATEGORIES.find(c => c.key === activeCategory)
        return {
            eventType: cat ? `${cat.prefix}*` : undefined,
            actorId: actorFilter.trim() || undefined,
            targetUserId: targetUserFilter.trim() || undefined,
            category: scope,
            fromTs,
            limit: 50,
        }
    }, [activeCategory, actorFilter, targetUserFilter, scope, fromTs])

    const load = useCallback(
        async (silent = false) => {
            if (!silent) setLoading(true)
            setError(null)
            try {
                const resp = await auditService.list(activeFilters)
                setEvents(resp.events)
                setNextCursor(resp.nextCursor ?? null)
            } catch (err) {
                const message = err instanceof Error ? err.message : 'Failed to load audit'
                setError(message)
                if (silent) showToast('error', message)
            } finally {
                setLoading(false)
                setRefreshing(false)
            }
        },
        [activeFilters, showToast],
    )

    useEffect(() => {
        void load()
    }, [load])

    const loadMore = async () => {
        if (!nextCursor) return
        setLoadingMore(true)
        try {
            const resp = await auditService.list({ ...activeFilters, cursor: nextCursor })
            setEvents(prev => [...prev, ...resp.events])
            setNextCursor(resp.nextCursor ?? null)
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load more'
            showToast('error', message)
        } finally {
            setLoadingMore(false)
        }
    }

    const counts = useMemo(() => {
        const out: Record<string, number> = {}
        for (const c of CATEGORIES) out[c.key] = 0
        for (const e of events) {
            for (const c of CATEGORIES) {
                if (e.eventType.startsWith(c.prefix)) {
                    out[c.key]++
                    break
                }
            }
        }
        return out
    }, [events])

    if (!canViewAudit) {
        return (
            <div className="p-6">
                <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-6 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                    <div>
                        <p className="text-sm font-semibold text-ink">Audit log requires Super Admin</p>
                        <p className="text-xs text-ink-muted mt-1">
                            The audit history contains sensitive role and permission changes
                            and is restricted to Super Admins (<code className="font-mono">system:admin</code>).
                        </p>
                    </div>
                </div>
            </div>
        )
    }

    return (
        <PageContainer gutter="shell" className="py-8 space-y-6 animate-in fade-in duration-500">
                {/* Hero */}
                <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-600 to-slate-700 flex items-center justify-center shadow-md shrink-0">
                            <History className="w-6 h-6 text-white" />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-2xl font-bold text-ink">Audit log</h1>
                            <p className="text-sm text-ink-muted">
                                RBAC + user lifecycle events emitted into the outbox.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={() => { setRefreshing(true); void load(true) }}
                        disabled={loading || refreshing}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-secondary hover:text-ink bg-glass-base/40 border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors shrink-0"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
                        Refresh
                    </button>
                </div>

                {/* KPI strip — counts per category */}
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {CATEGORIES.map(c => {
                        const Icon = c.icon
                        const isActive = activeCategory === c.key
                        return (
                            <button
                                key={c.key}
                                onClick={() => setActiveCategory(isActive ? null : c.key)}
                                className={cn(
                                    'rounded-xl border p-3 text-left transition-all flex items-center gap-3',
                                    isActive
                                        ? 'border-accent-lineage bg-accent-lineage/5 shadow-sm'
                                        : 'border-glass-border bg-canvas-elevated hover:border-accent-lineage/30',
                                )}
                            >
                                <div className={cn(
                                    'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
                                    c.iconBg,
                                )}>
                                    <Icon className="w-4 h-4" />
                                </div>
                                <div className="min-w-0">
                                    <p className="text-2xs uppercase tracking-wide text-ink-muted">
                                        {c.label}
                                    </p>
                                    <p className={cn('text-xl font-bold', c.accent)}>
                                        {counts[c.key]}
                                    </p>
                                </div>
                            </button>
                        )
                    })}
                </div>

                {/* Time range + scope toggle */}
                <div className="rounded-xl border border-glass-border bg-canvas-elevated p-3 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                        <span className="text-2xs uppercase tracking-wide text-ink-muted mr-1">
                            Range
                        </span>
                        {(['24h', '7d', '30d', 'all'] as const).map(r => {
                            const active = timeRange === r
                            return (
                                <button
                                    key={r}
                                    onClick={() => setTimeRange(r)}
                                    className={cn(
                                        'px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors',
                                        active
                                            ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
                                            : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30',
                                    )}
                                >
                                    {r === 'all' ? 'All time' : `Last ${r}`}
                                </button>
                            )
                        })}
                    </div>
                    <div className="flex items-center gap-1.5">
                        <span className="text-2xs uppercase tracking-wide text-ink-muted mr-1">
                            Scope
                        </span>
                        {(['security', 'activity', 'all'] as const).map(s => {
                            const active = scope === s
                            const labels = {
                                security: 'Security',
                                activity: 'Activity',
                                all: 'Everything',
                            } as const
                            const tooltips = {
                                security: 'Logins, role changes, RBAC mutations. Hides per-request 403 noise + signup/password chrome.',
                                activity: 'Security view plus signup / password-reset chrome — useful for support troubleshooting.',
                                all: 'Unfiltered firehose. Includes 403 spam — slow on busy systems.',
                            } as const
                            return (
                                <button
                                    key={s}
                                    onClick={() => setScope(s)}
                                    className={cn(
                                        'px-2.5 py-1 rounded-md text-xs font-semibold border transition-colors',
                                        active
                                            ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
                                            : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30',
                                    )}
                                    title={tooltips[s]}
                                >
                                    {labels[s]}
                                </button>
                            )
                        })}
                    </div>
                </div>

                {/* Inline scope description — keeps operators from
                    wondering "why isn't event X showing up?". */}
                <div className="text-2xs text-ink-muted -mt-3 px-3">
                    {scope === 'security' && (
                        <>Showing: logins, logouts, failed logins, session revocations, every RBAC mutation. Hiding: access-denied noise, password chrome, signup chrome.</>
                    )}
                    {scope === 'activity' && (
                        <>Showing: everything from Security plus password resets, signups, access requests. Hiding: per-request access-denied noise only.</>
                    )}
                    {scope === 'all' && (
                        <>Showing the unfiltered firehose — including hourly access-denied events.</>
                    )}
                </div>

                {/* Filter row */}
                <div className="rounded-xl border border-glass-border bg-canvas-elevated p-3 flex flex-wrap items-center gap-2">
                    <Filter className="w-4 h-4 text-ink-muted shrink-0" />
                    <input
                        type="text"
                        placeholder="Filter by actor user id…"
                        value={actorFilter}
                        onChange={e => setActorFilter(e.target.value)}
                        className="flex-1 min-w-[180px] bg-transparent border border-glass-border rounded-lg px-3 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/40"
                    />
                    <input
                        type="text"
                        placeholder="Filter by target user id…"
                        value={targetUserFilter}
                        onChange={e => setTargetUserFilter(e.target.value)}
                        className="flex-1 min-w-[180px] bg-transparent border border-glass-border rounded-lg px-3 py-1.5 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/40"
                    />
                    {(activeCategory || actorFilter || targetUserFilter) && (
                        <button
                            onClick={() => {
                                setActiveCategory(null)
                                setActorFilter('')
                                setTargetUserFilter('')
                            }}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold text-ink-muted hover:text-ink"
                        >
                            <X className="w-3 h-3" />
                            Clear
                        </button>
                    )}
                </div>

                {/* Body */}
                {loading ? (
                    <div className="flex items-center justify-center py-24">
                        <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
                    </div>
                ) : error ? (
                    <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-6 flex items-start gap-3">
                        <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                        <div>
                            <p className="text-sm font-semibold text-red-600 dark:text-red-400">Couldn't load audit log</p>
                            <p className="text-xs text-ink-muted mt-1">{error}</p>
                        </div>
                    </div>
                ) : events.length === 0 ? (
                    <div className="rounded-2xl border border-glass-border bg-glass-base/30 p-12 text-center">
                        <History className="w-8 h-8 text-ink-muted mx-auto mb-2" />
                        <p className="text-sm text-ink-muted">No audit events match this filter.</p>
                    </div>
                ) : (
                    <>
                        <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                            <table className="w-full text-sm">
                                <thead className="text-2xs uppercase tracking-wide text-ink-muted bg-glass-base/30">
                                    <tr>
                                        <th className="text-left px-2 py-2 w-6"></th>
                                        <th className="text-left px-4 py-2">When</th>
                                        <th className="text-left px-4 py-2">What happened</th>
                                        <th className="text-left px-4 py-2">Actor</th>
                                        <th className="text-left px-4 py-2">Target</th>
                                        <th className="text-left px-4 py-2">Workspace</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {events.map(e => (
                                        <AuditRow key={e.eventId} event={e} />
                                    ))}
                                </tbody>
                            </table>
                        </div>

                        {nextCursor && (
                            <div className="flex justify-center">
                                <button
                                    onClick={loadMore}
                                    disabled={loadingMore}
                                    className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold bg-canvas-elevated border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                >
                                    {loadingMore ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ChevronRight className="w-3.5 h-3.5" />}
                                    Load more
                                </button>
                            </div>
                        )}
                    </>
                )}
        </PageContainer>
    )
}


const SEVERITY_DOT: Record<string, string> = {
    info: 'bg-sky-500',
    warning: 'bg-amber-500',
    critical: 'bg-red-500',
}


function AuditRow({ event }: { event: AuditEvent }) {
    const [expanded, setExpanded] = useState(false)
    const severity = event.severity ?? 'info'
    return (
        <>
            <tr
                onClick={() => setExpanded(v => !v)}
                className="border-t border-glass-border hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer"
            >
                <td className="px-2 py-2.5">
                    <span
                        className={cn(
                            'inline-block w-2 h-2 rounded-full',
                            SEVERITY_DOT[severity] ?? SEVERITY_DOT.info,
                        )}
                        title={`Severity: ${severity}`}
                    />
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-muted whitespace-nowrap" title={event.createdAt}>
                    {formatRelative(event.createdAt)}
                </td>
                <td className="px-4 py-2.5">
                    <p className="text-sm text-ink font-medium">
                        {event.summary || event.eventType}
                    </p>
                    <code className="font-mono text-[10px] text-ink-muted">
                        {event.eventType}
                    </code>
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-secondary">
                    {event.actorId ? (
                        <a
                            href={`/admin/users#${event.actorId}`}
                            onClick={e => e.stopPropagation()}
                            className="font-mono text-[11px] hover:text-accent-lineage hover:underline"
                        >
                            {event.actorId}
                        </a>
                    ) : (
                        <span className="text-ink-muted">—</span>
                    )}
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-secondary">
                    {event.targetUserId ? (
                        <a
                            href={`/admin/users#${event.targetUserId}`}
                            onClick={e => e.stopPropagation()}
                            className="font-mono text-[11px] hover:text-accent-lineage hover:underline"
                        >
                            {event.targetUserId}
                        </a>
                    ) : (
                        <span className="text-ink-muted">—</span>
                    )}
                    {event.targetRole && (
                        <span className="ml-1 text-ink-muted">@ {event.targetRole}</span>
                    )}
                </td>
                <td className="px-4 py-2.5 text-xs text-ink-secondary">
                    {event.workspaceId ? (
                        <a
                            href={`/workspaces/${event.workspaceId}`}
                            onClick={e => e.stopPropagation()}
                            className="font-mono text-[11px] hover:text-accent-lineage hover:underline"
                        >
                            {event.workspaceId}
                        </a>
                    ) : (
                        <span className="text-ink-muted">—</span>
                    )}
                </td>
            </tr>
            {expanded && (
                <tr className="border-t border-glass-border bg-glass-base/20">
                    <td colSpan={6} className="px-4 py-3">
                        <pre className="text-2xs font-mono text-ink-secondary whitespace-pre-wrap break-words">
                            {JSON.stringify(event.payload, null, 2)}
                        </pre>
                    </td>
                </tr>
            )}
        </>
    )
}
