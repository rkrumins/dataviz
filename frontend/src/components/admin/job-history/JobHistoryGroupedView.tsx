import { useState, useMemo, useEffect, useRef } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
    Activity, Loader2, ArrowUpDown, AlertTriangle,
} from 'lucide-react'
import type { AggregationJobResponse } from '@/services/aggregationService'
import type { DataSourceResponse } from '@/services/workspaceService'
import { type DataSourceMeta } from './shared'
import {
    DataSourceGroupCard,
    buildGroups,
    sortGroups,
    type DataSourceGroup,
    type GroupSortKey,
} from './DataSourceGroupCard'

// ── Failure Correlation ──────────────────────────────────────────────

function detectFailureCorrelation(groups: DataSourceGroup[]): { count: number; timeRange: string } | null {
    const recentFailures: { dsLabel: string; at: number }[] = []
    for (const g of groups) {
        const failedJob = g.jobs.find(j => j.status === 'failed' && j.completedAt)
        if (failedJob?.completedAt) {
            recentFailures.push({ dsLabel: g.meta.label, at: new Date(failedJob.completedAt).getTime() })
        }
    }
    if (recentFailures.length < 2) return null

    recentFailures.sort((a, b) => a.at - b.at)
    const windowMs = 15 * 60 * 1000 // 15 minutes

    // Sliding window check
    for (let i = 0; i < recentFailures.length; i++) {
        const cluster = recentFailures.filter(f => f.at >= recentFailures[i].at && f.at <= recentFailures[i].at + windowMs)
        if (cluster.length >= 2) {
            const earliest = new Date(cluster[0].at)
            const latest = new Date(cluster[cluster.length - 1].at)
            const fmt = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            return {
                count: cluster.length,
                timeRange: `${fmt(earliest)}\u2013${fmt(latest)}`,
            }
        }
    }
    return null
}

// ── Sort Options ─────────────────────────────────────────────────────

const SORT_OPTIONS: { key: GroupSortKey; label: string }[] = [
    { key: 'attention', label: 'Attention Priority' },
    { key: 'alpha', label: 'Alphabetical' },
    { key: 'recent', label: 'Last Run' },
    { key: 'runs', label: 'Most Runs' },
    { key: 'success-rate', label: 'Success Rate' },
]

// ── Main Component ───────────────────────────────────────────────────

interface JobHistoryGroupedViewProps {
    jobs: AggregationJobResponse[]
    dsLookup: Map<string, DataSourceMeta>
    allDataSources: DataSourceResponse[]
    isLoading: boolean
    hasActiveFilters: boolean
    onClearFilters: () => void
    onCancel: (job: AggregationJobResponse) => void
    onResume: (job: AggregationJobResponse) => void
    onRetrigger: (job: AggregationJobResponse) => void
    onDelete: (job: AggregationJobResponse) => void
    onPurge: (job: AggregationJobResponse) => void
    onTriggerAggregation: (dataSourceId: string) => void
    onPurgeDataSource: (dataSourceId: string) => void
    onShowAllJobs: (dataSourceId: string) => void
    actionLoading: string | null
    purgeConfirm: string | null
    setPurgeConfirm: (id: string | null) => void
}

export function JobHistoryGroupedView({
    jobs,
    dsLookup,
    allDataSources,
    isLoading,
    hasActiveFilters,
    onClearFilters,
    onCancel,
    onResume,
    onRetrigger,
    onDelete,
    onPurge,
    onTriggerAggregation,
    onPurgeDataSource,
    onShowAllJobs,
    actionLoading,
    purgeConfirm,
    setPurgeConfirm,
}: JobHistoryGroupedViewProps) {
    const [sortKey, setSortKey] = useState<GroupSortKey>('attention')
    const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set())
    const [expandedRowId, setExpandedRowId] = useState<string | null>(null)

    const groups = useMemo(() => {
        const built = buildGroups(jobs, dsLookup, allDataSources)
        return sortGroups(built, sortKey)
    }, [jobs, dsLookup, allDataSources, sortKey])

    // Auto-expand groups with active jobs on first render
    const didAutoExpand = useRef(false)
    useEffect(() => {
        if (didAutoExpand.current || groups.length === 0) return
        const activeIds = groups.filter(g => g.isActive).map(g => g.dataSourceId)
        if (activeIds.length > 0) {
            setExpandedGroups(new Set(activeIds))
            didAutoExpand.current = true
        }
    }, [groups])

    const failureCorrelation = useMemo(() => detectFailureCorrelation(groups), [groups])

    const toggleGroup = (dsId: string) => {
        setExpandedGroups(prev => {
            const next = new Set(prev)
            if (next.has(dsId)) next.delete(dsId)
            else next.add(dsId)
            return next
        })
    }

    const expandAll = () => setExpandedGroups(new Set(groups.map(g => g.dataSourceId)))
    const collapseAll = () => { setExpandedGroups(new Set()); setExpandedRowId(null) }

    const hiddenCount = allDataSources.length - groups.length

    // Loading
    if (isLoading && jobs.length === 0) {
        return (
            <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-500" />
            </div>
        )
    }

    // Empty
    if (groups.length === 0) {
        return (
            <div className="glass-panel rounded-xl border border-glass-border py-16 text-center">
                <Activity className="w-8 h-8 text-ink-muted/40 mx-auto mb-3" />
                <p className="text-sm text-ink-muted">No aggregation jobs found.</p>
                <p className="text-xs text-ink-muted/60 mt-1">
                    {hasActiveFilters
                        ? 'Try adjusting your filters to see more results.'
                        : 'Jobs will appear here once aggregation is triggered from a data source.'}
                </p>
                {hasActiveFilters && (
                    <button onClick={onClearFilters} className="mt-3 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
                        Clear all filters
                    </button>
                )}
            </div>
        )
    }

    return (
        <div className="space-y-3">
            {/* Failure Correlation Banner */}
            {failureCorrelation && (
                <motion.div
                    initial={{ opacity: 0, y: -8 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="flex items-center gap-3 px-4 py-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5"
                >
                    <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />
                    <span className="text-xs text-amber-400 flex-1">
                        <strong>{failureCorrelation.count} data sources</strong> failed between {failureCorrelation.timeRange} — possible infrastructure issue
                    </span>
                </motion.div>
            )}

            {/* Sort controls + expand/collapse */}
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <ArrowUpDown className="w-3.5 h-3.5 text-ink-muted/50" />
                    <select
                        value={sortKey}
                        onChange={e => setSortKey(e.target.value as GroupSortKey)}
                        className="bg-transparent text-[11px] font-medium text-ink-muted outline-none cursor-pointer hover:text-ink transition-colors"
                    >
                        {SORT_OPTIONS.map(opt => (
                            <option key={opt.key} value={opt.key}>{opt.label}</option>
                        ))}
                    </select>
                    <span className="text-[11px] text-ink-muted/40 ml-1">
                        {groups.length} source{groups.length !== 1 ? 's' : ''}
                    </span>
                </div>
                <div className="flex items-center gap-2">
                    <button
                        onClick={expandAll}
                        className="text-[11px] text-ink-muted hover:text-ink transition-colors"
                    >
                        Expand all
                    </button>
                    <span className="text-ink-muted/20">|</span>
                    <button
                        onClick={collapseAll}
                        className="text-[11px] text-ink-muted hover:text-ink transition-colors"
                    >
                        Collapse all
                    </button>
                </div>
            </div>

            {/* Group cards */}
            <div className="space-y-2">
                <AnimatePresence>
                    {groups.map(group => (
                        <DataSourceGroupCard
                            key={group.dataSourceId}
                            group={group}
                            expanded={expandedGroups.has(group.dataSourceId)}
                            onToggle={() => toggleGroup(group.dataSourceId)}
                            onCancel={onCancel}
                            onResume={onResume}
                            onRetrigger={onRetrigger}
                            onDelete={onDelete}
                            onPurge={onPurge}
                            onTriggerAggregation={onTriggerAggregation}
                            onPurgeDataSource={onPurgeDataSource}
                            onShowAllJobs={onShowAllJobs}
                            expandedRowId={expandedRowId}
                            setExpandedRowId={setExpandedRowId}
                            purgeConfirm={purgeConfirm}
                            setPurgeConfirm={setPurgeConfirm}
                            actionLoading={actionLoading}
                        />
                    ))}
                </AnimatePresence>
            </div>

            {/* Hidden by filters indicator */}
            {hiddenCount > 0 && hasActiveFilters && (
                <p className="text-center text-[11px] text-ink-muted/50 py-2">
                    {hiddenCount} source{hiddenCount !== 1 ? 's' : ''} hidden by filters
                </p>
            )}
        </div>
    )
}
