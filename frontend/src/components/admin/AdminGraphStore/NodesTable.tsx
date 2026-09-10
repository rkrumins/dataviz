/**
 * Every node of one instance as a flat table — the answer to "are all nine
 * up?", which a stack of shard cards makes you count.
 *
 * Also the compact node list a provider's connection card shows, so the two
 * places never describe the same cluster differently.
 */
import { cn } from '@/lib/utils'
import type { GraphStoreInstance, GraphStoreNode } from '@/services/graphStoreService'
import { compactBytes } from '../shared/aggregationKnobs'
import { HealthChip } from './NodeRow'
import { lagLabel, uptimeLabel } from './meta'

type Row = { node: GraphStoreNode; shard: number }

function rowsOf(instance: GraphStoreInstance): Row[] {
    const out: Row[] = []
    for (const shard of instance.shards) {
        out.push({ node: shard.master, shard: shard.index })
        for (const replica of shard.replicas) out.push({ node: replica, shard: shard.index })
    }
    return out
}

export function NodesTable({ instance, compact }: { instance: GraphStoreInstance; compact?: boolean }) {
    const rows = rowsOf(instance)
    // The shard a replica was discovered under, for the rare node whose own
    // INFO could not be read: the topology still knows whose it is.
    const masterOf = new Map<string, string>(
        instance.shards.flatMap(s => s.replicas.map(r => [r.endpoint, s.master.endpoint] as const)),
    )
    if (rows.length === 0) return null
    return (
        <div className="overflow-x-auto" data-testid="graph-store-nodes-table">
            <table className="w-full text-left">
                <thead>
                    <tr className="text-[10px] uppercase tracking-wide text-ink-muted">
                        <th scope="col" className="py-1 pr-3 font-medium">Node</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Shard</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Role</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Health</th>
                        <th scope="col" className="py-1 pr-3 font-medium text-right">Memory</th>
                        <th scope="col" className="py-1 pr-3 font-medium">Replication</th>
                        {!compact && <th scope="col" className="py-1 pr-3 font-medium text-right">Graphs</th>}
                        {!compact && <th scope="col" className="py-1 font-medium">Since</th>}
                    </tr>
                </thead>
                <tbody>
                    {rows.map(({ node, shard }) => {
                        const used = node.memory?.used
                        const max = node.memory?.maxmemory
                        const uptime = uptimeLabel(node)
                        return (
                            <tr key={node.endpoint} className="border-t border-glass-border">
                                <td className="py-1.5 pr-3 font-mono text-[11px] text-ink-secondary whitespace-nowrap">{node.endpoint}</td>
                                <td className="py-1.5 pr-3 text-[11px] text-ink-muted tabular-nums">{shard + 1}</td>
                                <td className="py-1.5 pr-3 text-[11px] text-ink-muted">{node.role}</td>
                                <td className="py-1.5 pr-3"><HealthChip node={node} /></td>
                                <td className="py-1.5 pr-3 text-[11px] text-ink-muted tabular-nums text-right whitespace-nowrap">
                                    {used == null ? '—' : max ? `${compactBytes(used)} / ${compactBytes(max)}` : compactBytes(used)}
                                </td>
                                <td className="py-1.5 pr-3 text-[11px] text-ink-muted whitespace-nowrap">
                                    {/* A replica names the master it follows: link status and
                                        lag say how it is going, not which node it is going with,
                                        and on nine rows that is the question. */}
                                    {node.role === 'replica'
                                        ? `replica of ${node.replication?.masterEndpoint ?? masterOf.get(node.endpoint) ?? 'unknown'} · ${node.replication?.masterLinkStatus ?? 'link unknown'} · ${lagLabel(node.replication?.lagBytes)}`
                                        : `${node.replication?.connectedReplicas ?? 0} replica${(node.replication?.connectedReplicas ?? 0) === 1 ? '' : 's'} attached`}
                                </td>
                                {!compact && (
                                    <td className="py-1.5 pr-3 text-[11px] text-ink-muted tabular-nums text-right">
                                        {node.graphCount ?? '—'}
                                    </td>
                                )}
                                {!compact && (
                                    <td className={cn(
                                        'py-1.5 text-[11px] whitespace-nowrap',
                                        uptime?.startsWith('restarted') ? 'text-sky-600 dark:text-sky-400' : 'text-ink-muted',
                                    )}>
                                        {uptime ?? '—'}
                                    </td>
                                )}
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </div>
    )
}

/** The nodes that did not answer, gathered so they cannot be scrolled past. */
export function UnreachableNodes({ instances }: { instances: GraphStoreInstance[] }) {
    const rows = instances.flatMap(instance =>
        instance.shards.flatMap(shard =>
            [shard.master, ...shard.replicas]
                .filter(n => n.status !== 'up')
                .map(node => ({ node, shard: shard.index, instance })),
        ),
    )
    if (rows.length === 0) return null
    return (
        <section
            data-testid="graph-store-unreachable"
            className="rounded-2xl border border-red-500/30 bg-red-500/[0.04] px-4 py-3"
        >
            <h3 className="text-[13px] font-semibold text-ink">
                {rows.length} node{rows.length === 1 ? '' : 's'} did not answer
            </h3>
            <p className="mt-0.5 text-[11px] text-ink-muted">
                A master that is away has its slots served by a promoted replica; until one is promoted, keys in its range
                cannot be read or written. Rebuilds that land there wait for it and keep their checkpoint.
            </p>
            <ul className="mt-2 space-y-1">
                {rows.map(({ node, shard, instance }) => (
                    <li key={`${instance.id}:${node.endpoint}`} className="text-[11px] text-ink-muted">
                        <span className="font-mono text-ink-secondary">{node.endpoint}</span>
                        {' · '}{node.role} of shard {shard + 1}
                        {node.error && ` · ${node.error}`}
                    </li>
                ))}
            </ul>
        </section>
    )
}
