/**
 * shared.tsx — Shared helpers, constants, and reusable components for the
 * job-history views.  Extracted from RegistryJobHistory.tsx so that both the
 * global (registry) and per-workspace history pages can reuse them.
 */
import type { AggregationRunStats } from '@/services/aggregationService'
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    CheckCircle2, AlertCircle, Loader2, Clock, XCircle,
    Search, X, ChevronDown, Check,
    Settings, Zap, Calendar, Activity, Trash2, ShieldCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { WorkspaceResponse } from '@/services/workspaceService'
import type { ProviderResponse } from '@/services/providerService'
import type { CatalogItemResponse } from '@/services/catalogService'
import type { JobHistoryFilters } from '@/services/aggregationService'
import {
    describeSteps, compareStages, stageSlip, stageShares, STAGE_COLOUR,
    type StepView,
} from './runSteps'

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
            const catalogItem = ds.catalogItemId ? catalogMap.get(ds.catalogItemId) : undefined
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
    { key: 'reconcile', label: 'Reconciliation', icon: ShieldCheck },
    { key: 'drift', label: 'Drift', icon: Activity },
    { key: 'purge', label: 'Purge', icon: Trash2 },
    { key: 'post_purge', label: 'Post-purge', icon: Zap },
    { key: 'auto', label: 'Auto backfill', icon: Activity },
] as const

// Friendly labels for every trigger source the backend emits. Raw
// values like ``post_purge`` must never render capitalized-verbatim.
const TRIGGER_LABELS: Record<string, string> = {
    manual: 'Manual',
    api: 'API',
    onboarding: 'Onboarding',
    schedule: 'Scheduled',
    // The automatic reconciliation sweep. Distinct from 'schedule' (the cron
    // scheduler) and from 'api' (a person or an external caller) — the whole
    // point is that an automatic rebuild is identifiable as one.
    reconcile: 'Reconciliation',
    drift: 'Drift',
    purge: 'Purge',
    post_purge: 'Post-purge',
    auto: 'Auto backfill',
}

export function triggerLabel(source: string | undefined | null): string {
    if (!source) return '\u2014'
    return TRIGGER_LABELS[source]
        ?? source.replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase())
}

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

// ── Aggregation pipeline phases ─────────────────────────────────────
//
// Moved here from JobRow.tsx so the Freshness cockpit renders the SAME
// stepper and the SAME phase names. Two hard-coded copies of the
// pipeline's vocabulary drift the moment a phase is added.

// UI phase visibility. Maps the backend's short phase IDs (emitted by
// the aggregation pipeline's EXTRACT → COMPUTE → RECONCILE → APPLY
// stages) to operator-readable status labels. ``null`` / unrecognized
// values fall back to the generic "Processing lineage edges" string so
// legacy / non-FalkorDB paths keep the old UX.
export const PHASE_LABELS: Record<string, string> = {
    // The pipeline's own four phases, plus the two stages either side of
    // them that the worker owns. Those two never reach ``current_phase``
    // (only the pipeline checkpoints set it) — they come off the run's step
    // ledger, which is the only record that has them at all.
    preparing: 'Preparing the graph',
    extracting: 'Extracting lineage edges',
    computing: 'Computing rollups',
    reconciling: 'Reconciling existing aggregated edges',
    applying: 'Writing aggregated edges',
    finalizing: 'Recording the result',
}

export function phaseLabel(currentPhase: string | null | undefined): string {
    if (currentPhase && PHASE_LABELS[currentPhase]) {
        return PHASE_LABELS[currentPhase]
    }
    return 'Processing lineage edges'
}

// Pipeline phases in execution order — drives the stepper and the
// per-phase duration readout (keys emitted in ``job.runStats``).
export const PHASES: Array<{ id: string; label: string; statKey: string }> = [
    { id: 'extracting', label: 'Extract', statKey: 'extract_s' },
    { id: 'computing', label: 'Compute', statKey: 'compute_s' },
    { id: 'reconciling', label: 'Reconcile', statKey: 'reconcile_s' },
    { id: 'applying', label: 'Apply', statKey: 'apply_s' },
]

// Overall-progress band each phase occupies. MUST mirror the pipeline's
// _progress_pct mapping in falkordb_materialize.py (extract 0-45,
// compute 45-55, reconcile 55-75, apply 75-100).
export const PHASE_BANDS: Record<string, [number, number]> = {
    extracting: [0, 45],
    computing: [45, 55],
    reconciling: [55, 75],
    applying: [75, 100],
}

/**
 * The run's steps: which one it is on, what each finished one got through,
 * and how much of the current one is left.
 *
 * Renders the durable step ledger (``runStats.steps``) when the run has
 * one. That ledger is the only place the two ends of a run are visible at
 * all — the indexes and identity stamping before the first phase, the
 * after-fingerprint and state rows after the last — and the only place a
 * step past EXTRACT has a denominator, because the job's own
 * processed/total counters stop moving once the extract scan is over.
 *
 * Runs from before the ledger existed fall back to ``PhaseStepper``'s
 * original four segments derived from ``currentPhase``.
 */
function StepLedgerView({ views, status, deltas, slip, shares }: {
    views: StepView[]
    status: string
    /** Each stage's share of the run's total stage time. */
    shares: ReturnType<typeof stageShares>
    /** Percent change per stage against the previous run on this source. */
    deltas: Map<string, number>
    /** Set when the stage the run is ON is well past its own last time. */
    slip: { label: string; elapsedS: number; expectedS: number; overBy: number } | null
}) {
    const running = status === 'running' || status === 'pending'
    const open = views.find(v => v.open)
    return (
        <div className="space-y-1.5" data-testid="step-ledger">
            <div className="flex items-start gap-1.5">
                {views.map(v => {
                    const done = v.state === 'done'
                    const bad = v.state === 'failed' || v.state === 'cancelled'
                    const parked = v.state === 'waiting'
                    // How full THIS stage's bar is: its own unit of work
                    // while it runs, all the way once it is behind us.
                    const fill = done ? 100 : v.open ? (v.pct ?? 100) : 0
                    return (
                        <div key={v.id} className="flex-1 min-w-0" title={v.detailLabel}>
                            <div className={cn(
                                'h-1 rounded-full overflow-hidden',
                                bad ? 'bg-red-500/20' : 'bg-black/[0.06] dark:bg-white/[0.08]',
                            )}>
                                <div
                                    className={cn(
                                        'h-full rounded-full transition-[width] duration-700 ease-out',
                                        bad ? 'bg-red-500'
                                            : parked ? 'bg-amber-400 animate-pulse'
                                            : v.open ? 'bg-gradient-to-r from-indigo-500 to-violet-400 animate-pulse'
                                            : 'bg-indigo-500/70',
                                    )}
                                    style={{ width: `${fill}%` }}
                                />
                            </div>
                            <div className="mt-1 flex items-center justify-between gap-1">
                                <span className={cn(
                                    'text-[9px] font-bold uppercase tracking-wider truncate',
                                    bad ? 'text-red-400'
                                        : parked ? 'text-amber-500'
                                        : v.open ? 'text-indigo-400'
                                        : done ? 'text-ink-muted'
                                        : 'text-ink-muted opacity-40',
                                )}>{v.label}</span>
                                {v.elapsedS != null && (
                                    <span className="text-[9px] tabular-nums flex-shrink-0 flex items-center gap-1">
                                        <span className="text-ink-muted opacity-70">{formatDuration(v.elapsedS)}</span>
                                        {/* Against the same stage last time. Only when it
                                            is big in percent AND in seconds — a stage that
                                            went from 1s to 2s doubled and means nothing. */}
                                        {deltas.has(v.id) && (
                                            <span className={cn(
                                                'font-bold',
                                                deltas.get(v.id)! > 0 ? 'text-amber-500' : 'text-emerald-500',
                                            )}>
                                                {deltas.get(v.id)! > 0 ? '\u2191' : '\u2193'}
                                                {Math.abs(deltas.get(v.id)!)}%
                                            </span>
                                        )}
                                    </span>
                                )}
                            </div>
                        </div>
                    )
                })}
            </div>
            {/* What the stage the run is ON actually means, and how far
                through it is. The stepper says which stage; without this
                line nothing on the page says what that stage does or what
                its percentage is counting. */}
            {open && (
                <p className={cn(
                    'text-[10px] leading-relaxed',
                    open.state === 'waiting' ? 'text-amber-500/90' : 'text-ink-muted',
                )} data-testid="step-now">
                    <span className="text-ink-secondary">{open.detailLabel}</span>
                    {open.detail && <span className="tabular-nums">{` \u00b7 ${open.detail}`}</span>}
                    {open.visits > 1 && (
                        <span className="text-amber-500/80">{` \u00b7 restarted \u00d7${open.visits - 1}`}</span>
                    )}
                </p>
            )}
            {/* Stuck, or just slow? The question during an incident, and the
                one a percentage cannot answer. Silent until the stage is well
                past what the same stage took on the last run. */}
            {slip && (
                <p className="text-[10px] text-amber-500/90 leading-relaxed" data-testid="stage-slip">
                    {`${slip.label} has been running ${formatDuration(slip.elapsedS)} \u2014 `}
                    {`last run\u2019s took ${formatDuration(slip.expectedS)}, `}
                    {`so this one is ${slip.overBy.toFixed(1)}\u00d7 longer so far.`}
                </p>
            )}
            {running && !open && (
                <p className="text-[10px] text-ink-muted opacity-70">{'Starting\u2026'}</p>
            )}

            {/* Where the wall clock actually went. The per-stage durations
                above are a list of numbers; the SHARE each stage took is the
                thing that reads at a glance, and it is where the surprise
                usually is — on a graph with a slow fingerprint, Prepare and
                Finish together can be most of the run. */}
            {!running && shares.length > 1 && (
                <div className="space-y-1" data-testid="stage-shares">
                    <div className="flex h-1.5 rounded-full overflow-hidden gap-px">
                        {shares.map(sh => (
                            <span
                                key={sh.id}
                                className={cn('h-full', STAGE_COLOUR[sh.id] ?? 'bg-indigo-500')}
                                style={{ width: `${sh.pct}%` }}
                                title={`${sh.label} \u2014 ${formatDuration(sh.secs)} (${Math.round(sh.pct)}% of the run)`}
                            />
                        ))}
                    </div>
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[9px] text-ink-muted">
                        {shares.filter(sh => sh.pct >= 5).map(sh => (
                            <span key={sh.id} className="inline-flex items-center gap-1">
                                <span className={cn('w-1.5 h-1.5 rounded-sm', STAGE_COLOUR[sh.id] ?? 'bg-indigo-500')} />
                                {`${sh.label} ${Math.round(sh.pct)}%`}
                            </span>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}


/**
 * Four-segment EXTRACT → COMPUTE → RECONCILE → APPLY stepper.
 * Running: segments before the current phase are done, the current one
 * pulses, later ones are dormant. Completed: all done, with the
 * per-phase durations from ``runStats`` under each segment.
 */
export function PhaseStepper({ currentPhase, runStats, status, previousRunStats }: {
    currentPhase: string | null | undefined
    runStats: AggregationRunStats | null | undefined
    status: string
    /** The last completed run on this data source. Both runs carry the same
     *  ledger, so "is this getting worse" costs nothing to answer. */
    previousRunStats?: AggregationRunStats | null
}) {
    const completed = status === 'completed'
    // Re-read the clock while a step is open so its elapsed time ticks: the
    // ledger stores when the step started, not how long it has been going
    // (baking that in would mark the record dirty on every checkpoint).
    const [now, setNow] = useState(() => Date.now())
    const views = useMemo(() => describeSteps(runStats?.steps, now), [runStats?.steps, now])
    const anyOpen = views.some(v => v.open)
    useEffect(() => {
        if (!anyOpen) return
        const t = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(t)
    }, [anyOpen])
    const deltas = useMemo(() => {
        const out = new Map<string, number>()
        for (const d of compareStages(runStats?.steps, previousRunStats?.steps)) {
            if (d.material && d.deltaPct != null) out.set(d.id, d.deltaPct)
        }
        return out
    }, [runStats?.steps, previousRunStats?.steps])
    const slip = useMemo(
        () => stageSlip(runStats?.steps, previousRunStats?.steps, now),
        [runStats?.steps, previousRunStats?.steps, now],
    )
    const shares = useMemo(() => stageShares(runStats?.steps), [runStats?.steps])
    if (views.length > 0) {
        return (
            <StepLedgerView
                views={views} status={status} deltas={deltas} slip={slip} shares={shares}
            />
        )
    }

    const currentIdx = currentPhase ? PHASES.findIndex(p => p.id === currentPhase) : -1
    if (!completed && currentIdx < 0) return null
    return (
        <div className="flex items-start gap-1.5">
            {PHASES.map((p, i) => {
                const done = completed || i < currentIdx
                const active = !completed && i === currentIdx
                const raw = runStats?.[p.statKey]
                const secs = typeof raw === 'number' ? raw : null
                return (
                    <div key={p.id} className="flex-1 min-w-0">
                        <div className={cn(
                            'h-1 rounded-full transition-colors',
                            done ? 'bg-indigo-500/70'
                                : active ? 'bg-gradient-to-r from-indigo-500 to-violet-400 animate-pulse'
                                : 'bg-black/[0.06] dark:bg-white/[0.08]',
                        )} />
                        <div className="mt-1 flex items-center justify-between gap-1">
                            <span className={cn(
                                'text-[9px] font-bold uppercase tracking-wider truncate',
                                active ? 'text-indigo-400' : done ? 'text-ink-muted' : 'text-ink-muted/35',
                            )}>{p.label}</span>
                            {secs != null && (
                                <span className="text-[9px] tabular-nums text-ink-muted/60 flex-shrink-0">
                                    {formatDuration(secs)}
                                </span>
                            )}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}

/**
 * Deep link into Ingestion → Job History. Emits exactly the params
 * ``paramsToFilters`` reads, so a link and the filter state it produces
 * cannot drift. No new routing: IngestionPage already drives tabs off
 * ``?tab=``.
 */
export function jobHistoryPath(opts: {
    dataSourceId?: string
    status?: string[]
    triggerSource?: string
    search?: string
    dateFrom?: string
} = {}): string {
    const p = new URLSearchParams()
    p.set('tab', 'jobs')
    if (opts.dataSourceId) p.append('dataSourceId', opts.dataSourceId)
    for (const s of opts.status ?? []) p.append('status', s)
    // These round-trip through paramsToFilters, so a link built here lands on
    // exactly the filter state the user could have set by hand — same key
    // names, no second vocabulary to keep in sync.
    if (opts.triggerSource) p.set('triggerSource', opts.triggerSource)
    if (opts.search) p.set('search', opts.search)
    if (opts.dateFrom) p.set('dateFrom', opts.dateFrom)
    return `/ingestion?${p.toString()}`
}
