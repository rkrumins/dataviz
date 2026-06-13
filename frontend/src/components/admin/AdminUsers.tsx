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
    ChevronDown, ChevronUp, ChevronLeft, ChevronRight,
    KeyRound, UserCog,
    RotateCcw, Lock, Copy, Check, Link2,
    Building2, Globe, Sparkles, AtSign, Users2, ScrollText, Pencil,
} from 'lucide-react'
import { adminUserService, type AdminUserResponse, type InviteResponse } from '@/services/adminUserService'
import { permissionsService, type RoleDefinitionResponse, type UserAccessResponse } from '@/services/permissionsService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { usePermission } from '@/store/auth'
import { Backdrop } from '@/components/ui/Backdrop'
import { cn } from '@/lib/utils'
import { roleVisualFor } from '@/lib/roleVisual'
import { AccessSummary } from '@/components/access/AccessSummary'
import {
    ROLE_NAMES,
    PLATFORM_ADMIN_ROLES,
    WORKSPACE_TEMPLATE_ROLE_SET,
    type RoleName,
} from '@/lib/roleNames'


// Phase 11: classify a role for invite purposes from its catalogue
// entry. Mirrors the backend rules so the modal can drive the
// workspace-picker + email-required UX before the request is sent.
const _WORKSPACE_TEMPLATE_ROLES = WORKSPACE_TEMPLATE_ROLE_SET

function roleIsPrivileged(perms: string[]): boolean {
    return perms.some(p => p === 'workspace:admin' || p.startsWith('system:'))
}

function roleNeedsWorkspace(role: RoleDefinitionResponse): boolean {
    return _WORKSPACE_TEMPLATE_ROLES.has(role.name as RoleName) || role.scopeType === 'workspace'
}

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
    | { kind: 'editProfile'; userId: string; firstName: string; lastName: string; email: string }
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

// Legacy table row visual map — replaced at the row-render call site
// by ``roleVisualFor(user.role)`` from ``@/lib/roleVisual``. Kept as
// an empty object so any stale lookup gracefully falls back to the
// canonical helper (which itself falls back to "Custom" for unknown
// roles).

// Organization-wide access — what kind of account a person has across
// the whole org. Orthogonal to workspace access (managed inside each
// workspace's Members tab). Every user has exactly one organization
// role; ``user`` is the default and means "no organization-wide
// privileges, but they can still be invited into specific workspaces".
// See backend/app/db/repositories/user_repo.py:GLOBAL_ASSIGNABLE_ROLES.
const AVAILABLE_ROLES = [
    { value: ROLE_NAMES.USER, label: 'User', description: 'A standard team member. No organization-wide privileges; can be invited to specific workspaces.', icon: UserCog },
    { value: ROLE_NAMES.ORG_AUDITOR, label: 'Org Auditor', description: 'Can see every workspace and the activity log, but can\'t make changes anywhere.', icon: ScrollText },
    { value: ROLE_NAMES.ORG_ADMIN, label: 'Org Admin', description: 'Manages every workspace and creates new ones. Doesn\'t manage user accounts or sign-in settings.', icon: Shield },
    { value: ROLE_NAMES.SUPER_ADMIN, label: 'Super Admin', description: 'Full administrator with unrestricted access across the whole organization.', icon: Shield },
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
    // Phase 6: only super_admins can grant super_admin. Org admins
    // see ``org_admin`` only — the dropdown shouldn't tease a role
    // they'd 403 on. Match the backend ``require_admin`` gate on
    // ``PUT /admin/users/{id}/role`` (which checks ``system:admin``
    // legacy + claim) so the FE filter agrees with the BE gate.
    const canGrantSuperAdmin = usePermission('system:admin')
    const assignableRoles = useMemo(
        () =>
            canGrantSuperAdmin
                ? AVAILABLE_ROLES
                : AVAILABLE_ROLES.filter(r => r.value !== ROLE_NAMES.SUPER_ADMIN),
        [canGrantSuperAdmin],
    )

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

    // Invite state. Phase 11: the role / workspace / email selection
    // lives inside <InviteForm/>; the parent only holds the generated
    // result + copy state.
    const [inviteResult, setInviteResult] = useState<InviteResponse | null>(null)
    const [inviteCopied, setInviteCopied] = useState(false)
    const [inviteLoading, setInviteLoading] = useState(false)

    // Per-user access drawer — opens on row click. Shows direct +
    // inherited bindings, group memberships, workspace + global
    // permission maps via the shared ``AccessSummary`` component
    // (same render the ``/admin/permissions`` "By user" tab uses).
    const [accessUser, setAccessUser] = useState<AdminUserResponse | null>(null)
    const [accessData, setAccessData] = useState<UserAccessResponse | null>(null)
    const [accessLoading, setAccessLoading] = useState(false)
    const [accessError, setAccessError] = useState<string | null>(null)

    const openAccessDrawer = useCallback(async (user: AdminUserResponse) => {
        setAccessUser(user)
        setAccessData(null)
        setAccessError(null)
        setAccessLoading(true)
        try {
            const data = await permissionsService.getUserAccess(user.id)
            setAccessData(data)
        } catch (err) {
            setAccessError(err instanceof Error ? err.message : 'Failed to load access')
        } finally {
            setAccessLoading(false)
        }
    }, [])

    const closeAccessDrawer = useCallback(() => {
        setAccessUser(null)
        setAccessData(null)
        setAccessError(null)
    }, [])

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

    // Refresh on a permissions change (silent refresh, 60s poller, or
    // cross-tab BroadcastChannel) so a binding/role mutation made
    // elsewhere refreshes this page in place without a manual reload.
    useEffect(() => {
        const onChange = () => { void fetchUsers() }
        window.addEventListener('permissions:changed', onChange)
        return () => window.removeEventListener('permissions:changed', onChange)
    }, [fetchUsers])

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
        // Phase 5: count global-tier admins (super_admin + org_admin).
        // Workspace-scoped admins (workspace_admin bindings) aren't in
        // this number — they're not "platform" admins, just workspace
        // admins. Surface that distinction in the tooltip on the KPI.
        admins: users.filter(
            u => PLATFORM_ADMIN_ROLES.has(u.role as RoleName),
        ).length,
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
    }

    const handleCreateInvite = async (
        role: string | null,
        opts: {
            workspaceId?: string | null
            email?: string | null
            groupIds?: string[] | null
            allowShareableWithGroups?: boolean
            expiresInHours?: number
        },
    ) => {
        setInviteLoading(true)
        setError(null)
        try {
            const resp = await adminUserService.createInvite(role, opts)
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

    const openEditProfileModal = (user: AdminUserResponse) => {
        setModal({
            kind: 'editProfile',
            userId: user.id,
            firstName: user.firstName ?? '',
            lastName: user.lastName ?? '',
            email: user.email,
        })
    }

    const [profileFirstName, setProfileFirstName] = useState('')
    const [profileLastName, setProfileLastName] = useState('')

    useEffect(() => {
        if (modal?.kind === 'editProfile') {
            setProfileFirstName(modal.firstName)
            setProfileLastName(modal.lastName)
        }
    }, [modal])

    const handleUpdateProfile = async () => {
        if (modal?.kind !== 'editProfile') return
        const first = profileFirstName.trim()
        const last = profileLastName.trim()
        if (!first || !last) {
            setError('First and last name are required')
            return
        }
        await withAction(
            modal.userId,
            () => adminUserService.updateUser(modal.userId, { firstName: first, lastName: last }),
            'Profile updated',
        )
        closeModal()
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
                                const rc = roleVisualFor(user.role)
                                const RoleIcon = rc.icon
                                const isActing = actionLoading === user.id
                                return (
                                    <motion.tr key={user.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                                        transition={{ duration: 0.15, delay: i * 0.02 }}
                                        onClick={() => openAccessDrawer(user)}
                                        className="border-b last:border-b-0 border-glass-border transition-colors group hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer">

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

                                        {/* Role with icon — shared visual map. */}
                                        <td className="px-5 py-4">
                                            <span className={cn(
                                                'inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-semibold border',
                                                rc.badge,
                                            )}>
                                                <RoleIcon className="w-3 h-3" />
                                                {rc.label}
                                            </span>
                                        </td>

                                        {/* Joined */}
                                        <td className="px-5 py-4">
                                            <p className="text-sm text-ink-secondary">{formatDate(user.createdAt)}</p>
                                            <p className="text-[11px] text-ink-muted mt-0.5">{timeAgo(user.createdAt)}</p>
                                        </td>

                                        {/* Actions — clicks must not bubble to the row's drawer-open handler. */}
                                        <td className="px-5 py-4 text-right" onClick={(e) => e.stopPropagation()}>
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
                                                        {/* Edit profile (name fields) */}
                                                        <button onClick={() => openEditProfileModal(user)} disabled={isActing}
                                                            title="Edit profile"
                                                            className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50">
                                                            <Pencil className="w-4 h-4" />
                                                        </button>

                                                        {/* Change organization access */}
                                                        <button onClick={() => openRoleModal(user)} disabled={isActing}
                                                            title="Change organization access"
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
            {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
            <Backdrop open={!!modal} onClick={closeModal} zClassName="z-50" className="bg-black/50" />

            {/* Centering layer: plain, always-mounted, transparent to clicks (they fall
                through to the Backdrop beneath → outside-click still closes). */}
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <AnimatePresence>
                    {modal && (
                        <motion.div key="admin-users-modal-card" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }} transition={{ duration: 0.2 }}
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                                "pointer-events-auto relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full p-6",
                                // Phase 14: the invite modal carries more sections
                                // (role + workspace + groups + recipient + expiry +
                                // summary) and needs more horizontal room for the
                                // two-column layout. Other modals stay compact.
                                modal.kind === 'invite'
                                    ? "max-w-4xl max-h-[90vh] flex flex-col"
                                    : "max-w-md"
                            )}>

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

                            {/* ── Role change modal ──
                                Organization-wide access. Separate axis from
                                each workspace's own members list. Shows all
                                4 roles (User / Org Auditor / Org Admin /
                                Super Admin) so admins can demote as well as
                                promote. */}
                            {modal.kind === 'role' && (
                                <>
                                    <ModalHeader icon={UserCog} iconBg="bg-indigo-500/10 border-indigo-500/20" iconColor="text-indigo-500"
                                        title="Change Organization Access"
                                        subtitle={`Current: ${roleVisualFor(modal.currentRole).label}. Workspace-specific access is managed inside each workspace.`}
                                        onClose={closeModal} />
                                    <UserPill name={modal.name} />
                                    <div className="space-y-2 mb-5">
                                        {assignableRoles.map(r => {
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

                            {/* ── Edit profile modal ──
                                First / last name edit. Email is intentionally
                                read-only (SSO identity key). Display name is
                                derived server-side from first+last. */}
                            {modal.kind === 'editProfile' && (
                                <>
                                    <ModalHeader icon={Pencil} iconBg="bg-indigo-500/10 border-indigo-500/20" iconColor="text-indigo-500"
                                        title="Edit Profile"
                                        subtitle="Update the user's name. Email is fixed (SSO identity key)."
                                        onClose={closeModal} />
                                    <div className="space-y-4 mb-5">
                                        <div>
                                            <label className="text-[11px] uppercase tracking-wider font-bold text-ink-muted block mb-1.5">Email (read-only)</label>
                                            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border text-sm text-ink-muted">
                                                <AtSign className="w-3.5 h-3.5 shrink-0" />
                                                <span className="truncate">{modal.email}</span>
                                                <Lock className="w-3 h-3 ml-auto shrink-0" />
                                            </div>
                                        </div>
                                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                                            <div>
                                                <label className="text-[11px] uppercase tracking-wider font-bold text-ink-muted block mb-1.5">First name</label>
                                                <input
                                                    type="text"
                                                    value={profileFirstName}
                                                    onChange={(e) => setProfileFirstName(e.target.value)}
                                                    placeholder="First name"
                                                    maxLength={120}
                                                    className="w-full px-3 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink focus:ring-2 focus:ring-accent-lineage/40 focus:border-accent-lineage outline-none transition-colors"
                                                />
                                            </div>
                                            <div>
                                                <label className="text-[11px] uppercase tracking-wider font-bold text-ink-muted block mb-1.5">Last name</label>
                                                <input
                                                    type="text"
                                                    value={profileLastName}
                                                    onChange={(e) => setProfileLastName(e.target.value)}
                                                    placeholder="Last name"
                                                    maxLength={120}
                                                    className="w-full px-3 py-2 rounded-xl border border-glass-border bg-canvas-elevated text-sm text-ink focus:ring-2 focus:ring-accent-lineage/40 focus:border-accent-lineage outline-none transition-colors"
                                                />
                                            </div>
                                        </div>
                                        <p className="text-[11px] text-ink-muted">
                                            Display name is updated automatically from first + last.
                                        </p>
                                    </div>
                                    <ModalFooter onCancel={closeModal} onConfirm={handleUpdateProfile}
                                        confirmLabel="Save Profile" confirmIcon={Check}
                                        confirmClass="bg-accent-lineage hover:brightness-110 shadow-accent-lineage/20"
                                        loading={!!actionLoading}
                                        disabled={
                                            !profileFirstName.trim() ||
                                            !profileLastName.trim() ||
                                            (profileFirstName.trim() === modal.firstName && profileLastName.trim() === modal.lastName)
                                        } />
                                </>
                            )}

                            {/* ── Invite modal ── */}
                            {modal.kind === 'invite' && (
                                <>
                                    <ModalHeader icon={Link2} iconBg="bg-accent-lineage/10 border-accent-lineage/20" iconColor="text-accent-lineage"
                                        title="Invite by Link" subtitle="Generate a shareable signup link" onClose={closeModal} />

                                    {inviteResult ? (
                                        <InviteResultCard
                                            result={inviteResult}
                                            inviteUrl={inviteUrl}
                                            copied={inviteCopied}
                                            onCopy={handleCopyInvite}
                                            onAnother={() => { setInviteResult(null); setInviteCopied(false); }}
                                            onClose={closeModal}
                                        />
                                    ) : (
                                        <InviteForm
                                            canGrantSuperAdmin={canGrantSuperAdmin}
                                            loading={inviteLoading}
                                            onCancel={closeModal}
                                            onSubmit={handleCreateInvite}
                                        />
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
                    )}
                </AnimatePresence>
            </div>

            {/* Per-user access drawer — opens on row click. Reuses
                AccessSummary so this page and `/admin/permissions` →
                "By user" can't drift visually or factually. */}
            {/* Scrim — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks).
                ``backdrop-blur-sm`` was a perf killer — blur is GPU-expensive and the
                browser had to recompute it every frame while the drawer slid in,
                stalling the panel transform. Plain opacity dim achieves the same visual
                focus at zero cost. shadow-2xl on the drawer was the second offender
                (large shadow + moving transform = recomposite per frame); shadow-xl
                looks the same at 480px wide and animates clean. */}
            <Backdrop open={!!accessUser} onClick={closeAccessDrawer} zClassName="z-40" className="bg-black/40" />
            <AnimatePresence>
                {accessUser && (
                        <motion.aside
                            key="access-drawer"
                            initial={{ x: '100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '100%' }}
                            transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                            style={{ willChange: 'transform' }}
                            className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-lg bg-canvas-elevated border-l border-glass-border shadow-xl flex flex-col"
                        >
                            <div className="flex items-center gap-2 px-5 py-4 border-b border-glass-border shrink-0">
                                <div className="min-w-0 flex-1">
                                    <p className="text-[10px] uppercase tracking-wider font-bold text-ink-muted">User access</p>
                                    <h2 className="text-base font-bold text-ink truncate">{accessUser.displayName}</h2>
                                    <p className="text-[11px] text-ink-muted truncate">{accessUser.email}</p>
                                </div>
                                <button
                                    onClick={() => openEditProfileModal(accessUser)}
                                    className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                                    title="Edit profile"
                                >
                                    <Pencil className="w-4 h-4" />
                                </button>
                                <button
                                    onClick={() => openRoleModal(accessUser)}
                                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-colors shrink-0"
                                    title="Change organization access"
                                >
                                    <UserCog className="w-3.5 h-3.5" />
                                    Org access
                                </button>
                                <button
                                    onClick={closeAccessDrawer}
                                    className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                                    title="Close"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            {/* Body: show skeleton placeholders while the
                                /users/{id}/access call is in flight, so the
                                drawer feels responsive even on a slow BE.
                                Replaced by AccessSummary the moment data
                                lands. */}
                            <div className="flex-1 min-h-0 overflow-y-auto">
                                {accessLoading ? (
                                    <AccessSkeleton />
                                ) : accessError ? (
                                    <div className="p-6">
                                        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-500/5 border border-red-500/20 text-sm text-red-600 dark:text-red-400">
                                            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                                            <span>{accessError}</span>
                                        </div>
                                    </div>
                                ) : accessData ? (
                                    <AccessSummary access={accessData} mode="admin" hideHeader />
                                ) : null}
                            </div>
                        </motion.aside>
                )}
            </AnimatePresence>
        </div>
    )
}

// ── Skeleton placeholder for the user-access drawer ─────────────────
// Keeps the drawer feeling responsive while the BE compute_user_access
// call (groups + bindings + claim resolver) is in flight. Layout
// roughly matches AccessSummary so the eventual render isn't a jarring
// re-layout. Pure DIVs with `animate-pulse`; no expensive renders.
function AccessSkeleton() {
    return (
        <div className="p-6 space-y-6 animate-pulse">
            <div className="grid grid-cols-3 gap-3">
                {[0, 1, 2].map((i) => (
                    <div key={i} className="rounded-xl border border-glass-border bg-glass-base/30 px-3 py-2.5 h-[58px]" />
                ))}
            </div>
            <div className="space-y-3">
                <div className="h-5 w-32 rounded bg-black/5 dark:bg-white/5" />
                <div className="h-20 rounded-xl border border-glass-border bg-glass-base/30" />
                <div className="h-20 rounded-xl border border-glass-border bg-glass-base/30" />
            </div>
            <div className="space-y-3">
                <div className="h-5 w-40 rounded bg-black/5 dark:bg-white/5" />
                <div className="h-14 rounded-xl border border-glass-border bg-glass-base/30" />
                <div className="h-14 rounded-xl border border-glass-border bg-glass-base/30" />
            </div>
            <div className="space-y-3">
                <div className="h-5 w-36 rounded bg-black/5 dark:bg-white/5" />
                <div className="grid grid-cols-2 gap-2">
                    <div className="h-12 rounded-lg border border-glass-border bg-glass-base/30" />
                    <div className="h-12 rounded-lg border border-glass-border bg-glass-base/30" />
                </div>
            </div>
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


// ── Phase 12: premium invite form ────────────────────────────────────
// Visual language: icon-container per role tier, grouped sections
// (Quick start / Built-in / Custom), animated workspace + privilege
// reveals, chip-style workspace + expiry pickers, glass callouts.

// Invite-form role visuals are derived from the canonical shared map
// (``@/lib/roleVisual``) so a role rename or addition only needs to
// happen in one place. The shape returned here ({icon, bg, accent})
// matches the InviteForm's button styling; the canonical source has
// more fields (badge, gradient, iconBg) that this UI doesn't use.
const _ROLE_VISUAL_NONE = {
    icon: Globe,
    bg: 'bg-slate-500/10 text-slate-600 border-slate-500/20',
    accent: 'text-slate-600 dark:text-slate-400',
} as const

const _BUILTIN_ORDER: readonly string[] = [
    ROLE_NAMES.SUPER_ADMIN, ROLE_NAMES.ORG_ADMIN, ROLE_NAMES.ORG_AUDITOR,
    ROLE_NAMES.WORKSPACE_ADMIN, ROLE_NAMES.WORKSPACE_DATA_ENGINEER,
    ROLE_NAMES.WORKSPACE_MEMBER, ROLE_NAMES.WORKSPACE_VIEWER,
]

const _ROLE_FALLBACK_DESC: Record<string, string> = {
    [ROLE_NAMES.SUPER_ADMIN]: 'Full administrator. Unrestricted access across the whole organization.',
    [ROLE_NAMES.ORG_ADMIN]: 'Manages every workspace and creates new ones. Doesn\'t manage user accounts or sign-in.',
    [ROLE_NAMES.ORG_AUDITOR]: 'Read-only access to every workspace and the activity log.',
    [ROLE_NAMES.WORKSPACE_ADMIN]: 'Full control inside the workspace — members, settings, and content.',
    [ROLE_NAMES.WORKSPACE_DATA_ENGINEER]: 'Owns data sources, semantic layers, and views inside the workspace.',
    [ROLE_NAMES.WORKSPACE_MEMBER]: 'Day-to-day contributor. Creates and edits views and data sources.',
    [ROLE_NAMES.WORKSPACE_VIEWER]: 'Read-only access to the workspace.',
}


/** Adapter from the canonical ``RoleVisual`` to the {icon, bg, accent}
 *  shape this file's InviteForm + change-role modal use. */
function inviteRoleVisual(roleName: string): {
    icon: typeof Shield; bg: string; accent: string
} {
    const v = roleVisualFor(roleName)
    return {
        icon: v.icon,
        bg: v.iconBg,
        accent: `text-${v.accent}-600 dark:text-${v.accent}-400`,
    }
}



interface RoleOption {
    value: string                 // '' = No role
    label: string
    sublabel: string
    privileged: boolean
    scoped: boolean
    fixedWorkspaceId: string | null
    visual: { icon: typeof Shield; bg: string; accent: string }
    isBuiltin: boolean
}


function InviteForm({
    canGrantSuperAdmin, loading, onCancel, onSubmit,
}: {
    canGrantSuperAdmin: boolean
    loading: boolean
    onCancel: () => void
    onSubmit: (
        role: string | null,
        opts: {
            workspaceId?: string | null
            email?: string | null
            groupIds?: string[] | null
            allowShareableWithGroups?: boolean
            expiresInHours?: number
        },
    ) => void
}) {
    const [roles, setRoles] = useState<RoleDefinitionResponse[] | null>(null)
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[] | null>(null)
    const [groups, setGroups] = useState<GroupResponse[] | null>(null)
    const [selectedRole, setSelectedRole] = useState<string>('')
    const [workspaceId, setWorkspaceId] = useState<string>('')
    const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set())
    const [email, setEmail] = useState<string>('')
    // Phase 12: 24h | 7d | 30d | 90d.
    const [expiresIn, setExpiresIn] = useState<'24h' | '7d' | '30d' | '90d'>('30d')
    // Phase 14: opt-in override for shareable group invites. Default
    // OFF (groups → email required); flips to ON only after the admin
    // explicitly acknowledges the warning. Re-disables automatically
    // when groups are cleared or a privileged role is added.
    const [allowShareableGroups, setAllowShareableGroups] = useState<boolean>(false)
    // Inline confirmation panel inside the email callout.
    const [overrideConfirmOpen, setOverrideConfirmOpen] = useState<boolean>(false)
    const [overrideAck, setOverrideAck] = useState<boolean>(false)

    useEffect(() => {
        permissionsService.listRoles()
            .then(rs => setRoles(
                canGrantSuperAdmin ? rs : rs.filter(r => r.name !== ROLE_NAMES.SUPER_ADMIN),
            ))
            .catch(() => setRoles([]))
        workspaceService.list().then(setWorkspaces).catch(() => setWorkspaces([]))
        groupsService.list().then(setGroups).catch(() => setGroups([]))
    }, [canGrantSuperAdmin])

    const roleObj = useMemo(
        () => roles?.find(r => r.name === selectedRole) ?? null,
        [roles, selectedRole],
    )
    const isPrivileged = roleObj ? roleIsPrivileged(roleObj.permissions) : false
    const isWorkspaceScoped = roleObj ? roleNeedsWorkspace(roleObj) : false
    const fixedWorkspaceId = roleObj && roleObj.scopeType === 'workspace'
        ? roleObj.scopeId : null
    const needsWorkspacePick = isWorkspaceScoped && !fixedWorkspaceId
    const effectiveWorkspaceId = fixedWorkspaceId ?? (needsWorkspacePick ? workspaceId : null)

    // Phase 13: any group attachment makes the invite privileged-by-
    // policy on the backend; we mirror the UX here so the email field
    // flips to required before submit.
    // Phase 14: the admin can opt out of the groups-email rule by
    // toggling ``allowShareableGroups`` (the override). The override
    // does NOT relax the role-privilege rule — privileged roles still
    // require email even with the override on.
    const hasGroups = selectedGroups.size > 0
    const groupsRequireEmail = hasGroups && !allowShareableGroups
    const needsEmail = isPrivileged || groupsRequireEmail
    const overrideAvailable = hasGroups && !isPrivileged
    const overrideActive = allowShareableGroups && overrideAvailable

    // Reset the override if the conditions change — privileged role
    // added, or groups cleared — so a stale toggle can't leak through.
    useEffect(() => {
        if (!overrideAvailable && allowShareableGroups) {
            setAllowShareableGroups(false)
            setOverrideConfirmOpen(false)
            setOverrideAck(false)
        }
    }, [overrideAvailable, allowShareableGroups])

    const emailValid = /.+@.+\..+/.test(email.trim())
    const canSubmit =
        (!needsWorkspacePick || !!workspaceId)
        && (!needsEmail || emailValid)

    const expiresInHours = (() => {
        switch (expiresIn) {
            case '24h': return 24
            case '7d': return 24 * 7
            case '30d': return 24 * 30
            case '90d': return 24 * 90
        }
    })()

    const submit = () => {
        if (!canSubmit) return
        onSubmit(selectedRole || null, {
            workspaceId: isWorkspaceScoped ? effectiveWorkspaceId : null,
            email: email.trim() ? email.trim() : null,
            groupIds: hasGroups ? Array.from(selectedGroups) : null,
            allowShareableWithGroups: overrideActive,
            expiresInHours,
        })
    }

    const toggleGroup = (id: string) => {
        setSelectedGroups(prev => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id); else next.add(id)
            return next
        })
    }

    // Phase 13: classify by ``isSystem`` (not a hardcoded name list)
    // so legacy system roles like ``admin``/``user``/``viewer`` land
    // in Standard Roles, not Custom. The smart-visual helper picks an
    // icon/colour from role characteristics for any role without a
    // curated entry.
    // The invite flow is about getting someone INTO the organization.
    // Workspace-specific access is something each workspace's admin
    // grants from their own Members tab after the user signs up — so
    // we only surface two buckets in this picker:
    //   * Organization access — built-in tiers that apply across the
    //     whole org (super_admin / org_admin / org_auditor). ``user``
    //     is the implicit default and lives in the "Standard user"
    //     card up top.
    //   * Custom roles — admin-defined. Workspace-scoped custom roles
    //     are kept here in case an admin built one for a specific
    //     onboarding flow; their workspace pick still works via the
    //     right rail when one is selected.
    // Built-in workspace tiers (workspace_admin/member/viewer/
    // data_engineer) are intentionally NOT shown here — workspace
    // admins assign those from inside the workspace.
    const { platformTiers, customRoles, noRole } = useMemo(() => {
        const opt = (r: RoleDefinitionResponse): RoleOption => {
            const v = inviteRoleVisual(r.name)
            return {
                value: r.name,
                label: roleVisualFor(r.name).label,
                sublabel: r.description?.trim()
                    || _ROLE_FALLBACK_DESC[r.name]
                    || (roleNeedsWorkspace(r) ? 'Workspace-scoped role.' : 'Global role.'),
                privileged: roleIsPrivileged(r.permissions),
                scoped: roleNeedsWorkspace(r),
                fixedWorkspaceId: r.scopeType === 'workspace' ? r.scopeId : null,
                visual: v,
                isBuiltin: r.isSystem,
            }
        }
        const all = (roles ?? []).map(opt)
        const platformTiers: RoleOption[] = []
        const customRoles: RoleOption[] = []
        for (const o of all) {
            if (!o.isBuiltin) {
                customRoles.push(o)
                continue
            }
            // Drop built-in workspace tiers. They belong in each
            // workspace's own Members tab, not the org-level invite.
            if (o.scoped) continue
            platformTiers.push(o)
        }
        const byCanonicalOrder = (a: RoleOption, b: RoleOption) => {
            const ia = _BUILTIN_ORDER.indexOf(a.value)
            const ib = _BUILTIN_ORDER.indexOf(b.value)
            if (ia >= 0 && ib >= 0) return ia - ib
            if (ia >= 0) return -1
            if (ib >= 0) return 1
            return a.label.localeCompare(b.label)
        }
        platformTiers.sort(byCanonicalOrder)
        customRoles.sort((a, b) => a.label.localeCompare(b.label))
        const noRole: RoleOption = {
            value: '',
            label: 'Standard user',
            sublabel: 'A regular team account with no organization-wide privileges. A workspace admin will invite them into specific workspaces with the right role from inside that workspace.',
            privileged: false, scoped: false, fixedWorkspaceId: null,
            visual: _ROLE_VISUAL_NONE, isBuiltin: false,
        }
        return { platformTiers, customRoles, noRole }
    }, [roles])

    const fixedWorkspace = fixedWorkspaceId
        ? workspaces?.find(w => w.id === fixedWorkspaceId)
        : null

    // Phase 13: live summary inputs for the receipt preview.
    const selectedGroupNames = useMemo(() => {
        if (!groups) return []
        return Array.from(selectedGroups)
            .map(id => groups.find(g => g.id === id)?.name)
            .filter((n): n is string => !!n)
    }, [groups, selectedGroups])
    const summaryWorkspaceName = effectiveWorkspaceId
        ? (workspaces?.find(w => w.id === effectiveWorkspaceId)?.name ?? effectiveWorkspaceId)
        : null
    const summaryRoleLabel = selectedRole
        ? roleVisualFor(selectedRole).label
        : null

    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            // Phase 14: claim the full vertical budget of the modal
            // shell so the body can scroll internally and the footer
            // stays sticky.
            className="flex-1 flex flex-col min-h-0 -mx-6"
        >
            <p className="text-sm text-ink-secondary mb-4 px-6">
                Generate a link that lets a new user sign up as a standard team member.
                Optionally elevate them to an organization-wide role, or add them to groups.
                Workspace-specific access is granted by each workspace's admin after signup.
            </p>

            {roles === null ? (
                <div className="px-6"><RoleListSkeleton /></div>
            ) : (
                <>
                    {/* Scrollable body — wraps the role pickers + the
                        two-column config grid + the live summary. The
                        footer below sits outside this scroll region.
                        Grid:
                          * Left column has a 0 minimum so long role
                            descriptions truncate inside the column
                            instead of stealing width from the right
                            rail.
                          * Right column has an explicit 260px minimum
                            so it can never collapse to a sliver (last
                            bug: ``minmax(0,1fr)`` let it shrink to a
                            1-character-wide vertical strip when role
                            descriptions ate the available space). */}
                    <div className="flex-1 overflow-y-auto px-6 min-w-0">
                        <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.1fr)_minmax(260px,1fr)] gap-x-6 gap-y-0 min-w-0">
                            {/* ── LEFT column — Role catalogue ─────────── */}
                            <div>
                                <SectionLabel>Choose a role</SectionLabel>
                                <NoRoleCard
                                    option={noRole}
                                    selected={selectedRole === ''}
                                    onSelect={() => setSelectedRole('')}
                                />
                                <div className="space-y-3 mt-3 max-h-[360px] overflow-y-auto pr-1">
                                    {platformTiers.length > 0 && (
                                        <RoleGroup
                                            title="Elevate to a privileged role"
                                            subtitle="Optional. Grants access across the whole organization."
                                            options={platformTiers}
                                            selected={selectedRole}
                                            onSelect={setSelectedRole}
                                        />
                                    )}
                                    {customRoles.length > 0 && (
                                        <RoleGroup
                                            title="Custom roles"
                                            subtitle="Created by your team. How they work depends on the role."
                                            options={customRoles}
                                            selected={selectedRole}
                                            onSelect={setSelectedRole}
                                        />
                                    )}
                                </div>
                            </div>

                            {/* ── RIGHT column — Workspace + Groups + Email ──
                                ``min-w-0`` lets the column shrink below its
                                natural content width so long workspace / group /
                                recipient strings truncate inside the column
                                instead of pushing the modal to overflow. */}
                            <div className="min-w-0 space-y-0 md:border-l md:border-glass-border md:pl-6 mt-5 md:mt-0">

                    {/* ── Section 2 — Workspace (animated) ───────────── */}
                    <AnimatePresence initial={false}>
                        {isWorkspaceScoped && (
                            <motion.div
                                key="ws-section"
                                initial={{ opacity: 0, height: 0 }}
                                animate={{ opacity: 1, height: 'auto' }}
                                exit={{ opacity: 0, height: 0 }}
                                transition={{ duration: 0.18 }}
                                className="overflow-hidden"
                            >
                                <div>
                                    <SectionLabel>Workspace</SectionLabel>
                                    {fixedWorkspaceId ? (
                                        <div className="flex items-center gap-2.5 p-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-glass-border">
                                            <Building2 className="w-4 h-4 text-ink-muted shrink-0" />
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm font-semibold text-ink truncate">
                                                    {fixedWorkspace?.name ?? fixedWorkspaceId}
                                                </p>
                                                <p className="text-[11px] text-ink-muted">
                                                    This custom role is fixed to this workspace.
                                                </p>
                                            </div>
                                            <Lock className="w-3.5 h-3.5 text-ink-muted shrink-0" />
                                        </div>
                                    ) : (
                                        <WorkspacePicker
                                            workspaces={workspaces}
                                            value={workspaceId}
                                            onChange={setWorkspaceId}
                                        />
                                    )}
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* ── Section 3 — Groups ─────────────────────────── */}
                    <div className="mt-5">
                        <SectionLabel>
                            Add to Groups
                            <span className="ml-1 text-ink-muted normal-case tracking-normal font-normal">
                                (optional)
                            </span>
                        </SectionLabel>
                        <GroupsPicker
                            groups={groups}
                            selected={selectedGroups}
                            onToggle={toggleGroup}
                        />
                        <p className="text-[11px] text-ink-muted mt-2">
                            Group memberships apply across every workspace the
                            group is bound to. Attaching groups makes the invite
                            email-bound (we can't let a forwarded link grant
                            unknown cross-workspace access).
                        </p>
                    </div>

                    {/* ── Section 4 — Recipient (email) ──────────────── */}
                    <div className="mt-5">
                        <SectionLabel>
                            Recipient
                            {needsEmail ? (
                                <span className="ml-1 text-amber-600 dark:text-amber-400 normal-case tracking-normal font-normal">
                                    (required)
                                </span>
                            ) : (
                                <span className="ml-1 text-ink-muted normal-case tracking-normal font-normal">
                                    (optional)
                                </span>
                            )}
                        </SectionLabel>

                        <AnimatePresence initial={false}>
                            {/* Amber email-required callout — only when the
                                requirement is active (privileged role or
                                groups-without-override). */}
                            {needsEmail && (
                                <motion.div
                                    key="priv-callout"
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                    transition={{ duration: 0.18 }}
                                    className="p-3 mb-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300"
                                >
                                    <div className="flex items-start gap-2.5">
                                        <Lock className="w-4 h-4 shrink-0 mt-0.5" />
                                        <div className="text-xs leading-snug flex-1 min-w-0">
                                            <p className="font-semibold">
                                                {isPrivileged
                                                    ? 'Privileged role — email required.'
                                                    : 'Group attachments — email required.'}
                                            </p>
                                            <p className="mt-0.5 text-amber-700/80 dark:text-amber-300/80">
                                                {isPrivileged
                                                    ? 'This role grants admin or system perms. Pinning to an email stops a forwarded link from escalating someone else.'
                                                    : 'Group memberships can reach across workspaces. Pinning to an email stops a forwarded link from granting the wrong identity that access.'}
                                            </p>
                                            {/* Override link — only when the
                                                requirement is solely from groups
                                                (not a privileged role) AND the
                                                confirmation panel isn't already
                                                open. */}
                                            {overrideAvailable && !overrideConfirmOpen && (
                                                <button
                                                    type="button"
                                                    onClick={() => {
                                                        setOverrideConfirmOpen(true)
                                                        setOverrideAck(false)
                                                    }}
                                                    className="mt-1.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-amber-700 dark:text-amber-300 hover:underline"
                                                >
                                                    Make this a shareable group invite →
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {/* Inline confirmation panel. */}
                                    <AnimatePresence initial={false}>
                                        {overrideConfirmOpen && (
                                            <motion.div
                                                key="override-panel"
                                                initial={{ opacity: 0, height: 0 }}
                                                animate={{ opacity: 1, height: 'auto' }}
                                                exit={{ opacity: 0, height: 0 }}
                                                transition={{ duration: 0.18 }}
                                                className="overflow-hidden"
                                            >
                                                <div className="mt-3 p-3 rounded-xl bg-canvas-elevated border border-amber-500/40 text-ink">
                                                    <div className="flex items-start gap-2.5">
                                                        <AlertCircle className="w-4 h-4 text-amber-500 shrink-0 mt-0.5" />
                                                        <div className="text-xs leading-snug flex-1 min-w-0">
                                                            <p className="font-bold">Override the email pin?</p>
                                                            <p className="mt-1 text-ink-secondary">
                                                                Anyone with this link can sign up and join{' '}
                                                                <span className="font-semibold text-ink">
                                                                    {selectedGroupNames.join(', ')}
                                                                </span>. Forwardable and reusable — only override for
                                                                low-stakes, broadly-shared groups.
                                                            </p>
                                                            <label className="mt-2.5 flex items-start gap-2 cursor-pointer select-none">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={overrideAck}
                                                                    onChange={e => setOverrideAck(e.target.checked)}
                                                                    className="mt-0.5 accent-amber-500 cursor-pointer"
                                                                />
                                                                <span className="text-[11px] text-ink-secondary">
                                                                    I understand this link can be shared and reused
                                                                    by multiple people.
                                                                </span>
                                                            </label>
                                                            <div className="mt-3 flex items-center gap-2 flex-wrap">
                                                                <button
                                                                    type="button"
                                                                    onClick={() => {
                                                                        setOverrideConfirmOpen(false)
                                                                        setOverrideAck(false)
                                                                    }}
                                                                    className="px-3 py-1.5 rounded-lg text-[11px] font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors whitespace-nowrap"
                                                                >
                                                                    Cancel
                                                                </button>
                                                                <button
                                                                    type="button"
                                                                    disabled={!overrideAck}
                                                                    onClick={() => {
                                                                        setAllowShareableGroups(true)
                                                                        setOverrideConfirmOpen(false)
                                                                    }}
                                                                    className={cn(
                                                                        "inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors whitespace-nowrap",
                                                                        overrideAck
                                                                            ? "bg-amber-500 text-white hover:brightness-110"
                                                                            : "bg-amber-500/30 text-amber-700 dark:text-amber-300 cursor-not-allowed",
                                                                    )}
                                                                >
                                                                    <Lock className="w-3 h-3" />
                                                                    Make shareable
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </motion.div>
                            )}

                            {/* Slate notice — shown when the override is
                                active. Replaces the amber callout. */}
                            {overrideActive && (
                                <motion.div
                                    key="override-active"
                                    initial={{ opacity: 0, y: -4 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0, y: -4 }}
                                    transition={{ duration: 0.18 }}
                                    className="flex items-start gap-2.5 p-3 mb-3 rounded-xl bg-slate-500/10 border border-slate-500/20 text-slate-700 dark:text-slate-300"
                                >
                                    <Users2 className="w-4 h-4 shrink-0 mt-0.5" />
                                    <div className="text-xs leading-snug flex-1 min-w-0">
                                        <p className="font-semibold">Shareable group invite</p>
                                        <p className="mt-0.5 text-slate-700/80 dark:text-slate-300/80">
                                            Anyone with this link can sign up and join the
                                            selected {selectedGroupNames.length === 1 ? 'group' : 'groups'}.
                                            Email is optional.
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() => setAllowShareableGroups(false)}
                                        className="p-1 -m-1 rounded-md text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
                                        title="Require email instead"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </motion.div>
                            )}
                        </AnimatePresence>

                        <div className="relative group">
                            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors">
                                <AtSign className="w-4 h-4" />
                            </div>
                            <input
                                type="email"
                                value={email}
                                onChange={e => setEmail(e.target.value)}
                                placeholder="user@company.com"
                                className={cn(
                                    "w-full bg-canvas-elevated border rounded-xl pl-10 pr-3 py-2.5 text-sm text-ink placeholder:text-ink-muted focus:outline-none transition-colors",
                                    needsEmail && !emailValid
                                        ? "border-amber-500/40 focus:border-amber-500/60"
                                        : "border-glass-border focus:border-accent-lineage/40",
                                )}
                            />
                        </div>
                        <p className="text-[11px] text-ink-muted mt-1.5">
                            {needsEmail
                                ? "The link will refuse any signup whose email doesn't match."
                                : overrideActive
                                    ? "Optional — the link is shareable and reusable."
                                    : "Leave blank for a shareable link, or pin to one email for a single-recipient invite."}
                        </p>
                    </div>
                            {/* ── close RIGHT column ────────────────── */}
                            </div>
                        {/* ── close two-column grid ─────────────────── */}
                        </div>

                    {/* ── Section 5 — Access duration (full width) ───── */}
                    <div className="border-t border-glass-border mt-5 pt-5 mb-5">
                        <SectionLabel>Link expires in</SectionLabel>
                        <div className="flex flex-wrap gap-2">
                            {(['24h', '7d', '30d', '90d'] as const).map(opt => {
                                const isSelected = expiresIn === opt
                                return (
                                    <button
                                        key={opt}
                                        type="button"
                                        onClick={() => setExpiresIn(opt)}
                                        className={cn(
                                            'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                            isSelected
                                                ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
                                                : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                                        )}
                                    >
                                        {opt}
                                    </button>
                                )
                            })}
                        </div>
                        <p className="text-[11px] text-ink-muted mt-2">
                            After this window, the link stops working. The user
                            can still sign up — they'll need a new invite or admin approval.
                        </p>
                    </div>

                    {/* ── Live summary preview (full width) ──────────── */}
                    <InviteSummary
                        roleLabel={summaryRoleLabel}
                        workspaceName={summaryWorkspaceName}
                        groupNames={selectedGroupNames}
                        email={email.trim() || null}
                        emailRequired={needsEmail}
                        shareable={overrideActive}
                        expiresIn={expiresIn}
                    />
                    {/* ── close scroll body ──────────────────────────── */}
                    </div>

                    {/* ── Sticky footer ──────────────────────────────── */}
                    <div className="px-6 pt-4 mt-0 border-t border-glass-border bg-canvas-elevated/95 backdrop-blur">
                        <ModalFooter onCancel={onCancel} onConfirm={submit}
                            confirmLabel="Generate Link" confirmIcon={Link2}
                            confirmClass="bg-accent-lineage hover:brightness-110 shadow-accent-lineage/20"
                            loading={loading} disabled={!canSubmit} />
                    </div>
                </>
            )}
        </motion.div>
    )
}


function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
            {children}
        </p>
    )
}


function RoleListSkeleton() {
    return (
        <div className="space-y-1.5 mb-4">
            {[0, 1, 2, 3].map(i => (
                <div
                    key={i}
                    className="h-14 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] animate-pulse"
                />
            ))}
        </div>
    )
}


function RoleGroup({
    title, subtitle, options, selected, onSelect,
}: {
    title: string
    subtitle?: string
    options: RoleOption[]
    selected: string
    onSelect: (v: string) => void
}) {
    return (
        <div>
            <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted/80 mb-0.5 px-1">
                {title}
            </p>
            {subtitle && (
                <p className="text-[10px] text-ink-muted/70 mb-1.5 px-1 italic">
                    {subtitle}
                </p>
            )}
            <div className="space-y-1.5">
                {options.map(opt => {
                    const isSelected = selected === opt.value
                    const Icon = opt.visual.icon
                    return (
                        <button
                            key={opt.value || '__none__'}
                            type="button"
                            onClick={() => onSelect(opt.value)}
                            className={cn(
                                'w-full flex items-center gap-3 p-3 rounded-xl border-2 text-left transition-colors duration-150',
                                isSelected
                                    ? 'border-accent-lineage bg-accent-lineage/5 shadow-sm'
                                    : 'border-glass-border bg-canvas-elevated hover:border-ink-muted/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                            )}
                        >
                            <div
                                className={cn(
                                    'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
                                    opt.visual.bg,
                                )}
                            >
                                <Icon className="w-4 h-4" />
                            </div>
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-1.5 flex-wrap">
                                    <p
                                        className={cn(
                                            'text-sm font-semibold truncate',
                                            isSelected ? opt.visual.accent : 'text-ink',
                                        )}
                                    >
                                        {opt.label}
                                    </p>
                                    {opt.scoped && (
                                        <span className="inline-flex items-center px-1.5 py-px rounded-full text-[9px] font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                                            workspace
                                        </span>
                                    )}
                                    {opt.privileged && (
                                        <span className="inline-flex items-center gap-0.5 px-1.5 py-px rounded-full text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                            <Lock className="w-2.5 h-2.5" />
                                            privileged
                                        </span>
                                    )}
                                </div>
                                <p className="text-[11px] text-ink-muted leading-snug mt-0.5 truncate">
                                    {opt.sublabel}
                                </p>
                            </div>
                            {isSelected && (
                                <CheckCircle2 className="w-5 h-5 text-accent-lineage shrink-0" />
                            )}
                        </button>
                    )
                })}
            </div>
        </div>
    )
}


function WorkspacePicker({
    workspaces, value, onChange,
}: {
    workspaces: WorkspaceResponse[] | null
    value: string
    onChange: (v: string) => void
}) {
    if (workspaces === null) {
        return (
            <div className="h-10 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] animate-pulse" />
        )
    }
    if (workspaces.length === 0) {
        return (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>No workspaces available — create one before inviting workspace-scoped users.</span>
            </div>
        )
    }
    // ≤ 5 → inline chip grid (most-common case). > 5 → styled select.
    if (workspaces.length <= 5) {
        return (
            <div className="grid grid-cols-2 gap-2">
                {workspaces.map(w => {
                    const isSelected = value === w.id
                    return (
                        <button
                            key={w.id}
                            type="button"
                            onClick={() => onChange(w.id)}
                            className={cn(
                                'flex items-center gap-2 px-3 py-2 rounded-xl border text-left transition-colors',
                                isSelected
                                    ? 'border-accent-lineage bg-accent-lineage/5 text-accent-lineage'
                                    : 'border-glass-border bg-canvas-elevated text-ink hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                            )}
                        >
                            <Building2 className="w-4 h-4 shrink-0" />
                            <span className="text-sm font-medium truncate">{w.name}</span>
                            {isSelected && (
                                <CheckCircle2 className="w-4 h-4 ml-auto shrink-0" />
                            )}
                        </button>
                    )
                })}
            </div>
        )
    }
    // Many workspaces — fall back to a styled native select.
    return (
        <div className="relative">
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none">
                <Building2 className="w-4 h-4" />
            </div>
            <div className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none">
                <ChevronDown className="w-4 h-4" />
            </div>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                className="w-full appearance-none bg-canvas-elevated border border-glass-border rounded-xl pl-10 pr-9 py-2.5 text-sm text-ink focus:outline-none focus:border-accent-lineage/40 transition-colors"
            >
                <option value="">Select a workspace…</option>
                {workspaces.map(w => (
                    <option key={w.id} value={w.id}>{w.name}</option>
                ))}
            </select>
        </div>
    )
}


// ── Phase 13: hero card for the "No role" option ─────────────────────
// Sits above the standard / custom catalogue so it reads as "skip this
// step entirely", not just another role in a list.
function NoRoleCard({
    option, selected, onSelect,
}: {
    option: RoleOption
    selected: boolean
    onSelect: () => void
}) {
    const Icon = option.visual.icon
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                'w-full flex items-center gap-3 p-3.5 rounded-2xl border-2 text-left transition-colors duration-150',
                selected
                    ? 'border-accent-lineage bg-gradient-to-br from-accent-lineage/8 to-accent-lineage/0 shadow-sm'
                    : 'border-glass-border bg-canvas-elevated hover:border-ink-muted/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
            )}
        >
            <div className={cn(
                'w-10 h-10 rounded-xl border flex items-center justify-center shrink-0',
                option.visual.bg,
            )}>
                <Icon className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
                <p className={cn(
                    'text-sm font-semibold',
                    selected ? option.visual.accent : 'text-ink',
                )}>
                    {option.label}
                </p>
                <p className="text-[11px] text-ink-muted leading-snug mt-0.5">
                    {option.sublabel}
                </p>
            </div>
            {selected && (
                <CheckCircle2 className="w-5 h-5 text-accent-lineage shrink-0" />
            )}
        </button>
    )
}


// ── Phase 13: multi-select group picker ──────────────────────────────
function GroupsPicker({
    groups, selected, onToggle,
}: {
    groups: GroupResponse[] | null
    selected: Set<string>
    onToggle: (id: string) => void
}) {
    // Phase 14.1: client-side search + 5-per-page pagination so the
    // picker scales to 50+ groups without overwhelming the modal.
    // Selected groups stay pinned as chips above the picker so they
    // never disappear when the user pages / filters away from them.
    const [search, setSearch] = useState('')
    const [page, setPage] = useState(0)
    const PAGE_SIZE = 5

    // Reset to page 0 whenever the search term changes — otherwise
    // we'd land on a non-existent page after typing a narrower query.
    useEffect(() => { setPage(0) }, [search])

    const filtered = useMemo(() => {
        if (!groups) return [] as GroupResponse[]
        const q = search.trim().toLowerCase()
        if (!q) return groups
        return groups.filter(g => g.name.toLowerCase().includes(q))
    }, [groups, search])

    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
    const safePage = Math.min(page, totalPages - 1)
    const pageStart = safePage * PAGE_SIZE
    const pageItems = filtered.slice(pageStart, pageStart + PAGE_SIZE)

    if (groups === null) {
        return (
            <div className="space-y-1.5">
                {[0, 1].map(i => (
                    <div
                        key={i}
                        className="h-12 rounded-xl border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] animate-pulse"
                    />
                ))}
            </div>
        )
    }
    if (groups.length === 0) {
        return (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-dashed border-glass-border text-ink-muted text-xs">
                <Users2 className="w-3.5 h-3.5 shrink-0" />
                <span>No groups defined yet — create one in <span className="font-semibold">Admin → Groups</span> to add new users to it on signup.</span>
            </div>
        )
    }

    // Build the "selected chips" row from the full groups list (not
    // the filtered slice) so chips stay visible across pages.
    const selectedGroups = groups.filter(g => selected.has(g.id))
    const showPagination = filtered.length > PAGE_SIZE
    const showSearch = groups.length > PAGE_SIZE

    return (
        <div className="space-y-2">
            {/* Selected-group chips — always visible. */}
            {selectedGroups.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                    {selectedGroups.map(g => (
                        <button
                            key={g.id}
                            type="button"
                            onClick={() => onToggle(g.id)}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-accent-lineage/10 text-accent-lineage border border-accent-lineage/20 hover:bg-accent-lineage/15 transition-colors"
                            title="Remove from invite"
                        >
                            <Users2 className="w-3 h-3" />
                            {g.name}
                            <X className="w-2.5 h-2.5 opacity-70 hover:opacity-100" />
                        </button>
                    ))}
                </div>
            )}

            {/* Search — only when there are enough groups to warrant it. */}
            {showSearch && (
                <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">
                        <Search className="w-3.5 h-3.5" />
                    </div>
                    <input
                        type="text"
                        value={search}
                        onChange={e => setSearch(e.target.value)}
                        placeholder="Search groups…"
                        className="w-full bg-canvas-elevated border border-glass-border rounded-xl pl-9 pr-3 py-2 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/40 transition-colors"
                    />
                </div>
            )}

            {/* Page contents — fixed PAGE_SIZE rows so the modal
                doesn't shift height as the user types. */}
            <div className="grid grid-cols-1 gap-1.5">
                {pageItems.length === 0 ? (
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-dashed border-glass-border text-ink-muted text-xs">
                        <Search className="w-3.5 h-3.5 shrink-0" />
                        <span>No groups match "{search}".</span>
                    </div>
                ) : (
                    pageItems.map(g => {
                        const isSelected = selected.has(g.id)
                        return (
                            <button
                                key={g.id}
                                type="button"
                                onClick={() => onToggle(g.id)}
                                className={cn(
                                    'flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-colors',
                                    isSelected
                                        ? 'border-accent-lineage bg-accent-lineage/5'
                                        : 'border-glass-border bg-canvas-elevated hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                                )}
                            >
                                <div className={cn(
                                    'w-8 h-8 rounded-lg border flex items-center justify-center shrink-0',
                                    'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
                                )}>
                                    <Users2 className="w-4 h-4" />
                                </div>
                                <div className="flex-1 min-w-0">
                                    <p className={cn(
                                        'text-sm font-semibold truncate',
                                        isSelected ? 'text-accent-lineage' : 'text-ink',
                                    )}>
                                        {g.name}
                                    </p>
                                    <p className="text-[11px] text-ink-muted">
                                        {g.memberCount} {g.memberCount === 1 ? 'member' : 'members'}
                                    </p>
                                </div>
                                {isSelected && (
                                    <CheckCircle2 className="w-4 h-4 text-accent-lineage shrink-0" />
                                )}
                            </button>
                        )
                    })
                )}
            </div>

            {/* Pagination controls — only when more than one page. */}
            {showPagination && (
                <div className="flex items-center justify-between pt-1">
                    <p className="text-[11px] text-ink-muted">
                        {pageStart + 1}–{Math.min(pageStart + PAGE_SIZE, filtered.length)} of {filtered.length}
                    </p>
                    <div className="flex items-center gap-1">
                        <button
                            type="button"
                            disabled={safePage === 0}
                            onClick={() => setPage(p => Math.max(0, p - 1))}
                            className={cn(
                                'inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors',
                                safePage === 0
                                    ? 'border-glass-border text-ink-muted/40 cursor-not-allowed'
                                    : 'border-glass-border text-ink-secondary hover:text-ink hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                            )}
                            title="Previous page"
                        >
                            <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-[11px] font-semibold text-ink-secondary px-1.5 min-w-[3rem] text-center">
                            {safePage + 1} / {totalPages}
                        </span>
                        <button
                            type="button"
                            disabled={safePage >= totalPages - 1}
                            onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                            className={cn(
                                'inline-flex items-center justify-center w-7 h-7 rounded-lg border transition-colors',
                                safePage >= totalPages - 1
                                    ? 'border-glass-border text-ink-muted/40 cursor-not-allowed'
                                    : 'border-glass-border text-ink-secondary hover:text-ink hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                            )}
                            title="Next page"
                        >
                            <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}


// ── Phase 13: live invite summary preview ────────────────────────────
// A small receipt above the Generate Link button that explains in
// plain English what the invite will do. Builds entirely from the
// form's live state so it adapts as the user changes anything.
function InviteSummary({
    roleLabel, workspaceName, groupNames, email, emailRequired, shareable, expiresIn,
}: {
    roleLabel: string | null
    workspaceName: string | null
    groupNames: string[]
    email: string | null
    emailRequired: boolean
    /** Phase 14: when true, the invite is explicitly a shareable
     *  group invite — the summary narrates that instead of
     *  "Shareable link (no email pin)." */
    shareable: boolean
    expiresIn: string
}) {
    // Build a tiny sentence: "Activate a new account, [grant Role in
    // Workspace], [add to groups X, Y]. [Email-bound to a@x.com] or
    // [Shareable]. Expires in 30d."
    const parts: string[] = ['Activate a new account']
    if (roleLabel) {
        if (workspaceName) {
            parts.push(`grant ${roleLabel} in ${workspaceName}`)
        } else {
            parts.push(`grant ${roleLabel}`)
        }
    }
    if (groupNames.length > 0) {
        parts.push(`add to ${groupNames.length === 1 ? 'group' : 'groups'} ${groupNames.join(', ')}`)
    }

    const recipient = email
        ? `Email-bound to ${email}.`
        : shareable
            ? 'Shareable group invite — anyone with the link can sign up.'
            : (emailRequired
                ? 'Email required.'
                : 'Shareable link (no email pin).')

    return (
        <motion.div
            key={parts.join('|') + '|' + recipient + '|' + expiresIn}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.15 }}
            className="mt-2 mb-5 p-4 rounded-2xl bg-accent-lineage/5 border border-accent-lineage/20"
        >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-accent-lineage mb-1.5">
                This invite will
            </p>
            <p className="text-xs text-ink leading-relaxed">
                {parts.join(', ')}.{' '}
                <span className={cn(emailRequired && !email && 'text-amber-600 dark:text-amber-400 font-medium')}>
                    {recipient}
                </span>
                {' '}Link expires in <span className="font-semibold">{expiresIn}</span>.
            </p>
        </motion.div>
    )
}


// ── Phase 12: premium invite result card ─────────────────────────────
function InviteResultCard({
    result, inviteUrl, copied, onCopy, onAnother, onClose,
}: {
    result: InviteResponse
    inviteUrl: string
    copied: boolean
    onCopy: () => void
    onAnother: () => void
    onClose: () => void
}) {
    const roleLabel = result.role
        ? roleVisualFor(result.role).label
        : 'No role (plain account)'
    const expiresWhen = (() => {
        const d = new Date(result.expiresAt)
        const diff = d.getTime() - Date.now()
        const days = Math.max(0, Math.floor(diff / 86_400_000))
        const hours = Math.max(0, Math.floor(diff / 3_600_000))
        return days >= 1 ? `${days}d` : `${hours}h`
    })()
    return (
        <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className="space-y-4 mb-1"
        >
            {/* Hero */}
            <div className="flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-br from-emerald-500/10 to-emerald-500/0 border border-emerald-500/20">
                <div className="w-11 h-11 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center shrink-0">
                    <Sparkles className="w-5 h-5 text-emerald-500" />
                </div>
                <div className="min-w-0">
                    <p className="text-sm font-bold text-ink">Invite ready</p>
                    <p className="text-xs text-ink-muted">
                        Copy the link below and share it with the recipient.
                    </p>
                </div>
            </div>

            {/* Link card */}
            <div className="p-4 rounded-2xl bg-canvas-elevated border border-glass-border">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-ink-muted mb-2">
                    Invite link
                </p>
                <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono bg-black/5 dark:bg-white/5 px-3 py-2.5 rounded-xl break-all text-ink select-all">
                        {inviteUrl}
                    </code>
                    <button onClick={onCopy}
                        className={cn(
                            "p-2.5 rounded-xl transition-colors shrink-0",
                            copied
                                ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                                : "bg-accent-lineage/10 text-accent-lineage hover:bg-accent-lineage/20",
                        )}
                        title={copied ? 'Copied' : 'Copy to clipboard'}
                    >
                        {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                    </button>
                </div>

                {/* Metadata grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-4">
                    <MetaTile icon={Shield} label="Role" value={roleLabel} />
                    {result.workspaceId && (
                        <MetaTile icon={Building2} label="Workspace" value={result.workspaceId} />
                    )}
                    {result.groupIds && result.groupIds.length > 0 && (
                        <MetaTile
                            icon={Users2}
                            label={result.groupIds.length === 1 ? 'Group' : 'Groups'}
                            value={`${result.groupIds.length} attached`}
                        />
                    )}
                    <MetaTile icon={Clock} label="Expires in" value={expiresWhen} />
                    {result.email ? (
                        <MetaTile
                            icon={Lock}
                            label="Email-bound"
                            value={result.email}
                            tone="amber"
                        />
                    ) : (
                        <MetaTile
                            icon={Mail}
                            label="Recipient"
                            value="Shareable link"
                            tone="slate"
                        />
                    )}
                </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between gap-3">
                <button
                    onClick={onAnother}
                    className="text-xs font-semibold text-ink-muted hover:text-ink transition-colors"
                >
                    Generate another
                </button>
                <button
                    onClick={onClose}
                    className="px-4 py-2.5 rounded-xl text-sm font-semibold bg-accent-lineage text-white hover:brightness-110 transition-colors duration-150 shadow-sm shadow-accent-lineage/20"
                >
                    Done
                </button>
            </div>
        </motion.div>
    )
}


function MetaTile({
    icon: Icon, label, value, tone = 'neutral',
}: {
    icon: typeof Shield
    label: string
    value: string
    tone?: 'neutral' | 'amber' | 'slate'
}) {
    const toneCls =
        tone === 'amber'
            ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/20'
            : tone === 'slate'
                ? 'bg-slate-500/10 text-slate-700 dark:text-slate-300 border-slate-500/20'
                : 'bg-black/[0.03] dark:bg-white/[0.03] border-glass-border'
    return (
        <div className={cn('flex items-center gap-2.5 p-2.5 rounded-xl border', toneCls)}>
            <Icon className="w-3.5 h-3.5 shrink-0" />
            <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider font-semibold opacity-70">
                    {label}
                </p>
                <p className="text-xs font-medium truncate">{value}</p>
            </div>
        </div>
    )
}
