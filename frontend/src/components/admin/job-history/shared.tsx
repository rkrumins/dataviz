/**
 * shared.tsx — Shared helpers, constants, and reusable components for the
 * job-history views.  Extracted from RegistryJobHistory.tsx so that both the
 * global (registry) and per-workspace history pages can reuse them.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    CheckCircle2, AlertCircle, Loader2, Clock, XCircle,
    Search, X, ChevronDown, Check,
    Settings, Zap, Calendar, Activity, Trash2,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { ProviderResponse } from '@/services/providerService'
import type { CatalogItemResponse } from '@/services/catalogService'
import type { JobHistoryFilters } from '@/services/aggregationService'

// ── DataSourceMeta ──────────────────────────────────────────────────

export interface DataSourceMeta {
    label: string
    workspaceId: string
    workspaceName: string
    providerId: string
    providerName: string
    providerType: string
    graphName: string
    projectionMode: string
    ontologyId?: string
}

// ── buildDataSourceLookup ───────────────────────────────────────────

export function buildDataSourceLookup(
    workspaces: WorkspaceResponse[],
    providers: ProviderResponse[],
    catalogItems: CatalogItemResponse[],
): Map<string, DataSourceMeta> {
    const providerMap = new Map(providers.map(p => [p.id, p]))
    const catalogMap = new Map(catalogItems.map(c => [c.id, c]))
    const lookup = new Map<string, DataSourceMeta>()

    for (const ws of workspaces) {
        for (const ds of ws.dataSources ?? []) {
            const catalogItem = catalogMap.get(ds.catalogItemId)
            const providerId = catalogItem?.providerId ?? ws.providerId ?? ''
            const provider = providerMap.get(providerId)

            lookup.set(ds.id, {
                label: ds.label || catalogItem?.name || ds.id,
                workspaceId: ws.id,
                workspaceName: ws.name,
                providerId,
                providerName: provider?.name ?? providerId,
                providerType: provider?.providerType ?? 'unknown',
                graphName: ws.graphName ?? '',
                projectionMode: ds.projectionMode ?? 'in_source',
                ontologyId: ds.ontologyId,
            })
        }
    }
    return lookup
}

// ── Helper functions ────────────────────────────────────────────────

export function formatDuration(seconds: number | null | undefined): string {
    if (!seconds) return '\u2014'
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) {
        const m = Math.floor(seconds / 60)
        const s = Math.round(seconds % 60)
        return s > 0 ? `${m}m ${s}s` : `${m}m`
    }
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
}

export function timeAgo(iso: string | undefined): string {
    if (!iso) return '\u2014'
    const diff = (Date.now() - new Date(iso).getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
}

export function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
    useEffect(() => {
        function handler(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [ref, onClose])
}

// ── STATUS_CONFIG ───────────────────────────────────────────────────

export const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; bg: string; label: string }> = {
    completed: { icon: CheckCircle2, color: 'text-emerald-500', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Completed' },
    failed:    { icon: AlertCircle,  color: 'text-red-500',     bg: 'bg-red-500/10 border-red-500/20',         label: 'Failed' },
    running:   { icon: Loader2,      color: 'text-indigo-500',  bg: 'bg-indigo-500/10 border-indigo-500/20',   label: 'Running' },
    pending:   { icon: Clock,        color: 'text-amber-500',   bg: 'bg-amber-500/10 border-amber-500/20',     label: 'Pending' },
    cancelled: { icon: XCircle,      color: 'text-zinc-400',    bg: 'bg-zinc-500/10 border-zinc-500/20',       label: 'Cancelled' },
}

// ── Constants ───────────────────────────────────────────────────────

export const ALL_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const

export const TRIGGER_SOURCES = [
    { key: 'manual', label: 'Manual', icon: Settings },
    { key: 'onboarding', label: 'Onboarding', icon: Zap },
    { key: 'schedule', label: 'Schedule', icon: Calendar },
    { key: 'drift', label: 'Drift', icon: Activity },
    { key: 'purge', label: 'Purge', icon: Trash2 },
] as const

export const MODE_OPTIONS = [
    { key: 'in_source', label: 'In-Source' },
    { key: 'dedicated', label: 'Dedicated' },
] as const

export const PAGE_SIZE = 25

export const DATE_PRESETS = [
    { label: 'Today', getValue: () => { const d = new Date().toISOString().slice(0, 10); return { from: d, to: d } } },
    { label: 'Last 7 days', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 7); return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } } },
    { label: 'Last 30 days', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 30); return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } } },
    { label: 'Last 90 days', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 90); return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } } },
] as const

// ── URL / filter sync helpers ───────────────────────────────────────

export function filtersToParams(f: JobHistoryFilters): URLSearchParams {
    const p = new URLSearchParams()
    if (f.status?.length) f.status.forEach(s => p.append('status', s))
    if (f.workspaceId) p.set('workspaceId', f.workspaceId)
    if (f.dataSourceId?.length) f.dataSourceId.forEach(id => p.append('dataSourceId', id))
    if (f.projectionMode) p.set('projectionMode', f.projectionMode)
    if (f.triggerSource) p.set('triggerSource', f.triggerSource)
    if (f.dateFrom) p.set('dateFrom', f.dateFrom)
    if (f.dateTo) p.set('dateTo', f.dateTo)
    if (f.search) p.set('search', f.search)
    if (f.offset && f.offset > 0) p.set('offset', String(f.offset))
    return p
}

export function paramsToFilters(p: URLSearchParams): JobHistoryFilters {
    const status = p.getAll('status')
    const dsIds = p.getAll('dataSourceId')
    return {
        status: status.length > 0 ? status : undefined,
        workspaceId: p.get('workspaceId') ?? undefined,
        dataSourceId: dsIds.length > 0 ? dsIds : undefined,
        projectionMode: p.get('projectionMode') ?? undefined,
        triggerSource: p.get('triggerSource') ?? undefined,
        dateFrom: p.get('dateFrom') ?? undefined,
        dateTo: p.get('dateTo') ?? undefined,
        search: p.get('search') ?? undefined,
        offset: p.has('offset') ? Number(p.get('offset')) : 0,
        limit: PAGE_SIZE,
    }
}

// ── DropdownOption ──────────────────────────────────────────────────

export interface DropdownOption {
    id: string
    label: string
    sublabel?: string
}

// ── SearchableDropdown ──────────────────────────────────────────────

export function SearchableDropdown({
    icon: Icon,
    label,
    options,
    selected,
    onSelect,
    activeColor = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    multi = false,
}: {
    icon: typeof Search
    label: string
    options: DropdownOption[]
    selected: string[]
    onSelect: (ids: string[]) => void
    activeColor?: string
    multi?: boolean
}) {
    const [open, setOpen] = useState(false)
    const [query, setQuery] = useState('')
    const ref = useRef<HTMLDivElement>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    useClickOutside(ref, useCallback(() => { setOpen(false); setQuery('') }, []))

    const filtered = useMemo(() => {
        if (!query) return options
        const q = query.toLowerCase()
        return options.filter(o =>
            o.label.toLowerCase().includes(q) ||
            (o.sublabel?.toLowerCase().includes(q))
        )
    }, [options, query])

    const hasSelection = selected.length > 0
    const displayLabel = hasSelection
        ? selected.length === 1
            ? (options.find(o => o.id === selected[0])?.label ?? label)
            : `${selected.length} selected`
        : label

    function toggle(id: string) {
        if (multi) {
            onSelect(
                selected.includes(id)
                    ? selected.filter(s => s !== id)
                    : [...selected, id]
            )
        } else {
            onSelect(selected.includes(id) ? [] : [id])
            setOpen(false)
            setQuery('')
        }
    }

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => { setOpen(p => !p); if (!open) setTimeout(() => inputRef.current?.focus(), 50) }}
                className={cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                    hasSelection
                        ? activeColor
                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                )}
            >
                <Icon className="h-3.5 w-3.5" />
                <span className="max-w-[120px] truncate">{displayLabel}</span>
                <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-180')} />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className="absolute left-0 top-full z-50 mt-1.5 w-64 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden"
                    >
                        {/* Search input */}
                        <div className="px-2.5 pt-2.5 pb-1.5">
                            <div className="flex items-center gap-2 rounded-lg bg-black/[0.04] dark:bg-white/[0.04] px-2.5 py-1.5">
                                <Search className="w-3.5 h-3.5 text-ink-muted flex-shrink-0" />
                                <input
                                    ref={inputRef}
                                    type="text"
                                    value={query}
                                    onChange={e => setQuery(e.target.value)}
                                    placeholder={`Search ${label.toLowerCase()}...`}
                                    className="flex-1 bg-transparent text-xs text-ink placeholder-ink-muted/60 outline-none"
                                />
                                {query && (
                                    <button onClick={() => setQuery('')} className="p-0.5 rounded hover:bg-black/5 dark:hover:bg-white/5">
                                        <X className="w-3 h-3 text-ink-muted" />
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* Options */}
                        <div className="max-h-52 overflow-y-auto p-1">
                            {!multi && (
                                <button
                                    onClick={() => { onSelect([]); setOpen(false); setQuery('') }}
                                    className={cn(
                                        'w-full rounded-lg px-3 py-2 text-left text-xs transition-colors duration-150',
                                        !hasSelection ? 'text-indigo-600 dark:text-indigo-400 font-medium' : 'text-ink-muted hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                                    )}
                                >
                                    All {label}
                                </button>
                            )}
                            {filtered.length === 0 && (
                                <p className="px-3 py-3 text-xs text-ink-muted text-center">No results for &quot;{query}&quot;</p>
                            )}
                            {filtered.map(opt => {
                                const checked = selected.includes(opt.id)
                                return (
                                    <button
                                        key={opt.id}
                                        onClick={() => toggle(opt.id)}
                                        className={cn(
                                            'w-full flex items-center gap-2.5 rounded-lg px-3 py-2 text-xs transition-colors duration-150',
                                            checked
                                                ? 'bg-indigo-500/8 text-indigo-600 dark:text-indigo-400'
                                                : 'text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                                        )}
                                    >
                                        {multi && (
                                            <span className={cn(
                                                'w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors duration-150',
                                                checked ? 'bg-indigo-500 border-indigo-500 text-white' : 'border-glass-border',
                                            )}>
                                                {checked && <Check className="h-3 w-3" />}
                                            </span>
                                        )}
                                        <div className="flex-1 text-left min-w-0">
                                            <span className="font-medium truncate block">{opt.label}</span>
                                            {opt.sublabel && (
                                                <span className="text-[10px] text-ink-muted block truncate">{opt.sublabel}</span>
                                            )}
                                        </div>
                                        {!multi && checked && <Check className="h-3.5 w-3.5 ml-auto flex-shrink-0" />}
                                    </button>
                                )
                            })}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}

// ── DateRangePicker ─────────────────────────────────────────────────

export function DateRangePicker({
    dateFrom,
    dateTo,
    onChange,
}: {
    dateFrom?: string
    dateTo?: string
    onChange: (from?: string, to?: string) => void
}) {
    const [open, setOpen] = useState(false)
    const ref = useRef<HTMLDivElement>(null)
    useClickOutside(ref, useCallback(() => setOpen(false), []))

    const hasDate = !!(dateFrom || dateTo)
    const displayLabel = hasDate
        ? dateFrom && dateTo
            ? dateFrom === dateTo ? dateFrom : `${dateFrom} \u2013 ${dateTo}`
            : dateFrom ? `From ${dateFrom}` : `To ${dateTo}`
        : 'Date Range'

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(p => !p)}
                className={cn(
                    'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors duration-150',
                    hasDate
                        ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                )}
            >
                <Calendar className="h-3.5 w-3.5" />
                <span className="max-w-[160px] truncate">{displayLabel}</span>
                <ChevronDown className={cn('h-3 w-3 transition-transform duration-150', open && 'rotate-180')} />
            </button>

            <AnimatePresence>
                {open && (
                    <motion.div
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className="absolute left-0 top-full z-50 mt-1.5 w-72 bg-canvas border border-glass-border rounded-xl shadow-xl overflow-hidden"
                    >
                        {/* Quick presets */}
                        <div className="p-2 border-b border-glass-border/50">
                            <div className="flex flex-wrap gap-1">
                                {DATE_PRESETS.map(preset => {
                                    const v = preset.getValue()
                                    const active = dateFrom === v.from && dateTo === v.to
                                    return (
                                        <button
                                            key={preset.label}
                                            onClick={() => { onChange(v.from, v.to); setOpen(false) }}
                                            className={cn(
                                                'px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors duration-150',
                                                active
                                                    ? 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400'
                                                    : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                                            )}
                                        >
                                            {preset.label}
                                        </button>
                                    )
                                })}
                            </div>
                        </div>

                        {/* Custom range */}
                        <div className="p-3 space-y-2.5">
                            <div>
                                <label className="block text-[10px] text-ink-muted uppercase tracking-wider font-bold mb-1">From</label>
                                <input
                                    type="date"
                                    value={dateFrom ?? ''}
                                    onChange={e => onChange(e.target.value || undefined, dateTo)}
                                    className="w-full h-8 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.04] border border-glass-border text-xs text-ink focus:outline-none focus:ring-1 focus:ring-cyan-500/40 transition-colors"
                                />
                            </div>
                            <div>
                                <label className="block text-[10px] text-ink-muted uppercase tracking-wider font-bold mb-1">To</label>
                                <input
                                    type="date"
                                    value={dateTo ?? ''}
                                    onChange={e => onChange(dateFrom, e.target.value || undefined)}
                                    className="w-full h-8 px-2.5 rounded-lg bg-black/[0.04] dark:bg-white/[0.04] border border-glass-border text-xs text-ink focus:outline-none focus:ring-1 focus:ring-cyan-500/40 transition-colors"
                                />
                            </div>
                            {hasDate && (
                                <button
                                    onClick={() => { onChange(undefined, undefined); setOpen(false) }}
                                    className="w-full text-center text-[11px] text-ink-muted hover:text-ink transition-colors py-1"
                                >
                                    Clear dates
                                </button>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    )
}
