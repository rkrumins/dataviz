/**
 * RBACSearchBar — unified search across users / groups / workspaces /
 * roles / permissions (Phase 4.5).
 *
 * Renders an input with a dropdown of grouped results. Mounted at
 * the top of ``AdminPermissions``; on click, the parent receives a
 * ``navigateTo`` event so it can switch the active tab and select
 * the matched entity.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
    Search, Loader2, Users2, Briefcase, Lock, KeyRound, UserCog, X,
} from 'lucide-react'
import {
    rbacSearchService,
    type RBACSearchHit,
    type RBACSearchEntityType,
} from '@/services/rbacSearchService'
import { cn } from '@/lib/utils'


// One row click → one of these targets, surfaced upwards so the
// parent page can route to the right tab.
export type RBACSearchTarget =
    | { kind: 'user'; userId: string }
    | { kind: 'group'; groupId: string }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'role'; roleName: string }
    | { kind: 'permission'; permissionId: string }


function hitToTarget(h: RBACSearchHit): RBACSearchTarget {
    switch (h.type) {
        case 'user':       return { kind: 'user', userId: h.id }
        case 'group':      return { kind: 'group', groupId: h.id }
        case 'workspace':  return { kind: 'workspace', workspaceId: h.id }
        case 'role':       return { kind: 'role', roleName: h.id }
        case 'permission': return { kind: 'permission', permissionId: h.id }
    }
}


const TYPE_VISUAL: Record<RBACSearchEntityType, {
    label: string
    icon: typeof Users2
    pill: string
}> = {
    user: {
        label: 'User',
        icon: UserCog,
        pill: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
    },
    group: {
        label: 'Group',
        icon: Users2,
        pill: 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20',
    },
    workspace: {
        label: 'Workspace',
        icon: Briefcase,
        pill: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20',
    },
    role: {
        label: 'Role',
        icon: KeyRound,
        pill: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20',
    },
    permission: {
        label: 'Permission',
        icon: Lock,
        pill: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20',
    },
}


const ENTITY_ORDER: RBACSearchEntityType[] = [
    'user', 'group', 'workspace', 'role', 'permission',
]


export interface RBACSearchBarProps {
    onNavigate: (target: RBACSearchTarget) => void
    placeholder?: string
}


export function RBACSearchBar({
    onNavigate,
    placeholder = 'Search users, groups, workspaces, roles, permissions…',
}: RBACSearchBarProps) {
    const [query, setQuery] = useState('')
    const [hits, setHits] = useState<RBACSearchHit[] | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [open, setOpen] = useState(false)
    const containerRef = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)

    // Debounced search.
    useEffect(() => {
        const trimmed = query.trim()
        if (trimmed.length === 0) {
            setHits(null)
            setError(null)
            setLoading(false)
            return
        }
        let cancelled = false
        setLoading(true)
        const handle = setTimeout(async () => {
            try {
                const results = await rbacSearchService.search(trimmed)
                if (cancelled) return
                setHits(results)
                setError(null)
            } catch (err) {
                if (cancelled) return
                setError(err instanceof Error ? err.message : 'Search failed')
                setHits([])
            } finally {
                if (!cancelled) setLoading(false)
            }
        }, 220)
        return () => { cancelled = true; clearTimeout(handle) }
    }, [query])

    // Close on outside click.
    useEffect(() => {
        function onClick(e: MouseEvent) {
            if (!containerRef.current) return
            if (!containerRef.current.contains(e.target as Node)) {
                setOpen(false)
            }
        }
        if (open) {
            document.addEventListener('mousedown', onClick)
            return () => document.removeEventListener('mousedown', onClick)
        }
    }, [open])

    // Close on Escape.
    useEffect(() => {
        function onKey(e: KeyboardEvent) {
            if (e.key === 'Escape') {
                setOpen(false)
                inputRef.current?.blur()
            }
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [])

    const grouped = useMemo(() => {
        const out: Record<RBACSearchEntityType, RBACSearchHit[]> = {
            user: [], group: [], workspace: [], role: [], permission: [],
        }
        for (const h of hits ?? []) out[h.type].push(h)
        return out
    }, [hits])

    const totalHits = hits?.length ?? 0
    const showDropdown = open && query.trim().length > 0

    const handleSelect = (h: RBACSearchHit) => {
        onNavigate(hitToTarget(h))
        setOpen(false)
        setQuery('')
    }

    const clear = () => {
        setQuery('')
        setHits(null)
        setError(null)
        inputRef.current?.focus()
    }

    return (
        <div ref={containerRef} className="relative">
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                <input
                    ref={inputRef}
                    type="text"
                    value={query}
                    onChange={e => { setQuery(e.target.value); setOpen(true) }}
                    onFocus={() => setOpen(true)}
                    placeholder={placeholder}
                    className="w-full pl-10 pr-10 py-2.5 rounded-xl bg-canvas-elevated border border-glass-border focus:border-emerald-500/40 focus:ring-1 focus:ring-emerald-500/30 outline-none text-sm placeholder:text-ink-muted transition-colors"
                />
                {query.length > 0 && (
                    <button
                        onClick={clear}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-0.5 rounded text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5"
                        aria-label="Clear search"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            <AnimatePresence>
                {showDropdown && (
                    <motion.div
                        initial={{ opacity: 0, y: -4, scale: 0.99 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -4, scale: 0.99 }}
                        transition={{ duration: 0.14 }}
                        className="absolute z-30 left-0 right-0 mt-2 rounded-xl bg-canvas-elevated border border-glass-border shadow-xl shadow-black/15 dark:shadow-black/40 overflow-hidden max-h-[60vh] flex flex-col"
                    >
                        <div className="px-4 py-2 border-b border-glass-border flex items-center gap-2">
                            <span className="text-[10px] uppercase tracking-wider font-bold text-ink-muted">
                                Results
                            </span>
                            {loading
                                ? <Loader2 className="w-3 h-3 animate-spin text-ink-muted" />
                                : <span className="text-[10px] text-ink-muted">
                                    {totalHits} hit{totalHits === 1 ? '' : 's'}
                                </span>
                            }
                        </div>

                        <div className="flex-1 overflow-y-auto">
                            {error ? (
                                <p className="px-4 py-6 text-xs text-red-600 dark:text-red-400">
                                    {error}
                                </p>
                            ) : hits === null || hits.length === 0 ? (
                                loading ? (
                                    <p className="px-4 py-6 text-xs text-ink-muted">Searching…</p>
                                ) : (
                                    <p className="px-4 py-6 text-xs text-ink-muted">
                                        No matches for <code className="font-mono text-ink">{query.trim()}</code>.
                                    </p>
                                )
                            ) : (
                                ENTITY_ORDER.map(type => {
                                    const list = grouped[type]
                                    if (list.length === 0) return null
                                    const v = TYPE_VISUAL[type]
                                    const Icon = v.icon
                                    return (
                                        <div key={type} className="py-1">
                                            <div className="px-4 py-1.5 flex items-center gap-1.5">
                                                <Icon className="w-3 h-3 text-ink-muted" />
                                                <span className="text-[10px] uppercase tracking-wider font-bold text-ink-muted">
                                                    {v.label}{list.length > 1 ? 's' : ''}
                                                </span>
                                                <span className="text-[10px] text-ink-muted">({list.length})</span>
                                            </div>
                                            {list.map(h => (
                                                <ResultRow
                                                    key={`${h.type}:${h.id}`}
                                                    hit={h}
                                                    onSelect={handleSelect}
                                                />
                                            ))}
                                        </div>
                                    )
                                })
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}


function ResultRow({
    hit, onSelect,
}: {
    hit: RBACSearchHit
    onSelect: (h: RBACSearchHit) => void
}) {
    const v = TYPE_VISUAL[hit.type]
    return (
        <button
            type="button"
            onClick={() => onSelect(hit)}
            className="w-full text-left px-4 py-2 flex items-center gap-3 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
        >
            <span className={cn(
                'inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-bold border shrink-0',
                v.pill,
            )}>
                {v.label.toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
                {hit.type === 'permission' || hit.type === 'role' || hit.type === 'workspace' ? (
                    <code className="text-xs font-mono font-semibold text-ink truncate block">
                        {hit.displayName}
                    </code>
                ) : (
                    <p className="text-sm font-semibold text-ink truncate">{hit.displayName}</p>
                )}
                {hit.secondary && (
                    <p className="text-[11px] text-ink-muted truncate">{hit.secondary}</p>
                )}
            </div>
            {hit.score === 3 && (
                <span className="text-[9px] uppercase tracking-wider font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                    exact
                </span>
            )}
        </button>
    )
}
