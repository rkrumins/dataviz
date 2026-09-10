"""The graph store's shape, for people.

One snapshot answers every question the operator surfaces ask: which nodes
exist (masters AND replicas), how full each one is, how far behind each
replica is, which graphs live on which shard, and which data source owns
each graph. Every field is optional-by-absence: a node that could not be
read is still listed, with the reason, because a node missing from a list
is indistinguishable from a node that does not exist — and that is exactly
how three of nine nodes went unnoticed.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional

from pydantic import BaseModel, Field

from ..aggregation.schemas import CapacityLimits, ShardCapacity


class _Base(BaseModel):
    class Config:
        populate_by_name = True


class NodeMemory(_Base):
    """What one node holds. ``usedPct`` is None without a ``maxmemory``:
    unlimited is unknowable, never full."""
    used: Optional[int] = None
    rss: Optional[int] = None
    peak: Optional[int] = None
    maxmemory: Optional[int] = None
    policy: Optional[str] = None
    used_pct: Optional[float] = Field(None, alias="usedPct")
    fragmentation_ratio: Optional[float] = Field(None, alias="fragmentationRatio")
    # What replication itself costs here — the buffers that overflow into a
    # full resync when writes outrun the replicas.
    mem_clients_replicas: Optional[int] = Field(None, alias="memClientsReplicas")
    mem_repl_backlog: Optional[int] = Field(None, alias="memReplBacklog")
    # "warn" | "critical" from the shared memory-pressure verdict, else None.
    level: Optional[str] = None


class NodeReplicaLink(_Base):
    """One replica as its master sees it."""
    endpoint: str
    state: Optional[str] = None
    offset: Optional[int] = None
    lag_bytes: Optional[int] = Field(None, alias="lagBytes")
    lag_s: Optional[int] = Field(None, alias="lagS")


class NodeReplication(_Base):
    role: Optional[str] = None
    master_endpoint: Optional[str] = Field(None, alias="masterEndpoint")
    master_link_status: Optional[str] = Field(None, alias="masterLinkStatus")
    master_sync_in_progress: Optional[bool] = Field(None, alias="masterSyncInProgress")
    master_last_io_s: Optional[int] = Field(None, alias="masterLastIoS")
    repl_offset: Optional[int] = Field(None, alias="replOffset")
    lag_bytes: Optional[int] = Field(None, alias="lagBytes")
    connected_replicas: Optional[int] = Field(None, alias="connectedReplicas")
    replicas: List[NodeReplicaLink] = Field(default_factory=list)


class NodeServer(_Base):
    redis_version: Optional[str] = Field(None, alias="redisVersion")
    uptime_s: Optional[int] = Field(None, alias="uptimeS")
    # Regenerated on every start: a changed run id proves a restart.
    run_id: Optional[str] = Field(None, alias="runId")
    connected_clients: Optional[int] = Field(None, alias="connectedClients")
    ops_per_sec: Optional[int] = Field(None, alias="opsPerSec")
    loading: Optional[bool] = None
    bgsave_in_progress: Optional[bool] = Field(None, alias="bgsaveInProgress")
    aof_rewrite_in_progress: Optional[bool] = Field(None, alias="aofRewriteInProgress")
    latest_fork_usec: Optional[int] = Field(None, alias="latestForkUsec")
    sync_full: Optional[int] = Field(None, alias="syncFull")
    sync_partial_err: Optional[int] = Field(None, alias="syncPartialErr")
    # True when this node's run id differs from the previous snapshot's.
    restarted_since_last: Optional[bool] = Field(None, alias="restartedSinceLast")


class NodeLimits(_Base):
    """The node's own ``GRAPH.CONFIG`` ceilings — masters only."""
    query_mem_capacity: Optional[int] = Field(None, alias="queryMemCapacity")
    timeout_max_ms: Optional[int] = Field(None, alias="timeoutMaxMs")
    timeout_default_ms: Optional[int] = Field(None, alias="timeoutDefaultMs")
    thread_count: Optional[int] = Field(None, alias="threadCount")
    # µs per modification above which a write replicates as a change log
    # instead of being re-run on every replica. 0 = always as effects.
    effects_threshold_us: Optional[int] = Field(None, alias="effectsThresholdUs")
    # Replication buffers, from CONFIG GET — what a rebuild can overflow.
    repl_backlog_bytes: Optional[int] = Field(None, alias="replBacklogBytes")
    replica_buffer_hard_bytes: Optional[int] = Field(None, alias="replicaBufferHardBytes")
    cluster_node_timeout_ms: Optional[int] = Field(None, alias="clusterNodeTimeoutMs")


class GraphStoreNode(_Base):
    """One node of one instance. Always present, even when unreachable."""
    endpoint: str
    # The address the cluster announced, before the operator's addressRemap.
    announced: Optional[str] = None
    node_id: Optional[str] = Field(None, alias="nodeId")
    role: Literal["master", "replica"] = "master"
    status: Literal["up", "unreachable"] = "up"
    error: Optional[str] = None
    latency_ms: Optional[float] = Field(None, alias="latencyMs")
    # What the cluster bus thinks: "fail" / "pfail" / "noaddr", else None.
    gossip: Optional[str] = None
    memory: NodeMemory = Field(default_factory=NodeMemory)
    replication: NodeReplication = Field(default_factory=NodeReplication)
    server: NodeServer = Field(default_factory=NodeServer)
    limits: NodeLimits = Field(default_factory=NodeLimits)
    graph_count: Optional[int] = Field(None, alias="graphCount")
    # "measured" | "unsupported" | "skipped" — whether per-graph sizes on
    # this node were measured, refused by the server, or ran out of budget.
    graph_memory: Optional[str] = Field(None, alias="graphMemory")


class DataSourceRef(_Base):
    id: str
    label: Optional[str] = None
    workspace_id: Optional[str] = Field(None, alias="workspaceId")
    workspace_name: Optional[str] = Field(None, alias="workspaceName")
    catalog_item_id: Optional[str] = Field(None, alias="catalogItemId")
    provider_id: Optional[str] = Field(None, alias="providerId")
    aggregation_status: Optional[str] = Field(None, alias="aggregationStatus")
    edge_count: int = Field(0, alias="edgeCount")


class GraphOnShard(_Base):
    """One graph key on one shard, and who owns it.

    ``present`` False means the key is registered to a data source but the
    node does not hold it (never rebuilt, or dropped) — the row stays, so a
    missing graph is visible instead of silently absent.
    """
    key: str
    slot: int
    present: bool = True
    role: Literal["source", "projection", "unregistered"] = "source"
    data_sources: List[DataSourceRef] = Field(default_factory=list, alias="dataSources")
    edge_count: int = Field(0, alias="edgeCount")
    estimated_bytes: Optional[int] = Field(None, alias="estimatedBytes")
    measured_bytes: Optional[int] = Field(None, alias="measuredBytes")
    measured_detail: Optional[Dict[str, int]] = Field(None, alias="measuredDetail")


class ReplicationFinding(_Base):
    """One thing wrong with this shard's replication, and the way out."""
    code: str
    severity: Literal["info", "warn", "critical"] = "warn"
    text: str
    fix: Optional[str] = None
    # An endpoint the fix applies to (opens the limits dialog there).
    endpoint: Optional[str] = None


class ReplicationHealth(_Base):
    replicas_total: int = Field(0, alias="replicasTotal")
    replicas_online: int = Field(0, alias="replicasOnline")
    max_lag_bytes: Optional[int] = Field(None, alias="maxLagBytes")
    full_resyncs: Optional[int] = Field(None, alias="fullResyncs")
    partial_resync_errors: Optional[int] = Field(None, alias="partialResyncErrors")
    effects_threshold_us: Optional[int] = Field(None, alias="effectsThresholdUs")
    findings: List[ReplicationFinding] = Field(default_factory=list)


class GraphStoreShard(_Base):
    """One master, its replicas, the slots it owns and the graphs on it."""
    index: int
    slot_ranges: List[List[int]] = Field(default_factory=list, alias="slotRanges")
    slot_count: int = Field(0, alias="slotCount")
    master: GraphStoreNode
    replicas: List[GraphStoreNode] = Field(default_factory=list)
    graphs: List[GraphOnShard] = Field(default_factory=list)
    #: Every graph on this shard by key — INCLUDING the ones below the
    #: display cap on ``graphs`` above. Excluded from the response: it is
    #: what a placement question is answered from, so a modest graph that
    #: sorts below the cap is never reported as missing from the node it is
    #: sitting on. That answer reaches an ordinary user, on their own data
    #: source's profile, which is the last place to guess.
    rows_by_key: Dict[str, GraphOnShard] = Field(default_factory=dict, exclude=True)
    graphs_total: int = Field(0, alias="graphsTotal")
    graphs_truncated: bool = Field(False, alias="graphsTruncated")
    unregistered_count: int = Field(0, alias="unregisteredCount")
    replication: ReplicationHealth = Field(default_factory=ReplicationHealth)
    # The rollup write budget for this master — the same arithmetic the
    # rebuild applies, so the page and the run never disagree.
    capacity: Optional[ShardCapacity] = None


class ProviderRef(_Base):
    id: str
    name: Optional[str] = None
    is_active: bool = Field(True, alias="isActive")


class InstanceTotals(_Base):
    masters: int = 0
    replicas: int = 0
    nodes_up: int = Field(0, alias="nodesUp")
    nodes_total: int = Field(0, alias="nodesTotal")
    graphs: int = 0
    unregistered_graphs: int = Field(0, alias="unregisteredGraphs")
    used_memory: Optional[int] = Field(None, alias="usedMemory")
    maxmemory: Optional[int] = None


class GraphStoreInstance(_Base):
    """One graph store — every provider row that points at it, and every node.

    Providers sharing a topology share an instance: two rows listing
    different seeds of one cluster are one store, and showing them twice
    would double every figure on the page.
    """
    id: str
    providers: List[ProviderRef] = Field(default_factory=list)
    # True for the environment-configured default instance (no provider row).
    env_default: bool = Field(False, alias="envDefault")
    mode: str = "standalone"
    seeds: List[str] = Field(default_factory=list)
    seed_used: Optional[str] = Field(None, alias="seedUsed")
    # "clusterNodes" | "clusterSlots" | "sentinel" | "info"
    discovered_via: Optional[str] = Field(None, alias="discoveredVia")
    reachable: bool = True
    error: Optional[str] = None
    slots_covered: Optional[int] = Field(None, alias="slotsCovered")
    slots_missing: Optional[str] = Field(None, alias="slotsMissing")
    shards: List[GraphStoreShard] = Field(default_factory=list)
    totals: InstanceTotals = Field(default_factory=InstanceTotals)


class FleetSummary(_Base):
    instances: int = 0
    providers: int = 0
    masters: int = 0
    replicas: int = 0
    nodes_up: int = Field(0, alias="nodesUp")
    nodes_total: int = Field(0, alias="nodesTotal")
    graphs: int = 0
    unregistered_graphs: int = Field(0, alias="unregisteredGraphs")
    used_memory: Optional[int] = Field(None, alias="usedMemory")
    maxmemory: Optional[int] = None
    unreachable_nodes: int = Field(0, alias="unreachableNodes")
    findings: int = 0


class GraphStoreTopologyResponse(_Base):
    instances: List[GraphStoreInstance] = Field(default_factory=list)
    summary: FleetSummary = Field(default_factory=FleetSummary)
    limits: Optional[CapacityLimits] = None
    measured_at: Optional[str] = Field(None, alias="measuredAt")
    cache_age_ms: int = Field(0, alias="cacheAgeMs")
    ttl_s: float = Field(30.0, alias="ttlS")
    # True when this reading is the last good one and the refresh behind it
    # failed — the page shows the figures it has instead of going blank.
    stale: bool = False
    last_error: Optional[str] = Field(None, alias="lastError")


class ReadRouting(_Base):
    """How this provider's reads were actually served, IN THIS PROCESS.

    Per web pod, since a provider proxy is per process — so the figures say
    "replica routing is working here", not "across the fleet". That is still
    the question an operator needs answered after turning it on, and nothing
    else answers it: a replica read and a master read look identical from the
    outside.
    """
    replica_reads: int = Field(0, alias="replicaReads")
    master_reads: int = Field(0, alias="masterReads")
    # A read a replica failed, re-issued on the master. Steady growth here
    # means a replica is unwell, not that routing is wrong.
    replica_fallbacks: int = Field(0, alias="replicaFallbacks")


class ProviderTopologyResponse(_Base):
    provider_id: str = Field(alias="providerId")
    provider_name: Optional[str] = Field(None, alias="providerName")
    instance: Optional[GraphStoreInstance] = None
    reads: Optional[ReadRouting] = None
    measured_at: Optional[str] = Field(None, alias="measuredAt")
    cache_age_ms: int = Field(0, alias="cacheAgeMs")
    stale: bool = False
    last_error: Optional[str] = Field(None, alias="lastError")


class GraphPlacement(_Base):
    """Where one graph key lives, and what shares its shard."""
    graph_key: str = Field(alias="graphKey")
    role: Literal["source", "projection"] = "source"
    slot: int
    shard_index: Optional[int] = Field(None, alias="shardIndex")
    present: bool = True
    master: Optional[GraphStoreNode] = None
    replicas: List[GraphStoreNode] = Field(default_factory=list)
    siblings: int = 0
    siblings_sample: List[Dict[str, Any]] = Field(default_factory=list, alias="siblingsSample")
    edge_count: int = Field(0, alias="edgeCount")
    estimated_bytes: Optional[int] = Field(None, alias="estimatedBytes")
    measured_bytes: Optional[int] = Field(None, alias="measuredBytes")


class GraphPlacementResponse(_Base):
    data_source_id: Optional[str] = Field(None, alias="dataSourceId")
    provider_id: Optional[str] = Field(None, alias="providerId")
    provider_name: Optional[str] = Field(None, alias="providerName")
    instance_id: Optional[str] = Field(None, alias="instanceId")
    mode: str = "standalone"
    reachable: bool = True
    error: Optional[str] = None
    placements: List[GraphPlacement] = Field(default_factory=list)
    totals: InstanceTotals = Field(default_factory=InstanceTotals)
    measured_at: Optional[str] = Field(None, alias="measuredAt")
    cache_age_ms: int = Field(0, alias="cacheAgeMs")
    stale: bool = False


class PlacementBrief(_Base):
    """The compact answer for a list surface: one chip's worth."""
    graph_key: str = Field(alias="graphKey")
    shard_index: Optional[int] = Field(None, alias="shardIndex")
    master: Optional[str] = None
    status: Optional[str] = None
    present: bool = True


class GraphPlacementsResponse(_Base):
    placements: Dict[str, PlacementBrief] = Field(default_factory=dict)
    measured_at: Optional[str] = Field(None, alias="measuredAt")
    cache_age_ms: int = Field(0, alias="cacheAgeMs")
    stale: bool = False
