/**
 * MyAccessPage — self-service "what can I do?" page.
 *
 * Renders the same access map shape as the admin "By user" lens
 * (``GET /admin/users/{user_id}/access``) but keyed off the caller's
 * own ``user_id`` via ``GET /me/access``. End users no longer have
 * to file a ticket or trigger a 403 to find out what they have
 * access to.
 *
 * Renders into ``AccountShell``, the chrome the account pages share.
 * It used to carry its own hero and full-bleed container, so following
 * "My access" out of Account settings dropped you into what looked like
 * a different product — same information, different journey. The rail
 * and the width now come from the shell; what is left here is the
 * access map itself:
 *
 *   * Plain-English summary banner — derived from the
 *     ``permission.longDescription`` map (4.1) so the user sees
 *     "You can edit views in WS-Finance" rather than
 *     ``workspace:view:edit``.
 *   * AccessSummary — the same component the admin lens renders,
 *     in ``mode='self'`` so copy is second-person.
 */
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { motion } from 'framer-motion'
import { useQueryClient } from '@tanstack/react-query'
import {
    Loader2, AlertCircle, Shield, RefreshCw, Sparkles, Inbox, ArrowRight, Undo2,
} from 'lucide-react'
import {
    permissionsService,
    type PermissionResponse,
    type UserAccessResponse,
} from '@/services/permissionsService'
import {
    OPEN_STATUSES,
    type AccessRequestResponse,
} from '@/services/accessRequestsService'
import { AccessSummary } from '@/components/access/AccessSummary'
import { STATUS_META, idpInstruction, roleLabel } from '@/components/access/accessRequestCopy'
import { AccountShell } from '@/components/account/AccountShell'
import { PersonChip } from '@/components/ui/PersonChip'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    WORKSPACE_ACCESS_KEY,
    WORKSPACE_DIRECTORY_FEATURE,
    useAccessRequestActions,
    useMyAccessRequests,
} from '@/hooks/useWorkspaceAccess'
import { useFeature } from '@/store/features'
import { cn } from '@/lib/utils'
import { useDocumentTitle } from '@/lib/useDocumentTitle'


export function MyAccessPage() {
    useDocumentTitle('My Access')
    const [access, setAccess] = useState<UserAccessResponse | null>(null)
    const [permissions, setPermissions] = useState<PermissionResponse[] | null>(null)
    const { requests } = useMyAccessRequests()
    const queryClient = useQueryClient()
    const [loading, setLoading] = useState(true)
    const [refreshing, setRefreshing] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const { notify } = useAppNotifications()

    const load = async (silent = false) => {
        if (!silent) setLoading(true)
        setError(null)
        try {
            // The permission catalogue is best-effort — used only for the
            // summary banner. Its failure doesn't block the page, and most
            // people can't read it: no reason to show them Access denied.
            // (Requests come from their own query, shared with Find a
            // workspace.)
            const [accessRes, permsRes] = await Promise.allSettled([
                permissionsService.getMyAccess(),
                permissionsService.listPermissions({ silent403: true }),
            ])
            if (accessRes.status === 'rejected') {
                throw accessRes.reason instanceof Error
                    ? accessRes.reason
                    : new Error(String(accessRes.reason))
            }
            setAccess(accessRes.value)
            setPermissions(permsRes.status === 'fulfilled' ? permsRes.value : [])
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Failed to load access'
            setError(message)
            if (silent) notify('error', message)
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
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_ACCESS_KEY })
        load(true)
    }

    return (
        <AccountShell
            title="My access"
            blurb="Everything you can do across the platform, and how you got it."
            actions={
                <button
                    onClick={handleRefresh}
                    disabled={loading || refreshing}
                    className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold text-ink-secondary hover:text-ink bg-glass-base/40 border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
                    title="Refresh"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', refreshing && 'animate-spin')} />
                    Refresh
                </button>
            }
        >
            <>
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
            </>
        </AccountShell>
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
    const directoryOn = useFeature(WORKSPACE_DIRECTORY_FEATURE)
    const isAdmin = access.effectiveGlobal.includes('system:admin')
    const isOrgAdmin = access.effectiveGlobal.includes('system:org-admin')
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
                    <p className="text-sm font-bold text-ink">You're a Super Admin.</p>
                    <p className="text-xs text-ink-secondary mt-0.5">
                        The <code className="font-mono text-[11px] bg-amber-500/10 px-1 py-0.5 rounded">system:admin</code> permission grants you every other capability.
                        You can manage every workspace, change any user's role, and override every other permission check.
                    </p>
                </div>
            </motion.div>
        )
    }

    if (isOrgAdmin) {
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
                    <p className="text-sm font-bold text-ink">You're an Org Admin.</p>
                    <p className="text-xs text-ink-secondary mt-0.5">
                        The <code className="font-mono text-[11px] bg-amber-500/10 px-1 py-0.5 rounded">system:org-admin</code> permission gives you administrator powers in every workspace and lets you create new workspaces.
                        It does <strong>not</strong> grant user / SSO administration — those stay with Super Admin.
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
                    {directoryOn ? (
                        <p className="text-xs text-ink-secondary mt-0.5">
                            Find a workspace your team works in and ask to join it — its admins answer.{' '}
                            <Link to="/workspaces?tab=discover" className="font-semibold text-emerald-600 dark:text-emerald-400 hover:underline">
                                Find a workspace
                            </Link>
                        </p>
                    ) : (
                        <p className="text-xs text-ink-secondary mt-0.5">
                            Ask an administrator to add you to a workspace, or a colleague for a link to theirs — opening it lets you request access.
                        </p>
                    )}
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
                                            <Link
                                                to={`/workspaces/${wsId}`}
                                                className="hover:underline"
                                                title={`Open ${friendly ?? wsId}`}
                                            >
                                                {friendly ? (
                                                    <>
                                                        <span className="font-semibold text-ink">{friendly}</span>
                                                        <code className="font-mono text-ink-muted ml-1.5 text-[10px]">{wsId}</code>
                                                    </>
                                                ) : (
                                                    <code className="font-mono font-semibold text-ink">{wsId}</code>
                                                )}
                                            </Link>
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


function MyRequestsPanel({ requests }: { requests: AccessRequestResponse[] }) {
    // Open requests first, then the answered ones by most recent.
    const sorted = useMemo(() => [...requests].sort((a, b) => {
        const o = Number(!OPEN_STATUSES.includes(a.status)) - Number(!OPEN_STATUSES.includes(b.status))
        if (o !== 0) return o
        return (b.createdAt ?? '').localeCompare(a.createdAt ?? '')
    }), [requests])
    const open = sorted.filter(r => OPEN_STATUSES.includes(r.status)).length

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
                    {open > 0 ? `${open} open` : sorted.length}
                </span>
            </div>
            <div className="divide-y divide-glass-border">
                {sorted.map(r => <MyRequestRow key={r.id} request={r} />)}
            </div>
        </motion.div>
    )
}


function MyRequestRow({ request: r }: { request: AccessRequestResponse }) {
    const { notify } = useAppNotifications()
    const { withdraw } = useAccessRequestActions()
    const meta = STATUS_META[r.status] ?? STATUS_META.pending
    const ChipIcon = meta.icon
    const isOpen = OPEN_STATUSES.includes(r.status)

    const onWithdraw = () => withdraw.mutate(r.id, {
        onSuccess: () => notify('success', 'Request withdrawn.'),
        onError: (err) => notify('error', (err as Error).message),
    })

    return (
        <div className="px-5 py-3 flex items-start gap-3">
            <span className={cn(
                'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0',
                meta.pill,
            )}>
                <ChipIcon className="w-2.5 h-2.5" />
                {meta.label}
            </span>
            <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-ink truncate">
                    {r.target.label ?? <span>A workspace you asked to join <code className="font-mono text-[11px] text-ink-muted">{r.target.id}</code></span>}
                    <span className="font-normal text-ink-muted ml-1.5">as {roleLabel(r.requestedRole)}</span>
                </p>
                {r.justification && (
                    <p className="text-xs text-ink-secondary mt-0.5 break-words">
                        “{r.justification}”
                    </p>
                )}
                <RequestOutcome request={r} />
                <p className="text-[10px] text-ink-muted mt-1">
                    Asked {formatRelative(r.createdAt)}
                    {r.resolvedAt && r.status !== 'withdrawn' && (
                        <> · Answered {formatRelative(r.resolvedAt)}</>
                    )}
                    {r.fulfilledAt && (
                        <> · Access arrived {formatRelative(r.fulfilledAt)}</>
                    )}
                </p>
            </div>
            <div className="shrink-0 flex flex-col items-end gap-1.5">
                {r.status === 'approved' && r.target.label && (
                    <Link
                        to={`/workspaces/${r.target.id}`}
                        className="inline-flex items-center gap-1 text-xs font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                        Open <ArrowRight className="w-3 h-3" />
                    </Link>
                )}
                {isOpen && (
                    <button
                        type="button"
                        onClick={onWithdraw}
                        disabled={withdraw.isPending}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50"
                    >
                        {withdraw.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Undo2 className="w-3 h-3" />}
                        Withdraw
                    </button>
                )}
            </div>
        </div>
    )
}


/** How the request was answered — or what it's waiting on. */
function RequestOutcome({ request: r }: { request: AccessRequestResponse }) {
    const by = r.resolvedBy ? <PersonChip id={r.resolvedBy} size="xs" link={false} /> : null
    if (r.status === 'pending') {
        return <p className="text-xs text-ink-muted mt-1">Waiting for the workspace’s admins and stewards to answer.</p>
    }
    if (r.status === 'awaiting_idp' && r.idpGroup) {
        return (
            <div className="mt-1.5 rounded-lg border border-sky-500/20 bg-sky-500/[0.05] px-2.5 py-1.5">
                <p className="text-xs text-ink">{idpInstruction(r.idpGroup, r.idpProvider)}</p>
                {r.resolutionNote && <p className="text-xs text-ink-secondary mt-1">“{r.resolutionNote}”</p>}
                {by && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">Pointed there by {by}</p>}
            </div>
        )
    }
    if (r.status === 'approved') {
        const what = r.fulfilledAt && r.idpGroup
            ? <>Granted through your identity provider’s group “{r.idpGroup}”.</>
            : r.grantedGroup
                ? <>Added to the team “{r.grantedGroup.name ?? r.grantedGroup.id}”.</>
                : <>Granted {roleLabel(r.grantedRole ?? r.requestedRole)}{r.idpException ? ' as an exception' : ''}{r.accessExpiresAt ? ` until ${new Date(r.accessExpiresAt).toLocaleDateString()}` : ''}.</>
        return (
            <div className="mt-1">
                <p className="text-xs text-emerald-700 dark:text-emerald-400">{what}</p>
                {r.resolutionNote && <p className="text-xs text-ink-secondary mt-0.5">“{r.resolutionNote}”</p>}
                {by && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">Approved by {by}</p>}
            </div>
        )
    }
    if (r.status === 'denied') {
        return (
            <div className="mt-1">
                {r.resolutionNote && (
                    <p className="text-xs text-rose-600 dark:text-rose-400">Reason: {r.resolutionNote}</p>
                )}
                {by && <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-muted">Declined by {by}</p>}
            </div>
        )
    }
    return <p className="text-xs text-ink-muted mt-1">You withdrew it.</p>
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
