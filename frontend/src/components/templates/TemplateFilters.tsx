/**
 * TemplateFilters — search + scope toggle + sort controls for the gallery.
 *
 * Pure controlled component. Parent owns the URL-synced state via
 * useSearchParams; this component just emits change events.
 */
import { Search, Globe2, Building2, Layers as LayersIcon, ArrowUpDown } from 'lucide-react'
import type { TemplateListFilter } from '@/services/contextModelService'
import { cn } from '@/lib/utils'

interface TemplateFiltersProps {
    filter: TemplateListFilter
    onChange: (next: TemplateListFilter) => void
    categories: string[]
    tags: string[]
    isWorkspaceContext: boolean
}

const SORT_OPTIONS: { value: NonNullable<TemplateListFilter['sort']>; label: string }[] = [
    { value: 'recent', label: 'Recently updated' },
    { value: 'popular', label: 'Most used' },
    { value: 'name', label: 'A → Z' },
]

export function TemplateFilters({
    filter,
    onChange,
    categories,
    tags,
    isWorkspaceContext,
}: TemplateFiltersProps) {
    const scope = filter.scope ?? 'all'

    return (
        <div className="space-y-4">
            {/* Search */}
            <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted pointer-events-none" />
                <input
                    type="text"
                    value={filter.search ?? ''}
                    onChange={(e) => onChange({ ...filter, search: e.target.value || undefined })}
                    placeholder="Search templates"
                    className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink placeholder:text-ink-muted focus:outline-none focus:border-accent-lineage/50 focus:ring-1 focus:ring-accent-lineage/30"
                />
            </div>

            {/* Scope toggle */}
            <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1.5">Scope</h4>
                <div className="flex items-center gap-1 p-1 rounded-lg bg-canvas border border-glass-border">
                    <ScopeButton
                        active={scope === 'all'}
                        onClick={() => onChange({ ...filter, scope: 'all' })}
                        icon={LayersIcon}
                        label="All"
                    />
                    <ScopeButton
                        active={scope === 'global'}
                        onClick={() => onChange({ ...filter, scope: 'global' })}
                        icon={Globe2}
                        label="Global"
                    />
                    <ScopeButton
                        active={scope === 'workspace'}
                        onClick={() => onChange({ ...filter, scope: 'workspace' })}
                        icon={Building2}
                        label="Workspace"
                        disabled={!isWorkspaceContext}
                    />
                </div>
                {!isWorkspaceContext && scope === 'workspace' && (
                    <p className="text-[11px] text-amber-500 mt-1">
                        Select a workspace to see workspace-scoped templates.
                    </p>
                )}
            </div>

            {/* Sort */}
            <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1.5">Sort</h4>
                <div className="relative">
                    <ArrowUpDown className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-muted pointer-events-none" />
                    <select
                        value={filter.sort ?? 'recent'}
                        onChange={(e) => onChange({
                            ...filter,
                            sort: e.target.value as NonNullable<TemplateListFilter['sort']>,
                        })}
                        className="w-full pl-9 pr-3 py-2 text-sm rounded-lg bg-canvas border border-glass-border text-ink focus:outline-none focus:border-accent-lineage/50 appearance-none cursor-pointer"
                    >
                        {SORT_OPTIONS.map(opt => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                        ))}
                    </select>
                </div>
            </div>

            {/* Category */}
            {categories.length > 0 && (
                <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1.5">Category</h4>
                    <div className="flex flex-wrap gap-1.5">
                        <Chip
                            active={!filter.category}
                            onClick={() => onChange({ ...filter, category: undefined })}
                            label="All"
                        />
                        {categories.map(cat => (
                            <Chip
                                key={cat}
                                active={filter.category === cat}
                                onClick={() => onChange({
                                    ...filter,
                                    category: filter.category === cat ? undefined : cat,
                                })}
                                label={cat}
                            />
                        ))}
                    </div>
                </div>
            )}

            {/* Tags */}
            {tags.length > 0 && (
                <div>
                    <h4 className="text-[10px] font-bold uppercase tracking-wider text-ink-muted mb-1.5">Tag</h4>
                    <div className="flex flex-wrap gap-1.5">
                        <Chip
                            active={!filter.tag}
                            onClick={() => onChange({ ...filter, tag: undefined })}
                            label="Any"
                        />
                        {tags.map(tag => (
                            <Chip
                                key={tag}
                                active={filter.tag === tag}
                                onClick={() => onChange({
                                    ...filter,
                                    tag: filter.tag === tag ? undefined : tag,
                                })}
                                label={tag}
                            />
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

function ScopeButton({
    active, onClick, icon: Icon, label, disabled,
}: {
    active: boolean
    onClick: () => void
    icon: React.ComponentType<{ className?: string }>
    label: string
    disabled?: boolean
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={cn(
                'flex-1 inline-flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors',
                active
                    ? 'bg-accent-lineage/10 text-accent-lineage'
                    : 'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                disabled && 'opacity-40 cursor-not-allowed',
            )}
        >
            <Icon className="w-3 h-3" />
            {label}
        </button>
    )
}

function Chip({
    active, onClick, label,
}: {
    active: boolean
    onClick: () => void
    label: string
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className={cn(
                'px-2.5 py-1 rounded-full text-xs font-medium transition-colors',
                active
                    ? 'bg-accent-lineage text-white'
                    : 'glass-panel border border-glass-border text-ink-muted hover:text-ink',
            )}
        >
            {label}
        </button>
    )
}
