/**
 * AdminGroups — Group management panel inside the admin console.
 *
 * KPI summary cards + rich groups table with inline actions:
 *  - Create / edit / delete groups
 *  - Manage members (add / remove)
 *  - SCIM-source badge for IdP-synced groups
 *
 * Visual language matches AdminUsers.tsx: gradient hero icon, KPI strip
 * with colored gradient overlays, framer-motion animated banners,
 * gradient avatars, sortable table headers, and framer-motion modals.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Users2, Users, UserPlus, Pencil, Trash2, RefreshCw, Search,
    Loader2, Plus, X, AlertCircle, AlertTriangle, CheckCircle2,
    Cloud, ChevronDown, ChevronUp, Sparkles, Mail,
} from 'lucide-react'
import {
    groupsService,
    type GroupResponse,
    type GroupMemberResponse,
} from '@/services/groupsService'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import { useToast } from '@/components/ui/toast'
import { avatarGradient, getInitials, initialsOf } from '@/lib/avatar'
import { cn } from '@/lib/utils'


// ── Types & constants ────────────────────────────────────────────────

type SortField = 'name' | 'memberCount' | 'source' | 'createdAt'
type SortDir = 'asc' | 'desc'

type ModalType =
    | { kind: 'create' }
    | { kind: 'edit'; group: GroupResponse }
    | { kind: 'delete'; group: GroupResponse }
    | { kind: 'members'; group: GroupResponse }
    | null

const KPI_CARDS = [
    {
        key: 'total',
        label: 'Total Groups',
        icon: Users2,
        gradient: 'from-indigo-500/20 to-indigo-500/0',
        accent: 'text-indigo-600 dark:text-indigo-400',
        iconBg: 'bg-indigo-500/10 text-indigo-500 border-indigo-500/20',
    },
    {
        key: 'scim',
        label: 'SCIM-synced',
        icon: Cloud,
        gradient: 'from-violet-500/20 to-violet-500/0',
        accent: 'text-violet-600 dark:text-violet-400',
        iconBg: 'bg-violet-500/10 text-violet-500 border-violet-500/20',
    },
    {
        key: 'members',
        label: 'Total Members',
        icon: Users,
        gradient: 'from-emerald-500/20 to-emerald-500/0',
        accent: 'text-emerald-600 dark:text-emerald-400',
        iconBg: 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20',
    },
    {
        key: 'largest',
        label: 'Largest Group',
        icon: Sparkles,
        gradient: 'from-amber-500/20 to-amber-500/0',
        accent: 'text-amber-600 dark:text-amber-400',
        iconBg: 'bg-amber-500/10 text-amber-500 border-amber-500/20',
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


// ── Sortable header ──────────────────────────────────────────────────

function SortHeader({
    label, field, current, dir, onSort, align = 'left',
}: {
    label: string
    field: SortField
    current: SortField
    dir: SortDir
    onSort: (f: SortField) => void
    align?: 'left' | 'right'
}) {
    const isActive = current === field
    return (
        <button
            onClick={() => onSort(field)}
            className={cn(
                'flex items-center gap-1 text-xs font-semibold uppercase tracking-wider transition-colors',
                isActive ? 'text-ink' : 'text-ink-muted hover:text-ink-secondary',
                align === 'right' && 'ml-auto',
            )}
        >
            {label}
            {isActive && (dir === 'asc'
                ? <ChevronUp className="w-3 h-3" />
                : <ChevronDown className="w-3 h-3" />)}
        </button>
    )
}


// ── Main component ───────────────────────────────────────────────────

export function AdminGroups() {
    const [groups, setGroups] = useState<GroupResponse[]>([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const [sortField, setSortField] = useState<SortField>('name')
    const [sortDir, setSortDir] = useState<SortDir>('asc')
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [modal, setModal] = useState<ModalType>(null)
    const { showToast } = useToast()


    // ── Data fetching ────────────────────────────────────────────────

    const fetchGroups = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const data = await groupsService.list({ limit: 500 })
            setGroups(data)
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load groups')
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => { void fetchGroups() }, [fetchGroups])


    // ── KPI computation ──────────────────────────────────────────────

    const kpis = useMemo(() => {
        const memberCounts = groups.map(g => g.memberCount)
        return {
            total: groups.length,
            scim: groups.filter(g => g.source === 'scim').length,
            members: memberCounts.reduce((a, b) => a + b, 0),
            largest: memberCounts.length ? Math.max(...memberCounts) : 0,
        }
    }, [groups])


    // ── Filtering & sorting ─────────────────────────────────────────

    const processedGroups = useMemo(() => {
        let list = [...groups]
        if (search) {
            const q = search.toLowerCase()
            list = list.filter(g =>
                g.name.toLowerCase().includes(q)
                || (g.description?.toLowerCase().includes(q) ?? false),
            )
        }
        list.sort((a, b) => {
            let cmp = 0
            switch (sortField) {
                case 'name': cmp = a.name.localeCompare(b.name); break
                case 'memberCount': cmp = a.memberCount - b.memberCount; break
                case 'source': cmp = a.source.localeCompare(b.source); break
                case 'createdAt': cmp = a.createdAt.localeCompare(b.createdAt); break
            }
            return sortDir === 'asc' ? cmp : -cmp
        })
        return list
    }, [groups, search, sortField, sortDir])


    const handleSort = (field: SortField) => {
        if (sortField === field) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
        else { setSortField(field); setSortDir('asc') }
    }


    // ── Actions ──────────────────────────────────────────────────────

    const withAction = async <T,>(
        key: string,
        fn: () => Promise<T>,
        successMsg?: string,
    ): Promise<T | undefined> => {
        setActionLoading(key)
        setError(null)
        try {
            const result = await fn()
            if (successMsg) showToast('success', successMsg)
            await fetchGroups()
            return result
        } catch (err) {
            const message = err instanceof Error ? err.message : 'Action failed'
            showToast('error', message)
            setError(message)
            return undefined
        } finally {
            setActionLoading(null)
        }
    }


    // ── Render ───────────────────────────────────────────────────────

    if (loading && groups.length === 0) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="w-6 h-6 animate-spin text-ink-muted" />
            </div>
        )
    }

    return (
        <div className="max-w-6xl mx-auto p-8 animate-in fade-in duration-500">
            {/* Header */}
            <div className="flex items-center justify-between mb-10">
                <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-violet-500 to-fuchsia-600 flex items-center justify-center shadow-md">
                        <Users2 className="w-6 h-6 text-white" />
                    </div>
                    <div>
                        <h1 className="text-3xl font-bold tracking-tight text-ink">Groups</h1>
                        <p className="text-sm text-ink-muted mt-1">
                            Bind groups to workspaces to grant roles in bulk.
                        </p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={() => setModal({ kind: 'create' })}
                        className="px-4 py-2 rounded-xl font-medium text-sm text-white bg-accent-lineage hover:brightness-110 transition-colors duration-150 flex items-center gap-2 shadow-sm shadow-accent-lineage/20"
                    >
                        <Plus className="w-4 h-4" />
                        New group
                    </button>
                    <button
                        onClick={() => void fetchGroups()}
                        disabled={loading}
                        className="px-4 py-2 border border-glass-border bg-canvas-elevated hover:bg-black/5 dark:hover:bg-white/5 rounded-xl font-medium text-sm text-ink transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-4 h-4', loading && 'animate-spin')} />
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
                        <div
                            key={kpi.key}
                            className="relative overflow-hidden border border-glass-border rounded-xl p-5 bg-canvas-elevated hover:shadow-lg transition-colors duration-200"
                        >
                            <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', kpi.gradient)} />
                            <div className="relative">
                                <div className={cn('w-9 h-9 rounded-lg border flex items-center justify-center mb-3', kpi.iconBg)}>
                                    <Icon className="w-4.5 h-4.5" />
                                </div>
                                <p className={cn('text-2xl font-bold', kpi.accent)}>{value}</p>
                                <p className="text-xs text-ink-muted mt-1">{kpi.label}</p>
                            </div>
                        </div>
                    )
                })}
            </div>

            {/* SCIM banner */}
            <AnimatePresence>
                {kpis.scim > 0 && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-3 p-4 mb-4 rounded-xl bg-violet-500/10 border border-violet-500/20"
                    >
                        <div className="w-8 h-8 rounded-lg bg-violet-500/20 flex items-center justify-center shrink-0">
                            <Cloud className="w-4 h-4 text-violet-600 dark:text-violet-400" />
                        </div>
                        <div className="flex-1">
                            <p className="text-sm font-semibold text-violet-700 dark:text-violet-300">
                                {kpis.scim} SCIM-synced group{kpis.scim !== 1 ? 's' : ''}
                            </p>
                            <p className="text-xs text-violet-600/80 dark:text-violet-400/80 mt-0.5">
                                Members of these groups are managed by your identity provider — local edits will be overwritten on the next sync.
                            </p>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Error banner (in addition to toast) */}
            <AnimatePresence>
                {error && (
                    <motion.div
                        initial={{ opacity: 0, y: -8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                        transition={{ duration: 0.2 }}
                        className="flex items-center gap-2 p-3 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-sm"
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
            <div className="flex items-center gap-4 mb-6">
                <div className="relative flex-1 max-w-xs">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                    <input
                        type="text"
                        placeholder="Search groups by name or description..."
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        className="input pl-9 h-9 text-sm bg-white/50 dark:bg-black/20 w-full"
                    />
                    {search && (
                        <button
                            onClick={() => setSearch('')}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink transition-colors"
                        >
                            <X className="w-3.5 h-3.5" />
                        </button>
                    )}
                </div>
            </div>

            {/* Empty / table */}
            {processedGroups.length === 0 ? (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated">
                    <div className="flex flex-col items-center justify-center py-20">
                        <div className="w-16 h-16 rounded-2xl bg-black/5 dark:bg-white/5 flex items-center justify-center mb-4">
                            {search
                                ? <Search className="w-7 h-7 text-ink-muted/60" />
                                : <Users2 className="w-7 h-7 text-ink-muted/60" />}
                        </div>
                        <p className="text-sm font-medium text-ink-secondary mb-1">
                            {search ? 'No matching groups' : 'No groups yet'}
                        </p>
                        <p className="text-xs text-ink-muted max-w-md text-center mb-5">
                            {search
                                ? 'Try adjusting your search query.'
                                : 'Create a group to bind it to workspaces and grant roles in bulk.'}
                        </p>
                        {!search && (
                            <button
                                onClick={() => setModal({ kind: 'create' })}
                                className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-violet-500 to-fuchsia-600 text-white text-sm font-semibold shadow-sm shadow-violet-500/20"
                            >
                                <Plus className="w-4 h-4" />
                                Create your first group
                            </button>
                        )}
                    </div>
                </div>
            ) : (
                <div className="border border-glass-border rounded-xl bg-canvas-elevated overflow-hidden shadow-sm">
                    <table className="w-full">
                        <thead className="bg-black/[0.03] dark:bg-white/[0.03]">
                            <tr className="border-b border-glass-border">
                                <th className="text-left px-5 py-3"><SortHeader label="Group" field="name" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Members" field="memberCount" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Source" field="source" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-left px-5 py-3"><SortHeader label="Created" field="createdAt" current={sortField} dir={sortDir} onSort={handleSort} /></th>
                                <th className="text-right px-5 py-3"><span className="text-xs font-semibold uppercase tracking-wider text-ink-muted">Actions</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {processedGroups.map((g, i) => {
                                const isActing = actionLoading === g.id
                                const isScim = g.source === 'scim'
                                return (
                                    <motion.tr
                                        key={g.id}
                                        initial={{ opacity: 0 }}
                                        animate={{ opacity: 1 }}
                                        transition={{ duration: 0.15, delay: i * 0.02 }}
                                        className="border-b last:border-b-0 border-glass-border transition-colors group hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    >
                                        {/* Group avatar + name + description */}
                                        <td className="px-5 py-4">
                                            <div className="flex items-center gap-3">
                                                <div className={cn(
                                                    'w-9 h-9 rounded-full bg-gradient-to-br flex items-center justify-center text-[11px] font-bold text-white shrink-0 shadow-sm',
                                                    avatarGradient(g.name),
                                                )}>
                                                    {initialsOf(g.name)}
                                                </div>
                                                <div className="min-w-0">
                                                    <p className="text-sm font-semibold text-ink truncate">{g.name}</p>
                                                    {g.description ? (
                                                        <p className="text-xs text-ink-muted truncate mt-0.5">{g.description}</p>
                                                    ) : (
                                                        <p className="text-xs text-ink-muted/60 italic mt-0.5">No description</p>
                                                    )}
                                                </div>
                                            </div>
                                        </td>

                                        {/* Member count */}
                                        <td className="px-5 py-4">
                                            <button
                                                onClick={() => setModal({ kind: 'members', group: g })}
                                                className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-sm font-semibold text-ink-secondary hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                            >
                                                <Users className="w-3.5 h-3.5 text-ink-muted" />
                                                {g.memberCount}
                                            </button>
                                        </td>

                                        {/* Source badge */}
                                        <td className="px-5 py-4">
                                            <span className={cn(
                                                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border',
                                                isScim
                                                    ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20'
                                                    : 'bg-glass-base/60 text-ink-muted border-glass-border',
                                            )}>
                                                {isScim ? <Cloud className="w-3 h-3" /> : <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />}
                                                {isScim ? 'SCIM' : 'Local'}
                                            </span>
                                        </td>

                                        {/* Created */}
                                        <td className="px-5 py-4">
                                            <p className="text-sm text-ink-secondary">{formatDate(g.createdAt)}</p>
                                            <p className="text-[11px] text-ink-muted mt-0.5">{timeAgo(g.createdAt)}</p>
                                        </td>

                                        {/* Actions */}
                                        <td className="px-5 py-4 text-right">
                                            <div className="flex items-center gap-1.5 justify-end">
                                                <button
                                                    onClick={() => setModal({ kind: 'members', group: g })}
                                                    disabled={isActing}
                                                    title="Manage members"
                                                    className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                                                >
                                                    <UserPlus className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => setModal({ kind: 'edit', group: g })}
                                                    disabled={isActing || isScim}
                                                    title={isScim ? 'SCIM-synced groups cannot be edited locally' : 'Edit'}
                                                    className="p-2 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                                >
                                                    <Pencil className="w-4 h-4" />
                                                </button>
                                                <button
                                                    onClick={() => setModal({ kind: 'delete', group: g })}
                                                    disabled={isActing}
                                                    title="Delete group"
                                                    className="p-2 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/5 transition-colors disabled:opacity-50"
                                                >
                                                    <Trash2 className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </td>
                                    </motion.tr>
                                )
                            })}
                        </tbody>
                    </table>

                    {/* Footer */}
                    <div className="px-5 py-3 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.02] flex items-center justify-between">
                        <p className="text-xs text-ink-muted">
                            Showing <span className="font-semibold text-ink-secondary">{processedGroups.length}</span>
                            {processedGroups.length !== groups.length && (
                                <> of <span className="font-semibold text-ink-secondary">{groups.length}</span></>
                            )} group{groups.length !== 1 ? 's' : ''}
                        </p>
                        {search && (
                            <button
                                onClick={() => setSearch('')}
                                className="text-xs font-medium text-accent-lineage hover:underline"
                            >
                                Clear search
                            </button>
                        )}
                    </div>
                </div>
            )}

            {/* ── Modals ────────────────────────────────────────────── */}
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
                                modal.kind === 'members' ? 'max-w-2xl' : 'max-w-md',
                            )}
                        >
                            {modal.kind === 'create' && (
                                <CreateOrEditModal
                                    onClose={() => setModal(null)}
                                    onSubmit={async (vals) => {
                                        const created = await withAction('create', async () => {
                                            return await groupsService.create(vals)
                                        }, `Group "${vals.name}" created`)
                                        if (created) setModal(null)
                                    }}
                                    submitting={actionLoading === 'create'}
                                />
                            )}
                            {modal.kind === 'edit' && (
                                <CreateOrEditModal
                                    initial={modal.group}
                                    onClose={() => setModal(null)}
                                    onSubmit={async (vals) => {
                                        const updated = await withAction(`edit-${modal.group.id}`, async () => {
                                            return await groupsService.update(modal.group.id, vals)
                                        }, 'Group updated')
                                        if (updated) setModal(null)
                                    }}
                                    submitting={actionLoading === `edit-${modal.group.id}`}
                                />
                            )}
                            {modal.kind === 'delete' && (
                                <DeleteConfirmModal
                                    group={modal.group}
                                    onClose={() => setModal(null)}
                                    onConfirm={async () => {
                                        const ok = await withAction(`del-${modal.group.id}`, async () => {
                                            await groupsService.delete(modal.group.id)
                                            return true
                                        }, `Deleted "${modal.group.name}"`)
                                        if (ok) setModal(null)
                                    }}
                                    submitting={actionLoading === `del-${modal.group.id}`}
                                />
                            )}
                            {modal.kind === 'members' && (
                                <ManageMembersModal
                                    group={modal.group}
                                    onClose={() => setModal(null)}
                                    onChange={() => void fetchGroups()}
                                />
                            )}
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}


// ── Modal pieces ─────────────────────────────────────────────────────

function ModalHeader({
    icon: Icon, iconBg, iconColor, title, subtitle, onClose,
}: {
    icon: React.ComponentType<{ className?: string }>
    iconBg: string
    iconColor: string
    title: string
    subtitle?: string
    onClose: () => void
}) {
    return (
        <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-3">
                <div className={cn('w-10 h-10 rounded-xl border flex items-center justify-center', iconBg)}>
                    <Icon className={cn('w-5 h-5', iconColor)} />
                </div>
                <div>
                    <h3 className="text-lg font-bold text-ink">{title}</h3>
                    {subtitle && <p className="text-xs text-ink-muted">{subtitle}</p>}
                </div>
            </div>
            <button
                onClick={onClose}
                className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            >
                <X className="w-4 h-4" />
            </button>
        </div>
    )
}


function CreateOrEditModal({
    initial, onClose, onSubmit, submitting,
}: {
    initial?: GroupResponse
    onClose: () => void
    onSubmit: (vals: { name: string; description: string | null }) => Promise<void>
    submitting: boolean
}) {
    const isEdit = !!initial
    const [name, setName] = useState(initial?.name ?? '')
    const [description, setDescription] = useState(initial?.description ?? '')

    const valid = name.trim().length > 0

    return (
        <>
            <ModalHeader
                icon={isEdit ? Pencil : Sparkles}
                iconBg="bg-accent-lineage/10 border-accent-lineage/20"
                iconColor="text-accent-lineage"
                title={isEdit ? `Edit ${initial!.name}` : 'New group'}
                subtitle={isEdit
                    ? 'Update the group name or description'
                    : 'Bundle users so you can grant roles in bulk'}
                onClose={onClose}
            />

            <div className="space-y-4">
                <div>
                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                        Name
                    </label>
                    <input
                        autoFocus
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="e.g. Marketing"
                        className="input w-full text-sm"
                    />
                </div>
                <div>
                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                        Description <span className="normal-case font-normal">(optional)</span>
                    </label>
                    <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder="What this group is for..."
                        rows={3}
                        className="input w-full resize-none text-sm"
                    />
                </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
                <button
                    onClick={onClose}
                    disabled={submitting}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    onClick={() => void onSubmit({ name: name.trim(), description: description.trim() || null })}
                    disabled={!valid || submitting}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-accent-lineage hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm shadow-accent-lineage/20"
                >
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    {isEdit ? 'Save changes' : 'Create group'}
                </button>
            </div>
        </>
    )
}


function DeleteConfirmModal({
    group, onClose, onConfirm, submitting,
}: {
    group: GroupResponse
    onClose: () => void
    onConfirm: () => Promise<void>
    submitting: boolean
}) {
    return (
        <>
            <ModalHeader
                icon={AlertTriangle}
                iconBg="bg-red-500/10 border-red-500/20"
                iconColor="text-red-500"
                title="Delete group"
                subtitle="This action cannot be undone"
                onClose={onClose}
            />

            <div className="space-y-4">
                <div className="flex items-center gap-3 p-3 rounded-xl bg-glass-base/40 border border-glass-border">
                    <div className={cn(
                        'w-10 h-10 rounded-full bg-gradient-to-br flex items-center justify-center text-xs font-bold text-white shrink-0',
                        avatarGradient(group.name),
                    )}>
                        {initialsOf(group.name)}
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-ink truncate">{group.name}</p>
                        <p className="text-xs text-ink-muted">
                            {group.memberCount} member{group.memberCount !== 1 ? 's' : ''}
                        </p>
                    </div>
                </div>

                <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-3">
                    <p className="text-sm font-semibold text-red-700 dark:text-red-400 flex items-center gap-2">
                        <AlertCircle className="w-4 h-4" />
                        Cascading effects
                    </p>
                    <ul className="mt-2 text-xs text-red-600/90 dark:text-red-400/90 space-y-1 ml-6 list-disc">
                        <li>Every workspace binding granted to this group will be revoked.</li>
                        <li>Every view grant given to this group will be removed.</li>
                        <li>Members lose access immediately on their next request.</li>
                    </ul>
                </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
                <button
                    onClick={onClose}
                    disabled={submitting}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    onClick={() => void onConfirm()}
                    disabled={submitting}
                    className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-500 hover:bg-red-600 disabled:opacity-50 transition-colors shadow-sm shadow-red-500/20"
                >
                    {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                    Delete group
                </button>
            </div>
        </>
    )
}


function ManageMembersModal({
    group, onClose, onChange,
}: {
    group: GroupResponse
    onClose: () => void
    onChange: () => void
}) {
    const [members, setMembers] = useState<GroupMemberResponse[] | null>(null)
    const [users, setUsers] = useState<AdminUserResponse[] | null>(null)
    const [busy, setBusy] = useState<string | null>(null)
    const [search, setSearch] = useState('')
    const { showToast } = useToast()

    const refresh = useCallback(async () => {
        try {
            const [m, u] = await Promise.all([
                groupsService.listMembers(group.id),
                adminUserService.listUsers(),
            ])
            setMembers(m)
            setUsers(u)
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Failed to load members')
        }
    }, [group.id, showToast])

    useEffect(() => { void refresh() }, [refresh])

    const memberIds = useMemo(() => new Set((members ?? []).map(m => m.userId)), [members])
    const memberRows = useMemo(() => {
        if (!members || !users) return []
        return members
            .map(m => ({ member: m, user: users.find(u => u.id === m.userId) }))
            .sort((a, b) => (a.user?.displayName ?? '').localeCompare(b.user?.displayName ?? ''))
    }, [members, users])
    const candidates = useMemo(() => {
        if (!users) return []
        const q = search.trim().toLowerCase()
        return users
            .filter(u => !memberIds.has(u.id) && u.status === 'active')
            .filter(u => !q
                || u.displayName.toLowerCase().includes(q)
                || u.email.toLowerCase().includes(q))
            .sort((a, b) => a.displayName.localeCompare(b.displayName))
    }, [users, memberIds, search])

    const isScim = group.source === 'scim'

    return (
        <>
            <ModalHeader
                icon={Users}
                iconBg="bg-violet-500/10 border-violet-500/20"
                iconColor="text-violet-500"
                title={`${group.name} — members`}
                subtitle={isScim
                    ? 'SCIM-synced membership — local edits will be overwritten on next sync'
                    : `${group.memberCount} member${group.memberCount !== 1 ? 's' : ''}`}
                onClose={onClose}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* Current members */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                            Current ({members?.length ?? 0})
                        </h4>
                    </div>
                    <div className="rounded-xl border border-glass-border bg-glass-base/30 max-h-72 overflow-y-auto">
                        {members === null ? (
                            <div className="p-6 text-center text-ink-muted text-sm">
                                <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                                Loading…
                            </div>
                        ) : memberRows.length === 0 ? (
                            <div className="p-6 text-center text-ink-muted text-sm">
                                No members yet — add some →
                            </div>
                        ) : (
                            memberRows.map(({ member, user }) => {
                                const name = user?.displayName ?? member.userId
                                return (
                                    <div
                                        key={member.userId}
                                        className="flex items-center gap-2.5 px-3 py-2 border-b last:border-b-0 border-glass-border group hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                    >
                                        <div className={cn(
                                            'w-7 h-7 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white shrink-0',
                                            avatarGradient(name),
                                        )}>
                                            {user
                                                ? getInitials(user.firstName, user.lastName)
                                                : initialsOf(member.userId)}
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm text-ink truncate">{name}</p>
                                            {user?.email && (
                                                <div className="flex items-center gap-1 mt-0.5">
                                                    <Mail className="w-3 h-3 text-ink-muted shrink-0" />
                                                    <p className="text-[11px] text-ink-muted truncate">{user.email}</p>
                                                </div>
                                            )}
                                        </div>
                                        {!isScim && (
                                            <button
                                                onClick={async () => {
                                                    setBusy(member.userId)
                                                    try {
                                                        await groupsService.removeMember(group.id, member.userId)
                                                        await refresh()
                                                        onChange()
                                                        showToast('success', `Removed ${name}`)
                                                    } catch (err) {
                                                        showToast('error', err instanceof Error ? err.message : 'Remove failed')
                                                    } finally {
                                                        setBusy(null)
                                                    }
                                                }}
                                                disabled={busy === member.userId}
                                                className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-all disabled:opacity-50"
                                                title="Remove from group"
                                            >
                                                {busy === member.userId
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <X className="w-3.5 h-3.5" />}
                                            </button>
                                        )}
                                    </div>
                                )
                            })
                        )}
                    </div>
                </div>

                {/* Add member picker */}
                <div className="space-y-2">
                    <div className="flex items-center justify-between">
                        <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                            Add a user
                        </h4>
                    </div>
                    {isScim ? (
                        <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-4 text-xs text-violet-600 dark:text-violet-400">
                            <Cloud className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                            SCIM-synced groups manage their members through the identity provider. Local edits are not allowed.
                        </div>
                    ) : (
                        <>
                            <div className="relative">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
                                <input
                                    type="text"
                                    placeholder="Search users..."
                                    value={search}
                                    onChange={(e) => setSearch(e.target.value)}
                                    className="input pl-9 h-9 w-full text-sm"
                                />
                            </div>
                            <div className="rounded-xl border border-glass-border bg-glass-base/30 max-h-60 overflow-y-auto">
                                {users === null ? (
                                    <div className="p-6 text-center text-ink-muted text-sm">
                                        <Loader2 className="w-4 h-4 animate-spin inline-block mr-2" />
                                        Loading users…
                                    </div>
                                ) : candidates.length === 0 ? (
                                    <div className="p-6 text-center text-ink-muted text-sm">
                                        {search
                                            ? 'No users match your search.'
                                            : 'All active users are already members.'}
                                    </div>
                                ) : (
                                    candidates.map(u => (
                                        <button
                                            key={u.id}
                                            onClick={async () => {
                                                setBusy(u.id)
                                                try {
                                                    await groupsService.addMember(group.id, u.id)
                                                    await refresh()
                                                    onChange()
                                                    showToast('success', `Added ${u.displayName}`)
                                                } catch (err) {
                                                    showToast('error', err instanceof Error ? err.message : 'Add failed')
                                                } finally {
                                                    setBusy(null)
                                                }
                                            }}
                                            disabled={busy === u.id}
                                            className="w-full flex items-center gap-2.5 px-3 py-2 border-b last:border-b-0 border-glass-border text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                                        >
                                            <div className={cn(
                                                'w-7 h-7 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white shrink-0',
                                                avatarGradient(u.displayName),
                                            )}>
                                                {getInitials(u.firstName, u.lastName)}
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm text-ink truncate">{u.displayName}</p>
                                                <p className="text-[11px] text-ink-muted truncate">{u.email}</p>
                                            </div>
                                            {busy === u.id
                                                ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted" />
                                                : <Plus className="w-3.5 h-3.5 text-accent-lineage opacity-0 group-hover:opacity-100" />}
                                        </button>
                                    ))
                                )}
                            </div>
                        </>
                    )}
                </div>
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
                <button
                    onClick={onClose}
                    className="px-4 py-2 rounded-xl text-sm font-semibold text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                    <CheckCircle2 className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                    Done
                </button>
            </div>
        </>
    )
}
