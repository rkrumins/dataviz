/**
 * How much read load the response cache is absorbing, and the control to
 * rebuild it.
 *
 * This is the page's highest-leverage number. A cache hit costs one Redis
 * round trip; a miss costs a canvas open's worth of Cypher — roughly 55
 * queries — on the six query threads of the one shard replica that serves
 * that data source. Sharding spreads data SOURCES across hardware; it does
 * not widen a single source. So the hit ratio is not a tuning detail, it is
 * most of the difference between a view that opens instantly and one that
 * takes ten seconds.
 */
import { useCallback, useEffect, useState } from 'react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { graphStoreService } from '@/services/graphStoreService'
import type { CacheEndpointStats, CacheStatsResponse } from '@/services/graphStoreService'

/** What each cached endpoint is, in the words of what the user did. */
const ENDPOINT_MEANING: Record<string, string> = {
    'children-with-edges': 'Expanding a node to see what it contains',
    'canvas-bootstrap': 'Opening a view for the first time',
    'canvas-expand': 'Growing a view in place',
    'nodes-query': 'Loading the entities a view shows',
    'nodes_degree': 'Counting what each node connects to',
    'edges-between': 'Drawing the edges among what is on screen',
    aggregated: 'The rolled-up lineage between containers',
    'top-level': 'The roots a view starts from',
    'layer-assignment': 'Which layer each entity belongs to',
    trace: 'Tracing lineage from one node',
    'trace-expand': 'Growing a trace',
    'trace-closure': 'The full closure behind a trace',
}

function ratioTone(ratio: number | null): string {
    if (ratio == null) return 'text-ink-muted'
    if (ratio >= 0.8) return 'text-emerald-600 dark:text-emerald-400'
    if (ratio >= 0.4) return 'text-amber-600 dark:text-amber-400'
    return 'text-rose-600 dark:text-rose-400'
}

function pct(ratio: number | null): string {
    return ratio == null ? '—' : `${Math.round(ratio * 100)}%`
}

function Ratio({ stats, big = false }: { stats: CacheEndpointStats; big?: boolean }) {
    const served = stats.hit + stats.miss + stats.stale
    return (
        <span className={cn('font-semibold tabular-nums', ratioTone(stats.hit_ratio), big ? 'text-2xl' : 'text-sm')}>
            {pct(stats.hit_ratio)}
            {served > 0 && (
                <span className="ml-1.5 text-[10px] font-normal text-ink-muted">
                    {stats.hit.toLocaleString()} of {served.toLocaleString()}
                </span>
            )}
        </span>
    )
}

export function CacheHealthCard({
    workspaceId, dataSourceId, dataSourceName, canRefresh,
}: {
    workspaceId: string
    dataSourceId?: string
    dataSourceName?: string
    canRefresh: boolean
}) {
    const [stats, setStats] = useState<CacheStatsResponse | null>(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState<string | null>(null)
    const [refreshing, setRefreshing] = useState(false)
    const [refreshed, setRefreshed] = useState<string | null>(null)

    const load = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            setStats(await graphStoreService.getCacheStats(workspaceId, dataSourceId))
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Could not read the cache counters')
        } finally {
            setLoading(false)
        }
    }, [workspaceId, dataSourceId])

    useEffect(() => { void load() }, [load])

    const onRefresh = useCallback(async () => {
        if (!dataSourceId) return
        setRefreshing(true)
        setRefreshed(null)
        try {
            await graphStoreService.refreshCache(workspaceId, dataSourceId)
            setRefreshed('Cleared. The next person to open each view rebuilds it.')
            await load()
        } catch (e) {
            setError(e instanceof Error ? e.message : 'The refresh did not go through')
        } finally {
            setRefreshing(false)
        }
    }, [workspaceId, dataSourceId, load])

    const rows = Object.entries(stats?.endpoints ?? {})
        .sort((a, b) => (b[1].hit + b[1].miss + b[1].stale) - (a[1].hit + a[1].miss + a[1].stale))
    const totals = stats?.totals
    const served = totals ? totals.hit + totals.miss + totals.stale : 0
    const windowLabel = stats?.windowSeconds ? `${Math.round(stats.windowSeconds / 60)} min` : ''

    return (
        <section className="rounded-xl border border-glass-border bg-canvas-elevated p-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <h3 className="text-sm font-semibold text-ink-primary">
                        View cache
                        {dataSourceName && <span className="ml-1.5 font-normal text-ink-muted">· {dataSourceName}</span>}
                    </h3>
                    <p className="mt-0.5 max-w-prose text-[11px] text-ink-muted">
                        A hit answers from Redis in milliseconds. A miss re-reads the graph —
                        around 55 queries on the shard replicas serving this source, which is
                        what makes a large view take seconds to open.
                        {windowLabel && <> Last {windowLabel}.</>}
                    </p>
                </div>

                {canRefresh && dataSourceId && (
                    <HoverTip
                        label="Rebuild this source's cached views"
                        detail={
                            'Marks every cached view for this source out of date, so the next '
                            + 'read rebuilds it from the graph. Use it when something changed '
                            + 'the graph without going through the app — a direct query, an '
                            + 'external load, a restore. Edits made here and finished rollups '
                            + 'already do this on their own. The rebuild is paid by whoever '
                            + 'opens each view next.'
                        }
                    >
                        <button
                            type="button"
                            onClick={() => void onRefresh()}
                            disabled={refreshing}
                            className={cn(
                                'rounded-lg border border-glass-border px-3 py-1.5 text-xs font-medium',
                                'text-ink-secondary transition-colors',
                                refreshing ? 'opacity-60' : 'hover:bg-canvas-sunken hover:text-ink-primary',
                            )}
                        >
                            {refreshing ? 'Clearing…' : 'Rebuild cache'}
                        </button>
                    </HoverTip>
                )}
            </header>

            {refreshed && (
                <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
                    {refreshed}
                </p>
            )}
            {error && (
                <p className="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.06] px-3 py-2 text-[11px] text-rose-700 dark:text-rose-300">
                    {error}
                </p>
            )}

            {loading && !stats ? (
                <p className="mt-4 text-xs text-ink-muted">Reading the counters…</p>
            ) : served === 0 ? (
                <p className="mt-4 text-xs text-ink-muted">
                    Nothing served in this window — either nobody opened a view, or the
                    counters have not been written since the last restart.
                </p>
            ) : (
                <>
                    <div className="mt-4 flex flex-wrap items-end gap-x-6 gap-y-2 border-b border-glass-border pb-3">
                        <div>
                            <p className="text-[10px] uppercase tracking-wide text-ink-muted">Served from cache</p>
                            {totals && <Ratio stats={totals} big />}
                        </div>
                        {totals && totals.stale > 0 && (
                            <HoverTip
                                label="Served from the last-known-good copy"
                                detail={
                                    'The graph store could not answer, so the last good result was '
                                    + 'served instead. It kept people working — but it is not the '
                                    + 'cache doing its job, so it is never counted as a hit.'
                                }
                            >
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-ink-muted">Fell back</p>
                                    <span className="text-sm font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                                        {totals.stale.toLocaleString()}
                                    </span>
                                </div>
                            </HoverTip>
                        )}
                        {totals && totals.bypass > 0 && (
                            <HoverTip
                                label="Cache not consulted"
                                detail={
                                    'The endpoint has caching switched off, or Redis could not be '
                                    + 'reached. Kept out of the percentage so a disabled cache does '
                                    + 'not read as a broken one.'
                                }
                            >
                                <div>
                                    <p className="text-[10px] uppercase tracking-wide text-ink-muted">Bypassed</p>
                                    <span className="text-sm font-semibold tabular-nums text-ink-secondary">
                                        {totals.bypass.toLocaleString()}
                                    </span>
                                </div>
                            </HoverTip>
                        )}
                    </div>

                    <ul className="mt-3 space-y-1.5">
                        {rows.map(([endpoint, row]) => (
                            <li key={endpoint} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
                                <span className="min-w-0 flex-1">
                                    <span className="text-xs text-ink-secondary">
                                        {ENDPOINT_MEANING[endpoint] ?? endpoint}
                                    </span>
                                    <span className="ml-1.5 font-mono text-[10px] text-ink-muted">{endpoint}</span>
                                </span>
                                <Ratio stats={row} />
                            </li>
                        ))}
                    </ul>
                </>
            )}
        </section>
    )
}
