import { Database, Star, GitBranch, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { getProviderLogo } from '../ProviderLogos'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

interface DataSourceGridCardProps {
    ds: DataSourceResponse
    stats?: DataSourceStats
    providerInfo?: DataSourceProviderInfo
    ontologyName?: string
    ontologyVersion?: number
    ontologyPublished?: boolean
    viewCount: number
    isSelected: boolean
    onSelect: () => void
    onSetPrimary?: () => void
}

function AggregationStatusBadge({ status }: { status: string }) {
    const configs: Record<string, { label: string; dot: string; text: string }> = {
        ready: { label: 'Ready', dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400' },
        running: { label: 'Running', dot: 'bg-indigo-400 animate-pulse', text: 'text-indigo-600 dark:text-indigo-400' },
        pending: { label: 'Pending', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-600 dark:text-amber-400' },
        failed: { label: 'Failed', dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400' },
        skipped: { label: 'Skipped', dot: 'bg-gray-400', text: 'text-ink-muted' },
        none: { label: 'Not Started', dot: 'bg-gray-400', text: 'text-ink-muted' },
    }
    const cfg = configs[status] || configs.none
    return (
        <span className={cn('flex items-center gap-1.5 text-[11px] font-medium', cfg.text)}>
            <span className={cn('w-2 h-2 rounded-full', cfg.dot)} />
            {cfg.label}
        </span>
    )
}

export function DataSourceGridCard({
    ds,
    stats,
    providerInfo,
    ontologyName,
    ontologyVersion,
    ontologyPublished,
    viewCount,
    isSelected,
    onSelect,
    onSetPrimary,
}: DataSourceGridCardProps) {
    const ProviderLogo = providerInfo ? getProviderLogo(providerInfo.providerType) : null

    return (
        <div
            onClick={onSelect}
            className={cn(
                'border rounded-xl cursor-pointer transition-all duration-200 group overflow-hidden',
                isSelected
                    ? 'border-indigo-500/40 bg-indigo-500/[0.03] dark:bg-indigo-500/[0.05] shadow-md ring-1 ring-indigo-500/20'
                    : 'border-glass-border bg-canvas-elevated hover:border-indigo-500/20 hover:shadow-md hover:-translate-y-0.5',
            )}
        >
            {/* Provider accent bar at top */}
            <div className={cn(
                "h-1 w-full",
                providerInfo?.providerType === 'neo4j' ? 'bg-gradient-to-r from-blue-500 to-blue-400' :
                providerInfo?.providerType === 'falkordb' ? 'bg-gradient-to-r from-purple-500 via-pink-500 to-orange-400' :
                providerInfo?.providerType === 'datahub' ? 'bg-gradient-to-r from-blue-600 via-orange-400 to-red-500' :
                'bg-gradient-to-r from-indigo-500 to-violet-500'
            )} />

            <div className="p-4">
                {/* Header */}
                <div className="flex items-start justify-between mb-3">
                    <div className="flex items-center gap-3 min-w-0">
                        <div className={cn(
                            'w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border',
                            ds.isPrimary
                                ? 'bg-indigo-500/10 border-indigo-500/20'
                                : 'bg-black/[0.03] dark:bg-white/[0.03] border-glass-border',
                        )}>
                            {ProviderLogo ? (
                                <ProviderLogo className="w-5 h-5" />
                            ) : (
                                <Database className={cn("w-5 h-5", ds.isPrimary ? 'text-indigo-500' : 'text-ink-muted')} />
                            )}
                        </div>
                        <div className="min-w-0">
                            <h4 className="text-sm font-bold text-ink truncate">
                                {ds.label || providerInfo?.catalogItemName || 'Unnamed Source'}
                            </h4>
                            {providerInfo && (
                                <div className="flex items-center gap-1.5 mt-0.5">
                                    <span className="text-[10px] text-ink-muted font-medium">
                                        {providerInfo.providerName}
                                    </span>
                                    {providerInfo.sourceIdentifier && (
                                        <>
                                            <span className="text-[10px] text-ink-muted/50">/</span>
                                            <span className="text-[10px] text-ink-muted font-mono truncate max-w-[120px]">
                                                {providerInfo.sourceIdentifier}
                                            </span>
                                        </>
                                    )}
                                </div>
                            )}
                            {!providerInfo && (
                                <p className="text-[10px] text-ink-muted font-mono truncate">{ds.catalogItemId}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                        {ds.isPrimary && (
                            <span className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                <Star className="w-2.5 h-2.5" /> Primary
                            </span>
                        )}
                        {!ds.isPrimary && onSetPrimary && (
                            <button
                                onClick={(e) => { e.stopPropagation(); onSetPrimary() }}
                                className="px-2 py-0.5 text-[10px] font-medium rounded-full text-ink-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors opacity-0 group-hover:opacity-100"
                            >
                                Set Primary
                            </button>
                        )}
                    </div>
                </div>

                {/* Status + Ontology */}
                <div className="flex items-center justify-between mb-3">
                    <AggregationStatusBadge status={ds.aggregationStatus} />
                    {ontologyName && (
                        <span className="flex items-center gap-1 text-[11px] text-ink-muted">
                            <GitBranch className="w-3 h-3" />
                            {ontologyName} v{ontologyVersion}
                            {ontologyPublished ? (
                                <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-emerald-500/10 text-emerald-500">PUB</span>
                            ) : (
                                <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-amber-500/10 text-amber-500">DRAFT</span>
                            )}
                        </span>
                    )}
                </div>

                {/* Stats */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                    <div className="p-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center">
                        <div className="text-sm font-bold text-ink">{stats ? compactNum(stats.nodeCount) : '\u2014'}</div>
                        <div className="text-[9px] text-ink-muted uppercase tracking-wider">Nodes</div>
                    </div>
                    <div className="p-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center">
                        <div className="text-sm font-bold text-ink">{stats ? compactNum(stats.edgeCount) : '\u2014'}</div>
                        <div className="text-[9px] text-ink-muted uppercase tracking-wider">Edges</div>
                    </div>
                    <div className="p-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center">
                        <div className="text-sm font-bold text-ink">{viewCount}</div>
                        <div className="text-[9px] text-ink-muted uppercase tracking-wider">Views</div>
                    </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between text-[10px] text-ink-muted">
                    <div className="flex items-center gap-3">
                        <span>Updated {new Date(ds.updatedAt).toLocaleDateString()}</span>
                        {ds.lastAggregatedAt && (
                            <span>&middot; Aggregated {new Date(ds.lastAggregatedAt).toLocaleDateString()}</span>
                        )}
                    </div>
                    <span className="flex items-center gap-0.5 text-indigo-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity">
                        Inspect <ChevronRight className="w-3 h-3" />
                    </span>
                </div>
            </div>
        </div>
    )
}
