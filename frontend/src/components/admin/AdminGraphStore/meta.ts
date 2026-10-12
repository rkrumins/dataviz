/**
 * The words and small numbers the Graph store page is made of.
 *
 * Kept apart from the components so the copy is readable in one place and
 * testable without rendering: this page exists to explain a distributed
 * store to someone who did not build it, and every figure on it needs a
 * plain sentence saying what it means and what to do when it looks wrong.
 */
import type { GraphStoreNode, GraphStoreShard } from '@/services/graphStoreService'

export function slotRangeLabel(shard: Pick<GraphStoreShard, 'slotRanges'>): string | null {
    if (!shard.slotRanges?.length) return null
    return shard.slotRanges.map(([lo, hi]) => (lo === hi ? `${lo}` : `${lo}–${hi}`)).join(', ')
}

/** "up 3d 4h" / "restarted 6 min ago" — the second is the one that matters
 *  when a rebuild just failed, so it is said in those words. */
export function uptimeLabel(node: Pick<GraphStoreNode, 'server'>): string | null {
    const s = node.server?.uptimeS
    if (typeof s !== 'number' || s < 0) return null
    if (s < 60) return `restarted ${Math.max(1, Math.round(s))}s ago`
    if (s < 3600) return `restarted ${Math.round(s / 60)} min ago`
    if (s < 86_400) return `up ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`
    return `up ${Math.floor(s / 86_400)}d ${Math.round((s % 86_400) / 3600)}h`
}

/** True while a restart is recent enough that an operator should connect it
 *  to whatever else they are looking at. */
export function recentlyRestarted(node: Pick<GraphStoreNode, 'server'>): boolean {
    const s = node.server?.uptimeS
    return (typeof s === 'number' && s < 900) || node.server?.restartedSinceLast === true
}

/** "from a reading 2 min ago" — what a node that is not answering is being
 *  described by. A blank where its memory used to be reads as an outage;
 *  its last figures with their age read as what a rolling restart is. */
export function carriedLabel(node: Pick<GraphStoreNode, 'figuresAgeS'>): string | null {
    const s = node.figuresAgeS
    if (typeof s !== 'number') return null
    if (s < 90) return `from a reading ${Math.max(1, Math.round(s))}s ago`
    return `from a reading ${Math.round(s / 60)} min ago`
}

export function lagLabel(bytes: number | null | undefined): string {
    if (bytes == null) return 'lag unknown'
    if (bytes <= 0) return 'in step'
    if (bytes < 1024) return `${bytes} B behind`
    if (bytes < 1024 ** 2) return `${Math.round(bytes / 1024)} KB behind`
    if (bytes < 1024 ** 3) return `${Math.round(bytes / 1024 ** 2)} MB behind`
    return `${(bytes / 1024 ** 3).toFixed(1)} GB behind`
}

export function effectsLabel(us: number | null | undefined): string {
    if (us == null) return 'effects threshold unknown'
    if (us === 0) return 'replicates as effects'
    return `effects threshold ${us.toLocaleString()} µs`
}

export type NodeHealth = 'up' | 'restarting' | 'lagging' | 'unreachable'

export function nodeHealth(node: GraphStoreNode): NodeHealth {
    if (node.status !== 'up' || node.gossip === 'fail' || node.gossip === 'noaddr') return 'unreachable'
    if (node.server?.loading || recentlyRestarted(node)) return 'restarting'
    if (node.role === 'replica') {
        const link = node.replication?.masterLinkStatus
        if (link && link !== 'up') return 'lagging'
    }
    return 'up'
}

export const HEALTH_META: Record<NodeHealth, { label: string; chip: string; meaning: string }> = {
    up: {
        label: 'Up',
        chip: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/25',
        meaning: 'The node answered, and its replicas (if any) are following it.',
    },
    restarting: {
        label: 'Restarting',
        chip: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25',
        meaning: 'The node came back recently or is loading its data. Reads for its shard are served by its replicas; rebuilds wait for it and keep their checkpoint.',
    },
    lagging: {
        label: 'Behind',
        chip: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
        meaning: 'This replica is not in step with its master. A rebuild paces itself against this.',
    },
    unreachable: {
        label: 'Unreachable',
        chip: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25',
        meaning: 'The node did not answer. If it is a master, the cluster promotes one of its replicas; until then its slots are not served.',
    },
}

export const SEVERITY_CHIP: Record<'info' | 'warn' | 'critical', string> = {
    info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25',
    warn: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25',
    critical: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/25',
}

export const GRAPH_ROLE_LABEL: Record<string, string> = {
    source: 'Source graph',
    projection: 'Rollup projection',
    unregistered: 'Unregistered',
}

/** How to read this page — the collapsible glossary. Every term here is one
 *  a person meets on the page itself, in the order they meet it. */
export const GLOSSARY: { term: string; text: string }[] = [
    {
        term: 'Instance',
        text: 'One graph store. Provider rows that turn out to point at the same store — disjoint seeds of one cluster, or one node named by its service name and by its address — share a card, so its nodes and memory are counted once rather than once per row. Which store a row reaches is settled by asking the nodes what they call themselves, not by comparing connection settings.',
    },
    {
        term: 'Shard and slot range',
        text: 'A Redis Cluster splits the keyspace into 16,384 slots. Each shard owns a range of them; a graph key hashes to exactly one slot, so its shard is decided by its name, not by where it was created.',
    },
    {
        term: 'Master and replica',
        text: 'The master serves its slots and takes every write. Its replicas copy those writes and stand ready to be promoted when it goes away. Slot coverage below 16,384 means some keys have no master right now.',
    },
    {
        term: 'Lag',
        text: 'How many bytes of the write stream a replica has not applied yet. Steady lag under load is normal; lag that climbs during a rebuild means the replicas cannot keep up, and a rebuild waits for them rather than outrunning them.',
    },
    {
        term: 'Used, maxmemory and the reserve',
        text: 'Used is what the node holds now; maxmemory is the ceiling it was given. The fleet reserve is the slice a rebuild will not write into, so a node stays responsive rather than filling to the brim. The figure at the top of the page adds up the MASTERS — the size of the data itself. Each replica holds its own copy, so the memory the deployment actually needs is that figure multiplied by one plus the replicas per shard.',
    },
    {
        term: '"Fits ~N more rollup edges"',
        text: 'The free memory after the reserve, divided by the fleet bytes-per-edge. It is the same arithmetic the next rebuild does before it writes, so the page and the run never disagree.',
    },
    {
        term: 'Cannot govern vs unreachable',
        text: 'A node with no maxmemory answered, but nothing can be measured against it: rebuilds landing there fall back to a static edge cap. An unreachable node did not answer at all.',
    },
    {
        term: 'Unregistered graph',
        text: 'A graph key on the node that no data source claims. Usually a leftover from a deleted source or a manual experiment; it still takes memory.',
    },
    {
        term: 'Measured vs estimated size',
        text: 'Measured comes from asking the node itself (sampled, so it is close rather than exact). Estimated is the edge count times the fleet bytes-per-edge, used where a measurement is not available.',
    },
    {
        term: 'Effects threshold',
        text: 'Below this cost per change, the store replicates a write by RE-RUNNING the whole query on every replica — on the replica’s main thread, with no timeout. Set it to 0 so replicas apply a compact change log instead; that is what keeps them answering during a large rebuild.',
    },
    {
        term: 'Why a rebuild waits for replicas',
        text: 'A rebuild asks the master how many replicas have acknowledged its writes and holds when they fall behind. Without that it can drive a replica hard enough to miss its health probe and be restarted, which takes the shard with it.',
    },
]
