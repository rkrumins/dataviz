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
import { useState, useEffect, useCallback, useMemo, createElement } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Users, CheckCircle2, XCircle, Clock, Shield, AlertCircle,
    RefreshCw, Search, UserPlus, Ban, X, Loader2, Mail,
    ChevronDown, ChevronUp,
    KeyRound, UserCog,
    RotateCcw, Lock, Copy, Check, Link2, Pencil, ScrollText, ListChecks, AtSign,
} from 'lucide-react'
import {
    adminUserService,
    type AdminUserResponse,
    type BulkCreateUsersRequest,
    type BulkCreateUsersResponse,
    type BulkInviteResponse,
    type CreatedUser,
    type CreateInviteOptions,
    type CreateUserRequest,
    type InviteResponse,
} from '@/services/adminUserService'
import { useFeature } from '@/store/features'
import { AdminInvites } from './AdminInvites'
import { InviteWizard } from './InviteWizard'
import { CreateUserWizard } from './CreateUserWizard'
import { permissionsService, type UserAccessResponse } from '@/services/permissionsService'
import { usePermission } from '@/store/auth'
import { Backdrop } from '@/components/ui/Backdrop'
import { HoverTip } from '@/components/ui/HoverTip'
import { TablePagination } from '@/components/ui/TablePagination'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { logoFor } from '@/components/admin/sso/IdpLogos'
import { presetById } from '@/components/admin/sso/vendorPresets'
import { cn } from '@/lib/utils'
import { roleVisualFor } from '@/lib/roleVisual'
import { AccessSummary } from '@/components/access/AccessSummary'
import {
    ROLE_NAMES,
    PLATFORM_ADMIN_ROLES,
    type RoleName,
} from '@/lib/roleNames'
import { PageContainer } from '@/components/layout/PageContainer'


// Phase 11: classify a role for invite purposes from its catalogue
// entry. Mirrors the backend rules so the modal can drive the
// workspace-picker + email-required UX before the request is sent.
type StatusFilter = 'all' | 'pending' | 'active' | 'suspended'
type SortField = 'name' | 'email' | 'status' | 'role' | 'createdAt'
type SortDir = 'asc' | 'desc'
type ModalType =
    | { kind: 'reject'; userId: string; name: string }
    | { kind: 'role'; userId: string; name: string; currentRole: string }
    | { kind: 'suspend'; userId: string; name: string }
    | { kind: 'resetPassword'; userId: string; name: string }
    | { kind: 'invite' }
    | { kind: 'createUser' }
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

// ── How an account signs in, as chips ────────────────────────────────
//
// Local (password), each linked IdP by name with its vendor mark, or a
// stranded account with neither. Everything explains itself on hover —
// last sign-in, whether SSO provisioned the account, what "Local"
// means — so the table answers "who is SSO, and from where" without
// opening a single row.

const MAX_PROVIDER_CHIPS = 2
const SIGNIN_CHIP =
    'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border'

function SignInMethods({ user }: { user: AdminUserResponse }) {
    const identities = user.identities ?? []
    const shown = identities.slice(0, MAX_PROVIDER_CHIPS)
    const overflow = identities.slice(MAX_PROVIDER_CHIPS)

    if (identities.length === 0) {
        return user.hasPassword ? (
            <HoverTip label="Signs in with an email and password. No SSO identity is linked.">
                <span className={cn(SIGNIN_CHIP, 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-secondary border-glass-border')}>
                    <KeyRound className="w-3 h-3" />
                    Local
                </span>
            </HoverTip>
        ) : (
            <HoverTip label="No usable password and no linked SSO identity — this account has no way to sign in right now. Grant a reset token, or let a connection link it on their next SSO sign-in.">
                <span className={cn(SIGNIN_CHIP, 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20')}>
                    No sign-in
                </span>
            </HoverTip>
        )
    }

    return (
        <div className="flex items-center gap-1.5 flex-wrap">
            {shown.map(identity => (
                <HoverTip
                    key={identity.providerId}
                    label={(
                        <span className="block space-y-0.5">
                            <span className="block font-semibold">{identity.displayName}</span>
                            <span className="block">{identity.slug} · {identity.kind}</span>
                            {identity.lastLoginAt && (
                                <span className="block">Last signed in with it {timeAgo(identity.lastLoginAt)}.</span>
                            )}
                            {user.signupSource === 'sso_jit' && (
                                <span className="block">The account itself was provisioned by SSO.</span>
                            )}
                        </span>
                    )}
                >
                    <span className={cn(SIGNIN_CHIP, 'bg-indigo-500/[0.06] text-ink-secondary border-glass-border max-w-[11rem]')}>
                        {createElement(
                            logoFor(presetById(identity.kind)?.id, identity.kind),
                            { className: 'w-3 h-3 shrink-0' },
                        )}
                        <span className="truncate">{identity.displayName}</span>
                    </span>
                </HoverTip>
            ))}
            {overflow.length > 0 && (
                <HoverTip label={`Also linked: ${overflow.map(i => i.displayName).join(', ')}`}>
                    <span className={cn(SIGNIN_CHIP, 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border')}>
                        +{overflow.length}
                    </span>
                </HoverTip>
            )}
            {user.hasPassword && (
                <HoverTip label="Also has a password — can sign in locally too.">
                    <span
                        aria-label="Also has a password"
                        className={cn(SIGNIN_CHIP, 'bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted border-glass-border px-1.5')}
                    >
                        <KeyRound className="w-3 h-3" />
                    </span>
                </HoverTip>
            )}
        </div>
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
    const [page, setPage] = useState(0)
    const PAGE_SIZE = 25
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
    const [bulkResult, setBulkResult] = useState<BulkInviteResponse | null>(null)
    // Admin-created accounts. Separate state from the invite result
    // because they are separate wizards producing separate artefacts.
    const [createdUser, setCreatedUser] = useState<CreatedUser | null>(null)
    const [bulkCreated, setBulkCreated] = useState<BulkCreateUsersResponse | null>(null)
    const [createLoading, setCreateLoading] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)
    const inviteLinksEnabled = useFeature('inviteLinksEnabled')
    const [invitesOpen, setInvitesOpen] = useState(false)

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
                u.role.toLowerCase().includes(q) ||
                (u.identities ?? []).some(i =>
                    i.displayName.toLowerCase().includes(q) ||
                    i.slug.toLowerCase().includes(q))
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

    const pageCount = Math.max(1, Math.ceil(processedUsers.length / PAGE_SIZE))
    const clampedPage = Math.min(page, pageCount - 1)
    const pagedUsers = processedUsers.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE)

    // Back to page one whenever the visible set changes shape.
    useEffect(() => { setPage(0) }, [filter, search, sortField, sortDir])

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
        setCreatedUser(null)
        setBulkCreated(null)
        setCreateError(null)
    }

    const handleCreateUser = async (body: CreateUserRequest) => {
        setCreateLoading(true)
        setCreateError(null)
        try {
            const resp = await adminUserService.createUser(body)
            setCreatedUser(resp)
            setSuccessMsg(`${resp.email} added`)
            void fetchUsers()
        } catch (err: any) {
            setCreateError(err.message || 'Could not create the account')
        } finally {
            setCreateLoading(false)
        }
    }

    const handleCreateUsersBulk = async (body: BulkCreateUsersRequest) => {
        setCreateLoading(true)
        setCreateError(null)
        try {
            const resp = await adminUserService.createUsersBulk(body)
            setBulkCreated(resp)
            setSuccessMsg(
                resp.skipped === 0
                    ? `${resp.created} accounts added`
                    : `${resp.created} added, ${resp.skipped} skipped`,
            )
            void fetchUsers()
        } catch (err: any) {
            setCreateError(err.message || 'Could not create the accounts')
        } finally {
            setCreateLoading(false)
        }
    }

    const handleCreateInvite = async (
        role: string | null,
        opts: CreateInviteOptions,
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

    const handleCreateBulkInvites = async (
        emails: string[],
        role: string | null,
        opts: CreateInviteOptions,
    ) => {
        setInviteLoading(true)
        setError(null)
        try {
            const resp = await adminUserService.createBulkInvites(emails, role, opts)
            setBulkResult(resp)
            setSuccessMsg(
                resp.created === emails.length
                    ? `${resp.created} invite links created`
                    : `${resp.created} of ${emails.length} invite links created`,
            )
        } catch (err: any) {
            setError(err.message || 'Failed to create invites')
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
        <PageContainer gutter="shell" className="py-8 animate-in fade-in duration-500">
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
                    {/* Hidden when an admin has switched invite links off. The
                        server refuses the POST either way; this just stops us
                        offering a button that cannot work. */}
                    {/* Adding somebody directly is not gated on
                        `inviteLinksEnabled`: that flag governs LINKS, and an
                        admin typing an account out by hand is not a link.
                        Turning self-service off should not take away the
                        ability to add somebody deliberately. */}
                    <button
                        onClick={() => setModal({ kind: 'createUser' })}
                        className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-gradient-to-r from-emerald-500 to-teal-600 hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-emerald-500/20"
                    >
                        <UserPlus className="w-4 h-4" />
                        Add people
                    </button>
                    {inviteLinksEnabled && (
                        <button
                            onClick={() => setModal({ kind: 'invite' })}
                            className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                        >
                            <Link2 className="w-4 h-4" />
                            Invite by Link
                        </button>
                    )}
                    {/* Always available, even when link creation is off: an
                        admin who has just switched invite links off is
                        precisely the one who needs to revoke what is still
                        outstanding. */}
                    <button
                        onClick={() => setInvitesOpen(true)}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2"
                    >
                        <ListChecks className="w-4 h-4" />
                        Manage links
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
                    <input type="text" placeholder="Search by name, email, role, or provider..."
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
                                <th className="text-left px-5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Sign-in</span></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Role" field="role" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Joined" field="createdAt" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-right px-5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagedUsers.map((user, i) => {
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
                                                    <UserAvatar
                                                        userId={user.id}
                                                        name={user.displayName}
                                                        shape="gradient"
                                                        className="w-9 h-9 text-[11px] font-bold shadow-sm"
                                                    />
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
                                                        {/* An account still on the password it
                                                            shipped with — which is printed in the
                                                            setup docs, so it is public knowledge.
                                                            Worth seeing without opening the row. */}
                                                        {user.mustChangePassword && (
                                                            <span
                                                                title="This account is still using its default password. It must choose a new one at next sign-in."
                                                                className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 shrink-0">
                                                                DEFAULT PASSWORD
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

                                        {/* Sign-in methods — local, which IdP(s), or stranded.
                                            Plain spans: the row click (drawer) stays usable. */}
                                        <td className="px-5 py-4">
                                            <SignInMethods user={user} />
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

                                                        {/* Reset password. Carries its label rather
                                                            than relying on a hover title: this is
                                                            the action somebody comes to this screen
                                                            looking for — including for the system
                                                            administrator account — and a bare key
                                                            icon is not something you find by
                                                            looking. */}
                                                        <button onClick={() => setModal({ kind: 'resetPassword', userId: user.id, name: user.displayName })}
                                                            disabled={isActing} title="Reset password"
                                                            className={cn(
                                                                "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold transition-colors disabled:opacity-50",
                                                                user.resetRequested
                                                                    ? "text-sky-500 bg-sky-500/10 hover:bg-sky-500/20"
                                                                    : "text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                                                            )}>
                                                            <KeyRound className="w-4 h-4" />
                                                            Reset password
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

                    {/* Table footer — total count (left) + page controls (right) */}
                    <div className="px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between gap-3">
                        <p className="text-xs text-ink-muted">
                            Showing <span className="font-semibold text-ink-secondary">{processedUsers.length}</span>
                            {processedUsers.length !== users.length && (
                                <> of <span className="font-semibold text-ink-secondary">{users.length}</span></>
                            )} user{users.length !== 1 ? 's' : ''}
                        </p>
                        <div className="flex items-center gap-4">
                            {(search || filter !== 'all') && (
                                <button onClick={() => { setSearch(''); setFilter('all') }}
                                    className="text-xs font-medium text-accent-lineage hover:underline">Clear filters</button>
                            )}
                            <TablePagination page={clampedPage} pageSize={PAGE_SIZE} total={processedUsers.length} onPageChange={setPage} />
                        </div>
                    </div>
                </div>
            )}

            {/* ── Modals ──────────────────────────────────────────────── */}
            {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
            <Backdrop open={!!modal && modal.kind !== 'invite' && modal.kind !== 'createUser'} onClick={closeModal} zClassName="z-50" className="bg-black/50" />

            {/* Centering layer: plain, always-mounted, transparent to clicks (they fall
                through to the Backdrop beneath → outside-click still closes). */}
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <AnimatePresence>
                    {modal && modal.kind !== 'invite' && modal.kind !== 'createUser' && (
                        <motion.div key="admin-users-modal-card" initial={{ scale: 0.96, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }} transition={{ duration: 0.2 }}
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                                "pointer-events-auto relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full p-6 max-w-md",
                            )}>

                            {/* ── Reject modal ── */}
                            {modal.kind === 'reject' && (
                                <>
                                    <ModalHeader icon={XCircle} iconBg="bg-red-500/10 border-red-500/20" iconColor="text-red-500"
                                        title="Reject Signup" subtitle="This action cannot be undone" onClose={closeModal} />
                                    <UserPill name={modal.name} userId={modal.userId} />
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
                                    <UserPill name={modal.name} userId={modal.userId} />
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
                                    <UserPill name={modal.name} userId={modal.userId} />
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
                                            // A surname is optional — one-word
                                            // names ("Prince") must stay savable.
                                            !profileFirstName.trim() ||
                                            (profileFirstName.trim() === modal.firstName && profileLastName.trim() === modal.lastName)
                                        } />
                                </>
                            )}

                            {/* ── Reset password modal ── */}
                            {modal.kind === 'resetPassword' && (
                                <>
                                    <ModalHeader icon={KeyRound} iconBg="bg-sky-500/10 border-sky-500/20" iconColor="text-sky-500"
                                        title="Reset Password" subtitle="Choose a reset method" onClose={closeModal} />
                                    <UserPill name={modal.name} userId={modal.userId} />

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

            {modal?.kind === 'createUser' && (
                <CreateUserWizard
                    canGrantSuperAdmin={canGrantSuperAdmin}
                    loading={createLoading}
                    error={createError}
                    result={createdUser}
                    bulkResult={bulkCreated}
                    onSubmit={p => p && void handleCreateUser(p.body as CreateUserRequest)}
                    onSubmitBulk={p => p && void handleCreateUsersBulk(p.body as BulkCreateUsersRequest)}
                    onAnother={() => { setCreatedUser(null); setBulkCreated(null); setCreateError(null) }}
                    onClose={closeModal}
                />
            )}

            {/* The invite wizard is its own overlay, not a card inside the
                shared modal — same shape as ViewWizard and the asset
                onboarding wizard, which is the house pattern for anything
                with steps. */}
            {modal?.kind === 'invite' && (
                <InviteWizard
                    canGrantSuperAdmin={canGrantSuperAdmin}
                    loading={inviteLoading}
                    result={inviteResult}
                    bulkResult={bulkResult}
                    inviteUrl={inviteUrl}
                    copied={inviteCopied}
                    onCopy={handleCopyInvite}
                    onSubmit={handleCreateInvite}
                    onSubmitBulk={handleCreateBulkInvites}
                    onAnother={() => { setInviteResult(null); setBulkResult(null); setInviteCopied(false) }}
                    onClose={closeModal}
                />
            )}

            {/* Outstanding invite links. A drawer rather than a new admin
                route: a route would need a nav-catalogue entry and its drift
                test for no benefit — this belongs next to the button that
                creates the links. */}
            <Backdrop open={invitesOpen} onClick={() => setInvitesOpen(false)} zClassName="z-40" className="bg-black/40" />
            <AnimatePresence>
                {invitesOpen && (
                    <motion.aside
                        key="invites-drawer"
                        initial={{ x: '100%' }}
                        animate={{ x: 0 }}
                        exit={{ x: '100%' }}
                        transition={{ duration: 0.22, ease: [0.32, 0.72, 0, 1] }}
                        style={{ willChange: 'transform' }}
                        className="fixed top-0 right-0 bottom-0 z-50 w-full max-w-2xl bg-canvas-elevated border-l border-glass-border shadow-xl flex flex-col"
                    >
                        <div className="flex items-center gap-2 px-5 py-4 border-b border-glass-border shrink-0">
                            <div className="min-w-0 flex-1">
                                <p className="text-[10px] uppercase tracking-wider font-bold text-ink-muted">Invite links</p>
                                <h2 className="text-base font-bold text-ink">Outstanding links</h2>
                                <p className="text-[11px] text-ink-muted">
                                    Track who has joined, extend, replace or revoke.
                                </p>
                            </div>
                            <button
                                onClick={() => setInvitesOpen(false)}
                                className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
                                title="Close"
                            >
                                <X className="w-4 h-4" />
                            </button>
                        </div>
                        <div className="flex-1 min-h-0 overflow-y-auto p-5">
                            {/* Creating a link used to mean closing this panel
                                and hunting for a different button — the one
                                place you manage links could not make one.
                                Close the drawer rather than stacking the modal
                                on top of it: both live at z-50 and the result
                                card needs the user's full attention. */}
                            <AdminInvites
                                onCreate={() => { setInvitesOpen(false); setModal({ kind: 'invite' }) }}
                            />
                        </div>
                    </motion.aside>
                )}
            </AnimatePresence>
        </PageContainer>
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

function UserPill({ name, userId }: { name: string; userId?: string }) {
    return (
        <div className="flex items-center gap-3 p-3 rounded-xl bg-black/[0.03] dark:bg-white/[0.03] border border-glass-border mb-5">
            <UserAvatar
                userId={userId}
                name={name}
                shape="gradient"
                className="w-8 h-8 text-[10px] font-bold"
            />
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