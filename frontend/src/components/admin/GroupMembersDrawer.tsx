/**
 * GroupMembersDrawer — who is in a group, as the first thing you see.
 *
 * Replaces `ManageMembersModal`, which was an EDITING tool doing a READING
 * job: a two-column add/remove grid in a `max-w-2xl` box, reachable only
 * through the "Manage members" button. Answering "who is in this group"
 * meant entering an edit flow and reading the left half of it.
 *
 * So the list is the surface now — full width, searchable, with faces —
 * and adding people is a panel that folds out of the header. One surface,
 * not two that drift.
 *
 * IT ALSO STOPS ASKING THE WRONG ENDPOINT. The modal resolved member
 * identities by fetching the entire admin user list and joining in JS,
 * which was wrong twice: that list returns its 50 newest accounts, so an
 * older member rendered as a bare `usr_…` id, and it is gated on
 * `system:admin` — which `org_admin` does not hold, so a delegated groups
 * admin got a 403 inside the `Promise.all` and BOTH panes sat spinning
 * forever. `listMembers` now carries the names itself, and the picker uses
 * the same signed-in-user directory the share dialog does.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Users, UserPlus, UserMinus, X, Search, Loader2, Mail, Cloud,
    Plus, AlertCircle, RefreshCw,
} from 'lucide-react'
import {
    groupsService,
    type GroupResponse,
    type GroupMemberResponse,
} from '@/services/groupsService'
import { searchDirectory, type DirectoryUser } from '@/services/userDirectoryService'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { useModalA11y } from '@/hooks/useModalA11y'
import { Backdrop } from '@/components/ui/Backdrop'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { avatarGradient, initialsOf } from '@/lib/avatar'
import { timeAgo } from '@/lib/timeAgo'
import { cn } from '@/lib/utils'


export function GroupMembersDrawer({
    group, canManage, onClose, onChanged,
}: {
    /** `null` means closed — mirrors AdminUsers' `accessUser`, and lets the
     *  parent mount this unconditionally so the exit animation can play. */
    group: GroupResponse | null
    canManage: boolean
    /** MUST be referentially stable: `useModalA11y` depends on it and
     *  re-focuses the panel whenever it changes, which would yank focus out
     *  of the filter box on every keystroke. */
    onClose: () => void
    /** The group list owns memberCount and the row's avatar stack. */
    onChanged: () => void
}) {
    const [members, setMembers] = useState<GroupMemberResponse[] | null>(null)
    const [loadFailed, setLoadFailed] = useState(false)
    const [filter, setFilter] = useState('')
    const [busy, setBusy] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const [query, setQuery] = useState('')
    const [results, setResults] = useState<DirectoryUser[] | null>(null)
    const { notify } = useAppNotifications()

    const dialogRef = useModalA11y(!!group, onClose)
    const isScim = group?.source === 'scim'
    const canEdit = canManage && !isScim

    const groupId = group?.id
    const groupName = group?.name

    const load = useCallback(async () => {
        if (!groupId) return
        setLoadFailed(false)
        try {
            setMembers(await groupsService.listMembers(groupId))
        } catch (err) {
            setMembers(null)
            setLoadFailed(true)
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not load the members of "${groupName}".`)
        }
    }, [groupId, groupName, notify])

    // Opening a (possibly different) group starts from scratch.
    useEffect(() => {
        if (!groupId) return
        setMembers(null)
        setFilter('')
        setAdding(false)
        setQuery('')
        setResults(null)
        void load()
    }, [groupId, load])

    // The picker searches the directory server-side — the same source the
    // share dialog uses, and open to any signed-in user.
    const debouncedQuery = useDebouncedValue(query, 250)
    useEffect(() => {
        if (!adding) return
        let cancelled = false
        setResults(null)
        void searchDirectory(debouncedQuery, { types: ['user'], limit: 25 })
            .then(r => { if (!cancelled) setResults(r.users) })
            .catch(() => { if (!cancelled) setResults([]) })
        return () => { cancelled = true }
    }, [adding, debouncedQuery])

    const memberIds = useMemo(
        () => new Set((members ?? []).map(m => m.userId)),
        [members],
    )
    const shown = useMemo(() => {
        const q = filter.trim().toLowerCase()
        if (!q) return members ?? []
        return (members ?? []).filter(m =>
            (m.displayName ?? m.userId).toLowerCase().includes(q)
            || (m.email ?? '').toLowerCase().includes(q))
    }, [members, filter])
    const candidates = useMemo(
        () => (results ?? []).filter(u => !memberIds.has(u.id)),
        [results, memberIds],
    )

    async function remove(m: GroupMemberResponse) {
        if (!group) return
        const name = m.displayName ?? m.userId
        setBusy(m.userId)
        try {
            await groupsService.removeMember(group.id, m.userId)
            await load()
            onChanged()
            notify('success', `Removed ${name} from "${group.name}".`)
        } catch (err) {
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not remove ${name} from "${group.name}".`)
        } finally {
            setBusy(null)
        }
    }

    async function add(u: DirectoryUser) {
        if (!group) return
        setBusy(u.id)
        try {
            await groupsService.addMember(group.id, u.id)
            await load()
            onChanged()
            notify('success', `Added ${u.displayName} to "${group.name}".`)
        } catch (err) {
            notify('error', err instanceof Error && err.message
                ? err.message
                : `Could not add ${u.displayName} to "${group.name}".`)
        } finally {
            setBusy(null)
        }
    }

    return (
        <>
            {/* Plain CSS scrim, never inside AnimatePresence — a stranded
                fixed-inset-0 node would shield the viewport. No blur: it is
                recomputed every frame while the panel slides. */}
            <Backdrop open={!!group} onClick={onClose} zClassName="z-40" className="bg-black/40" />
            <AnimatePresence>
                {group && (
                    <motion.div
                        key="group-members-drawer"
                        ref={dialogRef}
                        tabIndex={-1}
                        role="dialog"
                        aria-modal="true"
                        aria-label={`Members of ${group.name}`}
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                        style={{ willChange: 'transform' }}
                        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-lg bg-canvas-elevated border-l border-glass-border shadow-xl flex flex-col focus:outline-none"
                    >
                        {/* ── Header — the group's own avatar, so the drawer
                            visibly belongs to the row you clicked. ── */}
                        <div className="flex items-start gap-3 px-5 py-4 border-b border-glass-border shrink-0">
                            <div className={cn(
                                'w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm',
                                avatarGradient(group.name),
                            )}>
                                {initialsOf(group.name)}
                            </div>
                            <div className="min-w-0 flex-1">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-ink-muted">
                                    Group members
                                </p>
                                <h2 className="text-base font-bold text-ink truncate">{group.name}</h2>
                                <p className="text-[11px] text-ink-muted truncate">
                                    {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
                                    {group.description ? ` · ${group.description}` : ''}
                                </p>
                            </div>
                            {canEdit && (
                                <button
                                    onClick={() => setAdding(v => !v)}
                                    title="Add members"
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 hover:bg-violet-500/20 transition-colors shrink-0"
                                >
                                    <UserPlus className="w-3.5 h-3.5" />
                                    Add
                                </button>
                            )}
                            <button
                                onClick={onClose}
                                title="Close"
                                className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>

                        {/* ── The identity provider owns this membership ── */}
                        {isScim && (
                            <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-xl border border-violet-500/20 bg-violet-500/10 p-3 text-[11px] text-violet-700 dark:text-violet-300 shrink-0">
                                <Cloud className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>
                                    SCIM-synced group. Membership is managed through your identity
                                    provider — local edits are overwritten on the next sync.
                                </span>
                            </div>
                        )}

                        {/* ── Add panel, folded out of the header ── */}
                        <AnimatePresence initial={false}>
                            {adding && canEdit && (
                                <motion.div
                                    key="add-panel"
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.18 }}
                                    className="overflow-hidden border-b border-glass-border shrink-0"
                                >
                                    <div className="px-5 py-4 bg-black/[0.02] dark:bg-white/[0.02]">
                                        <div className="relative mb-2">
                                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                                            <input
                                                type="text"
                                                autoFocus
                                                placeholder="Search people by name or email…"
                                                aria-label="Search people to add"
                                                value={query}
                                                onChange={e => setQuery(e.target.value)}
                                                className="input pl-9 h-9 w-full text-sm"
                                            />
                                        </div>
                                        <div className="rounded-xl border border-glass-border max-h-56 overflow-y-auto custom-scrollbar">
                                            {results === null ? (
                                                <div className="p-5 text-center text-ink-muted text-sm">
                                                    <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                                                    Searching…
                                                </div>
                                            ) : candidates.length === 0 ? (
                                                <div className="p-5 text-center text-xs text-ink-muted">
                                                    {query
                                                        ? 'Nobody matches that search.'
                                                        : 'Everyone found is already a member.'}
                                                </div>
                                            ) : candidates.map(u => (
                                                <button
                                                    key={u.id}
                                                    onClick={() => void add(u)}
                                                    disabled={busy === u.id}
                                                    className="w-full flex items-center gap-2.5 px-3 py-2 border-b last:border-b-0 border-glass-border text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.04] transition-colors disabled:opacity-50"
                                                >
                                                    <UserAvatar
                                                        userId={u.id}
                                                        name={u.displayName}
                                                        shape="gradient"
                                                        className="w-8 h-8 text-[10px] font-bold"
                                                    />
                                                    <div className="min-w-0 flex-1">
                                                        <p className="text-sm text-ink truncate">{u.displayName}</p>
                                                        <p className="text-[11px] text-ink-muted truncate">{u.email}</p>
                                                    </div>
                                                    {busy === u.id
                                                        ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted shrink-0" />
                                                        : <Plus className="w-3.5 h-3.5 text-accent-lineage shrink-0" />}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {/* ── Filter — only once there is a list worth filtering ── */}
                        {(members?.length ?? 0) > 0 && (
                            <div className="px-5 py-3 border-b border-glass-border shrink-0">
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                                    <input
                                        type="text"
                                        placeholder="Filter members by name or email…"
                                        aria-label="Filter members"
                                        value={filter}
                                        onChange={e => setFilter(e.target.value)}
                                        className="input pl-9 h-9 w-full text-sm"
                                    />
                                </div>
                            </div>
                        )}

                        {/* ── The list ── */}
                        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                            {loadFailed ? (
                                /* A spinner that never ends was the old failure
                                   mode. Say so, and offer the retry. */
                                <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                                    <div className="w-16 h-16 rounded-2xl bg-red-500/10 flex items-center justify-center mb-4">
                                        <AlertCircle className="w-7 h-7 text-red-500/70" />
                                    </div>
                                    <p className="text-sm font-medium text-ink-secondary mb-1">
                                        Members could not be loaded
                                    </p>
                                    <p className="text-xs text-ink-muted max-w-xs mb-5">
                                        The request for this group's membership did not come back.
                                    </p>
                                    <button
                                        onClick={() => void load()}
                                        className="flex items-center gap-2 px-4 py-2 rounded-xl border border-glass-border text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                    >
                                        <RefreshCw className="w-4 h-4" />
                                        Try again
                                    </button>
                                </div>
                            ) : members === null ? (
                                <MemberSkeleton />
                            ) : members.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
                                    <div className="w-16 h-16 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mb-4">
                                        <Users className="w-7 h-7 text-ink-muted" />
                                    </div>
                                    <p className="text-sm font-medium text-ink-secondary mb-1">No members yet</p>
                                    <p className="text-xs text-ink-muted max-w-xs mb-5">
                                        Add people to {group.name} and they inherit every role bound
                                        to it, in every workspace.
                                    </p>
                                    {canEdit && (
                                        <button
                                            onClick={() => setAdding(true)}
                                            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-600 text-white text-sm font-semibold shadow-sm shadow-violet-500/20"
                                        >
                                            <UserPlus className="w-4 h-4" />
                                            Add the first member
                                        </button>
                                    )}
                                </div>
                            ) : shown.length === 0 ? (
                                <div className="py-12 px-6 text-center">
                                    <p className="text-sm text-ink-secondary mb-1">
                                        No members match “{filter}”.
                                    </p>
                                    <button
                                        onClick={() => setFilter('')}
                                        className="text-xs font-medium text-accent-lineage hover:underline"
                                    >
                                        Clear filter
                                    </button>
                                </div>
                            ) : shown.map(m => (
                                <MemberRow
                                    key={m.userId}
                                    member={m}
                                    canEdit={canEdit}
                                    busy={busy === m.userId}
                                    onRemove={() => void remove(m)}
                                />
                            ))}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </>
    )
}


// ── Pieces ───────────────────────────────────────────────────────────

function MemberRow({
    member: m, canEdit, busy, onRemove,
}: {
    member: GroupMemberResponse
    canEdit: boolean
    busy: boolean
    onRemove: () => void
}) {
    // An id the server could not resolve stays an id. A membership row whose
    // account is gone is a real state the admin needs to see (and remove);
    // inventing "Unknown user" over it would claim a fact nobody has.
    const resolved = !!m.displayName
    const name = m.displayName ?? m.userId

    return (
        <div className="group/member flex items-center gap-3 px-5 py-3 border-b last:border-b-0 border-glass-border transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]">
            {resolved ? (
                <UserAvatar
                    userId={m.userId}
                    name={name}
                    shape="gradient"
                    className="w-9 h-9 text-[11px] font-bold shadow-sm"
                />
            ) : (
                <span
                    aria-hidden
                    className="w-9 h-9 rounded-full shrink-0 grid place-items-center text-[11px] font-bold bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted"
                >
                    ?
                </span>
            )}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    <p className={cn(
                        'truncate',
                        resolved
                            ? 'text-sm font-semibold text-ink'
                            : 'font-mono text-[11px] text-ink-secondary',
                    )}>
                        {name}
                    </p>
                    {m.source === 'sso' && (
                        <span
                            title="Added by the identity provider through a group mapping. Removing them by hand only lasts until their next sign-in — remove the mapping, or the group in the directory, instead."
                            className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-violet-500/15 text-violet-600 dark:text-violet-400"
                        >
                            SSO
                        </span>
                    )}
                    {m.deleted ? (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                            Deleted
                        </span>
                    ) : m.status && m.status !== 'active' && (
                        <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400">
                            {m.status}
                        </span>
                    )}
                </div>
                {m.email ? (
                    <a
                        href={`mailto:${m.email}`}
                        className="mt-0.5 flex items-center gap-1 text-[11px] text-ink-muted hover:text-accent-lineage transition-colors"
                    >
                        <Mail className="w-3 h-3 shrink-0" />
                        <span className="truncate">{m.email}</span>
                    </a>
                ) : resolved && (
                    <p className="mt-0.5 font-mono text-[10px] text-ink-muted truncate">{m.userId}</p>
                )}
            </div>
            <span className="hidden sm:block text-[11px] text-ink-muted shrink-0">
                {timeAgo(m.addedAt)}
            </span>
            {canEdit && (
                <button
                    onClick={onRemove}
                    disabled={busy}
                    title="Remove from group"
                    /* focus-visible, not hover alone: the old button was a
                       focusable control that never became visible. */
                    className="opacity-0 group-hover/member:opacity-100 focus-visible:opacity-100 p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-all disabled:opacity-50 shrink-0"
                >
                    {busy
                        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        : <UserMinus className="w-3.5 h-3.5" />}
                </button>
            )}
        </div>
    )
}

/** Row-shaped placeholders, so the drawer has weight before the list lands. */
function MemberSkeleton() {
    return (
        <div className="p-5 space-y-2 animate-pulse">
            {[0, 1, 2, 3, 4].map(i => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-glass-border p-3">
                    <div className="w-9 h-9 rounded-full bg-black/[0.06] dark:bg-white/[0.08] shrink-0" />
                    <div className="flex-1 space-y-1.5">
                        <div className="h-3 w-32 rounded bg-black/[0.06] dark:bg-white/[0.08]" />
                        <div className="h-2.5 w-44 rounded bg-black/[0.04] dark:bg-white/[0.06]" />
                    </div>
                </div>
            ))}
        </div>
    )
}
