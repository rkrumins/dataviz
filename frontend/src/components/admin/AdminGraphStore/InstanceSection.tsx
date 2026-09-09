/**
 * One graph store instance: which providers point at it, how it was
 * discovered, how the load is spread across its shards, and then either the
 * shard cards or a flat list of every node.
 *
 * The distribution bar answers the question a list of cards cannot: is this
 * cluster balanced? Three shards that each hold a third of the memory is a
 * healthy picture; one shard holding 80% of it explains a rebuild that keeps
 * refusing on one node while the others look empty.
 */
import { Link } from 'react-router-dom'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphStoreInstance } from '@/services/graphStoreService'
import { compactBytes } from '../shared/aggregationKnobs'
import { ShardCard } from './ShardCard'
import { NodesTable } from './NodesTable'

const SHARD_TONES = [
    'bg-indigo-500', 'bg-emerald-500', 'bg-amber-500', 'bg-sky-500',
    'bg-violet-500', 'bg-rose-500', 'bg-teal-500', 'bg-orange-500',
]

function DistributionBar({ instance, by }: { instance: GraphStoreInstance; by: 'memory' | 'graphs' }) {
    const values = instance.shards.map(s => (
        by === 'memory' ? (s.master.memory?.used ?? 0) : s.graphsTotal
    ))
    const total = values.reduce((a, b) => a + b, 0)
    if (total <= 0) return null
    const label = by === 'memory' ? 'Memory held per shard' : 'Graphs per shard'
    const parts = instance.shards.map((s, i) => ({
        key: s.master.endpoint,
        index: i,
        pct: (values[i] * 100) / total,
        text: by === 'memory' ? compactBytes(values[i]) : `${values[i].toLocaleString()} graphs`,
    }))
    return (
        <div className="min-w-0 flex-1">
            <p className="text-[10px] uppercase tracking-wide text-ink-muted">{label}</p>
            <div
                role="img"
                aria-label={`${label}: ${parts.map(p => `shard ${p.index + 1} ${Math.round(p.pct)}%`).join(', ')}`}
                className="mt-1 flex h-2 w-full overflow-hidden rounded-full bg-black/5 dark:bg-white/10"
            >
                {parts.map(p => (
                    <div
                        key={p.key}
                        className={cn(SHARD_TONES[p.index % SHARD_TONES.length])}
                        style={{ width: `${p.pct}%` }}
                    />
                ))}
            </div>
            <p className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-ink-muted">
                {parts.map(p => (
                    <span key={p.key} className="inline-flex items-center gap-1">
                        <span className={cn('inline-block h-1.5 w-1.5 rounded-full', SHARD_TONES[p.index % SHARD_TONES.length])} />
                        Shard {p.index + 1} {Math.round(p.pct)}% ({p.text})
                    </span>
                ))}
            </p>
        </div>
    )
}

export function InstanceSection({ instance, view, reservePct, canAdjustLimits, focusedShard, onOpenSource }: {
    instance: GraphStoreInstance
    view: 'shards' | 'nodes'
    reservePct?: number | null
    canAdjustLimits?: boolean
    /** `${instanceId}:${index}` of the shard to ring, from ``?shard=``. */
    focusedShard?: string | null
    onOpenSource?: (dsId: string) => void
}) {
    const t = instance.totals
    const coverageMissing = instance.mode === 'cluster'
        && instance.slotsCovered != null && instance.slotsCovered < 16_384

    return (
        <section className="rounded-2xl border border-glass-border bg-canvas-elevated overflow-hidden">
            <header className="px-4 pt-3.5 pb-3 border-b border-glass-border">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <h3 className="text-[13px] font-semibold text-ink">
                        {instance.providers.length > 0
                            ? instance.providers.map(p => p.name ?? p.id).join(', ')
                            : 'Default graph store'}
                    </h3>
                    {instance.envDefault && (
                        <HoverTip label="From the environment" detail="This store is configured by environment variables rather than a provider row — it is what a workspace without its own provider uses.">
                            <span className="rounded-full border border-glass-border px-1.5 py-0.5 text-[10px] text-ink-muted">env default</span>
                        </HoverTip>
                    )}
                    <span className="text-[11px] text-ink-muted">{instance.mode}</span>
                    {instance.providers.length > 0 && (
                        <Link
                            to="/ingestion?tab=providers"
                            className="text-[11px] font-semibold text-indigo-600 dark:text-indigo-400 hover:underline"
                        >
                            Connection settings
                        </Link>
                    )}
                </div>
                <p className="mt-1 text-[11px] text-ink-muted">
                    {t.masters} master{t.masters === 1 ? '' : 's'} · {t.replicas} replica{t.replicas === 1 ? '' : 's'}
                    {' · '}{t.nodesUp}/{t.nodesTotal} nodes answering
                    {instance.mode === 'cluster' && instance.slotsCovered != null && (
                        <span className={cn(coverageMissing && 'text-red-600 dark:text-red-400 font-semibold')}>
                            {' · '}{instance.slotsCovered.toLocaleString()}/16,384 slots covered
                            {coverageMissing && instance.slotsMissing && ` (missing ${instance.slotsMissing})`}
                        </span>
                    )}
                    {t.usedMemory != null && ` · ${compactBytes(t.usedMemory)} of ${compactBytes(t.maxmemory)} used`}
                    {' · '}{t.graphs.toLocaleString()} graph{t.graphs === 1 ? '' : 's'}
                    {t.unregisteredGraphs > 0 && ` (${t.unregisteredGraphs} unregistered)`}
                </p>
                <p className="mt-0.5 text-[10px] text-ink-muted">
                    Seeds: {instance.seeds.join(', ') || '—'}
                    {instance.seedUsed && ` · answered by ${instance.seedUsed}`}
                    {instance.discoveredVia && ` · discovered via ${instance.discoveredVia}`}
                </p>
                {!instance.reachable && (
                    <p className="mt-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.06] px-2.5 py-1.5 text-[11px] text-red-600 dark:text-red-400">
                        This graph store could not be reached: {instance.error ?? 'no seed answered'}.
                    </p>
                )}
                {instance.shards.length > 1 && (
                    <div className="mt-2.5 flex flex-wrap gap-4">
                        <DistributionBar instance={instance} by="memory" />
                        <DistributionBar instance={instance} by="graphs" />
                    </div>
                )}
            </header>

            <div className="p-3">
                {instance.shards.length === 0 ? (
                    <p className="py-2 text-[11px] text-ink-muted">No nodes were discovered for this store.</p>
                ) : view === 'nodes' ? (
                    <NodesTable instance={instance} />
                ) : (
                    <div className="space-y-3">
                        {instance.shards.map(shard => (
                            <ShardCard
                                key={shard.master.endpoint}
                                shard={shard}
                                instanceId={instance.id}
                                reservePct={reservePct}
                                canAdjustLimits={canAdjustLimits}
                                focused={focusedShard === `${instance.id}:${shard.index}`}
                                onOpenSource={onOpenSource}
                            />
                        ))}
                    </div>
                )}
            </div>
        </section>
    )
}
