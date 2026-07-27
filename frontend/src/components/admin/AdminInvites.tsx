/**
 * Outstanding invite links — the half that was missing.
 *
 * An invite used to be fire-and-forget: once generated there was no way
 * to see it, count it, or stop it. A link pasted into the wrong channel
 * worked for every reader until it expired, up to ninety days later,
 * and nobody could tell it had happened.
 *
 * Lives in its own file rather than inside AdminUsers.tsx, which is
 * already 2600+ lines.
 */
import { useCallback, useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    AlertCircle, Ban, ChevronDown, Infinity as InfinityIcon,
    Link2, Loader2, RefreshCw, Users,
} from 'lucide-react'
import {
    adminUserService,
    type InviteRedemption,
    type InviteSummary,
} from '@/services/adminUserService'
import { cn } from '@/lib/utils'
import { roleVisualFor } from '@/lib/roleVisual'

const STATUS_FILTERS = [
    { value: 'active', label: 'Active' },
    { value: 'revoked', label: 'Revoked' },
    { value: 'expired', label: 'Expired' },
    { value: 'exhausted', label: 'Used up' },
    { value: 'all', label: 'All' },
] as const

const STATUS_STYLES: Record<InviteSummary['status'], string> = {
    active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    revoked: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
    expired: 'bg-black/5 dark:bg-white/5 text-ink-muted border-glass-border',
    exhausted: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
}

const STATUS_LABELS: Record<InviteSummary['status'], string> = {
    active: 'Active',
    revoked: 'Revoked',
    expired: 'Expired',
    exhausted: 'Used up',
}

function messageOf(err: unknown, fallback: string): string {
    return err instanceof Error && err.message ? err.message : fallback
}

/** "in 3 days" / "2 hours ago" — enough to judge a link at a glance. */
function relativeTime(iso: string): string {
    const then = new Date(iso).getTime()
    if (Number.isNaN(then)) return iso
    const diffMs = then - Date.now()
    const abs = Math.abs(diffMs)
    const units: [number, Intl.RelativeTimeFormatUnit][] = [
        [1000 * 60 * 60 * 24, 'day'],
        [1000 * 60 * 60, 'hour'],
        [1000 * 60, 'minute'],
    ]
    const fmt = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
    for (const [ms, unit] of units) {
        if (abs >= ms) return fmt.format(Math.round(diffMs / ms), unit)
    }
    return fmt.format(Math.round(diffMs / 1000), 'second')
}

/** Who the link is for — the single most important column. */
function audienceOf(invite: InviteSummary): { label: string; shareable: boolean } {
    if (invite.email) return { label: invite.email, shareable: false }
    if (invite.emailDomain) return { label: `@${invite.emailDomain}`, shareable: true }
    return { label: 'Anyone with the link', shareable: true }
}

export function AdminInvites() {
    const [invites, setInvites] = useState<InviteSummary[]>([])
    const [status, setStatus] = useState<string>('active')
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [revoking, setRevoking] = useState<string | null>(null)
    const [expanded, setExpanded] = useState<string | null>(null)
    const [redemptions, setRedemptions] = useState<Record<string, InviteRedemption[]>>({})

    // A counter rather than calling a fetch function directly: it keeps
    // every setState inside the effect on the far side of an await, and
    // the cancellation flag stops a slow response for one filter landing
    // after the user has already switched to another.
    const [reloadToken, setReloadToken] = useState(0)

    const reload = useCallback(() => {
        setLoading(true)
        setReloadToken(n => n + 1)
    }, [])

    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const rows = await adminUserService.listInvites(status)
                if (cancelled) return
                setInvites(rows)
                setError(null)
            } catch (err: unknown) {
                if (!cancelled) setError(messageOf(err, 'Could not load invite links'))
            } finally {
                if (!cancelled) setLoading(false)
            }
        })()
        return () => { cancelled = true }
    }, [status, reloadToken])

    const handleRevoke = async (invite: InviteSummary) => {
        setRevoking(invite.id)
        setError(null)
        try {
            const updated = await adminUserService.revokeInvite(invite.id)
            // Reload rather than patching in place: revoking usually
            // moves the row out of the current filter, and leaving a
            // "Revoked" row sitting in the Active list is a lie.
            if (status === 'active') reload()
            else setInvites(prev => prev.map(i => (i.id === updated.id ? updated : i)))
        } catch (err: unknown) {
            setError(messageOf(err, 'Could not revoke this link'))
        } finally {
            setRevoking(null)
        }
    }

    // Redemptions are fetched only when a row is opened — most rows are
    // never expanded, and the list endpoint already carries the count.
    const toggleExpand = async (invite: InviteSummary) => {
        if (expanded === invite.id) {
            setExpanded(null)
            return
        }
        setExpanded(invite.id)
        if (!redemptions[invite.id]) {
            try {
                const rows = await adminUserService.listInviteRedemptions(invite.id)
                setRedemptions(prev => ({ ...prev, [invite.id]: rows }))
            } catch {
                setRedemptions(prev => ({ ...prev, [invite.id]: [] }))
            }
        }
    }

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                    {STATUS_FILTERS.map(f => (
                        <button
                            key={f.value}
                            onClick={() => setStatus(f.value)}
                            className={cn(
                                'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                status === f.value
                                    ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
                                    : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30',
                            )}
                        >
                            {f.label}
                        </button>
                    ))}
                </div>
                <button
                    onClick={reload}
                    disabled={loading}
                    className="px-3 py-1.5 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-lg text-xs font-medium text-ink transition-colors flex items-center gap-1.5 disabled:opacity-50"
                >
                    <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
                    Refresh
                </button>
            </div>

            {error && (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
                    <AlertCircle className="w-4 h-4 shrink-0" />
                    <p>{error}</p>
                </div>
            )}

            {loading ? (
                <div className="flex items-center justify-center py-12 text-ink-muted">
                    <Loader2 className="w-5 h-5 animate-spin" />
                </div>
            ) : invites.length === 0 ? (
                <div className="text-center py-12">
                    <Link2 className="w-8 h-8 mx-auto mb-3 text-ink-muted/40" />
                    <p className="text-sm text-ink-muted">
                        {status === 'active'
                            ? 'No invite links are currently active.'
                            : `No ${status} invite links.`}
                    </p>
                </div>
            ) : (
                <ul className="space-y-2">
                    {invites.map(invite => {
                        const audience = audienceOf(invite)
                        const isOpen = expanded === invite.id
                        const rows = redemptions[invite.id]
                        return (
                            <li
                                key={invite.id}
                                className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden"
                            >
                                <div className="flex items-center gap-3 p-3 flex-wrap">
                                    <span
                                        className={cn(
                                            'px-2 py-0.5 rounded-md text-[11px] font-semibold border shrink-0',
                                            STATUS_STYLES[invite.status],
                                        )}
                                    >
                                        {STATUS_LABELS[invite.status]}
                                    </span>

                                    <div className="min-w-0 flex-1">
                                        <p className="text-sm font-medium text-ink truncate">
                                            {invite.role
                                                ? roleVisualFor(invite.role).label
                                                : 'No role'}
                                            {invite.workspaceName && (
                                                <span className="text-ink-muted font-normal">
                                                    {' '}in {invite.workspaceName}
                                                </span>
                                            )}
                                        </p>
                                        <p className="text-xs text-ink-muted truncate">
                                            {audience.label}
                                            {invite.groupNames.length > 0 && (
                                                <> · {invite.groupNames.join(', ')}</>
                                            )}
                                        </p>
                                    </div>

                                    <div
                                        className="text-xs text-ink-muted flex items-center gap-1 shrink-0"
                                        title={
                                            invite.maxUses === null
                                                ? `${invite.useCount} used, no limit`
                                                : `${invite.useCount} of ${invite.maxUses} used`
                                        }
                                    >
                                        <Users className="w-3.5 h-3.5" />
                                        {invite.useCount}
                                        {' / '}
                                        {invite.maxUses ?? (
                                            <InfinityIcon className="w-3.5 h-3.5 inline" />
                                        )}
                                    </div>

                                    <p className="text-xs text-ink-muted shrink-0 w-28 text-right">
                                        {invite.status === 'revoked' && invite.revokedAt
                                            ? `Revoked ${relativeTime(invite.revokedAt)}`
                                            : `Expires ${relativeTime(invite.expiresAt)}`}
                                    </p>

                                    <button
                                        onClick={() => void toggleExpand(invite)}
                                        disabled={invite.redemptionCount === 0}
                                        title={
                                            invite.redemptionCount === 0
                                                ? 'Nobody has used this link yet'
                                                : 'Show who used this link'
                                        }
                                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                                    >
                                        <ChevronDown
                                            className={cn(
                                                'w-4 h-4 transition-transform',
                                                isOpen && 'rotate-180',
                                            )}
                                        />
                                    </button>

                                    {invite.status !== 'revoked' && (
                                        <button
                                            onClick={() => void handleRevoke(invite)}
                                            disabled={revoking === invite.id}
                                            title="Revoke this link"
                                            className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/10 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                                        >
                                            {revoking === invite.id ? (
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                            ) : (
                                                <Ban className="w-3.5 h-3.5" />
                                            )}
                                            Revoke
                                        </button>
                                    )}
                                </div>

                                <AnimatePresence initial={false}>
                                    {isOpen && (
                                        <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: 'auto', opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            className="border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02]"
                                        >
                                            <div className="p-3 space-y-1.5">
                                                {rows === undefined ? (
                                                    <p className="text-xs text-ink-muted">Loading…</p>
                                                ) : rows.length === 0 ? (
                                                    <p className="text-xs text-ink-muted">
                                                        Nobody has used this link.
                                                    </p>
                                                ) : (
                                                    rows.map(r => (
                                                        <div
                                                            key={r.id}
                                                            className="flex items-center justify-between text-xs"
                                                        >
                                                            <span className="text-ink">{r.email}</span>
                                                            <span className="text-ink-muted">
                                                                {relativeTime(r.redeemedAt)}
                                                            </span>
                                                        </div>
                                                    ))
                                                )}
                                            </div>
                                        </motion.div>
                                    )}
                                </AnimatePresence>
                            </li>
                        )
                    })}
                </ul>
            )}
        </div>
    )
}
