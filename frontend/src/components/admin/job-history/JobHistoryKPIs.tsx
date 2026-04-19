import { motion } from 'framer-motion'
import {
    Activity, TrendingUp, Timer, AlertTriangle, AlertCircle,
} from 'lucide-react'
import type { JobsSummary } from '@/services/aggregationService'
import type { DataSourceResponse } from '@/services/workspaceService'
import { formatDuration } from './shared'
import { KpiCard } from './JobRow'

interface JobHistoryKPIsProps {
    summary: JobsSummary | null
    allDataSources: DataSourceResponse[]
    onShowFailed: () => void
}

export function JobHistoryKPIs({ summary, allDataSources, onShowFailed }: JobHistoryKPIsProps) {
    const failedCount = summary?.byStatus?.failed ?? 0

    // System health summary from data source statuses
    const healthCounts = allDataSources.reduce(
        (acc, ds) => {
            const status = ds.aggregationStatus ?? 'none'
            if (status === 'ready') acc.healthy++
            else if (status === 'running') acc.running++
            else if (status === 'pending') acc.pending++
            else if (status === 'failed') acc.attention++
            else acc.other++
            return acc
        },
        { healthy: 0, running: 0, pending: 0, attention: 0, other: 0 },
    )

    return (
        <>
            {/* System Health Summary */}
            {allDataSources.length > 0 && (
                <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                    {healthCounts.healthy > 0 && (
                        <span className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                            {healthCounts.healthy} source{healthCounts.healthy !== 1 ? 's' : ''} healthy
                        </span>
                    )}
                    {healthCounts.running > 0 && (
                        <span className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                            {healthCounts.running} running
                        </span>
                    )}
                    {healthCounts.pending > 0 && (
                        <span className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            {healthCounts.pending} pending
                        </span>
                    )}
                    {healthCounts.attention > 0 && (
                        <span className="flex items-center gap-1.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
                            {healthCounts.attention} need{healthCounts.attention !== 1 ? '' : 's'} attention
                        </span>
                    )}
                </div>
            )}

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
                        onClick={onShowFailed}
                        className="text-[11px] font-semibold text-red-400 hover:text-red-300 transition-colors whitespace-nowrap"
                    >
                        Show failed
                    </button>
                </motion.div>
            )}
        </>
    )
}
