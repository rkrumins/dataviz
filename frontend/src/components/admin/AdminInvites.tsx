/**
 * Outstanding invite links — the half that was missing.
 *
 * An invite used to be fire-and-forget: once generated there was no way
 * to see it, count it, or stop it. A link pasted into the wrong channel
 * worked for every reader until it expired, up to ninety days later,
 * and nobody could tell it had happened.
 *
 * Layout note, learned the hard way. The first version put the identity,
 * the seat count, the expiry and three labelled buttons in ONE flex row.
 * The buttons and the fixed-width metadata starved the `flex-1` identity
 * column, and the two things a reader actually needs — what the link
 * grants and who it is for — truncated to "No r…" and "Anyo…". Actions
 * now collapse into an overflow menu and metadata sits on its own line,
 * so the identity can never be squeezed by a control again.
 *
 * Lives in its own file rather than inside AdminUsers.tsx, which is
 * already 2600+ lines.
 */
import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import * as Popover from '@radix-ui/react-popover'
import {
    AlertCircle, Ban, CalendarPlus, Check, ChevronDown, Copy, Globe,
    Infinity as InfinityIcon, Link2, Loader2, Mail, MoreHorizontal,
    RefreshCw, RotateCw, ShieldCheck, Users, X,
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

type Status = InviteSummary['status']

const STATUS_FILTERS: { value: Status | 'all'; label: string }[] = [
    { value: 'active', label: 'Active' },
    { value: 'revoked', label: 'Revoked' },
    { value: 'expired', label: 'Expired' },
    { value: 'exhausted', label: 'Used up' },
    { value: 'all', label: 'All' },
]

const STATUS_STYLES: Record<Status, string> = {
    active: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    revoked: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
    expired: 'bg-black/5 dark:bg-white/5 text-ink-muted border-glass-border',
    exhausted: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
}

const STATUS_LABELS: Record<Status, string> = {
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
function expiresIn(iso: string): { label: string; tone: string; urgent: boolean } {
    const d = toUtcDate(iso)
    if (!d) return { label: '—', tone: 'text-ink-muted', urgent: false }

    const ms = d.getTime() - Date.now()
    if (ms <= 0) return { label: 'Expired', tone: 'text-ink-muted', urgent: false }

    const hours = ms / HOUR_MS
    const label =
        hours < 1 ? `Expires in ${Math.max(1, Math.round(ms / 60000))}m`
        : hours < 48 ? `Expires in ${Math.round(hours)}h`
        : `Expires in ${Math.round(hours / 24)}d`

    return {
        label,
        tone: hours < 24 ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted',
        urgent: hours < 24,
    }
}

/** Seats remaining, or null when the link is uncapped. */
function seatsLeft(invite: InviteSummary): number | null {
    if (invite.maxUses === null) return null
    return Math.max(0, invite.maxUses - invite.useCount)
}

/** Who the link is for — with the icon that says which KIND of audience
 *  it is, so the distinction survives at a glance and does not rest on
 *  reading the string. */
function audienceOf(invite: InviteSummary) {
    if (invite.email) {
        return { label: invite.email, icon: Mail, hint: 'Only this address can use it' }
    }
    if (invite.emailDomain) {
        return {
            label: `Anyone @${invite.emailDomain}`,
            icon: ShieldCheck,
            hint: 'Restricted to one email domain',
        }
    }
    return { label: 'Anyone with the link', icon: Globe, hint: 'No restriction on who can use it' }
}

/**
 * Seat meter — a single ratio against a limit.
 *
 * Per the form heuristic this is a meter, not a chart: the fill carries
 * severity and the unfilled track is a lighter step of the SAME ramp, so
 * the state reads across the whole bar rather than only where it stops.
 * Colour never carries the meaning alone — the count sits beside it.
 */
function SeatMeter({ invite }: { invite: InviteSummary }) {
    const left = seatsLeft(invite)

    if (invite.maxUses === null) {
        return (
            <span
                className="inline-flex items-center gap-1.5 text-xs text-ink-muted"
                title={`${invite.useCount} used, no limit`}
            >
                <Users className="w-3.5 h-3.5" />
                <span className="tabular-nums">{invite.useCount}</span>
                <span className="text-ink-muted/60">/</span>
                <InfinityIcon className="w-3.5 h-3.5" />
            </span>
        )
    }

    const pct = Math.min(100, Math.round((invite.useCount / invite.maxUses) * 100))
    // Severity along one ramp: the fill darkens/warms as the link fills up
    // and the track is a lighter step of the SAME hue, so the state reads
    // across the whole bar rather than only where the fill stops.
    const remaining = left ?? 0
    const ramp =
        remaining === 0 ? { fill: 'bg-red-500', track: 'bg-red-500/15', text: 'text-red-600 dark:text-red-400' }
        : remaining <= 1 ? { fill: 'bg-amber-500', track: 'bg-amber-500/15', text: 'text-amber-600 dark:text-amber-400' }
        : { fill: 'bg-accent-lineage', track: 'bg-accent-lineage/15', text: 'text-ink-muted' }

    return (
        <span
            className="inline-flex items-center gap-2 text-xs"
            title={`${invite.useCount} of ${invite.maxUses} used · ${left} left`}
        >
            <Users className={cn('w-3.5 h-3.5', ramp.text)} />
            <span className={cn('tabular-nums', ramp.text)}>
                {invite.useCount}
                <span className="text-ink-muted/60">/</span>
                {invite.maxUses}
            </span>
            <span className={cn('h-1.5 w-14 rounded-full overflow-hidden shrink-0', ramp.track)}>
                <span
                    className={cn('block h-full rounded-full transition-all duration-500', ramp.fill)}
                    style={{ width: `${pct}%` }}
                />
            </span>
        </span>
    )
}

/** Label · value. Proportional figures, not tabular — a standalone
 *  number at this size looks loose when every digit is `0`-width. */
function StatTile({
    label, value, tone = 'text-ink', icon: Icon,
}: {
    label: string
    value: number
    tone?: string
    icon: typeof Users
}) {
    return (
        <div className="flex-1 min-w-0 rounded-xl border border-glass-border bg-canvas-elevated px-3 py-2.5">
            <div className="flex items-center gap-1.5 text-ink-muted mb-0.5">
                <Icon className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[10px] font-semibold uppercase tracking-wider truncate">
                    {label}
                </span>
            </div>
            <p className={cn('text-xl font-semibold leading-none', tone)}>{value}</p>
        </div>
    )
}

/** Initial-only avatar. Enough to make a list of addresses scannable
 *  without pretending we have profile pictures for people who signed up
 *  ninety seconds ago. */
function Initial({ email }: { email: string }) {
    return (
        <span className="w-6 h-6 rounded-full bg-accent-lineage/10 text-accent-lineage text-[10px] font-bold flex items-center justify-center shrink-0 uppercase">
            {email.charAt(0)}
        </span>
    )
}

export function AdminInvites() {
    const [invites, setInvites] = useState<InviteSummary[]>([])
    const [status, setStatus] = useState<Status | 'all'>('active')
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
    // the cancellation flag stops a slow response landing over a newer one.
    const [reloadToken, setReloadToken] = useState(0)
    const reload = () => {
        setLoading(true)
        setReloadToken(n => n + 1)
    }

    // Fetch EVERYTHING once and filter in memory. The volume is bounded
    // (the endpoint caps at 500) and it buys two things: switching tabs is
    // instant instead of a spinner per click, and the summary above can
    // count states the current tab is hiding.
    useEffect(() => {
        let cancelled = false
        void (async () => {
            try {
                const rows = await adminUserService.listInvites('all')
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
    }, [reloadToken])

    const counts = useMemo(() => {
        const by = (s: Status) => invites.filter(i => i.status === s).length
        return {
            active: by('active'),
            revoked: by('revoked'),
            expired: by('expired'),
            exhausted: by('exhausted'),
            all: invites.length,
            joined: invites.reduce((n, i) => n + i.redemptionCount, 0),
            // Links that will stop working on their own within a day, or
            // are down to their last seat — the ones worth acting on now.
            attention: invites.filter(i =>
                i.status === 'active'
                && (expiresIn(i.expiresAt).urgent || (seatsLeft(i) !== null && seatsLeft(i)! <= 1)),
            ).length,
        }
    }, [invites])

    const visible = useMemo(
        () => (status === 'all' ? invites : invites.filter(i => i.status === status)),
        [invites, status],
    )

    const handleRevoke = async (invite: InviteSummary) => {
        setRevoking(invite.id)
        setError(null)
        try {
            await adminUserService.revokeInvite(invite.id)
            setConfirming(null)
            showToast(
                'success',
                invite.useCount > 0
                    ? `Link revoked. It had already been used ${invite.useCount} time${invite.useCount === 1 ? '' : 's'}.`
                    : 'Link revoked. It stopped working immediately.',
            )
            reload()
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
                // one would silently impose a limit that was never there.
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
    // never expanded, and the list already carries the count.
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
            {/* At a glance, before the list. Answers "is anything wrong?"
                without making somebody read every row to find out. */}
            {!loading && invites.length > 0 && (
                <div className="flex items-stretch gap-2">
                    <StatTile label="Active" value={counts.active} icon={Link2} />
                    <StatTile label="People joined" value={counts.joined} icon={Users} />
                    <StatTile
                        label="Need attention"
                        value={counts.attention}
                        icon={AlertCircle}
                        tone={counts.attention > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-ink'}
                    />
                </div>
            )}

            <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-1.5 flex-wrap">
                    {STATUS_FILTERS.map(f => {
                        const n = counts[f.value]
                        return (
                            <button
                                key={f.value}
                                onClick={() => setStatus(f.value)}
                                className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors flex items-center gap-1.5',
                                    status === f.value
                                        ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
                                        : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30',
                                )}
                            >
                                {f.label}
                                {/* The count is the point of a filter chip — it
                                    says whether clicking is worth it. */}
                                {n > 0 && (
                                    <span className={cn(
                                        'tabular-nums',
                                        status === f.value ? 'text-accent-lineage/70' : 'text-ink-muted',
                                    )}>
                                        {n}
                                    </span>
                                )}
                            </button>
                        )
                    })}
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
                // shape, so the panel doesn't collapse and jump when data lands.
                <ul className="space-y-2" aria-busy="true" aria-label="Loading invite links">
                    {[0, 1, 2].map(i => (
                        <li key={i} className="rounded-xl border border-glass-border bg-canvas-elevated p-3.5 space-y-2.5">
                            <div className="flex items-center gap-2.5">
                                <div className="h-5 w-16 rounded-md bg-black/5 dark:bg-white/5 animate-pulse" />
                                <div className="h-3.5 w-44 rounded bg-black/5 dark:bg-white/5 animate-pulse" />
                            </div>
                            <div className="h-3 w-64 rounded bg-black/[0.04] dark:bg-white/[0.04] animate-pulse" />
                            <div className="h-3 w-52 rounded bg-black/[0.04] dark:bg-white/[0.04] animate-pulse" />
                        </li>
                    ))}
                </ul>
            ) : visible.length === 0 ? (
                <EmptyState status={status} hasAny={invites.length > 0} onShowAll={() => setStatus('all')} />
            ) : (
                <ul className="space-y-2">
                    {visible.map(invite => {
                        const audience = audienceOf(invite)
                        const AudienceIcon = audience.icon
                        const isOpen = expanded === invite.id
                        const rows = redemptions[invite.id]
                        const expiry = expiresIn(invite.expiresAt)
                        const left = seatsLeft(invite)
                        const live = invite.status !== 'revoked'
                        const busy = busyId === invite.id || revoking === invite.id

                        return (
                            <li
                                key={invite.id}
                                className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden transition-colors hover:border-accent-lineage/25"
                            >
                                <div className="p-3.5">
                                    {/* Identity line. Nothing fixed-width sits beside
                                        it except the menu button, so it always gets
                                        the room it needs. */}
                                    <div className="flex items-start gap-2.5">
                                        <span
                                            className={cn(
                                                'px-2 py-0.5 rounded-md text-[11px] font-semibold border shrink-0 mt-0.5',
                                                STATUS_STYLES[invite.status],
                                            )}
                                        >
                                            {STATUS_LABELS[invite.status]}
                                        </span>

                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm font-medium text-ink">
                                                {invite.role
                                                    ? roleVisualFor(invite.role).label
                                                    : 'No role'}
                                                {invite.workspaceName && (
                                                    <span className="text-ink-muted font-normal">
                                                        {' '}in {invite.workspaceName}
                                                    </span>
                                                )}
                                            </p>
                                            <p
                                                className="text-xs text-ink-muted flex items-center gap-1.5 mt-0.5"
                                                title={audience.hint}
                                            >
                                                <AudienceIcon className="w-3 h-3 shrink-0" />
                                                <span className="truncate">{audience.label}</span>
                                            </p>
                                            {invite.groupNames.length > 0 && (
                                                <p className="text-xs text-ink-muted mt-0.5 truncate">
                                                    Joins {invite.groupNames.join(', ')}
                                                </p>
                                            )}
                                        </div>

                                        {busy ? (
                                            <Loader2 className="w-4 h-4 animate-spin text-ink-muted shrink-0 mt-1" />
                                        ) : (
                                            <RowActions
                                                invite={invite}
                                                live={live}
                                                onExtend={() => void handleExtend(invite)}
                                                onRegenerate={() => setRotating(invite)}
                                                onRevoke={() => setConfirming(invite)}
                                            />
                                        )}
                                    </div>

                                    {/* Metadata line — its own row, so a control can
                                        never squeeze the identity above it again. */}
                                    <div className="flex items-center gap-3 flex-wrap mt-2.5 pl-[3.4rem]">
                                        <SeatMeter invite={invite} />

                                        <span
                                            className={cn('text-xs', invite.status === 'revoked' ? 'text-ink-muted' : expiry.tone)}
                                            title={
                                                invite.status === 'revoked' && invite.revokedAt
                                                    ? `Revoked ${formatUtc(invite.revokedAt)}`
                                                    : `Expires ${formatUtc(invite.expiresAt)}`
                                            }
                                        >
                                            {invite.status === 'revoked' && invite.revokedAt
                                                ? `Revoked ${timeAgo(invite.revokedAt)}`
                                                : expiry.label}
                                        </span>

                                        {invite.redemptionCount > 0 && (
                                            <button
                                                onClick={() => void toggleExpand(invite)}
                                                className="text-xs text-accent-lineage hover:underline flex items-center gap-1"
                                            >
                                                {invite.redemptionCount}{' '}
                                                {invite.redemptionCount === 1 ? 'person' : 'people'} joined
                                                <ChevronDown
                                                    className={cn(
                                                        'w-3 h-3 transition-transform',
                                                        isOpen && 'rotate-180',
                                                    )}
                                                />
                                            </button>
                                        )}
                                    </div>

                                    {/* The nudge, only where there is something to do.
                                        A status word tells you what IS; this tells you
                                        what to do about it. */}
                                    {live && (expiry.urgent || left === 0 || left === 1) && (
                                        <p className="text-[11px] text-amber-600 dark:text-amber-400 mt-2 pl-[3.4rem]">
                                            {left === 0
                                                ? 'Out of seats — extend it to let more people in.'
                                                : left === 1
                                                    ? 'One seat left. Extend it if more people still need to join.'
                                                    : 'Expiring today. Extend it if it is still needed.'}
                                        </p>
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
                                            <div className="p-3 pl-[3.4rem] space-y-2">
                                                {rows === undefined ? (
                                                    <p className="text-xs text-ink-muted">Loading…</p>
                                                ) : rows.length === 0 ? (
                                                    <p className="text-xs text-ink-muted">
                                                        Nobody has used this link.
                                                    </p>
                                                ) : (
                                                    rows.map(r => (
                                                        <div key={r.id} className="flex items-center gap-2.5">
                                                            <Initial email={r.email} />
                                                            <span className="text-xs text-ink truncate flex-1 min-w-0">
                                                                {r.email}
                                                            </span>
                                                            <span
                                                                className="text-[11px] text-ink-muted shrink-0"
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
                            'Anyone holding this link stops being able to sign up, immediately.',
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
                        className="p-4 rounded-2xl bg-accent-lineage/5 border border-accent-lineage/20"
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

/**
 * Row actions, collapsed.
 *
 * Three labelled buttons per row is what crushed the identity column in
 * the first version. A menu costs one extra click on actions nobody
 * performs often — extending or replacing a link is rare, revoking is
 * rarer — and buys back the width the reader needs on every row.
 */
function RowActions({
    invite, live, onExtend, onRegenerate, onRevoke,
}: {
    invite: InviteSummary
    live: boolean
    onExtend: () => void
    onRegenerate: () => void
    onRevoke: () => void
}) {
    const [open, setOpen] = useState(false)

    if (!live) {
        return <span className="w-7 shrink-0" aria-hidden />
    }

    const item = 'w-full text-left px-3 py-2 text-xs flex items-start gap-2.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors'

    return (
        <Popover.Root open={open} onOpenChange={setOpen}>
            <Popover.Trigger asChild>
                <button
                    className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                    title="Actions for this link"
                    aria-label="Actions for this link"
                >
                    <MoreHorizontal className="w-4 h-4" />
                </button>
            </Popover.Trigger>
            <Popover.Portal>
                <Popover.Content
                    align="end"
                    sideOffset={6}
                    className="w-64 bg-canvas-elevated border border-glass-border rounded-xl shadow-lg z-50 overflow-hidden animate-in fade-in zoom-in-95"
                >
                    {/* Each action says what it does to the URL already shared —
                        that is the only difference that matters between them. */}
                    <button className={item} aria-label="Extend this link" onClick={() => { setOpen(false); onExtend() }}>
                        <CalendarPlus className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" />
                        <span>
                            <span className="font-medium text-ink block">Extend</span>
                            <span className="text-ink-muted">
                                {invite.maxUses === null
                                    ? '30 more days. The URL you shared keeps working.'
                                    : '30 more days and 5 more seats. The URL you shared keeps working.'}
                            </span>
                        </span>
                    </button>
                    <button className={item} aria-label="Issue a new URL" onClick={() => { setOpen(false); onRegenerate() }}>
                        <RotateCw className="w-3.5 h-3.5 mt-0.5 shrink-0 text-ink-muted" />
                        <span>
                            <span className="font-medium text-ink block">New URL</span>
                            <span className="text-ink-muted">
                                Same invitation, new address. Every URL already sent stops working.
                            </span>
                        </span>
                    </button>
                    <div className="border-t border-glass-border" />
                    <button
                        className={cn(item, 'text-red-600 dark:text-red-400')}
                        aria-label="Revoke this link"
                        onClick={() => { setOpen(false); onRevoke() }}
                    >
                        <Ban className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                        <span>
                            <span className="font-medium block">Revoke</span>
                            <span className="text-ink-muted">
                                Stops working for everyone, immediately.
                            </span>
                        </span>
                    </button>
                </Popover.Content>
            </Popover.Portal>
        </Popover.Root>
    )
}

/** Empty states that say what to do next, not just that there is nothing
 *  here. "No revoked links" is good news and should read as such; an
 *  empty Active tab when other links exist is a wrong-tab problem, not an
 *  empty estate. */
function EmptyState({
    status, hasAny, onShowAll,
}: {
    status: Status | 'all'
    hasAny: boolean
    onShowAll: () => void
}) {
    const copy: Record<string, { title: string; body: string }> = {
        active: {
            title: 'No links are active right now',
            body: 'Use “Invite by Link” to create one. It will appear here so you can track and revoke it.',
        },
        revoked: { title: 'Nothing has been revoked', body: 'Links you kill will be listed here.' },
        expired: { title: 'Nothing has expired', body: 'Links that run out of time will be listed here.' },
        exhausted: { title: 'No link has run out of seats', body: 'Capped links that fill up will be listed here.' },
        all: {
            title: 'No invite links yet',
            body: 'Use “Invite by Link” to create one. Every link you create is tracked here — who used it, and when.',
        },
    }
    const { title, body } = copy[status] ?? copy.all

    return (
        <div className="text-center py-12 px-6">
            <div className="w-12 h-12 mx-auto mb-3 rounded-2xl bg-black/[0.03] dark:bg-white/[0.04] flex items-center justify-center">
                <Link2 className="w-5 h-5 text-ink-muted/50" />
            </div>
            <p className="text-sm font-medium text-ink">{title}</p>
            <p className="text-xs text-ink-muted mt-1 max-w-xs mx-auto leading-relaxed">{body}</p>
            {hasAny && status !== 'all' && (
                <button
                    onClick={onShowAll}
                    className="mt-3 text-xs font-medium text-accent-lineage hover:underline"
                >
                    Show all links
                </button>
            )}
        </div>
    )
}
