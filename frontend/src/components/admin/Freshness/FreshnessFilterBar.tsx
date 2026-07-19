/**
 * FreshnessFilterBar — the sticky triage controls: a status segmented control
 * (mirroring the stat tiles), Provider and Workspace multi-selects, a debounced
 * name search, and removable active-filter chips with Clear all.
 *
 * Fully controlled: every facet lives in the URL (the parent owns the search
 * params), so this component only renders state and dispatches changes. The
 * status segment and the stat-band tiles drive the same ``status`` facet — the
 * segment exposes the four common states; the tiles add the rest.
 */
import { Server, Layers, Search, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { FilterDropdown, type FilterOption } from '@/components/explorer/FilterDropdown'
import type { StatusFacet } from './freshnessTriage'

/** The four states the segmented control exposes (the tiles cover pending /
 *  cache coverage). ``''`` = All. */
const SEGMENTS: { key: StatusFacet; label: string }[] = [
    { key: '', label: 'All' },
    { key: 'needsAttention', label: 'Needs attention' },
    { key: 'ready', label: 'Ready' },
    { key: 'notBuilt', label: 'Not built' },
]

/** Human labels for every facet, for the active-filter chip. */
const FACET_LABEL: Record<Exclude<StatusFacet, ''>, string> = {
    ready: 'Ready',
    pending: 'Rebuilding now',
    needsAttention: 'Needs attention',
    notBuilt: 'Not built',
    cacheStamped: 'Cache coverage',
}

interface Props {
    providerOptions: FilterOption[]
    selectedProviders: string[]
    onProvidersChange: (ids: string[]) => void
    workspaceOptions: FilterOption[]
    selectedWorkspaces: string[]
    onWorkspacesChange: (ids: string[]) => void
    status: StatusFacet
    onStatusChange: (s: StatusFacet) => void
    search: string
    onSearchChange: (v: string) => void
    onClearAll: () => void
}

function Chip({ label, onRemove }: { label: string; onRemove: () => void }) {
    return (
        <span className="inline-flex items-center gap-1 h-6 pl-2 pr-1 rounded-full border border-glass-border bg-glass-base/40 text-[11px] text-ink-secondary">
            {label}
            <button
                type="button"
                onClick={onRemove}
                aria-label={`Remove filter ${label}`}
                className="rounded-full p-0.5 text-ink-muted hover:text-ink hover:bg-black/[0.06] dark:hover:bg-white/[0.08] transition-colors"
            >
                <X className="w-3 h-3" />
            </button>
        </span>
    )
}

export function FreshnessFilterBar({
    providerOptions, selectedProviders, onProvidersChange,
    workspaceOptions, selectedWorkspaces, onWorkspacesChange,
    status, onStatusChange, search, onSearchChange, onClearAll,
}: Props) {
    const providerLabel = (id: string) => providerOptions.find(o => o.id === id)?.label ?? id
    const workspaceLabel = (id: string) => workspaceOptions.find(o => o.id === id)?.label ?? id

    const hasFilters = selectedProviders.length > 0 || selectedWorkspaces.length > 0 || status !== '' || search.trim() !== ''

    return (
        <div className="space-y-2.5">
            <div className="flex flex-wrap items-center gap-2">
                {/* Status segmented control — mirrors the tiles */}
                <div role="group" aria-label="Filter by status" className="inline-flex items-center rounded-lg border border-glass-border p-0.5">
                    {SEGMENTS.map(({ key, label }) => {
                        const active = status === key
                        return (
                            <button
                                key={key || 'all'}
                                type="button"
                                aria-pressed={active}
                                onClick={() => onStatusChange(key)}
                                className={cn(
                                    'h-7 px-2.5 rounded-md text-xs font-semibold transition-colors outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                    active
                                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                                )}
                            >
                                {label}
                            </button>
                        )
                    })}
                </div>

                <FilterDropdown
                    icon={Server}
                    label="Provider"
                    accent="indigo"
                    options={providerOptions}
                    selectedIds={selectedProviders}
                    onChange={onProvidersChange}
                    searchPlaceholder="Search providers..."
                    emptyMessage="No providers"
                />
                <FilterDropdown
                    icon={Layers}
                    label="Workspace"
                    accent="violet"
                    options={workspaceOptions}
                    selectedIds={selectedWorkspaces}
                    onChange={onWorkspacesChange}
                    searchPlaceholder="Search workspaces..."
                    emptyMessage="No workspaces"
                />

                <div className="relative ml-auto">
                    <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted/60 pointer-events-none" />
                    <input
                        type="text"
                        aria-label="Search sources by name"
                        value={search}
                        onChange={(e) => onSearchChange(e.target.value)}
                        onKeyDown={(e) => e.stopPropagation()}
                        placeholder="Search sources…"
                        className="h-8 w-44 rounded-lg border border-glass-border bg-canvas pl-8 pr-2 text-xs text-ink outline-none placeholder:text-ink-muted/50 focus-visible:ring-2 focus-visible:ring-indigo-500/50"
                    />
                </div>
            </div>

            {/* Active-filter chips */}
            {hasFilters && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {status !== '' && (
                        <Chip label={`Status: ${FACET_LABEL[status]}`} onRemove={() => onStatusChange('')} />
                    )}
                    {selectedProviders.map(id => (
                        <Chip key={`p-${id}`} label={`Provider: ${providerLabel(id)}`}
                            onRemove={() => onProvidersChange(selectedProviders.filter(x => x !== id))} />
                    ))}
                    {selectedWorkspaces.map(id => (
                        <Chip key={`w-${id}`} label={`Workspace: ${workspaceLabel(id)}`}
                            onRemove={() => onWorkspacesChange(selectedWorkspaces.filter(x => x !== id))} />
                    ))}
                    {search.trim() !== '' && (
                        <Chip label={`Search: “${search.trim()}”`} onRemove={() => onSearchChange('')} />
                    )}
                    <button
                        type="button"
                        onClick={onClearAll}
                        className="ml-1 text-[11px] font-semibold text-ink-muted hover:text-ink transition-colors"
                    >
                        Clear all
                    </button>
                </div>
            )}
        </div>
    )
}
