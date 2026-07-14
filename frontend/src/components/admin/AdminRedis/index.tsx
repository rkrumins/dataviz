/**
 * AdminRedis — read-only diagnostics for the two Redis roles the platform
 * depends on: the streams/coordination bus and the cache. Each role is
 * resolved independently (separate connection, separate credentials,
 * separate TLS material), so this page shows them as two independent
 * endpoints rather than one "Redis" blob.
 *
 * Every field carries its provenance (which env var, file, or per-provider
 * override produced it) so an operator can trace a bad value back to its
 * source. The API never returns a password value — only where the
 * password came from — so this page has nothing secret to leak.
 */
import { useEffect, useState } from 'react'
import {
    AlertTriangle, CheckCircle2, Database, ExternalLink, HelpCircle, KeyRound,
    Loader2, Lock, Radio, ShieldCheck, XCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import {
    fetchRedisConfig, testRedisRole,
    type RedisConfigResponse, type RedisRole, type RedisRoleConfig, type RedisTestResult,
} from '@/services/redisConfigService'

type CardStatus = 'healthy' | 'degraded' | 'down' | 'not-configured'

const STATUS_META: Record<CardStatus, { dot: string; chip: string; icon: typeof CheckCircle2; label: string }> = {
    healthy: {
        dot: 'bg-emerald-500',
        chip: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
        icon: CheckCircle2,
        label: 'Healthy',
    },
    degraded: {
        dot: 'bg-amber-400',
        chip: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
        icon: AlertTriangle,
        label: 'Degraded',
    },
    down: {
        dot: 'bg-red-500',
        chip: 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400',
        icon: XCircle,
        label: 'Down',
    },
    'not-configured': {
        dot: 'bg-slate-300 dark:bg-slate-600',
        chip: 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-muted',
        icon: HelpCircle,
        label: 'Not configured',
    },
}

const ROLE_LABEL: Record<RedisRole, string> = {
    streams: 'Streams (coordination) endpoint',
    cache: 'Cache endpoint',
}

const ROLE_ICON: Record<RedisRole, typeof Radio> = {
    streams: Radio,
    cache: Database,
}

function statusFor(role: RedisRoleConfig): CardStatus {
    if (role.configured === false) return 'not-configured'
    if (role.error) return 'down'
    if (role.tls?.enabled && role.tls.filesReadable === false) return 'degraded'
    return 'healthy'
}

/** One resolved field + where it came from — the provenance chip is the point of this page. */
function FieldRow({ label, value, source }: { label: string; value: React.ReactNode; source?: string | null }) {
    return (
        <div className="flex items-center justify-between gap-3 py-1">
            <span className="text-[11px] text-ink-muted shrink-0">{label}</span>
            <span className="text-xs text-ink font-mono text-right min-w-0 truncate">
                {value}
                {source && <span className="ml-1.5 text-ink-muted/70 font-sans">· {source}</span>}
            </span>
        </div>
    )
}

function TlsRow({ tls }: { tls?: RedisRoleConfig['tls'] }) {
    if (!tls || !tls.enabled) {
        return <FieldRow label="TLS" value="Off" />
    }
    const unreadable = tls.filesReadable === false
    return (
        <div className="py-1">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-ink-muted shrink-0">TLS</span>
                <span className="text-xs text-ink font-mono text-right flex items-center gap-1 justify-end">
                    <Lock className="w-3 h-3 shrink-0" />
                    {tls.mutual ? 'On (mutual)' : 'On'}
                </span>
            </div>
            {(tls.caCertPath || tls.certPath || tls.keyPath) && (
                <div className="mt-1 space-y-0.5">
                    {tls.caCertPath && <FieldRow label="CA cert" value={tls.caCertPath} />}
                    {tls.certPath && <FieldRow label="Client cert" value={tls.certPath} />}
                    {tls.keyPath && <FieldRow label="Client key" value={tls.keyPath} />}
                </div>
            )}
            {unreadable && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] text-red-600 dark:text-red-400 leading-snug">
                        Cert files not readable by this process — check the Secret mount.
                    </p>
                </div>
            )}
        </div>
    )
}

function TestConnection({ role }: { role: RedisRole }) {
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<RedisTestResult | null>(null)
    const [failure, setFailure] = useState<string | null>(null)

    const run = async () => {
        setLoading(true)
        setFailure(null)
        setResult(null)
        try {
            const res = await testRedisRole(role)
            setResult(res)
        } catch (err) {
            setFailure(err instanceof Error ? err.message : String(err))
        } finally {
            setLoading(false)
        }
    }

    return (
        <div className="mt-3 pt-3 border-t border-glass-border">
            <button
                onClick={run}
                disabled={loading}
                className="px-3 py-1.5 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-lg font-medium text-xs text-ink transition-colors flex items-center gap-1.5 disabled:opacity-60"
            >
                {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                Test connection
            </button>
            {result?.ok && (
                <p className="mt-2 text-[11px] text-emerald-600 dark:text-emerald-400">
                    Connected{result.latencyMs != null ? ` · ${result.latencyMs}ms` : ''}
                </p>
            )}
            {result && !result.ok && (
                <p className="mt-2 text-[11px] font-mono text-red-600 dark:text-red-400 break-all">
                    {result.error ?? 'Connection failed'}
                </p>
            )}
            {failure && (
                <p className="mt-2 text-[11px] font-mono text-red-600 dark:text-red-400 break-all">{failure}</p>
            )}
        </div>
    )
}

function RoleCard({ role }: { role: RedisRoleConfig }) {
    const status = statusFor(role)
    const meta = STATUS_META[status]
    const StatusIcon = meta.icon
    const RoleIcon = ROLE_ICON[role.role]
    const source = role.source ?? {}
    const sentinelNodes = role.sentinelNodes ?? []

    return (
        <div className={cn(
            'border rounded-xl p-4 bg-canvas-elevated',
            status === 'down' ? 'border-red-500/30' : status === 'degraded' ? 'border-amber-500/30' : 'border-glass-border',
        )}>
            <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                    <RoleIcon className="w-4 h-4 text-indigo-500 shrink-0" />
                    <span className="text-sm font-semibold text-ink truncate">{ROLE_LABEL[role.role]}</span>
                </div>
                <div className={cn('inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px] font-semibold uppercase tracking-wide shrink-0', meta.chip)}>
                    <StatusIcon className="w-3 h-3" />
                    {meta.label}
                </div>
            </div>

            {role.error ? (
                <div className="mt-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-2">
                    <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0 mt-0.5" />
                    <p className="text-[11px] font-mono text-red-600 dark:text-red-400 break-all">{role.error}</p>
                </div>
            ) : (
                <div className="mt-3 space-y-0.5">
                    {role.mode && <FieldRow label="Mode" value={role.mode} source={source.mode} />}
                    {role.host != null && role.port != null && (
                        <FieldRow label="Endpoint" value={`${role.host}:${role.port}`} source={source.host ?? source.port} />
                    )}
                    {role.db != null && <FieldRow label="DB" value={role.db} source={source.db} />}
                    {role.sentinelMaster && <FieldRow label="Sentinel master" value={role.sentinelMaster} source={source.sentinelMaster} />}
                    {sentinelNodes.length > 0 && <FieldRow label="Sentinel nodes" value={sentinelNodes.join(', ')} />}

                    <div className="pt-1.5 mt-1.5 border-t border-glass-border/60 space-y-0.5">
                        <FieldRow label="Username" value={role.username || '—'} source={source.username} />
                        <FieldRow
                            label="Password"
                            value={role.hasPassword ? '••••' : 'Not set'}
                            source={role.hasPassword ? role.passwordSource : undefined}
                        />
                    </div>

                    <div className="pt-1.5 mt-1.5 border-t border-glass-border/60">
                        <TlsRow tls={role.tls} />
                    </div>
                </div>
            )}

            {role.role === 'cache' && (
                <CacheExtras role={role} />
            )}

            <TestConnection role={role.role} />
        </div>
    )
}

function CacheExtras({ role }: { role: RedisRoleConfig }) {
    const overrides = role.providerOverrides ?? []
    const legacy = role.legacyProviders ?? []
    if (overrides.length === 0 && legacy.length === 0) return null

    return (
        <div className="mt-3 pt-3 border-t border-glass-border space-y-2.5">
            {overrides.length > 0 && (
                <div>
                    <p className="text-[11px] text-ink-muted mb-1">
                        {overrides.length} provider{overrides.length === 1 ? '' : 's'} override this endpoint
                    </p>
                    <div className="space-y-1">
                        {overrides.map(p => (
                            <a
                                key={p.providerId}
                                href="/ingestion?tab=providers"
                                className="flex items-center gap-1.5 text-xs text-indigo-600 dark:text-indigo-400 hover:underline"
                            >
                                <ExternalLink className="w-3 h-3 shrink-0" />
                                <span className="truncate">{p.name}</span>
                                {p.host && <span className="text-ink-muted font-mono">→ {p.host}</span>}
                            </a>
                        ))}
                    </div>
                </div>
            )}
            {legacy.length > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-2.5 py-2">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-500 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                            Still using the legacy cache URL — migrate to a per-provider override:
                        </p>
                        <p className="text-[11px] text-ink-secondary mt-0.5 truncate">
                            {legacy.map(p => p.name).join(', ')}
                        </p>
                    </div>
                </div>
            )}
        </div>
    )
}

function DeprecationNotice({ deprecations }: { deprecations: RedisConfigResponse['deprecations'] }) {
    const notes: string[] = []
    if (deprecations.REDIS_URL) notes.push('REDIS_URL is set and deprecated — use the REDIS_STREAMS_* variables instead.')
    if (deprecations.CACHE_REDIS_URL) notes.push('CACHE_REDIS_URL is set and deprecated — use the REDIS_CACHE_* variables instead.')
    if (deprecations.providersOnLegacyCacheUrl > 0) {
        notes.push(`${deprecations.providersOnLegacyCacheUrl} provider${deprecations.providersOnLegacyCacheUrl === 1 ? ' is' : 's are'} still resolving cache config from the legacy CACHE_REDIS_URL.`)
    }
    if (notes.length === 0) return null

    return (
        <div className="border border-amber-500/30 bg-amber-500/5 rounded-xl p-4 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="space-y-1">
                <p className="text-sm font-semibold text-ink">Deprecated configuration in use</p>
                {notes.map(n => (
                    <p key={n} className="text-xs text-ink-muted">{n}</p>
                ))}
            </div>
        </div>
    )
}

function Skeleton() {
    return (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 animate-pulse">
            <div className="h-64 rounded-xl bg-black/5 dark:bg-white/10" />
            <div className="h-64 rounded-xl bg-black/5 dark:bg-white/10" />
        </div>
    )
}

export function AdminRedis() {
    const [data, setData] = useState<RedisConfigResponse | null>(null)
    const [error, setError] = useState<Error | null>(null)
    const [isLoading, setIsLoading] = useState(true)

    useEffect(() => {
        let cancelled = false
        setIsLoading(true)
        fetchRedisConfig()
            .then(res => { if (!cancelled) setData(res) })
            .catch(err => { if (!cancelled) setError(err instanceof Error ? err : new Error(String(err))) })
            .finally(() => { if (!cancelled) setIsLoading(false) })
        return () => { cancelled = true }
    }, [])

    return (
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
            <div className="flex items-center gap-3 mb-8">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
                    <KeyRound className="w-6 h-6 text-white" />
                </div>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight text-ink">Redis</h1>
                    <p className="text-sm text-ink-muted mt-1">
                        Resolved connection settings for the cache and coordination endpoints — where every value came from, and whether it's reachable.
                    </p>
                </div>
            </div>

            {isLoading ? (
                <Skeleton />
            ) : error && !data ? (
                <div className="border border-red-500/30 bg-red-500/5 rounded-xl p-6 flex items-center gap-3">
                    <XCircle className="w-6 h-6 text-red-500 shrink-0" />
                    <div>
                        <p className="text-sm font-semibold text-ink">Could not load the Redis configuration</p>
                        <p className="text-xs text-ink-muted mt-0.5 font-mono">{error.message}</p>
                    </div>
                </div>
            ) : data ? (
                <div className="space-y-6">
                    <DeprecationNotice deprecations={data.deprecations} />
                    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                        {data.roles.map(role => <RoleCard key={role.role} role={role} />)}
                    </div>
                </div>
            ) : null}
        </PageContainer>
    )
}
