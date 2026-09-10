/**
 * WHICH REPLICA BELONGS TO WHICH MASTER — DRAWN, NOT INFERRED.
 *
 * A shard's master and its replicas were rendered as sibling rows separated
 * by an indent, so "where is this master replicated, and is that replica
 * following THIS one" had to be reconstructed from a left border and the
 * order of the list. On nine nodes that is a puzzle; the answer is a
 * picture.
 *
 * Each master sits on a tinted tile with its replicas hanging off a spine
 * beneath it, every one of them naming the master it follows and how far
 * behind it is. The spine is the app's own (``views/ViewBuiltOn``), down to
 * the neutral it is drawn in: ``glass-border`` is nearly white in light
 * mode, so a connector drawn with it is a connector nobody can see.
 */
import { Database, HardDrive } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphStoreInstance, GraphStoreNode, GraphStoreShard } from '@/services/graphStoreService'
import { compactBytes, heldByRebuilds } from '../shared/aggregationKnobs'
import { HEALTH_META, lagLabel, nodeHealth, slotRangeLabel, uptimeLabel } from './meta'
import type { NodeHealth } from './meta'

/** One saturation across the family, as the spine rows elsewhere do it. */
const TILE: Record<NodeHealth, string> = {
    up: 'bg-emerald-500/15 border-emerald-500/30 text-emerald-600 dark:text-emerald-400',
    restarting: 'bg-sky-500/15 border-sky-500/30 text-sky-600 dark:text-sky-400',
    lagging: 'bg-amber-500/15 border-amber-500/30 text-amber-600 dark:text-amber-400',
    unreachable: 'bg-red-500/15 border-red-500/30 text-red-600 dark:text-red-400',
}

function HealthPill({ health }: { health: NodeHealth }) {
    const meta = HEALTH_META[health]
    return (
        <HoverTip label={meta.label} detail={meta.meaning}>
            <span className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                meta.chip,
            )}>
                {meta.label}
            </span>
        </HoverTip>
    )
}

function MemoryLine({ node }: { node: GraphStoreNode }) {
    const used = node.memory?.used
    const max = node.memory?.maxmemory
    if (used == null) return <span className="text-[10px] text-ink-muted">memory not read</span>
    if (!max) return <span className="text-[10px] text-ink-muted tabular-nums">{compactBytes(used)} used</span>
    const pct = Math.min(100, Math.max(0, node.memory.usedPct ?? (used * 100) / max))
    const fill = node.memory.level === 'critical' || (!node.memory.level && pct >= 90)
        ? 'bg-red-500'
        : node.memory.level === 'warn' || (!node.memory.level && pct >= 75)
            ? 'bg-amber-500'
            : 'bg-emerald-500'
    return (
        <span className="inline-flex items-center gap-1.5">
            <span
                role="meter"
                aria-valuenow={Math.round(pct)}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${node.endpoint} at ${Math.round(pct)}% of its ceiling`}
                className="inline-block h-1.5 w-16 rounded-full overflow-hidden bg-black/5 dark:bg-white/10"
            >
                <span className={cn('block h-full rounded-full', fill)} style={{ width: `${pct}%` }} />
            </span>
            <span className="text-[10px] text-ink-muted tabular-nums">
                {compactBytes(used)} of {compactBytes(max)}
            </span>
        </span>
    )
}

function ReplicaRow({ replica, master, last }: {
    replica: GraphStoreNode
    master: GraphStoreNode
    last: boolean
}) {
    const health = nodeHealth(replica)
    const link = replica.replication?.masterLinkStatus
    // The master this replica names for itself, which is the fact the page
    // exists to show; the shard's master is the fallback when INFO on the
    // replica could not be read.
    const follows = replica.replication?.masterEndpoint ?? master.endpoint
    const uptime = uptimeLabel(replica)

    return (
        <li className={cn('relative flex gap-3', last ? 'pb-0' : 'pb-3')}>
            {!last && (
                <span
                    aria-hidden
                    /* A real neutral, never `glass-border`: that token is
                       rgba(255,255,255,.4) in light mode, so the spine would
                       be white on a near-white card and simply not be there. */
                    className="absolute left-[17px] top-[34px] bottom-0 w-px bg-black/10 dark:bg-white/10"
                />
            )}
            <span className={cn(
                'relative z-[1] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl border',
                TILE[health],
            )}>
                <HardDrive className="h-4 w-4" />
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[12px] text-ink-secondary break-all">{replica.endpoint}</span>
                    <HealthPill health={health} />
                    {replica.gossip && (
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                            {replica.gossip}
                        </span>
                    )}
                </div>
                {replica.role === 'master' ? (
                    // Promoted, and the cluster has not caught up: reading the
                    // line below off a node in this state said "replica of …,
                    // link unknown, in step" about a node replicating nothing.
                    <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">
                        This node now calls itself the master; the cluster still lists it under{' '}
                        <span className="font-mono">{master.endpoint}</span>. A failover is in flight.
                    </p>
                ) : (
                    <p className="mt-0.5 text-[11px] text-ink-muted">
                        replica of <span className="font-mono text-ink-secondary">{follows}</span>
                        {' · '}link {link ?? 'unknown'}
                        {' · '}{lagLabel(replica.replication?.lagBytes)}
                    </p>
                )}
                <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                    <MemoryLine node={replica} />
                    {uptime && (
                        <span className={cn(
                            'text-[10px]',
                            uptime.startsWith('restarted')
                                ? 'text-sky-600 dark:text-sky-400 font-semibold'
                                : 'text-ink-muted',
                        )}>
                            {uptime}
                        </span>
                    )}
                </p>
            </div>
        </li>
    )
}

export function ShardReplication({ shard, reservePct }: {
    shard: GraphStoreShard
    reservePct?: number | null
}) {
    const master = shard.master
    const health = nodeHealth(master)
    const slots = slotRangeLabel(shard)
    const uptime = uptimeLabel(master)
    const held = shard.capacity ? heldByRebuilds(shard.capacity) : null
    const fits = shard.capacity?.allowedGrowthEdges ?? null
    // Reads survive a master going away: the replicas hold the only copies
    // of these graphs until one is promoted, and the router keeps using
    // them. Saying so is the difference between "a node is down" and "and
    // here is what is still working".
    const servedByReplicas = master.status !== 'up'
        && shard.replicas.some(r => r.status === 'up')

    return (
        <section
            data-testid={`shard-replication-${shard.index}`}
            className="rounded-xl border border-glass-border bg-canvas-elevated px-4 py-3.5"
        >
            <div className="flex gap-3">
                <span className={cn(
                    'relative z-[1] flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-xl border',
                    TILE[health],
                )}>
                    <Database className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h4 className="text-[12px] font-semibold text-ink">Shard {shard.index + 1}</h4>
                        <span className="font-mono text-[12px] text-ink-secondary break-all">{master.endpoint}</span>
                        <span className="text-[10px] uppercase tracking-wide text-ink-muted">
                            {master.role === 'replica' ? 'master (stepping down)' : 'master'}
                        </span>
                        <HealthPill health={health} />
                        {master.gossip && (
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">
                                {master.gossip}
                            </span>
                        )}
                    </div>
                    <p className="mt-0.5 text-[11px] text-ink-muted tabular-nums">
                        {slots && (
                            <HoverTip
                                label={`Slots ${slots}`}
                                detail="A graph key hashes to one of 16,384 slots; this shard owns these, so every key that hashes into the range lives on this master."
                            >
                                <span>slots {slots}</span>
                            </HoverTip>
                        )}
                        {slots && ' · '}
                        {shard.graphsTotal.toLocaleString()} graph{shard.graphsTotal === 1 ? '' : 's'}
                        {typeof reservePct === 'number' && ` · ${reservePct}% held back as reserve`}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <MemoryLine node={master} />
                        {uptime && (
                            <span className={cn(
                                'text-[10px]',
                                uptime.startsWith('restarted')
                                    ? 'text-sky-600 dark:text-sky-400 font-semibold'
                                    : 'text-ink-muted',
                            )}>
                                {uptime}
                            </span>
                        )}
                        {fits != null && (
                            <span className="text-[10px] text-ink-muted tabular-nums">
                                fits ~{fits.toLocaleString()} more rollup edges
                            </span>
                        )}
                        {held && <span className="text-[10px] text-ink-muted">{held}</span>}
                    </p>
                </div>
            </div>

            {servedByReplicas && (
                <p
                    data-testid={`served-by-replicas-${shard.index}`}
                    className="mt-2.5 rounded-lg border border-sky-500/25 bg-sky-500/[0.06] px-2.5 py-1.5 text-[11px] text-sky-700 dark:text-sky-300"
                >
                    This master is not answering, so reads for its graphs are being served by the replicas below.
                    Writes and rebuilds wait for it to come back, or for one of them to be promoted.
                </p>
            )}

            {shard.replicas.length === 0 ? (
                <p className="mt-2.5 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
                    No replica is following this master. If it goes away, its slots are not served until it comes
                    back — nothing can be promoted in its place, and its graphs cannot be read or written meanwhile.
                </p>
            ) : (
                <>
                    <p className="mt-3 text-[10px] font-semibold uppercase tracking-[0.13em] text-ink-muted">
                        Replicated to {shard.replicas.length} node{shard.replicas.length === 1 ? '' : 's'}
                    </p>
                    <ul className="mt-1.5">
                        {shard.replicas.map((replica, i) => (
                            <ReplicaRow
                                key={replica.nodeId ?? replica.endpoint}
                                replica={replica}
                                master={master}
                                last={i === shard.replicas.length - 1}
                            />
                        ))}
                    </ul>
                </>
            )}
        </section>
    )
}

/** Why a node the cluster knows belongs to no shard. */
function unplacedReason(node: GraphStoreNode): string {
    if (node.role === 'joining') return 'still joining the cluster (mid-MEET)'
    if (node.gossip === 'noaddr') return 'the cluster announces no address for it'
    if (node.role === 'replica') return 'it follows a master this reading cannot see'
    return 'the cluster places it in no shard'
}

function UnplacedNodes({ nodes }: { nodes: GraphStoreNode[] }) {
    if (nodes.length === 0) return null
    return (
        <section
            data-testid="unplaced-nodes"
            className="rounded-xl border border-amber-500/25 bg-amber-500/[0.04] px-4 py-3"
        >
            <h4 className="text-[12px] font-semibold text-ink">
                {nodes.length} node{nodes.length === 1 ? '' : 's'} in no shard
            </h4>
            <p className="mt-0.5 text-[11px] text-ink-muted">
                The cluster knows these nodes but gives them no slots and no master. They used to be
                either invented into a shard of their own or hung off whichever master owned slot 0 —
                both of which say something the cluster never said.
            </p>
            <ul className="mt-2 space-y-1">
                {nodes.map(node => (
                    <li key={node.nodeId ?? node.endpoint} className="text-[11px] text-ink-muted">
                        <span className="font-mono text-ink-secondary">{node.endpoint}</span>
                        {' · '}{unplacedReason(node)}
                        {node.error && ` · ${node.error}`}
                    </li>
                ))}
            </ul>
        </section>
    )
}

export function ReplicationMap({ instance, reservePct }: {
    instance: GraphStoreInstance
    reservePct?: number | null
}) {
    const unplaced = instance.unplacedNodes ?? []
    if (instance.shards.length === 0 && unplaced.length === 0) return null
    return (
        <div className="space-y-3" data-testid="replication-map">
            <p className="text-[11px] text-ink-muted">
                Every master this store owns, and the replicas standing behind each one. A graph lives on exactly one
                master — the one whose slot range its name hashes into — and each replica below holds a copy of that
                master's data, ready to be promoted in its place.
            </p>
            {instance.shards.map(shard => (
                <ShardReplication key={shard.index} shard={shard} reservePct={reservePct} />
            ))}
            <UnplacedNodes nodes={unplaced} />
        </div>
    )
}
