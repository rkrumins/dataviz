/**
 * The graph store's shape, read once and shared by every surface.
 *
 * One snapshot answers what used to take a per-source probe each: which
 * nodes exist (masters AND replicas), how full each one is, how far behind
 * each replica is, which graphs live on which shard, and which data source
 * owns each graph. Everything here is a read — the page never dials a node
 * itself, and the server keeps its last good reading when a refresh fails.
 */
import { authFetch } from './apiClient'
import type { CapacityLimits, ShardCapacity } from './aggregationService'

export interface NodeMemory {
    used?: number | null
    rss?: number | null
    peak?: number | null
    maxmemory?: number | null
    policy?: string | null
    usedPct?: number | null
    fragmentationRatio?: number | null
    /** What replication itself costs here — the buffers a fast rebuild overflows. */
    memClientsReplicas?: number | null
    memReplBacklog?: number | null
    /** 'warn' | 'critical' from the shared memory-pressure verdict. */
    level?: string | null
}

export interface NodeReplicaLink {
    endpoint: string
    state?: string | null
    offset?: number | null
    lagBytes?: number | null
    lagS?: number | null
}

export interface NodeReplication {
    role?: string | null
    masterEndpoint?: string | null
    masterLinkStatus?: string | null
    masterSyncInProgress?: boolean | null
    masterLastIoS?: number | null
    replOffset?: number | null
    lagBytes?: number | null
    connectedReplicas?: number | null
    replicas: NodeReplicaLink[]
}

export interface NodeServer {
    redisVersion?: string | null
    uptimeS?: number | null
    runId?: string | null
    connectedClients?: number | null
    opsPerSec?: number | null
    loading?: boolean | null
    bgsaveInProgress?: boolean | null
    aofRewriteInProgress?: boolean | null
    latestForkUsec?: number | null
    syncFull?: number | null
    syncPartialErr?: number | null
    /** The run id changed since the previous reading: the node restarted. */
    restartedSinceLast?: boolean | null
}

export interface NodeLimits {
    queryMemCapacity?: number | null
    timeoutMaxMs?: number | null
    timeoutDefaultMs?: number | null
    threadCount?: number | null
    /** µs per modification above which a write ships a change log instead of
     *  being re-run on every replica. 0 = always as effects. */
    effectsThresholdUs?: number | null
    replBacklogBytes?: number | null
    replicaBufferHardBytes?: number | null
    clusterNodeTimeoutMs?: number | null
}

export interface GraphStoreNode {
    endpoint: string
    /** What the cluster calls this node. Its identity — two nodes can share
     *  an address, and then every figure keyed by one counts them as one. */
    /** The address the cluster announced, before the operator's remap. */
    announced?: string | null
    nodeId?: string | null
    role: 'master' | 'replica' | 'joining'
    status: 'up' | 'unreachable'
    error?: string | null
    latencyMs?: number | null
    /** What the cluster bus thinks: 'fail' | 'pfail' | 'noaddr'. */
    gossip?: string | null
    memory: NodeMemory
    replication: NodeReplication
    server: NodeServer
    limits: NodeLimits
    graphCount?: number | null
    /** 'measured' | 'unsupported' | 'skipped' for the per-graph sizes. */
    graphMemory?: string | null
}

export interface DataSourceRef {
    id: string
    label?: string | null
    workspaceId?: string | null
    workspaceName?: string | null
    catalogItemId?: string | null
    providerId?: string | null
    aggregationStatus?: string | null
    edgeCount: number
}

export interface GraphOnShard {
    key: string
    slot: number
    /** False: registered to a data source, but the node does not hold it. */
    present: boolean
    role: 'source' | 'projection' | 'unregistered'
    dataSources: DataSourceRef[]
    edgeCount: number
    estimatedBytes?: number | null
    measuredBytes?: number | null
    measuredDetail?: Record<string, number> | null
}

export interface ReplicationFinding {
    code: string
    severity: 'info' | 'warn' | 'critical'
    text: string
    fix?: string | null
    endpoint?: string | null
}

export interface ReplicationHealth {
    replicasTotal: number
    replicasOnline: number
    maxLagBytes?: number | null
    fullResyncs?: number | null
    partialResyncErrors?: number | null
    effectsThresholdUs?: number | null
    findings: ReplicationFinding[]
}

export interface GraphStoreShard {
    index: number
    slotRanges: number[][]
    slotCount: number
    master: GraphStoreNode
    replicas: GraphStoreNode[]
    graphs: GraphOnShard[]
    graphsTotal: number
    graphsTruncated: boolean
    unregisteredCount: number
    replication: ReplicationHealth
    capacity?: ShardCapacity | null
}

export interface ProviderRef {
    id: string
    name?: string | null
    isActive: boolean
}

export interface InstanceTotals {
    masters: number
    replicas: number
    nodesUp: number
    nodesTotal: number
    graphs: number
    unregisteredGraphs: number
    usedMemory?: number | null
    maxmemory?: number | null
}

export interface GraphStoreInstance {
    id: string
    providers: ProviderRef[]
    mode: string
    seeds: string[]
    seedUsed?: string | null
    discoveredVia?: string | null
    reachable: boolean
    error?: string | null
    slotsCovered?: number | null
    slotsMissing?: string | null
    shards: GraphStoreShard[]
    /** Nodes the cluster knows that belong to no shard: one mid-MEET, one
     *  the cluster announces no address for, one following a master this
     *  view cannot see. Reported rather than invented into a shard. */
    unplacedNodes?: GraphStoreNode[]
    /** `cluster_known_nodes` — the cluster's own count of itself. */
    knownNodes?: number | null
    clusterState?: string | null
    /** Whole-store problems, as opposed to one shard's replication. */
    findings?: ReplicationFinding[]
    totals: InstanceTotals
}

export interface FleetSummary {
    instances: number
    providers: number
    masters: number
    replicas: number
    nodesUp: number
    nodesTotal: number
    graphs: number
    unregisteredGraphs: number
    usedMemory?: number | null
    maxmemory?: number | null
    unreachableNodes: number
    findings: number
}

export interface GraphStoreTopologyResponse {
    instances: GraphStoreInstance[]
    summary: FleetSummary
    limits?: CapacityLimits | null
    measuredAt?: string | null
    cacheAgeMs: number
    ttlS: number
    /** The reading is the last good one; the refresh behind it failed. */
    stale: boolean
    lastError?: string | null
    /** A sweep is running now. With no instances alongside it this is the
     *  first reading of a store the page has never seen; with instances it
     *  is a refresh behind figures already on screen. */
    refreshing?: boolean
}

export interface ReadRouting {
    /** How this provider's reads were served IN THE POD that answered — a
     *  provider proxy is per process, so this says "replica routing is
     *  working here", not "across the fleet". */
    replicaReads: number
    masterReads: number
    /** A read a replica failed, re-issued on the master. Steady growth means
     *  a replica is unwell, not that the routing is wrong. */
    replicaFallbacks: number
}

export interface ProviderTopologyResponse {
    providerId: string
    providerName?: string | null
    instance?: GraphStoreInstance | null
    /** Absent when no provider for this connection is built in this pod yet. */
    reads?: ReadRouting | null
    measuredAt?: string | null
    cacheAgeMs: number
    stale: boolean
    lastError?: string | null
}

export interface GraphPlacement {
    graphKey: string
    role: 'source' | 'projection'
    slot: number
    shardIndex?: number | null
    present: boolean
    master?: GraphStoreNode | null
    replicas: GraphStoreNode[]
    siblings: number
    siblingsSample: { key: string; label?: string | null; bytes?: number | null }[]
    edgeCount: number
    estimatedBytes?: number | null
    measuredBytes?: number | null
}

export interface GraphPlacementResponse {
    dataSourceId?: string | null
    providerId?: string | null
    providerName?: string | null
    instanceId?: string | null
    mode: string
    reachable: boolean
    error?: string | null
    placements: GraphPlacement[]
    totals: InstanceTotals
    measuredAt?: string | null
    cacheAgeMs: number
    stale: boolean
}

export interface PlacementBrief {
    graphKey: string
    shardIndex?: number | null
    master?: string | null
    status?: string | null
    present: boolean
}

export interface GraphPlacementsResponse {
    /** data source id → the one chip: which shard its graph is on. */
    placements: Record<string, PlacementBrief>
    measuredAt?: string | null
    cacheAgeMs: number
    stale: boolean
}

const BASE = '/api/v1/admin/graph-store'

export const graphStoreService = {
    /** Every node of every graph store this deployment talks to. */
    async getTopology(fresh = false): Promise<GraphStoreTopologyResponse> {
        return authFetch<GraphStoreTopologyResponse>(`${BASE}/topology${fresh ? '?fresh=true' : ''}`)
    },

    /** One provider's instance — the same nodes, scoped to its connection. */
    async getProviderTopology(providerId: string, fresh = false): Promise<ProviderTopologyResponse> {
        return authFetch<ProviderTopologyResponse>(
            `${BASE}/providers/${encodeURIComponent(providerId)}${fresh ? '?fresh=true' : ''}`,
        )
    },

    /** Where one data source's graphs live, and what shares their shards. */
    async getPlacement(dataSourceId: string): Promise<GraphPlacementResponse> {
        return authFetch<GraphPlacementResponse>(
            `${BASE}/placement?dataSourceId=${encodeURIComponent(dataSourceId)}`,
        )
    },

    /** One chip's worth per source, for a list — never one request per row. */
    async getPlacements(dataSourceIds: string[]): Promise<GraphPlacementsResponse> {
        return authFetch<GraphPlacementsResponse>(
            `${BASE}/placements?dataSourceIds=${encodeURIComponent(dataSourceIds.join(','))}`,
        )
    },
}
