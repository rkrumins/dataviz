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
    AlertCircle, Ban, CalendarPlus, Check, ChevronDown, Copy,
    Infinity as InfinityIcon, Link2, Loader2, RefreshCw, RotateCw, Users, X,
} from 'lucide-react'
import {
    adminUserService,
    type InviteRedemption,
    type InviteSummary,
} from '@/services/adminUserService'
import { cn } from '@/lib/utils'
import { roleVisualFor } from '@/lib/roleVisual'
import { formatUtc, timeAgo, toUtcDate } from '@/lib/timeAgo'
import { useToast } from '@/components/ui/toast'
import { ConfirmDialog } from '@/components/admin/job-history/ConfirmDialog'

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

const HOUR_MS = 1000 * 60 * 60

/** "in 3 days" / "in 5h" — how long a link has left.
 *
 *  Deliberately not `TimeStamp`: that component colours by AGE (how long
 *  ago something happened) and an expiry is in the future, so every live
 *  link would read as freshly-green. The urgency here runs the other way
 *  — a link with two hours left is the one worth noticing. Parsing goes
 *  through `toUtcDate` so a timestamp without an offset is not skewed by
 *  the viewer's timezone. */
function expiresIn(iso: string): { label: string; tone: string } {
    const d = toUtcDate(iso)
    if (!d) return { label: '—', tone: 'text-ink-muted' }

    const ms = d.getTime() - Date.now()
    if (ms <= 0) return { label: 'expired', tone: 'text-ink-muted' }

    const hours = ms / HOUR_MS
    const label =
        hours < 1 ? `in ${Math.max(1, Math.round(ms / 60000))}m`
        : hours < 48 ? `in ${Math.round(hours)}h`
        : `in ${Math.round(hours / 24)}d`

    return {
        label,
        tone: hours < 24 ? 'text-amber-500' : hours < 72 ? 'text-ink-secondary' : 'text-ink-muted',
    }
}

/** Seats remaining, or null when the link is uncapped. Drives the amber
 *  "nearly gone" cue — a link about to close itself is the one an admin
 *  needs to notice before someone is turned away. */
function seatsLeft(invite: InviteSummary): number | null {
    if (invite.maxUses === null) return null
    return Math.max(0, invite.maxUses - invite.useCount)
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
    // Revoking is instant and irreversible — the link dies for everyone
    // holding it, including people mid-signup. Every other destructive
    // action on this page confirms first; this one was the exception.
    const [confirming, setConfirming] = useState<InviteSummary | null>(null)
    const [rotating, setRotating] = useState<InviteSummary | null>(null)
    // A regenerated URL is shown once, here, and never again — the list
    // deliberately never returns tokens.
    const [rotatedUrl, setRotatedUrl] = useState<string | null>(null)
    const [rotatedCopied, setRotatedCopied] = useState(false)
    const [busyId, setBusyId] = useState<string | null>(null)
    const { showToast } = useToast()

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
            setConfirming(null)
            // Say what actually happened, not just "done". An admin
            // revoking a link wants to know it stopped working, and
            // whether anyone had already got in through it.
            showToast(
                'success',
                invite.useCount > 0
                    ? `Link revoked. It had already been used ${invite.useCount} time${invite.useCount === 1 ? '' : 's'}.`
                    : 'Link revoked. It stopped working immediately.',
            )
            // Reload rather than patching in place: revoking usually
            // moves the row out of the current filter, and leaving a
            // "Revoked" row sitting in the Active list is a lie.
            if (status === 'active') reload()
            else setInvites(prev => prev.map(i => (i.id === updated.id ? updated : i)))
        } catch (err: unknown) {
            const msg = messageOf(err, 'Could not revoke this link')
            setError(msg)
            showToast('error', msg)
        } finally {
            setRevoking(null)
        }
    }

    const handleExtend = async (invite: InviteSummary) => {
        setBusyId(invite.id)
        try {
            const updated = await adminUserService.extendInvite(invite.id, {
                expiresInHours: 24 * 30,
                // Only top up a capped link. Adding seats to an uncapped
                // one would silently impose a cap that was never there.
                additionalUses: invite.maxUses === null ? null : 5,
            })
            showToast(
                'success',
                invite.maxUses === null
                    ? 'Link extended by 30 days. The URL you shared still works.'
                    : `Link extended by 30 days, now usable ${updated.maxUses} times total.`,
            )
            reload()
        } catch (err: unknown) {
            showToast('error', messageOf(err, 'Could not extend this link'))
        } finally {
            setBusyId(null)
        }
    }

    const handleRegenerate = async (invite: InviteSummary) => {
        setBusyId(invite.id)
        try {
            const fresh = await adminUserService.regenerateInvite(invite.id, {
                expiresInHours: 24 * 30,
            })
            setRotating(null)
            setRotatedUrl(`${window.location.origin}/signup?invite=${fresh.inviteToken}`)
            showToast('success', 'New link created. Every previous URL has stopped working.')
            reload()
        } catch (err: unknown) {
            showToast('error', messageOf(err, 'Could not regenerate this link'))
        } finally {
            setBusyId(null)
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
                // Skeleton rows rather than a spinner: the list keeps its
                // shape, so the panel doesn't collapse and jump when data
                // lands. Matches the drawer's AccessSkeleton next door.
                <ul className="space-y-2" aria-busy="true" aria-label="Loading invite links">
                    {[0, 1, 2].map(i => (
                        <li
                            key={i}
                            className="rounded-xl border border-glass-border bg-canvas-elevated p-3 flex items-center gap-3"
                        >
                            <div className="h-5 w-16 rounded-md bg-black/5 dark:bg-white/5 animate-pulse" />
                            <div className="flex-1 space-y-1.5">
                                <div className="h-3.5 w-40 rounded bg-black/5 dark:bg-white/5 animate-pulse" />
                                <div className="h-3 w-56 rounded bg-black/[0.04] dark:bg-white/[0.04] animate-pulse" />
                            </div>
                            <div className="h-3.5 w-10 rounded bg-black/5 dark:bg-white/5 animate-pulse" />
                            <div className="h-3.5 w-20 rounded bg-black/5 dark:bg-white/5 animate-pulse" />
                        </li>
                    ))}
                </ul>
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
                                        className={cn(
                                            'text-xs flex items-center gap-1 shrink-0 tabular-nums',
                                            seatsLeft(invite) !== null && seatsLeft(invite)! <= 1
                                                ? 'text-amber-500 font-medium'
                                                : 'text-ink-muted',
                                        )}
                                        title={
                                            invite.maxUses === null
                                                ? `${invite.useCount} used, no limit`
                                                : `${invite.useCount} of ${invite.maxUses} used · ${seatsLeft(invite)} left`
                                        }
                                    >
                                        <Users className="w-3.5 h-3.5" />
                                        {invite.useCount}
                                        {' / '}
                                        {invite.maxUses ?? (
                                            <InfinityIcon className="w-3.5 h-3.5 inline" />
                                        )}
                                    </div>

                                    {/* The exact instant lives in the tooltip — "in 3d"
                                        is for scanning, and nobody can act on it when
                                        they actually need to know when. */}
                                    <p
                                        className={cn(
                                            'text-xs shrink-0 w-24 text-right',
                                            invite.status === 'revoked'
                                                ? 'text-ink-muted'
                                                : expiresIn(invite.expiresAt).tone,
                                        )}
                                        title={
                                            invite.status === 'revoked' && invite.revokedAt
                                                ? `Revoked ${formatUtc(invite.revokedAt)}`
                                                : `Expires ${formatUtc(invite.expiresAt)}`
                                        }
                                    >
                                        {invite.status === 'revoked' && invite.revokedAt
                                            ? `Revoked ${timeAgo(invite.revokedAt)}`
                                            : `Expires ${expiresIn(invite.expiresAt).label}`}
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

                                    {/* Extend keeps the shared URL alive; regenerate
                                        replaces it. Both stay on this one row, so an
                                        invitation keeps a single history instead of
                                        fragmenting every time it is renewed. */}
                                    {invite.status !== 'revoked' && (
                                        <>
                                            <button
                                                onClick={() => void handleExtend(invite)}
                                                disabled={busyId === invite.id}
                                                title={
                                                    invite.maxUses === null
                                                        ? 'Give this link another 30 days — the URL you shared keeps working'
                                                        : 'Give this link another 30 days and 5 more seats — the URL you shared keeps working'
                                                }
                                                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                                            >
                                                {busyId === invite.id
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <CalendarPlus className="w-3.5 h-3.5" />}
                                                Extend
                                            </button>
                                            <button
                                                onClick={() => setRotating(invite)}
                                                disabled={busyId === invite.id}
                                                title="Issue a new URL — every link already sent stops working"
                                                className="px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-secondary border border-glass-border hover:bg-black/5 dark:hover:bg-white/5 transition-colors flex items-center gap-1.5 disabled:opacity-50"
                                            >
                                                <RotateCw className="w-3.5 h-3.5" />
                                                New URL
                                            </button>
                                        </>
                                    )}
                                    {invite.status !== 'revoked' && (
                                        <button
                                            onClick={() => setConfirming(invite)}
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
                                                            <span
                                                                className="text-ink-muted"
                                                                title={formatUtc(r.redeemedAt)}
                                                            >
                                                                {timeAgo(r.redeemedAt)}
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

            {/* Revoking is instant and cannot be undone: everyone holding the
                link loses it, including anyone part-way through signing up.
                The message names the blast radius rather than asking a generic
                "are you sure?", which nobody reads. */}
            <ConfirmDialog
                open={confirming !== null}
                title="Revoke this invite link?"
                message={
                    confirming
                        ? [
                            `Anyone holding this link stops being able to sign up, immediately.`,
                            confirming.useCount > 0
                                ? `${confirming.useCount} ${confirming.useCount === 1 ? 'person has' : 'people have'} already used it — their accounts are not affected.`
                                : 'Nobody has used it yet.',
                            'This cannot be undone. Create a new link if you need one.',
                        ].join(' ')
                        : ''
                }
                confirmLabel="Revoke link"
                confirmIcon={Ban}
                loading={revoking !== null}
                onConfirm={() => { if (confirming) void handleRevoke(confirming) }}
                onCancel={() => setConfirming(null)}
            />

            <ConfirmDialog
                open={rotating !== null}
                title="Issue a new URL for this link?"
                message={
                    'Everyone still holding the old URL loses it, immediately. '
                    + 'The role, groups, seat count and the record of who has already '
                    + 'joined all stay on this same invitation — only the address changes. '
                    + 'The new URL is shown once, so copy it before closing.'
                }
                confirmLabel="Generate new URL"
                confirmIcon={RotateCw}
                confirmColor="bg-accent-lineage hover:brightness-110 shadow-md"
                loading={busyId !== null}
                onConfirm={() => { if (rotating) void handleRegenerate(rotating) }}
                onCancel={() => setRotating(null)}
            />

            {/* Shown once. The list never returns tokens, so closing this
                without copying means regenerating again. Say so, rather
                than letting someone discover it. */}
            <AnimatePresence>
                {rotatedUrl && (
                    <motion.div
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: 8 }}
                        className="mt-4 p-4 rounded-2xl bg-accent-lineage/5 border border-accent-lineage/20"
                    >
                        <div className="flex items-start justify-between gap-3 mb-2">
                            <div>
                                <p className="text-[10px] font-semibold uppercase tracking-wider text-accent-lineage">
                                    New link
                                </p>
                                <p className="text-[11px] text-ink-muted mt-0.5">
                                    Copy it now — it is not shown again.
                                </p>
                            </div>
                            <button
                                onClick={() => { setRotatedUrl(null); setRotatedCopied(false) }}
                                className="p-1 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                title="Dismiss"
                            >
                                <X className="w-3.5 h-3.5" />
                            </button>
                        </div>
                        <div className="flex items-center gap-2">
                            <code className="flex-1 min-w-0 truncate text-[11px] text-ink bg-canvas-elevated border border-glass-border rounded-lg px-2.5 py-2">
                                {rotatedUrl}
                            </code>
                            <button
                                onClick={async () => {
                                    await navigator.clipboard.writeText(rotatedUrl)
                                    setRotatedCopied(true)
                                    setTimeout(() => setRotatedCopied(false), 2000)
                                }}
                                className="p-2 rounded-lg bg-accent-lineage text-white hover:brightness-110 transition-all shrink-0"
                                title="Copy link"
                            >
                                {rotatedCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                            </button>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
