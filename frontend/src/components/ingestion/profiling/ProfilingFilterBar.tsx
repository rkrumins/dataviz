/**
 * The board's controls.
 *
 * Rebuilt around one idea: these are three different KINDS of control and were
 * being drawn as one undifferentiated row. A time range, a measure, and a set
 * of filters answer different questions, and running them together as eight
 * identical pills makes the reader parse the whole row to find the one thing
 * they came to change.
 *
 * So: range and measure lead, as segmented groups in the Analytics idiom —
 * gradient on the active preset, hairline between sets. Then a rule, then the
 * filters, which are the part you reach for repeatedly. Then the surface-level
 * affordances pushed right, where nothing competes with them.
 */
import { Download, Search, Settings2, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { getProviderLogo } from '@/components/admin/ProviderLogos'
import { PROFILING_WINDOWS, type ProfilingWindowKey } from '@/hooks/useProfiling'
import type { BoardRow } from '@/types/profiling'
import { FilterMenu, type FilterOption } from './FilterMenu'
import { UtcChip } from './UtcChip'

const MEASURES = [
    { key: 'nodes' as const, label: 'Entities' },
    { key: 'edges' as const, label: 'Relationships' },
]

export interface FilterState {
    window: ProfilingWindowKey
    metric: 'nodes' | 'edges'
    unusualOnly: boolean
    providerId: string
    workspaceId: string
    search: string
}

interface Props extends FilterState {
    rows: BoardRow[]
    /** Hidden when the board is already scoped to one workspace. */
    showWorkspaceFilter: boolean
    onWindow: (next: ProfilingWindowKey) => void
    onMetric: (next: 'nodes' | 'edges') => void
    onUnusualOnly: (next: boolean) => void
    onProvider: (next: string) => void
    onWorkspace: (next: string) => void
    onSearch: (next: string) => void
    onOpenSettings: () => void
    exportHref: string
}

/** Options built from what is actually on the board, so a filter can never
 *  offer a choice that returns nothing. */
function facet(
    rows: BoardRow[],
    id: (r: BoardRow) => string | null,
    name: (r: BoardRow) => string | null,
    glyph?: (r: BoardRow) => React.ComponentType<{ className?: string }> | undefined,
): FilterOption[] {
    const seen = new Map<string, FilterOption>()
    rows.forEach((row) => {
        const key = id(row)
        if (!key) return
        const existing = seen.get(key)
        if (existing) existing.count = (existing.count ?? 0) + 1
        else seen.set(key, {
            key, label: name(row) || key, count: 1, glyph: glyph?.(row),
        })
    })
    return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label))
}

export function ProfilingFilterBar({
    rows, window, metric, unusualOnly, providerId, workspaceId, search,
    showWorkspaceFilter, onWindow, onMetric, onUnusualOnly, onProvider,
    onWorkspace, onSearch, onOpenSettings, exportHref,
}: Props) {
    const providers = facet(
        rows,
        (r) => r.provider_id,
        (r) => r.provider_name,
        (r) => (r.provider_type ? getProviderLogo(r.provider_type) : undefined),
    )
    const workspaces = facet(rows, (r) => r.workspace_id, (r) => r.workspace_name)
    const filtered = Boolean(search || providerId || workspaceId || unusualOnly)

    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {/* Range and measure: what the board is OF. */}
            <div
                role="group"
                aria-label="Time window"
                className="inline-flex items-center rounded-xl border border-glass-border bg-canvas-elevated p-1 shadow-sm"
            >
                {PROFILING_WINDOWS.map((w) => (
                    <button
                        key={w.key}
                        type="button"
                        aria-pressed={window === w.key}
                        onClick={() => onWindow(w.key)}
                        className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
                            'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                            window === w.key
                                ? 'bg-gradient-to-r from-indigo-500 to-violet-600 text-white shadow-sm'
                                : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                    >
                        {w.label}
                    </button>
                ))}

                {/* Hairline, so the measure reads as a second question about the
                    same range rather than a fifth range. */}
                <span className="mx-1 h-5 w-px bg-glass-border" aria-hidden />

                {MEASURES.map((m) => (
                    <button
                        key={m.key}
                        type="button"
                        aria-pressed={metric === m.key}
                        onClick={() => onMetric(m.key)}
                        className={cn(
                            'px-3 py-1.5 rounded-lg text-xs font-semibold transition-all whitespace-nowrap',
                            'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                            metric === m.key
                                ? 'bg-canvas text-ink shadow-sm ring-1 ring-glass-border'
                                : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                        )}
                    >
                        {m.label}
                    </button>
                ))}
            </div>

            <span className="hidden lg:block h-6 w-px bg-glass-border" aria-hidden />

            {/* Filters: which rows survive. */}
            <div className="relative">
                <Search
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted"
                    aria-hidden
                />
                <input
                    type="search"
                    value={search}
                    onChange={(e) => onSearch(e.target.value)}
                    placeholder="Search sources"
                    aria-label="Search sources by name or provider"
                    className={cn(
                        'w-44 sm:w-56 rounded-xl border border-glass-border bg-canvas-elevated shadow-sm',
                        'pl-8 pr-7 py-1.5 text-xs text-ink placeholder:text-ink-muted',
                        'focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/40',
                        '[&::-webkit-search-cancel-button]:appearance-none',
                    )}
                />
                {search && (
                    <button
                        type="button"
                        onClick={() => onSearch('')}
                        aria-label="Clear search"
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink"
                    >
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {providers.length > 1 && (
                <FilterMenu
                    label="Filter by provider" allLabel="All providers"
                    value={providerId} onChange={onProvider} options={providers}
                />
            )}
            {showWorkspaceFilter && workspaces.length > 1 && (
                <FilterMenu
                    label="Filter by workspace" allLabel="All workspaces"
                    value={workspaceId} onChange={onWorkspace} options={workspaces}
                />
            )}

            <button
                type="button"
                aria-pressed={unusualOnly}
                onClick={() => onUnusualOnly(!unusualOnly)}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-xl border px-2.5 py-1.5',
                    'text-xs font-semibold transition-colors whitespace-nowrap',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                    unusualOnly
                        ? 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        : 'border-glass-border bg-canvas-elevated text-ink-muted hover:text-ink',
                )}
            >
                <span
                    aria-hidden
                    className={cn(
                        'w-1.5 h-1.5 rounded-full',
                        unusualOnly ? 'bg-amber-500' : 'bg-ink-muted/40',
                    )}
                />
                Unusual only
            </button>

            {filtered && (
                <button
                    type="button"
                    onClick={() => {
                        onSearch(''); onProvider(''); onWorkspace(''); onUnusualOnly(false)
                    }}
                    className="text-xs font-semibold text-ink-muted hover:text-ink"
                >
                    Clear
                </button>
            )}

            {/* Surface affordances, pushed right so nothing competes with them. */}
            <div className="ml-auto flex items-center gap-2">
                <UtcChip />
                <a
                    href={exportHref}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-xl border border-glass-border',
                        'bg-canvas-elevated shadow-sm px-2.5 py-1.5 text-xs font-semibold',
                        'text-ink-muted hover:text-ink transition-colors',
                    )}
                >
                    <Download className="w-3.5 h-3.5" aria-hidden /> Export
                </a>
                <button
                    type="button"
                    onClick={onOpenSettings}
                    className={cn(
                        'inline-flex items-center gap-1.5 rounded-xl border border-glass-border',
                        'bg-canvas-elevated shadow-sm px-2.5 py-1.5 text-xs font-semibold',
                        'text-ink-muted hover:text-ink transition-colors',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                    )}
                >
                    <Settings2 className="w-3.5 h-3.5" aria-hidden /> Retention
                </button>
            </div>
        </div>
    )
}
