/**
 * MyAccessPage — self-service "what can I do?" page.
 *
 * Renders the same access map shape as the admin "By user" lens
 * (``GET /admin/users/{user_id}/access``) but keyed off the caller's
 * own ``user_id`` via ``GET /me/access``. End users no longer have
 * to file a ticket or trigger a 403 to find out what they have
 * access to.
 *
 * Layout:
 *   * Hero — gradient icon + "My access" title
 *   * Plain-English summary banner — derived from the new
 *     ``permission.longDescription`` map (4.1) so the user sees
 *     "You can edit views in WS-Finance" rather than
 *     ``workspace:view:edit``.
 *   * AccessSummary — the same component the admin lens renders,
 *     in ``mode='self'`` so copy is second-person.
 */
import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
    Loader2, AlertCircle, Shield, RefreshCw, Sparkles, Clock,
    CheckCircle2, XCircle, Inbox,
} from 'lucide-react'
import {
    permissionsService,
    type PermissionResponse,
    type UserAccessResponse,
} from '@/services/permissionsService'
import {
    accessRequestsService,
    type AccessRequestResponse,
} from '@/services/accessRequestsService'
import { AccessSummary } from '@/components/access/AccessSummary'
import { useToast } from '@/components/ui/toast'
import { cn } from '@/lib/utils'


export function MyAccessPage() {
    const [access, setAccess] = useState<UserAccessResponse | null>(null)
    const [permissions, setPermissions] = useState<PermissionResponse[] | null>(null)
    const [requests, setRequests] = useState<AccessRequestResponse[] | null>(null)
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { showToast } = useToast()

    const load = async (silent = false) => {
        if (!silent) setLoading(true)
        setError(null)
        try {
            // Permission catalogue + my requests are best-effort —
            // used only for the summary banner / pending list. Their
            // failures don't block the page.
            const [accessRes, permsRes, reqsRes] = await Promise.allSettled([
                permissionsService.getMyAccess(),
                permissionsService.listPermissions(),
                accessRequestsService.listMine(),
            ])
            if (accessRes.status === 'rejected') {
                throw accessRes.reason instanceof Error
                    ? accessRes.reason
                    : new Error(String(accessRes.reason))
            }
            setAccess(accessRes.value)
            setPermissions(permsRes.status === 'fulfilled' ? permsRes.value : [])
            setRequests(reqsRes.status === 'fulfilled' ? reqsRes.value : [])
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load access'
            setError(message)
            if (silent) showToast('error', message)
        } finally {
            setLoading(false)
            setRefreshing(false)
        }
    }

    useEffect(() => {
        load()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const handleRefresh = () => {
        setRefreshing(true)
        load(true)
    }

    return (
        <div className="min-h-full bg-canvas">
            <div className="max-w-5xl mx-auto p-6 space-y-6">
                {/* Hero */}
                <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-md shrink-0">
                            <Shield className="w-6 h-6 text-white" />
                        </div>
                        <div className="min-w-0">
                            <h1 className="text-2xl font-bold text-ink">My access</h1>
                            <p className="text-sm text-ink-muted">
                                Everything you can do across the platform, and how you got that access.
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={handleRefresh}
                        disabled={loading || refreshing}
                        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-secondary hover:text-ink bg-glass-base/40 border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors shrink-0"
                        title="Refresh"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
                        Refresh
                    </button>
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
                            <p className="text-sm font-semibold text-red-600 dark:text-red-400">Couldn't load your access</p>
                            <p className="text-xs text-ink-muted mt-1">{error}</p>
                            <button
                                onClick={handleRefresh}
                                className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-canvas-elevated border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                            >
                                <RefreshCw className="w-3 h-3" />
                                Try again
                            </button>
                        </div>
                    </div>
                ) : access ? (
                    <>
                        <PlainEnglishSummary access={access} permissions={permissions ?? []} />
                        {requests && requests.length > 0 && (
                            <MyRequestsPanel requests={requests} />
                        )}
                        <div className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
                            <AccessSummary access={access} mode="self" hideHeader />
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    )
}


/**
 * Banner rendered above the full breakdown that paraphrases the
 * effective access map in plain English. Built client-side from the
 * permission long-descriptions surfaced by Phase 4.1.
 */
function PlainEnglishSummary({
    access, permissions,
}: {
    access: UserAccessResponse
    permissions: PermissionResponse[]
}) {
    const isAdmin = access.effectiveGlobal.includes('system:admin')
    const wsCount = Object.keys(access.effectiveWs).length

    // Index for quick description lookup (Phase 4.1's longDescription).
    const permDesc = useMemo(() => {
        const out: Record<string, PermissionResponse> = {}
        for (const p of permissions) out[p.id] = p
        return out
    }, [permissions])

    const wsHighlights = useMemo(() => {
        // Pick the top 3 most-permissive workspace bullets so the
        // banner stays readable. Sort descending by permission count.
        const entries = Object.entries(access.effectiveWs)
        entries.sort((a, b) => b[1].length - a[1].length)
        return entries.slice(0, 3)
    }, [access.effectiveWs])

    // Index of {ws_id → friendly name} pulled from the bindings the
    // backend already resolved. Lets the bullets show
    // "Finance — edit views" rather than "ws_finance_001 — edit views".
    const wsLabels = useMemo(() => {
        const out: Record<string, string> = {}
        for (const b of [...access.directBindings, ...access.inheritedBindings]) {
            if (b.scope.type === 'workspace' && b.scope.id && b.scope.label) {
                out[b.scope.id] = b.scope.label
            }
        }
        return out
    }, [access.directBindings, access.inheritedBindings])

    if (isAdmin) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/10 to-amber-500/0 p-4 flex items-start gap-3"
            >
                <div className="w-9 h-9 rounded-xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
                    <Shield className="w-4.5 h-4.5 text-amber-500" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-bold text-ink">You're a system administrator.</p>
                    <p className="text-xs text-ink-secondary mt-0.5">
                        The <code className="font-mono text-[11px] bg-amber-500/10 px-1 py-0.5 rounded">system:admin</code> permission grants you every other capability.
                        You can manage every workspace, change any user's role, and override every other permission check.
                    </p>
                </div>
            </motion.div>
        )
    }

    if (wsCount === 0 && access.effectiveGlobal.length === 0) {
        return (
            <motion.div
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="rounded-2xl border border-glass-border bg-glass-base/30 p-4 flex items-start gap-3"
            >
                <div className="w-9 h-9 rounded-xl bg-slate-500/10 border border-slate-500/20 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-slate-500" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-bold text-ink">You don't have any workspace access yet.</p>
                    <p className="text-xs text-ink-secondary mt-0.5">
                        Ask an administrator to add you to a workspace, or request access from a workspace's settings page.
                    </p>
                </div>
            </motion.div>
        )
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-emerald-500/0 p-4"
        >
            <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                    <Sparkles className="w-4 h-4 text-emerald-500" />
                </div>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-ink">
                        You have access to <span className="text-emerald-600 dark:text-emerald-400">{wsCount} workspace{wsCount !== 1 ? 's' : ''}</span>.
                    </p>
                    {wsHighlights.length > 0 && (
                        <ul className="mt-2 space-y-1.5">
                            {wsHighlights.map(([wsId, perms]) => {
                                const friendly = wsLabels[wsId]
                                return (
                                    <li key={wsId} className="text-xs text-ink-secondary flex items-start gap-1.5">
                                        <span className="text-emerald-500 shrink-0 mt-px">•</span>
                                        <span className="min-w-0">
                                            {friendly ? (
                                                <>
                                                    <span className="font-semibold text-ink">{friendly}</span>
                                                    <code className="font-mono text-ink-muted ml-1.5 text-[10px]">{wsId}</code>
                                                </>
                                            ) : (
                                                <code className="font-mono font-semibold text-ink">{wsId}</code>
                                            )}
                                            {' — '}
                                            {summariseCapabilities(perms, permDesc)}
                                        </span>
                                    </li>
                                )
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </motion.div>
    )
}


/** Convert a permission-id list into a comma-joined human sentence. */
function summariseCapabilities(
    perms: string[],
    permDesc: Record<string, PermissionResponse>,
): string {
    if (perms.length === 0) return 'no permissions'
    // Prefer the short description; fall back to the verb mid-sentence
    // that we infer from the id (``workspace:view:edit`` → "edit views").
    const phrases = perms.slice(0, 4).map(p => {
        const def = permDesc[p]
        if (def?.description) {
            // Lowercase first letter so it reads as a clause — most
            // descriptions are sentence-case and meant to stand alone.
            return def.description.charAt(0).toLowerCase() + def.description.slice(1).replace(/\.$/, '')
        }
        return p
    })
    if (perms.length > 4) phrases.push(`and ${perms.length - 4} more`)
    return phrases.join('; ')
}


// ── My access requests panel ────────────────────────────────────────

const STATUS_CHIP: Record<string, { icon: typeof Clock; pill: string; label: string }> = {
    pending: {
        icon: Clock,
        pill: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        label: 'Pending',
    },
    approved: {
        icon: CheckCircle2,
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        label: 'Approved',
    },
    denied: {
        icon: XCircle,
        pill: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
        label: 'Denied',
    },
}


function MyRequestsPanel({ requests }: { requests: AccessRequestResponse[] }) {
    // Sort: pending first, then approved/denied by most recent.
    const sorted = useMemo(() => {
        const order = { pending: 0, approved: 1, denied: 2 } as const
        return [...requests].sort((a, b) => {
            const o = (order[a.status] ?? 3) - (order[b.status] ?? 3)
            if (o !== 0) return o
            return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
        })
    }, [requests])

    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden"
        >
            <div className="px-5 py-3 border-b border-glass-border flex items-center gap-2">
                <Inbox className="w-4 h-4 text-ink-secondary" />
                <h3 className="text-sm font-bold text-ink">My access requests</h3>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-black/5 dark:bg-white/5 text-ink-muted">
                    {sorted.length}
                </span>
            </div>
            <div className="divide-y divide-glass-border">
                {sorted.map(r => {
                    const chip = STATUS_CHIP[r.status] ?? STATUS_CHIP.pending
                    const ChipIcon = chip.icon
                    return (
                        <div key={r.id} className="px-5 py-3 flex items-start gap-3">
                            <span className={cn(
                                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0',
                                chip.pill,
                            )}>
                                <ChipIcon className="w-2.5 h-2.5" />
                                {chip.label}
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold text-ink truncate">
                                    {r.target.label ?? r.target.id}
                                    <span className="font-normal text-ink-muted ml-1.5">as {r.requestedRole}</span>
                                </p>
                                {r.justification && (
                                    <p className="text-xs text-ink-secondary mt-0.5 break-words">
                                        “{r.justification}”
                                    </p>
                                )}
                                {r.status === 'denied' && r.resolutionNote && (
                                    <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                                        Reason: {r.resolutionNote}
                                    </p>
                                )}
                                <p className="text-[10px] text-ink-muted mt-1">
                                    Submitted {formatRelative(r.createdAt)}
                                    {r.resolvedAt && (
                                        <> · Resolved {formatRelative(r.resolvedAt)}</>
                                    )}
                                </p>
                            </div>
                        </div>
                    )
                })}
            </div>
        </motion.div>
    )
}


function formatRelative(iso: string): string {
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return ''
    const diffSec = Math.max(0, Math.round((Date.now() - then) / 1000))
    if (diffSec < 60) return 'just now'
    const diffMin = Math.round(diffSec / 60)
    if (diffMin < 60) return `${diffMin}m ago`
    const diffH = Math.round(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    const diffD = Math.round(diffH / 24)
    if (diffD < 7) return `${diffD}d ago`
    return new Date(iso).toLocaleDateString()
}
