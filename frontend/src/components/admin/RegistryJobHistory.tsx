/**
 * RegistryJobHistory — Orchestrator for the global aggregation job history tab.
 *
 * Supports two view modes:
 *   - Grouped (default): jobs grouped by data source with summary headers
 *   - Flat: traditional paginated table
 *
 * All sub-components live in ./job-history/
 */
import { useState, useEffect, useCallback, useMemo, useRef, useTransition } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
    Loader2, Activity, RotateCcw, Trash2,
    ChevronLeft, ChevronsLeft, ChevronRight, ChevronsRight,
    List, LayoutGrid,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    aggregationService,
    type AggregationJobResponse,
    type AggregationTuning,
    type JobHistoryFilters,
    type JobsSummary,
    type PaginatedJobsResponse,
} from '@/services/aggregationService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { useAppNotifications } from '@/components/ui/notifications'
import {
    buildDataSourceLookup,
    filtersToParams, paramsToFilters,
    STATUS_CONFIG, PAGE_SIZE, triggerLabel,
    type DropdownOption,
} from './job-history/shared'
import { JobRow } from './job-history/JobRow'
import { ConfirmDialog } from './job-history/ConfirmDialog'
import { RetriggerDialog } from './job-history/RetriggerDialog'
import { JobHistoryFilterBar } from './job-history/JobHistoryFilterBar'
import { JobHistoryKPIs } from './job-history/JobHistoryKPIs'
import { JobHistoryGroupedView } from './job-history/JobHistoryGroupedView'
import type { AggregationOverridesValue } from './shared/AggregationOverridesForm'
import { PageContainer } from '@/components/layout/PageContainer'

// ── Defaults ─────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_SECS = 10800
const DEFAULT_MAX_RETRIES = 3
const DEFAULT_BATCH_SIZE = 5000

/** Only send ``tuning`` when the user actually set an override. */
function tuningForRequest(tuning: AggregationTuning | undefined): AggregationTuning | undefined {
    return tuning && Object.keys(tuning).length > 0 ? tuning : undefined
}

/**
 * Seed the Re-trigger / Resume dialog for an existing job.
 *
 * Performance settings come from the CONFIGURED DEFAULTS, never from the
 * job row. Replaying a failed job's frozen tuning is what made a graph
 * that failed under bad settings keep failing under those same settings:
 * the whole point of re-triggering is to get the current defaults. Only
 * ``projectionMode`` is carried over, because that is a structural choice
 * about where the projection lives, not a performance knob.
 */
export function buildInitialOverridesFromJob(
    job: AggregationJobResponse,
    defaultTuning?: AggregationTuning,
): AggregationOverridesValue {
    // Backend's AggregationTriggerRequest enforces ``batchSize >= 100``.
    // Older purge job rows were written with ``batch_size = 0`` (now fixed
    // server-side, but rows persist), so a plain ``?? DEFAULT`` doesn't
    // protect us — ``??`` only falls back from null/undefined. Clamp to
    // the default any time the stored value is below the validator's floor.
    const storedBatchSize = job.batchSize ?? DEFAULT_BATCH_SIZE
    const safeBatchSize = storedBatchSize < 100 ? DEFAULT_BATCH_SIZE : storedBatchSize
    return {
        batchSize: safeBatchSize,
        projectionMode: (job.projectionMode === 'dedicated' ? 'dedicated' : 'in_source'),
        maxRetries: DEFAULT_MAX_RETRIES,
        timeoutMinutes: Math.round(DEFAULT_TIMEOUT_SECS / 60),
        tuning: defaultTuning,
    }
}

function buildInitialOverridesForDataSource(
    projectionMode?: string | null,
    defaultTuning?: AggregationTuning,
): AggregationOverridesValue {
    return {
        batchSize: DEFAULT_BATCH_SIZE,
        projectionMode: projectionMode === 'dedicated' ? 'dedicated' : 'in_source',
        maxRetries: DEFAULT_MAX_RETRIES,
        timeoutMinutes: Math.round(DEFAULT_TIMEOUT_SECS / 60),
        tuning: defaultTuning,
    }
}

// ── View mode ────────────────────────────────────────────────────────

type ViewMode = 'grouped' | 'flat'

// ── Main Component ───────────────────────────────────────────────────

export function RegistryJobHistory() {
    const [searchParams, setSearchParams] = useSearchParams()

    // View mode from URL
    const [viewMode, setViewModeRaw] = useState<ViewMode>(
        () => (searchParams.get('view') as ViewMode) || 'grouped'
    )
    const setViewMode = useCallback((mode: ViewMode) => {
        // Wrap in startTransition so the click commits without blocking on the
        // refetch + full subtree rerender that follows from the viewMode dep
        // chain (fetchJobs → useEffect → setData).
        startTransition(() => {
            setViewModeRaw(mode)
            const p = new URLSearchParams(searchParams)
            p.set('view', mode)
            setSearchParams(p, { replace: true })
        })
    }, [searchParams, setSearchParams])

    // Filters from URL
    const [filters, setFiltersRaw] = useState<JobHistoryFilters>(() => paramsToFilters(searchParams))
    const [data, setData] = useState<PaginatedJobsResponse | null>(null)
    const [summary, setSummary] = useState<JobsSummary | null>(null)
    const [isLoading, setIsLoading] = useState(true)
    const [workspaces, setWorkspaces] = useState<WorkspaceResponse[]>([])
    const [providers, setProviders] = useState<ProviderResponse[]>([])
    const [catalogItems, setCatalogItems] = useState<CatalogItemResponse[]>([])
    const [expandedRowId, setExpandedRowId] = useState<string | null>(null)
    const [actionLoading, setActionLoading] = useState<string | null>(null)
    const [purgeConfirm, setPurgeConfirm] = useState<string | null>(null)
    const [confirmDelete, setConfirmDelete] = useState<AggregationJobResponse | null>(null)
    // Retrigger dialog: either job-derived (from a JobRow) or data-source-derived (from grouped card).
    const [retriggerCtx, setRetriggerCtx] = useState<
        | { kind: 'job'; job: AggregationJobResponse; initialValue: AggregationOverridesValue }
        | { kind: 'dataSource'; dataSourceId: string; dataSourceLabel: string; initialValue: AggregationOverridesValue }
        | null
    >(null)
    const [searchInput, setSearchInput] = useState(filters.search ?? '')
    const [, setTick] = useState(0)
    const [, startTransition] = useTransition()
    const { notify, showLoading, hideLoading } = useAppNotifications()
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    // Sync filters -> URL. Wrapped in startTransition for the same reason as
    // setViewMode — filter changes trigger a refetch via fetchJobs, and we
    // want the click to commit immediately.
    const setFilters = useCallback((updater: JobHistoryFilters | ((prev: JobHistoryFilters) => JobHistoryFilters)) => {
        startTransition(() => {
            setFiltersRaw(prev => {
                const next = typeof updater === 'function' ? updater(prev) : updater
                const newParams = filtersToParams(next)
                newParams.set('tab', 'jobs')
                newParams.set('view', viewMode)
                setSearchParams(newParams, { replace: true })
                return next
            })
        })
    }, [setSearchParams, viewMode])

    // Admin-level tuning defaults — seeds the re-trigger dialog when the job
    // row itself carries no tuning. Best-effort: on failure the dialog simply
    // opens with blank tuning fields (worker defaults).
    const [defaultTuning, setDefaultTuning] = useState<AggregationTuning | undefined>(undefined)
    // What the server resolves for Rollup storage when the request says
    // nothing, so the dialog's radio can show the mode the job would actually
    // run in rather than assuming Auto for an absent key.
    const [envFinePairs, setEnvFinePairs] = useState<'auto' | 'true' | 'false' | undefined>(undefined)

    // Load reference data + summary
    useEffect(() => {
        workspaceService.list().then(setWorkspaces).catch(() => {})
        providerService.list().then(setProviders).catch(() => {})
        catalogService.list().then(setCatalogItems).catch(() => {})
        aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        aggregationService.getAggregationSettings()
            .then(s => {
                setDefaultTuning(s.tuning ?? undefined)
                setEnvFinePairs(s.envMaterializeFinePairs ?? undefined)
            })
            .catch(() => {})
    }, [])

    // Data source enrichment lookup
    const dsLookup = useMemo(
        () => buildDataSourceLookup(workspaces, providers, catalogItems),
        [workspaces, providers, catalogItems],
    )

    // Flat list of all data sources (for grouped view + health summary)
    const allDataSources = useMemo(
        () => workspaces.flatMap(w => w.dataSources ?? []),
        [workspaces],
    )

    // Auto-refresh relative timestamps every 30s
    useEffect(() => {
        const interval = setInterval(() => setTick(t => t + 1), 30_000)
        return () => clearInterval(interval)
    }, [])

    // Derived dropdown options
    const workspaceOptions = useMemo<DropdownOption[]>(
        () => workspaces.map(ws => ({ id: ws.id, label: ws.name })),
        [workspaces],
    )
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

    // Fetch jobs — for grouped mode fetch with max limit (100) to get more jobs per source
    const fetchJobs = useCallback(async () => {
        try {
            const fetchFilters = viewMode === 'grouped'
                ? { ...filters, limit: 100, offset: 0 }
                : filters
            const result = await aggregationService.listJobsGlobal(fetchFilters)
            setData(result)
        } catch (err) {
            console.error('Failed to fetch global job history', err)
        } finally {
            setIsLoading(false)
        }
    }, [filters, viewMode])

    // Intentionally do NOT set isLoading=true here — that would force a
    // synchronous re-render before the transition commits. The previous data
    // stays visible while the new fetch runs; the refresh button still owns
    // its own spinner via handleRefresh.
    useEffect(() => { fetchJobs() }, [fetchJobs])

    // Poll while active jobs exist. Cadence relaxed from 3s → 10s
    // because per-row ``useJob`` now drives live progress via SSE.
    // Polling here is the safety-net for: (a) list-level changes
    // (new job appearing, status flipping to terminal so the row
    // can be re-rendered with durable values), and (b) the
    // Redis-down fallback path. Live counter freshness is owned by
    // SSE; this poll only refreshes the durable shape of the list.
    const mountedAtRef = useRef(Date.now())
    // Derived boolean — depending on this instead of ``data?.items``
    // (a fresh array reference on every poll) keeps the interval from
    // being torn down + reinstalled every 10s while polling.
    const isPolling = useMemo(
        () => !!data?.items.some(j => j.status === 'pending' || j.status === 'running'),
        [data?.items],
    )
    useEffect(() => {
        const withinStartupWindow = Date.now() - mountedAtRef.current < 15_000
        if (!isPolling && !withinStartupWindow) return
        const interval = setInterval(() => {
            fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        }, 10_000)
        return () => clearInterval(interval)
    }, [isPolling, fetchJobs])

    // Filter helpers — memoized so memo'd children (FilterBar, KPIs, GroupedView)
    // don't re-render purely because callback identity changed.
    const updateFilter = useCallback((patch: Partial<JobHistoryFilters>) =>
        setFilters(prev => ({ ...prev, ...patch, offset: 0 })),
        [setFilters],
    )

    const toggleStatusFilter = useCallback((s: string) => {
        const current = filters.status ?? []
        const next = current.includes(s) ? current.filter(x => x !== s) : [...current, s]
        updateFilter({ status: next.length > 0 ? next : undefined })
    }, [filters.status, updateFilter])

    const clearFilters = useCallback(() => {
        setFilters({ limit: PAGE_SIZE, offset: 0 })
        setSearchInput('')
    }, [setFilters])

    // Debounced search
    const handleSearchInput = useCallback((value: string) => {
        setSearchInput(value)
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = setTimeout(() => {
            updateFilter({ search: value || undefined })
        }, 400)
    }, [updateFilter])

    // Stable callback for the KPIs "Show failed" button — passing an inline
    // arrow defeats JobHistoryKPIs' React.memo.
    const handleShowFailed = useCallback(
        () => updateFilter({ status: ['failed'] }),
        [updateFilter],
    )

    // Active filter chips
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
            chips.push({ key: 'trigger', label: triggerLabel(filters.triggerSource) })
        }
        for (const s of filters.status ?? []) {
            chips.push({ key: `status-${s}`, label: STATUS_CONFIG[s]?.label ?? s })
        }
        if (filters.dateFrom) chips.push({ key: 'dateFrom', label: `From ${filters.dateFrom}` })
        if (filters.dateTo) chips.push({ key: 'dateTo', label: `To ${filters.dateTo}` })
        if (filters.search) chips.push({ key: 'search', label: `"${filters.search}"` })
        return chips
    }, [filters, workspaces, dataSourceOptions])

    const removeChip = useCallback((key: string) => {
        if (key === 'workspace') updateFilter({ workspaceId: undefined, dataSourceId: undefined })
        else if (key.startsWith('ds-')) updateFilter({ dataSourceId: (filters.dataSourceId ?? []).filter(d => d !== key.replace('ds-', '')) || undefined })
        else if (key === 'mode') updateFilter({ projectionMode: undefined })
        else if (key === 'trigger') updateFilter({ triggerSource: undefined })
        else if (key.startsWith('status-')) toggleStatusFilter(key.replace('status-', ''))
        else if (key === 'dateFrom') updateFilter({ dateFrom: undefined })
        else if (key === 'dateTo') updateFilter({ dateTo: undefined })
        else if (key === 'search') { updateFilter({ search: undefined }); setSearchInput('') }
    }, [filters.dataSourceId, updateFilter, toggleStatusFilter])

    // Job actions
    // `failureMsg` is per-caller: "Action failed" told an operator neither
    // which of these actions failed nor which job it was for. `||` rather
    // than `??` — an error carrying an empty message must not render as an
    // empty notification.
    const withAction = useCallback(async (jobId: string, fn: () => Promise<unknown>, successMsg: string, failureMsg: string) => {
        setActionLoading(jobId)
        try {
            await fn()
            notify('success', successMsg)
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            notify('error', err?.message || failureMsg)
        } finally {
            setActionLoading(null)
        }
    }, [notify, fetchJobs])

    const handleCancel = useCallback((job: AggregationJobResponse) =>
        withAction(job.id, () => aggregationService.cancelJob(job.dataSourceId, job.id), 'Job cancelled', 'Could not cancel that job.'),
        [withAction],
    )

    // Both Resume and Re-trigger buttons on JobRow open the same dialog. The
    // user picks the action inside (Resume preserves last_cursor; Re-trigger
    // starts from scratch). This keeps the headline timeout-recovery flow on
    // a single path so users can always tweak timeout/batch_size before retry.
    //
    // Wrapping the dialog-opening setters in startTransition keeps the click
    // event from blocking on the modal mount (RetriggerDialog pulls in
    // AggregationOverridesForm, three radix tooltip providers, and a few
    // framer-motion roots — easily 150–250ms of synchronous work). The dialog
    // appears one frame later, which still reads as instant.
    const handleResume = useCallback((job: AggregationJobResponse) => {
        startTransition(() => {
            setRetriggerCtx({ kind: 'job', job, initialValue: buildInitialOverridesFromJob(job, defaultTuning) })
        })
    }, [defaultTuning])

    const handleRetrigger = useCallback((job: AggregationJobResponse) => {
        startTransition(() => {
            setRetriggerCtx({ kind: 'job', job, initialValue: buildInitialOverridesFromJob(job, defaultTuning) })
        })
    }, [defaultTuning])

    const handleDelete = useCallback((job: AggregationJobResponse) => {
        startTransition(() => setConfirmDelete(job))
    }, [])

    const executeConfirmedDelete = () => {
        if (!confirmDelete) return
        const job = confirmDelete
        setConfirmDelete(null)
        withAction(job.id, () => aggregationService.deleteJob(job.id), 'Job removed from history', 'Could not remove that job from the history.')
    }

    /**
     * Run an aggregation trigger/resume from the dialog.
     * Throws on failure so the dialog stays open with the user's overrides.
     */
    const runDialogAction = useCallback(async (
        loadingKey: string,
        action: () => Promise<unknown>,
        successMsg: string,
        failureMsg: string,
    ) => {
        showLoading(loadingKey, 'Submitting…')
        try {
            await action()
            hideLoading(loadingKey)
            notify('success', successMsg)
            setViewMode('flat')  // ensure user lands somewhere they can see the new job
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            hideLoading(loadingKey)
            notify('error', err?.message || failureMsg)
            throw err
        }
    }, [showLoading, hideLoading, notify, setViewMode, fetchJobs])

    const handleConfirmRetrigger = useCallback(async (overrides: AggregationOverridesValue) => {
        if (!retriggerCtx) return
        const dsId = retriggerCtx.kind === 'job' ? retriggerCtx.job.dataSourceId : retriggerCtx.dataSourceId
        await runDialogAction(
            `retrigger-${dsId}`,
            () => aggregationService.triggerAggregation(dsId, {
                projectionMode: overrides.projectionMode,
                batchSize: overrides.batchSize,
                maxRetries: overrides.maxRetries,
                timeoutSecs: overrides.timeoutMinutes * 60,
                tuning: tuningForRequest(overrides.tuning),
            }, 'manual'),
            'Aggregation triggered',
            'Could not trigger the aggregation.',
        )
    }, [retriggerCtx, runDialogAction])

    const handleConfirmResume = useCallback(async (overrides: AggregationOverridesValue) => {
        if (!retriggerCtx || retriggerCtx.kind !== 'job') return
        const { job } = retriggerCtx
        await runDialogAction(
            `resume-${job.id}`,
            () => aggregationService.resumeJob(job.dataSourceId, job.id, {
                projectionMode: overrides.projectionMode,
                batchSize: overrides.batchSize,
                maxRetries: overrides.maxRetries,
                timeoutSecs: overrides.timeoutMinutes * 60,
                tuning: tuningForRequest(overrides.tuning),
            }),
            'Job resumed from checkpoint',
            'Could not resume that job.',
        )
    }, [retriggerCtx, runDialogAction])

    const handlePurge = useCallback(async (job: AggregationJobResponse) => {
        setPurgeConfirm(null)
        setActionLoading(job.id)
        try {
            const result = await aggregationService.purgeAggregation(job.dataSourceId)
            notify('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            notify('error', err?.message || 'Could not purge the aggregated edges. Nothing was deleted.')
        } finally {
            setActionLoading(null)
        }
    }, [notify, fetchJobs])

    // Data source-level actions (for grouped view) — opens the overrides dialog.
    // startTransition rationale: same as handleResume/handleRetrigger above.
    const handleTriggerAggregation = useCallback((dataSourceId: string) => {
        const meta = dsLookup.get(dataSourceId)
        startTransition(() => {
            setRetriggerCtx({
                kind: 'dataSource',
                dataSourceId,
                dataSourceLabel: meta?.label ?? dataSourceId,
                initialValue: buildInitialOverridesForDataSource(meta?.projectionMode, defaultTuning),
            })
        })
    }, [dsLookup, defaultTuning])

    const handlePurgeDataSource = useCallback(async (dataSourceId: string) => {
        setActionLoading(dataSourceId)
        try {
            const result = await aggregationService.purgeAggregation(dataSourceId)
            notify('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            notify('error', err?.message || 'Could not purge the aggregated edges. Nothing was deleted.')
        } finally {
            setActionLoading(null)
        }
    }, [notify, fetchJobs])

    // "Show all jobs" for a specific data source (switches to flat view with filter)
    const handleShowAllJobs = useCallback((dataSourceId: string) => {
        setViewMode('flat')
        updateFilter({ dataSourceId: [dataSourceId] })
    }, [setViewMode, updateFilter])

    // Pagination (flat view only)
    const total = data?.total ?? 0
    const currentPage = Math.floor((filters.offset ?? 0) / PAGE_SIZE) + 1
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const goToPage = useCallback((page: number) =>
        setFilters(prev => ({ ...prev, offset: (page - 1) * PAGE_SIZE })),
        [setFilters],
    )

    const handleRefresh = useCallback(() => {
        setIsLoading(true)
        fetchJobs()
        aggregationService.getJobsSummary().then(setSummary).catch(() => {})
    }, [fetchJobs])

    // Stable per-row toggle so the inline arrow at the JobRow callsite doesn't
    // get recreated every render (which would defeat JobRow's React.memo and
    // re-render all 25-100 rows on any parent state change — the cause of the
    // 264ms td-click and the row-cascade after Play/Resume opens the dialog).
    const handleToggleRow = useCallback((id: string) => {
        setExpandedRowId(prev => prev === id ? null : id)
    }, [])

    return (
        <div className="flex flex-col h-full animate-in fade-in duration-300">
            {/* ── Pinned toolbar: header + KPIs + filters ── */}
            <div className="shrink-0 pt-6 pb-4 border-b border-glass-border/40 bg-canvas">
                <PageContainer className="space-y-4">
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

                        {/* View mode toggle */}
                        <div className="flex items-center rounded-lg border border-glass-border overflow-hidden">
                            <button
                                onClick={() => setViewMode('grouped')}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors',
                                    viewMode === 'grouped'
                                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                                )}
                            >
                                <LayoutGrid className="w-3.5 h-3.5" />
                                Grouped
                            </button>
                            <div className="w-px h-5 bg-glass-border" />
                            <button
                                onClick={() => setViewMode('flat')}
                                className={cn(
                                    'flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium transition-colors',
                                    viewMode === 'flat'
                                        ? 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400'
                                        : 'text-ink-muted hover:text-ink hover:bg-black/[0.04] dark:hover:bg-white/[0.04]',
                                )}
                            >
                                <List className="w-3.5 h-3.5" />
                                Flat
                            </button>
                        </div>

                        <button
                            onClick={handleRefresh}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                            <RotateCcw className={cn('w-3.5 h-3.5', isLoading && 'animate-spin')} /> Refresh
                        </button>
                    </div>

                    {/* KPIs + Health Summary */}
                    <JobHistoryKPIs
                        summary={summary}
                        filteredJobs={data?.items ?? []}
                        hasActiveFilters={activeChips.length > 0}
                        allDataSources={allDataSources}
                        onShowFailed={handleShowFailed}
                    />

                    {/* Filters */}
                    <JobHistoryFilterBar
                        filters={filters}
                        searchInput={searchInput}
                        onSearchInput={handleSearchInput}
                        updateFilter={updateFilter}
                        toggleStatusFilter={toggleStatusFilter}
                        clearFilters={clearFilters}
                        workspaceOptions={workspaceOptions}
                        dataSourceOptions={dataSourceOptions}
                        activeChips={activeChips}
                        removeChip={removeChip}
                    />
                </PageContainer>
            </div>

            {/* ── Scrollable content area ── */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                <PageContainer className="py-4">

            {/* ── Grouped View ── */}
            {viewMode === 'grouped' && (
                <JobHistoryGroupedView
                    jobs={data?.items ?? []}
                    dsLookup={dsLookup}
                    allDataSources={allDataSources}
                    isLoading={isLoading}
                    hasActiveFilters={activeChips.length > 0}
                    onClearFilters={clearFilters}
                    onCancel={handleCancel}
                    onResume={handleResume}
                    onRetrigger={handleRetrigger}
                    onDelete={handleDelete}
                    onPurge={handlePurge}
                    onTriggerAggregation={handleTriggerAggregation}
                    onPurgeDataSource={handlePurgeDataSource}
                    onShowAllJobs={handleShowAllJobs}
                    actionLoading={actionLoading}
                    purgeConfirm={purgeConfirm}
                    setPurgeConfirm={setPurgeConfirm}
                />
            )}

            {/* ── Flat View ── */}
            {viewMode === 'flat' && (
                <>
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
                                        {data.items.map((job, i) => (
                                            <JobRow
                                                key={job.id}
                                                job={job}
                                                previousJob={data.items.slice(i + 1).find(
                                                    j => j.dataSourceId === job.dataSourceId
                                                        && j.status === 'completed'
                                                        && j.triggerSource !== 'purge'
                                                )}
                                                meta={dsLookup.get(job.dataSourceId)}
                                                expanded={expandedRowId === job.id}
                                                onToggle={handleToggleRow}
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
                </>
            )}

                </PageContainer>
            </div>

            {/* Confirm Dialog for Delete only */}
            <ConfirmDialog
                open={!!confirmDelete}
                title="Delete job from history"
                message={`Remove job ${confirmDelete?.id ?? ''} from history? This only deletes the record — aggregated edges in the graph are not affected.`}
                confirmLabel="Delete"
                confirmColor="bg-red-500 hover:bg-red-600 shadow-lg shadow-red-500/25"
                confirmIcon={Trash2}
                onConfirm={executeConfirmedDelete}
                onCancel={() => setConfirmDelete(null)}
                loading={!!actionLoading}
            />

            {/* Re-trigger / Resume dialog with override knobs */}
            <RetriggerDialog
                isOpen={!!retriggerCtx}
                onClose={() => setRetriggerCtx(null)}
                title={
                    retriggerCtx?.kind === 'job'
                        ? 'Re-trigger aggregation'
                        : retriggerCtx?.kind === 'dataSource'
                            ? `Trigger aggregation — ${retriggerCtx.dataSourceLabel}`
                            : 'Re-trigger aggregation'
                }
                initialValue={retriggerCtx?.initialValue ?? {
                    batchSize: DEFAULT_BATCH_SIZE,
                    projectionMode: 'in_source',
                    maxRetries: DEFAULT_MAX_RETRIES,
                    timeoutMinutes: Math.round(DEFAULT_TIMEOUT_SECS / 60),
                    tuning: defaultTuning,
                }}
                originatingJob={retriggerCtx?.kind === 'job' ? {
                    id: retriggerCtx.job.id,
                    lastCursor: retriggerCtx.job.lastCursor ?? null,
                    status: retriggerCtx.job.status,
                } : undefined}
                defaultFinePairs={envFinePairs}
                onConfirmRetrigger={handleConfirmRetrigger}
                onConfirmResume={retriggerCtx?.kind === 'job' ? handleConfirmResume : undefined}
            />
        </div>
    )
}

export default RegistryJobHistory
