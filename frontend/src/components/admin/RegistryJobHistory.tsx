/**
 * RegistryJobHistory — Orchestrator for the global aggregation job history tab.
 *
 * Supports two view modes:
 *   - Grouped (default): jobs grouped by data source with summary headers
 *   - Flat: traditional paginated table
 *
 * All sub-components live in ./job-history/
 */
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
    Loader2, Activity, RotateCcw, Play, Trash2,
    ChevronLeft, ChevronsLeft, ChevronRight, ChevronsRight,
    List, LayoutGrid,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    aggregationService,
    type AggregationJobResponse,
    type JobHistoryFilters,
    type JobsSummary,
    type PaginatedJobsResponse,
} from '@/services/aggregationService'
import { workspaceService, type WorkspaceResponse } from '@/services/workspaceService'
import { providerService, type ProviderResponse } from '@/services/providerService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import { useToast } from '@/components/ui/toast'
import {
    buildDataSourceLookup,
    filtersToParams, paramsToFilters,
    STATUS_CONFIG, PAGE_SIZE,
    type DropdownOption,
} from './job-history/shared'
import { JobRow } from './job-history/JobRow'
import { ConfirmDialog } from './job-history/ConfirmDialog'
import { JobHistoryFilterBar } from './job-history/JobHistoryFilterBar'
import { JobHistoryKPIs } from './job-history/JobHistoryKPIs'
import { JobHistoryGroupedView } from './job-history/JobHistoryGroupedView'

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
        setViewModeRaw(mode)
        const p = new URLSearchParams(searchParams)
        p.set('view', mode)
        setSearchParams(p, { replace: true })
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
    const [confirmAction, setConfirmAction] = useState<{ job: AggregationJobResponse; type: 'delete' | 'retrigger' } | null>(null)
    const [searchInput, setSearchInput] = useState(filters.search ?? '')
    const [, setTick] = useState(0)
    const { showToast } = useToast()
    const searchTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)

    // Sync filters -> URL
    const setFilters = useCallback((updater: JobHistoryFilters | ((prev: JobHistoryFilters) => JobHistoryFilters)) => {
        setFiltersRaw(prev => {
            const next = typeof updater === 'function' ? updater(prev) : updater
            const newParams = filtersToParams(next)
            newParams.set('tab', 'jobs')
            newParams.set('view', viewMode)
            setSearchParams(newParams, { replace: true })
            return next
        })
    }, [setSearchParams, viewMode])

    // Load reference data + summary
    useEffect(() => {
        workspaceService.list().then(setWorkspaces).catch(() => {})
        providerService.list().then(setProviders).catch(() => {})
        catalogService.list().then(setCatalogItems).catch(() => {})
        aggregationService.getJobsSummary().then(setSummary).catch(() => {})
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

    // Debounced search
    const handleSearchInput = (value: string) => {
        setSearchInput(value)
        clearTimeout(searchTimerRef.current)
        searchTimerRef.current = setTimeout(() => {
            updateFilter({ search: value || undefined })
        }, 400)
    }

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

    useEffect(() => { setIsLoading(true); fetchJobs() }, [fetchJobs])

    // Poll while active jobs exist
    const mountedAtRef = useRef(Date.now())
    useEffect(() => {
        const hasActive = data?.items.some(j => j.status === 'pending' || j.status === 'running')
        const withinStartupWindow = Date.now() - mountedAtRef.current < 15_000
        if (!hasActive && !withinStartupWindow) return
        const interval = setInterval(() => {
            fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        }, 3000)
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

    // Job actions
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

    // Data source-level actions (for grouped view)
    const handleTriggerAggregation = (dataSourceId: string) => {
        const dsId = dataSourceId
        withAction(dsId, () => aggregationService.triggerAggregation(dsId, {
            projectionMode: dsLookup.get(dsId)?.projectionMode ?? 'in_source',
            batchSize: 1000,
        }, 'manual'), 'Aggregation triggered')
    }

    const handlePurgeDataSource = async (dataSourceId: string) => {
        setActionLoading(dataSourceId)
        try {
            const result = await aggregationService.purgeAggregation(dataSourceId)
            showToast('success', `Purged ${result.deletedEdges.toLocaleString()} aggregated edges`)
            await fetchJobs()
            aggregationService.getJobsSummary().then(setSummary).catch(() => {})
        } catch (err: any) {
            showToast('error', err?.message ?? 'Purge failed')
        } finally {
            setActionLoading(null)
        }
    }

    // "Show all jobs" for a specific data source (switches to flat view with filter)
    const handleShowAllJobs = (dataSourceId: string) => {
        setViewMode('flat')
        updateFilter({ dataSourceId: [dataSourceId] })
    }

    // Pagination (flat view only)
    const total = data?.total ?? 0
    const currentPage = Math.floor((filters.offset ?? 0) / PAGE_SIZE) + 1
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
    const goToPage = (page: number) => setFilters(prev => ({ ...prev, offset: (page - 1) * PAGE_SIZE }))

    const isPolling = !!data?.items.some(j => j.status === 'pending' || j.status === 'running')

    const handleRefresh = () => {
        setIsLoading(true)
        fetchJobs()
        aggregationService.getJobsSummary().then(setSummary).catch(() => {})
    }

    return (
        <div className="flex flex-col h-full animate-in fade-in duration-300">
            {/* ── Pinned toolbar: header + KPIs + filters ── */}
            <div className="shrink-0 px-8 pt-6 pb-4 space-y-4 border-b border-glass-border/40 bg-canvas">
                <div className="max-w-7xl mx-auto space-y-4">
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
                        allDataSources={allDataSources}
                        onShowFailed={() => updateFilter({ status: ['failed'] })}
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
                </div>
            </div>

            {/* ── Scrollable content area ── */}
            <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="px-8 py-4 max-w-7xl mx-auto">

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
                                        {data.items.map(job => (
                                            <JobRow
                                                key={job.id}
                                                job={job}
                                                meta={dsLookup.get(job.dataSourceId)}
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
                </>
            )}

                </div>
            </div>

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

export default RegistryJobHistory
