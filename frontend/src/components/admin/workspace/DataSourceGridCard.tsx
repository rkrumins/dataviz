import { memo } from 'react'
import { Database, Star, GitBranch, ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DataSourceResponse } from '@/services/workspaceService'
import { resolveSourceMode } from '@/services/workspaceService'
import type { DataSourceStats } from '@/hooks/useDashboardData'
import { getProviderLogo } from '../ProviderLogos'
import { NodeIdentityBadge } from '@/components/dataSource/NodeIdentity'
import type { DataSourceProviderInfo } from './useWorkspaceDetailData'
import type { DataSourceReadinessResponse } from '@/services/aggregationService'
import { usePersonaMode } from '@/store/persona'

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
    /** Live readiness, when the page has it: the card's status sentence. */
    readiness?: DataSourceReadinessResponse
    ontologyName?: string
    ontologyVersion?: number
    ontologyPublished?: boolean
    viewCount: number
    isSelected: boolean
    onSelect: () => void
    onSetPrimary?: () => void
}

const PROVIDER_NAMES: Record<string, string> = { neo4j: 'Neo4j', falkordb: 'FalkorDB', datahub: 'DataHub' }

/** Can I use this source right now — in a few words, with a colour. */
function sourceStatus(ds: DataSourceResponse, readiness?: DataSourceReadinessResponse): { label: string; dot: string; text: string; title?: string } {
    const status = readiness?.aggregationStatus ?? ds.aggregationStatus
    if (ds.isActive === false) return { label: 'Paused', dot: 'bg-gray-400', text: 'text-ink-muted' }
    if (status === 'failed') return { label: 'Last refresh didn’t finish', dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400', title: readiness?.message }
    if (readiness?.projectorCurrent === false) return { label: 'Behind its latest changes', dot: 'bg-red-400', text: 'text-red-600 dark:text-red-400', title: readiness?.message }
    if (status === 'running' || status === 'pending') return { label: 'Refreshing…', dot: 'bg-amber-400 animate-pulse', text: 'text-amber-600 dark:text-amber-400' }
    if (readiness && !readiness.canCreateViews) return { label: 'Not ready for views yet', dot: 'bg-slate-400', text: 'text-ink-muted', title: readiness.message }
    return { label: 'Ready to explore', dot: 'bg-emerald-400', text: 'text-emerald-600 dark:text-emerald-400', title: readiness?.message }
}

function DataSourceGridCardBase({
    ds,
    stats,
    providerInfo,
    readiness,
    ontologyName,
    ontologyVersion,
    ontologyPublished,
    viewCount,
    isSelected,
    onSelect,
    onSetPrimary,
}: DataSourceGridCardProps) {
    const ProviderLogo = providerInfo ? getProviderLogo(providerInfo.providerType) : null
    const technical = usePersonaMode() === 'technical'
    const name = ds.label || providerInfo?.catalogItemName || 'Unnamed source'
    const state = sourceStatus(ds, readiness)
    const statCell = (value: React.ReactNode, label: string, title?: string) => (
        <div className="p-2.5 rounded-lg border border-glass-border bg-black/[0.02] dark:bg-white/[0.02] text-center" title={title}>
            <div className="text-sm font-bold text-ink">{value}</div>
            <div className="text-[10px] text-ink-muted">{label}</div>
        </div>
    )
    const computing = stats?.computing
    const counted = (n?: number) =>
        computing ? <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-muted mx-auto" /> : stats ? compactNum(n ?? 0) : '\u2014'

    return (
        <div
            className={cn(
                'relative border rounded-2xl transition-all duration-200 group overflow-hidden',
                isSelected
                    ? 'border-indigo-500/40 bg-indigo-500/[0.03] dark:bg-indigo-500/[0.05] shadow-md ring-1 ring-indigo-500/20'
                    : 'border-glass-border bg-canvas-elevated hover:border-indigo-500/20 hover:shadow-md hover:-translate-y-0.5',
            )}
        >
            {/* The whole card opens the source — one button under the content, so
                the card is reachable by keyboard and Set primary stays its own control. */}
            <button
                type="button"
                onClick={onSelect}
                aria-pressed={isSelected}
                aria-label={`Open ${name}`}
                className="absolute inset-0 z-0 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-lineage/50"
            />

            <div className="h-1 w-full bg-gradient-to-r from-indigo-500 to-violet-500 opacity-80" />

            <div className="relative p-4 pointer-events-none">
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
                            <h4 className="text-sm font-bold text-ink truncate">{name}</h4>
                            {technical ? (
                                providerInfo ? (
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                        <span className="text-[10px] text-ink-muted font-medium">{providerInfo.providerName}</span>
                                        {providerInfo.sourceIdentifier && (
                                            <>
                                                <span className="text-[10px] text-ink-muted/50">/</span>
                                                <span className="text-[10px] text-ink-muted font-mono truncate max-w-[120px]">{providerInfo.sourceIdentifier}</span>
                                            </>
                                        )}
                                    </div>
                                ) : (
                                    <p className="text-[10px] text-ink-muted font-mono truncate">{ds.catalogItemId}</p>
                                )
                            ) : providerInfo && (
                                <p className="text-[11px] text-ink-muted mt-0.5">From {PROVIDER_NAMES[providerInfo.providerType] ?? providerInfo.providerName}</p>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                        {ds.isPrimary && (
                            <span title="The source this workspace opens by default" className="flex items-center gap-1 px-2 py-0.5 text-[10px] font-bold rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                                <Star className="w-2.5 h-2.5" /> Primary
                            </span>
                        )}
                        {!ds.isPrimary && onSetPrimary && (
                            <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); onSetPrimary() }}
                                className="pointer-events-auto px-2 py-0.5 text-[10px] font-medium rounded-full text-ink-muted hover:text-amber-500 hover:bg-amber-500/10 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                            >
                                Make primary
                            </button>
                        )}
                    </div>
                </div>

                {/* Can I use it? */}
                <div className="flex items-center justify-between gap-2 mb-3">
                    <span title={state.title} className={cn('flex items-center gap-1.5 text-[11px] font-semibold', state.text)}>
                        <span className={cn('w-2 h-2 rounded-full', state.dot)} />
                        {state.label}
                    </span>
                    {technical && (
                        <div className="flex items-center gap-1.5">
                            <SourceModeChip mode={resolveSourceMode(ds)} />
                            <NodeIdentityBadge value={ds.identityProperty} />
                        </div>
                    )}
                </div>

                {/* What's in it, and what's built on it */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                    {statCell(viewCount, viewCount === 1 ? 'view' : 'views')}
                    {statCell(counted(stats?.nodeCount), technical ? 'nodes' : 'things', computing ? 'Being counted \u2014 check back shortly.' : 'Entities in this source')}
                    {statCell(counted(stats?.edgeCount), technical ? 'edges' : 'connections', computing ? 'Being counted \u2014 check back shortly.' : 'Relationships between them')}
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between gap-2 text-[10px] text-ink-muted">
                    <span className="flex items-center gap-1 min-w-0 truncate">
                        {ontologyName ? (
                            <>
                                <GitBranch className="w-3 h-3 shrink-0" />
                                <span className="truncate">{technical ? `${ontologyName} v${ontologyVersion}` : ontologyName}</span>
                                {technical && (ontologyPublished ? (
                                    <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-emerald-500/10 text-emerald-500">PUB</span>
                                ) : (
                                    <span className="px-1 py-0.5 text-[8px] font-bold rounded bg-amber-500/10 text-amber-500">DRAFT</span>
                                ))}
                            </>
                        ) : (
                            <span>Updated {new Date(ds.updatedAt).toLocaleDateString()}</span>
                        )}
                    </span>
                    <span className="flex items-center gap-0.5 text-indigo-500 font-medium opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        Open <ChevronRight className="w-3 h-3" />
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
