import { memo } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Search, X, Users, Database, Zap, Settings,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { JobHistoryFilters } from '@/services/aggregationService'
import {
    STATUS_CONFIG, ALL_STATUSES, TRIGGER_SOURCES, MODE_OPTIONS,
    SearchableDropdown, DateRangePicker, type DropdownOption,
} from './shared'

interface JobHistoryFilterBarProps {
    filters: JobHistoryFilters
    searchInput: string
    onSearchInput: (value: string) => void
    updateFilter: (patch: Partial<JobHistoryFilters>) => void
    toggleStatusFilter: (s: string) => void
    clearFilters: () => void
    workspaceOptions: DropdownOption[]
    dataSourceOptions: DropdownOption[]
    activeChips: { key: string; label: string }[]
    removeChip: (key: string) => void
}

export const JobHistoryFilterBar = memo(function JobHistoryFilterBar({
    filters,
    searchInput,
    onSearchInput,
    updateFilter,
    toggleStatusFilter,
    clearFilters,
    workspaceOptions,
    dataSourceOptions,
    activeChips,
    removeChip,
}: JobHistoryFilterBarProps) {
    return (
        <>
            {/* Search Box */}
            <div className="relative">
                <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                    type="text"
                    placeholder="Search by job ID, data source, workspace, or error message..."
                    value={searchInput}
                    onChange={e => onSearchInput(e.target.value)}
                    className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-canvas-elevated border border-glass-border focus:ring-2 focus:ring-indigo-500/50 outline-none text-sm text-ink placeholder:text-ink-muted"
                />
                {searchInput && (
                    <button onClick={() => { onSearchInput(''); updateFilter({ search: undefined }) }} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* Filter bar */}
            <div className="space-y-2">
                <div className="flex items-center gap-1 flex-wrap">
                    {/* Status chips inline */}
                    {ALL_STATUSES.map(s => {
                        const active = filters.status?.includes(s)
                        const cfg = STATUS_CONFIG[s]
                        const Icon = cfg.icon
                        return (
                            <button
                                key={s}
                                onClick={() => toggleStatusFilter(s)}
                                className={cn(
                                    'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors duration-150',
                                    active
                                        ? cfg.bg + ' ' + cfg.color
                                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                                )}
                            >
                                <Icon className={cn('h-3.5 w-3.5', s === 'running' && active && 'animate-spin')} />
                                {cfg.label}
                            </button>
                        )
                    })}

                    <div className="w-px h-5 bg-glass-border mx-1" />

                    <SearchableDropdown
                        icon={Users}
                        label="Workspace"
                        options={workspaceOptions}
                        selected={filters.workspaceId ? [filters.workspaceId] : []}
                        onSelect={ids => updateFilter({ workspaceId: ids[0] ?? undefined, dataSourceId: undefined })}
                    />

                    <SearchableDropdown
                        icon={Database}
                        label="Data Source"
                        options={dataSourceOptions}
                        selected={filters.dataSourceId ?? []}
                        onSelect={ids => updateFilter({ dataSourceId: ids.length > 0 ? ids : undefined })}
                        activeColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    />

                    <SearchableDropdown
                        icon={Zap}
                        label="Trigger"
                        options={TRIGGER_SOURCES.map(t => ({ id: t.key, label: t.label }))}
                        selected={filters.triggerSource ? [filters.triggerSource] : []}
                        onSelect={ids => updateFilter({ triggerSource: ids[0] ?? undefined })}
                        activeColor="bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    />

                    <SearchableDropdown
                        icon={Settings}
                        label="Mode"
                        options={MODE_OPTIONS.map(m => ({ id: m.key, label: m.label }))}
                        selected={filters.projectionMode ? [filters.projectionMode] : []}
                        onSelect={ids => updateFilter({ projectionMode: ids[0] ?? undefined })}
                        activeColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
                    />

                    <div className="w-px h-5 bg-glass-border mx-1" />

                    <DateRangePicker
                        dateFrom={filters.dateFrom}
                        dateTo={filters.dateTo}
                        onChange={(from, to) => updateFilter({ dateFrom: from, dateTo: to })}
                    />
                </div>

                {/* Active filter chips */}
                <AnimatePresence>
                    {activeChips.length > 0 && (
                        <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="flex flex-wrap items-center gap-1.5 overflow-hidden"
                        >
                            {activeChips.map(chip => (
                                <span
                                    key={chip.key}
                                    className="inline-flex items-center gap-1 rounded-full bg-black/[0.05] dark:bg-white/[0.08] px-2.5 py-1 text-[11px] font-medium text-ink-muted"
                                >
                                    {chip.label}
                                    <button
                                        onClick={() => removeChip(chip.key)}
                                        className="rounded-full p-0.5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors duration-150"
                                    >
                                        <X className="h-2.5 w-2.5" />
                                    </button>
                                </span>
                            ))}
                            <button
                                onClick={clearFilters}
                                className="text-[11px] font-medium text-ink-muted hover:text-ink transition-colors duration-150 underline underline-offset-2"
                            >
                                Clear all
                            </button>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </>
    )
})
