/**
 * RegistryJobHistory — Global aggregation job history with searchable filters,
 * active filter chips, inline actions (cancel / resume / re-trigger / purge).
 *
 * Filter dropdowns follow the ExplorerFilterBar pattern:
 *   popover + click-outside + free-text search + check marks.
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useSearchParams } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Loader2, CheckCircle2, AlertCircle, Clock, XCircle,
    X, ChevronDown, ChevronRight, RotateCcw, StopCircle, Play, Trash2,
    ChevronLeft, ChevronsLeft, ChevronsRight, Activity,
    Search, Database, Users, Zap, Calendar, Check, Settings,
    TrendingUp, Timer, AlertTriangle,
} from 'lucide-react'
import * as TooltipPrimitive from '@radix-ui/react-tooltip'
import { cn } from '@/lib/utils'
import {
    aggregationService,
    type AggregationJobResponse,
    type JobHistoryFilters,
    type JobsSummary,
    type PaginatedJobsResponse,
} from '@/services/aggregationService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { useToast } from '@/components/ui/toast'

// ── Helpers ──────────────────────────────────────────────────────────

function formatDuration(seconds: number | null | undefined): string {
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

function timeAgo(iso: string | undefined): string {
    if (!iso) return '\u2014'
    const diff = (Date.now() - new Date(iso).getTime()) / 1000
    if (diff < 60) return 'just now'
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
}

function useClickOutside(ref: React.RefObject<HTMLElement | null>, onClose: () => void) {
    useEffect(() => {
        function handler(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose()
        }
        document.addEventListener('mousedown', handler)
        return () => document.removeEventListener('mousedown', handler)
    }, [ref, onClose])
}

const STATUS_CONFIG: Record<string, { icon: typeof CheckCircle2; color: string; bg: string; label: string }> = {
    completed: { icon: CheckCircle2, color: 'text-emerald-500', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Completed' },
    failed:    { icon: AlertCircle,  color: 'text-red-500',     bg: 'bg-red-500/10 border-red-500/20',         label: 'Failed' },
    running:   { icon: Loader2,      color: 'text-indigo-500',  bg: 'bg-indigo-500/10 border-indigo-500/20',   label: 'Running' },
    pending:   { icon: Clock,        color: 'text-amber-500',   bg: 'bg-amber-500/10 border-amber-500/20',     label: 'Pending' },
    cancelled: { icon: XCircle,      color: 'text-zinc-400',    bg: 'bg-zinc-500/10 border-zinc-500/20',       label: 'Cancelled' },
}

const ALL_STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'] as const
const TRIGGER_SOURCES = [
    { key: 'manual', label: 'Manual', icon: Settings },
    { key: 'onboarding', label: 'Onboarding', icon: Zap },
    { key: 'schedule', label: 'Schedule', icon: Calendar },
    { key: 'drift', label: 'Drift', icon: Activity },
    { key: 'purge', label: 'Purge', icon: Trash2 },
] as const
const MODE_OPTIONS = [
    { key: 'in_source', label: 'In-Source' },
    { key: 'dedicated', label: 'Dedicated' },
] as const
const PAGE_SIZE = 25

const DATE_PRESETS = [
    { label: 'Today', getValue: () => { const d = new Date().toISOString().slice(0, 10); return { from: d, to: d } } },
    { label: 'Last 7 days', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 7); return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } } },
    { label: 'Last 30 days', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 30); return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } } },
    { label: 'Last 90 days', getValue: () => { const d = new Date(); d.setDate(d.getDate() - 90); return { from: d.toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) } } },
] as const

// URL <-> filter sync helpers
function filtersToParams(f: JobHistoryFilters): URLSearchParams {
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

function paramsToFilters(p: URLSearchParams): JobHistoryFilters {
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

// ── Tooltip ──────────────────────────────────────────────────────────

function Tip({ children, label }: { children: React.ReactNode; label: string }) {
    return (
        <TooltipPrimitive.Provider delayDuration={300}>
            <TooltipPrimitive.Root>
                <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
                <TooltipPrimitive.Portal>
                    <TooltipPrimitive.Content
                        side="top"
                        sideOffset={6}
                        className="z-50 px-2.5 py-1.5 rounded-lg bg-ink text-canvas text-[11px] font-medium shadow-lg animate-in fade-in zoom-in-95 duration-150"
                    >
                        {label}
                        <TooltipPrimitive.Arrow className="fill-ink" />
                    </TooltipPrimitive.Content>
                </TooltipPrimitive.Portal>
            </TooltipPrimitive.Root>
        </TooltipPrimitive.Provider>
    )
}

// ── Confirm Dialog ───────────────────────────────────────────────────

function ConfirmDialog({
    open,
    title,
    message,
    confirmLabel,
    confirmColor = 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/25',
    confirmIcon: ConfirmIcon,
    onConfirm,
    onCancel,
    loading,
}: {
    open: boolean
    title: string
    message: string
    confirmLabel: string
    confirmColor?: string
    confirmIcon: typeof Play
    onConfirm: () => void
    onCancel: () => void
    loading?: boolean
}) {
    if (!open) return null
    return createPortal(
        <AnimatePresence>
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
                onClick={() => !loading && onCancel()}
                role="dialog"
                aria-modal="true"
            >
                <motion.div
                    initial={{ scale: 0.96, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    exit={{ scale: 0.96, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    onClick={e => e.stopPropagation()}
                    className="w-full max-w-md rounded-2xl bg-canvas-elevated border border-glass-border shadow-xl overflow-hidden"
                >
                    <div className="h-1 bg-gradient-to-r from-red-500 to-red-400" />
                    <div className="p-6">
                        <h3 className="text-lg font-bold text-ink mb-2">{title}</h3>
                        <p className="text-sm text-ink-muted leading-relaxed">{message}</p>
                    </div>
                    <div className="flex justify-end gap-3 px-6 pb-6">
                        <button
                            onClick={onCancel}
                            disabled={loading}
                            className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={onConfirm}
                            disabled={loading}
                            className={cn('px-4 py-2 rounded-xl text-sm font-semibold text-white transition-colors disabled:opacity-50 flex items-center gap-2', confirmColor)}
                        >
                            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <ConfirmIcon className="w-4 h-4" />}
                            {confirmLabel}
                        </button>
                    </div>
                </motion.div>
            </motion.div>
        </AnimatePresence>,
        document.body,
    )
}

// ── Date Range Picker ────────────────────────────────────────────────

function DateRangePicker({
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

// ── Searchable Dropdown ──────────────────────────────────────────────

interface DropdownOption {
    id: string
    label: string
    sublabel?: string
}

function SearchableDropdown({
    icon: Icon,
    label,
    options,
    selected,
    onSelect,
    activeColor = 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400',
    multi = false,
}: {
    icon: typeof Users
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
                                <p className="px-3 py-3 text-xs text-ink-muted text-center">No results for "{query}"</p>
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

// ── Main Component ───────────────────────────────────────────────────

export function RegistryJobHistory() {
    const [searchParams, setSearchParams] = useSearchParams()

    // Initialize filters from URL on first render
    const [filters, setFiltersRaw] = useState<JobHistoryFilters>(() => paramsToFilters(searchParams))
    const [data, setData] = useState<PaginatedJobsResponse | null>(null)
    const [summary, setSummary] = useState<JobsSummary | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [purgeConfirm, setPurgeConfirm] = useState<string | null>(null)
    const [confirmAction, setConfirmAction] = useState<{ job: AggregationJobResponse; type: 'delete' | 'retrigger' } | null>(null)
    const [searchInput, setSearchInput] = useState(filters.search ?? '')
    const [, setTick] = useState(0) // for refreshing relative timestamps
    const { showToast } = useToast()
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    // Sync filters -> URL (preserve the 'tab' param from AdminRegistry)
    const setFilters = useCallback((updater: JobHistoryFilters | ((prev: JobHistoryFilters) => JobHistoryFilters)) => {
        setFiltersRaw(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater
            const newParams = filtersToParams(next)
            // Preserve the tab param
            newParams.set('tab', 'jobs')
            setSearchParams(newParams, { replace: true })
            return next
        })
    }, [setSearchParams])

    // Load workspaces + summary
    useEffect(() => {
        workspaceService.list().then(setWorkspaces).catch(() => {})
        aggregationService.getJobsSummary().then(setSummary).catch(() => {})
    }, [])

    // Auto-refresh relative timestamps every 30s
    useEffect(() => {
        const interval = setInterval(() => setTick(t => t + 1), 30_000)
        return () => clearInterval(interval)
    }, [])

    // Debounced search — 400ms after typing stops
    const handleSearchInput = (value: string) => {
        setSearchInput(value)
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = setTimeout(() => {
            updateFilter({ search: value || undefined })
        }, 400)
    }

    // Derived dropdown options
    const workspaceOptions = useMemo<DropdownOption[]>(() =>
        workspaces.map(ws => ({ id: ws.id, label: ws.name }))
    , [workspaces])

    const dataSourceOptions = useMemo<DropdownOption[]>(() => {
        if (filters.workspaceId) {
            const ws = workspaces.find(w => w.id === filters.workspaceId)
            return (ws?.dataSources ?? []).map(ds => ({ id: ds.id, label: ds.label || ds.id }))
        }
        return workspaces.flatMap(w =>
            (w.dataSources ?? []).map(ds => ({
                id: ds.id,
                label: ds.label || ds.id,
                sublabel: w.name,
            }))
        )
    }, [workspaces, filters.workspaceId])

    // Fetch jobs
    const fetchJobs = useCallback(async () => {
        try {
            const result = await aggregationService.listJobsGlobal(filters)
            setData(result)
        } catch (err) {
            console.error('Failed to fetch global job history', err)
        } finally {
            setIsLoading(false)
        }
    }, [filters])

    useEffect(() => { setIsLoading(true); fetchJobs() }, [fetchJobs])

    // Poll while active jobs exist OR for a brief window after mount to catch
    // recently-triggered jobs that haven't appeared in the first fetch yet.
    const mountedAtRef = useRef(Date.now())
    useEffect(() => {
        const hasActive = data?.items.some(j => j.status === 'pending' || j.status === 'running')
        const withinStartupWindow = Date.now() - mountedAtRef.current < 15_000
        if (!hasActive && !withinStartupWindow) return
        const interval = setInterval(fetchJobs, 3000)
        return () => clearInterval(interval)
    }, [data?.items, fetchJobs])

    // Filter helpers
    const updateFilter = (patch: Partial<JobHistoryFilters>) =>
        setFilters(prev => ({ ...prev, ...patch, offset: 0 }))

    const toggleStatusFilter = (s: string) => {
        const current = filters.status ?? []
        const next = current.includes(s) ? current.filter(x => x !== s) : [...current, s]
        updateFilter({ status: next.length > 0 ? next : undefined })
    }

    const clearFilters = () => {
        setFilters({ limit: PAGE_SIZE, offset: 0 })
        setSearchInput('')
    }

    // Active filter chips for display
    const activeChips = useMemo(() => {
        const chips: { key: string; label: string }[] = []
        if (filters.workspaceId) {
            const ws = workspaces.find(w => w.id === filters.workspaceId)
            chips.push({ key: 'workspace', label: ws?.name ?? filters.workspaceId })
        }
        for (const dsId of filters.dataSourceId ?? []) {
            const ds = dataSourceOptions.find(d => d.id === dsId)
            chips.push({ key: `ds-${dsId}`, label: ds?.label ?? dsId })
        }
        if (filters.projectionMode) {
            chips.push({ key: 'mode', label: filters.projectionMode === 'in_source' ? 'In-Source' : 'Dedicated' })
        }
        if (filters.triggerSource) {
            chips.push({ key: 'trigger', label: filters.triggerSource.charAt(0).toUpperCase() + filters.triggerSource.slice(1) })
        }
        for (const s of filters.status ?? []) {
            chips.push({ key: `status-${s}`, label: STATUS_CONFIG[s]?.label ?? s })
        }
        if (filters.dateFrom) chips.push({ key: 'dateFrom', label: `From ${filters.dateFrom}` })
        if (filters.dateTo) chips.push({ key: 'dateTo', label: `To ${filters.dateTo}` })
        if (filters.search) chips.push({ key: 'search', label: `"${filters.search}"` })
        return chips
    }, [filters, workspaces, dataSourceOptions])

    const removeChip = (key: string) => {
        if (key === 'workspace') updateFilter({ workspaceId: undefined, dataSourceId: undefined })
        else if (key.startsWith('ds-')) updateFilter({ dataSourceId: (filters.dataSourceId ?? []).filter(d => d !== key.replace('ds-', '')) || undefined })
        else if (key === 'mode') updateFilter({ projectionMode: undefined })
        else if (key === 'trigger') updateFilter({ triggerSource: undefined })
        else if (key.startsWith('status-')) toggleStatusFilter(key.replace('status-', ''))
        else if (key === 'dateFrom') updateFilter({ dateFrom: undefined })
        else if (key === 'dateTo') updateFilter({ dateTo: undefined })
        else if (key === 'search') { updateFilter({ search: undefined }); setSearchInput('') }
    }

    // Job actions — all with toast feedback
    const withAction = async (jobId: string, fn: () => Promise<unknown>, successMsg: string) => {
        setActionLoading(jobId)
        try {
            await fn()
            showToast('success', successMsg)
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            showToast('error', err?.message ?? 'Action failed')
        } finally {
            setActionLoading(null)
        }
    }

    const handleCancel = (job: AggregationJobResponse) =>
        withAction(job.id, () => aggregationService.cancelJob(job.dataSourceId, job.id), 'Job cancelled')

    const handleResume = (job: AggregationJobResponse) =>
        withAction(job.id, () => aggregationService.resumeJob(job.dataSourceId, job.id), 'Job resumed from checkpoint')

    const handleRetrigger = (job: AggregationJobResponse) =>
        setConfirmAction({ job, type: 'retrigger' })

    const handleDelete = (job: AggregationJobResponse) =>
        setConfirmAction({ job, type: 'delete' })

    const executeConfirmedAction = () => {
        if (!confirmAction) return
        const { job, type } = confirmAction
        setConfirmAction(null)
        if (type === 'delete') {
            withAction(job.id, () => aggregationService.deleteJob(job.id), 'Job removed from history')
        } else {
            withAction(job.id, () => aggregationService.triggerAggregation(job.dataSourceId, {
                projectionMode: job.projectionMode ?? 'in_source',
                batchSize: 1000,
            }, 'manual'), 'Aggregation triggered')
        }
    }

    const handlePurge = async (job: AggregationJobResponse) => {
        setPurgeConfirm(null)
        setActionLoading(job.id)
        try {
            const result = await aggregationService.purgeAggregation(job.dataSourceId)
            showToast('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            showToast('error', err?.message ?? 'Purge failed')
        } finally {
            setActionLoading(null)
        }
    }

    // Pagination
    const total = data?.total ?? 0
    const currentPage = Math.floor((filters.offset ?? 0) / PAGE_SIZE) + 1
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const goToPage = (page: number) => setFilters(prev => ({ ...prev, offset: (page - 1) * PAGE_SIZE }))

    // Needs-attention count from summary
    const failedCount = summary?.byStatus?.failed ?? 0
    const isPolling = !!data?.items.some(j => j.status === 'pending' || j.status === 'running')

    return (
        <div className="space-y-4 animate-in fade-in duration-300">
            {/* Header */}
            <div className="flex items-center gap-3">
                <div className="flex-shrink-0 w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                    <Activity className="w-4.5 h-4.5 text-indigo-500" />
                </div>
                <div className="flex-1">
                    <div className="flex items-center gap-2">
                        <h2 className="text-base font-semibold text-ink">Aggregation Job History</h2>
                        {isPolling && (
                            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-indigo-500/10 border border-indigo-500/20">
                                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                                <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">Live</span>
                            </span>
                        )}
                    </div>
                    <p className="text-xs text-ink-muted mt-0.5">
                        Track aggregation jobs across all workspaces and data sources
                    </p>
                </div>
                <button
                    onClick={() => { fetchJobs(); aggregationService.getJobsSummary().then(setSummary).catch(() => {}) }}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                    <RotateCcw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} /> Refresh
                </button>
            </div>

            {/* KPI Strip */}
            {summary && summary.total > 0 && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <KpiCard
                        icon={Activity}
                        label="Total Jobs"
                        value={summary.total.toLocaleString()}
                        accent="text-indigo-600 dark:text-indigo-400"
                        iconBg="bg-indigo-500/10 text-indigo-500"
                    />
                    <KpiCard
                        icon={TrendingUp}
                        label="Success Rate"
                        value={summary.successRate != null ? `${summary.successRate}%` : '\u2014'}
                        accent={
                            summary.successRate != null && summary.successRate >= 90
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : summary.successRate != null && summary.successRate >= 70
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-red-600 dark:text-red-400'
                        }
                        iconBg="bg-emerald-500/10 text-emerald-500"
                    />
                    <KpiCard
                        icon={Timer}
                        label="Avg Duration"
                        value={formatDuration(summary.avgDurationSeconds)}
                        accent="text-violet-600 dark:text-violet-400"
                        iconBg="bg-violet-500/10 text-violet-500"
                    />
                    <KpiCard
                        icon={AlertTriangle}
                        label="Failed"
                        value={failedCount.toLocaleString()}
                        accent={failedCount > 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}
                        iconBg={failedCount > 0 ? 'bg-red-500/10 text-red-500' : 'bg-emerald-500/10 text-emerald-500'}
                    />
                </div>
            )}

            {/* Needs Attention Banner */}
            {failedCount > 0 && (
                <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-red-500/20 bg-red-500/5"
                >
                    <AlertCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                    <span className="text-xs text-red-400 flex-1">
                        <strong>{failedCount} failed job{failedCount !== 1 ? 's' : ''}</strong> need{failedCount === 1 ? 's' : ''} attention
                    </span>
                    <button
                        onClick={() => updateFilter({ status: ['failed'] })}
                        className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors whitespace-nowrap"
                    >
                        Show failed
                    </button>
                </motion.div>
            )}

            {/* Search Box */}
            <div className="relative">
                <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                    type="text"
                    placeholder="Search by job ID, data source, workspace, or error message..."
                    value={searchInput}
                    onChange={e => handleSearchInput(e.target.value)}
                    className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-canvas-elevated border border-glass-border focus:ring-2 focus:ring-indigo-500/50 outline-none text-sm text-ink placeholder:text-ink-muted"
                />
                {searchInput && (
                    <button onClick={() => { setSearchInput(''); updateFilter({ search: undefined }) }} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                        <X className="w-3.5 h-3.5" />
                    </button>
                )}
            </div>

            {/* ── Filter bar: single row of popover dropdowns ── */}
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

                    {/* Separator */}
                    <div className="w-px h-5 bg-glass-border mx-1" />

                    {/* Workspace popover */}
                    <SearchableDropdown
                        icon={Users}
                        label="Workspace"
                        options={workspaceOptions}
                        selected={filters.workspaceId ? [filters.workspaceId] : []}
                        onSelect={ids => updateFilter({ workspaceId: ids[0] ?? undefined, dataSourceId: undefined })}
                    />

                    {/* Data Source popover */}
                    <SearchableDropdown
                        icon={Database}
                        label="Data Source"
                        options={dataSourceOptions}
                        selected={filters.dataSourceId ?? []}
                        onSelect={ids => updateFilter({ dataSourceId: ids.length > 0 ? ids : undefined })}
                        activeColor="bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                    />

                    {/* Trigger Source popover */}
                    <SearchableDropdown
                        icon={Zap}
                        label="Trigger"
                        options={TRIGGER_SOURCES.map(t => ({ id: t.key, label: t.label }))}
                        selected={filters.triggerSource ? [filters.triggerSource] : []}
                        onSelect={ids => updateFilter({ triggerSource: ids[0] ?? undefined })}
                        activeColor="bg-amber-500/10 text-amber-600 dark:text-amber-400"
                    />

                    {/* Projection Mode popover */}
                    <SearchableDropdown
                        icon={Settings}
                        label="Mode"
                        options={MODE_OPTIONS.map(m => ({ id: m.key, label: m.label }))}
                        selected={filters.projectionMode ? [filters.projectionMode] : []}
                        onSelect={ids => updateFilter({ projectionMode: ids[0] ?? undefined })}
                        activeColor="bg-violet-500/10 text-violet-600 dark:text-violet-400"
                    />

                    {/* Separator */}
                    <div className="w-px h-5 bg-glass-border mx-1" />

                    {/* Date range popover */}
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

            {/* Loading */}
            {isLoading && !data && (
                <div className="flex items-center justify-center py-16">
                    <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
                </div>
            )}

            {/* Empty */}
            {!isLoading && data && data.items.length === 0 && (
                <div className="glass-panel rounded-xl border border-glass-border py-16 text-center">
                    <Activity className="w-8 h-8 text-ink-muted/40 mx-auto mb-3" />
                    <p className="text-sm text-ink-muted">No aggregation jobs found.</p>
                    <p className="text-xs text-ink-muted/60 mt-1">
                        {activeChips.length > 0
                            ? 'Try adjusting your filters to see more results.'
                            : 'Jobs will appear here once aggregation is triggered from a data source.'}
                    </p>
                    {activeChips.length > 0 && (
                        <button onClick={clearFilters} className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                            Clear all filters
                        </button>
                    )}
                </div>
            )}

            {/* Job Table */}
            {data && data.items.length > 0 && (
                <div className="glass-panel rounded-xl border border-glass-border overflow-hidden">
                    <div className="overflow-x-auto">
                        <table className="w-full min-w-[900px]">
                            <thead>
                                <tr className="border-b border-glass-border bg-black/[0.02] dark:bg-white/[0.01]">
                                    {['Status', 'Data Source', 'Mode', 'Trigger', 'Progress', 'Edges', 'Duration', 'Started', ''].map((h, i) => (
                                        <th key={h || 'actions'} className={cn(
                                            'text-[10px] font-bold text-ink-muted uppercase tracking-wider px-4 py-2.5',
                                            i === 8 ? 'text-right' : 'text-left'
                                        )}>
                                            {h}
                                        </th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {data.items.map(job => (
                                    <JobRow
                                        key={job.id}
                                        job={job}
                                        expanded={expandedRowId === job.id}
                                        onToggle={() => setExpandedRowId(prev => prev === job.id ? null : job.id)}
                                        onCancel={handleCancel}
                                        onResume={handleResume}
                                        onRetrigger={handleRetrigger}
                                        onDelete={handleDelete}
                                        onPurge={handlePurge}
                                        purgeConfirm={purgeConfirm}
                                        setPurgeConfirm={setPurgeConfirm}
                                        actionLoading={actionLoading === job.id}
                                    />
                                ))}
                            </tbody>
                        </table>
                    </div>

                    {/* Pagination */}
                    {totalPages > 1 && (
                        <div className="flex items-center justify-between px-4 py-2.5 border-t border-glass-border bg-black/[0.02] dark:bg-white/[0.01]">
                            <span className="text-[11px] text-ink-muted">
                                {(filters.offset ?? 0) + 1}{'\u2013'}{Math.min((filters.offset ?? 0) + PAGE_SIZE, total)} of {total}
                            </span>
                            <div className="flex items-center gap-0.5">
                                {[
                                    { icon: ChevronsLeft, page: 1, disabled: currentPage === 1 },
                                    { icon: ChevronLeft, page: currentPage - 1, disabled: currentPage === 1 },
                                ].map(({ icon: Ic, page, disabled }, i) => (
                                    <button key={i} onClick={() => goToPage(page)} disabled={disabled}
                                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                                        <Ic className="w-3.5 h-3.5" />
                                    </button>
                                ))}
                                <span className="text-[11px] text-ink-muted px-2.5 tabular-nums">{currentPage} / {totalPages}</span>
                                {[
                                    { icon: ChevronRight, page: currentPage + 1, disabled: currentPage === totalPages },
                                    { icon: ChevronsRight, page: totalPages, disabled: currentPage === totalPages },
                                ].map(({ icon: Ic, page, disabled }, i) => (
                                    <button key={i} onClick={() => goToPage(page)} disabled={disabled}
                                        className="p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors">
                                        <Ic className="w-3.5 h-3.5" />
                                    </button>
                                ))}
                            </div>
                        </div>
                    )}
                </div>
            )}

            {/* Confirm Dialog for Delete / Re-trigger */}
            <ConfirmDialog
                open={!!confirmAction}
                title={confirmAction?.type === 'delete' ? 'Delete job from history' : 'Re-trigger aggregation'}
                message={
                    confirmAction?.type === 'delete'
                        ? `Remove job ${confirmAction?.job.id ?? ''} from history? This only deletes the record — aggregated edges in the graph are not affected.`
                        : `Start a new aggregation job for ${confirmAction?.job.dataSourceLabel || confirmAction?.job.dataSourceId || 'this data source'}? This will re-process all edges.`
                }
                confirmLabel={confirmAction?.type === 'delete' ? 'Delete' : 'Re-trigger'}
                confirmColor={confirmAction?.type === 'delete' ? 'bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/25' : 'bg-indigo-500 hover:bg-indigo-600 shadow-lg shadow-indigo-500/25'}
                confirmIcon={confirmAction?.type === 'delete' ? Trash2 : Play}
                onConfirm={executeConfirmedAction}
                onCancel={() => setConfirmAction(null)}
                loading={!!actionLoading}
            />
        </div>
    )
}

// ── Job Row ──────────────────────────────────────────────────────────

interface JobRowProps {
    job: AggregationJobResponse
    expanded: boolean
    onToggle: () => void
    onCancel: (job: AggregationJobResponse) => void
    onResume: (job: AggregationJobResponse) => void
    onRetrigger: (job: AggregationJobResponse) => void
    onDelete: (job: AggregationJobResponse) => void
    onPurge: (job: AggregationJobResponse) => void
    purgeConfirm: string | null
    setPurgeConfirm: (id: string | null) => void
    actionLoading: boolean
}

function JobRow({ job, expanded, onToggle, onCancel, onResume, onRetrigger, onDelete, onPurge, purgeConfirm, setPurgeConfirm, actionLoading }: JobRowProps) {
    const cfg = STATUS_CONFIG[job.status] ?? STATUS_CONFIG.pending
    const StatusIcon = cfg.icon
    const isRunning = job.status === 'running'
    const canCancel = job.status === 'pending' || isRunning
    const canResume = job.resumable
    const isTerminal = job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled'
    const isPurging = purgeConfirm === job.id

    return (
        <>
            <tr
                onClick={onToggle}
                className={cn(
                    'border-b border-glass-border/50 cursor-pointer transition-colors hover:bg-black/[0.03] dark:hover:bg-white/[0.02]',
                    expanded && 'bg-black/[0.03] dark:bg-white/[0.02]'
                )}
            >
                <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1.5">
                        <span className="flex items-center justify-center w-4 h-4">
                            {expanded ? <ChevronDown className="w-3 h-3 text-ink-muted" /> : <ChevronRight className="w-3 h-3 text-ink-muted" />}
                        </span>
                        <StatusIcon className={cn('w-3.5 h-3.5', cfg.color, isRunning && 'animate-spin')} />
                        <span className={cn('text-[11px] font-semibold', cfg.color)}>{cfg.label}</span>
                    </div>
                </td>

                <td className="px-4 py-2.5">
                    <div className="leading-tight">
                        <span className="text-xs font-medium text-ink">{job.dataSourceLabel || job.dataSourceId}</span>
                        {job.workspaceName && <span className="block text-[10px] text-ink-muted mt-0.5">{job.workspaceName}</span>}
                    </div>
                </td>

                <td className="px-4 py-2.5">
                    {job.projectionMode ? (
                        <span className={cn(
                            'inline-block px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider',
                            job.projectionMode === 'in_source' ? 'bg-emerald-500/10 text-emerald-500' : 'bg-blue-500/10 text-blue-400'
                        )}>
                            {job.projectionMode === 'in_source' ? 'In-Source' : 'Dedicated'}
                        </span>
                    ) : <span className="text-[10px] text-ink-muted">{'\u2014'}</span>}
                </td>

                <td className="px-4 py-2.5">
                    {job.triggerSource === 'purge' ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-red-400">
                            <Trash2 className="w-3 h-3" /> Purge
                        </span>
                    ) : (
                        <span className="text-[11px] text-ink-muted capitalize">{job.triggerSource}</span>
                    )}
                </td>

                <td className="px-4 py-2.5">
                    {job.triggerSource === 'purge' ? (
                        <span className="text-[11px] text-ink-muted">{'\u2014'}</span>
                    ) : job.edgeCoveragePct != null ? (
                        <Tip label="Percentage of input lineage edges processed">
                            <span className={cn(
                                'text-[11px] font-semibold tabular-nums',
                                job.edgeCoveragePct >= 80 ? 'text-emerald-500' : job.edgeCoveragePct >= 50 ? 'text-amber-500' : 'text-red-500'
                            )}>
                                {job.edgeCoveragePct}%
                            </span>
                        </Tip>
                    ) : <span className="text-[11px] text-ink-muted">{'\u2014'}</span>}
                </td>

                <td className="px-4 py-2.5">
                    {job.triggerSource === 'purge' ? (
                        <span className="text-[11px] text-red-400 font-medium">
                            Purged {job.processedEdges.toLocaleString()} edge{job.processedEdges !== 1 ? 's' : ''}
                        </span>
                    ) : (
                        <div className="flex items-center gap-2">
                            <Tip label={`Input lineage edges processed${job.createdEdges > 0 ? ` · ${job.createdEdges.toLocaleString()} materialized` : ''}`}>
                                <span className="text-[11px] text-ink-muted tabular-nums">
                                    {job.processedEdges.toLocaleString()}{job.totalEdges > 0 ? ` / ${job.totalEdges.toLocaleString()}` : ''}
                                    {job.status === 'completed' && job.createdEdges > 0 && (
                                        <span className="text-emerald-500 font-medium"> → {job.createdEdges.toLocaleString()}</span>
                                    )}
                                </span>
                            </Tip>
                            {isRunning && job.totalEdges > 0 && (
                                <div className="w-12 h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                                    <div className="h-full bg-indigo-500 rounded-full transition-all duration-500"
                                        style={{ width: `${Math.min(100, Math.round(job.progress))}%` }} />
                                </div>
                            )}
                        </div>
                    )}
                </td>

                <td className="px-4 py-2.5">
                    <span className="text-[11px] text-ink-muted tabular-nums">{formatDuration(job.durationSeconds)}</span>
                </td>

                <td className="px-4 py-2.5">
                    <span className="text-[11px] text-ink-muted" title={job.startedAt ? new Date(job.startedAt).toLocaleString() : job.createdAt}>
                        {timeAgo(job.startedAt ?? job.createdAt)}
                    </span>
                </td>

                <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-0.5" onClick={e => e.stopPropagation()}>
                        {canCancel && (
                            <Tip label="Cancel job">
                                <button onClick={() => onCancel(job)} disabled={actionLoading}
                                    className="p-1.5 rounded-lg text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                                    {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <StopCircle className="w-3.5 h-3.5" />}
                                </button>
                            </Tip>
                        )}
                        {canResume && (
                            <Tip label="Resume from checkpoint">
                                <button onClick={() => onResume(job)} disabled={actionLoading}
                                    className="p-1.5 rounded-lg text-indigo-400 hover:bg-indigo-500/10 transition-colors disabled:opacity-40">
                                    {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
                                </button>
                            </Tip>
                        )}
                        {isTerminal && (
                            <>
                                <Tip label="Re-trigger aggregation">
                                    <button onClick={() => onRetrigger(job)} disabled={actionLoading}
                                        className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-40">
                                        {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                                    </button>
                                </Tip>
                                <Tip label="Delete from history">
                                    <button onClick={() => onDelete(job)} disabled={actionLoading}
                                        className="p-1.5 rounded-lg text-ink-muted hover:text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40">
                                        {actionLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                                    </button>
                                </Tip>
                            </>
                        )}
                    </div>
                </td>
            </tr>

            {/* Expanded detail */}
            {expanded && (
                <tr className="bg-black/[0.02] dark:bg-white/[0.01]">
                    <td colSpan={9} className="px-6 py-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-3">
                            <DetailField label="Job ID" value={job.id} mono />
                            <DetailField label="Data Source ID" value={job.dataSourceId} mono />
                            {job.triggerSource !== 'purge' && (
                                <DetailField label="Retry Count" value={
                                    <span>{job.retryCount}{job.resumable && <span className="ml-1.5 text-[10px] text-indigo-400 font-medium">(resumable)</span>}</span>
                                } />
                            )}
                            <DetailField
                                label={job.triggerSource === 'purge' ? 'Purged Edges' : 'Materialized Edges'}
                                value={
                                    job.triggerSource === 'purge'
                                        ? job.processedEdges.toLocaleString()
                                        : job.createdEdges > 0
                                            ? job.createdEdges.toLocaleString()
                                            : job.status === 'completed'
                                                ? '0'
                                                : <span className="text-ink-muted/60">updates during processing</span>
                                }
                            />
                            {job.triggerSource !== 'purge' && (
                                <DetailField label="Batch Size" value={job.batchSize.toLocaleString()} />
                            )}
                            {job.estimatedCompletionAt && (
                                <DetailField label="Est. Completion" value={new Date(job.estimatedCompletionAt).toLocaleTimeString()} />
                            )}
                            {job.lastCheckpointAt && (
                                <DetailField label="Last Checkpoint" value={timeAgo(job.lastCheckpointAt)} />
                            )}
                            <DetailField label="Created" value={new Date(job.createdAt).toLocaleString()} />
                        </div>

                        {job.errorMessage && (
                            <div className="mt-3 p-3 rounded-lg bg-red-500/5 border border-red-500/20">
                                <span className="block text-[10px] text-red-400 uppercase tracking-wider font-bold mb-1">Error</span>
                                <pre className="text-xs font-mono text-red-400 break-words whitespace-pre-wrap">{job.errorMessage}</pre>
                                {job.errorMessage.includes('Max retries exceeded after crash recovery') && (
                                    <p className="mt-2 text-[11px] text-amber-400">
                                        This typically indicates server restarts during processing, not a job failure.
                                        The job may have been making progress before each restart.
                                    </p>
                                )}
                            </div>
                        )}

                        {/* Purge aggregated edges (destructive — kept in detail for confirmation flow) */}
                        {isTerminal && job.createdEdges > 0 && job.triggerSource !== 'purge' && (
                            <div className="mt-4 pt-3 border-t border-glass-border/50">
                                {!isPurging ? (
                                    <button
                                        onClick={() => setPurgeConfirm(job.id)}
                                        className="flex items-center gap-1.5 text-[11px] font-medium text-ink-muted hover:text-red-400 transition-colors"
                                    >
                                        <Trash2 className="w-3 h-3" />
                                        Purge aggregated edges from graph
                                    </button>
                                ) : (
                                    <div className="flex items-center gap-3">
                                        <span className="text-[11px] text-red-400">
                                            Remove {job.createdEdges.toLocaleString()} aggregated edges? This cannot be undone.
                                        </span>
                                        <button
                                            onClick={() => onPurge(job)}
                                            disabled={actionLoading}
                                            className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-colors disabled:opacity-40"
                                        >
                                            {actionLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                                        </button>
                                        <button
                                            onClick={() => setPurgeConfirm(null)}
                                            className="text-[11px] text-ink-muted hover:text-ink transition-colors"
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}
                    </td>
                </tr>
            )}
        </>
    )
}

// ── Shared sub-components ────────────────────────────────────────────

function DetailField({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
    return (
        <div>
            <span className="block text-[10px] text-ink-muted uppercase tracking-wider font-bold mb-0.5">{label}</span>
            <span className={cn('text-xs text-ink-secondary', mono && 'font-mono text-[11px]')}>{value}</span>
        </div>
    )
}

function KpiCard({ icon: Icon, label, value, accent, iconBg }: {
    icon: typeof Activity; label: string; value: string; accent: string; iconBg: string
}) {
    return (
        <div className="glass-panel rounded-xl border border-glass-border px-4 py-3 flex items-center gap-3">
            <div className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', iconBg)}>
                <Icon className="w-4 h-4" />
            </div>
            <div>
                <p className={cn('text-lg font-bold tabular-nums leading-none', accent)}>{value}</p>
                <p className="text-[10px] text-ink-muted uppercase tracking-wider font-bold mt-1">{label}</p>
            </div>
        </div>
    )
}

export default RegistryJobHistory
