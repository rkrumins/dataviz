/**
 * ShareViewDialog - control how a view is shared.
 *
 * Two layers stacked vertically:
 *   1. Visibility tier (private | workspace | enterprise) — broadcast
 *      audience. Saved on every selection. Transitions to/from
 *      enterprise are publish-gated (workspace:view:publish) and the
 *      tiles disable themselves accordingly.
 *   2. Explicit grants — additive shares with named users or groups
 *      at editor or viewer scope. Independent of workspace membership.
 *      Roles are editable in place; the picker searches the signed-in
 *      directory (NOT the admin user listing, which non-admin creators
 *      cannot read — that bug made the picker silently empty).
 *
 * The shareable URL banner sits between the two so users get the
 * "what link can I send?" question answered up front, then refine the
 * audience below.
 *
 * Capability gating comes from the server's access envelope when the
 * host passes it; the fallbacks preserve the pre-envelope behavior
 * (hosts gated the open action themselves; the backend enforces).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import {
    X, Link2, Check, UserPlus, UserCog, Users2,
    Search, Loader2, Eye, Pencil, Trash2, Lock,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Backdrop } from '@/components/ui/Backdrop'
import { updateViewVisibility, type ViewAccess } from '@/services/viewApiService'
import {
    viewGrantsService,
    type ViewGrantResponse,
} from '@/services/viewGrantsService'
import {
    searchDirectory,
    type DirectoryGroup,
    type DirectoryUser,
} from '@/services/userDirectoryService'
import { useToast } from '@/components/ui/toast'
import { usePermission } from '@/store/auth'
import { useBrand } from '@/store/branding'
import { avatarGradient, initialsOf } from '@/lib/avatar'
import { buildViewShareUrl } from '@/lib/viewShareLink'
import {
    VISIBILITY_ACCENT,
    buildVisibilityOptions,
    visibilityDescription,
    type ViewVisibility,
} from '@/lib/viewVisibility'


type GrantRole = 'editor' | 'viewer'
type SubjectType = 'user' | 'group'


interface ShareViewDialogProps {
    viewId: string
    viewName: string
    currentVisibility: ViewVisibility
    /** The view's workspace — powers the publish-permission fallback when
     *  no access envelope is supplied. */
    workspaceId?: string
    /** The caller's capability envelope from GET /views/{id}. */
    access?: ViewAccess | null
    isOpen: boolean
    onClose: () => void
    onVisibilityChange?: (visibility: ViewVisibility) => void
}


const GRANT_ROLES: { id: GrantRole; label: string; icon: typeof Eye }[] = [
    { id: 'viewer', label: 'Viewer', icon: Eye },
    { id: 'editor', label: 'Editor', icon: Pencil },
]


export function ShareViewDialog({
    viewId,
    viewName,
    currentVisibility,
    workspaceId,
    access = null,
    isOpen,
    onClose,
    onVisibilityChange,
}: ShareViewDialogProps) {
    const [visibility, setVisibility] = useState<ViewVisibility>(currentVisibility)
    const [copied, setCopied] = useState(false)
    const [savingVisibility, setSavingVisibility] = useState(false)

    const [grants, setGrants] = useState<ViewGrantResponse[] | null>(null)
    const [busyGrantId, setBusyGrantId] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)

    const { showToast } = useToast()
    const { appName } = useBrand()

    // Envelope wins; fallbacks preserve the pre-envelope behavior (hosts
    // gated the open action; the backend enforces regardless).
    const publishPerm = usePermission('workspace:view:publish', workspaceId)
    const canPublish = access ? access.canPublish : publishPerm
    const canManageGrants = access ? access.canManageGrants : true
    const canChangeVisibility = access ? access.canChangeVisibility : true

    const shareUrl = buildViewShareUrl(viewId)

    const visibilityOptions = useMemo(
        () => buildVisibilityOptions({ current: visibility, canPublish, appName }),
        [visibility, canPublish, appName],
    )


    // ── Initial load: fetch existing grants ─────────────────────────

    const fetchGrants = useCallback(async () => {
        if (!isOpen || !canManageGrants) return
        try {
            const data = await viewGrantsService.list(viewId)
            setGrants(data)
        } catch {
            // The locked state below already explains who can manage
            // sharing; a red error box on top of it helped nobody.
            setGrants([])
        }
    }, [isOpen, viewId, canManageGrants])

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

    const handleVisibilityChange = useCallback(async (newVisibility: ViewVisibility) => {
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
            const message = err instanceof Error ? err.message : 'Failed to update visibility'
            showToast(
                'error',
                message.includes('workspace:view:publish')
                    ? 'Publishing to everyone needs the "Publish views" permission — ask a workspace admin.'
                    : message,
            )
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

    const handleChangeGrantRole = async (grant: ViewGrantResponse, role: GrantRole) => {
        if (grant.role === role) return
        setBusyGrantId(grant.grantId)
        const prev = grants
        // Optimistic: flip the chip immediately, revert on failure.
        setGrants(g => (g ?? []).map(x => x.grantId === grant.grantId ? { ...x, role } : x))
        try {
            const updated = await viewGrantsService.update(viewId, grant.grantId, role)
            setGrants(g => (g ?? []).map(x => x.grantId === grant.grantId ? updated : x))
        } catch (err) {
            setGrants(prev)
            showToast('error', err instanceof Error ? err.message : 'Failed to change role')
        } finally {
            setBusyGrantId(null)
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
        <>
            <Backdrop open={true} onClick={onClose} zClassName="z-[70]" className="bg-black/50" />
            <div className="fixed inset-0 z-[71] flex items-center justify-center p-4 pointer-events-none">
                {/* Mount-only animation — no AnimatePresence/exit on a fixed
                    overlay (the stranded-click-blocker class of freezes). */}
                <motion.div
                    initial={{ scale: 0.95, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    onClick={(e) => e.stopPropagation()}
                    className="pointer-events-auto w-full max-w-xl bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]"
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
                                {visibilityOptions.map(({ id, label, description, icon: Icon, disabled, disabledReason }) => {
                                    const isSelected = visibility === id
                                    const accent = VISIBILITY_ACCENT[id]
                                    const locked = disabled || !canChangeVisibility
                                    return (
                                        <button
                                            key={id}
                                            onClick={() => { if (!locked) void handleVisibilityChange(id) }}
                                            disabled={savingVisibility || locked}
                                            title={disabledReason}
                                            className={cn(
                                                'w-full flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-colors duration-150 text-left',
                                                isSelected
                                                    ? cn(accent.tileBorder, accent.tileBg)
                                                    : 'border-glass-border hover:border-ink-muted/30 bg-canvas-elevated',
                                                locked && !isSelected && 'opacity-50 cursor-not-allowed hover:border-glass-border',
                                            )}
                                        >
                                            <div className={cn(
                                                'w-9 h-9 rounded-lg border flex items-center justify-center shrink-0',
                                                isSelected
                                                    ? cn(accent.chipBg, accent.chipBorder)
                                                    : 'bg-glass-base/40 border-glass-border',
                                            )}>
                                                <Icon className={cn('w-4 h-4', isSelected ? accent.iconText : 'text-ink-muted')} />
                                            </div>
                                            <div className="flex-1 min-w-0">
                                                <span className={cn(
                                                    'text-sm font-semibold block',
                                                    isSelected ? accent.iconText : 'text-ink',
                                                )}>
                                                    {label}
                                                </span>
                                                <span className="text-[11px] text-ink-muted leading-snug">
                                                    {disabled && disabledReason ? disabledReason : description}
                                                </span>
                                            </div>
                                            {isSelected && (
                                                <Check className={cn('w-4 h-4 shrink-0', accent.check)} />
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
                                {canManageGrants && grants && grants.length > 0 && (
                                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold border border-glass-border text-ink-muted bg-glass-base/40">
                                        {grants.length} share{grants.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>

                            {!canManageGrants ? (
                                <div className="rounded-xl border border-dashed border-glass-border bg-glass-base/20 px-4 py-5 text-center">
                                    <Lock className="w-6 h-6 text-ink-muted/60 mx-auto mb-2" />
                                    <p className="text-xs text-ink-muted">
                                        Only the view's owner or a workspace admin can manage sharing.
                                    </p>
                                </div>
                            ) : (
                                <>
                                    {/* Add picker */}
                                    <AddGrantPicker disabled={adding} onAdd={handleAddGrant} />

                                    {/* Existing grants */}
                                    <div className="mt-3">
                                        {grants === null && (
                                            <div className="flex items-center justify-center py-6 text-ink-muted text-sm">
                                                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                                                Loading shares…
                                            </div>
                                        )}
                                        {grants && grants.length === 0 && (
                                            <div className="rounded-xl border border-dashed border-glass-border bg-glass-base/20 px-4 py-5 text-center">
                                                <UserPlus className="w-6 h-6 text-ink-muted/60 mx-auto mb-2" />
                                                <p className="text-xs text-ink-muted">
                                                    No explicit shares yet. Use the picker above to share with specific people or groups.
                                                </p>
                                            </div>
                                        )}
                                        {grants && grants.length > 0 && (
                                            <div className="rounded-xl border border-glass-border bg-glass-base/20 divide-y divide-glass-border">
                                                {grants.map(g => {
                                                    const name = g.subject.displayName ?? g.subject.id
                                                    const isUser = g.subject.type === 'user'
                                                    const isBusy = busyGrantId === g.grantId
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
                                                            {/* Role — editable in place */}
                                                            <div className="flex items-center bg-black/5 dark:bg-white/5 rounded-lg p-0.5 shrink-0">
                                                                {GRANT_ROLES.map(({ id, label, icon: RIcon }) => (
                                                                    <button
                                                                        key={id}
                                                                        onClick={() => void handleChangeGrantRole(g, id)}
                                                                        disabled={isBusy}
                                                                        title={`Make ${label.toLowerCase()}`}
                                                                        className={cn(
                                                                            'flex items-center gap-1 px-2 py-1 rounded-md text-[10px] font-semibold transition-colors disabled:opacity-50',
                                                                            g.role === id
                                                                                ? 'bg-white dark:bg-white/10 text-ink shadow-sm'
                                                                                : 'text-ink-muted hover:text-ink',
                                                                        )}
                                                                    >
                                                                        {isBusy && g.role === id
                                                                            ? <Loader2 className="w-3 h-3 animate-spin" />
                                                                            : <RIcon className="w-3 h-3" />}
                                                                        {label}
                                                                    </button>
                                                                ))}
                                                            </div>
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
                                </>
                            )}
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="px-6 py-3 border-t border-glass-border bg-glass-base/20 shrink-0">
                        <p className="text-[11px] text-ink-muted text-center leading-relaxed">
                            {visibilityDescription(visibility, { appName })}
                            {canManageGrants && grants && grants.length > 0 && (
                                <> Plus <span className="font-semibold text-ink-secondary">{grants.length} explicit share{grants.length !== 1 ? 's' : ''}</span>.</>
                            )}
                        </p>
                    </div>
                </motion.div>
            </div>
        </>
    )
}


// ── Add-grant picker (subject-type toggle + directory search + role) ──

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
    const [users, setUsers] = useState<DirectoryUser[] | null>(null)
    const [groups, setGroups] = useState<DirectoryGroup[] | null>(null)
    const [role, setRole] = useState<GrantRole>('viewer')
    const [open, setOpen] = useState(false)

    // Debounced directory search — the signed-in endpoint, so creators
    // without admin rights get a working picker.
    useEffect(() => {
        if (!open) return
        let cancelled = false
        const timer = setTimeout(async () => {
            try {
                const result = await searchDirectory(search.trim(), {
                    types: [subjectType], limit: 25,
                })
                if (cancelled) return
                if (subjectType === 'user') setUsers(result.users)
                else setGroups(result.groups)
            } catch {
                /* errors surface via toast in onAdd */
            }
        }, 200)
        return () => { cancelled = true; clearTimeout(timer) }
    }, [open, subjectType, search])

    const candidates = useMemo(
        () => (subjectType === 'user' ? users : groups) ?? [],
        [subjectType, users, groups],
    )
    const loading = (subjectType === 'user' ? users : groups) === null

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

            {/* Results */}
            {open && (
                <div className="border-t border-glass-border max-h-56 overflow-y-auto">
                    {loading ? (
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
                            const u = isUser ? (c as DirectoryUser) : null
                            const g = !isUser ? (c as DirectoryGroup) : null
                            const id = isUser ? u!.id : g!.id
                            const label = isUser ? u!.displayName : g!.name
                            const sub = isUser
                                ? u!.email
                                : `${g!.memberCount} member${g!.memberCount === 1 ? '' : 's'}`
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
                </div>
            )}
        </div>
    )
}
