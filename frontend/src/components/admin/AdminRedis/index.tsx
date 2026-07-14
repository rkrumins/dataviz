/**
 * AdminRedis — the operator's control room for the two Redis endpoints the
 * platform depends on: the STREAMS (coordination) bus and the CACHE.
 *
 * This is a read-only console by design. The endpoints are deploy-managed
 * (environment variables + mounted secret/cert files), so infrastructure
 * config stays in GitOps and nobody can take down the job bus from a browser.
 * The page's job is to make that resolved config legible: what each endpoint
 * is, why it matters, where every value came from, whether it's reachable,
 * and — for the cache — exactly which providers it affects.
 *
 * The config API never returns a password value, only where each field
 * (including the password) was resolved *from*, so there is nothing secret
 * to render here.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'
import {
    AlertTriangle, ArrowRight, Boxes, Check, CheckCircle2, ChevronDown, Copy,
    Database, ExternalLink, FileKey, Gauge, KeyRound, Layers, Loader2, Lock,
    Network, Radio, RefreshCw, ShieldCheck, ShieldOff, Sparkles, TerminalSquare,
    Workflow, XCircle, Zap,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { PageContainer } from '@/components/layout/PageContainer'
import {
    fetchRedisConfig, testRedisRole,
    type RedisConfigResponse, type RedisRole, type RedisRoleConfig, type RedisTestResult,
} from '@/services/redisConfigService'

// ─────────────────────────────────────────────────────────────────────────
// Domain knowledge — what each endpoint is, why it matters, how it's wired.
// Kept in one place so the copy reads like a briefing, not scattered labels.
// ─────────────────────────────────────────────────────────────────────────

type Tint = 'sky' | 'violet'

interface RoleContent {
    label: string
    tagline: string
    icon: ComponentType<{ className?: string }>
    tint: Tint
    carries: string
    whenDown: { headline: string; detail: string; severity: 'contained' | 'serious' }
    usedBy: string[]
    /** Env-var reference, grouped. Each row: the variable + what it sets. */
    envGroups: { title: string; icon: ComponentType<{ className?: string }>; vars: [string, string][] }[]
    legacyNote: string
}

const ROLE_CONTENT: Record<RedisRole, RoleContent> = {
    streams: {
        label: 'Streams · coordination bus',
        tagline: 'The backbone every background job and cross-replica signal flows through.',
        icon: Radio,
        tint: 'sky',
        carries:
            'Job-dispatch streams and consumer groups (aggregation, versioning), single-active ' +
            'execution locks, cancel pub/sub, the admission rate-limiter, and token-revocation lookups.',
        whenDown: {
            severity: 'serious',
            headline: 'Background work stops; auth stays up.',
            detail:
                'New jobs stop dispatching and workers can’t claim or acknowledge work, so aggregation ' +
                'and versioning stall. Token revocation fails open — sign-ins keep working, but revocations ' +
                'aren’t enforced across replicas until the bus recovers.',
        },
        usedBy: ['Web API', 'Aggregation worker', 'Aggregation control plane', 'Versioning worker', 'Insights / stats'],
        envGroups: [
            {
                title: 'Endpoint', icon: Network, vars: [
                    ['REDIS_STREAMS_HOST', 'hostname'],
                    ['REDIS_STREAMS_PORT', 'port (default 6380)'],
                    ['REDIS_STREAMS_DB', 'database index'],
                    ['REDIS_STREAMS_MODE', 'standalone | sentinel'],
                ],
            },
            {
                title: 'Authentication', icon: KeyRound, vars: [
                    ['REDIS_STREAMS_USERNAME', 'ACL user'],
                    ['REDIS_STREAMS_PASSWORD', 'password (or use the file form)'],
                    ['REDIS_STREAMS_PASSWORD_FILE', 'mounted secret file — re-read on reconnect'],
                ],
            },
            {
                title: 'TLS / mutual TLS', icon: Lock, vars: [
                    ['REDIS_STREAMS_TLS_ENABLED', 'true to require TLS'],
                    ['REDIS_STREAMS_TLS_CA_CERTS', 'CA bundle path'],
                    ['REDIS_STREAMS_TLS_CERTFILE', 'client cert path (mTLS)'],
                    ['REDIS_STREAMS_TLS_KEYFILE', 'client key path (mTLS)'],
                ],
            },
        ],
        legacyNote: 'Legacy alias: REDIS_URL (+ REDIS_PASSWORD / REDIS_TLS_*) still works and maps here.',
    },
    cache: {
        label: 'Cache · provider read accelerator',
        tagline: 'Stores what providers compute so repeat graph reads are instant.',
        icon: Database,
        tint: 'violet',
        carries:
            'Per-provider ancestor chains, URN→label maps, materialize in-flight flags, and cached ' +
            'schema stats. Every provider that reads a graph reads through here first.',
        whenDown: {
            severity: 'contained',
            headline: 'Reads get slower; nothing breaks.',
            detail:
                'The cache is never on the critical path. If it’s unreachable, values are recomputed on ' +
                'the fly — reads are slower, but the application keeps working. A cache outage can’t take ' +
                'down a request.',
        },
        usedBy: ['Web API', 'Aggregation worker', 'Versioning worker', 'Every provider read path'],
        envGroups: [
            {
                title: 'Endpoint', icon: Network, vars: [
                    ['REDIS_CACHE_HOST', 'hostname'],
                    ['REDIS_CACHE_PORT', 'port (default 6379)'],
                    ['REDIS_CACHE_DB', 'database index'],
                    ['REDIS_CACHE_MODE', 'standalone | sentinel'],
                ],
            },
            {
                title: 'Authentication', icon: KeyRound, vars: [
                    ['REDIS_CACHE_USERNAME', 'ACL user'],
                    ['REDIS_CACHE_PASSWORD', 'password (or use the file form)'],
                    ['REDIS_CACHE_PASSWORD_FILE', 'mounted secret file — re-read on reconnect'],
                ],
            },
            {
                title: 'TLS / mutual TLS', icon: Lock, vars: [
                    ['REDIS_CACHE_TLS_ENABLED', 'true to require TLS'],
                    ['REDIS_CACHE_TLS_CA_CERTS', 'CA bundle path'],
                    ['REDIS_CACHE_TLS_CERTFILE', 'client cert path (mTLS)'],
                    ['REDIS_CACHE_TLS_KEYFILE', 'client key path (mTLS)'],
                ],
            },
        ],
        legacyNote: 'Legacy alias: CACHE_REDIS_URL still works and maps here. Per provider, a dedicated cache overrides this default.',
    },
}

const TINT: Record<Tint, { text: string; tile: string; ring: string; soft: string }> = {
    sky: {
        text: 'text-sky-600 dark:text-sky-400',
        tile: 'from-sky-500 to-cyan-600 shadow-sky-500/20',
        ring: 'border-sky-500/20',
        soft: 'bg-sky-500/5',
    },
    violet: {
        text: 'text-violet-600 dark:text-violet-400',
        tile: 'from-violet-500 to-indigo-600 shadow-violet-500/20',
        ring: 'border-violet-500/20',
        soft: 'bg-violet-500/5',
    },
}

// ── status ───────────────────────────────────────────────────────────────

type CardStatus = 'healthy' | 'degraded' | 'down' | 'not-configured'

const STATUS_META: Record<CardStatus, {
    dot: string; chip: string; icon: ComponentType<{ className?: string }>; label: string; blurb: string
}> = {
    healthy: {
        dot: 'bg-emerald-500',
        chip: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
        icon: CheckCircle2, label: 'Healthy', blurb: 'Resolved and reachable.',
    },
    degraded: {
        dot: 'bg-amber-400',
        chip: 'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
        icon: AlertTriangle, label: 'Degraded', blurb: 'Configured, but something needs attention.',
    },
    down: {
        dot: 'bg-red-500',
        chip: 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400',
        icon: XCircle, label: 'Misconfigured', blurb: 'The endpoint could not be resolved.',
    },
    'not-configured': {
        dot: 'bg-slate-300 dark:bg-slate-600',
        chip: 'bg-black/5 dark:bg-white/5 border-glass-border text-ink-muted',
        icon: ShieldOff, label: 'Not configured', blurb: 'No endpoint is set for this role.',
    },
}

function statusFor(role: RedisRoleConfig): CardStatus {
    if (role.error) return 'down'
    if (role.configured === false) return 'not-configured'
    if (role.tls?.enabled && role.tls.filesReadable === false) return 'degraded'
    return 'healthy'
}

// ─────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
    return (
        <p className={cn('text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-muted', className)}>
            {children}
        </p>
    )
}

/** A subtle chip showing where a resolved value came from. The heart of this page. */
function Provenance({ source }: { source?: string | null }) {
    if (!source) return null
    return (
        <span className="inline-flex items-center rounded-md bg-black/[0.04] dark:bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">
            {source}
        </span>
    )
}

/** One resolved field: label · value · where it came from. */
function FieldRow({ label, value, source, mono = true }: {
    label: string; value: ReactNode; source?: string | null; mono?: boolean
}) {
    return (
        <div className="flex items-baseline justify-between gap-3 py-[3px]">
            <span className="shrink-0 text-[11px] text-ink-muted">{label}</span>
            <span className="flex min-w-0 items-center justify-end gap-2 text-right">
                <span className={cn('truncate text-xs text-ink', mono && 'font-mono')}>{value}</span>
                <Provenance source={source} />
            </span>
        </div>
    )
}

function CopyVar({ name }: { name: string }) {
    const [copied, setCopied] = useState(false)
    const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
    useEffect(() => () => clearTimeout(timer.current), [])
    const copy = async () => {
        try {
            await navigator.clipboard?.writeText(name)
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 1400)
        } catch { /* clipboard unavailable — no-op */ }
    }
    return (
        <button
            type="button" onClick={copy}
            className="group/copy inline-flex items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-[11px] text-ink-secondary transition-colors hover:bg-black/5 hover:text-ink dark:hover:bg-white/5"
            aria-label={`Copy ${name}`}
        >
            {copied
                ? <Check className="h-3 w-3 text-emerald-500" />
                : <Copy className="h-3 w-3 opacity-0 transition-opacity group-hover/copy:opacity-100" />}
            {name}
        </button>
    )
}

/** A titled, collapsible drawer. Used for the config reference so the card
 *  stays scannable but the full detail is one click away. */
function Disclosure({ label, icon: Icon, children, defaultOpen = false }: {
    label: string; icon: ComponentType<{ className?: string }>; children: ReactNode; defaultOpen?: boolean
}) {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <div className="rounded-lg border border-glass-border">
            <button
                type="button" onClick={() => setOpen(o => !o)}
                className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.03]"
                aria-expanded={open}
            >
                <Icon className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                <span className="flex-1 text-xs font-medium text-ink-secondary">{label}</span>
                <ChevronDown className={cn('h-3.5 w-3.5 text-ink-muted transition-transform duration-200', open && 'rotate-180')} />
            </button>
            <div className={cn('grid transition-all duration-200 ease-in-out', open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]')}>
                <div className="overflow-hidden">
                    <div className="border-t border-glass-border/70 px-3 py-3">{children}</div>
                </div>
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────
// TLS
// ─────────────────────────────────────────────────────────────────────────

function TlsBlock({ tls }: { tls?: RedisRoleConfig['tls'] }) {
    if (!tls || !tls.enabled) {
        return (
            <FieldRow
                label="Transport"
                mono={false}
                value={<span className="inline-flex items-center gap-1 text-ink-muted"><ShieldOff className="h-3 w-3" /> Plaintext</span>}
            />
        )
    }
    const unreadable = tls.filesReadable === false
    return (
        <div className="py-[3px]">
            <div className="flex items-center justify-between gap-3">
                <span className="text-[11px] text-ink-muted">Transport</span>
                <span className="inline-flex items-center gap-1 text-xs text-ink">
                    <Lock className="h-3 w-3" />
                    {tls.mutual ? 'TLS · mutual' : 'TLS'}
                    {tls.verifyMode && <span className="text-ink-muted">· verify {tls.verifyMode}</span>}
                </span>
            </div>
            {(tls.caCertPath || tls.certPath || tls.keyPath) && (
                <div className="mt-1.5 space-y-0.5 border-l border-glass-border pl-2.5">
                    {tls.caCertPath && <FieldRow label="CA bundle" value={tls.caCertPath} />}
                    {tls.certPath && <FieldRow label="Client cert" value={tls.certPath} />}
                    {tls.keyPath && <FieldRow label="Client key" value={tls.keyPath} />}
                </div>
            )}
            {unreadable && (
                <div className="mt-2 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-2.5 py-2">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-500" />
                    <p className="text-[11px] leading-snug text-red-600 dark:text-red-400">
                        <span className="font-semibold">Cert files aren’t readable by this process.</span> TLS is
                        required but the CA/cert/key can’t be opened — the Secret is likely mounted into the wrong
                        container or path. Connections to this endpoint will fail until it’s fixed.
                    </p>
                </div>
            )}
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────
// Test connection
// ─────────────────────────────────────────────────────────────────────────

function TestConnection({ role }: { role: RedisRole }) {
    const [loading, setLoading] = useState(false)
    const [result, setResult] = useState<RedisTestResult | null>(null)
    const [failure, setFailure] = useState<string | null>(null)

    const run = async () => {
        setLoading(true); setFailure(null); setResult(null)
        try { setResult(await testRedisRole(role)) }
        catch (err) { setFailure(err instanceof Error ? err.message : String(err)) }
        finally { setLoading(false) }
    }

    return (
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-glass-border pt-4">
            <button
                type="button" onClick={run} disabled={loading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-glass-border bg-canvas px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/5"
            >
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                Test connection
            </button>
            <span className="text-[11px] text-ink-muted">Opens a live PING + INFO to confirm auth &amp; TLS.</span>
            {result?.ok && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Connected{result.latencyMs != null ? ` · ${result.latencyMs} ms` : ''}
                </span>
            )}
            {result && !result.ok && (
                <span className="inline-flex items-start gap-1 font-mono text-[11px] text-red-600 dark:text-red-400">
                    <XCircle className="mt-px h-3.5 w-3.5 shrink-0" /> <span className="break-all">{result.error ?? 'Connection failed'}</span>
                </span>
            )}
            {failure && (
                <span className="break-all font-mono text-[11px] text-red-600 dark:text-red-400">{failure}</span>
            )}
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────
// Role card — a full briefing per endpoint
// ─────────────────────────────────────────────────────────────────────────

function RoleCard({ role, index }: { role: RedisRoleConfig; index: number }) {
    const content = ROLE_CONTENT[role.role]
    const status = statusFor(role)
    const meta = STATUS_META[status]
    const tint = TINT[content.tint]
    const RoleIcon = content.icon
    const StatusIcon = meta.icon
    const source = role.source ?? {}
    const sentinelNodes = role.sentinelNodes ?? []
    const endpoint = role.host != null && role.port != null ? `${role.host}:${role.port}` : null

    return (
        <section
            className={cn(
                'flex flex-col rounded-2xl border bg-canvas-elevated p-5 opacity-0 [animation-fill-mode:forwards]',
                'animate-in fade-in slide-in-from-bottom-2 duration-500',
                status === 'down' ? 'border-red-500/30' : status === 'degraded' ? 'border-amber-500/30' : 'border-glass-border',
            )}
            style={{ animationDelay: `${120 + index * 90}ms` }}
        >
            {/* header */}
            <div className="flex items-start gap-3">
                <div className={cn('flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-lg', tint.tile)}>
                    <RoleIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="truncate text-[15px] font-bold text-ink">{content.label}</h2>
                        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide', meta.chip)}>
                            <StatusIcon className="h-3 w-3" /> {meta.label}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-snug text-ink-muted">{content.tagline}</p>
                </div>
            </div>

            {/* what it carries */}
            <p className="mt-4 text-xs leading-relaxed text-ink-secondary">
                <span className={cn('font-semibold', tint.text)}>Carries — </span>{content.carries}
            </p>

            {/* if it goes down */}
            <div className={cn(
                'mt-3 rounded-lg border px-3 py-2.5',
                content.whenDown.severity === 'serious'
                    ? 'border-amber-500/25 bg-amber-500/[0.06]'
                    : 'border-glass-border bg-black/[0.02] dark:bg-white/[0.02]',
            )}>
                <div className="flex items-center gap-1.5">
                    {content.whenDown.severity === 'serious'
                        ? <Zap className="h-3.5 w-3.5 text-amber-500" />
                        : <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />}
                    <span className="text-[11px] font-semibold text-ink">If this endpoint is down — {content.whenDown.headline}</span>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-ink-muted">{content.whenDown.detail}</p>
            </div>

            {/* resolved connection */}
            <div className="mt-4">
                <Eyebrow className="mb-2">Resolved connection</Eyebrow>
                {role.error ? (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3 py-2.5">
                        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                        <div className="min-w-0">
                            <p className="text-[11px] font-semibold text-ink">This endpoint could not be resolved</p>
                            <p className="mt-0.5 break-all font-mono text-[11px] text-red-600 dark:text-red-400">{role.error}</p>
                        </div>
                    </div>
                ) : (
                    <div className="rounded-lg border border-glass-border bg-canvas/60 px-3 py-2">
                        {endpoint && <FieldRow label="Endpoint" value={endpoint} source={source.host ?? source.port} />}
                        {role.mode && <FieldRow label="Mode" value={role.mode} source={source.mode} mono={false} />}
                        {role.db != null && <FieldRow label="Database" value={role.db} source={source.db} />}
                        {role.sentinelMaster && <FieldRow label="Sentinel master" value={role.sentinelMaster} source={source.sentinelMaster} />}
                        {sentinelNodes.length > 0 && <FieldRow label="Sentinel nodes" value={sentinelNodes.join(', ')} />}
                        <div className="my-1 border-t border-glass-border/60" />
                        <FieldRow label="Username" value={role.username || <span className="text-ink-muted">none</span>} source={source.username} />
                        <FieldRow
                            label="Password"
                            mono={false}
                            value={role.hasPassword
                                ? <span className="inline-flex items-center gap-1"><FileKey className="h-3 w-3 text-ink-muted" /><span className="font-mono tracking-tight">••••••••</span></span>
                                : <span className="text-ink-muted">none</span>}
                            source={role.hasPassword ? role.passwordSource : undefined}
                        />
                        <div className="my-1 border-t border-glass-border/60" />
                        <TlsBlock tls={role.tls} />
                    </div>
                )}
            </div>

            {role.role === 'cache' && <CacheUsageStrip role={role} />}

            {/* configuration reference */}
            <div className="mt-4">
                <Disclosure label="How to configure this endpoint" icon={TerminalSquare}>
                    <p className="mb-3 text-[11px] leading-relaxed text-ink-muted">
                        Set these in your deployment (environment variables + mounted secret/cert files), then roll out
                        the affected services. Prefer the <span className="font-mono text-ink-secondary">…_PASSWORD_FILE</span> form
                        for secrets — it’s re-read on reconnect, so rotation doesn’t need a full restart.
                    </p>
                    <div className="space-y-3">
                        {content.envGroups.map(group => {
                            const GroupIcon = group.icon
                            return (
                                <div key={group.title}>
                                    <div className="mb-1 flex items-center gap-1.5">
                                        <GroupIcon className="h-3 w-3 text-ink-muted" />
                                        <Eyebrow>{group.title}</Eyebrow>
                                    </div>
                                    <div className="space-y-0.5">
                                        {group.vars.map(([name, desc]) => (
                                            <div key={name} className="flex items-baseline justify-between gap-3">
                                                <CopyVar name={name} />
                                                <span className="shrink-0 text-right text-[11px] text-ink-muted">{desc}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    <p className="mt-3 border-t border-glass-border/70 pt-2 text-[11px] text-ink-muted">{content.legacyNote}</p>
                    <div className="mt-3 rounded-lg border border-glass-border bg-black/[0.02] px-3 py-2 dark:bg-white/[0.02]">
                        <Eyebrow className="mb-1.5">Affected services on change</Eyebrow>
                        <div className="flex flex-wrap gap-1.5">
                            {content.usedBy.map(svc => (
                                <span key={svc} className="rounded-md bg-black/5 px-1.5 py-0.5 text-[10px] font-medium text-ink-secondary dark:bg-white/5">{svc}</span>
                            ))}
                        </div>
                    </div>
                </Disclosure>
            </div>

            <div className="flex-1" />
            <TestConnection role={role.role} />
        </section>
    )
}

/** Compact "who uses this cache" summary shown on the cache card, with a jump
 *  to the full provider-impact section below. */
function CacheUsageStrip({ role }: { role: RedisRoleConfig }) {
    const overrides = role.providerOverrides ?? []
    const legacy = role.legacyProviders ?? []
    if (overrides.length === 0 && legacy.length === 0) {
        return (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-glass-border bg-black/[0.02] px-3 py-2 dark:bg-white/[0.02]">
                <Boxes className="h-3.5 w-3.5 text-ink-muted" />
                <p className="text-[11px] text-ink-muted">Every provider uses this shared cache — none have a dedicated override yet.</p>
            </div>
        )
    }
    return (
        <a href="#provider-impact" className="group mt-3 flex items-center gap-2 rounded-lg border border-violet-500/20 bg-violet-500/[0.04] px-3 py-2 transition-colors hover:bg-violet-500/[0.08]">
            <Boxes className="h-3.5 w-3.5 shrink-0 text-violet-500" />
            <p className="flex-1 text-[11px] text-ink-secondary">
                {overrides.length > 0 && <><span className="font-semibold text-ink">{overrides.length}</span> provider{overrides.length === 1 ? '' : 's'} override this cache</>}
                {overrides.length > 0 && legacy.length > 0 && ' · '}
                {legacy.length > 0 && <><span className="font-semibold text-amber-600 dark:text-amber-400">{legacy.length}</span> on the legacy URL</>}
            </p>
            <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-violet-600 opacity-0 transition-opacity group-hover:opacity-100 dark:text-violet-400">
                Details <ArrowRight className="h-3 w-3" />
            </span>
        </a>
    )
}

// ─────────────────────────────────────────────────────────────────────────
// Provider impact — the user-facing "so what does this do to my providers?"
// ─────────────────────────────────────────────────────────────────────────

function ProviderImpact({ cache }: { cache?: RedisRoleConfig }) {
    const overrides = cache?.providerOverrides ?? []
    const legacy = cache?.legacyProviders ?? []
    const globalEndpoint = cache && cache.host != null && cache.port != null ? `${cache.host}:${cache.port}` : null

    return (
        <section id="provider-impact" className="scroll-mt-8 rounded-2xl border border-glass-border bg-canvas-elevated p-5">
            <div className="flex items-center gap-2">
                <Layers className="h-4 w-4 text-violet-500" />
                <h2 className="text-sm font-bold text-ink">Impact on providers</h2>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-ink-muted">
                Only the <span className="font-medium text-ink-secondary">cache</span> endpoint touches providers — the streams
                bus is fleet-wide and never provider-specific. Each provider gets its cache one of two ways:
            </p>

            {/* two paths */}
            <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="rounded-xl border border-glass-border p-4">
                    <div className="flex items-center gap-2">
                        <Database className="h-3.5 w-3.5 text-violet-500" />
                        <span className="text-xs font-semibold text-ink">Shared default</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
                        Any provider without its own cache uses this global endpoint
                        {globalEndpoint && <> — <span className="font-mono text-ink-secondary">{globalEndpoint}</span></>}.
                        Change it here and <span className="font-medium text-ink-secondary">every one of those providers moves with it</span>.
                    </p>
                </div>
                <div className="rounded-xl border border-glass-border p-4">
                    <div className="flex items-center gap-2">
                        <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />
                        <span className="text-xs font-semibold text-ink">Dedicated override</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
                        A provider can point at its own Redis — its own host, credentials and TLS — in the provider’s
                        connection settings. Those providers are <span className="font-medium text-ink-secondary">insulated</span> from
                        changes to the shared default.
                    </p>
                </div>
            </div>

            {/* overrides list */}
            {overrides.length > 0 && (
                <div className="mt-4">
                    <Eyebrow className="mb-2">Providers with a dedicated cache ({overrides.length})</Eyebrow>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        {overrides.map(p => (
                            <a key={p.providerId} href="/ingestion?tab=providers"
                                className="group flex items-center gap-2 rounded-lg border border-glass-border px-3 py-2 transition-colors hover:border-violet-500/30 hover:bg-violet-500/[0.04]">
                                <Network className="h-3.5 w-3.5 shrink-0 text-ink-muted" />
                                <span className="truncate text-xs font-medium text-ink">{p.name}</span>
                                {p.host && <span className="truncate font-mono text-[11px] text-ink-muted">→ {p.host}</span>}
                                <ExternalLink className="ml-auto h-3 w-3 shrink-0 text-ink-muted opacity-0 transition-opacity group-hover:opacity-100" />
                            </a>
                        ))}
                    </div>
                </div>
            )}

            {/* legacy migration */}
            {legacy.length > 0 && (
                <div className="mt-4 rounded-xl border border-amber-500/25 bg-amber-500/[0.06] p-4">
                    <div className="flex items-center gap-2">
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                        <span className="text-xs font-semibold text-ink">
                            {legacy.length} provider{legacy.length === 1 ? '' : 's'} still on the legacy cache URL
                        </span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">
                        These resolve their cache from a bare <span className="font-mono text-ink-secondary">CACHE_REDIS_URL</span> that
                        carries the password in the connection string. Move each to a structured dedicated cache in the
                        provider wizard — the password is then encrypted at rest and TLS is explicit, not inferred from the URL scheme.
                    </p>
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                        {legacy.map(p => (
                            <a key={p.providerId} href="/ingestion?tab=providers"
                                className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[11px] font-medium text-amber-700 transition-colors hover:bg-amber-500/10 dark:text-amber-300">
                                {p.name} <ArrowRight className="h-3 w-3" />
                            </a>
                        ))}
                    </div>
                </div>
            )}
        </section>
    )
}

// ─────────────────────────────────────────────────────────────────────────
// Mental-model band + how-to-apply + deprecations
// ─────────────────────────────────────────────────────────────────────────

const MODEL_FACTS: { icon: ComponentType<{ className?: string }>; title: string; body: ReactNode }[] = [
    {
        icon: Workflow, title: 'Two independent endpoints',
        body: <>Cache and streams are <span className="font-medium text-ink-secondary">separate Redis instances</span> — separate hosts, credentials and TLS. Neither shares anything with the other, or with FalkorDB.</>,
    },
    {
        icon: FileKey, title: 'Deploy-managed, read-only here',
        body: <>Config comes from environment variables and mounted secret files, so it stays in GitOps. This page shows what <span className="font-medium text-ink-secondary">resolved</span> and from where — it never stores a secret.</>,
    },
    {
        icon: RefreshCw, title: 'Change, roll out, then verify',
        body: <>Update the variable or secret in your deployment, restart the affected services, then use <span className="font-medium text-ink-secondary">Test connection</span> to confirm the new endpoint authenticates.</>,
    },
]

function MentalModel() {
    return (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {MODEL_FACTS.map((f, i) => {
                const Icon = f.icon
                return (
                    <div key={f.title}
                        className="rounded-xl border border-glass-border bg-canvas-elevated p-4 opacity-0 [animation-fill-mode:forwards] animate-in fade-in slide-in-from-bottom-2 duration-500"
                        style={{ animationDelay: `${i * 70}ms` }}>
                        <div className="flex items-center gap-2">
                            <Icon className="h-4 w-4 text-indigo-500" />
                            <span className="text-xs font-semibold text-ink">{f.title}</span>
                        </div>
                        <p className="mt-1.5 text-[11px] leading-relaxed text-ink-muted">{f.body}</p>
                    </div>
                )
            })}
        </div>
    )
}

function DeprecationNotice({ deprecations }: { deprecations: RedisConfigResponse['deprecations'] }) {
    const notes = useMemo(() => {
        const out: string[] = []
        if (deprecations.REDIS_URL) out.push('REDIS_URL is set — it still works, but migrate to the REDIS_STREAMS_* variables so the endpoint is explicit.')
        if (deprecations.CACHE_REDIS_URL) out.push('CACHE_REDIS_URL is set — it still works, but migrate to the REDIS_CACHE_* variables.')
        if (deprecations.providersOnLegacyCacheUrl > 0) {
            out.push(`${deprecations.providersOnLegacyCacheUrl} provider${deprecations.providersOnLegacyCacheUrl === 1 ? ' resolves' : 's resolve'} their cache from the legacy per-provider URL — see “Impact on providers” below.`)
        }
        return out
    }, [deprecations])
    if (notes.length === 0) return null

    return (
        <div className="flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
            <div className="space-y-1">
                <p className="text-sm font-semibold text-ink">Deprecated configuration in use</p>
                {notes.map(n => <p key={n} className="text-xs leading-relaxed text-ink-muted">{n}</p>)}
            </div>
        </div>
    )
}

function Skeleton() {
    return (
        <div className="space-y-6">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
                {[0, 1, 2].map(i => <div key={i} className="h-24 animate-pulse rounded-xl bg-black/5 dark:bg-white/10" />)}
            </div>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                {[0, 1].map(i => <div key={i} className="h-96 animate-pulse rounded-2xl bg-black/5 dark:bg-white/10" />)}
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────
// Page
// ─────────────────────────────────────────────────────────────────────────

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

    const cache = data?.roles.find(r => r.role === 'cache')
    const healthy = data?.roles.filter(r => statusFor(r) === 'healthy').length ?? 0
    const total = data?.roles.length ?? 0

    return (
        <PageContainer gutter="shell" className="py-8">
            {/* hero */}
            <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-3">
                    <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20">
                        <KeyRound className="h-6 w-6 text-white" />
                    </div>
                    <div>
                        <div className="flex items-center gap-2">
                            <h1 className="text-3xl font-bold tracking-tight text-ink">Redis</h1>
                            <span className="mt-1 inline-flex items-center gap-1 rounded-full border border-glass-border bg-canvas-elevated px-2 py-0.5 text-[10px] font-medium text-ink-muted">
                                <Sparkles className="h-3 w-3" /> Deploy-managed · read-only
                            </span>
                        </div>
                        <p className="mt-1 max-w-2xl text-sm leading-relaxed text-ink-muted">
                            The two Redis endpoints this platform runs on. See what each is for, where every value was
                            resolved from, whether it’s reachable, and exactly which providers it touches.
                        </p>
                    </div>
                </div>
                {data && (
                    <div className="flex items-center gap-2 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2">
                        <Gauge className={cn('h-4 w-4', healthy === total ? 'text-emerald-500' : 'text-amber-500')} />
                        <div className="leading-tight">
                            <p className="text-sm font-semibold text-ink">{healthy}/{total} healthy</p>
                            <p className="text-[10px] text-ink-muted">endpoints resolved</p>
                        </div>
                    </div>
                )}
            </div>

            {isLoading ? (
                <Skeleton />
            ) : error && !data ? (
                <div className="flex items-center gap-3 rounded-2xl border border-red-500/30 bg-red-500/5 p-6">
                    <XCircle className="h-6 w-6 shrink-0 text-red-500" />
                    <div>
                        <p className="text-sm font-semibold text-ink">Couldn’t load the Redis configuration</p>
                        <p className="mt-0.5 font-mono text-xs text-ink-muted">{error.message}</p>
                    </div>
                </div>
            ) : data ? (
                <div className="space-y-6">
                    <MentalModel />
                    <DeprecationNotice deprecations={data.deprecations} />
                    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                        {data.roles.map((role, i) => <RoleCard key={role.role} role={role} index={i} />)}
                    </div>
                    <ProviderImpact cache={cache} />
                </div>
            ) : null}
        </PageContainer>
    )
}
