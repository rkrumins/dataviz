"""Talking to graph store nodes: discovery, and one bounded read per node.

Everything here is best-effort by contract. A node that refuses, times out
or answers nonsense comes back as a node with ``status="unreachable"`` and
a reason — never as an exception, and never as an absence. The whole point
of this module is that the operator can count the nodes on the page and
get the same number as ``kubectl get pods``.

Discovery uses the provider's OWN connection settings (seeds, auth, TLS,
addressRemap) through short-lived clients. It never borrows the pinned
data-plane client a provider writes with: a view must not be able to
disturb a rebuild, and a provider that is not instantiated in this process
must still be visible.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

from backend.app.providers.falkordb_connection import (
    FalkorDBConnConfig,
    _conn_auth_kwargs,
    connect_verify_budget,
    remap_address,
    resolve_sentinel_master,
    with_auth_negotiation,
)
from . import info_parse

logger = logging.getLogger(__name__)

#: Per-graph memory is measured with ``GRAPH.MEMORY USAGE``, which samples
#: the graph on a worker thread. Bounded per node per snapshot: the page is
#: a view, and a fleet with thousands of graphs must not turn one refresh
#: into thousands of round trips.
MAX_GRAPH_MEASURES_PER_NODE = 50
GRAPH_MEMORY_SAMPLES = 100


def _err(exc: BaseException) -> str:
    return (str(exc) or exc.__class__.__name__)[:200]


@dataclass
class RawNode:
    """One node as the topology announced it, before it is read."""
    host: str
    port: int
    endpoint: str                     # after addressRemap — what we dial
    announced: str                    # what the cluster said
    role: str = "master"              # "master" | "replica"
    node_id: Optional[str] = None
    master_id: Optional[str] = None
    gossip: Optional[str] = None      # "fail" | "pfail" | "noaddr"
    slots: List[List[int]] = field(default_factory=list)
    dialable: bool = True
    reason: Optional[str] = None      # why not dialable


@dataclass
class RawTopology:
    """The nodes of one instance, grouped into shards, before the reads."""
    shards: List[Tuple[RawNode, List[RawNode]]] = field(default_factory=list)
    discovered_via: Optional[str] = None
    seed_used: Optional[str] = None
    reachable: bool = True
    error: Optional[str] = None
    slots_covered: Optional[int] = None
    slots_missing: Optional[str] = None


def node_client(cfg: FalkorDBConnConfig, host: str, port: int, *, socket_timeout: float):
    """A short-lived plain client pinned to ONE node.

    Plain, never a cluster client: every command this module sends is
    keyless (``INFO``, ``GRAPH.LIST``, ``GRAPH.CONFIG``, ``CLUSTER NODES``)
    and a cluster client routes those to an arbitrary node — which is
    exactly how a per-node reading turns into "some node's" reading.
    """
    from redis.asyncio import Redis

    return Redis(host=host, port=int(port), **_conn_auth_kwargs(cfg, socket_timeout))


async def _aclose(client: Any) -> None:
    try:
        await client.aclose()
    except Exception:                                 # pragma: no cover - best effort
        try:
            await client.close()
        except Exception:
            pass


# ── Cluster discovery ────────────────────────────────────────────────────


def _gossip_of(flags: str) -> Optional[str]:
    lowered = flags.lower()
    if "fail?" in lowered:
        return "pfail"
    if "fail" in lowered:
        return "fail"
    if "noaddr" in lowered:
        return "noaddr"
    return None


def _slot_ranges(raw: Any) -> List[List[int]]:
    """``[['0','5460'], ['7000']]`` → ``[[0, 5460], [7000, 7000]]``."""
    out: List[List[int]] = []
    for entry in raw or []:
        try:
            if isinstance(entry, (list, tuple)) and entry:
                lo = int(entry[0])
                hi = int(entry[1]) if len(entry) > 1 else lo
            else:
                lo = hi = int(entry)
        except (TypeError, ValueError):
            continue
        out.append([lo, hi])
    return sorted(out)


def parse_cluster_nodes_reply(
    parsed: Dict[str, Dict[str, Any]], cfg: FalkorDBConnConfig, *,
    seed: Optional[Tuple[str, int]] = None,
) -> List[RawNode]:
    """redis-py's parsed ``CLUSTER NODES`` → the nodes we can dial.

    The address a node announces is the one the CLUSTER knows: a pod IP, a
    hostname when the deployment sets ``cluster-preferred-endpoint-type
    hostname``, or ``?`` for the node answering us (it does not know its
    own announced ip). Preference order: the announced hostname, then the
    ip, then — for the ``?`` node only — the seed we are talking through,
    which is by definition reachable. Everything else is reported as a node
    we cannot dial rather than dropped.
    """
    nodes: List[RawNode] = []
    for address, entry in (parsed or {}).items():
        ip, _, port_text = str(address).rpartition(":")
        try:
            port = int(port_text)
        except (TypeError, ValueError):
            continue
        flags = str(entry.get("flags") or "")
        hostname = (entry.get("hostname") or "").strip()
        host = hostname or (ip if ip and ip != "?" else "")
        dialable, reason = True, None
        if not host:
            if "myself" in flags and seed is not None:
                host, port = seed[0], seed[1]
            else:
                host = ip or "?"
                dialable = False
                reason = "the cluster announces no address for this node"
        announced = f"{ip or '?'}:{port}"
        if dialable:
            mapped_host, mapped_port = remap_address(cfg, host, port)
        else:
            mapped_host, mapped_port = host, port
        master_id = entry.get("master_id")
        nodes.append(RawNode(
            host=mapped_host,
            port=int(mapped_port),
            endpoint=f"{mapped_host}:{mapped_port}",
            announced=announced,
            role="replica" if "slave" in flags.lower() else "master",
            node_id=entry.get("node_id"),
            master_id=master_id if master_id and master_id != "-" else None,
            gossip=_gossip_of(flags),
            slots=_slot_ranges(entry.get("slots")),
            dialable=dialable,
            reason=reason,
        ))
    return nodes


def group_shards(nodes: Sequence[RawNode]) -> List[Tuple[RawNode, List[RawNode]]]:
    """Masters (ordered by their first slot) each with their replicas.

    A master with no slots sorts last: it is in the cluster but owns
    nothing — a state worth seeing rather than hiding.
    """
    masters = [n for n in nodes if n.role == "master"]
    by_id = {n.node_id: n for n in masters if n.node_id}
    replicas: Dict[str, List[RawNode]] = {}
    orphans: List[RawNode] = []
    for node in nodes:
        if node.role != "replica":
            continue
        if node.master_id and node.master_id in by_id:
            replicas.setdefault(node.master_id, []).append(node)
        else:
            orphans.append(node)
    masters.sort(key=lambda n: (n.slots[0][0] if n.slots else 1 << 20, n.endpoint))
    shards = [
        (m, sorted(replicas.get(m.node_id or "", []), key=lambda r: r.endpoint))
        for m in masters
    ]
    # A replica whose master is not in the reply (mid-failover, or a
    # partial view) still belongs to the page: attach it to the first
    # shard rather than losing it.
    if orphans and shards:
        shards[0][1].extend(sorted(orphans, key=lambda r: r.endpoint))
    return shards


def _coverage(shards: Sequence[Tuple[RawNode, List[RawNode]]]) -> Tuple[int, Optional[str]]:
    from backend.app.providers.falkordb_connection import _missing_slot_ranges

    covered: set = set()
    for master, _ in shards:
        for lo, hi in master.slots:
            covered.update(range(lo, hi + 1))
    if len(covered) >= 16384:
        return 16384, None
    return len(covered), _missing_slot_ranges(covered)


async def discover_cluster(cfg: FalkorDBConnConfig, budget: float) -> RawTopology:
    """Every node of a cluster, from the first seed that answers.

    ``CLUSTER NODES`` is the primary source: it names every node, its role,
    its slots, its node id and what the cluster bus thinks of it. When a
    deployment's ACL refuses it, fall back to the slot map redis-py builds
    (roles and slots, no ids or gossip). No seed answering at all is the
    only case that leaves the instance unreachable.
    """
    last_error: Optional[str] = None
    for host, port in cfg.cluster_nodes or []:
        async def _attempt(c: FalkorDBConnConfig, _host=host, _port=port):
            client = node_client(c, _host, _port, socket_timeout=budget)
            try:
                async with asyncio.timeout(budget):
                    return await client.execute_command("CLUSTER NODES")
            finally:
                await _aclose(client)

        try:
            parsed = await with_auth_negotiation(cfg, _attempt)
        except Exception as exc:                      # noqa: BLE001 — try the next seed
            last_error = _err(exc)
            logger.debug("graph store: seed %s:%s did not answer CLUSTER NODES: %s",
                         host, port, last_error)
            continue
        nodes = parse_cluster_nodes_reply(
            parsed if isinstance(parsed, dict) else {}, cfg, seed=(host, port),
        )
        if not nodes:
            last_error = "CLUSTER NODES returned no nodes"
            continue
        shards = group_shards(nodes)
        covered, missing = _coverage(shards)
        return RawTopology(
            shards=shards, discovered_via="clusterNodes",
            seed_used=f"{host}:{port}", slots_covered=covered, slots_missing=missing,
        )
    fallback = await _shards_from_slot_map(cfg, budget)
    if fallback is not None:
        return fallback
    return RawTopology(
        reachable=False,
        error=last_error or "no cluster seed is configured",
        discovered_via=None,
    )


async def _shards_from_slot_map(cfg: FalkorDBConnConfig, budget: float) -> Optional[RawTopology]:
    """The slot map redis-py itself builds, when ``CLUSTER NODES`` is refused.

    ``slots_cache[slot]`` is ``[primary, *replicas]`` after ``initialize()``,
    so roles and slot ownership survive; node ids and gossip flags do not.
    """
    from redis.asyncio.cluster import RedisCluster
    from redis.cluster import ClusterNode

    from backend.app.providers.falkordb_connection import _address_remap_kwargs

    if not cfg.cluster_nodes:
        return None
    cluster = RedisCluster(
        startup_nodes=[ClusterNode(h, p) for h, p in cfg.cluster_nodes],
        require_full_coverage=False,
        **_conn_auth_kwargs(cfg, budget),
        **_address_remap_kwargs(cfg),
    )
    try:
        async with asyncio.timeout(budget):
            await cluster.initialize()
        slots = getattr(cluster.nodes_manager, "slots_cache", None) or {}
        by_master: Dict[str, Tuple[RawNode, List[RawNode], set]] = {}
        for slot, chain in slots.items():
            if not chain:
                continue
            primary = chain[0]
            key = f"{primary.host}:{primary.port}"
            if key not in by_master:
                by_master[key] = (
                    RawNode(host=primary.host, port=int(primary.port),
                            endpoint=key, announced=key, role="master"),
                    [RawNode(host=r.host, port=int(r.port),
                             endpoint=f"{r.host}:{r.port}",
                             announced=f"{r.host}:{r.port}", role="replica")
                     for r in chain[1:]],
                    set(),
                )
            by_master[key][2].add(int(slot))
        if not by_master:
            return None
        shards: List[Tuple[RawNode, List[RawNode]]] = []
        for master, replicas, owned in by_master.values():
            master.slots = _ranges_of(owned)
            shards.append((master, replicas))
        shards.sort(key=lambda s: (s[0].slots[0][0] if s[0].slots else 1 << 20,
                                   s[0].endpoint))
        covered, missing = _coverage(shards)
        return RawTopology(
            shards=shards, discovered_via="clusterSlots",
            slots_covered=covered, slots_missing=missing,
        )
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.info("graph store: slot-map discovery failed: %s", _err(exc))
        return None
    finally:
        await _aclose(cluster)


def _ranges_of(slots: set) -> List[List[int]]:
    out: List[List[int]] = []
    for slot in sorted(slots):
        if out and slot == out[-1][1] + 1:
            out[-1][1] = slot
        else:
            out.append([slot, slot])
    return out


# ── Sentinel and standalone ──────────────────────────────────────────────


async def _replicas_from_info(
    cfg: FalkorDBConnConfig, host: str, port: int, budget: float,
) -> List[RawNode]:
    """The replicas a master lists in ``INFO replication``.

    Outside cluster mode this is the only way to see them at all: sentinel
    announces the master, standalone announces nothing.
    """
    client = node_client(cfg, host, port, socket_timeout=budget)
    try:
        async with asyncio.timeout(budget):
            info = info_parse.parse_info_text(await client.info("replication"))
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.debug("graph store: replication read on %s:%s failed: %s",
                     host, port, _err(exc))
        return []
    finally:
        await _aclose(client)
    out: List[RawNode] = []
    for entry in info_parse.replication_stats(info).get("replicas", []):
        r_host, _, r_port = str(entry["endpoint"]).rpartition(":")
        mapped_host, mapped_port = remap_address(cfg, r_host, int(r_port))
        out.append(RawNode(
            host=mapped_host, port=int(mapped_port),
            endpoint=f"{mapped_host}:{mapped_port}",
            announced=entry["endpoint"], role="replica",
        ))
    return out


async def discover_sentinel(cfg: FalkorDBConnConfig, budget: float) -> RawTopology:
    try:
        host, port = await resolve_sentinel_master(cfg, budget)
    except Exception as exc:                          # noqa: BLE001 — by contract
        return RawTopology(reachable=False, error=_err(exc), discovered_via="sentinel")
    master = RawNode(host=host, port=int(port), endpoint=f"{host}:{port}",
                     announced=f"{host}:{port}", role="master")
    replicas = await _replicas_from_info(cfg, host, int(port), budget)
    return RawTopology(shards=[(master, replicas)], discovered_via="sentinel")


async def discover_standalone(cfg: FalkorDBConnConfig, budget: float) -> RawTopology:
    master = RawNode(host=cfg.host, port=int(cfg.port),
                     endpoint=f"{cfg.host}:{cfg.port}",
                     announced=f"{cfg.host}:{cfg.port}", role="master")
    replicas = await _replicas_from_info(cfg, cfg.host, int(cfg.port), budget)
    return RawTopology(shards=[(master, replicas)], discovered_via="info")


async def discover(cfg: FalkorDBConnConfig, *, budget: Optional[float] = None) -> RawTopology:
    """Every node of one instance, whatever its topology."""
    b = budget if budget is not None else connect_verify_budget(cfg, 1.5)
    if cfg.mode == "cluster":
        return await discover_cluster(cfg, b)
    if cfg.mode == "sentinel":
        return await discover_sentinel(cfg, b)
    return await discover_standalone(cfg, b)


# ── Reading one node ─────────────────────────────────────────────────────


def parse_graph_memory_reply(raw: Any) -> Tuple[Optional[int], Dict[str, int]]:
    """``GRAPH.MEMORY USAGE`` → ``(total_bytes, {field: bytes})``.

    The server answers in megabytes, one ``*_sz_mb`` field per part of the
    graph (matrices, node/edge blocks, attributes, indices). Any shape the
    client hands back is accepted; an unrecognised reply yields no total,
    never an exception.
    """
    pairs = info_parse.parse_config_pairs(raw)
    detail: Dict[str, int] = {}
    total: Optional[int] = None
    for name, value in pairs.items():
        if not name.endswith("_sz_mb"):
            continue
        mb = info_parse.as_float(value)
        if mb is None:
            continue
        as_bytes = int(mb * (1024 ** 2))
        detail[name] = as_bytes
        if name == "total_graph_sz_mb":
            total = as_bytes
    if total is None and detail:
        total = sum(v for k, v in detail.items() if k != "total_graph_sz_mb")
    return total, detail


async def read_node(
    cfg: FalkorDBConnConfig, node: RawNode, *, budget: float,
    want_graphs: bool = False, measure_keys: Sequence[str] = (),
) -> Dict[str, Any]:
    """One node's numbers, in one bounded visit. Never raises.

    Order matters: liveness and memory first (they are what the page is
    for), then the master-only extras, and per-graph sizes last — so a slow
    ``GRAPH.MEMORY`` costs the graph sizes, never the memory reading.
    """
    out: Dict[str, Any] = {
        "endpoint": node.endpoint,
        "announced": node.announced,
        "nodeId": node.node_id,
        "role": node.role,
        "gossip": node.gossip,
        "status": "up",
        "error": None,
        "latencyMs": None,
        "memory": {},
        "replication": {},
        "server": {},
        "limits": {},
        "graphs": None,
        "graphMemory": None,
        "measured": {},
    }
    if not node.dialable:
        out["status"] = "unreachable"
        out["error"] = node.reason or "no dialable address"
        return out

    # Building the client can itself fail (a TLS bundle that will not load,
    # an address the URL parser rejects). This function's contract is that a
    # node fault never raises — the sweep gathers every node without
    # ``return_exceptions``, so one that did would take the whole snapshot
    # down rather than costing one row.
    try:
        client = node_client(cfg, node.host, node.port, socket_timeout=budget)
    except Exception as exc:                          # noqa: BLE001 — by contract
        out["status"] = "unreachable"
        out["error"] = _err(exc)
        return out
    deadline = time.monotonic() + budget
    try:
        started = time.monotonic()
        async with asyncio.timeout(budget):
            await client.ping()
        out["latencyMs"] = round((time.monotonic() - started) * 1000, 1)

        async with asyncio.timeout(max(0.1, deadline - time.monotonic())):
            info = info_parse.parse_info_text(await client.info())
        out["memory"] = info_parse.memory_stats(info)
        out["server"] = info_parse.server_stats(info)
        out["replication"] = info_parse.replication_stats(info)
        # The announced role can lag a failover; INFO is authoritative.
        live_role = out["replication"].get("role")
        if live_role in ("master", "replica"):
            out["role"] = live_role

        try:
            async with asyncio.timeout(max(0.1, deadline - time.monotonic())):
                cfg_pairs = info_parse.parse_config_pairs(await client.config_get(
                    "repl-backlog-size", "client-output-buffer-limit",
                    "repl-timeout", "cluster-node-timeout",
                ))
        except Exception as exc:                      # noqa: BLE001 — optional detail
            logger.debug("graph store: CONFIG GET on %s failed: %s", node.endpoint, _err(exc))
            cfg_pairs = {}
        out["limits"].update({
            "replBacklogBytes": info_parse.parse_memory_bytes(
                cfg_pairs.get("repl-backlog-size")),
            "replicaBufferHardBytes": info_parse.replica_output_buffer_hard_limit(cfg_pairs),
            "clusterNodeTimeoutMs": info_parse.as_int(
                cfg_pairs.get("cluster-node-timeout")),
        })

        if want_graphs and out["role"] == "master":
            from backend.app.providers.shard_capacity import _read_server_limits

            try:
                async with asyncio.timeout(max(0.1, deadline - time.monotonic())):
                    raw = await client.execute_command("GRAPH.LIST")
                out["graphs"] = sorted({_decode(k) for k in (raw or [])})
            except Exception as exc:                  # noqa: BLE001 — optional detail
                logger.debug("graph store: GRAPH.LIST on %s failed: %s",
                             node.endpoint, _err(exc))
            try:
                async with asyncio.timeout(max(0.1, deadline - time.monotonic())):
                    out["limits"].update(await _read_server_limits(client, None))
            except Exception as exc:                  # noqa: BLE001 — optional detail
                logger.debug("graph store: GRAPH.CONFIG on %s failed: %s",
                             node.endpoint, _err(exc))
            await _measure_graphs(client, node, out, measure_keys, deadline)
    except Exception as exc:                          # noqa: BLE001 — by contract
        out["status"] = "unreachable"
        out["error"] = _err(exc)
        logger.info("graph store: node %s unreachable: %s", node.endpoint, out["error"])
    finally:
        await _aclose(client)
    return out


async def _measure_graphs(
    client: Any, node: RawNode, out: Dict[str, Any],
    measure_keys: Sequence[str], deadline: float,
) -> None:
    """Per-graph sizes, with what is left of the node's budget.

    ``GRAPH.MEMORY USAGE`` is optional by design: a server without it
    answers with an error, and the page falls back to the planning estimate
    (edges × bytes per edge) rather than showing nothing. Running out of
    time is equally benign — the sizes gathered so far stand.
    """
    present = set(out.get("graphs") or [])
    keys = [k for k in measure_keys if k in present][:MAX_GRAPH_MEASURES_PER_NODE]
    if not keys:
        return
    for key in keys:
        remaining = deadline - time.monotonic()
        if remaining <= 0.15:
            out["graphMemory"] = out["graphMemory"] or "skipped"
            return
        try:
            async with asyncio.timeout(remaining):
                raw = await client.execute_command(
                    "GRAPH.MEMORY", "USAGE", key, "SAMPLES", GRAPH_MEMORY_SAMPLES,
                )
        except asyncio.TimeoutError:
            out["graphMemory"] = out["graphMemory"] or "skipped"
            return
        except Exception as exc:                      # noqa: BLE001 — server may not have it
            out["graphMemory"] = "unsupported"
            logger.debug("graph store: GRAPH.MEMORY unavailable on %s: %s",
                         node.endpoint, _err(exc))
            return
        total, detail = parse_graph_memory_reply(raw)
        if total is not None:
            out["measured"][key] = {"bytes": total, "detail": detail}
            out["graphMemory"] = "measured"


def _decode(value: Any) -> str:
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    return str(value)
