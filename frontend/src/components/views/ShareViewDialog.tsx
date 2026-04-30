/**
 * ShareViewDialog - control how a view is shared.
 *
 * Two layers stacked vertically:
 *   1. Visibility tier (private | workspace | enterprise) — broadcast
 *      audience. Saved on every selection.
 *   2. Explicit grants — additive shares with named users or groups
 *      at editor or viewer scope. Independent of workspace membership.
 *
 * The shareable URL banner sits between the two so users get the
 * "what link can I send?" question answered up front, then refine the
 * audience below.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    X, Link2, Check, Lock, Users, Globe, UserPlus, UserCog, Users2,
    Search, Loader2, Eye, Pencil, Trash2, AlertCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { updateViewVisibility } from '@/services/viewApiService'
import {
    viewGrantsService,
    type ViewGrantResponse,
} from '@/services/viewGrantsService'
import { groupsService, type GroupResponse } from '@/services/groupsService'
import { adminUserService, type AdminUserResponse } from '@/services/adminUserService'
import { useToast } from '@/components/ui/toast'
import { avatarGradient, initialsOf } from '@/lib/avatar'


type GrantRole = 'editor' | 'viewer'
type SubjectType = 'user' | 'group'


interface ShareViewDialogProps {
    viewId: string
    viewName: string
    currentVisibility: 'private' | 'workspace' | 'enterprise'
    isOpen: boolean
    onClose: () => void
    onVisibilityChange?: (visibility: 'private' | 'workspace' | 'enterprise') => void
}


const VISIBILITY_OPTIONS = [
    {
        id: 'private' as const,
        label: 'Private',
        description: 'Only you (and workspace admins) can see this view',
        icon: Lock,
        accent: 'indigo',
    },
    {
        id: 'workspace' as const,
        label: 'Workspace',
        description: 'All members of the view\'s workspace can access',
        icon: Users,
        accent: 'sky',
    },
    {
        id: 'enterprise' as const,
        label: 'Enterprise',
        description: 'Anyone in the organization can access (broadly visible)',
        icon: Globe,
        accent: 'amber',
    },
] as const


const GRANT_ROLES: { id: GrantRole; label: string; icon: typeof Eye }[] = [
    { id: 'viewer', label: 'Viewer', icon: Eye },
    { id: 'editor', label: 'Editor', icon: Pencil },
]


export function ShareViewDialog({
    viewId,
    viewName,
    currentVisibility,
    isOpen,
    onClose,
    onVisibilityChange,
}: ShareViewDialogProps) {
    const [visibility, setVisibility] = useState(currentVisibility)
    const [copied, setCopied] = useState(false)
    const [savingVisibility, setSavingVisibility] = useState(false)

    const [grants, setGrants] = useState<ViewGrantResponse[] | null>(null)
    const [grantsError, setGrantsError] = useState<string | null>(null)
    const [busyGrantId, setBusyGrantId] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)

    const { showToast } = useToast()

    const shareUrl = `${window.location.origin}/views/${viewId}`


    // ── Initial load: fetch existing grants ─────────────────────────

    const fetchGrants = useCallback(async () => {
        if (!isOpen) return
        setGrantsError(null)
        try {
            const data = await viewGrantsService.list(viewId)
            setGrants(data)
        } catch (err) {
            // 403 here means the caller can't manage grants — render
            // the section in a read-only / locked state.
            setGrantsError(err instanceof Error ? err.message : 'Failed to load grants')
            setGrants([])
        }
    }, [isOpen, viewId])

    useEffect(() => { void fetchGrants() }, [fetchGrants])

    // Reset visibility selector if the parent prop changes (e.g. after
    // a different view opens the dialog).
    useEffect(() => { setVisibility(currentVisibility) }, [currentVisibility])


    // ── Handlers ────────────────────────────────────────────────────

    const handleCopy = useCallback(async () => {
        await navigator.clipboard.writeText(shareUrl)
        setCopied(true)
        setTimeout(() => setCopied(false), 2000)
    }, [shareUrl])

    const handleVisibilityChange = useCallback(async (newVisibility: typeof visibility) => {
        const prev = visibility
        setVisibility(newVisibility)
        setSavingVisibility(true)
        try {
            await updateViewVisibility(viewId, newVisibility)
            onVisibilityChange?.(newVisibility)
            showToast('success', `Visibility set to ${newVisibility}`)
        } catch (err) {
            // Revert on error
            setVisibility(prev)
            showToast('error', err instanceof Error ? err.message : 'Failed to update visibility')
        } finally {
            setSavingVisibility(false)
        }
    }, [viewId, visibility, onVisibilityChange, showToast])

    const handleAddGrant = async (
        subjectType: SubjectType,
        subjectId: string,
        role: GrantRole,
        label: string,
    ) => {
        setAdding(true)
        try {
            const grant = await viewGrantsService.create(viewId, {
                subjectType, subjectId, role,
            })
            setGrants(prev => [...(prev ?? []), grant])
            showToast('success', `Shared with ${label} as ${role}`)
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Failed to add grant')
        } finally {
            setAdding(false)
        }
    }

    const handleRemoveGrant = async (grant: ViewGrantResponse) => {
        setBusyGrantId(grant.grantId)
        try {
            await viewGrantsService.delete(viewId, grant.grantId)
            setGrants(prev => (prev ?? []).filter(g => g.grantId !== grant.grantId))
            showToast('success', `Removed ${grant.subject.displayName ?? grant.subject.id}`)
        } catch (err) {
            showToast('error', err instanceof Error ? err.message : 'Failed to remove grant')
        } finally {
            setBusyGrantId(null)
        }
    }


    if (!isOpen) return null

    return (
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-black/50"
                onClick={onClose}
            >
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.95, opacity: 0 }}
                    onClick={(e) => e.stopPropagation()}
                    className="w-full max-w-xl bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]"
                >
                    {/* Header */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-glass-border shrink-0">
                        <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center shadow-md shadow-sky-500/20">
                                <Link2 className="w-5 h-5 text-white" />
                            </div>
                            <div className="min-w-0">
                                <h3 className="text-lg font-bold text-ink">Share View</h3>
                                <p className="text-xs text-ink-muted truncate">{viewName}</p>
                            </div>
                        </div>
                        <button
                            onClick={onClose}
                            className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="overflow-y-auto px-6 py-5 space-y-6">
                        {/* Shareable URL */}
                        <div>
                            <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2 block">
                                Shareable Link
                            </label>
                            <div className="flex gap-2">
                                <input
                                    type="text"
                                    value={shareUrl}
                                    readOnly
                                    className="input flex-1 text-sm bg-glass-base/40"
                                />
                                <button
                                    onClick={handleCopy}
                                    className={cn(
                                        'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors duration-150',
                                        copied
                                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20'
                                            : 'bg-accent-lineage text-white hover:brightness-110 shadow-sm shadow-accent-lineage/20',
                                    )}
                                >
                                    {copied ? <><Check className="w-4 h-4" />Copied</> : <><Link2 className="w-4 h-4" />Copy</>}
                                </button>
                            </div>
                        </div>

                        {/* Visibility tier */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted">
                                    Visibility
                                </label>
                                {savingVisibility && (
                                    <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                                        <Loader2 className="w-3 h-3 animate-spin" /> Saving…
                                    </span>
                                )}
                            </div>
                            <div className="space-y-2">
                                {VISIBILITY_OPTIONS.map(({ id, label, description, icon: Icon, accent }) => {
                                    const isSelected = visibility === id
                                    return (
                                        <button
                                            key={id}
                                            onClick={() => void handleVisibilityChange(id)}
                                            disabled={savingVisibility}
                                            className={cn(
                                                'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-colors duration-150 text-left',
                                                isSelected
                                                    ? `border-${accent}-500 bg-${accent}-500/5`
                                                    : 'border-glass-border hover:border-ink-muted/30 bg-canvas-elevated',
                                            )}
                                        >
                                            <div className={cn(
                                                'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
                                                isSelected
                                                    ? `bg-${accent}-500/15 border-${accent}-500/30`
                                                    : 'bg-glass-base/40 border-glass-border',
                                            )}>
                                                <Icon className={cn('w-4 h-4', isSelected ? `text-${accent}-500` : 'text-ink-muted')} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <span className={cn(
                                                    'text-sm font-semibold block',
                                                    isSelected ? `text-${accent}-600 dark:text-${accent}-400` : 'text-ink',
                                                )}>
                                                    {label}
                                                </span>
                                                <span className="text-[11px] text-ink-muted leading-snug">{description}</span>
                                            </div>
                                            {isSelected && (
                                                <Check className={cn('w-4 h-4 shrink-0', `text-${accent}-500`)} />
                                            )}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        {/* Explicit grants */}
                        <div>
                            <div className="flex items-center justify-between mb-2">
                                <div>
                                    <label className="text-xs font-semibold uppercase tracking-wider text-ink-muted block">
                                        Share with people or groups
                                    </label>
                                    <p className="text-[11px] text-ink-muted mt-0.5">
                                        Adds access on top of the visibility above. Editors can edit; viewers can read.
                                    </p>
                                </div>
                                {grants && grants.length > 0 && (
                                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold border border-glass-border text-ink-muted bg-glass-base/40">
                                        {grants.length} share{grants.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>

                            {/* Add picker */}
                            <AddGrantPicker disabled={adding} onAdd={handleAddGrant} />

                            {/* Existing grants */}
                            <div className="mt-3">
                                {grantsError && (
                                    <div className="flex items-center gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-600 dark:text-red-400 text-xs">
                                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                        <p>{grantsError}</p>
                                    </div>
                                )}
                                {!grantsError && grants === null && (
                                    <div className="flex items-center justify-center py-6 text-ink-muted text-sm">
                                        <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                        Loading shares…
                                    </div>
                                )}
                                {!grantsError && grants && grants.length === 0 && (
                                    <div className="rounded-xl border border-dashed border-glass-border bg-glass-base/20 px-4 py-5 text-center">
                                        <UserPlus className="w-6 h-6 text-ink-muted/60 mx-auto mb-2" />
                                        <p className="text-xs text-ink-muted">
                                            No explicit shares yet. Use the picker above to share with specific people or groups.
                                        </p>
                                    </div>
                                )}
                                {!grantsError && grants && grants.length > 0 && (
                                    <div className="rounded-xl border border-glass-border bg-glass-base/20 divide-y divide-glass-border">
                                        {grants.map(g => {
                                            const name = g.subject.displayName ?? g.subject.id
                                            const isUser = g.subject.type === 'user'
                                            const isBusy = busyGrantId === g.grantId
                                            const RoleIcon = g.role === 'editor' ? Pencil : Eye
                                            return (
                                                <div
                                                    key={g.grantId}
                                                    className="flex items-center gap-2.5 px-3 py-2 group hover:bg-black/[0.02] dark:hover:bg-white/[0.02]"
                                                >
                                                    {isUser ? (
                                                        <div className={cn(
                                                            'w-8 h-8 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white shrink-0',
                                                            avatarGradient(name),
                                                        )}>
                                                            {initialsOf(name)}
                                                        </div>
                                                    ) : (
                                                        <div className="w-8 h-8 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                                                            <Users2 className="w-3.5 h-3.5" />
                                                        </div>
                                                    )}
                                                    <div className="min-w-0 flex-1">
                                                        <div className="flex items-center gap-1.5">
                                                            <p className="text-sm text-ink truncate">{name}</p>
                                                            {!isUser && (
                                                                <span className="px-1 py-px rounded text-[9px] font-bold bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 shrink-0">
                                                                    GROUP
                                                                </span>
                                                            )}
                                                        </div>
                                                        {g.subject.secondary && (
                                                            <p className="text-[11px] text-ink-muted truncate">{g.subject.secondary}</p>
                                                        )}
                                                    </div>
                                                    <span className={cn(
                                                        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold border shrink-0',
                                                        g.role === 'editor'
                                                            ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                                                            : 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border-slate-500/20',
                                                    )}>
                                                        <RoleIcon className="w-3 h-3" />
                                                        {g.role === 'editor' ? 'Editor' : 'Viewer'}
                                                    </span>
                                                    <button
                                                        onClick={() => void handleRemoveGrant(g)}
                                                        disabled={isBusy}
                                                        title="Remove share"
                                                        className="opacity-0 group-hover:opacity-100 p-1.5 rounded-lg text-ink-muted hover:text-red-500 hover:bg-red-500/10 transition-all disabled:opacity-50"
                                                    >
                                                        {isBusy
                                                            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                            : <Trash2 className="w-3.5 h-3.5" />}
                                                    </button>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-3 border-t border-glass-border bg-glass-base/20 shrink-0">
                        <p className="text-[11px] text-ink-muted text-center leading-relaxed">
                            {visibility === 'private' && 'Only the creator and workspace admins can access this view.'}
                            {visibility === 'workspace' && 'All workspace members can access this view.'}
                            {visibility === 'enterprise' && 'Anyone in the organization can access this view.'}
                            {grants && grants.length > 0 && (
                                <> Plus <span className="font-semibold text-ink-secondary">{grants.length} explicit share{grants.length !== 1 ? 's' : ''}</span>.</>
                            )}
                        </p>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>
    )
}


// ── Add-grant picker (subject-type toggle + searchable list + role) ──

function AddGrantPicker({
    disabled,
    onAdd,
}: {
    disabled: boolean
    onAdd: (
        subjectType: SubjectType,
        subjectId: string,
        role: GrantRole,
        label: string,
    ) => Promise<void>
}) {
    const [subjectType, setSubjectType] = useState<SubjectType>('user')
    const [search, setSearch] = useState('')
    const [users, setUsers] = useState<AdminUserResponse[] | null>(null)
    const [groups, setGroups] = useState<GroupResponse[] | null>(null)
    const [role, setRole] = useState<GrantRole>('viewer')
    const [open, setOpen] = useState(false)

    useEffect(() => {
        if (!open) return
        ;(async () => {
            try {
                if (subjectType === 'user' && users === null) {
                    setUsers(await adminUserService.listUsers())
                }
                if (subjectType === 'group' && groups === null) {
                    setGroups(await groupsService.list({ limit: 500 }))
                }
            } catch {
                /* errors surface via toast in onAdd */
            }
        })()
    }, [open, subjectType, users, groups])

    const candidates = useMemo(() => {
        const q = search.trim().toLowerCase()
        if (subjectType === 'user') {
            return (users ?? [])
                .filter(u => u.status === 'active')
                .filter(u => !q || u.displayName.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
                .sort((a, b) => a.displayName.localeCompare(b.displayName))
                .slice(0, 25)
        }
        return (groups ?? [])
            .filter(g => !q || g.name.toLowerCase().includes(q))
            .sort((a, b) => a.name.localeCompare(b.name))
            .slice(0, 25)
    }, [subjectType, users, groups, search])

    return (
        <div className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden">
            {/* Search row + toggle */}
            <div className="flex items-stretch gap-2 p-2">
                {/* Subject toggle */}
                <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
                    {(['user', 'group'] as const).map(t => (
                        <button
                            key={t}
                            onClick={() => { setSubjectType(t); setSearch('') }}
                            className={cn(
                                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors',
                                subjectType === t ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                            )}
                            title={t === 'user' ? 'Pick a user' : 'Pick a group'}
                        >
                            {t === 'user' ? <UserCog className="w-3 h-3" /> : <Users2 className="w-3 h-3" />}
                            {t === 'user' ? 'User' : 'Group'}
                        </button>
                    ))}
                </div>

                {/* Search */}
                <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted" />
                    <input
                        type="text"
                        placeholder={subjectType === 'user' ? 'Add a user…' : 'Add a group…'}
                        value={search}
                        onFocus={() => setOpen(true)}
                        onChange={(e) => { setSearch(e.target.value); setOpen(true) }}
                        className="input pl-8 h-8 text-sm bg-glass-base/40 w-full"
                    />
                </div>

                {/* Role select */}
                <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
                    {GRANT_ROLES.map(({ id, label, icon: Icon }) => (
                        <button
                            key={id}
                            onClick={() => setRole(id)}
                            className={cn(
                                'flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs font-semibold transition-colors',
                                role === id ? 'bg-white dark:bg-white/10 text-ink shadow-sm' : 'text-ink-muted hover:text-ink',
                            )}
                            title={`Grant ${label.toLowerCase()} access`}
                        >
                            <Icon className="w-3 h-3" />
                            {label}
                        </button>
                    ))}
                </div>
            </div>

            {/* Results dropdown */}
            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        className="border-t border-glass-border max-h-56 overflow-y-auto"
                    >
                        {(subjectType === 'user' ? users : groups) === null ? (
                            <div className="p-4 text-center text-ink-muted text-xs">
                                <Loader2 className="w-3.5 h-3.5 animate-spin inline-block mr-1.5" />
                                Loading {subjectType}s…
                            </div>
                        ) : candidates.length === 0 ? (
                            <div className="p-4 text-center text-ink-muted text-xs">
                                {search ? 'No matches.' : `Start typing to find ${subjectType}s.`}
                            </div>
                        ) : (
                            candidates.map(c => {
                                const isUser = subjectType === 'user'
                                const u = isUser ? (c as AdminUserResponse) : null
                                const g = !isUser ? (c as GroupResponse) : null
                                const id = isUser ? u!.id : g!.id
                                const label = isUser ? u!.displayName : g!.name
                                const sub = isUser ? u!.email : (g!.description ?? `${g!.memberCount} member${g!.memberCount === 1 ? '' : 's'}`)
                                return (
                                    <button
                                        key={id}
                                        onClick={async () => {
                                            await onAdd(subjectType, id, role, label)
                                            setSearch('')
                                            setOpen(false)
                                        }}
                                        disabled={disabled}
                                        className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50 border-b last:border-b-0 border-glass-border"
                                    >
                                        {isUser ? (
                                            <div className={cn(
                                                'w-7 h-7 rounded-full bg-gradient-to-br flex items-center justify-center text-[10px] font-bold text-white shrink-0',
                                                avatarGradient(label),
                                            )}>
                                                {initialsOf(label)}
                                            </div>
                                        ) : (
                                            <div className="w-7 h-7 rounded-full bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
                                                <Users2 className="w-3.5 h-3.5" />
                                            </div>
                                        )}
                                        <div className="min-w-0 flex-1">
                                            <p className="text-sm text-ink truncate">{label}</p>
                                            <p className="text-[11px] text-ink-muted truncate">{sub}</p>
                                        </div>
                                        <span className="text-[10px] font-semibold text-ink-muted shrink-0">
                                            Add as {role}
                                        </span>
                                    </button>
                                )
                            })
                        )}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
