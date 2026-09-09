/**
 * Graph store capacity — what the write budget measures before every
 * rebuild, on the page where rebuilds are decided.
 *
 * One row per master: a meter of used memory with the fleet reserve marked on
 * it, what is free after that reserve, how many more rollup edges that is at
 * the fleet bytes-per-edge, and the sources whose rollups live there (each a
 * way into its drawer). A node the budget cannot govern says why and what
 * rule applies instead. A source whose last rebuild was refused shows up as a
 * count that filters the table to exactly those.
 *
 * The rows come from the graph store topology reading, so every master is
 * here whether or not a source sits on it, the order never moves, and a
 * failed refresh leaves the figures on screen with a note rather than
 * replacing the card with an error.
 */
import { useState } from 'react'
import { Database, HardDrive, Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import { DocsLink } from '@/components/help/DocsLink'
import type { CapacitySource, ShardCapacity } from '@/services/aggregationService'
import { compactBytes, compactEdges, heldByRebuilds } from '../shared/aggregationKnobs'
import { useFleetCapacity, useRemeasureCapacity } from '../shared/useAggregationCapacity'

/** Tone by how much of the room UNDER the reserve is still free. */
function tone(shard: ShardCapacity) {
    const room = (shard.maxmemory ?? 0) - (shard.reserveBytes ?? 0)
    const ratio = room > 0 ? (shard.availableBytes ?? 0) / room : 0
    if (ratio >= 0.5) return { fill: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: 'Room to grow' }
    if (ratio >= 0.2) return { fill: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', label: 'Getting full' }
    return { fill: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: 'Near the reserve' }
}

function SourceChip({ source, onOpen }: { source: CapacitySource; onOpen: (dsId: string) => void }) {
    const refused = source.lastFailureCategory === 'write_budget'
    return (
        <HoverTip
            label={`${source.label ?? source.dataSourceId}${source.providerName ? ` · ${source.providerName}` : ''}`}
            detail={`${source.edgeCount.toLocaleString()} rollup edges · ~${compactBytes(source.footprintBytes)} at ${source.bytesPerEdge} B each (${source.bytesPerEdgeSource})${source.lastCubeEstimate != null ? ` · full detail would be ~${compactEdges(source.lastCubeEstimate)} edges` : ''}${refused ? ' · last rebuild would not fit' : ''}`}
        >
            <button
                type="button"
                onClick={() => onOpen(source.dataSourceId)}
                aria-label={`Open ${source.label ?? source.dataSourceId}`}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                    'outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50',
                    refused
                        ? 'border-red-500/30 bg-red-500/[0.06] text-red-600 dark:text-red-400 hover:bg-red-500/10'
                        : 'border-glass-border text-ink-secondary hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03]',
                )}
            >
                <span className="truncate max-w-[14rem]">{source.label ?? source.dataSourceId}</span>
                <span className="tabular-nums text-ink-muted">{compactEdges(source.edgeCount)}</span>
            </button>
        </HoverTip>
    )
}

function ShardRow({ shard, bytesPerEdge, onOpenSource }: {
    shard: ShardCapacity
    bytesPerEdge: number
    onOpenSource: (dsId: string) => void
}) {
    if (!shard.measurable) {
        // Two different things wear the same "not measurable": a node that
        // answered but governs nothing, and a node that is not there. Sending
        // an operator to set maxmemory on a pod that is down wasted a morning.
        const unreachable = shard.state === 'unreachable'
        return (
            <li className="py-3">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="text-[12px] font-mono text-ink-secondary">{shard.endpoint}</span>
                    <span className={cn(
                        'text-[10px] font-semibold uppercase tracking-wide',
                        unreachable ? 'text-red-600 dark:text-red-400' : 'text-amber-600 dark:text-amber-400',
                    )}>
                        {unreachable ? 'Unreachable' : 'Cannot govern'}
                    </span>
                </div>
                <p className="mt-1 text-[11px] text-ink-muted leading-snug">
                    {shard.whyNot ? `${shard.whyNot.charAt(0).toUpperCase()}${shard.whyNot.slice(1)}. ` : ''}
                    {unreachable
                        ? 'Rebuilds that land here wait for it and keep their checkpoint.'
                        : <>
                            Set <span className="font-mono">maxmemory</span> on this node to let the budget read its headroom; until then the static cap of{' '}
                            <span className="tabular-nums">{shard.staticCap.toLocaleString()}</span> edges governs rebuilds landing here.
                        </>}
                </p>
                {shard.sources.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                        {shard.sources.map(s => <SourceChip key={s.dataSourceId} source={s} onOpen={onOpenSource} />)}
                    </div>
                )}
            </li>
        )
    }
    const t = tone(shard)
    const used = shard.used ?? 0
    const max = shard.maxmemory ?? 0
    const usedPct = Math.min(100, Math.max(0, shard.usedPct ?? (max > 0 ? used * 100 / max : 0)))
    const reserveAt = 100 - shard.reservePct
    return (
        <li className="py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[12px] font-mono text-ink-secondary">{shard.endpoint}</span>
                    <span className={cn('text-[10px] font-semibold uppercase tracking-wide', t.text)}>{t.label}</span>
                    {shard.policy && shard.policy !== 'noeviction' && (
                        <span className="text-[10px] text-amber-600 dark:text-amber-400">policy {shard.policy}</span>
                    )}
                    {shard.queryMemCapacity != null && (
                        <span className="text-[10px] text-ink-muted" title="QUERY_MEM_CAPACITY — the ceiling one query may use; rebuilds narrow their scans until each query fits under it">
                            per-query limit {compactBytes(shard.queryMemCapacity)}
                        </span>
                    )}
                </div>
                <span className="text-[12px] text-ink tabular-nums">
                    {compactBytes(used)} of {compactBytes(max)} used ({Math.round(usedPct)}%)
                </span>
            </div>
            <div
                role="meter"
                aria-valuenow={used}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-label={`${compactBytes(used)} of ${compactBytes(max)} used on ${shard.endpoint}; ${shard.reservePct}% reserved`}
                className="relative mt-1.5 h-2 rounded-full overflow-hidden bg-black/5 dark:bg-white/10"
            >
                <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', t.fill)} style={{ width: `${usedPct}%` }} />
                <div
                    aria-hidden="true"
                    className="absolute inset-y-0 w-0.5 bg-ink"
                    style={{ left: `${reserveAt}%` }}
                    title={undefined}
                />
            </div>
            <p className="mt-1.5 text-[11px] text-ink-muted tabular-nums leading-snug">
                <span className="text-ink-secondary">{compactBytes(shard.availableBytes)}</span> free after the {shard.reservePct}% reserve
                {heldByRebuilds(shard) && ` and ${heldByRebuilds(shard)}`}
                {' → '}fits <span className="text-ink-secondary">~{compactEdges(shard.allowedGrowthEdges)}</span> more rollup edges at {bytesPerEdge} B each
            </p>
            {shard.sources.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                    {shard.sources.map(s => <SourceChip key={s.dataSourceId} source={s} onOpen={onOpenSource} />)}
                </div>
            ) : (
                <p className="mt-1.5 text-[11px] text-ink-muted">No rollups live on this node yet.</p>
            )}
        </li>
    )
}

export function GraphStoreCapacity({ onOpenSource, onFacetWouldNotFit, onAdjustLimits }: {
    onOpenSource: (dsId: string) => void
    onFacetWouldNotFit: () => void
    /** Present only for a system admin: opens the Defaults dialog. */
    onAdjustLimits?: () => void
}) {
    const capacity = useFleetCapacity(true)
    const remeasure = useRemeasureCapacity()
    const [remeasuring, setRemeasuring] = useState(false)
    const data = capacity.data

    const refusedCount = data
        ? data.shards.reduce((n, s) => n + s.sources.filter(x => x.lastFailureCategory === 'write_budget').length, 0)
        : 0
    const bytesPerEdge = typeof data?.limits.bytesPerEdge.value === 'number' ? data.limits.bytesPerEdge.value : 512

    const onRemeasure = async () => {
        setRemeasuring(true)
        try { await remeasure() } catch { /* the query's own error state says so */ } finally { setRemeasuring(false) }
    }

    return (
        <section className="rounded-xl border border-glass-border bg-canvas-elevated overflow-hidden" aria-labelledby="capacity-title">
            <header className="flex flex-wrap items-start gap-3 px-4 pt-4 pb-3">
                <div className="w-9 h-9 shrink-0 rounded-xl bg-gradient-to-br from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-sm">
                    <Database className="w-4.5 h-4.5" />
                </div>
                <div className="min-w-0 flex-1">
                    <h2 id="capacity-title" className="text-sm font-semibold text-ink flex items-center gap-2">
                        Graph store capacity
                        <DocsLink slug="rollup-capacity" variant="icon" />
                    </h2>
                    <p className="text-[12px] text-ink-muted mt-0.5">
                        What every rebuild measures on the shard that owns its graph before it writes rollups: the memory
                        left under the fleet reserve, and how many more rollup edges that is.
                    </p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                    {refusedCount > 0 && (
                        <button
                            type="button"
                            onClick={onFacetWouldNotFit}
                            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-red-500/30 bg-red-500/[0.06] text-xs font-semibold text-red-600 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                        >
                            <HardDrive className="w-3.5 h-3.5" />
                            {refusedCount} would not fit
                        </button>
                    )}
                    {onAdjustLimits && (
                        <button
                            type="button"
                            onClick={onAdjustLimits}
                            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                        >
                            <SlidersHorizontal className="w-3.5 h-3.5" />
                            Adjust limits
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onRemeasure}
                        disabled={remeasuring}
                        aria-label="Re-measure capacity"
                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-glass-border text-xs font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors disabled:opacity-50"
                    >
                        <RefreshCw className={cn('w-3.5 h-3.5', remeasuring && 'animate-spin')} />
                        Re-measure
                    </button>
                </div>
            </header>

            <div className="px-4 pb-4">
                {!data && capacity.isLoading ? (
                    <div className="flex items-center gap-2 py-4 text-[12px] text-ink-muted">
                        <Loader2 className="w-4 h-4 animate-spin" /> Measuring the graph store…
                    </div>
                ) : !data ? (
                    <p className="py-3 text-[12px] text-ink-muted">Capacity could not be measured right now. The write budget still measures the shard before every rebuild.</p>
                ) : data.shards.length === 0 && data.unresolved.length === 0 ? (
                    <p className="py-3 text-[12px] text-ink-muted">No source has rollups yet. The first rebuild will measure its shard before it writes.</p>
                ) : (
                    <>
                        {(data.stale || capacity.isError) && (
                            <p className="mb-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
                                Last refresh failed — showing the reading from{' '}
                                {data.cacheAgeMs < 1000 ? 'a moment' : `${Math.round(data.cacheAgeMs / 1000)}s`} ago
                                {data.lastError ? `: ${data.lastError}` : '.'}
                            </p>
                        )}
                        <ul className="divide-y divide-glass-border border-t border-glass-border">
                            {data.shards.map(s => (
                                <ShardRow key={s.endpoint} shard={s} bytesPerEdge={bytesPerEdge} onOpenSource={onOpenSource} />
                            ))}
                        </ul>
                        {data.unresolved.length > 0 && (
                            <p className="mt-2 text-[11px] text-ink-muted leading-snug">
                                Not placed on a shard: {data.unresolved.map(u => `${u.label ?? u.dataSourceId} (${u.whyNot})`).join(', ')}.
                            </p>
                        )}
                        <p className="mt-2 text-[11px] text-ink-muted tabular-nums">
                            Reserve {typeof data.limits.shardReservePct.value === 'number' ? data.limits.shardReservePct.value : '—'}%
                            {' · '}{bytesPerEdge} B per edge
                            {data.limits.maxMaterializedEdges.value != null && ` · ceiling ${compactEdges(Number(data.limits.maxMaterializedEdges.value))} edges`}
                            {' · '}{data.sourcesTotal.toLocaleString()} source{data.sourcesTotal === 1 ? '' : 's'}
                            {data.truncated && ' (largest shown)'}
                            {' · '}measured {data.cacheAgeMs < 1000 ? 'just now' : `${Math.round(data.cacheAgeMs / 1000)}s ago`}
                        </p>
                    </>
                )}
            </div>
        </section>
    )
}
