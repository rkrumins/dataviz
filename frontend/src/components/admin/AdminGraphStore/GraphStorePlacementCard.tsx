/**
 * Where one data source's lineage actually lives.
 *
 * A data source's graph sits on exactly one node of one shard, chosen by
 * hashing its key — and in dedicated projection mode its rollups sit on a
 * DIFFERENT key, which can hash to a different shard. Until this card, no
 * screen said which node any of it was on, so "the graph store is full" and
 * "a node restarted" could not be connected to the source in front of you.
 */
import { Link } from 'react-router-dom'
import { HardDrive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphPlacement } from '@/services/graphStoreService'
import { compactBytes, compactEdges } from '../shared/aggregationKnobs'
import { useGraphPlacement } from '../shared/useGraphStoreTopology'
import { HEALTH_META, lagLabel, nodeHealth } from './meta'

function PlacementRow({ placement, instanceId }: { placement: GraphPlacement; instanceId?: string | null }) {
    const master = placement.master
    const health = master ? nodeHealth(master) : null
    const size = placement.measuredBytes ?? placement.estimatedBytes
    const used = master?.memory?.used
    const max = master?.memory?.maxmemory
    const pct = master?.memory?.usedPct ?? (used != null && max ? (used * 100) / max : null)

    return (
        <div className="rounded-lg border border-glass-border px-3 py-2">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className="font-mono text-[11px] text-ink-secondary break-all">{placement.graphKey}</span>
                <span className="text-[10px] uppercase tracking-wide text-ink-muted">
                    {placement.role === 'projection' ? 'rollup projection' : 'source graph'}
                </span>
                {!placement.present && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">not found on the node</span>
                )}
            </div>

            {master ? (
                <>
                    <p className="mt-1 text-[11px] text-ink-muted">
                        {placement.shardIndex != null && <>Shard {placement.shardIndex + 1} · </>}
                        slot {placement.slot.toLocaleString()} ·{' '}
                        <span className="font-mono text-ink-secondary">{master.endpoint}</span>
                        {health && (
                            <HoverTip label={HEALTH_META[health].label} detail={HEALTH_META[health].meaning}>
                                <span className={cn(
                                    'ml-1.5 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                                    HEALTH_META[health].chip,
                                )}>
                                    {HEALTH_META[health].label}
                                </span>
                            </HoverTip>
                        )}
                    </p>
                    {pct != null && (
                        <div className="mt-1 h-1.5 rounded-full overflow-hidden bg-black/5 dark:bg-white/10">
                            <div
                                className={cn('h-full rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500')}
                                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
                            />
                        </div>
                    )}
                    <p className="mt-1 text-[11px] text-ink-muted tabular-nums">
                        {used != null && max ? `${compactBytes(used)} of ${compactBytes(max)} on this node · ` : ''}
                        {compactEdges(placement.edgeCount)} edges
                        {size != null && ` · ${placement.measuredBytes != null ? '' : '~'}${compactBytes(size)}`}
                        {placement.siblings > 0 && ` · sharing the shard with ${placement.siblings} other graph${placement.siblings === 1 ? '' : 's'}`}
                    </p>
                    {placement.replicas.length > 0 && (
                        <p className="mt-0.5 text-[11px] text-ink-muted">
                            {placement.replicas.length} replica{placement.replicas.length === 1 ? '' : 's'}:{' '}
                            {placement.replicas.map(r => `${r.endpoint} (${lagLabel(r.replication?.lagBytes)})`).join(', ')}
                        </p>
                    )}
                    {instanceId && placement.shardIndex != null && (
                        <Link
                            to={`/admin/graph-store?shard=${encodeURIComponent(`${instanceId}:${placement.shardIndex}`)}`}
                            className="mt-1 inline-block text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                            Open in Graph store
                        </Link>
                    )}
                </>
            ) : (
                <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    No shard of this graph store holds slot {placement.slot.toLocaleString()} right now.
                </p>
            )}
        </div>
    )
}

export function GraphStorePlacementCard({ dataSourceId, className }: {
    dataSourceId: string
    className?: string
}) {
    const { data, isLoading, isError } = useGraphPlacement(dataSourceId)
    if (isLoading && !data) return null
    if (isError && !data) return null
    if (!data) return null

    const split = data.placements.length > 1
        && new Set(data.placements.map(p => p.shardIndex)).size > 1

    return (
        <section
            data-testid="graph-store-placement"
            className={cn('rounded-xl border border-glass-border bg-canvas-elevated p-5', className)}
        >
            <div className="flex items-center gap-2 mb-2">
                <HardDrive className="w-4 h-4 text-ink-muted shrink-0" />
                <h3 className="text-sm font-bold text-ink">Where this lives</h3>
            </div>
            <p className="text-[11px] text-ink-muted mb-2.5">
                A graph lives entirely on one node — the one whose slot range its name hashes into. That node's memory,
                its replicas and its limits decide how this source reads and rebuilds.
            </p>

            {!data.reachable ? (
                <p className="text-[11px] text-red-600 dark:text-red-400">
                    This source's graph store could not be reached: {data.error ?? 'no node answered'}.
                </p>
            ) : data.placements.length === 0 ? (
                <p className="text-[11px] text-ink-muted">This source has no graph in the store yet.</p>
            ) : (
                <div className="space-y-2">
                    {data.placements.map(p => (
                        <PlacementRow key={p.graphKey} placement={p} instanceId={data.instanceId} />
                    ))}
                </div>
            )}

            {split && (
                <p className="mt-2 text-[11px] text-ink-muted">
                    This source's rollups are on a different shard than its source graph — the projection graph hashes on
                    its own name, so the two are sized and restarted independently.
                </p>
            )}

            <p className="mt-2 text-[10px] text-ink-muted">
                {data.mode} · {data.totals.masters} master{data.totals.masters === 1 ? '' : 's'},{' '}
                {data.totals.replicas} replica{data.totals.replicas === 1 ? '' : 's'} ·{' '}
                {data.totals.nodesUp}/{data.totals.nodesTotal} answering
                {data.stale && ' · showing the last good reading'}
            </p>
        </section>
    )
}
