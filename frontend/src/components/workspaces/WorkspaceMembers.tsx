/**
 * WorkspaceMembers — workspace settings tab for managing role bindings.
 *
 * Mounted inside ``WorkspaceDetailPage`` as the "Members" tab. Provides:
 *   - KPI strip: total members + per-role breakdown
 *   - Member table: subject (user/group) + role badge + grant audit
 *   - Add Member modal: subject-type toggle + search picker + role grid
 *   - Revoke confirm modal
 *
 * Authorization: the parent page mounts this tab for callers who may let
 * people in (``workspace:members:add`` — admins and stewards). A steward
 * (``canManage`` false) adds people as Viewer or Member; removing people,
 * binding groups and the access settings stay with ``workspace:admin``.
 * The component still calls the backend on every action — backend remains
 * source of truth.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Users, Shield, UserCog, Eye, UserPlus, Trash2, RefreshCw,
    Search, Loader2, X, AlertCircle, AlertTriangle, Mail, Users2,
    ChevronDown, ChevronUp, ChevronRight, Clock,
    UserCheck,
} from 'lucide-react'
import {
    workspaceMembersService,
    type WorkspaceMemberResponse,
} from '@/services/workspaceMembersService'
import { WorkspaceAccessList } from './WorkspaceAccessList'
import {
    groupsService,
    type GroupResponse,
    type GroupMemberResponse,
} from '@/services/groupsService'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import type { ImpactPreviewResponse } from '@/services/permissionsService'
import { searchDirectory } from '@/services/userDirectoryService'
import { ReviewRequestsPanel } from '@/components/access/ReviewRequestsPanel'
import { WorkspaceAccessSettings } from './WorkspaceAccessSettings'
import { useGrantOptions } from '@/hooks/useWorkspaceAccess'
import { useAuthStore } from '@/store/auth'
import { ImpactPreviewModal } from '@/components/admin/ImpactPreviewModal'
import { useAppNotifications } from '@/components/ui/notifications'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { Backdrop } from '@/components/ui/Backdrop'
import { TablePagination } from '@/components/ui/TablePagination'
import { UserAvatar } from '@/components/ui/UserAvatar'
import { cn } from '@/lib/utils'
import { roleVisualFor, isBuiltinRole } from '@/lib/roleVisual'
import { ROLE_NAMES } from '@/lib/roleNames'
import { ReasonField } from '@/components/activity/ReasonField'
import { useReasonDraft } from '@/components/activity/useReasonDraft'


// ── Types & constants ────────────────────────────────────────────────

type SortField = 'subject' | 'role' | 'grantedAt'
type SortDir = 'asc' | 'desc'
/**
 * Phase 3: ``RoleName`` is no longer a closed enum. Bindings can
 * reference any role defined in the canonical ``roles`` table —
 * built-ins (admin / user / viewer) and admin-defined custom roles.
 * Role visuals come from ``@/lib/roleVisual`` (single source of
 * truth across the FE).
 */
type RoleName = string
type SubjectType = 'user' | 'group'

type ModalType =
    | { kind: 'add' }
    | null

const KPI_CARDS = [
    {
        key: 'total',
        label: 'Members',
        icon: Users,
        gradient: 'from-indigo-500/20 to-indigo-500/0',
        accent: 'text-indigo-600 dark:text-indigo-400',
        iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    },
    {
        key: ROLE_NAMES.WORKSPACE_ADMIN,
        label: 'Admins',
        icon: Shield,
        gradient: 'from-amber-500/20 to-amber-500/0',
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    },
    {
        key: ROLE_NAMES.WORKSPACE_MEMBER,
        label: 'Members',
        icon: UserCog,
        gradient: 'from-sky-500/20 to-sky-500/0',
        accent: 'text-sky-600 dark:text-sky-400',
        iconBg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    },
    {
        key: ROLE_NAMES.WORKSPACE_VIEWER,
        label: 'Viewers',
        icon: Eye,
        gradient: 'from-slate-500/20 to-slate-500/0',
        accent: 'text-slate-600 dark:text-slate-400',
        iconBg: 'bg-slate-500/10 text-slate-500 border-slate-500/20',
    },
] as const


// ── Helpers ──────────────────────────────────────────────────────────

function formatDate(iso: string): string {
    return new Date(iso).toLocaleDateString(undefined, {
        month: 'short', day: 'numeric', year: 'numeric',
    })
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


/** Phase 7 — small inline badge next to time-bound binding rows.
 *  Red if expired, amber if within 24h, slate otherwise. */
function ExpiryBadge({ expiresAt }: { expiresAt: string }) {
    const remaining = new Date(expiresAt).getTime() - Date.now()
    const expired = remaining <= 0
    const soon = remaining > 0 && remaining < 24 * 3600_000

    const label = expired
        ? 'Expired'
        : (soon
            ? `Expires in ${Math.max(1, Math.floor(remaining / 3600_000))}h`
            : `Expires in ${Math.max(1, Math.floor(remaining / 86_400_000))}d`)

    const tone = expired
        ? 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
        : (soon
            ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
            : 'bg-slate-500/10 text-ink-muted border-slate-500/20')

    return (
        <span
            className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold mt-1 border',
                tone,
            )}
            title={`Auto-revokes at ${new Date(expiresAt).toLocaleString()}`}
        >
            <Clock className="w-2.5 h-2.5" />
            {label}
        </span>
    )
}


function SortHeader({
    label, field, current, dir, onSort,
}: {
    label: string
    field: SortField
    current: SortField
    dir: SortDir
    onSort: (f: SortField) => void
}) {
    const isActive = current === field
    return (
        <button
            onClick={() => onSort(field)}
            className={cn(
                'flex items-center gap-1 text-xs font-semibold uppercase tracking-wider transition-colors',
                isActive ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
            )}
        >
            {label}
            {isActive && (dir === 'asc'
                ? <ChevronUp className="w-3 h-3" />
                : <ChevronDown className="w-3 h-3" />)}
        </button>
    )
}


// ── Subject avatar ───────────────────────────────────────────────────

function SubjectAvatar({ type, displayName, userId, size = 'md' }: {
    type: SubjectType
    displayName: string
    userId?: string
    size?: 'sm' | 'md'
}) {
    const dims = size === 'sm' ? 'w-7 h-7 text-[10px]' : 'w-9 h-9 text-[11px]'
    if (type === 'group') {
        return (
            <div className={cn(
                dims,
                'rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0',
            )}>
                <Users2 className={size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4'} />
            </div>
        )
    }
    return (
        <UserAvatar
            userId={userId}
            name={displayName}
            shape="gradient"
            className={cn(dims, 'font-bold shadow-sm')}
        />
    )
}


// ── Group member line (inline group expansion) ───────────────────────

/** A compact, read-only member row for a group revealed inside the
 *  bindings table. Mirrors the /admin/groups drawer's member row: the id
 *  stays visible when it resolves to nobody, deleted/SSO are flagged. */
function GroupMemberLine({ member: m }: { member: GroupMemberResponse }) {
    const resolved = !!m.displayName
    const name = m.displayName ?? m.userId
    return (
        <div className="flex items-center gap-2.5 px-4 py-2 border-b last:border-b-0 border-glass-border">
            {resolved ? (
                <UserAvatar
                    userId={m.userId}
                    avatarId={m.avatarId ?? undefined}
                    name={name}
                    shape="gradient"
                    className="w-7 h-7 text-[10px] font-bold shrink-0"
                />
            ) : (
                <span aria-hidden className="w-7 h-7 rounded-full shrink-0 grid place-items-center text-[10px] font-bold bg-black/[0.04] dark:bg-white/[0.06] text-ink-muted">
                    ?
                </span>
            )}
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 min-w-0">
                    <p className={cn(
                        'truncate',
                        resolved ? 'text-[13px] font-medium text-ink' : 'font-mono text-[11px] text-ink-secondary',
                    )}>
                        {name}
                    </p>
                    {m.source === 'sso' && (
                        <span className="shrink-0 px-1 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide bg-violet-500/15 text-violet-600 dark:text-violet-400">
                            SSO
                        </span>
                    )}
                    {m.deleted && (
                        <span className="shrink-0 px-1 py-0.5 rounded text-[8px] font-bold uppercase tracking-wide bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">
                            Deleted
                        </span>
                    )}
                </div>
                {m.email && (
                    <p className="text-[11px] text-ink-muted truncate">{m.email}</p>
                )}
            </div>
        </div>
    )
}


// ── Main component ───────────────────────────────────────────────────

export function WorkspaceMembers({ workspaceId, canManage = true }: {
    workspaceId: string
    /** Workspace admin: removes people, binds groups, sets how people get in. */
    canManage?: boolean
}) {
    const [members, setMembers] = useState<WorkspaceMemberResponse[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [sortField, setSortField] = useState<SortField>('subject')
    const [sortDir, setSortDir] = useState<SortDir>('asc')
    const [page, setPage] = useState(0)
    const PAGE_SIZE = 25
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [modal, setModal] = useState<ModalType>(null)
    // Phase 4.4: revoke confirms now go through an impact preview.
    const [revokePreview, setRevokePreview] = useState<{
        member: WorkspaceMemberResponse
        loading: boolean
        preview: ImpactPreviewResponse | null
        error: string | null
    } | null>(null)
    const revokeReason = useReasonDraft('member-remove')
    // Bindings (the raw grants) vs People (the flattened, inheritance-
    // aware list of everyone who can actually get in).
    const [viewMode, setViewMode] = useState<'bindings' | 'people'>('bindings')
    // Group binding rows expand in place to reveal their members — the
    // same list the /admin/groups drawer shows, fetched lazily and cached
    // by group id so re-expanding is instant.
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
    const [groupMembers, setGroupMembers] = useState<
        Record<string, GroupMemberResponse[] | 'loading' | 'error'>
    >({})
    const { notify } = useAppNotifications()

    const ensureGroupMembers = useCallback((groupId: string) => {
        setGroupMembers(prev =>
            prev[groupId] && prev[groupId] !== 'error'
                ? prev
                : { ...prev, [groupId]: 'loading' },
        )
        groupsService.listMembers(groupId)
            .then(ms => setGroupMembers(prev => ({ ...prev, [groupId]: ms })))
            .catch(() => setGroupMembers(prev => ({ ...prev, [groupId]: 'error' })))
    }, [])

    const toggleGroupRow = (bindingId: string, groupId: string) => {
        const willOpen = !expandedGroups.has(bindingId)
        setExpandedGroups(prev => {
            const next = new Set(prev)
            if (willOpen) next.add(bindingId)
            else next.delete(bindingId)
            return next
        })
        if (willOpen) ensureGroupMembers(groupId)
    }


    // ── Data fetching ────────────────────────────────────────────────

    const fetchMembers = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const data = await workspaceMembersService.list(workspaceId)
            setMembers(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load members')
        } finally {
            setLoading(false)
        }
    }, [workspaceId])

    useEffect(() => { void fetchMembers() }, [fetchMembers])

    // Refresh on a permissions change (silent refresh, 60s poller, or
    // cross-tab BroadcastChannel) so a binding mutation made elsewhere
    // (admin removed a member in another tab, group binding revoked,
    // etc.) refreshes this page in place.
    useEffect(() => {
        const onChange = () => { void fetchMembers() }
        window.addEventListener('permissions:changed', onChange)
        return () => window.removeEventListener('permissions:changed', onChange)
    }, [fetchMembers])


    // ── KPIs + filtering + sort ─────────────────────────────────────

    const kpis = useMemo(() => ({
        total: members.length,
        [ROLE_NAMES.WORKSPACE_ADMIN]: members.filter(m => m.role === ROLE_NAMES.WORKSPACE_ADMIN).length,
        [ROLE_NAMES.WORKSPACE_MEMBER]: members.filter(m => m.role === ROLE_NAMES.WORKSPACE_MEMBER).length,
        [ROLE_NAMES.WORKSPACE_VIEWER]: members.filter(m => m.role === ROLE_NAMES.WORKSPACE_VIEWER).length,
    }), [members])

    const processedMembers = useMemo(() => {
        let list = [...members]
        if (search) {
            const q = search.toLowerCase()
            list = list.filter(m => {
                const name = m.subject.displayName?.toLowerCase() ?? ''
                const sec = m.subject.secondary?.toLowerCase() ?? ''
                return name.includes(q) || sec.includes(q) || m.subject.id.toLowerCase().includes(q)
            })
        }
        list.sort((a, b) => {
            let cmp = 0
            switch (sortField) {
                case 'subject':
                    cmp = (a.subject.displayName ?? a.subject.id).localeCompare(b.subject.displayName ?? b.subject.id)
                    break
                case 'role': cmp = a.role.localeCompare(b.role); break
                case 'grantedAt': cmp = a.grantedAt.localeCompare(b.grantedAt); break
            }
            return sortDir === 'asc' ? cmp : -cmp
        })
        return list
    }, [members, search, sortField, sortDir])

    const pageCount = Math.max(1, Math.ceil(processedMembers.length / PAGE_SIZE))
    const clampedPage = Math.min(page, pageCount - 1)
    const pagedMembers = processedMembers.slice(clampedPage * PAGE_SIZE, (clampedPage + 1) * PAGE_SIZE)

    // Back to page one whenever the visible set changes shape.
    useEffect(() => { setPage(0) }, [search, sortField, sortDir])

    const handleSort = (field: SortField) => {
        if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        else { setSortField(field); setSortDir('asc') }
    }


    // ── Actions ──────────────────────────────────────────────────────

    const handleAdd = async (
        subjectType: SubjectType,
        subjectId: string,
        role: RoleName,
        label: string,
        expiresIn?: string | null,
        reason?: string,
        exception?: boolean,
    ) => {
        setActionLoading('add')
        setError(null)
        try {
            await workspaceMembersService.create(workspaceId, {
                subjectType, subjectId, role,
                expiresIn: expiresIn ?? null,
                exception: exception || undefined,
            }, { reason })
            await fetchMembers()
            const suffix = expiresIn ? ` (expires in ${expiresIn})` : ''
            notify('success', `Granted ${roleVisualFor(role).label} to ${label}${suffix}`)
            setModal(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to add member'
            notify('error', msg)
            setError(msg)
        } finally {
            setActionLoading(null)
        }
    }

    const handleRevoke = async (member: WorkspaceMemberResponse, reason?: string) => {
        setActionLoading(`revoke-${member.bindingId}`)
        setError(null)
        try {
            await workspaceMembersService.revoke(workspaceId, member.bindingId, { reason })
            await fetchMembers()
            notify('success', `Revoked ${member.subject.displayName ?? member.subject.id}`)
            setModal(null)
            setRevokePreview(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to revoke binding'
            notify('error', msg)
            setError(msg)
        } finally {
            setActionLoading(null)
        }
    }

    /**
     * Phase 4.4: open the revoke flow with an impact preview. Replaces
     * the bare "are you sure?" modal with a real diff so admins see
     * what each member is about to lose.
     */
    const handleRequestRevoke = async (member: WorkspaceMemberResponse) => {
        revokeReason.reset()
        setRevokePreview({ member, loading: true, preview: null, error: null })
        try {
            const preview = await workspaceMembersService.previewRevoke(
                workspaceId, member.bindingId,
            )
            setRevokePreview(prev => prev && prev.member.bindingId === member.bindingId
                ? { ...prev, loading: false, preview }
                : prev,
            )
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to compute impact'
            setRevokePreview(prev => prev && prev.member.bindingId === member.bindingId
                ? { ...prev, loading: false, error: msg }
                : prev,
            )
        }
    }


    // ── Render ───────────────────────────────────────────────────────

    return (
        <div className="space-y-6 py-4">
            {/* Section intro */}
            <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center shrink-0">
                    <Users className="w-4 h-4 text-indigo-500" />
                </div>
                <div className="flex-1">
                    <h3 className="text-base font-bold text-ink">Members</h3>
                    {canManage ? (
                        <p className="text-sm text-ink-secondary leading-relaxed mt-0.5">
                            Bind users or groups to this workspace. Each binding grants a role —
                            <span className="font-semibold"> Admin</span>,
                            <span className="font-semibold"> User</span>, or
                            <span className="font-semibold"> Viewer</span>.
                            Group bindings cascade to every member of the group.
                        </p>
                    ) : (
                        <p className="text-sm text-ink-secondary leading-relaxed mt-0.5">
                            As a steward you let people in as <span className="font-semibold">Viewer</span> or
                            <span className="font-semibold"> Member</span>, and answer their requests. Removing
                            people and changing their access stays with the workspace’s admins.
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    <button
                        onClick={() => setModal({ kind: 'add' })}
                        className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                    >
                        <UserPlus className="w-4 h-4" />
                        Add member
                    </button>
                    <button
                        onClick={() => void fetchMembers()}
                        disabled={loading}
                        className="px-3 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl text-ink transition-colors disabled:opacity-50"
                        title="Refresh"
                    >
                        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
                    </button>
                </div>
            </div>

            {/* Requests waiting on this workspace's admins and stewards. */}
            <ReviewRequestsPanel workspaceId={workspaceId} hideWhenEmpty />

            {/* View toggle: the raw bindings, or the flattened list of
                everyone who can actually get in. */}
            <div className="flex gap-1 bg-black/5 dark:bg-white/5 rounded-xl p-1 w-fit">
                {([
                    ['bindings', 'Bindings', Shield],
                    ['people', 'People with access', UserCheck],
                ] as const).map(([mode, label, Icon]) => (
                    <button
                        key={mode}
                        onClick={() => setViewMode(mode)}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150',
                            viewMode === mode
                                ? 'bg-white dark:bg-white/10 text-ink shadow-sm'
                                : 'text-ink-muted hover:text-ink',
                        )}
                    >
                        <Icon className="w-3.5 h-3.5" />
                        {label}
                    </button>
                ))}
            </div>

            {/* KPI strip */}
            {viewMode === 'bindings' && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {KPI_CARDS.map(kpi => {
                    const Icon = kpi.icon
                    const value = kpis[kpi.key as keyof typeof kpis]
                    return (
                        <div
                            key={kpi.key}
                            className="relative overflow-hidden border border-glass-border rounded-xl p-4 bg-canvas-elevated"
                        >
                            <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', kpi.gradient)} />
                            <div className="relative">
                                <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center mb-2', kpi.iconBg)}>
                                    <Icon className="w-4 h-4" />
                                </div>
                                <p className={cn('text-xl font-bold', kpi.accent)}>{value}</p>
                                <p className="text-[11px] text-ink-muted mt-0.5">{kpi.label}</p>
                            </div>
                        </div>
                    )
                })}
            </div>
            )}

            {/* Error banner */}
            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm"
                    >
                        <AlertCircle className="w-4 h-4 shrink-0" />
                        <p className="flex-1">{error}</p>
                        <button onClick={() => setError(null)} className="p-1 rounded-lg hover:bg-red-500/10 transition-colors">
                            <X className="w-3.5 h-3.5" />
                        </button>
                    </motion.div>
                )}
            </AnimatePresence>

            {viewMode === 'people' ? (
                <WorkspaceAccessList workspaceId={workspaceId} />
            ) : (
            <>
            {/* Toolbar */}
            <div className="flex items-center gap-3">
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                        type="text"
                        placeholder="Search members..."
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
            </div>

            {/* Table / empty state */}
            {loading && members.length === 0 ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated py-16 flex items-center justify-center">
                    <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
                </div>
            ) : processedMembers.length === 0 ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated">
                    <div className="flex flex-col items-center justify-center py-16">
                        <div className="w-16 h-16 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mb-4">
                            {search
                                ? <Search className="w-7 h-7 text-ink-muted/60" />
                                : <Users className="w-7 h-7 text-ink-muted/60" />}
                        </div>
                        <p className="text-sm font-medium text-ink-secondary mb-1">
                            {search ? 'No matching members' : 'No members yet'}
                        </p>
                        <p className="text-xs text-ink-muted max-w-sm text-center mb-5">
                            {search
                                ? 'Try clearing the search or adjusting your query.'
                                : 'Add a user or group to grant them access to this workspace.'}
                        </p>
                        {!search && (
                            <button
                                onClick={() => setModal({ kind: 'add' })}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-600 text-white text-sm font-semibold shadow-sm shadow-indigo-500/20"
                            >
                                <UserPlus className="w-4 h-4" />
                                Add the first member
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    <table className="w-full">
                        <thead className="bg-black/[0.03] dark:bg-white/[0.03]">
                            <tr className="border-b border-glass-border">
                                <th className="text-left px-5 py-3"><SortHeader label="Subject" field="subject" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Role" field="role" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Granted" field="grantedAt" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-right px-5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {pagedMembers.map((m, i) => {
                                const role = roleVisualFor(m.role)
                                const RoleIcon = role.icon
                                const isActing = actionLoading === `revoke-${m.bindingId}`
                                const name = m.subject.displayName ?? m.subject.id
                                const isGroup = m.subject.type === 'group'
                                const isExpanded = isGroup && expandedGroups.has(m.bindingId)
                                const membersState = isGroup ? groupMembers[m.subject.id] : undefined
                                return (
                                    <Fragment key={m.bindingId}>
                                    <motion.tr
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.15, delay: i * 0.02 }}
                                        className={cn(
                                            'border-b border-glass-border transition-colors group hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                                            !isExpanded && 'last:border-b-0',
                                        )}
                                    >
                                        {/* Subject */}
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-3">
                                                {/* Groups expand in place; users get a spacer so
                                                    the avatars stay in one column. */}
                                                {isGroup ? (
                                                    <button
                                                        onClick={() => toggleGroupRow(m.bindingId, m.subject.id)}
                                                        title={isExpanded ? 'Hide members' : 'Show members'}
                                                        aria-label={isExpanded ? `Hide members of ${name}` : `Show members of ${name}`}
                                                        aria-expanded={isExpanded}
                                                        className="p-0.5 -ml-1 rounded text-ink-muted hover:text-ink transition-colors shrink-0"
                                                    >
                                                        <ChevronRight className={cn('w-4 h-4 transition-transform', isExpanded && 'rotate-90')} />
                                                    </button>
                                                ) : (
                                                    <span className="w-3.5 shrink-0" aria-hidden />
                                                )}
                                                <SubjectAvatar type={m.subject.type as SubjectType} displayName={name} userId={m.subject.id} />
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <p className="text-sm font-semibold text-ink truncate">{name}</p>
                                                        {isGroup && (
                                                            <span className="px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 shrink-0">
                                                                GROUP
                                                            </span>
                                                        )}
                                                    </div>
                                                    {m.subject.secondary && (
                                                        <div className="flex items-center gap-1 mt-0.5">
                                                            {m.subject.type === 'user' && <Mail className="w-3 h-3 text-ink-muted shrink-0" />}
                                                            <p className="text-xs text-ink-muted truncate">{m.subject.secondary}</p>
                                                        </div>
                                                    )}
                                                </div>
                                            </div>
                                        </td>

                                        {/* Role */}
                                        <td className="px-5 py-4">
                                            <span className={cn(
                                                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border',
                                                role.badge,
                                            )}>
                                                <RoleIcon className="w-3 h-3" />
                                                {role.label}
                                            </span>
                                        </td>

                                        {/* Granted */}
                                        <td className="px-5 py-4">
                                            <p className="text-sm text-ink-secondary">{formatDate(m.grantedAt)}</p>
                                            <p className="text-[11px] text-ink-muted mt-0.5">{timeAgo(m.grantedAt)}</p>
                                            {m.expiresAt && (
                                                <ExpiryBadge expiresAt={m.expiresAt} />
                                            )}
                                        </td>

                                        {/* Actions — removing people is the admins' */}
                                        <td className="px-5 py-4 text-right">
                                            {canManage && (
                                                <button
                                                    onClick={() => void handleRequestRevoke(m)}
                                                    disabled={isActing}
                                                    title="Revoke binding"
                                                    className="p-2 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50"
                                                >
                                                    {isActing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                                </button>
                                            )}
                                        </td>
                                    </motion.tr>

                                    {/* Group members, revealed in place — the same list the
                                        /admin/groups drawer shows, and who this binding lets in. */}
                                    {isExpanded && (
                                        <tr className="border-b last:border-b-0 border-glass-border bg-black/[0.015] dark:bg-white/[0.015]">
                                            <td colSpan={4} className="px-5 pb-4 pt-0">
                                                <div className="ml-8 rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
                                                    <div className="px-4 py-2 border-b border-glass-border bg-black/[0.02] dark:bg-white/[0.03] flex items-center gap-2">
                                                        <Users2 className="w-3.5 h-3.5 text-violet-500 shrink-0" />
                                                        <p className="text-[11px] font-semibold text-ink-secondary">
                                                            {Array.isArray(membersState)
                                                                ? `${membersState.length} member${membersState.length !== 1 ? 's' : ''} inherit the ${role.label} role here`
                                                                : `Members of ${name}`}
                                                        </p>
                                                    </div>
                                                    {membersState === undefined || membersState === 'loading' ? (
                                                        <div className="py-6 flex items-center justify-center text-ink-muted text-xs">
                                                            <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                                            Loading members…
                                                        </div>
                                                    ) : membersState === 'error' ? (
                                                        <div className="py-6 text-center text-xs text-ink-muted">
                                                            Couldn't load this group's members.{' '}
                                                            <button onClick={() => ensureGroupMembers(m.subject.id)} className="font-semibold text-accent-lineage hover:underline">
                                                                Retry
                                                            </button>
                                                        </div>
                                                    ) : membersState.length === 0 ? (
                                                        <div className="py-6 text-center text-xs text-ink-muted">
                                                            This group has no members yet — the binding grants nobody access.
                                                        </div>
                                                    ) : (
                                                        <div className="max-h-72 overflow-y-auto custom-scrollbar">
                                                            {membersState.map(gm => (
                                                                <GroupMemberLine key={gm.userId} member={gm} />
                                                            ))}
                                                        </div>
                                                    )}
                                                </div>
                                            </td>
                                        </tr>
                                    )}
                                    </Fragment>
                                )
                            })}
                        </tbody>
                    </table>

                    <div className="px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between gap-3">
                        <p className="text-xs text-ink-muted">
                            Showing <span className="font-semibold text-ink-secondary">{processedMembers.length}</span>
                            {processedMembers.length !== members.length && (
                                <> of <span className="font-semibold text-ink-secondary">{members.length}</span></>
                            )} member{members.length !== 1 ? 's' : ''}
                        </p>
                        <TablePagination page={clampedPage} pageSize={PAGE_SIZE} total={processedMembers.length} onPageChange={setPage} />
                    </div>
                </div>
            )}
            </>
            )}

            {/* How people get in — listed, who decides, the note for people asking */}
            {canManage && <WorkspaceAccessSettings workspaceId={workspaceId} />}

            {/* Modals */}
            {/* Backdrop — plain CSS transition, never inside AnimatePresence (fixes the
                StrictMode click-shield where a stranded fixed-inset-0 node eats clicks). */}
            <Backdrop open={!!modal} onClick={() => setModal(null)} zClassName="z-50" className="bg-black/50" />

            {/* Centering layer: plain, always-mounted, transparent to clicks (they fall
                through to the Backdrop beneath → outside-click still closes). */}
            <div className="fixed inset-0 z-[51] flex items-center justify-center p-4 pointer-events-none">
                <AnimatePresence>
                    {modal && (
                        <motion.div
                            key="workspace-members-modal-card"
                            initial={{ scale: 0.96, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                                'pointer-events-auto relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full p-6 max-h-[90vh] overflow-y-auto',
                                modal.kind === 'add' ? 'max-w-2xl' : 'max-w-md',
                            )}
                        >
                            {modal.kind === 'add' && (
                                <AddMemberModal
                                    workspaceId={workspaceId}
                                    existingBindings={members}
                                    onClose={() => setModal(null)}
                                    onSubmit={handleAdd}
                                    submitting={actionLoading === 'add'}
                                />
                            )}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>

            {/* Revoke confirmation with impact preview (Phase 4.4) */}
            <ImpactPreviewModal
                open={revokePreview !== null}
                title={revokePreview
                    ? `Revoke ${revokePreview.member.subject.displayName ?? revokePreview.member.subject.id}?`
                    : ''}
                intent="destructive"
                confirmLabel="Revoke binding"
                preview={revokePreview?.preview ?? null}
                loading={revokePreview?.loading ?? false}
                error={revokePreview?.error ?? null}
                confirming={
                    revokePreview
                        ? actionLoading === `revoke-${revokePreview.member.bindingId}`
                        : false
                }
                onCancel={() => setRevokePreview(null)}
                onConfirm={() => {
                    if (revokePreview) void handleRevoke(revokePreview.member, revokeReason.take())
                }}
                reason={revokeReason}
            />
        </div>
    )
}


// ── Add Member modal ────────────────────────────────────────────────

/** Users per picker page — the server searches and pages every account. */
const USER_PICKER_PAGE_SIZE = 25

function AddMemberModal({
    workspaceId, existingBindings, onClose, onSubmit, submitting,
}: {
    workspaceId: string
    existingBindings: WorkspaceMemberResponse[]
    onClose: () => void
    onSubmit: (
        subjectType: SubjectType,
        subjectId: string,
        role: RoleName,
        label: string,
        expiresIn?: string | null,
        reason?: string,
        exception?: boolean,
    ) => Promise<void>
    submitting: boolean
}) {
    const reason = useReasonDraft('member-add')
    const [subjectType, setSubjectType] = useState<SubjectType>('user')
    // What the caller may grant here: a steward adds people as Viewer or
    // Member; an admin any role whose permissions they hold, groups too.
    const { options } = useGrantOptions(workspaceId)
    const canBindGroups = options?.tier === 'admin'
    const idpRun = options?.accessMode === 'idp'
    const [exception, setException] = useState(false)
    // Only a Super Admin may list every account; everyone else picks from
    // the people directory any signed-in user can search.
    const listsAccounts = useAuthStore(s => s.can('system:admin'))
    /** One page of matching active users; null until the first arrives. */
    const [users, setUsers] = useState<Pick<AdminUserResponse, 'id' | 'displayName' | 'email'>[] | null>(null)
    /** Active users matching the search across every page. */
    const [userTotal, setUserTotal] = useState(0)
    const [userPage, setUserPage] = useState(0)
    const [groups, setGroups] = useState<GroupResponse[] | null>(null)
    const availableRoles = options?.roles ?? null
    const [search, setSearch] = useState('')
    const [selected, setSelected] = useState<{ id: string; label: string } | null>(null)
    const [role, setRole] = useState<RoleName>('workspace_member')
    // Phase 7: time-bound bindings. ``''`` means permanent; otherwise
    // we send the duration shortcut to the backend which normalises
    // it to an ISO ``expires_at`` on the server side.
    const [expiresIn, setExpiresIn] = useState<string>('')
    const { notify } = useAppNotifications()

    // Subject id → role pairs already bound, so we can disable them in
    // the picker (the API would 409 anyway).
    const existingForType = useMemo(() => {
        const out = new Set<string>()
        for (const b of existingBindings) {
            if (b.subject.type === subjectType) {
                out.add(`${b.subject.id}:${b.role}`)
            }
        }
        return out
    }, [existingBindings, subjectType])

    // Users are searched and paged by the server, so every active account is
    // reachable — the picker used to offer only the first page the user list
    // returned (fifty people). Groups are still one local list.
    const debouncedSearch = useDebouncedValue(search.trim(), 300)
    useEffect(() => {
        if (subjectType !== 'user') return
        let cancelled = false
        const page = listsAccounts
            ? adminUserService.listUsers({
                status: 'active',
                search: debouncedSearch,
                sort: 'name',
                order: 'asc',
                limit: USER_PICKER_PAGE_SIZE,
                offset: userPage * USER_PICKER_PAGE_SIZE,
            })
            : searchDirectory(debouncedSearch, { types: ['user'], limit: USER_PICKER_PAGE_SIZE })
                .then(({ users: found }) => ({ items: found, total: found.length }))
        page
            .then(({ items, total }) => {
                if (cancelled) return
                setUsers(items)
                setUserTotal(total)
            })
            .catch(err => {
                if (!cancelled) notify('error', err instanceof Error ? err.message : 'Failed to load')
            })
        return () => { cancelled = true }
    }, [subjectType, debouncedSearch, userPage, listsAccounts, notify])

    useEffect(() => {
        ;(async () => {
            try {
                if (subjectType === 'group' && groups === null) {
                    const data = await groupsService.list({ limit: 500 })
                    setGroups(data)
                }
            } catch (err) {
                notify('error', err instanceof Error ? err.message : 'Failed to load')
            }
        })()
    }, [subjectType, groups, notify])

    // Reset selection when toggling subject type
    useEffect(() => { setSelected(null) }, [subjectType])

    const candidates = useMemo(() => {
        // Already active-only, searched and name-sorted by the server.
        if (subjectType === 'user') return users ?? []
        const q = search.trim().toLowerCase()
        return (groups ?? [])
            .filter(g => !q || g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [subjectType, users, groups, search])

    const needsException = idpRun && subjectType === 'user'
    const valid = !!selected && (!needsException || exception)
    const conflict = selected ? existingForType.has(`${selected.id}:${role}`) : false

    return (
        <>
            {/* Header */}
            <div className="flex items-center justify-between mb-5">
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl border bg-accent-lineage/10 border-accent-lineage/20 flex items-center justify-center">
                        <UserPlus className="w-5 h-5 text-accent-lineage" />
                    </div>
                    <div>
                        <h3 className="text-lg font-bold text-ink">Add member</h3>
                        <p className="text-xs text-ink-muted">
                            Bind a user or group to this workspace at a chosen role
                        </p>
                    </div>
                </div>
                <button onClick={onClose} className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors">
                    <X className="w-4 h-4" />
                </button>
            </div>

            {/* Subject-type toggle — groups are bound by admins only */}
            {canBindGroups && (
            <div className="flex gap-1 bg-black/5 dark:bg-white/5 rounded-xl p-1 mb-4 w-fit">
                {(['user', 'group'] as const).map(t => (
                    <button
                        key={t}
                        onClick={() => setSubjectType(t)}
                        className={cn(
                            'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors duration-150',
                            subjectType === t ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                        )}
                    >
                        {t === 'user' ? <UserCog className="w-3.5 h-3.5" /> : <Users2 className="w-3.5 h-3.5" />}
                        {t === 'user' ? 'User' : 'Group'}
                    </button>
                ))}
            </div>
            )}

            {/* Picker + role grid side by side */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Subject picker */}
                <div className="space-y-2">
                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted block">
                        {subjectType === 'user' ? 'Choose a user' : 'Choose a group'}
                    </label>
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                        <input
                            type="text"
                            placeholder={subjectType === 'user' ? 'Search users...' : 'Search groups...'}
                            value={search}
                            onChange={(e) => { setSearch(e.target.value); setUserPage(0) }}
                            className="input pl-9 h-9 w-full text-sm"
                            autoFocus
                        />
                    </div>
                    <div className="rounded-xl border border-glass-border bg-glass-base/30 max-h-60 overflow-y-auto">
                        {(subjectType === 'user' ? users : groups) === null ? (
                            <div className="p-6 text-center text-ink-muted text-sm">
                                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                                Loading…
                            </div>
                        ) : candidates.length === 0 ? (
                            <div className="p-6 text-center text-ink-muted text-sm">
                                {search ? 'No matches.' : `No ${subjectType}s available.`}
                            </div>
                        ) : (
                            candidates.map(c => {
                                const isUser = subjectType === 'user'
                                const u = isUser ? (c as Pick<AdminUserResponse, 'id' | 'displayName' | 'email'>) : null
                                const g = !isUser ? (c as GroupResponse) : null
                                const id = isUser ? u!.id : g!.id
                                const label = isUser ? u!.displayName : g!.name
                                const sub = isUser ? u!.email : (g!.description ?? `${g!.memberCount} member${g!.memberCount === 1 ? '' : 's'}`)
                                const isSelected = selected?.id === id
                                return (
                                    <button
                                        key={id}
                                        onClick={() => setSelected({ id, label })}
                                        className={cn(
                                            'w-full flex items-center gap-2.5 px-3 py-2 border-b last:border-b-0 border-glass-border text-left transition-colors',
                                            isSelected
                                                ? 'bg-accent-lineage/10'
                                                : 'hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                        )}
                                    >
                                        <SubjectAvatar type={subjectType} displayName={label} userId={id} size="sm" />
                                        <div className="min-w-0 flex-1">
                                            <p className={cn('text-sm truncate', isSelected ? 'font-semibold text-accent-lineage' : 'text-ink')}>
                                                {label}
                                            </p>
                                            <p className="text-[11px] text-ink-muted truncate">{sub}</p>
                                        </div>
                                    </button>
                                )
                            })
                        )}
                    </div>
                    {subjectType === 'user' && listsAccounts && (
                        <TablePagination
                            className="justify-end"
                            page={userPage}
                            pageSize={USER_PICKER_PAGE_SIZE}
                            total={userTotal}
                            onPageChange={setUserPage}
                        />
                    )}
                </div>

                {/* Role grid */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                            Role
                        </label>
                        {availableRoles && (
                            <span className="text-[10px] text-ink-muted">
                                {availableRoles.length} bindable here
                            </span>
                        )}
                    </div>
                    <div className="grid grid-cols-1 gap-2 max-h-[320px] overflow-y-auto pr-1">
                        {availableRoles === null ? (
                            <div className="p-4 text-center text-ink-muted text-xs rounded-xl border border-glass-border bg-glass-base/30">
                                <Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" />
                                Loading roles…
                            </div>
                        ) : availableRoles.length === 0 ? (
                            <div className="p-4 text-center text-ink-muted text-xs rounded-xl border border-glass-border bg-glass-base/30">
                                No roles available for this workspace.
                            </div>
                        ) : (
                            availableRoles.map(r => {
                                const cfg = roleVisualFor(r.name)
                                const isCustom = !r.isSystem
                                const Icon = isCustom ? Users2 : cfg.icon
                                const isSelected = role === r.name
                                const description = r.description
                                    ?? (isCustom
                                        ? 'Custom role — see Permissions for its bundle.'
                                        : 'Built-in role — see Permissions for the bundle.')
                                return (
                                    <button
                                        key={r.name}
                                        onClick={() => setRole(r.name)}
                                        className={cn(
                                            'flex items-start gap-3 p-3 rounded-xl border-2 text-left transition-colors duration-150',
                                            isSelected
                                                ? 'border-accent-lineage bg-accent-lineage/5'
                                                : 'border-glass-border hover:border-ink-muted/30 bg-canvas-elevated',
                                        )}
                                    >
                                        <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0', cfg.iconBg)}>
                                            <Icon className="w-4 h-4" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <p className={cn(
                                                    'text-sm font-semibold truncate',
                                                    isSelected ? `text-${cfg.accent}-600 dark:text-${cfg.accent}-400` : 'text-ink',
                                                )}>
                                                    {isBuiltinRole(r.name) ? cfg.label : r.name}
                                                </p>
                                                {isCustom && (
                                                    <span className="inline-flex items-center px-1.5 py-px rounded-full text-[9px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20">
                                                        custom
                                                    </span>
                                                )}
                                            </div>
                                            <p className="text-[11px] text-ink-muted leading-snug mt-0.5 truncate">
                                                {description}
                                            </p>
                                        </div>
                                    </button>
                                )
                            })
                        )}
                    </div>
                </div>
            </div>

            {/* Phase 7 — access duration */}
            <div className="mt-5 pt-5 border-t border-glass-border">
                <p className="text-xs font-semibold text-ink mb-2">
                    Access duration
                </p>
                <div className="flex flex-wrap gap-2">
                    {(['', '24h', '7d', '30d', '90d'] as const).map(opt => {
                        const isSelected = expiresIn === opt
                        const label = opt === '' ? 'Permanent' : opt
                        return (
                            <button
                                key={opt || 'permanent'}
                                type="button"
                                onClick={() => setExpiresIn(opt)}
                                className={cn(
                                    'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                                    isSelected
                                        ? 'border-accent-lineage bg-accent-lineage/10 text-accent-lineage'
                                        : 'border-glass-border text-ink-secondary hover:border-accent-lineage/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                                )}
                            >
                                {label}
                            </button>
                        )
                    })}
                </div>
                <p className="text-[11px] text-ink-muted mt-2">
                    {expiresIn
                        ? `Access auto-revokes after ${expiresIn}. Useful for contractors and temporary cover.`
                        : 'Binding stays active until manually revoked.'}
                </p>
            </div>

            {/* Conflict notice */}
            <AnimatePresence>
                {conflict && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginTop: 0 }}
                        className="mt-4 flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 text-xs"
                    >
                        <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                        This subject already holds the {roleVisualFor(role).label} role here. Pick a different role or subject.
                    </motion.div>
                )}
            </AnimatePresence>

            {/* A workspace whose identity provider decides who is in: adding
                a person here is an exception, and is labelled as one. */}
            {needsException && (
                <label className="mt-4 flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] p-3 text-xs text-amber-800 dark:text-amber-300 cursor-pointer">
                    <input
                        type="checkbox"
                        checked={exception}
                        onChange={e => setException(e.target.checked)}
                        className="mt-0.5"
                    />
                    <span>
                        <span className="font-semibold">Add them here as an exception.</span>{' '}
                        This workspace’s access is decided by your identity provider; this grant won’t follow
                        their groups, and People with access marks it as an exception.
                    </span>
                </label>
            )}

            <ReasonField draft={reason} audience="workspace" disabled={submitting} className="mt-5" />

            {/* Footer */}
            <div className="mt-6 flex items-center justify-end gap-2">
                <button
                    onClick={onClose}
                    disabled={submitting}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    onClick={() => {
                        if (!selected) return
                        void onSubmit(
                            subjectType, selected.id, role, selected.label,
                            expiresIn || null, reason.take(), needsException && exception,
                        )
                    }}
                    disabled={!valid || conflict || submitting}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent-lineage hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm shadow-accent-lineage/20"
                >
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    Add to workspace
                </button>
            </div>
            {/* Suppress unused-variable warning for workspaceId in this scope. */}
            <span className="hidden">{workspaceId}</span>
        </>
    )
}

