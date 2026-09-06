/**
 * WorkspaceAccessList — who can actually get into this workspace, and how.
 *
 * The Members table lists BINDINGS: a group bound here is one row, and to
 * learn who that lets in you had to open the group somewhere else. This is
 * the resolved answer — every distinct person with access, flattened across
 * their direct binding(s) and every bound group they belong to, each row
 * expandable to the exact route(s) that got them there. A person in three
 * bound groups (and maybe bound directly too) is ONE row with a grant each.
 *
 * Borrows the member-row visuals from ``GroupMembersDrawer`` so a person
 * reads the same on both surfaces.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Users, Search, Loader2, X, Mail, ChevronRight, UserCheck, Users2,
    Shield, RefreshCw, AlertCircle,
} from 'lucide-react'
import {
    workspaceMembersService,
    type WorkspaceAccessUser,
    type WorkspaceAccessGrant,
} from '@/services/workspaceMembersService'
import { useAppNotifications } from '@/components/ui/notifications'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { cn } from '@/lib/utils'
import { roleVisualFor, isBuiltinRole } from '@/lib/roleVisual'


function roleLabel(role: string): string {
    return isBuiltinRole(role) ? roleVisualFor(role).label : role
}


function RoleBadge({ role, className }: { role: string; className?: string }) {
    const v = roleVisualFor(role)
    const Icon = v.icon
    return (
        <span className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0',
            v.badge, className,
        )}>
            <Icon className="w-2.5 h-2.5" />
            {roleLabel(role)}
        </span>
    )
}


/** One route to a user's access, in the expanded panel. */
function GrantRow({ grant }: { grant: WorkspaceAccessGrant }) {
    return (
        <div className="flex items-center gap-2 py-1.5">
            {grant.via === 'direct' ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary">
                    <UserCheck className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                    Bound directly
                </span>
            ) : (
                <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-ink-secondary min-w-0">
                    <Users2 className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                    via
                    <span className="font-semibold text-ink truncate">
                        {grant.groupName ?? grant.groupId}
                    </span>
                </span>
            )}
            <span className="text-ink-muted">·</span>
            <RoleBadge role={grant.role} />
            {grant.expiresAt && (
                <span className="text-[10px] text-amber-600 dark:text-amber-400 shrink-0">
                    expires {new Date(grant.expiresAt).toLocaleDateString()}
                </span>
            )}
        </div>
    )
}


function AccessRow({ user }: { user: WorkspaceAccessUser }) {
    const [open, setOpen] = useState(false)
    const resolved = !!user.displayName
    const name = user.displayName ?? user.userId
    const groupCount = user.grants.filter(g => g.via === 'group').length
    const hasDirect = user.grants.some(g => g.via === 'direct')

    // A one-line summary of HOW they have access, before expanding.
    const viaSummary: string = (() => {
        const parts: string[] = []
        if (hasDirect) parts.push('Direct')
        if (groupCount === 1) {
            const g = user.grants.find(x => x.via === 'group')
            parts.push(`via ${g?.groupName ?? 'a group'}`)
        } else if (groupCount > 1) {
            parts.push(`via ${groupCount} groups`)
        }
        return parts.join(' · ')
    })()

    return (
        <div className="border-b last:border-b-0 border-glass-border">
            <button
                onClick={() => setOpen(o => !o)}
                className="w-full flex items-center gap-3 px-5 py-3 text-left transition-colors hover:bg-black/[0.02] dark:hover:bg-white/[0.03]"
            >
                <ChevronRight className={cn(
                    'w-4 h-4 text-ink-muted shrink-0 transition-transform',
                    open && 'rotate-90',
                )} />
                {resolved ? (
                    <UserAvatar
                        userId={user.userId}
                        avatarId={user.avatarId ?? undefined}
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
                            resolved ? 'text-sm font-semibold text-ink' : 'font-mono text-[11px] text-ink-secondary',
                        )}>
                            {name}
                        </p>
                        {user.deleted && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                                Deleted
                            </span>
                        )}
                        {!user.deleted && user.status && user.status !== 'active' && (
                            <span className="shrink-0 px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                {user.status}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 min-w-0">
                        {user.email ? (
                            <span className="flex items-center gap-1 text-[11px] text-ink-muted min-w-0">
                                <Mail className="w-3 h-3 shrink-0" />
                                <span className="truncate">{user.email}</span>
                            </span>
                        ) : (
                            <span className="text-[11px] text-ink-muted truncate">{viaSummary}</span>
                        )}
                        {user.email && viaSummary && (
                            <>
                                <span className="text-ink-muted">·</span>
                                <span className="text-[11px] text-ink-muted truncate">{viaSummary}</span>
                            </>
                        )}
                    </div>
                </div>
                {/* Effective role badge, plus a count when there is more than one. */}
                <div className="flex items-center gap-1.5 shrink-0">
                    <RoleBadge role={user.effectiveRole} />
                    {user.roles.length > 1 && (
                        <span
                            title={user.roles.map(roleLabel).join(', ')}
                            className="text-[10px] font-semibold text-ink-muted"
                        >
                            +{user.roles.length - 1}
                        </span>
                    )}
                </div>
            </button>

            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.18 }}
                        className="overflow-hidden"
                    >
                        <div className="pl-16 pr-5 pb-3 pt-0.5">
                            <p className="text-[10px] uppercase tracking-wider font-bold text-ink-muted mb-1">
                                How they have access
                            </p>
                            <div className="divide-y divide-glass-border">
                                {user.grants.map((g, i) => (
                                    <GrantRow key={`${g.bindingId}-${i}`} grant={g} />
                                ))}
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}


export function WorkspaceAccessList({ workspaceId }: { workspaceId: string }) {
    const [users, setUsers] = useState<WorkspaceAccessUser[] | null>(null)
    const [totals, setTotals] = useState<{ total: number; direct: number; viaGroup: number }>(
        { total: 0, direct: 0, viaGroup: 0 },
    )
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const { notify } = useAppNotifications()

    const fetchAccess = useCallback(async () => {
        // First statement is the await, so this never sets state
        // synchronously when called straight from an effect.
        try {
            const data = await workspaceMembersService.listEffective(workspaceId)
            setUsers(data.users)
            setTotals({ total: data.totalUsers, direct: data.directUsers, viaGroup: data.viaGroupUsers })
            setError(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to load access list'
            setError(msg)
            notify('error', msg)
        }
    }, [workspaceId, notify])

    useEffect(() => { void fetchAccess() }, [fetchAccess])

    // A binding change anywhere (this tab or another) reshapes who has
    // access — re-resolve in place, same as the bindings table does.
    useEffect(() => {
        const onChange = () => { void fetchAccess() }
        window.addEventListener('permissions:changed', onChange)
        return () => window.removeEventListener('permissions:changed', onChange)
    }, [fetchAccess])

    const shown = useMemo(() => {
        const list = users ?? []
        const q = search.trim().toLowerCase()
        if (!q) return list
        return list.filter(u =>
            (u.displayName ?? u.userId).toLowerCase().includes(q)
            || (u.email ?? '').toLowerCase().includes(q)
            || u.grants.some(g => (g.groupName ?? '').toLowerCase().includes(q))
            || u.roles.some(r => roleLabel(r).toLowerCase().includes(q)),
        )
    }, [users, search])

    return (
        <div className="space-y-4">
            {/* Intro + totals */}
            <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500/20 to-sky-500/20 border border-emerald-500/20 flex items-center justify-center shrink-0">
                    <UserCheck className="w-4 h-4 text-emerald-500" />
                </div>
                <div className="flex-1 min-w-0">
                    <h3 className="text-base font-bold text-ink">Everyone with access</h3>
                    <p className="text-sm text-ink-secondary leading-relaxed mt-0.5">
                        Every person who can reach this workspace, resolved across direct
                        bindings and every group. Expand a row to see the exact route —
                        direct, or via which group — for each role they hold.
                    </p>
                </div>
                <button
                    onClick={() => void fetchAccess()}
                    className="px-3 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl text-ink transition-colors shrink-0"
                    title="Refresh"
                >
                    <RefreshCw className={cn('w-4 h-4', users === null && 'animate-spin')} />
                </button>
            </div>

            {/* Totals strip */}
            <div className="grid grid-cols-3 gap-3">
                <StatChip icon={Users} label="People" value={totals.total} accent="text-emerald-600 dark:text-emerald-400" iconBg="bg-emerald-500/10 text-emerald-500 border-emerald-500/20" />
                <StatChip icon={UserCheck} label="Bound directly" value={totals.direct} accent="text-sky-600 dark:text-sky-400" iconBg="bg-sky-500/10 text-sky-500 border-sky-500/20" />
                <StatChip icon={Users2} label="Via a group" value={totals.viaGroup} accent="text-violet-600 dark:text-violet-400" iconBg="bg-violet-500/10 text-violet-500 border-violet-500/20" />
            </div>

            {/* Search */}
            <div className="relative max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                <input
                    type="text"
                    placeholder="Search people, groups, roles…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    className="input pl-9 h-9 text-sm bg-white/50 dark:bg-black/20 w-full"
                />
                {search && (
                    <button
                        onClick={() => setSearch('')}
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* List */}
            {error ? (
                <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 flex items-start gap-3">
                    <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-red-600 dark:text-red-400">Couldn't load the access list</p>
                        <p className="text-xs text-ink-muted mt-0.5">{error}</p>
                    </div>
                    <button onClick={() => void fetchAccess()} className="text-xs font-semibold text-red-600 dark:text-red-400 hover:underline">
                        Retry
                    </button>
                </div>
            ) : users === null ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated py-16 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
                </div>
            ) : shown.length === 0 ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated py-16 flex flex-col items-center justify-center text-center">
                    <div className="w-14 h-14 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mb-3">
                        {search ? <Search className="w-6 h-6 text-ink-muted" /> : <Shield className="w-6 h-6 text-ink-muted" />}
                    </div>
                    <p className="text-sm font-medium text-ink-secondary mb-1">
                        {search ? 'No one matches that search' : 'No one has access yet'}
                    </p>
                    <p className="text-xs text-ink-muted max-w-sm">
                        {search
                            ? 'Try a different name, group, or role.'
                            : 'Bind a user or group in the Bindings tab to grant access.'}
                    </p>
                </div>
            ) : (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    {shown.map(u => <AccessRow key={u.userId} user={u} />)}
                </div>
            )}
        </div>
    )
}


function StatChip({
    icon: Icon, label, value, accent, iconBg,
}: {
    icon: typeof Users
    label: string
    value: number
    accent: string
    iconBg: string
}) {
    return (
        <div className="border border-glass-border rounded-xl p-3 bg-canvas-elevated flex items-center gap-3">
            <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0', iconBg)}>
                <Icon className="w-4 h-4" />
            </div>
            <div className="min-w-0">
                <p className={cn('text-lg font-bold leading-none', accent)}>{value}</p>
                <p className="text-[11px] text-ink-muted mt-1 truncate">{label}</p>
            </div>
        </div>
    )
}
