/**
 * Invite pickers — the role catalogue, workspace, and group controls.
 *
 * Moved out of AdminUsers.tsx (which was 3300 lines) when the invite flow
 * became a wizard of its own. Every one of these is used only by that
 * flow, so they live with it; keeping them in AdminUsers would also make
 * the import cycle AdminUsers → InviteWizard → AdminUsers.
 *
 * Borders here are `border-black/[0.08] dark:border-white/[0.10]`, not
 * `border-glass-border`: in light mode that token is rgba(255,255,255,.4),
 * a WHITE hairline, and these controls sit on an elevated surface where a
 * white edge is no edge at all.
 */
import { useState, useEffect, useMemo } from 'react'
import {
    CheckCircle2, Search, X, ChevronDown, ChevronLeft, ChevronRight,
    Building2, Users2, Lock, AlertCircle, AtSign,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { type RoleOption } from './roleModel'
import { type WorkspaceResponse } from '@/services/workspaceService'
import { type GroupResponse } from '@/services/groupsService'

export function FieldWithIcon({
    icon: Icon, className, children,
}: {
    icon: typeof AtSign
    className?: string
    children: React.ReactNode
}) {
    return (
        <div className={cn('relative group', className)}>
            <div className="absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-muted group-focus-within:text-accent-lineage transition-colors pointer-events-none">
                <Icon className="w-4 h-4" />
            </div>
            {children}
        </div>
    )
}

export function FieldHint({ children, tone }: { children: React.ReactNode; tone?: 'warn' }) {
    return (
        <p className={cn(
            'text-[11px] mt-1.5 leading-relaxed',
            tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-ink-muted',
        )}>
            {children}
        </p>
    )
}

/** The expiry / seat-cap chip rows. Two copies of this markup had already
 *  drifted apart in padding and hover treatment. */
export function ChipRow<T extends string | number | null>({
    options, value, onChange,
}: {
    options: { value: T; label: string }[]
    value: T
    onChange: (v: T) => void
}) {
    return (
        <div className="flex flex-wrap gap-2">
            {options.map(opt => (
                <button
                    key={String(opt.value)}
                    type="button"
                    onClick={() => onChange(opt.value)}
                    className={cn(
                        'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
                        value === opt.value
                            ? 'border-accent-lineage bg-indigo-500/10 text-accent-lineage'
                            : 'border-black/[0.08] dark:border-white/[0.10] text-ink-secondary hover:border-indigo-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
                    )}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    )
}

export function SectionLabel({ children }: { children: React.ReactNode }) {
    return (
        <p className="text-xs font-semibold uppercase tracking-wider text-ink-muted mb-2">
            {children}
        </p>
    )
}


export function RoleListSkeleton() {
    return (
        <div className="space-y-1.5 mb-4">
            {[0, 1, 2, 3].map(i => (
                <div
                    key={i}
                    className="h-14 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] animate-pulse"
                />
            ))}
        </div>
    )
}


export function RoleGroup({
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
                                    ? 'border-accent-lineage bg-indigo-500/5 shadow-sm'
                                    : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-ink-muted/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
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
                                {/* NOT truncated. These descriptions are how
                                    you tell "read-only across the tenancy"
                                    from "manage every workspace", and the
                                    single-line clamp cut every one of them
                                    mid-sentence — on the privileged roles,
                                    where knowing what you are granting
                                    matters most. The step is full-width now,
                                    so there is room to just say it. */}
                                <p className="text-[11px] text-ink-muted leading-snug mt-0.5">
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


export function WorkspacePicker({
    workspaces, value, onChange,
}: {
    workspaces: WorkspaceResponse[] | null
    value: string
    onChange: (v: string) => void
}) {
    if (workspaces === null) {
        return (
            <div className="h-10 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] animate-pulse" />
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
                                    ? 'border-accent-lineage bg-indigo-500/5 text-accent-lineage'
                                    : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated text-ink hover:border-indigo-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
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
                className="w-full appearance-none bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] rounded-xl pl-10 pr-9 py-2.5 text-sm text-ink focus:outline-none focus:border-indigo-500/40 transition-colors"
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
export function NoRoleCard({
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
                    ? 'border-accent-lineage bg-gradient-to-br from-indigo-500/8 to-indigo-500/0 shadow-sm'
                    : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-ink-muted/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
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
export function GroupsPicker({
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
                        className="h-12 rounded-xl border border-black/[0.08] dark:border-white/[0.10] bg-black/[0.02] dark:bg-white/[0.02] animate-pulse"
                    />
                ))}
            </div>
        )
    }
    if (groups.length === 0) {
        return (
            <div className="flex items-center gap-2 p-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-dashed border-black/[0.08] dark:border-white/[0.10] text-ink-muted text-xs">
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
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold bg-indigo-500/10 text-accent-lineage border border-indigo-500/20 hover:bg-indigo-500/15 transition-colors"
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
                        className="w-full bg-canvas-elevated border border-black/[0.08] dark:border-white/[0.10] rounded-xl pl-9 pr-3 py-2 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:border-indigo-500/40 transition-colors"
                    />
                </div>
            )}

            {/* Page contents — fixed PAGE_SIZE rows so the modal
                doesn't shift height as the user types. */}
            <div className="grid grid-cols-1 gap-1.5">
                {pageItems.length === 0 ? (
                    <div className="flex items-center gap-2 p-3 rounded-xl bg-black/[0.02] dark:bg-white/[0.02] border border-dashed border-black/[0.08] dark:border-white/[0.10] text-ink-muted text-xs">
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
                                        ? 'border-accent-lineage bg-indigo-500/5'
                                        : 'border-black/[0.08] dark:border-white/[0.10] bg-canvas-elevated hover:border-indigo-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
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
                                    ? 'border-black/[0.08] dark:border-white/[0.10] text-ink-muted/40 cursor-not-allowed'
                                    : 'border-black/[0.08] dark:border-white/[0.10] text-ink-secondary hover:text-ink hover:border-indigo-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
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
                                    ? 'border-black/[0.08] dark:border-white/[0.10] text-ink-muted/40 cursor-not-allowed'
                                    : 'border-black/[0.08] dark:border-white/[0.10] text-ink-secondary hover:text-ink hover:border-indigo-500/30 hover:bg-black/[0.02] dark:hover:bg-white/[0.02]',
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
/** Per-address outcome of a bulk invite.
 *
 *  Every created link is shown in full, because there is no second
 *  chance to see it — and "Copy all" exists because pasting twenty
 *  URLs one at a time is the kind of chore that makes people go back
 *  to one shared link. */
