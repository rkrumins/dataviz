/**
 * RegistryAssets — Full-page Data Asset Management
 *
 * Two-panel layout:
 *  Left: sticky provider selector with health + asset counts
 *  Right: scrollable asset list with search, filters, bulk actions,
 *         lazy stats, blast-radius unregister, and inline route step
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useSearchParams, Link } from 'react-router-dom'
import {
    Database, Search, Filter, Loader2, Trash2,
    CheckCircle2, RefreshCw, Layers,
    AlertTriangle, Zap, X, Check, ChevronDown, ChevronLeft, ChevronRight,
    Plus, WifiOff, ArrowUpDown, ArrowUpRight, LineChart,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import {
    providerService,
    friendlyError,
    isWarmingError,
    isDriftError,
    type ProviderResponse,
    type ProviderImpactResponse,
} from '@/services/providerService'
import { catalogService, type CatalogItemResponse } from '@/services/catalogService'
import {
    useProviders,
    useProviderAssets,
    useProviderCatalog,
    useAllProviderCounts,
    assetListState,
    PROVIDER_ASSETS_QUERY_KEY,
    PROVIDER_CATALOG_QUERY_KEY,
} from '@/hooks/useProviderAssets'
import { workspaceService } from '@/services/workspaceService'
import { useWorkspacesStore } from '@/store/workspaces'
import { useProviderHealth, PROVIDER_HEALTH_META } from '@/store/providerHealthModel'
import { aggregationService } from '@/services/aggregationService'
import { useAppNotifications } from '@/components/ui/notifications'
import { Backdrop } from '@/components/ui/Backdrop'
import { AccessDeniedNotice } from '@/components/feedback/AccessDeniedNotice'
import { Neo4jLogo, FalkorDBLogo, DataHubLogo } from './ProviderLogos'
import { AssetOnboardingWizard } from './AssetOnboardingWizard'
import { FirstRunHero } from './FirstRunHero'
import { RetriggerDialog } from './job-history/RetriggerDialog'
import { PRESET_TIMEOUT_MINUTES, type AggregationOverridesValue } from './shared/AggregationOverridesForm'
import type { Envelope, AssetStatsPayload } from '@/types/insights'
import { StatusChip } from '@/components/insights/StatusChip'
import { RefreshControl } from '@/components/insights/RefreshControl'
import { DataSourceProfileDrawer } from '@/components/insights/DataSourceProfileDrawer'
import { useInsightsJob } from '@/hooks/useInsightsJob'
import { useSharedIntersectionObserver } from '@/hooks/useSharedIntersectionObserver'
import { mapWithConcurrency } from '@/lib/concurrency'

// Plain-language sort options — field + direction folded into one
// control so the toolbar reads like a sentence, not a query builder.
const SORT_OPTIONS: Array<{
    label: string
    by: 'name' | 'size' | 'refreshed'
    dir: 'asc' | 'desc'
}> = [
    { label: 'Name A→Z', by: 'name', dir: 'asc' },
    { label: 'Name Z→A', by: 'name', dir: 'desc' },
    { label: 'Largest first', by: 'size', dir: 'desc' },
    { label: 'Smallest first', by: 'size', dir: 'asc' },
    { label: 'Recently refreshed', by: 'refreshed', dir: 'desc' },
    { label: 'Longest since refresh', by: 'refreshed', dir: 'asc' },
]
import { useAssetStats, ASSET_STATS_QUERY_KEY_PREFIX } from '@/hooks/useAssetStats'

// Post-refresh poll loop bounds. Concurrency is capped well under the
// 30-slot WEB DB pool so a Refresh-all can't storm it into
// "too many connections" — it settles the visible page in bounded
// microbatches ("not all in one go") rather than one ~50-wide blast.
const REFRESH_POLL_CONCURRENCY = 4
const REFRESH_POLL_BASE_MS = 2_500
const REFRESH_POLL_MAX_MS = 10_000
const REFRESH_POLL_DEADLINE_MS = 90_000

// ─── Provider type helpers ────────────────────────────────────────────────────
const PROVIDER_TYPES = [
    { type: 'falkordb', label: 'FalkorDB', Logo: FalkorDBLogo, color: 'text-amber-500 bg-amber-500/10 border-amber-500/20' },
    { type: 'neo4j', label: 'Neo4j', Logo: Neo4jLogo, color: 'text-blue-500 bg-blue-500/10 border-blue-500/20' },
    { type: 'datahub', label: 'DataHub', Logo: DataHubLogo, color: 'text-emerald-500 bg-emerald-500/10 border-emerald-500/20' },
]
function getProviderConfig(type: string) {
    return PROVIDER_TYPES.find(p => p.type === type) || PROVIDER_TYPES[0]
}

/** One provider row in the left rail. Renders the SAME live health dot (from the
 *  shared `providerHealthModel`) as the Providers tab and the view wizard, so a
 *  provider that's down looks down everywhere — not silently blank here. */
function ProviderRailItem({
    provider, counts, isActive, onSelect,
}: {
    provider: ProviderResponse
    counts?: { total: number; registered: number }
    isActive: boolean
    onSelect: () => void
}) {
    const config = getProviderConfig(provider.providerType)
    const health = useProviderHealth(provider.id)
    const healthMeta = PROVIDER_HEALTH_META[health.state]
    return (
        <button
            onClick={onSelect}
            className={cn(
                'w-full flex items-center gap-3 p-3 rounded-xl border text-left transition-colors duration-150',
                isActive
                    ? 'bg-indigo-500/8 border-indigo-500/30 shadow-sm'
                    : 'bg-canvas-elevated border-glass-border hover:border-indigo-400/30 hover:bg-indigo-500/5'
            )}
        >
            <div className={cn('w-8 h-8 rounded-lg border flex items-center justify-center shrink-0', config.color)}>
                <config.Logo className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    <p className="text-sm font-semibold text-ink truncate">{provider.name}</p>
                    <span
                        className={cn('w-2 h-2 rounded-full shrink-0', healthMeta.dot)}
                        title={health.error ?? healthMeta.label}
                    />
                </div>
                <p className="text-[11px] text-ink-muted">{config.label}</p>
            </div>
            {counts && (
                <div className="text-right shrink-0">
                    <p className="text-xs font-bold text-emerald-500">{counts.registered}</p>
                    <p className="text-[10px] text-ink-muted">/{counts.total}</p>
                </div>
            )}
        </button>
    )
}

// Stable palette of subtle indicator colours cycling for type chips
const TYPE_COLOURS = [
    'bg-blue-500/10 text-blue-600 border-blue-500/20',
    'bg-violet-500/10 text-violet-600 border-violet-500/20',
    'bg-amber-500/10 text-amber-600 border-amber-500/20',
    'bg-emerald-500/10 text-emerald-600 border-emerald-500/20',
    'bg-rose-500/10 text-rose-600 border-rose-500/20',
    'bg-cyan-500/10 text-cyan-600 border-cyan-500/20',
    'bg-orange-500/10 text-orange-600 border-orange-500/20',
    'bg-teal-500/10 text-teal-600 border-teal-500/20',
]

// ─── AssetRow ─────────────────────────────────────────────────────────────────
function AssetRow({
    providerId, assetName, isRegistered, isSelected, catalogId,
    onToggle, onUnregister, boundWorkspaceName, onReaggregate, onPurge, onOpenProfile
}: {
    providerId: string
    assetName: string
    isRegistered: boolean
    isSelected: boolean
    /** Present once the asset is registered — enables the insights link. */
    catalogId?: string
    onToggle: (name: string) => void
    onUnregister: (name: string) => void
    onReaggregate?: (name: string) => void
    onPurge?: (name: string, opts?: { skipReaggregate?: boolean }) => void
    onOpenProfile: (catalogId: string) => void
    boundWorkspaceName?: string
}) {
    const [expanded, setExpanded] = useState(false)
    const [purgeConfirm, setPurgeConfirm] = useState(false)
    const [purgeLoading, setPurgeLoading] = useState(false)
    const [purgeSkipReagg, setPurgeSkipReagg] = useState(false)
    const [refreshPending, setRefreshPending] = useState(false)
    const ref = useRef<HTMLDivElement>(null)
    const queryClient = useQueryClient()
    const { notify } = useAppNotifications()

    // Lazy-load: only fetch stats once the row scrolls into view (or
    // close to it). One IntersectionObserver instance is shared across
    // every row with the same options — see ``useSharedIntersectionObserver``.
    const isVisible = useSharedIntersectionObserver(ref, { rootMargin: '200px' })

    // React Query owns the envelope state. Filter toggles that
    // unmount/remount this row reuse the cached envelope (gcTime
    // window), and the global useBackendRecovery hook can invalidate
    // every ``insights-asset-stats`` key on Redis recovery.
    const query = useAssetStats(providerId, assetName, { enabled: isVisible })
    const envelope: Envelope<AssetStatsPayload> | null = query.data ?? null
    const stats = envelope?.data ?? null
    const loadingStats = query.isLoading || query.isFetching
    const fetchError = query.error?.message ?? null

    const refetch = useCallback(() => {
        // Imperative refetch shared by the Retry button and the
        // useInsightsJob completion callback.
        void query.refetch()
    }, [query])

    // Manual "Refresh now" — drops the dedup claim on the backend and
    // force-enqueues a discovery job. Used by the per-row ⟳ icon. The
    // ``refreshPending`` state gives an immediate visual confirmation
    // (spinner + "queued" tint) before the backend's ``refreshing=true``
    // envelope comes back on the next poll. Errors surface as a notification
    // because a silent failure here is indistinguishable from "nothing
    // happened" — and that's what the user reported as the original UX
    // pain point.
    const onAssetRefresh = useCallback(async (e: React.MouseEvent) => {
        e.stopPropagation()
        if (refreshPending) return
        setRefreshPending(true)
        try {
            const res = await providerService.refreshAssetStats(providerId, assetName)
            queryClient.invalidateQueries({
                queryKey: [ASSET_STATS_QUERY_KEY_PREFIX, providerId, assetName],
            })
            if (res.status === 'redis_unavailable') {
                notify(
                    'warning',
                    `Refresh queue unreachable for ${assetName} — retry shortly.`,
                )
            } else {
                notify(
                    'success',
                    `Refresh queued for ${assetName} — chip will update when the worker completes.`,
                )
            }
        } catch (err: any) {
            notify(
                'error',
                `Refresh failed for ${assetName}: ${err?.message ?? 'unknown error'}`,
            )
        } finally {
            setRefreshPending(false)
        }
    }, [providerId, assetName, queryClient, notify, refreshPending])

    // Auto-refresh when a computing/stale job completes. ``useInsightsJob``
    // polls /admin/insights/jobs/{id}; on completion we invalidate the
    // asset-stats query so a fresh fetch reads the now-populated cache row.
    useInsightsJob(
        envelope?.meta.job_id ?? null,
        envelope?.meta.poll_url ?? null,
        {
            enabled: !!envelope?.meta.refreshing && !!envelope?.meta.job_id,
            onComplete: () => {
                queryClient.invalidateQueries({
                    queryKey: [ASSET_STATS_QUERY_KEY_PREFIX, providerId, assetName],
                })
            },
        },
    )

    // Separate handlers: circle = select/unregister, chevron = expand
    const handleSelect = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (isRegistered) onUnregister(assetName)
        else onToggle(assetName)
    }
    const handleExpand = (e: React.MouseEvent) => {
        e.stopPropagation()
        setExpanded(v => !v)
    }

    const nodeTypes = stats?.entityTypeCounts
        ? (Object.entries(stats.entityTypeCounts) as [string, number][])
        : []
    const edgeTypes = stats?.edgeTypeCounts
        ? (Object.entries(stats.edgeTypeCounts) as [string, number][])
        : []
    const hasTypes = nodeTypes.length > 0 || edgeTypes.length > 0

    return (
        <div
            ref={ref}
            className={cn(
                'rounded-xl border-2 transition-colors duration-150 duration-150 overflow-hidden',
                isRegistered
                    ? 'bg-emerald-500/5 border-emerald-500/30'
                    : isSelected
                        ? 'bg-indigo-500/[0.06] border-indigo-500/40 shadow-sm'
                        : 'bg-canvas border-glass-border hover:border-indigo-400/40'
            )}
        >
            {/* ─── Header row ─────────────────────────────────────── */}
            <div className="flex items-center gap-3 p-3.5">
                {/* Selection circle */}
                <div
                    onClick={handleSelect}
                    role="checkbox"
                    aria-checked={isRegistered || isSelected}
                    className={cn(
                        'flex-shrink-0 w-5 h-5 rounded-full border-2 flex items-center justify-center cursor-pointer transition-colors duration-150 duration-150 group/sel',
                        isRegistered
                            ? 'border-emerald-500 bg-emerald-500 hover:border-red-400 hover:bg-red-400'
                            : isSelected
                                ? 'border-indigo-500 bg-indigo-500 hover:bg-indigo-400'
                                : 'border-glass-border bg-transparent hover:border-indigo-400'
                    )}
                >
                    {isRegistered && (
                        <>
                            <svg className="w-2.5 h-2.5 text-white group-hover/sel:hidden" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                            <svg className="w-2.5 h-2.5 text-white hidden group-hover/sel:block" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
                        </>
                    )}
                    {!isRegistered && isSelected && (
                        <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>
                    )}
                </div>

                {/* DB icon */}
                <div className={cn(
                    'w-8 h-8 rounded-lg flex items-center justify-center shrink-0',
                    isRegistered ? 'bg-emerald-500/10 border border-emerald-500/20' : 'bg-indigo-500/10 border border-indigo-500/20'
                )}>
                    <Database className={cn('w-3.5 h-3.5', isRegistered ? 'text-emerald-500' : 'text-indigo-500')} />
                </div>

                {/* Name + badge + metrics summary */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                        <span className="text-sm font-semibold text-ink truncate">{assetName}</span>
                        {isRegistered ? (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-600 border border-emerald-500/25 font-bold uppercase tracking-wide">Active</span>
                        ) : isSelected ? (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-600 border border-indigo-500/25 font-bold uppercase tracking-wide">Queued</span>
                        ) : (
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-full bg-black/5 dark:bg-white/5 text-ink-muted font-bold uppercase tracking-wide">Available</span>
                        )}
                        {boundWorkspaceName && (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-indigo-500/10 text-indigo-500 text-[10px] font-semibold">
                                <Database className="w-2.5 h-2.5" />
                                {boundWorkspaceName}
                            </span>
                        )}
                        {envelope && (
                            <StatusChip meta={envelope.meta} compact />
                        )}
                        <button
                            onClick={onAssetRefresh}
                            disabled={refreshPending}
                            title={
                                refreshPending
                                    ? 'Refresh queued — waiting for the worker to pick it up'
                                    : envelope?.meta.refreshing
                                        ? 'A refresh is already running for this asset — click to re-queue'
                                        : `Force a fresh stats scan now (drops the in-flight dedup claim and re-enqueues a discovery job)${
                                            envelope?.meta.updated_at
                                                ? `\nLast refreshed: ${new Date(envelope.meta.updated_at).toLocaleString()}`
                                                : ''
                                        }`
                            }
                            aria-label={`Refresh stats for ${assetName}`}
                            className={cn(
                                'shrink-0 inline-flex items-center justify-center w-6 h-6 rounded',
                                'transition-colors disabled:cursor-not-allowed',
                                refreshPending
                                    ? 'text-indigo-500 bg-indigo-500/10'
                                    : 'text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10',
                            )}
                        >
                            {refreshPending || envelope?.meta.refreshing ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                                <RefreshCw className="w-3 h-3" />
                            )}
                        </button>
                        {catalogId && (
                            <>
                                {/* Counts over time for THIS source. Registered
                                    assets are profiled from the moment they are
                                    onboarded, and the fastest way to answer
                                    "did something delete my data" is to look at
                                    the series — so the row links straight to it
                                    rather than making the reader find the
                                    Profiling tab and search for the name. */}
                                <Link
                                    to={`/ingestion?tab=profiling&source=${encodeURIComponent(catalogId)}`}
                                    onClick={(e) => e.stopPropagation()}
                                    title="See counts over time for this source"
                                    aria-label={`Open profiling for ${assetName}`}
                                    className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors"
                                >
                                    <LineChart className="w-3.5 h-3.5" />
                                </Link>
                                <button
                                    onClick={(e) => { e.stopPropagation(); onOpenProfile(catalogId) }}
                                    title="Open data source profile"
                                    aria-label={`Open profile for ${assetName}`}
                                    className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded text-ink-muted hover:text-indigo-500 hover:bg-indigo-500/10 transition-colors"
                                >
                                    <ArrowUpRight className="w-3.5 h-3.5" />
                                </button>
                            </>
                        )}
                    </div>

                    <div className="flex items-center gap-3">
                        {loadingStats ? (
                            <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                <Loader2 className="w-3 h-3 animate-spin" />
                                <span>Loading metrics...</span>
                            </div>
                        ) : fetchError ? (
                            // The fetch itself failed (500, network, etc.).
                            // Distinct from `unavailable` (Redis-down on the
                            // backend) — show the error and let the user retry
                            // without needing to scroll the row off-screen and
                            // back to re-trigger the IntersectionObserver.
                            <div className="flex items-center gap-1.5 text-[11px] text-red-500">
                                <AlertTriangle className="w-3 h-3 shrink-0" />
                                <span className="truncate" title={fetchError}>
                                    Failed to load — {fetchError}
                                </span>
                                <button
                                    onClick={(e) => { e.stopPropagation(); refetch() }}
                                    className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
                                >
                                    Retry
                                </button>
                            </div>
                        ) : envelope && !stats ? (
                            // Cache-miss states: computing, unavailable, etc. The
                            // chip in the header carries the visual signal; surface
                            // a short auxiliary message here so the row isn't blank.
                            <div className="flex items-center gap-1.5 text-[11px] text-ink-muted">
                                {envelope.meta.status === 'computing' && (
                                    <>
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        <span>Provider scan in progress…</span>
                                    </>
                                )}
                                {envelope.meta.status === 'unavailable' && (
                                    <>
                                        <AlertTriangle className="w-3 h-3" />
                                        <span>Refresh queue unreachable — try again shortly</span>
                                    </>
                                )}
                                {envelope.meta.status === 'partial' && (
                                    <span>Partial metadata available; full scan running</span>
                                )}
                            </div>
                        ) : stats ? (
                            <div className="flex items-center gap-3 text-[11px] text-ink-muted">
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0"></span>
                                    {(stats.nodeCount ?? 0).toLocaleString()} nodes
                                </span>
                                <span className="flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0"></span>
                                    {(stats.edgeCount ?? 0).toLocaleString()} edges
                                </span>
                                {nodeTypes.length > 0 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/8 text-blue-600 font-semibold border border-blue-500/15">
                                        {nodeTypes.length} entity type{nodeTypes.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                                {edgeTypes.length > 0 && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/8 text-violet-600 font-semibold border border-violet-500/15">
                                        {edgeTypes.length} edge type{edgeTypes.length !== 1 ? 's' : ''}
                                    </span>
                                )}
                            </div>
                        ) : (
                            <span className="text-[11px] text-ink-muted/40 font-mono truncate">{assetName}</span>
                        )}
                    </div>
                </div>

                {/* Expand toggle — only when types are available */}
                {(hasTypes || loadingStats) && (
                    <button
                        onClick={handleExpand}
                        className="shrink-0 p-1.5 rounded-lg text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        title={expanded ? 'Hide schema detail' : 'Show entity & relationship types'}
                    >
                        <svg
                            className={cn('w-3.5 h-3.5 transition-transform duration-200', expanded && 'rotate-180')}
                            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                        >
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                )}
            </div>

            {/* ─── Entity + Relationship type breakdown ───────────── */}
            {expanded && hasTypes && (
                <div className="border-t border-glass-border/60 px-3.5 pb-3.5 animate-in slide-in-from-top-1 fade-in duration-150">
                    <div className="pt-3 space-y-3">

                        {/* Node types */}
                        {nodeTypes.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-blue-400 shrink-0"></span>
                                    Entity Types ({nodeTypes.length})
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {[...nodeTypes]
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([typeName, count], i) => (
                                            <span
                                                key={typeName}
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-medium',
                                                    TYPE_COLOURS[i % TYPE_COLOURS.length]
                                                )}
                                            >
                                                <span className="font-semibold">{typeName}</span>
                                                <span className="opacity-55 font-mono text-[10px]">{(count as number).toLocaleString()}</span>
                                            </span>
                                        ))
                                    }
                                </div>
                            </div>
                        )}

                        {/* Relationship types */}
                        {edgeTypes.length > 0 && (
                            <div>
                                <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider mb-2 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-violet-400 shrink-0"></span>
                                    Edge Types ({edgeTypes.length})
                                </p>
                                <div className="flex flex-wrap gap-1.5">
                                    {[...edgeTypes]
                                        .sort((a, b) => b[1] - a[1])
                                        .map(([typeName, count], i) => (
                                            <span
                                                key={typeName}
                                                className={cn(
                                                    'inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-medium',
                                                    TYPE_COLOURS[(i + 3) % TYPE_COLOURS.length]
                                                )}
                                            >
                                                <svg className="w-2.5 h-2.5 opacity-60 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" d="M5 12h14M14 7l5 5-5 5" /></svg>
                                                <span className="font-semibold">{typeName}</span>
                                                <span className="opacity-55 font-mono text-[10px]">{(count as number).toLocaleString()}</span>
                                            </span>
                                        ))
                                    }
                                </div>
                            </div>
                        )}

                        {/* Graph Connectivity score */}
                        {stats && (stats.nodeCount ?? 0) > 0 && (() => {
                            const ratio = (stats.edgeCount ?? 0) / Math.max(stats.nodeCount ?? 1, 1)
                            // Normalise: 0 edges/node = 0%, 10 edges/node = 100%
                            const pct = Math.min(100, Math.round((ratio / 10) * 100))
                            const label = pct < 20 ? 'Very Sparse' : pct < 40 ? 'Sparse' : pct < 60 ? 'Moderate' : pct < 80 ? 'Dense' : 'Very Dense'
                            const barColor = pct < 20
                                ? 'from-blue-400 to-blue-500'
                                : pct < 50
                                    ? 'from-blue-500 to-indigo-500'
                                    : pct < 75
                                        ? 'from-indigo-500 to-violet-500'
                                        : 'from-violet-500 to-amber-500'
                            return (
                                <div>
                                    <div className="flex items-center justify-between mb-1.5">
                                        <p className="text-[10px] font-bold text-ink-muted uppercase tracking-wider">Graph Connectivity</p>
                                        <div className="flex items-center gap-1.5">
                                            <span className={cn(
                                                'text-[10px] font-bold px-1.5 py-0.5 rounded-full border',
                                                pct < 20 ? 'text-blue-500 bg-blue-500/10 border-blue-500/20'
                                                    : pct < 50 ? 'text-indigo-500 bg-indigo-500/10 border-indigo-500/20'
                                                        : pct < 75 ? 'text-violet-500 bg-violet-500/10 border-violet-500/20'
                                                            : 'text-amber-500 bg-amber-500/10 border-amber-500/20'
                                            )}>{label}</span>
                                            <span className="text-[11px] font-black text-ink">{pct}%</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-2">
                                        <div className="flex-1 h-2 rounded-full bg-black/8 dark:bg-white/8 overflow-hidden">
                                            <div
                                                className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-700', barColor)}
                                                style={{ width: `${pct}%` }}
                                            />
                                        </div>
                                        <span className="text-[10px] text-ink-muted font-mono shrink-0">{ratio.toFixed(2)} edges/node</span>
                                    </div>
                                </div>
                            )
                        })()}

                    </div>
                    {isRegistered && (onReaggregate || onPurge) && (
                        <div className="mt-4 pt-3 border-t border-glass-border space-y-2">
                            <div className="flex justify-end gap-2">
                                {onPurge && !purgeConfirm && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); setPurgeConfirm(true); }}
                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:text-red-500 hover:bg-red-500/5 border border-glass-border hover:border-red-500/20 transition-colors"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" /> Purge Edges
                                    </button>
                                )}
                                {onReaggregate && (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); onReaggregate(assetName); }}
                                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20 hover:bg-indigo-500/20 transition-colors"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" /> Force Re-Aggregation
                                    </button>
                                )}
                            </div>
                            {purgeConfirm && (
                                <div className="p-3 rounded-lg border border-red-500/20 bg-red-500/5 space-y-2" onClick={e => e.stopPropagation()}>
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0 mt-0.5" />
                                        <p className="text-xs text-red-400 leading-relaxed">
                                            This will remove all materialized aggregated edges from the graph for this asset. This cannot be undone.
                                        </p>
                                    </div>
                                    <label className="flex items-center gap-2 text-xs text-ink-muted cursor-pointer select-none">
                                        <input
                                            type="checkbox"
                                            checked={!purgeSkipReagg}
                                            onChange={e => setPurgeSkipReagg(!e.target.checked)}
                                            className="rounded border-glass-border"
                                        />
                                        Re-aggregate automatically after purge (recommended — container-level lineage is empty until aggregation runs)
                                    </label>
                                    <div className="flex justify-end gap-2">
                                        <button
                                            onClick={() => setPurgeConfirm(false)}
                                            disabled={purgeLoading}
                                            className="px-3 py-1.5 rounded-lg text-xs font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={async () => {
                                                setPurgeLoading(true)
                                                try { onPurge!(assetName, { skipReaggregate: purgeSkipReagg }) } finally {
                                                    setPurgeLoading(false)
                                                    setPurgeConfirm(false)
                                                }
                                            }}
                                            disabled={purgeLoading}
                                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50 shadow-sm shadow-red-500/25"
                                        >
                                            {purgeLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                                            Confirm Purge
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}

// ─── Unregister Dialog ────────────────────────────────────────────────────────
function UnregisterDialog({
    target,
    impact,
    loading,
    onCancel,
    onConfirm,
}: {
    target: CatalogItemResponse
    impact: ProviderImpactResponse | null
    loading: boolean
    onCancel: () => void
    onConfirm: () => void
}) {
    const hasImpact = impact && (impact.workspaces.length > 0 || impact.views.length > 0)
    return (
        <>
        <Backdrop open={true} onClick={() => !loading && onCancel()} zClassName="z-[70]" className="bg-black/60" />
        <div className="fixed inset-0 z-[70] flex items-center justify-center pointer-events-none">
            <div className="relative bg-canvas-elevated border border-glass-border rounded-2xl shadow-lg w-full max-w-md mx-4 p-6 animate-in zoom-in-95 fade-in duration-200 pointer-events-auto">
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-10 h-10 rounded-xl bg-red-500/10 flex items-center justify-center">
                        <Trash2 className="w-5 h-5 text-red-500" />
                    </div>
                    <div>
                        <h3 className="text-base font-bold text-ink">Unregister Asset</h3>
                        <p className="text-xs text-ink-muted mt-0.5">{target.sourceIdentifier}</p>
                    </div>
                </div>

                <p className="text-sm text-ink-secondary mb-4">
                    This will remove <strong>{target.name || target.sourceIdentifier}</strong> from the Enterprise Catalog.
                </p>

                {loading ? (
                    <div className="flex flex-col items-center justify-center py-8 gap-3 text-ink-muted">
                        <Loader2 className="w-6 h-6 animate-spin" />
                        <span className="text-sm">Calculating impact...</span>
                    </div>
                ) : hasImpact ? (
                    <div className="mb-5 rounded-xl border border-red-500/20 bg-red-500/5 overflow-hidden">
                        <div className="flex items-center gap-2 px-4 py-3 bg-red-500/10 border-b border-red-500/20">
                            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
                            <span className="text-sm font-bold text-red-500">Micro-Blast Radius Warning</span>
                        </div>
                        <div className="px-4 py-3 space-y-3 max-h-52 overflow-y-auto text-sm">
                            {impact!.workspaces.length > 0 && (
                                <div>
                                    <p className="text-xs font-bold text-red-400 uppercase tracking-wide mb-1.5">{impact!.workspaces.length} Impacted Workspace{impact!.workspaces.length > 1 ? 's' : ''}</p>
                                    <ul className="space-y-1">
                                        {impact!.workspaces.map(ws => (
                                            <li key={ws.id} className="flex items-center gap-2 text-red-500 text-xs">
                                                <ChevronRight className="w-3 h-3 shrink-0" />
                                                {ws.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                            {impact!.views.length > 0 && (
                                <div>
                                    <p className="text-xs font-bold text-red-400 uppercase tracking-wide mb-1.5">
                                        {impact!.views.length} Downstream Semantic View{impact!.views.length > 1 ? 's' : ''}
                                    </p>
                                    <ul className="space-y-1">
                                        {impact!.views.map(v => (
                                            <li key={v.id} className="flex items-center gap-2 text-red-500 text-xs">
                                                <ChevronRight className="w-3 h-3 shrink-0" />
                                                {v.name}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    </div>
                ) : (
                    <div className="mb-5 p-3 rounded-lg bg-emerald-500/10 text-emerald-600 text-sm font-medium flex items-center gap-2">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        No downstream workspaces or views depend on this asset. Safe to remove.
                    </div>
                )}

                <div className="flex justify-end gap-3">
                    <button
                        onClick={onCancel}
                        disabled={loading}
                        className="px-4 py-2 rounded-xl text-sm font-medium text-ink-muted hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-50 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={onConfirm}
                        disabled={loading}
                        className="px-4 py-2 rounded-xl text-sm font-semibold bg-red-500 text-white hover:bg-red-600 disabled:opacity-50 transition-colors flex items-center gap-2"
                    >
                        {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                        Confirm Unregister
                    </button>
                </div>
            </div>
        </div>
        </>
    )
}

// ─── Main: RegistryAssets ─────────────────────────────────────────────────────
export function RegistryAssets() {
    const [searchParams, setSearchParams] = useSearchParams()
    const initialProvider = searchParams.get('provider')
    const { notify, showLoading, hideLoading } = useAppNotifications()

    // Providers (React Query — shared cache with the counts fan-out below).
    const { data: providers = [], isLoading: providersLoading } = useProviders()
    const [selectedProviderId, setSelectedProviderId] = useState<string | null>(initialProvider)

    // Per-provider asset + catalog state, sourced from React Query so the
    // list is eager, self-updating (invalidate after refresh; poll while a
    // cold cache is still computing), and globally consistent. `selected`
    // stays local and starts EMPTY — nothing is pre-selected (was: every
    // unregistered asset auto-checked, forcing a Clear on every visit).
    const assetsQuery = useProviderAssets(selectedProviderId)
    const catalogQuery = useProviderCatalog(selectedProviderId)
    const assetsEnvelope = assetsQuery.data ?? null
    // How a nothing-to-show envelope should render: only 'ready' may show
    // the true "no data sources" empty state — computing/unavailable/stub
    // envelopes are transient backend states, not an empty provider.
    const listState = assetListState(assetsEnvelope)
    const assets = listState === 'ready' ? assetsEnvelope!.data!.assets : []
    // Stable ref so the callbacks that depend on it (re-aggregate, purge,
    // unregister) aren't rebuilt every render.
    const existingCatalogs = useMemo(() => catalogQuery.data ?? [], [catalogQuery.data])
    const assetsLoading = assetsQuery.isLoading
    // Only treat as a hard error when we have nothing to show — a failed
    // background refetch keeps the last good list visible.
    const assetsError = (!assetsQuery.data && assetsQuery.error)
        ? (assetsQuery.error.message || 'Failed to load assets.')
        : ''
    const [selected, setSelected] = useState<Set<string>>(new Set())

    // Filters
    const [searchQuery, setSearchQuery] = useState('')
    const [statusFilter, setStatusFilter] = useState<'all' | 'selected' | 'registered' | 'unregistered'>('all')

    // Sort + pagination. Sort keys come from the bulk ``assetsDetail``
    // summaries on the list envelope (one query server-side) — no
    // per-row stats fetches are needed to order the whole list.
    const [sortBy, setSortBy] = useState<'name' | 'size' | 'refreshed'>('name')
    const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc')
    const [pageSize, setPageSize] = useState<10 | 25 | 50>(10)
    const [page, setPage] = useState(0)
    // Sort menu (house dropdown pattern — click-outside to dismiss,
    // same as RefreshControl's overflow menu in this toolbar).
    const [sortMenuOpen, setSortMenuOpen] = useState(false)
    const sortMenuRef = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!sortMenuOpen) return
        const onClick = (e: MouseEvent) => {
            if (!sortMenuRef.current?.contains(e.target as Node)) setSortMenuOpen(false)
        }
        document.addEventListener('mousedown', onClick)
        return () => document.removeEventListener('mousedown', onClick)
    }, [sortMenuOpen])

    // Actions
    const [showOnboarding, setShowOnboarding] = useState(false)
    const [onboardingCatalogs, setOnboardingCatalogs] = useState<any[]>([])

    // Unregister dialog
    const [unregisterTarget, setUnregisterTarget] = useState<CatalogItemResponse | null>(null)
    const [unregisterImpact, setUnregisterImpact] = useState<ProviderImpactResponse | null>(null)
    const [unregisterLoading, setUnregisterLoading] = useState(false)

    // Re-aggregate dialog: holds the resolved set of data sources to fan out to.
    // We resolve them eagerly (when the user clicks Re-aggregate) so the dialog
    // can pre-populate `projectionMode` from the first data source's actual setting.
    const [reaggregateCtx, setReaggregateCtx] = useState<{
        assetName: string
        dataSources: Array<{ id: string; projectionMode?: string | null }>
        initialValue: AggregationOverridesValue
        defaultFinePairs?: 'auto' | 'true' | 'false'
    } | null>(null)

    // Eager, global per-provider counts for the sidebar badges + Catalog
    // Summary. Fans out list + catalog queries for EVERY provider (sharing
    // the single-provider query keys, so no double fetch) — so counts are
    // accurate on first paint instead of filling in only as you click each
    // provider.
    const providerCounts = useAllProviderCounts(providers)

    // QueryClient at the parent level so the panel's Refresh button can
    // invalidate every per-row asset-stats query for the active provider.
    const queryClient = useQueryClient()

    // Auto-select the first provider once the list loads (unless the URL
    // already named one).
    useEffect(() => {
        if (!selectedProviderId && providers.length > 0) {
            setSelectedProviderId(providers[0].id)
        }
    }, [providers, selectedProviderId])

    // Reset the search box, filter, and selection when switching providers
    // (the asset list itself is fetched by useProviderAssets above).
    useEffect(() => {
        setSearchQuery('')
        setStatusFilter('all')
        setSelected(new Set())
    }, [selectedProviderId])

    // Select provider + update URL
    const handleSelectProvider = (id: string) => {
        setSelectedProviderId(id)
        setSearchParams({ tab: 'assets', provider: id })
    }

    // Open onboarding wizard with selected assets (no API calls yet — registration
    // happens inside the wizard on final submit so cancelling is safe).
    const handleRegister = () => {
        if (!selectedProviderId || selected.size === 0) return
        // Build placeholder catalog items for the wizard to use.
        // Real catalog items are created by the wizard's submit handler.
        const placeholders: CatalogItemResponse[] = Array.from(selected).map(assetId => ({
            id: `pending_${assetId}`,
            providerId: selectedProviderId,
            sourceIdentifier: assetId,
            name: assetId.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
            description: undefined,
            permittedWorkspaces: ['*'],
            status: 'active',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
        }))
        setOnboardingCatalogs(placeholders)
        setShowOnboarding(true)
    }

    // Called by wizard on successful completion — invalidate the caches so
    // registration state, sidebar counts, and Catalog Summary recompute.
    const handleOnboardingComplete = () => {
        setShowOnboarding(false)
        setSelected(new Set())
        if (selectedProviderId) {
            queryClient.invalidateQueries({ queryKey: [PROVIDER_CATALOG_QUERY_KEY, selectedProviderId] })
            queryClient.invalidateQueries({ queryKey: [PROVIDER_ASSETS_QUERY_KEY, selectedProviderId] })
        }
    }

    // Initiate unregister
    const handleUnregisterClick = async (assetName: string) => {
        const catalogItem = existingCatalogs.find(c => c.sourceIdentifier === assetName)
        if (!catalogItem) return
        setUnregisterTarget(catalogItem)
        setUnregisterLoading(true)
        try {
            const impact = await catalogService.getImpact(catalogItem.id)
            setUnregisterImpact(impact)
        } catch { /* swallow */ } finally {
            setUnregisterLoading(false)
        }
    }

    // Confirm unregister
    const confirmUnregister = async () => {
        if (!unregisterTarget || !selectedProviderId) return
        setUnregisterLoading(true)
        try {
            await catalogService.delete(unregisterTarget.id, true)
            queryClient.invalidateQueries({ queryKey: [PROVIDER_CATALOG_QUERY_KEY, selectedProviderId] })
            queryClient.invalidateQueries({ queryKey: [PROVIDER_ASSETS_QUERY_KEY, selectedProviderId] })
            // Off-boarding force-soft-deletes the catalog item's workspace data sources.
            // Refresh the workspace-backed surfaces (View Wizard reads the store; the
            // paged workspace rail reads the ['workspaces'] query) so the source
            // disappears immediately instead of lingering until the next reload.
            queryClient.invalidateQueries({ queryKey: ['workspaces'] })
            await useWorkspacesStore.getState().loadWorkspaces()
            setUnregisterTarget(null)
            setUnregisterImpact(null)
        } catch { /* swallow */ } finally {
            setUnregisterLoading(false)
        }
    }

    /**
     * Step 1 of re-aggregate: discover the bound data sources, then open the
     * overrides dialog. The actual trigger fan-out happens in
     * `handleConfirmReaggregate` once the user picks their knob settings.
     */
    const handleReaggregate = useCallback(async (assetName: string) => {
        const item = existingCatalogs.find(c => c.sourceIdentifier === assetName)
        if (!item) return

        showLoading('reaggregate', 'Discovering data sources…')
        try {
            // Admin-level tuning defaults seed the dialog; best-effort only.
            const [wsList, settings] = await Promise.all([
                workspaceService.list(),
                aggregationService.getAggregationSettings().catch(() => null),
            ])
            const dataSourcesToTrigger: Array<{ id: string; projectionMode?: string | null }> =
                wsList.flatMap((ws: any) =>
                    ws.dataSources?.filter((ds: any) => ds.catalogItemId === item.id) || []
                )

            hideLoading('reaggregate')

            if (dataSourcesToTrigger.length === 0) {
                notify('warning', 'No data sources found for this catalog item. Ensure it is bound to a workspace first.')
                return
            }

            // Default projectionMode to the first data source's setting; the user can
            // change it in the dialog and it will apply uniformly to every fan-out.
            const firstMode = dataSourcesToTrigger[0]?.projectionMode === 'dedicated' ? 'dedicated' : 'in_source'
            setReaggregateCtx({
                assetName,
                dataSources: dataSourcesToTrigger,
                initialValue: {
                    batchSize: 5000,
                    projectionMode: firstMode,
                    maxRetries: 3,
                    timeoutMinutes: PRESET_TIMEOUT_MINUTES,
                    tuning: settings?.tuning ?? undefined,
                },
                defaultFinePairs: settings?.envMaterializeFinePairs ?? undefined,
            })
        } catch (e: any) {
            hideLoading('reaggregate')
            notify('error', e?.message ?? 'Failed to discover data sources')
        }
    }, [existingCatalogs, notify, showLoading, hideLoading])

    /**
     * Step 2 of re-aggregate: fan-out trigger calls with the user's overrides.
     * Throws on total failure so the dialog stays open and surfaces the error.
     */
    const handleConfirmReaggregate = useCallback(async (overrides: AggregationOverridesValue) => {
        if (!reaggregateCtx) return
        const { dataSources } = reaggregateCtx
        showLoading('reaggregate', `Triggering aggregation for ${dataSources.length} data source(s)…`)
        const timeoutSecs = overrides.timeoutMinutes * 60
        const tuning = overrides.tuning && Object.keys(overrides.tuning).length > 0 ? overrides.tuning : undefined
        try {
            const results = await Promise.allSettled(dataSources.map(ds =>
                aggregationService.triggerAggregation(ds.id, {
                    projectionMode: overrides.projectionMode,
                    batchSize: overrides.batchSize,
                    maxRetries: overrides.maxRetries,
                    timeoutSecs,
                    tuning,
                }, 'manual')
            ))

            const succeeded = results.filter(r => r.status === 'fulfilled').length
            const failed = results.filter(r => r.status === 'rejected').length

            hideLoading('reaggregate')
            if (failed === 0) {
                notify('success', `Aggregation triggered for ${succeeded} data source(s). Switching to Job History…`)
                setTimeout(() => setSearchParams({ tab: 'jobs' }), 600)
            } else if (succeeded > 0) {
                notify('warning', `Triggered ${succeeded}, failed ${failed} data source(s). A job may already be active.`)
                setTimeout(() => setSearchParams({ tab: 'jobs' }), 600)
            } else {
                const firstError = (results.find(r => r.status === 'rejected') as PromiseRejectedResult)?.reason
                notify('error', firstError?.message ?? 'Failed to trigger aggregation')
                throw firstError instanceof Error ? firstError : new Error('Failed to trigger aggregation')
            }
        } catch (e: any) {
            hideLoading('reaggregate')
            // Re-throw so RetriggerDialog stays open with the user's overrides intact.
            throw e
        }
    }, [reaggregateCtx, notify, showLoading, hideLoading, setSearchParams])

    const handlePurge = useCallback(async (assetName: string, opts?: { skipReaggregate?: boolean }) => {
        const item = existingCatalogs.find(c => c.sourceIdentifier === assetName)
        if (!item) return

        showLoading('purge', 'Purging aggregated edges…')
        try {
            const wsList = await workspaceService.list()
            const dataSources = wsList.flatMap((ws: any) =>
                ws.dataSources?.filter((ds: any) => ds.catalogItemId === item.id) || []
            )

            if (dataSources.length === 0) {
                hideLoading('purge')
                notify('warning', 'No data sources found for this catalog item.')
                return
            }

            const results = await Promise.allSettled(dataSources.map((ds: any) =>
                aggregationService.purgeAggregation(ds.id, opts)
            ))

            // Purge is now asynchronous: the backend creates a `running`
            // job row and returns 202 immediately, then runs the
            // provider DELETE in a BackgroundTask. The actual
            // `deletedEdges` count is unknown at this point — Job
            // History will surface progress + the final count.
            const succeeded = results.filter(r => r.status === 'fulfilled').length
            const failed = results.filter(r => r.status === 'rejected').length

            hideLoading('purge')
            if (failed === 0) {
                notify('success', opts?.skipReaggregate
                    ? `Purge queued for ${succeeded} data source(s). Aggregation will stay empty until you re-trigger it.`
                    : `Purge queued for ${succeeded} data source(s) — re-aggregation starts automatically when each purge completes. Switching to Job History to monitor…`)
                setTimeout(() => setSearchParams({ tab: 'jobs' }), 600)
            } else if (succeeded > 0) {
                notify('warning', `Queued ${succeeded} purge job(s); ${failed} source(s) failed to enqueue (a job may already be active).`)
                setTimeout(() => setSearchParams({ tab: 'jobs' }), 600)
            } else {
                const firstError = (results.find(r => r.status === 'rejected') as PromiseRejectedResult)?.reason
                notify('error', firstError?.message ?? 'Failed to queue purge job')
            }
        } catch (e: any) {
            hideLoading('purge')
            notify('error', e?.message ?? 'Failed to purge aggregated edges')
        }
    }, [existingCatalogs, notify, showLoading, hideLoading, setSearchParams])

    const toggleSelection = (g: string) => {
        setSelected(prev => {
            const next = new Set(prev)
            if (next.has(g)) next.delete(g)
            else next.add(g)
            return next
        })
    }

    // Deduplicate: build a Set of registered source identifiers
    // (guards against legacy duplicate catalog entries)
    const registeredSourceIds = new Set(
        existingCatalogs.map(c => c.sourceIdentifier).filter(Boolean)
    )
    const registeredCount = assets.filter(a => registeredSourceIds.has(a)).length

    const filteredAssets = assets.filter(g => {
        if (searchQuery && !g.toLowerCase().includes(searchQuery.toLowerCase())) return false
        const isReg = registeredSourceIds.has(g)
        if (statusFilter === 'registered' && !isReg) return false
        if (statusFilter === 'unregistered' && isReg) return false
        if (statusFilter === 'selected' && !selected.has(g)) return false
        return true
    })

    // Sort using the bulk per-asset summaries from the list envelope —
    // assets without a cached summary sort to the end of size/refreshed
    // orders (they've never been scanned).
    const detailByName = new Map(
        (assetsEnvelope?.data?.assetsDetail ?? []).map(d => [d.name, d]),
    )
    const sortedAssets = [...filteredAssets].sort((a, b) => {
        const dir = sortDir === 'asc' ? 1 : -1
        if (sortBy === 'name') return a.localeCompare(b) * dir
        const da = detailByName.get(a)
        const db = detailByName.get(b)
        if (sortBy === 'size') {
            const na = da?.nodeCount ?? -1
            const nb = db?.nodeCount ?? -1
            if (na !== nb) return (na - nb) * dir
        } else {
            const ta = da?.updatedAt ?? ''
            const tb = db?.updatedAt ?? ''
            if (ta !== tb) return ta.localeCompare(tb) * dir
        }
        return a.localeCompare(b)
    })

    const pageCount = Math.max(1, Math.ceil(sortedAssets.length / pageSize))
    const clampedPage = Math.min(page, pageCount - 1)
    const pagedAssets = sortedAssets.slice(
        clampedPage * pageSize, (clampedPage + 1) * pageSize,
    )

    // Back to page one whenever the visible set changes shape.
    useEffect(() => {
        setPage(0)
    }, [selectedProviderId, searchQuery, statusFilter, sortBy, sortDir, pageSize])

    const selectedProvider = providers.find(p => p.id === selectedProviderId)
    // A provider that's still loading its dataset is reachable, not broken —
    // show a calm amber "warming up" affordance instead of a red "unreachable"
    // alarm (fixes stale/inaccurate error messaging).
    const providerWarming = isWarmingError(assetsEnvelope?.meta.last_error)

    // Refresh EVERY cached asset for the selected provider (all N sources,
    // not just the visible page). Passing no asset_names tells the backend
    // to fan out across every cached asset (capped at 200, deduped) plus the
    // list sentinel. To keep feedback snappy and light, the button only
    // *waits* on the VISIBLE page's rows to go live; the rest refresh in the
    // background and update their figures as they're scrolled to (each row's
    // own stats query polls while its ``meta.refreshing`` is set).
    const handleRefreshSelectedProvider = useCallback(async () => {
        if (!selectedProviderId) return
        const providerId = selectedProviderId
        try {
            const result = await providerService.refreshAllAssets(providerId)
            const n = result.jobs_queued
            notify(
                'success',
                `Refreshing all ${n} source${n !== 1 ? 's' : ''}${result.truncated ? ' (capped at 200)' : ''} — figures update as each completes.`,
            )
        } catch (err: any) {
            // err.message is already run through friendlyError at the
            // service boundary, so this reads as human copy (e.g. "The
            // database is busy right now…") rather than raw JSON.
            notify(
                'warning',
                err?.message
                    ? `${err.message} Showing the latest available data.`
                    : "Couldn't queue a refresh right now — showing the latest available data.",
            )
        }
        // Mark every per-row asset-stats query under this provider stale
        // WITHOUT a simultaneous refetch burst (``refetchType: 'none'``).
        // The bounded poll loop below is the single controlled fetch
        // driver: it writes fresh envelopes (incl. the claim-backed
        // ``meta.refreshing`` spinner signal) into these same query keys,
        // and the mounted rows observe them.
        queryClient.invalidateQueries({
            predicate: (q) =>
                q.queryKey[0] === ASSET_STATS_QUERY_KEY_PREFIX
                && q.queryKey[1] === selectedProviderId,
            refetchType: 'none',
        })

        // Wait only for the VISIBLE page's jobs to finish (bounded, light):
        // poll each visible row's stats until ``refreshing`` clears (the
        // worker releases the claim on success AND failure, so this
        // terminates promptly; 90s safety cap). fetchQuery writes into the
        // same query keys the rows render from, so figures update in place.
        //
        // Polling is microbatched at ``REFRESH_POLL_CONCURRENCY`` so a full
        // page (up to 50 rows) can't fire 50 concurrent GETs and exhaust
        // the WEB DB pool. On any 503/timeout the round backs off (up to
        // ``REFRESH_POLL_MAX_MS``) instead of hammering — "respect the
        // boundaries" — and the errored asset stays pending for a retry.
        const deadline = Date.now() + REFRESH_POLL_DEADLINE_MS
        const pending = new Set(pagedAssets)
        let roundDelay = 0   // first round fires immediately → prompt spinner feedback
        while (pending.size > 0 && Date.now() < deadline) {
            if (roundDelay > 0) await new Promise(r => setTimeout(r, roundDelay))
            const results = await mapWithConcurrency(
                Array.from(pending),
                REFRESH_POLL_CONCURRENCY,
                async name => {
                    const env = await queryClient.fetchQuery({
                        queryKey: [ASSET_STATS_QUERY_KEY_PREFIX, providerId, name],
                        queryFn: () => providerService.getAssetStats(providerId, name),
                        staleTime: 0,
                        retry: 0,   // don't multiply the under-load 503 storm
                    })
                    return { name, refreshing: !!(env as any)?.meta?.refreshing }
                },
            )
            let sawRejection = false
            for (const r of results) {
                if (r.status === 'fulfilled') {
                    if (!r.value.refreshing) pending.delete(r.value.name)
                } else {
                    sawRejection = true   // keep name pending, retry next round
                }
            }
            roundDelay = sawRejection
                ? Math.min(REFRESH_POLL_MAX_MS, (roundDelay || REFRESH_POLL_BASE_MS) * 2)
                : REFRESH_POLL_BASE_MS
        }

        // Final re-list so the bulk summaries (sort keys, counts,
        // updatedAt) and the sidebar/Catalog totals reflect the completed
        // jobs — and so any brand-new graph appears without a page reload.
        // Invalidation re-fetches in place; the current list stays useful
        // throughout (React Query keeps prior data during the refetch).
        queryClient.invalidateQueries({ queryKey: [PROVIDER_ASSETS_QUERY_KEY, providerId] })
        queryClient.invalidateQueries({ queryKey: [PROVIDER_CATALOG_QUERY_KEY, providerId] })
    }, [selectedProviderId, pagedAssets, queryClient, notify])

    // ── Render ──────────────────────────────────────────────────────────────
    return (
        <div className="flex gap-6 h-full min-h-0 animate-in fade-in duration-300">

            {/* ─── Left: Provider Sidebar ─────────────────────────────────────── */}
            <div data-tour="ingestion-assets" className="w-64 shrink-0 flex flex-col gap-2">
                <div className="mb-1">
                    <p className="text-xs font-bold text-ink-muted uppercase tracking-wider">Providers</p>
                </div>

                {providersLoading ? (
                    <div className="flex items-center gap-2 text-ink-muted text-sm py-4">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Loading...</span>
                    </div>
                ) : providers.length === 0 ? (
                    <div className="p-4 rounded-xl border border-glass-border text-center">
                        <p className="text-ink-muted text-sm mb-3">No providers registered yet.</p>
                        <Link
                            to="/ingestion?tab=connections"
                            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 text-xs font-semibold transition-colors"
                        >
                            <Plus className="w-3 h-3" /> Register a provider
                        </Link>
                    </div>
                ) : (
                    providers.map(p => (
                        <ProviderRailItem
                            key={p.id}
                            provider={p}
                            counts={providerCounts.byProvider[p.id]}
                            isActive={selectedProviderId === p.id}
                            onSelect={() => handleSelectProvider(p.id)}
                        />
                    ))
                )}

                {/* Global stats pill */}
                {providers.length > 0 && (
                    <div className="mt-2 p-3 rounded-xl bg-black/5 dark:bg-white/5 border border-glass-border">
                        <p className="text-[11px] text-ink-muted mb-2 font-semibold uppercase tracking-wide">Catalog Summary</p>
                        <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-ink-muted">Providers</span>
                                <span className="font-bold text-ink">{providers.length}</span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-ink-muted">Total Assets</span>
                                <span className="font-bold text-ink tabular-nums">
                                    {providerCounts.loading
                                        ? <Loader2 className="w-3 h-3 animate-spin inline" />
                                        : providerCounts.totals.total}
                                </span>
                            </div>
                            <div className="flex items-center justify-between text-xs">
                                <span className="text-ink-muted">Registered</span>
                                <span className="font-bold text-emerald-500 tabular-nums">
                                    {providerCounts.loading
                                        ? <Loader2 className="w-3 h-3 animate-spin inline" />
                                        : providerCounts.totals.registered}
                                </span>
                            </div>
                        </div>
                    </div>
                )}
            </div>

            {/* ─── Right: Asset Panel ─────────────────────────────────────────── */}
            <div className="flex-1 flex flex-col min-h-0 min-w-0">
                {!providersLoading && providers.length === 0 ? (
                    <FirstRunHero embedded />
                ) : !selectedProvider ? (
                    <div className="flex flex-col items-center justify-center h-full text-ink-muted gap-4">
                        <Layers className="w-12 h-12 opacity-20" />
                        <p className="text-sm font-semibold">Select a provider to view its assets</p>
                    </div>
                ) : (
                    <>
                        {searchParams.get('onboarding') && (
                            <div className="mb-4 flex items-center gap-3 px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 animate-in slide-in-from-top-2 fade-in duration-300">
                                <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />
                                <p className="text-sm text-emerald-700 dark:text-emerald-400 flex-1">
                                    Provider connected successfully. Select graphs below to onboard them to your enterprise catalog.
                                </p>
                                <button onClick={() => setSearchParams({ tab: 'assets', provider: selectedProviderId || '' })} className="text-emerald-500 hover:text-emerald-600 p-1">
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                        )}

                        {/* Panel header */}
                        <div className="flex items-center justify-between mb-4 shrink-0">
                            <div>
                                <h2 className="text-base font-bold text-ink flex items-center gap-2">
                                    {(() => { const C = getProviderConfig(selectedProvider.providerType); return <C.Logo className="w-5 h-5" /> })()}
                                    {selectedProvider.name}
                                </h2>
                                <p className="text-sm text-ink-muted mt-0.5">
                                    {assetsLoading
                                        ? 'Scanning...'
                                        : `${assets.length} physical asset${assets.length !== 1 ? 's' : ''} · ${registeredCount} registered`
                                    }
                                </p>
                            </div>
                            <RefreshControl
                                onRefreshProvider={handleRefreshSelectedProvider}
                                disabled={assetsLoading || !selectedProviderId}
                            />
                        </div>

                        {/* Toolbar */}
                        <div className="shrink-0 space-y-3 mb-4">
                            <div className="relative">
                                <Search className="w-4 h-4 text-ink-muted absolute left-3 top-1/2 -translate-y-1/2" />
                                <input
                                    type="text"
                                    placeholder="Search assets by name..."
                                    value={searchQuery}
                                    onChange={e => setSearchQuery(e.target.value)}
                                    className="w-full pl-9 pr-10 py-2.5 rounded-xl bg-canvas-elevated border border-glass-border focus:ring-2 focus:ring-indigo-500/50 outline-none text-sm text-ink placeholder:text-ink-muted"
                                />
                                {searchQuery && (
                                    <button onClick={() => setSearchQuery('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted hover:text-ink">
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                )}
                            </div>

                            <div className="flex items-center justify-between gap-2">
                                {/* Filter tabs */}
                                <div className="flex gap-1 p-1 bg-black/5 dark:bg-white/5 rounded-xl border border-glass-border">
                                    {[
                                        { id: 'all', label: `All (${assets.length})` },
                                        { id: 'selected', label: `Queued (${selected.size})` },
                                        { id: 'registered', label: `Active (${registeredCount})` },
                                        { id: 'unregistered', label: `Available (${assets.length - registeredCount})` },
                                    ].map(f => (
                                        <button
                                            key={f.id}
                                            onClick={() => setStatusFilter(f.id as any)}
                                            className={cn(
                                                'px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-colors duration-150 duration-150 whitespace-nowrap',
                                                statusFilter === f.id
                                                    ? 'bg-canvas shadow text-ink'
                                                    : 'text-ink-muted hover:text-ink'
                                            )}
                                        >
                                            {f.label}
                                        </button>
                                    ))}
                                </div>

                                {/* Sort + bulk actions */}
                                <div className="flex items-center gap-1.5">
                                    <div className="relative" ref={sortMenuRef}>
                                        <button
                                            onClick={() => setSortMenuOpen(o => !o)}
                                            aria-haspopup="menu"
                                            aria-expanded={sortMenuOpen}
                                            aria-label="Sort assets"
                                            className={cn(
                                                'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-semibold border border-glass-border bg-canvas-elevated transition-colors',
                                                'text-ink-muted hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                                                'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                                                sortMenuOpen && 'text-ink bg-black/5 dark:bg-white/5',
                                            )}
                                        >
                                            <ArrowUpDown className="w-3.5 h-3.5" />
                                            {SORT_OPTIONS.find(o => o.by === sortBy && o.dir === sortDir)?.label ?? 'Sort'}
                                            <ChevronDown className={cn('w-3 h-3 transition-transform duration-150', sortMenuOpen && 'rotate-180')} />
                                        </button>
                                        {sortMenuOpen && (
                                            <div
                                                role="menu"
                                                className="absolute right-0 top-full mt-1.5 z-20 w-52 p-1 rounded-xl border border-glass-border bg-canvas-elevated shadow-xl animate-in fade-in slide-in-from-top-1 duration-100"
                                            >
                                                {SORT_OPTIONS.map(opt => {
                                                    const active = sortBy === opt.by && sortDir === opt.dir
                                                    return (
                                                        <button
                                                            key={opt.label}
                                                            role="menuitemradio"
                                                            aria-checked={active}
                                                            onClick={() => {
                                                                setSortBy(opt.by)
                                                                setSortDir(opt.dir)
                                                                setSortMenuOpen(false)
                                                            }}
                                                            className={cn(
                                                                'w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg text-xs text-left transition-colors',
                                                                active
                                                                    ? 'font-semibold text-indigo-600 dark:text-indigo-400 bg-indigo-500/10'
                                                                    : 'text-ink-secondary hover:text-ink hover:bg-black/5 dark:hover:bg-white/5',
                                                            )}
                                                        >
                                                            {opt.label}
                                                            {active && <Check className="w-3.5 h-3.5 shrink-0" />}
                                                        </button>
                                                    )
                                                })}
                                            </div>
                                        )}
                                    </div>
                                    <button
                                        onClick={() => setSelected(new Set(assets.filter(a => !registeredSourceIds.has(a))))}
                                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-indigo-600 bg-indigo-500/10 hover:bg-indigo-500/20 transition-colors"
                                    >
                                        Select All
                                    </button>
                                    <button
                                        onClick={() => setSelected(new Set())}
                                        disabled={selected.size === 0}
                                        className="px-2.5 py-1.5 rounded-lg text-xs font-semibold text-ink-muted bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-40"
                                    >
                                        Clear
                                    </button>
                                </div>
                            </div>
                        </div>

                        {/* Provider-unreachable banner.
                            Discovery worker stamps ``meta.last_error`` on the
                            cache row when preflight fails (tcp_refused,
                            dns_unresolvable, connect_timeout, auth_failed, …)
                            — without this banner the user only saw an empty
                            asset list and couldn't distinguish "provider
                            unreachable" from "provider has no graphs". */}
                        {assetsEnvelope?.meta.last_error && (
                            providerWarming ? (
                                <div className="shrink-0 mb-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/5 flex items-start gap-3 animate-in slide-in-from-top-1 fade-in duration-200">
                                    <Loader2 className="w-4 h-4 text-amber-500 mt-0.5 shrink-0 animate-spin" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                                            Provider warming up
                                        </p>
                                        <p className="text-xs text-amber-600/90 dark:text-amber-400/90 mt-0.5 break-words">
                                            {friendlyError(assetsEnvelope.meta.last_error)} This resolves on its own — data will appear shortly.
                                        </p>
                                    </div>
                                </div>
                            ) : isDriftError(assetsEnvelope.meta.last_error) ? (
                                // Data-integrity banner: the connection is fine (the
                                // listing succeeded) but registered graphs are missing
                                // from the provider — no "Edit connection" CTA.
                                <div className="shrink-0 mb-3 p-3 rounded-xl border border-amber-500/20 bg-amber-500/5 flex items-start gap-3 animate-in slide-in-from-top-1 fade-in duration-200">
                                    <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-amber-600 dark:text-amber-400">
                                            Registered data sources missing from provider
                                        </p>
                                        <p className="text-xs text-amber-600/90 dark:text-amber-400/90 mt-0.5 break-words">
                                            {assetsEnvelope.meta.last_error.replace(/^graph_drift:\s*/, '')}
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <div className="shrink-0 mb-3 p-3 rounded-xl border border-red-500/20 bg-red-500/5 flex items-start gap-3 animate-in slide-in-from-top-1 fade-in duration-200">
                                    <WifiOff className="w-4 h-4 text-red-500 mt-0.5 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                        <p className="text-sm font-semibold text-red-600 dark:text-red-400">
                                            Provider unreachable
                                        </p>
                                        <p className="text-xs text-red-500/90 dark:text-red-400/90 mt-0.5 break-words">
                                            {friendlyError(assetsEnvelope.meta.last_error)}
                                            {selectedProvider?.host && (
                                                <span className="ml-1 font-mono text-red-500/70 dark:text-red-400/70">
                                                    (tried {selectedProvider.host}{selectedProvider.port ? `:${selectedProvider.port}` : ''})
                                                </span>
                                            )}
                                        </p>
                                        {assets.length > 0 && (
                                            <p className="text-[11px] text-ink-muted mt-1.5 break-words">
                                                The sources below are the last cached copy — counts may be out of date and will refresh automatically once the provider is reachable.
                                            </p>
                                        )}
                                    </div>
                                    <Link
                                        to={`/ingestion?tab=connections&edit=${selectedProviderId}`}
                                        className="shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-500/10 text-red-600 dark:text-red-400 hover:bg-red-500/20 transition-colors"
                                    >
                                        Edit connection
                                    </Link>
                                </div>
                            )
                        )}

                        {/* Asset list */}
                        <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-0">
                            {assetsLoading ? (
                                <div className="flex flex-col items-center justify-center h-full text-ink-muted py-16 gap-4">
                                    <Loader2 className="w-8 h-8 animate-spin" />
                                    <div className="text-center">
                                        <p className="font-semibold text-sm">Scanning Provider</p>
                                        <p className="text-xs opacity-70 mt-1">Discovering physical data sources...</p>
                                    </div>
                                </div>
                            ) : assetsError ? (
                                <AccessDeniedNotice
                                    error={assetsError}
                                    variant="card"
                                    feature="view data assets for this provider"
                                />
                            ) : filteredAssets.length === 0 ? (
                                assets.length === 0 && listState === 'loading' ? (
                                    <div className="flex flex-col items-center justify-center h-full text-ink-muted py-16 gap-4">
                                        <Loader2 className="w-8 h-8 animate-spin" />
                                        <div className="text-center">
                                            <p className="font-semibold text-sm">Discovering data sources…</p>
                                            <p className="text-xs opacity-70 mt-1">This updates automatically — no need to reload.</p>
                                        </div>
                                    </div>
                                ) : assets.length === 0 && listState === 'unavailable' ? (
                                    // data:null without a job in flight — the cache has no
                                    // usable row (enqueue failed / payload unreadable). NOT
                                    // proof the provider is empty.
                                    <div className="flex flex-col items-center justify-center h-full text-ink-muted py-12 gap-3">
                                        <RefreshCw className="w-10 h-10 opacity-20" />
                                        <p className="text-sm font-semibold">Background refresh paused</p>
                                        <p className="text-xs opacity-70 text-center max-w-sm">
                                            The data source list couldn't be refreshed in the background. Use Refresh to retry — existing data sources are unaffected.
                                        </p>
                                    </div>
                                ) : assets.length === 0 && listState === 'error-stub' ? (
                                    // Discovery failure stub: listing failed before a first
                                    // successful scan (the banner above carries the reason).
                                    <div className="flex flex-col items-center justify-center h-full text-ink-muted py-12 gap-3">
                                        <WifiOff className="w-10 h-10 opacity-20" />
                                        <p className="text-sm font-semibold">Couldn't list data sources</p>
                                        <p className="text-xs opacity-70 text-center max-w-sm">
                                            Discovery failed on the last attempt — this is not proof the provider is empty. It retries automatically on the next background sweep.
                                        </p>
                                    </div>
                                ) : assets.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center h-full text-ink-muted py-12 gap-3">
                                        <Database className="w-10 h-10 opacity-20" />
                                        <p className="text-sm font-semibold">No data sources found on this provider yet</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col items-center justify-center h-full text-ink-muted py-12 gap-3">
                                        <Filter className="w-10 h-10 opacity-20" />
                                        <p className="text-sm font-semibold">No assets match your filters</p>
                                        <button onClick={() => { setSearchQuery(''); setStatusFilter('all') }} className="text-xs text-indigo-500 hover:underline">
                                            Clear filters
                                        </button>
                                    </div>
                                )
                            ) : (
                                pagedAssets.map(assetName => (
                                    <AssetRow
                                        // Keyed by provider TOO: a bare assetName key reuses the
                                        // row instance across providers that share asset names,
                                        // and the reused row's already-true visibility gate then
                                        // fires the new provider's stats fetch instantly.
                                        key={`${selectedProviderId}:${assetName}`}
                                        providerId={selectedProviderId!}
                                        assetName={assetName}
                                        isRegistered={registeredSourceIds.has(assetName)}
                                        isSelected={selected.has(assetName)}
                                        catalogId={existingCatalogs.find(c => c.sourceIdentifier === assetName)?.id}
                                        onToggle={toggleSelection}
                                        onUnregister={handleUnregisterClick}
                                        onReaggregate={handleReaggregate}
                                        onPurge={handlePurge}
                                        onOpenProfile={(id) => setSearchParams({ tab: 'assets', provider: selectedProviderId ?? '', profile: id })}
                                    />
                                ))
                            )}
                        </div>

                        {/* Pager — matches the Job History pager conventions */}
                        {!assetsLoading && sortedAssets.length > 0 && (
                            <div className="shrink-0 mt-3 flex items-center justify-between gap-4 text-xs text-ink-muted">
                                <div className="flex items-center gap-2">
                                    <span>Show</span>
                                    <div className="flex gap-0.5 p-0.5 bg-black/5 dark:bg-white/5 rounded-lg border border-glass-border">
                                        {([10, 25, 50] as const).map(size => (
                                            <button
                                                key={size}
                                                onClick={() => setPageSize(size)}
                                                aria-label={`Show ${size} per page`}
                                                aria-pressed={pageSize === size}
                                                className={cn(
                                                    'px-2 py-1 text-xs font-semibold rounded-md transition-colors tabular-nums',
                                                    pageSize === size
                                                        ? 'bg-canvas shadow text-ink'
                                                        : 'text-ink-muted hover:text-ink',
                                                )}
                                            >
                                                {size}
                                            </button>
                                        ))}
                                    </div>
                                    <span>per page</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className="tabular-nums">
                                        {clampedPage * pageSize + 1}–{Math.min((clampedPage + 1) * pageSize, sortedAssets.length)} of {sortedAssets.length}
                                    </span>
                                    <button
                                        onClick={() => setPage(p => Math.max(0, p - 1))}
                                        disabled={clampedPage === 0}
                                        aria-label="Previous page"
                                        className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-muted bg-black/5 dark:bg-white/5 hover:text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                                    >
                                        <ChevronLeft className="w-3.5 h-3.5" />
                                    </button>
                                    <span className="tabular-nums font-semibold text-ink">
                                        {clampedPage + 1} / {pageCount}
                                    </span>
                                    <button
                                        onClick={() => setPage(p => Math.min(pageCount - 1, p + 1))}
                                        disabled={clampedPage >= pageCount - 1}
                                        aria-label="Next page"
                                        className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-muted bg-black/5 dark:bg-white/5 hover:text-ink hover:bg-black/10 dark:hover:bg-white/10 transition-colors disabled:opacity-30 disabled:pointer-events-none"
                                    >
                                        <ChevronRight className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                            </div>
                        )}

                        {/* Footer action bar */}
                        <div className="shrink-0 mt-4 pt-4 border-t border-glass-border flex items-center justify-between gap-4">
                            <div className="text-sm text-ink-muted">
                                {selected.size > 0 ? (
                                    <><span className="font-bold text-ink">{selected.size}</span> queued to register</>
                                ) : (
                                    <><span className="font-bold text-emerald-500">{registeredCount}</span> active in catalog</>
                                )}
                            </div>
                            <button
                                onClick={handleRegister}
                                disabled={assetsLoading || selected.size === 0}
                                className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-black tracking-wide bg-indigo-500 text-white hover:bg-indigo-600 shadow-md transition-colors duration-150 active:scale-95 disabled:opacity-50 disabled:active:scale-100 disabled:shadow-none"
                            >
                                <Zap className="w-4 h-4" /> Onboard Sources ({selected.size})
                            </button>
                        </div>
                    </>
                )}
            </div>

            {/* ─── Dialogs ────────────────────────────────────────────────────── */}
            {unregisterTarget && (
                <UnregisterDialog
                    target={unregisterTarget}
                    impact={unregisterImpact}
                    loading={unregisterLoading}
                    onCancel={() => { setUnregisterTarget(null); setUnregisterImpact(null) }}
                    onConfirm={confirmUnregister}
                />
            )}

            {showOnboarding && providers.find(p => p.id === selectedProviderId) && (
                <AssetOnboardingWizard
                    provider={providers.find(p => p.id === selectedProviderId)!}
                    catalogItems={onboardingCatalogs}
                    isOpen={showOnboarding}
                    onComplete={handleOnboardingComplete}
                    onClose={() => setShowOnboarding(false)}
                />
            )}

            {/* Re-aggregate overrides dialog (fan-out trigger across all bound data sources) */}
            <RetriggerDialog
                isOpen={!!reaggregateCtx}
                onClose={() => setReaggregateCtx(null)}
                title={
                    reaggregateCtx
                        ? `Re-aggregate ${reaggregateCtx.assetName} (${reaggregateCtx.dataSources.length} data source${reaggregateCtx.dataSources.length !== 1 ? 's' : ''})`
                        : 'Re-aggregate'
                }
                initialValue={reaggregateCtx?.initialValue ?? {
                    batchSize: 5000,
                    projectionMode: 'in_source',
                    maxRetries: 3,
                    timeoutMinutes: PRESET_TIMEOUT_MINUTES,
                }}
                defaultFinePairs={reaggregateCtx?.defaultFinePairs}
                onConfirmRetrigger={handleConfirmReaggregate}
            />

            <DataSourceProfileDrawer
                catalogId={searchParams.get('profile')}
                isOpen={!!searchParams.get('profile')}
                onClose={() => { const p = new URLSearchParams(searchParams); p.delete('profile'); setSearchParams(p) }}
            />
        </div>
    )
}
