/**
 * WorkspaceMembers — workspace settings tab for managing role bindings.
 *
 * Mounted inside ``WorkspaceDetailPage`` as the "Members" tab. Provides:
 *   - KPI strip: total members + per-role breakdown
 *   - Member table: subject (user/group) + role badge + grant audit
 *   - Add Member modal: subject-type toggle + search picker + role grid
 *   - Revoke confirm modal
 *
 * Authorization: the parent page only mounts this tab for callers with
 * ``workspace:admin`` on the workspace. The component still calls the
 * backend on every action — backend remains source of truth.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Users, Shield, UserCog, Eye, UserPlus, Trash2, RefreshCw,
    Search, Loader2, X, AlertCircle, AlertTriangle, Mail, Users2,
    ChevronDown, ChevronUp, Inbox, Check, XCircle, Clock,
} from 'lucide-react'
import {
    workspaceMembersService,
    type WorkspaceMemberResponse,
} from '@/services/workspaceMembersService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import {
    permissionsService,
    type RoleDefinitionResponse,
} from '@/services/permissionsService'
import {
    accessRequestsService,
    type AccessRequestResponse,
} from '@/services/accessRequestsService'
import type { ImpactPreviewResponse } from '@/services/permissionsService'
import { ImpactPreviewModal } from '@/components/admin/ImpactPreviewModal'
import { useToast } from '@/components/ui/toast'
import { avatarGradient, initialsOf } from '@/lib/avatar'
import { cn } from '@/lib/utils'


// ── Types & constants ────────────────────────────────────────────────

type SortField = 'subject' | 'role' | 'grantedAt'
type SortDir = 'asc' | 'desc'
/**
 * Phase 3: ``RoleName`` is no longer a closed enum. Bindings can
 * reference any role defined in the canonical ``roles`` table —
 * built-ins (admin / user / viewer) and admin-defined custom roles.
 * The visual ``ROLE_CONFIG`` keeps fallbacks for unknown names.
 */
type RoleName = string
type SubjectType = 'user' | 'group'

type ModalType =
    | { kind: 'add' }
    | null

interface RoleVisual {
    label: string
    description: string
    icon: typeof Shield
    badge: string
    iconColor: string
    iconBg: string
    accent: string
}

const ROLE_CONFIG: Record<string, RoleVisual> = {
    admin: {
        label: 'Admin',
        description: 'Full control of this workspace, including members, settings, and data sources.',
        icon: Shield,
        badge: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
        iconColor: 'text-amber-500',
        iconBg: 'bg-amber-500/10 border-amber-500/20',
        accent: 'text-amber-600 dark:text-amber-400',
    },
    user: {
        label: 'User',
        description: 'Create, edit, and delete views; connect data sources; full read access.',
        icon: UserCog,
        badge: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
        iconColor: 'text-sky-500',
        iconBg: 'bg-sky-500/10 border-sky-500/20',
        accent: 'text-sky-600 dark:text-sky-400',
    },
    viewer: {
        label: 'Viewer',
        description: 'Read-only — list views and data sources, no edits.',
        icon: Eye,
        badge: 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
        iconColor: 'text-slate-500',
        iconBg: 'bg-slate-500/10 border-slate-500/20',
        accent: 'text-slate-600 dark:text-slate-400',
    },
}

/** Visual fallback for any custom (non-built-in) role. */
const CUSTOM_ROLE_VISUAL: RoleVisual = {
    label: 'Custom',
    description: 'Custom role — see the Permissions page for its bundle.',
    icon: Shield,  // overridden at the call-site to Sparkles
    badge: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    iconColor: 'text-violet-500',
    iconBg: 'bg-violet-500/10 border-violet-500/20',
    accent: 'text-violet-600 dark:text-violet-400',
}

/** Resolve the visual treatment for a role by name, falling back to
 *  the custom-role styling for anything not in the built-in set. */
function resolveRoleVisual(name: string): RoleVisual {
    return ROLE_CONFIG[name] ?? CUSTOM_ROLE_VISUAL
}

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
        key: 'admin',
        label: 'Admins',
        icon: Shield,
        gradient: 'from-amber-500/20 to-amber-500/0',
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
    },
    {
        key: 'user',
        label: 'Users',
        icon: UserCog,
        gradient: 'from-sky-500/20 to-sky-500/0',
        accent: 'text-sky-600 dark:text-sky-400',
        iconBg: 'bg-sky-500/10 text-sky-500 border-sky-500/20',
    },
    {
        key: 'viewer',
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

function SubjectAvatar({ type, displayName, size = 'md' }: {
    type: SubjectType
    displayName: string
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
        <div className={cn(
            dims,
            'rounded-full bg-gradient-to-br flex items-center justify-center font-bold text-white shrink-0 shadow-sm',
            avatarGradient(displayName),
        )}>
            {initialsOf(displayName)}
        </div>
    )
}


// ── Main component ───────────────────────────────────────────────────

export function WorkspaceMembers({ workspaceId }: { workspaceId: string }) {
    const [members, setMembers] = useState<WorkspaceMemberResponse[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [sortField, setSortField] = useState<SortField>('subject')
    const [sortDir, setSortDir] = useState<SortDir>('asc')
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [modal, setModal] = useState<ModalType>(null)
    // Phase 4.4: revoke confirms now go through an impact preview.
    const [revokePreview, setRevokePreview] = useState<{
        member: WorkspaceMemberResponse
        loading: boolean
        preview: ImpactPreviewResponse | null
        error: string | null
    } | null>(null)
    const { showToast } = useToast()


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


    // ── KPIs + filtering + sort ─────────────────────────────────────

    const kpis = useMemo(() => ({
        total: members.length,
        admin: members.filter(m => m.role === 'admin').length,
        user: members.filter(m => m.role === 'user').length,
        viewer: members.filter(m => m.role === 'viewer').length,
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

    const handleSort = (field: SortField) => {
        if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        else { setSortField(field); setSortDir('asc') }
    }


    // ── Actions ──────────────────────────────────────────────────────

    const handleAdd = async (subjectType: SubjectType, subjectId: string, role: RoleName, label: string) => {
        setActionLoading('add')
        setError(null)
        try {
            await workspaceMembersService.create(workspaceId, { subjectType, subjectId, role })
            await fetchMembers()
            showToast('success', `Granted ${resolveRoleVisual(role).label} to ${label}`)
            setModal(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to add member'
            showToast('error', msg)
            setError(msg)
        } finally {
            setActionLoading(null)
        }
    }

    const handleRevoke = async (member: WorkspaceMemberResponse) => {
        setActionLoading(`revoke-${member.bindingId}`)
        setError(null)
        try {
            await workspaceMembersService.revoke(workspaceId, member.bindingId)
            await fetchMembers()
            showToast('success', `Revoked ${member.subject.displayName ?? member.subject.id}`)
            setModal(null)
            setRevokePreview(null)
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Failed to revoke binding'
            showToast('error', msg)
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
                    <p className="text-sm text-ink-secondary leading-relaxed mt-0.5">
                        Bind users or groups to this workspace. Each binding grants a role —
                        <span className="font-semibold"> Admin</span>,
                        <span className="font-semibold"> User</span>, or
                        <span className="font-semibold"> Viewer</span>.
                        Group bindings cascade to every member of the group.
                    </p>
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

            {/* KPI strip */}
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
                            {processedMembers.map((m, i) => {
                                const role = resolveRoleVisual(m.role)
                                const RoleIcon = role.icon
                                const isActing = actionLoading === `revoke-${m.bindingId}`
                                const name = m.subject.displayName ?? m.subject.id
                                return (
                                    <motion.tr
                                        key={m.bindingId}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.15, delay: i * 0.02 }}
                                        className="border-b last:border-b-0 border-glass-border transition-colors group hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    >
                                        {/* Subject */}
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-3">
                                                <SubjectAvatar type={m.subject.type as SubjectType} displayName={name} />
                                                <div className="min-w-0">
                                                    <div className="flex items-center gap-2">
                                                        <p className="text-sm font-semibold text-ink truncate">{name}</p>
                                                        {m.subject.type === 'group' && (
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
                                        </td>

                                        {/* Actions */}
                                        <td className="px-5 py-4 text-right">
                                            <button
                                                onClick={() => void handleRequestRevoke(m)}
                                                disabled={isActing}
                                                title="Revoke binding"
                                                className="p-2 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50"
                                            >
                                                {isActing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                                            </button>
                                        </td>
                                    </motion.tr>
                                )
                            })}
                        </tbody>
                    </table>
                    <div className="px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between">
                        <p className="text-xs text-ink-muted">
                            Showing <span className="font-semibold text-ink-secondary">{processedMembers.length}</span>
                            {processedMembers.length !== members.length && (
                                <> of <span className="font-semibold text-ink-secondary">{members.length}</span></>
                            )} member{members.length !== 1 ? 's' : ''}
                        </p>
                    </div>
                </div>
            )}

            {/* Pending access requests inbox (Phase 4.3) */}
            <PendingRequestsPanel
                workspaceId={workspaceId}
                onResolved={fetchMembers}
            />

            {/* Modals */}
            <AnimatePresence>
                {modal && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.15 }}
                        className="fixed inset-0 z-50 flex items-center justify-center p-4"
                    >
                        <div className="absolute inset-0 bg-black/50" onClick={() => setModal(null)} />
                        <motion.div
                            initial={{ scale: 0.96, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.96, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            onClick={(e) => e.stopPropagation()}
                            className={cn(
                                'relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full p-6',
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
                    </motion.div>
                )}
            </AnimatePresence>

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
                    if (revokePreview) void handleRevoke(revokePreview.member)
                }}
            />
        </div>
    )
}


// ── Add Member modal ────────────────────────────────────────────────

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
    ) => Promise<void>
    submitting: boolean
}) {
    const [subjectType, setSubjectType] = useState<SubjectType>('user')
    const [users, setUsers] = useState<AdminUserResponse[] | null>(null)
    const [groups, setGroups] = useState<GroupResponse[] | null>(null)
    const [availableRoles, setAvailableRoles] = useState<RoleDefinitionResponse[] | null>(null)
    const [search, setSearch] = useState('')
    const [selected, setSelected] = useState<{ id: string; label: string } | null>(null)
    const [role, setRole] = useState<RoleName>('user')
    const { showToast } = useToast()

    // Phase 3: pull the bindable roles for *this* workspace — global
    // roles plus any role scoped to this workspace. The picker only
    // shows what the binding endpoint will accept.
    useEffect(() => {
        ;(async () => {
            try {
                setAvailableRoles(
                    await permissionsService.listRoles({ workspaceId }),
                )
            } catch (err) {
                showToast('error', err instanceof Error ? err.message : 'Failed to load roles')
            }
        })()
    }, [workspaceId, showToast])

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

    useEffect(() => {
        ;(async () => {
            try {
                if (subjectType === 'user' && users === null) {
                    const data = await adminUserService.listUsers()
                    setUsers(data)
                }
                if (subjectType === 'group' && groups === null) {
                    const data = await groupsService.list({ limit: 500 })
                    setGroups(data)
                }
            } catch (err) {
                showToast('error', err instanceof Error ? err.message : 'Failed to load')
            }
        })()
    }, [subjectType, users, groups, showToast])

    // Reset selection when toggling subject type
    useEffect(() => { setSelected(null) }, [subjectType])

    const candidates = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (subjectType === 'user') {
            return (users ?? [])
                .filter(u => u.status === 'active')
                .filter(u => !q || u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
                .sort((a, b) => a.displayName.localeCompare(b.displayName))
        }
        return (groups ?? [])
            .filter(g => !q || g.name.toLowerCase().includes(q) || (g.description ?? '').toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
    }, [subjectType, users, groups, search])

    const valid = !!selected
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

            {/* Subject-type toggle */}
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
                            onChange={(e) => setSearch(e.target.value)}
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
                                const u = isUser ? (c as AdminUserResponse) : null
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
                                        <SubjectAvatar type={subjectType} displayName={label} size="sm" />
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
                                const cfg = resolveRoleVisual(r.name)
                                const isCustom = !r.isSystem
                                const Icon = isCustom ? Users2 : cfg.icon
                                const isSelected = role === r.name
                                const isWsScoped = r.scopeType === 'workspace'
                                const description = r.description
                                    ?? (r.isSystem ? cfg.description : 'Custom role — see Permissions for its bundle.')
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
                                            <Icon className={cn('w-4 h-4', cfg.iconColor)} />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center gap-1.5 flex-wrap">
                                                <p className={cn('text-sm font-semibold truncate', isSelected ? cfg.accent : 'text-ink')}>
                                                    {r.isSystem ? cfg.label : r.name}
                                                </p>
                                                {isWsScoped && (
                                                    <span className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[9px] font-bold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
                                                        ws-scoped
                                                    </span>
                                                )}
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
                        This subject already holds the {resolveRoleVisual(role).label} role here. Pick a different role or subject.
                    </motion.div>
                )}
            </AnimatePresence>

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
                        void onSubmit(subjectType, selected.id, role, selected.label)
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


// ── Pending access requests inbox (Phase 4.3) ────────────────────────

function PendingRequestsPanel({
    workspaceId, onResolved,
}: {
    workspaceId: string
    onResolved: () => void | Promise<void>
}) {
    const [requests, setRequests] = useState<AccessRequestResponse[] | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [acting, setActing] = useState<string | null>(null)
    const [denyingId, setDenyingId] = useState<string | null>(null)
    const [denyNote, setDenyNote] = useState('')
    const { showToast } = useToast()

    const fetchPending = useCallback(async () => {
        setError(null)
        try {
            const data = await accessRequestsService.listForWorkspace(workspaceId, {
                status: 'pending',
            })
            setRequests(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load requests')
        }
    }, [workspaceId])

    useEffect(() => { void fetchPending() }, [fetchPending])

    const handleApprove = async (req: AccessRequestResponse) => {
        setActing(req.id)
        try {
            await accessRequestsService.approve(req.id)
            showToast('success', `Approved access for ${req.requester.displayName ?? req.requester.id}`)
            await fetchPending()
            await onResolved()
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Approve failed')
        } finally {
            setActing(null)
        }
    }

    const handleDeny = async (req: AccessRequestResponse) => {
        setActing(req.id)
        try {
            await accessRequestsService.deny(req.id, { note: denyNote.trim() || null })
            showToast('success', `Denied request from ${req.requester.displayName ?? req.requester.id}`)
            setDenyingId(null)
            setDenyNote('')
            await fetchPending()
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Deny failed')
        } finally {
            setActing(null)
        }
    }

    if (requests === null && !error) {
        return null  // initial silent load — keep the page calm
    }

    if (error) {
        return (
            <div className="rounded-2xl border border-red-500/20 bg-red-500/5 p-4 flex items-start gap-3">
                <AlertCircle className="w-4 h-4 text-red-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-red-600 dark:text-red-400">Couldn't load access requests</p>
                    <p className="text-xs text-ink-muted mt-0.5">{error}</p>
                </div>
                <button
                    onClick={() => void fetchPending()}
                    className="text-xs font-semibold text-red-600 dark:text-red-400 hover:underline"
                >
                    Retry
                </button>
            </div>
        )
    }

    const list = requests ?? []
    if (list.length === 0) {
        return null  // empty state suppressed — admins don't need a no-news panel
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18 }}
            className="rounded-2xl border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.04] to-amber-500/0 overflow-hidden"
        >
            <div className="px-5 py-3 border-b border-amber-500/15 flex items-center gap-2">
                <Inbox className="w-4 h-4 text-amber-500" />
                <h3 className="text-sm font-bold text-ink">Pending access requests</h3>
                <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-700 dark:text-amber-300">
                    {list.length}
                </span>
            </div>
            <div className="divide-y divide-amber-500/10">
                {list.map(req => {
                    const isActing = acting === req.id
                    const denying = denyingId === req.id
                    const v = resolveRoleVisual(req.requestedRole)
                    return (
                        <div key={req.id} className="px-5 py-3.5 flex items-start gap-3">
                            <div className={cn(
                                'w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-xs font-bold text-white shrink-0',
                                avatarGradient(req.requester.displayName ?? req.requester.id),
                            )}>
                                {initialsOf(req.requester.displayName ?? req.requester.email ?? req.requester.id)}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                    <p className="text-sm font-semibold text-ink truncate">
                                        {req.requester.displayName ?? req.requester.id}
                                    </p>
                                    {req.requester.email && (
                                        <p className="text-xs text-ink-muted truncate">{req.requester.email}</p>
                                    )}
                                    <span className={cn(
                                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border',
                                        v.badge,
                                    )}>
                                        wants {v.label}
                                    </span>
                                </div>
                                {req.justification && (
                                    <p className="text-xs text-ink-secondary mt-1 break-words">
                                        “{req.justification}”
                                    </p>
                                )}
                                <p className="text-[10px] text-ink-muted mt-1 flex items-center gap-1">
                                    <Clock className="w-2.5 h-2.5" />
                                    Requested {timeAgo(req.createdAt)}
                                </p>

                                {denying && (
                                    <motion.div
                                        initial={{ opacity: 0, height: 0 }}
                                        animate={{ opacity: 1, height: 'auto' }}
                                        className="mt-2 space-y-2"
                                    >
                                        <textarea
                                            value={denyNote}
                                            onChange={e => setDenyNote(e.target.value)}
                                            disabled={isActing}
                                            placeholder="Why are you denying? (optional, shown to the requester)"
                                            rows={2}
                                            className="w-full text-xs px-2.5 py-1.5 rounded-lg bg-canvas-elevated border border-glass-border focus:border-red-500/40 focus:ring-1 focus:ring-red-500/30 outline-none resize-none"
                                        />
                                        <div className="flex gap-2 justify-end">
                                            <button
                                                onClick={() => { setDenyingId(null); setDenyNote('') }}
                                                disabled={isActing}
                                                className="text-xs font-semibold px-3 py-1.5 rounded-lg text-ink-secondary hover:text-ink"
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                onClick={() => void handleDeny(req)}
                                                disabled={isActing}
                                                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/15 text-red-700 dark:text-red-300 border border-red-500/30 hover:bg-red-500/20 disabled:opacity-50"
                                            >
                                                {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                                                Confirm deny
                                            </button>
                                        </div>
                                    </motion.div>
                                )}
                            </div>
                            {!denying && (
                                <div className="flex items-center gap-1.5 shrink-0">
                                    <button
                                        onClick={() => void handleApprove(req)}
                                        disabled={isActing}
                                        title="Approve"
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 disabled:opacity-50 transition-colors"
                                    >
                                        {isActing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                        Approve
                                    </button>
                                    <button
                                        onClick={() => { setDenyingId(req.id); setDenyNote('') }}
                                        disabled={isActing}
                                        title="Deny"
                                        className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/10 border border-transparent hover:border-red-500/20 disabled:opacity-50 transition-colors"
                                    >
                                        <XCircle className="w-3 h-3" />
                                        Deny
                                    </button>
                                </div>
                            )}
                        </div>
                    )
                })}
            </div>
        </motion.div>
    )
}
