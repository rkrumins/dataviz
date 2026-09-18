/**
 * Which graph store node each running rebuild is writing.
 *
 * The first question during the memory incident was "what ELSE is writing
 * this shard right now", and nothing could answer it: the Graph store page
 * knows nodes, Job History knows jobs, and the two never met. A run's own
 * record now names its node from the first checkpoint with a measured
 * reading, so the join is a group-by over rows the page already has.
 *
 * Why it matters and not just as trivia: a shard holds many graphs, so two
 * rebuilds can be writing one master while each holds its own graph's lease.
 * They are bounded — the reservation ledger for memory, two write slots per
 * node, and neither gets the pacing floor while the other is there — but
 * bounded is not free, and "why is this run slow" is usually answered by the
 * run next to it.
 */
import type { AggregationJobResponse } from '@/services/aggregationService'

export interface NodeLoad {
    /** ``host:port`` of the graph store node. */
    node: string
    runs: AggregationJobResponse[]
    /** More than one rebuild writing one master. */
    shared: boolean
}

/** The node a run says it is writing, or null when it has not said. */
export function nodeOf(job: AggregationJobResponse): string | null {
    const stats = job.runStats as { node?: unknown } | null | undefined
    const node = stats?.node
    return typeof node === 'string' && node ? node : null
}

/**
 * Active runs grouped by the node they write, busiest node first, then by
 * address so the order is stable between polls. Runs that have not named a
 * node yet (still preparing, or a store that cannot be measured) are left
 * out rather than bucketed under "unknown" — a list of nodes with a phantom
 * entry in it is worse than a shorter list.
 */
export function nodeLoads(jobs: AggregationJobResponse[]): NodeLoad[] {
    const byNode = new Map<string, AggregationJobResponse[]>()
    for (const job of jobs) {
        if (job.status !== 'running') continue
        const node = nodeOf(job)
        if (!node) continue
        const list = byNode.get(node) ?? []
        list.push(job)
        byNode.set(node, list)
    }
    return [...byNode.entries()]
        .map(([node, runs]) => ({ node, runs, shared: runs.length > 1 }))
        .sort((a, b) => b.runs.length - a.runs.length || a.node.localeCompare(b.node))
}
