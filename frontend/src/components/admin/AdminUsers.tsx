/**
 * AdminUsers — User management panel inside the admin console.
 *
 * KPI summary cards + rich user table with inline actions:
 * - Approve / reject pending signups
 * - Change user role (admin / user / viewer)
 * - Suspend / reactivate users
 * - Admin password reset (direct or generate token)
 * - Password reset request notifications
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Users, CheckCircle2, XCircle, Clock, Shield, AlertCircle,
    RefreshCw, Search, UserPlus, Ban, X, Loader2, Mail,
    ChevronDown, ChevronUp, KeyRound, Eye, UserCog,
    RotateCcw, Lock, Copy, Check, Link2,
} from 'lucide-react'
import { adminUserService, type AdminUserResponse, type InviteResponse } from '@/services/adminUserService'
import { cn } from '@/lib/utils'

// ── Types & constants ────────────────────────────────────────────────

type StatusFilter = 'all' | 'pending' | 'active' | 'suspended'
type SortField = 'name' | 'email' | 'status' | 'role' | 'createdAt'
type SortDir = 'asc' | 'desc'
type ModalType =
    | { kind: 'reject'; userId: string; name: string }
    | { kind: 'role'; userId: string; name: string; currentRole: string }
    | { kind: 'suspend'; userId: string; name: string }
    | { kind: 'resetPassword'; userId: string; name: string }
    | { kind: 'invite' }
    | null

const STATUS_TABS: { value: StatusFilter; label: string; icon: typeof Clock }[] = [
    { value: 'all', label: 'All Users', icon: Users },
    { value: 'pending', label: 'Pending', icon: Clock },
    { value: 'active', label: 'Active', icon: CheckCircle2 },
    { value: 'suspended', label: 'Suspended', icon: Ban },
]

const STATUS_CONFIG: Record<string, { badge: string; dot: string; label: string }> = {
    pending: {
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        dot: 'bg-amber-500',
        label: 'Pending Approval',
    },
    active: {
        badge: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
        dot: 'bg-emerald-500',
        label: 'Active',
    },
    suspended: {
        badge: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20',
        dot: 'bg-red-500',
        label: 'Suspended',
    },
}

const ROLE_CONFIG: Record<string, { icon: typeof Shield; color: string; iconBg: string }> = {
    admin: {
        icon: Shield,
        color: 'text-accent-lineage font-semibold',
        iconBg: 'text-accent-lineage',
    },
    user: {
        icon: UserCog,
        color: 'text-sky-600 dark:text-sky-400',
        iconBg: 'text-sky-500',
    },
    viewer: {
        icon: Eye,
        color: 'text-ink-secondary',
        iconBg: 'text-ink-muted',
    },
}

const AVAILABLE_ROLES = [
    { value: 'admin', label: 'Administrator', description: 'Full system access', icon: Shield },
    { value: 'user', label: 'User', description: 'Standard workspace access', icon: UserCog },
    { value: 'viewer', label: 'Viewer', description: 'Read-only access', icon: Eye },
]

const KPI_CARDS = [
    { key: 'total', label: 'Total Users', icon: Users, gradient: 'from-indigo-500/20 to-indigo-500/0', accent: 'text-indigo-600 dark:text-indigo-400', iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20' },
    { key: 'pending', label: 'Pending Approval', icon: Clock, gradient: 'from-amber-500/20 to-amber-500/0', accent: 'text-amber-600 dark:text-amber-400', iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20' },
    { key: 'active', label: 'Active Users', icon: CheckCircle2, gradient: 'from-emerald-500/20 to-emerald-500/0', accent: 'text-emerald-600 dark:text-emerald-400', iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20' },
    { key: 'admins', label: 'Administrators', icon: Shield, gradient: 'from-violet-500/20 to-violet-500/0', accent: 'text-violet-600 dark:text-violet-400', iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20' },
]

// ── Helpers ───────────────────────────────────────────────────────────

function getInitials(first: string, last: string): string {
    return `${(first || '?')[0]}${(last || '?')[0]}`.toUpperCase()
}

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function timeAgo(iso: string): string {
    const diff = Date.now() - new Date(iso).getTime()
    const mins = Math.floor(diff / 60000)
    if (mins < 1) return 'Just now'
    if (mins < 60) return `${mins}m ago`
    const hrs = Math.floor(mins / 60)
    if (hrs < 24) return `${hrs}h ago`
    const days = Math.floor(hrs / 24)
    if (days < 30) return `${days}d ago`
    return formatDate(iso)
}

const AVATAR_COLORS = [
    'from-indigo-500 to-violet-500',
    'from-emerald-500 to-teal-500',
    'from-amber-500 to-orange-500',
    'from-rose-500 to-pink-500',
    'from-sky-500 to-blue-500',
    'from-fuchsia-500 to-purple-500',
]

function avatarGradient(name: string): string {
    let hash = 0
    for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash)
    return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length]
}

// ── Sortable column header ───────────────────────────────────────────

function SortHeader({ label, field, current, dir, onSort }: {
    label: string; field: SortField; current: SortField; dir: SortDir; onSort: (f: SortField) => void
}) {
    const isActive = current === field
    return (
        <button
            onClick={() => onSort(field)}
            className={cn(
                "flex items-center gap-1 text-left text-xs font-semibold uppercase tracking-wider transition-colors",
                isActive ? "text-ink" : "text-ink-muted hover:text-ink-secondary"
            )}
        >
            {label}
            {isActive && (dir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
        </button>
    )
}

// ── Main component ───────────────────────────────────────────────────

export function AdminUsers() {
    const [users, setUsers] = useState<AdminUserResponse[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [successMsg, setSuccessMsg] = useState<string | null>(null)
    const [filter, setFilter] = useState<StatusFilter>('all')
    const [search, setSearch] = useState('')
    const [sortField, setSortField] = useState<SortField>('createdAt')
    const [sortDir, setSortDir] = useState<SortDir>('desc')
    const [actionLoading, setActionLoading] = useState<string | null>(null)

    // Modal state (unified)
    const [modal, setModal] = useState<ModalType>(null)
    const [modalInput, setModalInput] = useState('')
    const [selectedRole, setSelectedRole] = useState('')

    // Reset token display
    const [generatedToken, setGeneratedToken] = useState<{ token: string; expiresAt: string } | null>(null)
    const [tokenCopied, setTokenCopied] = useState(false)

    // Reset password mode: 'direct' or 'token'
    const [resetMode, setResetMode] = useState<'direct' | 'token'>('token')

    // Invite state
    const [inviteRole, setInviteRole] = useState('user')
    const [inviteResult, setInviteResult] = useState<InviteResponse | null>(null)
    const [inviteCopied, setInviteCopied] = useState(false)
    const [inviteLoading, setInviteLoading] = useState(false)

    // ── Data fetching ────────────────────────────────────────────────

    const fetchUsers = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const data = await adminUserService.listUsers()
            setUsers(data)
        } catch (err: any) {
            setError(err.message || 'Failed to load users')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { fetchUsers() }, [fetchUsers])

    // Auto-dismiss success message
    useEffect(() => {
        if (!successMsg) return
        const t = setTimeout(() => setSuccessMsg(null), 4000)
        return () => clearTimeout(t)
    }, [successMsg])

    // ── KPI computation ──────────────────────────────────────────────

    const kpis = useMemo(() => ({
        total: users.length,
        pending: users.filter(u => u.status === 'pending').length,
        active: users.filter(u => u.status === 'active').length,
        admins: users.filter(u => u.role === 'admin').length,
    }), [users])

    const resetRequestCount = useMemo(() => users.filter(u => u.resetRequested).length, [users])

    // ── Filtering, search, sort ──────────────────────────────────────

    const processedUsers = useMemo(() => {
        let list = [...users]
        if (filter !== 'all') list = list.filter(u => u.status === filter)
        if (search) {
            const q = search.toLowerCase()
            list = list.filter(u =>
                u.displayName.toLowerCase().includes(q) ||
                u.email.toLowerCase().includes(q) ||
                u.role.toLowerCase().includes(q)
            )
        }
        list.sort((a, b) => {
            let cmp = 0
            switch (sortField) {
                case 'name': cmp = a.displayName.localeCompare(b.displayName); break
                case 'email': cmp = a.email.localeCompare(b.email); break
                case 'status': cmp = a.status.localeCompare(b.status); break
                case 'role': cmp = a.role.localeCompare(b.role); break
                case 'createdAt': cmp = a.createdAt.localeCompare(b.createdAt); break
            }
            return sortDir === 'asc' ? cmp : -cmp
        })
        return list
    }, [users, filter, search, sortField, sortDir])

    // ── Actions ──────────────────────────────────────────────────────

    const withAction = async (userId: string, fn: () => Promise<unknown>, msg?: string) => {
        setActionLoading(userId)
        setError(null)
        try {
            await fn()
            if (msg) setSuccessMsg(msg)
            await fetchUsers()
        } catch (err: any) {
            setError(err.message)
        } finally {
            setActionLoading(null)
        }
    }

    const handleApprove = (userId: string) =>
        withAction(userId, () => adminUserService.approveUser(userId), 'User approved successfully')

    const handleRejectConfirm = async () => {
        if (modal?.kind !== 'reject') return
        await withAction(modal.userId, () =>
            adminUserService.rejectUser(modal.userId, modalInput || undefined), 'User rejected')
        closeModal()
    }

    const handleSuspendConfirm = async () => {
        if (modal?.kind !== 'suspend') return
        await withAction(modal.userId, () =>
            adminUserService.suspendUser(modal.userId), 'User suspended')
        closeModal()
    }

    const handleReactivate = (userId: string) =>
        withAction(userId, () => adminUserService.reactivateUser(userId), 'User reactivated')

    const handleRoleChange = async () => {
        if (modal?.kind !== 'role' || !selectedRole) return
        await withAction(modal.userId, () =>
            adminUserService.changeRole(modal.userId, selectedRole), `Role changed to ${selectedRole}`)
        closeModal()
    }

    const handleResetPassword = async () => {
        if (modal?.kind !== 'resetPassword') return
        if (resetMode === 'direct') {
            if (!modalInput || modalInput.length < 8) {
                setError('Password must be at least 8 characters')
                return
            }
            await withAction(modal.userId, () =>
                adminUserService.resetPassword(modal.userId, modalInput), 'Password has been reset')
            closeModal()
        } else {
            // Generate token
            setActionLoading(modal.userId)
            setError(null)
            try {
                const resp = await adminUserService.generateResetToken(modal.userId)
                setGeneratedToken({ token: resp.resetToken, expiresAt: resp.expiresAt })
                setSuccessMsg('Reset token generated')
                await fetchUsers()
            } catch (err: any) {
                setError(err.message)
            } finally {
                setActionLoading(null)
            }
        }
    }

    const handleCopyToken = async () => {
        if (!generatedToken) return
        await navigator.clipboard.writeText(generatedToken.token)
        setTokenCopied(true)
        setTimeout(() => setTokenCopied(false), 2000)
    }

    const handleSort = (field: SortField) => {
        if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        else { setSortField(field); setSortDir('asc') }
    }

    const closeModal = () => {
        setModal(null)
        setModalInput('')
        setSelectedRole('')
        setGeneratedToken(null)
        setTokenCopied(false)
        setResetMode('token')
        setInviteResult(null)
        setInviteCopied(false)
        setInviteRole('user')
    }

    const handleCreateInvite = async () => {
        setInviteLoading(true)
        setError(null)
        try {
            const resp = await adminUserService.createInvite(inviteRole)
            setInviteResult(resp)
            setSuccessMsg('Invite link generated')
        } catch (err: any) {
            setError(err.message || 'Failed to create invite')
        } finally {
            setInviteLoading(false)
        }
    }

    const inviteUrl = inviteResult
        ? `${window.location.origin}/signup?invite=${inviteResult.inviteToken}`
        : ''

    const handleCopyInvite = async () => {
        if (!inviteUrl) return
        await navigator.clipboard.writeText(inviteUrl)
        setInviteCopied(true)
        setTimeout(() => setInviteCopied(false), 2000)
    }

    const openRoleModal = (user: AdminUserResponse) => {
        setSelectedRole(user.role)
        setModal({ kind: 'role', userId: user.id, name: user.displayName, currentRole: user.role })
    }

    // ── Tab counts ───────────────────────────────────────────────────

    const tabCounts: Record<StatusFilter, number> = {
        all: users.length,
        pending: kpis.pending,
        active: kpis.active,
        suspended: users.filter(u => u.status === 'suspended').length,
    }

    // ── Loading state ────────────────────────────────────────────────

    if (loading && users.length === 0) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
            </div>
        )
    }

    // ── Render ───────────────────────────────────────────────────────

    return (
        <div className="max-w-6xl mx-auto p-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center shadow-md">
                        <Users className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink">User Management</h1>
                        <p className="text-sm text-ink-muted mt-1">
                            Manage accounts, roles, and access control.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setModal({ kind: 'invite' })}
                        className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                    >
                        <Link2 className="w-4 h-4" />
                        Invite by Link
                    </button>
                    <button
                        onClick={fetchUsers}
                        disabled={loading}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} />
                        Refresh
                    </button>
                </div>
            </div>

            {/* KPI Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
                {KPI_CARDS.map(kpi => {
                    const Icon = kpi.icon
                    const value = kpis[kpi.key as keyof typeof kpis]
                    return (
                        <div key={kpi.key} className={cn(
                            "relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated",
                            "hover:shadow-lg transition-colors duration-150 duration-200"
                        )}>
                            <div className={cn("absolute inset-0 bg-gradient-to-br pointer-events-none", kpi.gradient)} />
                            <div className="relative">
                                <div className={cn("w-9 h-9 rounded-lg border flex items-center justify-center mb-3", kpi.iconBg)}>
                                    <Icon className="w-4.5 h-4.5" />
                                </div>
                                <p className={cn("text-2xl font-bold", kpi.accent)}>{value}</p>
                                <p className="text-xs text-ink-muted mt-1">{kpi.label}</p>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* Alert banners */}
            <AnimatePresence>
                {kpis.pending > 0 && filter !== 'pending' && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-3 p-4 mb-4 rounded-xl bg-amber-500/10 border border-amber-500/20"
                    >
                        <div className="w-8 h-8 rounded-lg bg-amber-500/20 flex items-center justify-center shrink-0">
                            <UserPlus className="w-4 h-4 text-amber-600 dark:text-amber-400" />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">
                                {kpis.pending} user{kpis.pending !== 1 ? 's' : ''} awaiting approval
                            </p>
                            <p className="text-xs text-amber-600/80 dark:text-amber-400/80 mt-0.5">
                                Review and approve new signups to grant access.
                            </p>
                        </div>
                        <button onClick={() => setFilter('pending')}
                            className="px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-semibold hover:bg-amber-600 transition-colors shrink-0">
                            Review Now
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            <AnimatePresence>
                {resetRequestCount > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-3 p-4 mb-4 rounded-xl bg-sky-500/10 border border-sky-500/20"
                    >
                        <div className="w-8 h-8 rounded-lg bg-sky-500/20 flex items-center justify-center shrink-0">
                            <KeyRound className="w-4 h-4 text-sky-600 dark:text-sky-400" />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-semibold text-sky-700 dark:text-sky-300">
                                {resetRequestCount} password reset request{resetRequestCount !== 1 ? 's' : ''}
                            </p>
                            <p className="text-xs text-sky-600/80 dark:text-sky-400/80 mt-0.5">
                                Users have requested password resets. Generate tokens or set passwords directly.
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Success toast */}
            <AnimatePresence>
                {successMsg && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-2 p-3 mb-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-600 dark:text-emerald-400 text-sm"
                    >
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <p className="flex-1">{successMsg}</p>
                        <button onClick={() => setSuccessMsg(null)} className="p-1 rounded-lg hover:bg-emerald-500/10 transition-colors">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Toolbar */}
            <div className="flex items-center gap-4 mb-6">
                <div className="flex gap-1 bg-black/5 dark:bg-white/5 rounded-xl p-1">
                    {STATUS_TABS.map(tab => {
                        const Icon = tab.icon
                        const isActive = filter === tab.value
                        const count = tabCounts[tab.value]
                        return (
                            <button key={tab.value} onClick={() => setFilter(tab.value)}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150",
                                    isActive ? "bg-white dark:bg-white/10 text-ink shadow-sm" : "text-ink-muted hover:text-ink"
                                )}>
                                <Icon className="w-3.5 h-3.5" />
                                {tab.label}
                                {count > 0 && (
                                    <span className={cn(
                                        "ml-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold leading-none",
                                        isActive ? "bg-accent-lineage/10 text-accent-lineage" : "bg-black/5 dark:bg-white/10 text-ink-muted"
                                    )}>{count}</span>
                                )}
                            </button>
                        )
                    })}
                </div>
                <div className="relative flex-1 max-w-xs ml-auto">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input type="text" placeholder="Search by name, email, or role..."
                        value={search} onChange={(e) => setSearch(e.target.value)}
                        className="input pl-9 h-9 text-sm bg-white/50 dark:bg-black/20 w-full" />
                    {search && (
                        <button onClick={() => setSearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink transition-colors">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Error */}
            <AnimatePresence>
                {error && (
                    <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }} transition={{ duration: 0.2 }}
                        className="flex items-center gap-2 p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm">
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <p className="flex-1">{error}</p>
                        <button onClick={() => setError(null)} className="p-1 rounded-lg hover:bg-red-500/10 transition-colors">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* User table */}
            {processedUsers.length === 0 ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated">
                    <div className="flex flex-col items-center justify-center py-20">
                        <div className="w-16 h-16 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mb-4">
                            {search ? <Search className="w-7 h-7 text-ink-muted/60" /> : <Users className="w-7 h-7 text-ink-muted/60" />}
                        </div>
                        <p className="text-sm font-medium text-ink-secondary mb-1">
                            {search ? 'No matching users' : `No ${filter === 'all' ? '' : filter + ' '}users`}
                        </p>
                        <p className="text-xs text-ink-muted">
                            {search ? 'Try adjusting your search query.' : filter !== 'all' ? 'No users match this status filter.' : 'Users will appear here after signing up.'}
                        </p>
                    </div>
                </div>
            ) : (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    <table className="w-full">
                        <thead className="bg-black/[0.03] dark:bg-white/[0.03]">
                            <tr className="border-b border-glass-border">
                                <th className="text-left px-5 py-3"><SortHeader label="User" field="name" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Status" field="status" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Role" field="role" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Joined" field="createdAt" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-right px-5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {processedUsers.map((user, i) => {
                                const sc = STATUS_CONFIG[user.status]
                                const rc = ROLE_CONFIG[user.role] || ROLE_CONFIG.user
                                const RoleIcon = rc.icon
                                const isActing = actionLoading === user.id
                                return (
                                    <motion.tr key={user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                                        transition={{ duration: 0.15, delay: i * 0.02 }}
                                        className="border-b last:border-b-0 border-glass-border transition-colors group hover:bg-black/[0.02] dark:hover:bg-white/[0.02]">

                                        {/* User avatar + name + email + reset badge */}
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className="relative">
                                                    <div className={cn(
                                                        "w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow-sm",
                                                        avatarGradient(user.displayName)
                                                    )}>
                                                        {getInitials(user.firstName, user.lastName)}
                                                    </div>
                                                    {user.resetRequested && (
                                                        <div className="absolute -top-0.5 -right-0.5 w-3.5 h-3.5 rounded-full bg-sky-500 border-2 border-canvas-elevated flex items-center justify-center"
                                                            title="Password reset requested">
                                                            <KeyRound className="w-2 h-2 text-white" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <p className="text-sm font-semibold text-ink truncate">{user.displayName}</p>
                                                        {user.resetRequested && (
                                                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20 shrink-0">
                                                                RESET
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="flex items-center gap-1 mt-0.5">
                                                        <Mail className="w-3 h-3 text-ink-muted shrink-0" />
                                                        <p className="text-xs text-ink-muted truncate">{user.email}</p>
                                                    </div>
                                                </div>
                                            </div>
                                        </td>

                                        {/* Status */}
                                        <td className="px-5 py-4">
                                            {sc ? (
                                                <span className={cn("inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border", sc.badge)}>
                                                    <span className={cn("w-1.5 h-1.5 rounded-full", sc.dot)} />
                                                    {sc.label}
                                                </span>
                                            ) : (
                                                <span className="text-xs text-ink-muted">{user.status}</span>
                                            )}
                                        </td>

                                        {/* Role with icon */}
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-1.5">
                                                <RoleIcon className={cn("w-3.5 h-3.5", rc.iconBg)} />
                                                <span className={cn("text-sm capitalize", rc.color)}>{user.role}</span>
                                            </div>
                                        </td>

                                        {/* Joined */}
                                        <td className="px-5 py-4">
                                            <p className="text-sm text-ink-secondary">{formatDate(user.createdAt)}</p>
                                            <p className="text-[11px] text-ink-muted mt-0.5">{timeAgo(user.createdAt)}</p>
                                        </td>

                                        {/* Actions */}
                                        <td className="px-5 py-4 text-right">
                                            <div className="flex items-center gap-1.5 justify-end">
                                                {/* Pending: approve + reject */}
                                                {user.status === 'pending' && (
                                                    <>
                                                        <button onClick={() => handleApprove(user.id)} disabled={isActing}
                                                            title="Approve"
                                                            className={cn(
                                                                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150",
                                                                "bg-emerald-500 text-white shadow-sm shadow-emerald-500/20",
                                                                "hover:bg-emerald-600 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
                                                            )}>
                                                            {isActing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                                            Approve
                                                        </button>
                                                        <button onClick={() => setModal({ kind: 'reject', userId: user.id, name: user.displayName })}
                                                            disabled={isActing} title="Reject"
                                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20 hover:bg-red-500/20 active:scale-[0.98] disabled:opacity-50 transition-colors duration-150">
                                                            <XCircle className="w-3.5 h-3.5" />
                                                            Reject
                                                        </button>
                                                    </>
                                                )}

                                                {/* Active / Suspended: action buttons */}
                                                {user.status !== 'pending' && (
                                                    <>
                                                        {/* Change role (not for self — backend guards this too) */}
                                                        <button onClick={() => openRoleModal(user)} disabled={isActing}
                                                            title="Change role"
                                                            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50">
                                                            <UserCog className="w-4 h-4" />
                                                        </button>

                                                        {/* Reset password */}
                                                        <button onClick={() => setModal({ kind: 'resetPassword', userId: user.id, name: user.displayName })}
                                                            disabled={isActing} title="Reset password"
                                                            className={cn(
                                                                "p-2 rounded-lg transition-colors disabled:opacity-50",
                                                                user.resetRequested
                                                                    ? "text-sky-500 bg-sky-500/10 hover:bg-sky-500/20"
                                                                    : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                                                            )}>
                                                            <KeyRound className="w-4 h-4" />
                                                        </button>

                                                        {/* Suspend / Reactivate */}
                                                        {user.status === 'active' && (
                                                            <button onClick={() => setModal({ kind: 'suspend', userId: user.id, name: user.displayName })}
                                                                disabled={isActing} title="Suspend user"
                                                                className="p-2 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50">
                                                                <Ban className="w-4 h-4" />
                                                            </button>
                                                        )}
                                                        {user.status === 'suspended' && (
                                                            <button onClick={() => handleReactivate(user.id)}
                                                                disabled={isActing} title="Reactivate user"
                                                                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 active:scale-[0.98] disabled:opacity-50 transition-colors duration-150">
                                                                {isActing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                                                Reactivate
                                                            </button>
                                                        )}
                                                    </>
                                                )}
                                            </div>
                                        </td>
                                    </motion.tr>
                                )
                            })}
                        </tbody>
                    </table>

                    {/* Table footer */}
                    <div className="px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between">
                        <p className="text-xs text-ink-muted">
                            Showing <span className="font-semibold text-ink-secondary">{processedUsers.length}</span>
                            {processedUsers.length !== users.length && (
                                <> of <span className="font-semibold text-ink-secondary">{users.length}</span></>
                            )} user{users.length !== 1 ? 's' : ''}
                        </p>
                        {(search || filter !== 'all') && (
                            <button onClick={() => { setSearch(''); setFilter('all') }}
                                className="text-xs font-medium text-accent-lineage hover:underline">Clear filters</button>
                        )}
                    </div>
                </div>
            )}

            {/* ── Modals ──────────────────────────────────────────────── */}
            <AnimatePresence>
                {modal && (
                    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }} className="fixed inset-0 z-50 flex items-center justify-center p-4">
                        <div className="absolute inset-0 bg-black/50" onClick={closeModal} />
                        <motion.div initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }} transition={{ duration: 0.2 }}
                            onClick={(e) => e.stopPropagation()}
                            className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-md p-6">

                            {/* ── Reject modal ── */}
                            {modal.kind === 'reject' && (
                                <>
                                    <ModalHeader icon={XCircle} iconBg="bg-red-500/10 border-red-500/20" iconColor="text-red-500"
                                        title="Reject Signup" subtitle="This action cannot be undone" onClose={closeModal} />
                                    <UserPill name={modal.name} />
                                    <div className="mb-5">
                                        <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                            Reason <span className="normal-case font-normal">(optional)</span>
                                        </label>
                                        <textarea placeholder="Provide a reason..." value={modalInput}
                                            onChange={(e) => setModalInput(e.target.value)} rows={3}
                                            className="input w-full resize-none text-sm" autoFocus />
                                    </div>
                                    <ModalFooter onCancel={closeModal} onConfirm={handleRejectConfirm}
                                        confirmLabel="Reject User" confirmIcon={XCircle} confirmClass="bg-red-500 hover:bg-red-600 shadow-red-500/20"
                                        loading={!!actionLoading} />
                                </>
                            )}

                            {/* ── Suspend modal ── */}
                            {modal.kind === 'suspend' && (
                                <>
                                    <ModalHeader icon={Ban} iconBg="bg-red-500/10 border-red-500/20" iconColor="text-red-500"
                                        title="Suspend User" subtitle="User will lose access immediately" onClose={closeModal} />
                                    <UserPill name={modal.name} />
                                    <p className="text-sm text-ink-secondary mb-5">
                                        This will prevent the user from logging in. You can reactivate them later.
                                    </p>
                                    <ModalFooter onCancel={closeModal} onConfirm={handleSuspendConfirm}
                                        confirmLabel="Suspend User" confirmIcon={Ban} confirmClass="bg-red-500 hover:bg-red-600 shadow-red-500/20"
                                        loading={!!actionLoading} />
                                </>
                            )}

                            {/* ── Role change modal ── */}
                            {modal.kind === 'role' && (
                                <>
                                    <ModalHeader icon={UserCog} iconBg="bg-indigo-500/10 border-indigo-500/20" iconColor="text-indigo-500"
                                        title="Change Role" subtitle={`Current: ${modal.currentRole}`} onClose={closeModal} />
                                    <UserPill name={modal.name} />
                                    <div className="space-y-2 mb-5">
                                        {AVAILABLE_ROLES.map(r => {
                                            const RIcon = r.icon
                                            const isSelected = selectedRole === r.value
                                            return (
                                                <button key={r.value} onClick={() => setSelectedRole(r.value)}
                                                    className={cn(
                                                        "w-full flex items-center gap-3 p-3 rounded-xl border transition-colors duration-150 text-left",
                                                        isSelected
                                                            ? "border-accent-lineage bg-accent-lineage/5 shadow-sm"
                                                            : "border-glass-border hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                                    )}>
                                                    <div className={cn(
                                                        "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                                                        isSelected ? "bg-accent-lineage/10 text-accent-lineage" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                                                    )}>
                                                        <RIcon className="w-4 h-4" />
                                                    </div>
                                                    <div>
                                                        <p className={cn("text-sm font-semibold", isSelected ? "text-accent-lineage" : "text-ink")}>{r.label}</p>
                                                        <p className="text-[11px] text-ink-muted">{r.description}</p>
                                                    </div>
                                                    {isSelected && (
                                                        <CheckCircle2 className="w-5 h-5 text-accent-lineage ml-auto shrink-0" />
                                                    )}
                                                </button>
                                            )
                                        })}
                                    </div>
                                    <ModalFooter onCancel={closeModal} onConfirm={handleRoleChange}
                                        confirmLabel="Update Role" confirmIcon={CheckCircle2}
                                        confirmClass="bg-accent-lineage hover:brightness-110 shadow-accent-lineage/20"
                                        loading={!!actionLoading} disabled={selectedRole === modal.currentRole} />
                                </>
                            )}

                            {/* ── Invite modal ── */}
                            {modal.kind === 'invite' && (
                                <>
                                    <ModalHeader icon={Link2} iconBg="bg-accent-lineage/10 border-accent-lineage/20" iconColor="text-accent-lineage"
                                        title="Invite by Link" subtitle="Generate a shareable signup link" onClose={closeModal} />

                                    {inviteResult ? (
                                        <div className="space-y-4 mb-5">
                                            <div className="p-4 rounded-xl bg-accent-lineage/5 border border-accent-lineage/20">
                                                <p className="text-xs font-semibold uppercase tracking-wider text-accent-lineage mb-2">Invite Link</p>
                                                <div className="flex items-center gap-2">
                                                    <code className="flex-1 text-xs font-mono bg-black/5 dark:bg-white/5 px-3 py-2 rounded-lg break-all text-ink select-all">
                                                        {inviteUrl}
                                                    </code>
                                                    <button onClick={handleCopyInvite}
                                                        className="p-2 rounded-lg bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20 transition-colors shrink-0">
                                                        {inviteCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                                    </button>
                                                </div>
                                                <p className="text-[11px] text-ink-muted mt-2">
                                                    Role: <span className="font-semibold capitalize">{inviteResult.role}</span> &middot; Expires: {formatDate(inviteResult.expiresAt)}
                                                </p>
                                                <p className="text-[11px] text-ink-muted mt-1">
                                                    Share this link with the user. They will be auto-activated upon signup.
                                                </p>
                                            </div>
                                            <div className="flex justify-end">
                                                <button onClick={closeModal}
                                                    className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 transition-colors duration-150">
                                                    Done
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <p className="text-sm text-ink-secondary mb-4">
                                                Generate a link that lets a new user sign up and bypass the approval queue.
                                                Choose what role the invited user will receive.
                                            </p>
                                            <div className="space-y-2 mb-5">
                                                {AVAILABLE_ROLES.map(r => {
                                                    const RIcon = r.icon
                                                    const isSelected = inviteRole === r.value
                                                    return (
                                                        <button key={r.value} onClick={() => setInviteRole(r.value)}
                                                            className={cn(
                                                                "w-full flex items-center gap-3 p-3 rounded-xl border transition-colors text-left",
                                                                isSelected
                                                                    ? "border-accent-lineage bg-accent-lineage/5"
                                                                    : "border-glass-border hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                                            )}>
                                                            <div className={cn(
                                                                "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                                                                isSelected ? "bg-accent-lineage/10 text-accent-lineage" : "bg-black/5 dark:bg-white/5 text-ink-muted"
                                                            )}>
                                                                <RIcon className="w-4 h-4" />
                                                            </div>
                                                            <div>
                                                                <p className={cn("text-sm font-semibold", isSelected ? "text-accent-lineage" : "text-ink")}>{r.label}</p>
                                                                <p className="text-[11px] text-ink-muted">{r.description}</p>
                                                            </div>
                                                            {isSelected && (
                                                                <CheckCircle2 className="w-5 h-5 text-accent-lineage ml-auto shrink-0" />
                                                            )}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                            <ModalFooter onCancel={closeModal} onConfirm={handleCreateInvite}
                                                confirmLabel="Generate Link" confirmIcon={Link2}
                                                confirmClass="bg-accent-lineage hover:brightness-110 shadow-accent-lineage/20"
                                                loading={inviteLoading} />
                                        </>
                                    )}
                                </>
                            )}

                            {/* ── Reset password modal ── */}
                            {modal.kind === 'resetPassword' && (
                                <>
                                    <ModalHeader icon={KeyRound} iconBg="bg-sky-500/10 border-sky-500/20" iconColor="text-sky-500"
                                        title="Reset Password" subtitle="Choose a reset method" onClose={closeModal} />
                                    <UserPill name={modal.name} />

                                    {/* If we have a generated token, show it */}
                                    {generatedToken ? (
                                        <div className="space-y-4 mb-5">
                                            <div className="p-4 rounded-xl bg-sky-500/5 border border-sky-500/20">
                                                <p className="text-xs font-semibold uppercase tracking-wider text-sky-600 dark:text-sky-400 mb-2">Reset Token</p>
                                                <div className="flex items-center gap-2">
                                                    <code className="flex-1 text-xs font-mono bg-black/5 dark:bg-white/5 px-3 py-2 rounded-lg break-all text-ink select-all">
                                                        {generatedToken.token}
                                                    </code>
                                                    <button onClick={handleCopyToken}
                                                        className="p-2 rounded-lg bg-sky-500/10 text-sky-600 hover:bg-sky-500/20 transition-colors shrink-0">
                                                        {tokenCopied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                                                    </button>
                                                </div>
                                                <p className="text-[11px] text-ink-muted mt-2">
                                                    Expires: {formatDate(generatedToken.expiresAt)}. Share this token with the user.
                                                </p>
                                                <p className="text-[11px] text-ink-muted mt-1">
                                                    The user should visit <span className="font-mono text-sky-600 dark:text-sky-400">/reset-password</span> and enter this token.
                                                </p>
                                            </div>
                                            <div className="flex justify-end">
                                                <button onClick={closeModal}
                                                    className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 transition-colors duration-150">
                                                    Done
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            {/* Mode toggle */}
                                            <div className="flex gap-2 mb-4">
                                                <button onClick={() => setResetMode('token')}
                                                    className={cn(
                                                        "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors duration-150",
                                                        resetMode === 'token'
                                                            ? "border-accent-lineage bg-accent-lineage/5 text-accent-lineage"
                                                            : "border-glass-border text-ink-muted hover:text-ink"
                                                    )}>
                                                    <KeyRound className="w-3.5 h-3.5" />
                                                    Generate Token
                                                </button>
                                                <button onClick={() => setResetMode('direct')}
                                                    className={cn(
                                                        "flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl text-xs font-semibold border transition-colors duration-150",
                                                        resetMode === 'direct'
                                                            ? "border-accent-lineage bg-accent-lineage/5 text-accent-lineage"
                                                            : "border-glass-border text-ink-muted hover:text-ink"
                                                    )}>
                                                    <Lock className="w-3.5 h-3.5" />
                                                    Set Password
                                                </button>
                                            </div>

                                            {resetMode === 'token' ? (
                                                <div className="mb-5">
                                                    <p className="text-sm text-ink-secondary">
                                                        Generate a one-time reset token that you can share with the user.
                                                        They will use it at the <span className="font-mono text-xs">/reset-password</span> page.
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className="mb-5">
                                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                                        New Password
                                                    </label>
                                                    <div className="relative group">
                                                        <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                                            <Lock className="w-4 h-4" />
                                                        </div>
                                                        <input type="password" placeholder="Min. 8 characters"
                                                            value={modalInput} onChange={(e) => setModalInput(e.target.value)}
                                                            className="input pl-10 h-11 w-full text-sm" autoFocus minLength={8} />
                                                    </div>
                                                    <p className="text-[11px] text-ink-muted mt-1.5">
                                                        Set the password directly. The user will need to be informed of the new password.
                                                    </p>
                                                </div>
                                            )}

                                            <ModalFooter onCancel={closeModal} onConfirm={handleResetPassword}
                                                confirmLabel={resetMode === 'token' ? 'Generate Token' : 'Reset Password'}
                                                confirmIcon={resetMode === 'token' ? KeyRound : Lock}
                                                confirmClass="bg-sky-500 hover:bg-sky-600 shadow-sky-500/20"
                                                loading={!!actionLoading}
                                                disabled={resetMode === 'direct' && modalInput.length < 8} />
                                        </>
                                    )}
                                </>
                            )}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ── Shared modal sub-components ──────────────────────────────────────

function ModalHeader({ icon: Icon, iconBg, iconColor, title, subtitle, onClose }: {
    icon: typeof Shield; iconBg: string; iconColor: string; title: string; subtitle: string; onClose: () => void
}) {
    return (
        <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
                <div className={cn("w-10 h-10 rounded-xl border flex items-center justify-center", iconBg)}>
                    <Icon className={cn("w-5 h-5", iconColor)} />
                </div>
                <div>
                    <h3 className="text-lg font-bold text-ink">{title}</h3>
                    <p className="text-xs text-ink-muted">{subtitle}</p>
                </div>
            </div>
            <button onClick={onClose} className="p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/5 text-ink-muted transition-colors">
                <X className="w-4 h-4" />
            </button>
        </div>
    )
}

function UserPill({ name }: { name: string }) {
    return (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border mb-5">
            <div className={cn(
                "w-8 h-8 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white",
                avatarGradient(name)
            )}>
                {name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
            </div>
            <p className="text-sm font-medium text-ink">{name}</p>
        </div>
    )
}

function ModalFooter({ onCancel, onConfirm, confirmLabel, confirmIcon: Icon, confirmClass, loading, disabled }: {
    onCancel: () => void; onConfirm: () => void; confirmLabel: string; confirmIcon: typeof Shield
    confirmClass: string; loading: boolean; disabled?: boolean
}) {
    return (
        <div className="flex gap-3 justify-end">
            <button onClick={onCancel}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold text-ink-secondary border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                Cancel
            </button>
            <button onClick={onConfirm} disabled={loading || disabled}
                className={cn(
                    "px-4 py-2.5 rounded-xl text-sm font-semibold text-white transition-colors duration-150 shadow-sm flex items-center gap-2",
                    "disabled:opacity-50 disabled:cursor-not-allowed",
                    confirmClass
                )}>
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Icon className="w-4 h-4" />}
                {confirmLabel}
            </button>
        </div>
    )
}
