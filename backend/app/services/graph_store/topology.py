"""One picture of every graph store: nodes, shards, replicas, graphs.

Why this exists. Two separate code paths used to decide which graph-store
nodes anyone could see, and both were partial: the infrastructure probe
enumerated only the primaries the ENVIRONMENT names, and the rollup
capacity sweep only ever read a node that happened to own an aggregated
source's graph. A nine-node cluster showed three nodes, replicas were
invisible everywhere, and a node with no rollups on it did not exist as
far as the product was concerned.

This module reads the topology from the providers' own connection settings
and reports EVERY node — masters and replicas — with what it holds, how it
is replicating, and which graphs live on it. One snapshot behind a short
TTL feeds every surface (the Graph store page, rollup capacity, a data
source's placement, a provider's node table), so a hundred viewers cost
one sweep and nothing a viewer does can disturb a rebuild.

The snapshot is deliberately boring under failure: a node that cannot be
read is listed with its reason, a refresh that fails keeps serving the
last good reading, and the order never depends on live utilisation — a
row that jumps between refreshes is indistinguishable from a row that
changed, which is how "cannot be measured" became background noise.
"""
from __future__ import annotations

import asyncio
import logging
import math
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from backend.app.providers.falkordb_connection import (
    FalkorDBConnConfig,
    connect_verify_budget,
)
from backend.app.providers.shard_capacity import ShardMemory
from . import discovery, info_parse
from .discovery import RawNode, RawTopology
from .schemas import (
    DataSourceRef,
    FleetSummary,
    GraphOnShard,
    GraphPlacement,
    GraphStoreInstance,
    GraphStoreNode,
    GraphStoreShard,
    GraphStoreTopologyResponse,
    InstanceTotals,
    NodeLimits,
    NodeMemory,
    NodeReplicaLink,
    NodeReplication,
    NodeServer,
    ProviderRef,
    ReplicationFinding,
    ReplicationHealth,
)

logger = logging.getLogger(__name__)

#: Graphs per shard in the response. The counts are always exact; only the
#: per-graph rows are capped, so a store with thousands of graphs stays a
#: page rather than a download.
MAX_GRAPH_ROWS_PER_SHARD = 2000
#: How many nodes are read at once across the whole fleet.
#: Nodes read at once. A sweep is I/O against short-lived connections, so
#: the ceiling is the store's patience rather than ours — and a wave costs
#: a whole node budget, so a 9-node cluster read 8 at a time takes TWO of
#: them and blows through any ordinary gateway timeout before it starts.
_NODE_CONCURRENCY = 24
#: However large the fleet, one sweep may not hold the build lock longer.
_SWEEP_DEADLINE_CAP_S = 60.0
#: How long a failed sweep is remembered before another is attempted. Without
#: it a store that is down turns every arriving request into its own full
#: sweep, and the build lock queues them rather than sharing one.
_FAILURE_BACKOFF_S = 5.0
#: A replica this far behind is called out: one apply batch is orders of
#: magnitude smaller, so this much backlog means it is not keeping up.
_LAG_WARN_BYTES = 64 * 1024 ** 2
#: Below this the replica output buffer overflows under a rebuild and the
#: master drops the replica into a full resync.
_REPLICA_BUFFER_MIN_BYTES = 1024 ** 3


def _ttl_s() -> float:
    try:
        return max(1.0, float(os.getenv("GRAPH_STORE_TOPOLOGY_CACHE_TTL_S", "30")))
    except (TypeError, ValueError):
        return 30.0


def _deadline_s() -> float:
    """The budget for ONE wave of nodes — see :func:`_sweep_deadline_s`."""
    try:
        return max(1.0, float(os.getenv("GRAPH_STORE_TOPOLOGY_DEADLINE_S", "8")))
    except (TypeError, ValueError):
        return 8.0


def _sweep_deadline_s(jobs: int) -> float:
    """How long the whole sweep may take to read ``jobs`` nodes.

    A fixed fleet-wide deadline reads as generous on a 9-node cluster and
    starves a large one: nodes are read ``_NODE_CONCURRENCY`` at a time, so
    past that many the later waves share what the earlier ones left. The
    order is fixed, so it would be the SAME tail nodes every sweep that came
    back "not read before the deadline" — reported honestly, and wrong: a
    node that answers perfectly well reads as permanently unreachable, and
    its last good memory figures are dropped with it.

    Scaling by waves keeps the per-node budget constant whatever the fleet
    size. The cap is what stops a fleet large enough to matter from turning
    one sweep into a minutes-long hold on the build lock.
    """
    waves = max(1, math.ceil(max(1, jobs) / _NODE_CONCURRENCY))
    return min(_deadline_s() * waves, _SWEEP_DEADLINE_CAP_S)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _err(exc: BaseException) -> str:
    return (str(exc) or exc.__class__.__name__)[:200]


def _session_factory():
    """The read-only pool. A view never borrows a write session."""
    from backend.app.db.engine import PoolRole, get_session_factory

    return get_session_factory(PoolRole.READONLY)


# ── Instances: provider rows grouped by the store they point at ──────────


@dataclass
class _Pending:
    key: Tuple
    cfg: FalkorDBConnConfig
    providers: List[ProviderRef] = field(default_factory=list)


def _identity(cfg: FalkorDBConnConfig) -> Tuple:
    """What makes two provider rows the SAME store.

    Two rows listing different seeds of one cluster still name one store;
    showing them as two would double every figure on the page. Seeds are
    sorted so the order a row lists them in cannot split an instance.
    """
    if cfg.mode == "cluster":
        return ("cluster", tuple(sorted(f"{h}:{p}" for h, p in cfg.cluster_nodes)))
    if cfg.mode == "sentinel":
        return ("sentinel", cfg.sentinel_master,
                tuple(sorted(f"{h}:{p}" for h, p in cfg.sentinel_nodes)))
    return ("standalone", cfg.host, int(cfg.port))


def _instance_id(key: Tuple) -> str:
    import hashlib

    return hashlib.sha1("|".join(str(k) for k in key).encode()).hexdigest()[:12]


def _pending_instances(rows: Sequence[Any]) -> List[_Pending]:
    """Every active FalkorDB provider row → the instances to sweep.

    Provider rows are the whole list. A data source's ``provider_id`` is NOT
    NULL, so every graph this page accounts for belongs to a provider's
    store; there is no default one to fall back to, and the store named by
    ``FALKORDB_HOST`` is the connection this application was bootstrapped
    with rather than somewhere anybody's lineage lives. Sweeping it anyway
    invented a "default graph store" the operator has no way to act on,
    added a phantom node's memory to the fleet totals, and reported an
    outage on an address nothing reads when it was left over from another
    environment.

    With no provider rows there is nothing to show, and the page says so
    with the one thing that would help: add a provider.
    """
    from backend.app.db.repositories import provider_repo
    from backend.app.providers.falkor_graph_registry import conn_config_from_row

    pending: Dict[Tuple, _Pending] = {}
    for row in rows:
        if row.provider_type != "falkordb" or not row.is_active or not row.host:
            continue
        try:
            cfg = conn_config_from_row(row, provider_repo.credentials_of(row))
        except Exception as exc:                      # noqa: BLE001 — one bad row
            logger.info("graph store: provider %s has unusable connection settings: %s",
                        row.id, _err(exc))
            continue
        key = _identity(cfg)
        slot = pending.get(key)
        if slot is None:
            slot = pending[key] = _Pending(key=key, cfg=cfg)
        slot.providers.append(ProviderRef(
            id=row.id, name=row.name, is_active=bool(row.is_active),
        ))
    return list(pending.values())


def _server_identity(instance: GraphStoreInstance) -> Set[str]:
    """What the SERVERS behind an instance call themselves.

    A cluster node id where there is one, and otherwise the Redis run id,
    which is regenerated per server process and so is unique across a
    deployment. Connection settings cannot answer this — one node reached
    as a service name by one provider row and as an address by another is
    two identities and one server — so the nodes are asked.
    """
    out: Set[str] = set()
    for shard in instance.shards:
        node_id = shard.master.node_id
        run_id = shard.master.server.run_id
        if node_id:
            out.add(f"node:{node_id}")
        elif run_id:
            out.add(f"run:{run_id}")
    return out


def _merge_by_node_ids(
    instances: List[Tuple[int, GraphStoreInstance]],
) -> List[Tuple[List[int], GraphStoreInstance]]:
    """Fold instances that turned out to be the same store.

    Two provider rows can list disjoint seeds of one cluster, or name one
    standalone node by its service name and by its address — different
    connection settings, same store. Discovery settles it: overlapping
    server identities mean one store, and the rows merge onto one card.
    Without the fold every figure on that store is counted once per row.
    """
    out: List[Tuple[List[int], GraphStoreInstance]] = []
    for idx, instance in instances:
        ids = _server_identity(instance)
        target = None
        for existing_idxs, existing in out:
            if not ids or existing.mode != instance.mode:
                continue
            if _server_identity(existing) & ids:
                target, target_idxs = existing, existing_idxs
                break
        if target is None:
            out.append(([idx], instance))
            continue
        # Both rows' reads stay in play: each asked the same nodes to measure
        # ITS OWN graphs, so dropping one leaves the other row's sources
        # sized by estimate on a store that measured them.
        target_idxs.append(idx)
        known = {p.id for p in target.providers}
        target.providers.extend(p for p in instance.providers if p.id not in known)
        target.seeds = sorted(set(target.seeds) | set(instance.seeds))
    return out


# ── The data-source join ─────────────────────────────────────────────────


async def _expected_graphs(
    session: Any, provider_ids: Sequence[str],
) -> Dict[Tuple[str, str], List[Tuple[str, DataSourceRef]]]:
    """``(provider_id, graph_key)`` → the data sources that own that key.

    A source contributes its own graph and, in dedicated projection mode,
    the projection graph as well — which hashes independently and can land
    on a different shard than the source graph. That surprise is exactly
    what the placement views exist to show, so both keys are registered.
    """
    from sqlalchemy import select

    from backend.app.db.models import WorkspaceDataSourceORM, WorkspaceORM
    from ..aggregation.capacity import graph_key_of

    out: Dict[Tuple[str, str], List[Tuple[str, DataSourceRef]]] = {}
    if not provider_ids:
        return out
    rows = (await session.execute(
        select(WorkspaceDataSourceORM, WorkspaceORM.name)
        .join(WorkspaceORM, WorkspaceORM.id == WorkspaceDataSourceORM.workspace_id,
              isouter=True)
        .where(
            WorkspaceDataSourceORM.deleted_at.is_(None),
            WorkspaceDataSourceORM.provider_id.in_(list(provider_ids)),
        )
    )).all()
    for ds, workspace_name in rows:
        ref = DataSourceRef(
            id=ds.id,
            label=getattr(ds, "label", None),
            workspace_id=getattr(ds, "workspace_id", None),
            workspace_name=workspace_name,
            catalog_item_id=getattr(ds, "catalog_item_id", None),
            provider_id=getattr(ds, "provider_id", None),
            aggregation_status=getattr(ds, "aggregation_status", None),
            edge_count=int(getattr(ds, "aggregation_edge_count", 0) or 0),
        )
        pid = str(getattr(ds, "provider_id", "") or "")
        source_key = str(getattr(ds, "graph_name", "") or "")
        if source_key:
            out.setdefault((pid, source_key), []).append(("source", ref))
        if (getattr(ds, "projection_mode", None) or "") == "dedicated":
            projection_key = graph_key_of(ds, None)
            if projection_key and projection_key != source_key:
                out.setdefault((pid, projection_key), []).append(("projection", ref))
    return out


# ── Adapters ─────────────────────────────────────────────────────────────


def reading_of(node: GraphStoreNode) -> ShardMemory:
    """A node's memory as the write budget reads it.

    One arithmetic for the page and the rebuild: the same
    ``compute_write_budget`` runs on this reading, so "fits ~N more rollup
    edges" on screen is the number the next run will apply.
    """
    measurable = node.status == "up" and node.memory.used is not None
    return ShardMemory(
        node.endpoint,
        node.memory.used if measurable else None,
        node.memory.maxmemory if measurable else None,
        node.memory.policy,
        time.monotonic(),
        "measured" if measurable else "unavailable",
        None if measurable else (node.error or "the node could not be read"),
        node.limits.query_mem_capacity,
        node.limits.timeout_max_ms,
        node.limits.timeout_default_ms,
        node.limits.thread_count,
        node.limits.effects_threshold_us,
    )


def key_slot(graph_key: str) -> int:
    """The cluster slot a graph key hashes to — pure, client-side.

    Placement needs no round trip: the slot is a CRC of the key, and the
    snapshot already knows which master owns which slots.
    """
    from redis.crc import key_slot as _key_slot

    return int(_key_slot(graph_key.encode()))


def place(
    instance: Optional[GraphStoreInstance], graph_key: str,
) -> Tuple[Optional[GraphStoreShard], int]:
    """The shard holding ``graph_key`` in this instance, and its slot."""
    slot = key_slot(graph_key)
    if instance is None or not instance.shards:
        return None, slot
    if instance.mode != "cluster":
        return instance.shards[0], slot
    for shard in instance.shards:
        for lo, hi in shard.slot_ranges:
            if lo <= slot <= hi:
                return shard, slot
    return None, slot


def _node_from_read(raw: RawNode, read: Dict[str, Any],
                    previous: Dict[str, Dict[str, Any]]) -> GraphStoreNode:
    memory = dict(read.get("memory") or {})
    server = dict(read.get("server") or {})
    replication = dict(read.get("replication") or {})
    limits = dict(read.get("limits") or {})
    prev = previous.get(read.get("nodeId") or read["endpoint"]) or {}
    run_id = server.get("runId")
    restarted = None
    if run_id and prev.get("runId"):
        restarted = run_id != prev["runId"]
    node = GraphStoreNode(
        endpoint=read["endpoint"],
        announced=read.get("announced"),
        node_id=read.get("nodeId"),
        role=read.get("role") or raw.role,
        status=read.get("status") or "up",
        error=read.get("error"),
        latency_ms=read.get("latencyMs"),
        gossip=read.get("gossip"),
        memory=NodeMemory(
            used=memory.get("used"), rss=memory.get("rss"), peak=memory.get("peak"),
            maxmemory=memory.get("maxmemory"), policy=memory.get("policy"),
            used_pct=memory.get("usedPct"),
            fragmentation_ratio=memory.get("fragmentationRatio"),
            mem_clients_replicas=memory.get("memClientsReplicas"),
            mem_repl_backlog=memory.get("memReplBacklog"),
            level=_memory_level(memory, read["endpoint"]),
        ),
        replication=NodeReplication(
            role=replication.get("role"),
            master_endpoint=replication.get("masterEndpoint"),
            master_link_status=replication.get("masterLinkStatus"),
            master_sync_in_progress=replication.get("masterSyncInProgress"),
            master_last_io_s=replication.get("masterLastIoS"),
            repl_offset=replication.get("replOffset"),
            lag_bytes=replication.get("lagBytes"),
            connected_replicas=replication.get("connectedReplicas"),
            replicas=[NodeReplicaLink(**{
                "endpoint": r["endpoint"], "state": r.get("state"),
                "offset": r.get("offset"), "lagBytes": r.get("lagBytes"),
                "lagS": r.get("lagS"),
            }) for r in replication.get("replicas", [])],
        ),
        server=NodeServer(
            redis_version=server.get("redisVersion"), uptime_s=server.get("uptimeS"),
            run_id=run_id, connected_clients=server.get("connectedClients"),
            ops_per_sec=server.get("opsPerSec"), loading=server.get("loading"),
            bgsave_in_progress=server.get("bgsaveInProgress"),
            aof_rewrite_in_progress=server.get("aofRewriteInProgress"),
            latest_fork_usec=server.get("latestForkUsec"),
            sync_full=server.get("syncFull"),
            sync_partial_err=server.get("syncPartialErr"),
            restarted_since_last=restarted,
        ),
        limits=NodeLimits(
            query_mem_capacity=limits.get("query_mem_capacity"),
            timeout_max_ms=limits.get("timeout_max_ms"),
            timeout_default_ms=limits.get("timeout_default_ms"),
            thread_count=limits.get("thread_count"),
            effects_threshold_us=limits.get("effects_threshold_us"),
            repl_backlog_bytes=limits.get("replBacklogBytes"),
            replica_buffer_hard_bytes=limits.get("replicaBufferHardBytes"),
            cluster_node_timeout_ms=limits.get("clusterNodeTimeoutMs"),
        ),
        graph_count=len(read["graphs"]) if read.get("graphs") is not None else None,
        graph_memory=read.get("graphMemory"),
    )
    return node


def _memory_level(memory: Dict[str, Any], endpoint: str) -> Optional[str]:
    """The shared used-memory verdict, so this page and the infrastructure
    tile agree about which node is filling."""
    from backend.app.services.system_status.probes import _memory_pressure

    verdict = _memory_pressure(
        {"memoryUsedPct": memory.get("usedPct"),
         "maxmemoryPolicy": memory.get("policy")},
        endpoint,
    )
    return (verdict or {}).get("level")


# ── Findings ─────────────────────────────────────────────────────────────


def _shard_findings(
    master: GraphStoreNode, replicas: Sequence[GraphStoreNode],
    previous: Dict[str, Dict[str, Any]],
) -> ReplicationHealth:
    """What is wrong with this shard's replication, in plain sentences.

    These are the conditions that turn a large rebuild into a restarted
    node: replicas re-running every write, buffers too small to hold the
    backlog, a link that is down, a resync loop, a node that already
    restarted.
    """
    findings: List[ReplicationFinding] = []
    lags = [r.replication.lag_bytes for r in replicas
            if r.replication.lag_bytes is not None]
    online = sum(1 for r in replicas
                 if r.status == "up" and r.replication.master_link_status in (None, "up"))
    threshold = master.limits.effects_threshold_us

    if replicas and threshold is not None and threshold > 0:
        findings.append(ReplicationFinding(
            code="effects_threshold_high", severity="warn",
            text=(f"Replicas re-run every rollup write on their main thread "
                  f"(effects threshold {threshold} µs)."),
            fix=("Set the effects threshold to 0 on this node so replicas apply a "
                 "change log instead — a replica re-running a batch answers no "
                 "health check while it works."),
            endpoint=master.endpoint,
        ))
    for replica in replicas:
        if replica.status != "up":
            continue
        link = replica.replication.master_link_status
        if link is not None and link != "up":
            findings.append(ReplicationFinding(
                code="replica_link_down", severity="critical",
                text=f"Replica {replica.endpoint} has lost its link to the master ({link}).",
                fix="Check the replica's logs; a full resync starts on its own once it reconnects.",
                endpoint=replica.endpoint,
            ))
        if replica.replication.master_sync_in_progress:
            findings.append(ReplicationFinding(
                code="replica_full_sync", severity="warn",
                text=f"Replica {replica.endpoint} is taking a full copy of the shard.",
                fix="Expect higher memory and disk on both nodes until it finishes.",
                endpoint=replica.endpoint,
            ))
        lag = replica.replication.lag_bytes
        if lag is not None and lag > _LAG_WARN_BYTES:
            findings.append(ReplicationFinding(
                code="replica_behind", severity="warn",
                text=f"Replica {replica.endpoint} is {_human_bytes(lag)} behind the master.",
                fix=("A rebuild waits for replicas to acknowledge; a lag this size means "
                     "writes are arriving faster than this replica applies them."),
                endpoint=replica.endpoint,
            ))
    for node in (master, *replicas):
        prev = previous.get(_read_key(node)) or {}
        before, now = prev.get("syncFull"), node.server.sync_full
        if before is not None and now is not None and now > before:
            findings.append(ReplicationFinding(
                code="full_resync_storm", severity="critical",
                text=(f"{node.endpoint} has taken {now - before} more full "
                      f"resync(s) since the last reading."),
                fix=("Raise the replica output buffer and the replication backlog: a "
                     "resync loop under a rebuild forks the master repeatedly."),
                endpoint=node.endpoint,
            ))
        if node.server.restarted_since_last:
            findings.append(ReplicationFinding(
                code="node_restarted", severity="critical",
                text=f"{node.endpoint} restarted since the last reading.",
                fix=("Check whether the container was killed for memory or by its health "
                     "probe: kubectl get pod <pod> -o "
                     "jsonpath='{.status.containerStatuses[0].lastState.terminated.reason}'"),
                endpoint=node.endpoint,
            ))
    buffer_limit = master.limits.replica_buffer_hard_bytes
    if replicas and buffer_limit is not None and 0 < buffer_limit < _REPLICA_BUFFER_MIN_BYTES:
        findings.append(ReplicationFinding(
            code="output_buffer_small", severity="warn",
            text=(f"The replica output buffer on {master.endpoint} is "
                  f"{_human_bytes(buffer_limit)}."),
            fix=("A rebuild can fill it in seconds; the master then drops the replica "
                 "into a full resync. Raise client-output-buffer-limit for replicas."),
            endpoint=master.endpoint,
        ))
    return ReplicationHealth(
        replicas_total=len(replicas),
        replicas_online=online,
        max_lag_bytes=max(lags) if lags else None,
        full_resyncs=master.server.sync_full,
        partial_resync_errors=master.server.sync_partial_err,
        effects_threshold_us=threshold,
        findings=findings,
    )


def _human_bytes(n: Optional[int]) -> str:
    if n is None:
        return "?"
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


# ── Building one snapshot ────────────────────────────────────────────────


_cache: Optional[Tuple[float, GraphStoreTopologyResponse]] = None
_last_error: Optional[str] = None
#: Monotonic time before which a failed sweep is not worth re-attempting.
_retry_not_before: float = 0.0
_prev_nodes: Dict[str, Dict[str, Any]] = {}
_lock: Optional[asyncio.Lock] = None
_lock_loop: Optional[asyncio.AbstractEventLoop] = None
#: instance id → the connection settings that reached it, from the last build.
_configs: Dict[str, FalkorDBConnConfig] = {}


def _build_lock() -> asyncio.Lock:
    """The build lock, bound to the loop that is actually running.

    A module-level ``asyncio.Lock`` binds itself to the first event loop
    that CONTENDS it, and raises ``RuntimeError`` for every loop after
    that. A server is one loop per process, so it never shows there —
    anywhere a second loop runs (a management command, a test that sweeps
    concurrently) it is a hard failure with nothing to do with what the
    caller asked for.
    """
    global _lock, _lock_loop
    loop = asyncio.get_running_loop()
    if _lock is None or _lock_loop is not loop:
        _lock = asyncio.Lock()
        _lock_loop = loop
    return _lock


def _read_key(node: Any) -> str:
    """What a node IS, for keying its reading and its history.

    Its node id where the cluster gives one, and its address only as a
    fallback. Two nodes at one address — an addressRemap onto a shared
    gateway, a hostname announced per service rather than per pod, or two
    nodes the cluster has no address for at all — otherwise share a reading
    and a history: one row shown twice with the same figures, and a restart
    finding that fires because the entry alternates between them.
    """
    return getattr(node, "node_id", None) or node.endpoint


async def _read_all_nodes(
    pending: Sequence[Tuple[_Pending, RawTopology]],
    measure_by_instance: Dict[int, List[str]],
) -> Dict[Tuple[int, str], Dict[str, Any]]:
    """Read every node of every instance, concurrently and bounded.

    A node that does not answer in time is still reported — with "not read
    before the deadline" — because a page that silently drops slow nodes is
    how a partial fleet passes for a whole one.
    """
    semaphore = asyncio.Semaphore(_NODE_CONCURRENCY)
    results: Dict[Tuple[int, str], Dict[str, Any]] = {}
    jobs: List[Tuple[int, RawNode, FalkorDBConnConfig, bool, List[str]]] = []
    for idx, (slot, raw) in enumerate(pending):
        for master, replicas in raw.shards:
            jobs.append((idx, master, slot.cfg, True, measure_by_instance.get(idx, [])))
            for replica in replicas:
                jobs.append((idx, replica, slot.cfg, False, []))
        # A node in no shard is still a node of the cluster, and the count on
        # the page has to match `kubectl get pods`.
        for stray in raw.unplaced:
            jobs.append((idx, stray, slot.cfg, False, []))

    async def _one(idx: int, node: RawNode, cfg: FalkorDBConnConfig,
                   want_graphs: bool, measure: List[str]) -> None:
        async with semaphore:
            results[(idx, _read_key(node))] = await discovery.read_node(
                cfg, node, budget=connect_verify_budget(cfg, 1.5),
                want_graphs=want_graphs, measure_keys=measure,
            )

    deadline = _sweep_deadline_s(len(jobs))
    try:
        async with asyncio.timeout(deadline):
            await asyncio.gather(*(_one(*job) for job in jobs))
    except (TimeoutError, asyncio.TimeoutError):
        logger.info("graph store: topology sweep hit its %.1fs deadline after %d of %d nodes",
                    deadline, len(results), len(jobs))
    for idx, node, _cfg, _want, _measure in jobs:
        results.setdefault((idx, _read_key(node)), {
            "endpoint": node.endpoint, "announced": node.announced,
            "nodeId": node.node_id, "role": node.role, "gossip": node.gossip,
            "status": "unreachable", "error": "not read before the deadline",
            "memory": {}, "replication": {}, "server": {}, "limits": {},
            "graphs": None, "graphMemory": None, "measured": {},
        })
    return results


async def build_snapshot() -> GraphStoreTopologyResponse:
    """Read every instance once and assemble the whole picture."""
    from sqlalchemy import select

    from backend.app.db.models import ProviderORM
    from ..aggregation.capacity import _stored_tuning, effective_limits, shard_row

    global _prev_nodes

    factory = _session_factory()
    async with factory() as session:
        rows = (await session.execute(
            select(ProviderORM).order_by(ProviderORM.created_at)
        )).scalars().all()
        pending = _pending_instances(rows)
        provider_ids = [p.id for slot in pending for p in slot.providers]
        expected = await _expected_graphs(session, provider_ids)
        limits = effective_limits(await _stored_tuning(session))

    discovered = await asyncio.gather(*(
        discovery.discover(slot.cfg, extra_seeds=_seeds_last_seen(slot))
        for slot in pending
    ), return_exceptions=True)

    paired: List[Tuple[_Pending, RawTopology]] = []
    for slot, raw in zip(pending, discovered):
        if isinstance(raw, BaseException):
            raw = RawTopology(reachable=False, error=_err(raw))
        paired.append((slot, raw))

    # The graphs worth measuring on each instance: the registered ones,
    # largest first, so a capped measurement spends its budget where the
    # numbers matter.
    measure_by_instance: Dict[int, List[str]] = {}
    for idx, (slot, _raw) in enumerate(paired):
        keys: List[Tuple[int, str]] = []
        for (pid, key), owners in expected.items():
            if any(p.id == pid for p in slot.providers):
                keys.append((max((ref.edge_count for _role, ref in owners), default=0), key))
        measure_by_instance[idx] = [
            k for _edges, k in sorted(keys, key=lambda t: (-t[0], t[1]))
        ][: discovery.MAX_GRAPH_MEASURES_PER_NODE]

    global _configs, _prev_nodes

    reads = await _read_all_nodes(paired, measure_by_instance)
    previous = dict(_prev_nodes)

    bytes_per_edge = int(limits.bytes_per_edge.value or 512)
    assembled: List[Tuple[int, GraphStoreInstance]] = [
        (idx, _assemble_nodes(idx, slot, raw, reads, previous))
        for idx, (slot, raw) in enumerate(paired)
    ]
    # Fold first: which graphs an instance is expected to hold depends on
    # every provider row that points at it, and two rows on one store only
    # become one row list here.
    merged = _merge_by_node_ids(assembled)
    for idxs, instance in merged:
        _attach_graphs(
            instance, idxs, reads, _expected_here(expected, instance), bytes_per_edge,
        )
        for shard in instance.shards:
            shard.capacity = shard_row(reading_of(shard.master), limits)
        instance.totals = _totals(instance)
    instances = [instance for _idxs, instance in merged]
    instances.sort(key=lambda i: (
        (i.providers[0].name or "").lower() if i.providers else "~env", i.id,
    ))

    # How to reach each instance again, kept beside the snapshot so a write
    # (a limits change on one node) can open its own short-lived client with
    # the instance's own auth and TLS, instead of borrowing whichever
    # provider happened to be instantiated.
    by_id = {_instance_id(slot.key): slot.cfg for slot, _raw in paired}
    _configs = {i.id: cfg for i in instances if (cfg := by_id.get(i.id)) is not None}

    # Replaced only once a build has got this far. Emptying it up front and
    # refilling it here would mean any error in between left it empty — and
    # a build with no previous run ids cannot tell a restarted node from a
    # slow one, so the two critical findings go quiet for cycles, during
    # exactly the instability that makes builds fail.
    _prev_nodes = {
        _read_key(node): {"runId": node.server.run_id, "syncFull": node.server.sync_full}
        for instance in instances
        for shard in instance.shards
        for node in (shard.master, *shard.replicas)
    }

    return GraphStoreTopologyResponse(
        instances=instances,
        summary=_summarize(instances),
        limits=limits,
        measured_at=_now_iso(),
        ttl_s=_ttl_s(),
    )


def _assemble_nodes(
    idx: int, slot: _Pending, raw: RawTopology,
    reads: Dict[Tuple[int, str], Dict[str, Any]],
    previous: Dict[str, Dict[str, Any]],
) -> GraphStoreInstance:
    """The store's NODES. What lives on them is attached after the fold —
    two provider rows on one store only become one row list there, and the
    graphs an instance is expected to hold follow from that list."""
    shards: List[GraphStoreShard] = []
    for index, (raw_master, raw_replicas) in enumerate(raw.shards):
        master = _node_from_read(raw_master, reads[(idx, _read_key(raw_master))], previous)
        replicas = [
            _node_from_read(r, reads[(idx, _read_key(r))], previous) for r in raw_replicas
        ]
        shards.append(GraphStoreShard(
            index=index,
            slot_ranges=[list(r) for r in raw_master.slots],
            slot_count=sum(hi - lo + 1 for lo, hi in raw_master.slots),
            master=master,
            replicas=replicas,
            replication=_shard_findings(master, replicas, previous),
        ))

    instance = GraphStoreInstance(
        id=_instance_id(slot.key),
        providers=slot.providers,
        mode=slot.cfg.mode,
        seeds=_seeds_of(slot.cfg),
        seed_used=raw.seed_used,
        discovered_via=raw.discovered_via,
        reachable=raw.reachable and bool(raw.shards),
        error=raw.error,
        slots_covered=raw.slots_covered,
        slots_missing=raw.slots_missing,
        shards=shards,
        unplaced_nodes=[
            _node_from_read(n, reads[(idx, _read_key(n))], previous) for n in raw.unplaced
        ],
        known_nodes=info_parse.as_int(raw.cluster_info.get("cluster_known_nodes")),
        cluster_state=raw.cluster_info.get("cluster_state"),
        findings=_instance_findings(raw),
    )
    return instance


def _seeds_last_seen(slot: "_Pending") -> List[Tuple[str, int]]:
    """Nodes of this store the last good reading found, masters first.

    A provider's configured seeds are the masters as they were the day it
    was set up, and masters change: pods are replaced, roles move. When all
    of them are gone the store reads as unreachable while the cluster is
    perfectly healthy. The cluster's own last-known addresses are better
    seeds than a list written months ago — and on a cold start there is
    nothing but the configuration, which still works.
    """
    snapshot = _cache[1] if _cache is not None else None
    if snapshot is None:
        return []
    wanted = {p.id for p in slot.providers}
    out: List[Tuple[str, int]] = []
    for instance in snapshot.instances:
        if wanted and not wanted & {p.id for p in instance.providers}:
            continue
        ordered = [s.master for s in instance.shards]
        ordered += [r for s in instance.shards for r in s.replicas]
        for node in ordered:
            host, _, port = node.endpoint.rpartition(":")
            if host and port.isdigit() and node.status == "up":
                out.append((host, int(port)))
    return out


def _instance_findings(raw: RawTopology) -> List[ReplicationFinding]:
    """Problems with the store as a whole rather than with one shard."""
    out: List[ReplicationFinding] = []
    for endpoint, ids in sorted(raw.collisions.items()):
        out.append(ReplicationFinding(
            code="endpoint_collision",
            severity="critical",
            text=(f"{len(ids)} nodes are reached at {endpoint} "
                  f"({', '.join(sorted(i[:8] for i in ids))}). Every figure keyed by "
                  f"address counts them as one node measured twice."),
            fix=("Give each node its own address: an addressRemap entry per node, or "
                 "cluster-announce-hostname set per pod rather than to a headless "
                 "service name."),
            endpoint=endpoint,
        ))
    known = info_parse.as_int(raw.cluster_info.get("cluster_known_nodes"))
    seen = sum(1 + len(reps) for _m, reps in raw.shards) + len(raw.unplaced)
    if known is not None and known > seen:
        out.append(ReplicationFinding(
            code="nodes_missing_from_view",
            severity="warn",
            text=(f"The cluster says it knows {known} nodes; this reading found "
                  f"{seen}. The seed that answered has an incomplete view."),
            fix="Check the cluster bus between the nodes, and CLUSTER NODES on another node.",
        ))
    state = raw.cluster_info.get("cluster_state")
    if state and str(state).lower() != "ok":
        out.append(ReplicationFinding(
            code="cluster_state_not_ok",
            severity="critical",
            text=f"The cluster reports its own state as {state}.",
            fix="Slots are unserved until it recovers; check for a master with no replica promoted.",
        ))
    return out


def _expected_here(
    expected: Dict[Tuple[str, str], List[Tuple[str, DataSourceRef]]],
    instance: GraphStoreInstance,
) -> Dict[str, List[Tuple[str, DataSourceRef]]]:
    """Every graph key THIS store's rows expect, so a registered graph that
    is not on its node still shows up (with ``present`` false) instead of
    vanishing — and so a graph belonging to the second row on a shared
    store is not reported as an orphan nobody claims.

    """
    ids = {p.id for p in instance.providers}
    return {key: owners for (pid, key), owners in expected.items() if pid in ids}


def _seeds_of(cfg: FalkorDBConnConfig) -> List[str]:
    if cfg.mode == "cluster":
        return [f"{h}:{p}" for h, p in cfg.cluster_nodes]
    if cfg.mode == "sentinel":
        return [f"{h}:{p}" for h, p in cfg.sentinel_nodes]
    return [f"{cfg.host}:{cfg.port}"]


def _attach_graphs(
    instance: GraphStoreInstance, idxs: Sequence[int],
    reads: Dict[Tuple[int, str], Dict[str, Any]],
    expected_here: Dict[str, List[Tuple[str, DataSourceRef]]],
    bytes_per_edge: int,
) -> None:
    """Every graph on the shard it is really on.

    A graph the node LISTED belongs to that node — that is the truth, and
    a graph sitting somewhere its key does not hash to (mid-migration, or
    restored onto the wrong shard) is exactly the kind of thing an operator
    needs to see rather than have tidied away. A graph the catalogue
    expects but no node holds is placed by its key slot: where it will land
    when it is next rebuilt.
    """
    by_shard: Dict[int, List[GraphOnShard]] = {}
    placed: set = set()

    def _add(key: str, present: bool, measured: Optional[Dict[str, Any]],
             on_shard: Optional[GraphStoreShard] = None) -> None:
        if key in placed:
            return
        placed.add(key)
        shard, slot = (on_shard, key_slot(key)) if on_shard is not None \
            else place(instance, key)
        owners = expected_here.get(key) or []
        role = "unregistered" if not owners else owners[0][0]
        refs = [ref for _role, ref in owners]
        edges = max((ref.edge_count for ref in refs), default=0)
        row = GraphOnShard(
            key=key, slot=slot, present=present, role=role, data_sources=refs,
            edge_count=edges,
            estimated_bytes=edges * bytes_per_edge if edges else None,
            measured_bytes=(measured or {}).get("bytes"),
            measured_detail=(measured or {}).get("detail"),
        )
        if shard is not None:
            by_shard.setdefault(shard.index, []).append(row)

    for shard in instance.shards:
        listed: List[str] = []
        measured: Dict[str, Any] = {}
        for idx in idxs:
            read = reads.get((idx, _read_key(shard.master))) or {}
            for key in read.get("graphs") or []:
                if key not in listed:
                    listed.append(key)
            measured.update(read.get("measured") or {})
        for key in listed:
            _add(key, True, measured.get(key), on_shard=shard)
    for key in expected_here:
        _add(key, False, None)

    for shard in instance.shards:
        rows = sorted(
            by_shard.get(shard.index, []),
            key=lambda g: (-(g.measured_bytes or g.estimated_bytes or 0), g.key),
        )
        shard.graphs_total = len(rows)
        shard.unregistered_count = sum(1 for g in rows if g.role == "unregistered")
        shard.graphs_truncated = len(rows) > MAX_GRAPH_ROWS_PER_SHARD
        shard.graphs = rows[:MAX_GRAPH_ROWS_PER_SHARD]
        # The cap bounds what the PAGE renders, never what the snapshot
        # knows: placement is looked up here.
        shard.rows_by_key = {g.key: g for g in rows}


def _totals(instance: GraphStoreInstance) -> InstanceTotals:
    # Every node the cluster knows, so the figure matches `kubectl get pods`
    # — and masters counted by ROLE, not by the column a node sits in, so a
    # promoted replica is not counted as a master of itself.
    nodes = [n for s in instance.shards for n in (s.master, *s.replicas)]
    nodes += list(instance.unplaced_nodes)
    masters = [s.master for s in instance.shards]
    used = [m.memory.used for m in masters if m.memory.used is not None]
    cap = [m.memory.maxmemory for m in masters if m.memory.maxmemory]
    return InstanceTotals(
        masters=len(masters),
        replicas=sum(len(s.replicas) for s in instance.shards),
        nodes_up=sum(1 for n in nodes if n.status == "up"),
        nodes_total=len(nodes),
        graphs=sum(s.graphs_total for s in instance.shards),
        unregistered_graphs=sum(s.unregistered_count for s in instance.shards),
        used_memory=sum(used) if used else None,
        maxmemory=sum(cap) if cap else None,
    )


def _summarize(instances: Sequence[GraphStoreInstance]) -> FleetSummary:
    nodes = [n for i in instances for s in i.shards for n in (s.master, *s.replicas)]
    used = [t for t in (i.totals.used_memory for i in instances) if t is not None]
    cap = [t for t in (i.totals.maxmemory for i in instances) if t is not None]
    return FleetSummary(
        instances=len(instances),
        providers=len({p.id for i in instances for p in i.providers}),
        masters=sum(i.totals.masters for i in instances),
        replicas=sum(i.totals.replicas for i in instances),
        nodes_up=sum(i.totals.nodes_up for i in instances),
        nodes_total=sum(i.totals.nodes_total for i in instances),
        graphs=sum(i.totals.graphs for i in instances),
        unregistered_graphs=sum(i.totals.unregistered_graphs for i in instances),
        used_memory=sum(used) if used else None,
        maxmemory=sum(cap) if cap else None,
        unreachable_nodes=sum(1 for n in nodes if n.status != "up"),
        findings=sum(len(s.replication.findings) for i in instances for s in i.shards),
    )


# ── The cache ────────────────────────────────────────────────────────────


def _with_age(snapshot: GraphStoreTopologyResponse, cached_at: float,
              *, stale: bool = False) -> GraphStoreTopologyResponse:
    return snapshot.model_copy(update={
        "cache_age_ms": int((time.monotonic() - cached_at) * 1000),
        "stale": stale,
        "last_error": _last_error if stale else None,
    })


async def get_topology_snapshot(*, fresh: bool = False) -> GraphStoreTopologyResponse:
    """The current picture, from cache unless it has aged out.

    A failed rebuild NEVER replaces a good reading: the page keeps showing
    the figures it has, marked stale with the reason, because a blank page
    tells the operator less than a slightly old one. ``fresh`` skips the
    TTL but obeys the same rule.

    A FAILURE is remembered too, for a few seconds. Without that the TTL
    stays expired through an outage and the lock stops preventing a
    stampede and starts queueing one: a hundred people on Freshness each
    wait out everybody ahead of them and then run their own full sweep. And
    a caller that waited for the lock takes whatever the holder built
    rather than building the same thing again — ``fresh`` included, which
    is what a room full of admins pressing Re-measure looks like.
    """
    global _cache, _last_error, _retry_not_before

    now = time.monotonic()
    if not fresh and _cache is not None and now - _cache[0] < _ttl_s():
        return _with_age(_cache[1], _cache[0])
    if _cache is not None and now < _retry_not_before:
        return _with_age(_cache[1], _cache[0], stale=True)
    entered = time.monotonic()
    async with _build_lock():
        if not fresh and _cache is not None and time.monotonic() - _cache[0] < _ttl_s():
            return _with_age(_cache[1], _cache[0])
        if _cache is not None and _cache[0] >= entered:
            # Someone swept while we waited; theirs is as fresh as ours.
            return _with_age(_cache[1], _cache[0])
        if _cache is not None and time.monotonic() < _retry_not_before:
            return _with_age(_cache[1], _cache[0], stale=True)
        try:
            snapshot = await build_snapshot()
        except Exception as exc:                      # noqa: BLE001 — serve what we have
            _last_error = _err(exc)
            _retry_not_before = time.monotonic() + _FAILURE_BACKOFF_S
            logger.warning("graph store: topology refresh failed: %s", _last_error)
            if _cache is not None:
                return _with_age(_cache[1], _cache[0], stale=True)
            raise
        _last_error = None
        _retry_not_before = 0.0
        _cache = (time.monotonic(), snapshot)
        return _with_age(snapshot, _cache[0])


#: The sweep running in the background, if any. Held so it is not garbage
#: collected mid-flight, and so a second request joins it rather than
#: starting a second one.
_refresh_task: Optional["asyncio.Task"] = None


async def _refresh_quietly(fresh: bool) -> None:
    try:
        await get_topology_snapshot(fresh=fresh)
    except Exception as exc:                          # noqa: BLE001 — already logged
        logger.debug("graph store: background refresh ended: %s", _err(exc))


def last_error() -> Optional[str]:
    """Why the last sweep failed, if it did — so a page with nothing on it
    can say what is wrong rather than only that it is empty."""
    return _last_error


def request_refresh(*, fresh: bool = False) -> "asyncio.Task":
    """Start a sweep unless one is already running; return it either way."""
    global _refresh_task
    task = _refresh_task
    if task is None or task.done():
        task = _refresh_task = asyncio.create_task(_refresh_quietly(fresh))
    return task


async def snapshot_for_request(
    *, fresh: bool = False, wait_s: float = 0.0,
) -> Tuple[Optional[GraphStoreTopologyResponse], bool]:
    """What an HTTP request may have — which is never a full sweep.

    A sweep reads every node of every store behind a lock. On a cluster
    mid-rotation that is tens of seconds, and no gateway holds a connection
    that long: the request dies with a 504 having done all the work. So a
    request takes what is cached, asks for a refresh in the background, and
    says whether one is running; the page polls and fills in.

    ``wait_s`` is for Re-measure, which asked for the sweep and can hold
    briefly for it — but not past the gateway.

    Returns ``(snapshot or None, refreshing)``.
    """
    now = time.monotonic()
    if not fresh and _cache is not None and now - _cache[0] < _ttl_s():
        return _with_age(_cache[1], _cache[0]), False

    task = request_refresh(fresh=fresh)
    if wait_s > 0 and not task.done():
        try:
            async with asyncio.timeout(wait_s):
                await asyncio.shield(task)
        except (TimeoutError, asyncio.TimeoutError):
            pass
        except Exception:                             # noqa: BLE001 — the cache answers
            pass

    refreshing = not task.done()
    if _cache is None:
        return None, refreshing
    stale = time.monotonic() - _cache[0] >= _ttl_s()
    return _with_age(_cache[1], _cache[0], stale=stale and _last_error is not None), refreshing


def invalidate_topology_cache() -> None:
    """Drop the snapshot so the next view sweeps again — called after a
    change that alters what the sweep would read (a limits change)."""
    global _cache, _retry_not_before
    _cache = None
    # An operator who just changed something is owed a read, not the tail of
    # a backoff a failure minutes ago started.
    _retry_not_before = 0.0


def cached_snapshot() -> Optional[GraphStoreTopologyResponse]:
    """The snapshot as it stands, without triggering a sweep."""
    return _with_age(_cache[1], _cache[0]) if _cache is not None else None


# ── Reading the snapshot ─────────────────────────────────────────────────


def instance_of_endpoint(
    snapshot: GraphStoreTopologyResponse, endpoint: str,
) -> Optional[GraphStoreInstance]:
    """The instance that has a node at ``endpoint`` — master or replica."""
    for instance in snapshot.instances:
        for shard in instance.shards:
            for node in (shard.master, *shard.replicas):
                if node.endpoint == endpoint:
                    return instance
    return None


def nodes_of(instance: GraphStoreInstance) -> List[GraphStoreNode]:
    """Every node of an instance, masters first — the order a change that
    applies to all of them should be made in."""
    masters = [shard.master for shard in instance.shards]
    replicas = [r for shard in instance.shards for r in shard.replicas]
    return [*masters, *replicas]


def conn_config_of(instance_id: str) -> Optional[FalkorDBConnConfig]:
    """The connection settings that reached ``instance_id`` in the last
    snapshot build: auth, TLS and the address remap, ready for a one-node
    client. ``None`` before the first build, or for an instance that is gone.
    """
    return _configs.get(instance_id)


def instance_for_provider(
    snapshot: GraphStoreTopologyResponse, provider_id: str,
) -> Optional[GraphStoreInstance]:
    wanted = str(provider_id or "")
    if not wanted:
        return None
    for instance in snapshot.instances:
        if any(p.id == wanted for p in instance.providers):
            return instance
    return None


def graph_row(instance: Optional[GraphStoreInstance],
              shard: Optional[GraphStoreShard], key: str) -> Optional[GraphOnShard]:
    """One graph's row on its shard, from EVERY graph the shard holds.

    Not from ``shard.graphs``, which is cut to the largest few thousand for
    the page: a graph below that cut would come back as no row at all,
    which the caller cannot tell apart from "registered, but the node does
    not hold it" — and would then say so on the owner's own data source.
    """
    if shard is None:
        return None
    row = shard.rows_by_key.get(key)
    if row is not None:
        return row
    # A shard assembled without the lookup map (a fixture, a snapshot
    # rebuilt from JSON) still answers from what it does carry.
    for listed in shard.graphs:
        if listed.key == key:
            return listed
    return None


def placement_for_graph(
    snapshot: GraphStoreTopologyResponse, provider_id: str, graph_key: str,
    *, role: str = "source",
) -> Optional[GraphPlacement]:
    """Where one graph lives, with what shares its shard."""
    instance = instance_for_provider(snapshot, provider_id)
    shard, slot = place(instance, graph_key)
    row = graph_row(instance, shard, graph_key)
    siblings = [g for g in (shard.graphs if shard else []) if g.key != graph_key]
    # Counted from the shard's total, not from the rows the page shows: on a
    # shard past the display cap "sharing with 1,999 others" would be a
    # ceiling rather than a fact.
    siblings_total = max(0, (shard.graphs_total - 1) if row else (shard.graphs_total if shard else 0))
    return GraphPlacement(
        graph_key=graph_key,
        role="projection" if role == "projection" else "source",
        slot=slot,
        shard_index=shard.index if shard else None,
        present=bool(row.present) if row else False,
        master=shard.master if shard else None,
        replicas=shard.replicas if shard else [],
        siblings=siblings_total,
        siblings_sample=[
            {"key": g.key,
             "label": (g.data_sources[0].label if g.data_sources else None),
             "bytes": g.measured_bytes or g.estimated_bytes}
            for g in siblings[:8]
        ],
        edge_count=row.edge_count if row else 0,
        estimated_bytes=row.estimated_bytes if row else None,
        measured_bytes=row.measured_bytes if row else None,
    )


def placement_keys_for(ds: Any) -> List[Tuple[str, str]]:
    """``(role, graph_key)`` for one data source: its graph, and its
    dedicated projection graph when it has one."""
    from ..aggregation.capacity import graph_key_of

    out: List[Tuple[str, str]] = []
    source_key = str(getattr(ds, "graph_name", "") or "")
    if source_key:
        out.append(("source", source_key))
    if (getattr(ds, "projection_mode", None) or "") == "dedicated":
        projection = graph_key_of(ds, None)
        if projection and projection != source_key:
            out.append(("projection", projection))
    return out
