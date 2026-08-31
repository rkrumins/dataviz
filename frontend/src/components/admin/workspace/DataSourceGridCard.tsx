import { memo } from 'react'
import { Database, Star, GitBranch, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import { resolveSourceMode } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { providerVisual } from '@/services/providerTypes'
import { NodeIdentityBadge } from '@/components/dataSource/NodeIdentity'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'

function compactNum(n: number): string {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`
    return String(n)
}

/**
 * Provenance at a glance — the "will Delete touch the underlying data?" cue.
 *
 * Managed: a graph we generated; a permanent Delete drops it. External: pinned to the customer's
 * own graph; Delete only removes our overlay/version history and never touches their data. (The
 * authoritative, per-graph verdict is the delete dialog's ownership caveat; this is the provenance
 * shorthand.)
 */
function SourceModeChip({ mode }: { mode: 'managed' | 'federated' }) {
    const managed = mode === 'managed'
    return (
        <span
            title={
                managed
                    ? 'Managed graph — we generated it. Deleting this source can drop the graph.'
                    : 'External graph — belongs to your provider. Deleting this source never touches its data.'
            }
            className={cn(
                'px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-full border',
                managed
                    ? 'bg-violet-500/10 text-violet-600 dark:text-violet-400 border-violet-500/20'
                    : 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/20',
            )}
        >
            {managed ? 'Managed' : 'External'}
        </span>
    )
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

function DataSourceGridCardBase({
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
    const ProviderLogo = providerInfo ? providerVisual(providerInfo.providerType).Logo : null

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
            <div className={cn("h-1 w-full", providerVisual(providerInfo?.providerType).accent)} />

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

                {/* Status + Ontology — operational status (not the opt-in
                    aggregation state, which is a per-source detail). */}
                <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                        <span className={cn('flex items-center gap-1.5 text-[11px] font-semibold', ds.isActive ? 'text-emerald-600 dark:text-emerald-400' : 'text-ink-muted')}>
                            <span className={cn('w-2 h-2 rounded-full', ds.isActive ? 'bg-emerald-400' : 'bg-gray-400')} />
                            {ds.isActive ? 'Active' : 'Inactive'}
                        </span>
                        <SourceModeChip mode={resolveSourceMode(ds)} />
                        <NodeIdentityBadge value={ds.identityProperty} />
                    </div>
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
                    <div className="p-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center" title={stats?.computing ? 'Stats are being computed \u2014 check back shortly.' : undefined}>
                        <div className="text-sm font-bold text-ink">
                            {stats?.computing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted mx-auto" /> : stats ? compactNum(stats.nodeCount) : '\u2014'}
                        </div>
                        <div className="text-[9px] text-ink-muted uppercase tracking-wider">Nodes</div>
                    </div>
                    <div className="p-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center" title={stats?.computing ? 'Stats are being computed \u2014 check back shortly.' : undefined}>
                        <div className="text-sm font-bold text-ink">
                            {stats?.computing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted mx-auto" /> : stats ? compactNum(stats.edgeCount) : '\u2014'}
                        </div>
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

// Memoized: in a workspace's data-source grid these render in a .map, so this
// keeps a card from re-rendering when a sibling/parent changes. (Full benefit
// needs the parent to pass stable onSelect/onSetPrimary via useCallback.)
export const DataSourceGridCard = memo(DataSourceGridCardBase)
