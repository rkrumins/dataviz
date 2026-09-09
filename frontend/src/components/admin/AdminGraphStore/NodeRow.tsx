/**
 * One node — master or replica — as a line an operator can read at a glance
 * and interrogate on hover: where it is, whether it answered, how full it
 * is, what it allows one query to do, and (for a replica) how far behind it
 * has fallen.
 *
 * Every node of every instance gets one of these, including the ones that
 * did not answer. A node missing from a list is indistinguishable from a
 * node that does not exist, which is how six of nine went unnoticed.
 */
import { Link } from 'react-router-dom'
import { SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils'
import { HoverTip } from '@/components/ui/HoverTip'
import type { GraphStoreNode } from '@/services/graphStoreService'
import { compactBytes, compactEdges } from '../shared/aggregationKnobs'
import { HEALTH_META, effectsLabel, lagLabel, nodeHealth, uptimeLabel } from './meta'

export function HealthChip({ node }: { node: GraphStoreNode }) {
    const health = nodeHealth(node)
    const meta = HEALTH_META[health]
    return (
        <HoverTip label={meta.label} detail={node.error ? `${meta.meaning} ${node.error}` : meta.meaning}>
            <span className={cn(
                'inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                meta.chip,
            )}>
                {meta.label}
            </span>
        </HoverTip>
    )
}

function MemoryMeter({ node, reservePct }: { node: GraphStoreNode; reservePct?: number | null }) {
    const used = node.memory?.used ?? null
    const max = node.memory?.maxmemory ?? null
    if (used == null) {
        return <p className="mt-1 text-[11px] text-ink-muted">Memory not read.</p>
    }
    if (!max) {
        return (
            <p className="mt-1 text-[11px] text-ink-muted tabular-nums">
                {compactBytes(used)} used · no maxmemory set, so nothing can be measured against it
            </p>
        )
    }
    const pct = Math.min(100, Math.max(0, node.memory.usedPct ?? (used * 100) / max))
    const fill = pct >= 90 ? 'bg-red-500' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500'
    const reserveAt = typeof reservePct === 'number' ? 100 - reservePct : null
    return (
        <>
            <div
                role="meter"
                aria-valuenow={used}
                aria-valuemin={0}
                aria-valuemax={max}
                aria-label={`${compactBytes(used)} of ${compactBytes(max)} used on ${node.endpoint}`}
                className="relative mt-1.5 h-2 rounded-full overflow-hidden bg-black/5 dark:bg-white/10"
            >
                <div className={cn('h-full rounded-full transition-[width] duration-700 ease-out', fill)} style={{ width: `${pct}%` }} />
                {reserveAt != null && (
                    <div aria-hidden="true" className="absolute inset-y-0 w-0.5 bg-ink" style={{ left: `${reserveAt}%` }} />
                )}
            </div>
            <p className="mt-1 text-[11px] text-ink-muted tabular-nums">
                {compactBytes(used)} of {compactBytes(max)} ({Math.round(pct)}%)
                {node.memory.policy && node.memory.policy !== 'noeviction' && (
                    <span className="text-amber-600 dark:text-amber-400"> · policy {node.memory.policy}</span>
                )}
            </p>
        </>
    )
}

export function NodeRow({ node, reservePct, fitsEdges, heldNote, canAdjustLimits, limitsHref }: {
    node: GraphStoreNode
    reservePct?: number | null
    /** "fits ~N more rollup edges" for a master, from the same budget a run uses. */
    fitsEdges?: number | null
    /** What running rebuilds hold on this node right now, in words. */
    heldNote?: string | null
    canAdjustLimits?: boolean
    limitsHref?: string
}) {
    const uptime = uptimeLabel(node)
    const isReplica = node.role === 'replica'
    const detail = [
        node.server.redisVersion ? `Redis ${node.server.redisVersion}` : null,
        node.memory.rss != null ? `RSS ${compactBytes(node.memory.rss)}` : null,
        node.memory.peak != null ? `peak ${compactBytes(node.memory.peak)}` : null,
        node.memory.fragmentationRatio != null ? `fragmentation ${node.memory.fragmentationRatio.toFixed(2)}×` : null,
        node.memory.memReplBacklog != null ? `replication backlog ${compactBytes(node.memory.memReplBacklog)}` : null,
        node.memory.memClientsReplicas != null ? `replica buffers ${compactBytes(node.memory.memClientsReplicas)}` : null,
        node.nodeId ? `node ${node.nodeId.slice(0, 8)}` : null,
        node.announced && node.announced !== node.endpoint ? `announced ${node.announced}` : null,
    ].filter(Boolean).join(' · ')

    return (
        <div className={cn('py-2.5', isReplica && 'pl-4 border-l border-glass-border')}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <HoverTip label={node.endpoint} detail={detail || 'No further detail was read from this node.'}>
                    <span className="text-[12px] font-mono text-ink-secondary">{node.endpoint}</span>
                </HoverTip>
                <span className="text-[10px] uppercase tracking-wide text-ink-muted">{isReplica ? 'replica' : 'master'}</span>
                <HealthChip node={node} />
                {node.gossip && (
                    <HoverTip label={`Cluster bus: ${node.gossip}`} detail="What the other nodes think of this one. 'pfail' is one node's suspicion; 'fail' is the cluster's agreement.">
                        <span className="text-[10px] font-semibold uppercase tracking-wide text-red-600 dark:text-red-400">{node.gossip}</span>
                    </HoverTip>
                )}
                {uptime && (
                    <span className={cn(
                        'text-[10px]',
                        uptime.startsWith('restarted') ? 'text-sky-600 dark:text-sky-400 font-semibold' : 'text-ink-muted',
                    )}>
                        {uptime}
                    </span>
                )}
                {node.latencyMs != null && (
                    <span className="text-[10px] text-ink-muted tabular-nums">{Math.round(node.latencyMs)} ms</span>
                )}
                {isReplica && (
                    <span className="text-[10px] text-ink-muted">
                        link {node.replication?.masterLinkStatus ?? 'unknown'} · {lagLabel(node.replication?.lagBytes)}
                    </span>
                )}
                {node.graphCount != null && (
                    <span className="text-[10px] text-ink-muted tabular-nums">{node.graphCount} graph{node.graphCount === 1 ? '' : 's'}</span>
                )}
                {canAdjustLimits && limitsHref && (
                    <Link
                        to={limitsHref}
                        data-testid={`adjust-limits-${node.endpoint}`}
                        className="ml-auto inline-flex items-center gap-1 rounded-md border border-glass-border px-1.5 py-0.5 text-[10px] font-semibold text-ink-muted hover:text-ink hover:bg-black/[0.03] dark:hover:bg-white/[0.03] transition-colors"
                    >
                        <SlidersHorizontal className="w-3 h-3" /> Adjust limits
                    </Link>
                )}
            </div>

            <MemoryMeter node={node} reservePct={reservePct} />

            {node.status === 'unreachable' && node.error && (
                <p className="mt-1 text-[11px] text-red-600 dark:text-red-400 leading-snug">{node.error}</p>
            )}

            {!isReplica && (
                <p className="mt-1 text-[11px] text-ink-muted tabular-nums leading-snug">
                    {fitsEdges != null
                        ? <>fits ~<span className="text-ink-secondary">{compactEdges(fitsEdges)}</span> more rollup edges</>
                        : 'the rollup budget cannot be measured here'}
                    {heldNote && ` · ${heldNote}`}
                    {node.limits.queryMemCapacity != null && ` · per-query limit ${compactBytes(node.limits.queryMemCapacity)}`}
                    {node.limits.timeoutMaxMs != null && ` · query time cap ${Math.round(node.limits.timeoutMaxMs / 1000)} s`}
                    {node.limits.threadCount != null && ` · ${node.limits.threadCount} query threads`}
                    {' · '}
                    <HoverTip
                        label={effectsLabel(node.limits.effectsThresholdUs)}
                        detail="Below this cost per change, a write is replicated by re-running the whole query on every replica — on the replica's main thread, with no timeout. 0 means replicas apply a compact change log instead."
                    >
                        <span className={cn(
                            (node.limits.effectsThresholdUs ?? 0) > 0 && node.replication?.connectedReplicas
                                ? 'text-amber-600 dark:text-amber-400' : undefined,
                        )}>
                            {effectsLabel(node.limits.effectsThresholdUs)}
                        </span>
                    </HoverTip>
                </p>
            )}
        </div>
    )
}
