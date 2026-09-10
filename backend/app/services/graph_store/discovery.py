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
    role: str = "master"              # "master" | "replica" | "joining"
    node_id: Optional[str] = None
    master_id: Optional[str] = None
    gossip: Optional[str] = None      # "fail" | "pfail" | "noaddr" | "handshake"
    slots: List[List[int]] = field(default_factory=list)
    dialable: bool = True
    reason: Optional[str] = None      # why not dialable
    #: Every flag token the cluster gave, exactly as tokens. Substring tests
    #: on the joined string are how ``nofailover`` came to be read as
    #: ``fail`` and paint a healthy node red.
    flags: frozenset = frozenset()
    #: "connected" | "disconnected" — the cluster bus link, which is not the
    #: same as the FAIL verdict and can be down long before one is reached.
    link_state: Optional[str] = None
    #: Settles which master owns a slot range when two of them claim it.
    epoch: Optional[int] = None
    #: (slot, peer node id) — only ever present on the answering node's own
    #: line, so they say "a reshard is running", not "here is all of it".
    migrating: List[Tuple[int, str]] = field(default_factory=list)
    importing: List[Tuple[int, str]] = field(default_factory=list)


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
    #: Nodes the cluster knows that belong to no shard — mid-MEET, without
    #: an announced address, or following a master this view cannot see.
    #: They are the cluster's own truth and are reported rather than either
    #: invented into a shard or dropped.
    unplaced: List[RawNode] = field(default_factory=list)
    #: endpoint → the node ids that resolve to it, when more than one does.
    collisions: Dict[str, List[str]] = field(default_factory=dict)
    #: ``CLUSTER INFO`` — the cluster's own count of itself, to check the
    #: number this page prints against.
    cluster_info: Dict[str, Any] = field(default_factory=dict)


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


def _gossip_of(flags: frozenset) -> Optional[str]:
    """What the cluster bus thinks of a node, from EXACT flag tokens.

    ``"fail" in "slave,nofailover"`` is true, which is how a replica held
    out of failover — standard for a cross-AZ or restoring replica — came
    to be rendered red, labelled FAIL, over a tooltip reading "the
    cluster's agreement".
    """
    if "fail?" in flags:
        return "pfail"
    if "fail" in flags:
        return "fail"
    if "noaddr" in flags:
        return "noaddr"
    if "handshake" in flags:
        return "handshake"
    return None


def _as_int(text: Any) -> Optional[int]:
    try:
        return int(text)
    except (TypeError, ValueError):
        return None


def _parse_address(addr: str) -> Tuple[str, Optional[int], str]:
    """``10.0.0.1:6379@16379,node2.example.com,shard-id=ff`` → ip, port, hostname.

    The bus port and the Redis 7 auxiliary fields are read and discarded
    here rather than never seen: an aux field is ``key=value``, a hostname
    is not, which is how the two are told apart when only one is present.
    """
    parts = addr.split(",")
    base, _, _bus_port = parts[0].partition("@")
    ip, _, port_text = base.rpartition(":")
    hostname = next((p.strip() for p in parts[1:] if p and "=" not in p), "")
    return ip, _as_int(port_text), hostname


def _slots_from_fields(fields: Sequence[str]) -> Tuple[
    List[List[int]], List[Tuple[int, str]], List[Tuple[int, str]],
]:
    """The slot fields: owned ranges, plus migrating-out and importing-in.

    A migrating slot is still OWNED by this node until the migration
    finishes, so it stays in the ranges; an importing one is not owned yet
    and does not. Both are also reported, because a reshard in progress is
    the explanation for figures that otherwise look wrong.
    """
    owned: List[List[int]] = []
    migrating: List[Tuple[int, str]] = []
    importing: List[Tuple[int, str]] = []
    for token in fields:
        if token.startswith("[") and token.endswith("]"):
            body = token[1:-1]
            for marker, sink in (("->-", migrating), ("-<-", importing)):
                slot_text, sep, peer = body.partition(marker)
                if sep:
                    slot = _as_int(slot_text)
                    if slot is not None:
                        sink.append((slot, peer))
                    break
            continue
        lo_text, _, hi_text = token.partition("-")
        lo = _as_int(lo_text)
        if lo is None:
            continue
        hi = _as_int(hi_text) if hi_text else lo
        owned.append([lo, hi if hi is not None else lo])
    return sorted(owned), migrating, importing


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


def parse_cluster_nodes_text(
    text: Any, cfg: FalkorDBConnConfig, *, seed: Optional[Tuple[str, int]] = None,
) -> List[RawNode]:
    """``CLUSTER NODES`` output → the nodes of the cluster.

    Parsed from the reply text rather than from redis-py's dict, which is
    keyed on ``ip:port``: every node the cluster has no address for is
    written ``:0@0``, so they all share the key ``":0"`` and all but one
    are lost. Two pods losing their addresses at once — a rolling restart,
    a half-finished ``CLUSTER FORGET`` — is enough. The dict also drops the
    config epoch, the link state, the migration markers and the Redis 7
    auxiliary fields before this module can see them.

    One line per node:

        <id> <ip:port@cport[,hostname[,aux=val]]> <flags> <master>
        <ping-sent> <pong-recv> <config-epoch> <link-state> <slot>...

    The address a node announces is the one the CLUSTER knows: a pod IP, a
    hostname when the deployment sets ``cluster-preferred-endpoint-type
    hostname``, or nothing at all for a node with no known address.
    Preference order: the announced hostname, then the ip, then — for the
    answering node only — the seed we are talking through, which is
    reachable by definition. Everything else is reported as a node we
    cannot dial, never dropped.
    """
    nodes: List[RawNode] = []
    for line in str(text or "").splitlines():
        fields = line.split()
        if len(fields) < 8:
            continue
        node_id, address, flag_text, master_id = fields[0], fields[1], fields[2], fields[3]
        flags = frozenset(f for f in flag_text.split(",") if f)
        ip, port, hostname = _parse_address(address)
        if port is None:
            logger.debug("graph store: unreadable node address %r", address)
            continue

        # What the CLUSTER said, captured before the seed can stand in for
        # it — otherwise a node with no announced address is reported as
        # announcing the seed's port, which it never said.
        announced = f"{ip or '?'}:{port}"

        host = hostname or (ip if ip and ip != "?" else "")
        dialable, reason = True, None
        if not host:
            if "myself" in flags and seed is not None:
                host, port = seed[0], seed[1]
            else:
                host = ip or "?"
                dialable = False
                reason = "the cluster announces no address for this node"
        mapped_host, mapped_port = (
            remap_address(cfg, host, port) if dialable else (host, port)
        )
        owned, migrating, importing = _slots_from_fields(fields[8:])

        if "slave" in flags:
            role = "replica"
        elif "master" in flags:
            role = "master"
        else:
            # A node mid-MEET carries `handshake` and nothing else. Calling
            # it a master because it is not a slave is how one came to hold
            # a shard of its own, be counted, and be swept for graphs.
            role = "joining"

        nodes.append(RawNode(
            host=mapped_host,
            port=int(mapped_port),
            endpoint=f"{mapped_host}:{mapped_port}",
            announced=announced,
            role=role,
            node_id=node_id or None,
            master_id=master_id if master_id and master_id != "-" else None,
            gossip=_gossip_of(flags),
            slots=owned,
            dialable=dialable,
            reason=reason,
            flags=flags,
            link_state=fields[7] or None,
            epoch=_as_int(fields[6]),
            migrating=migrating,
            importing=importing,
        ))
    return _deduped(nodes)


def _deduped(nodes: Sequence[RawNode]) -> List[RawNode]:
    """One entry per node id. A cluster cannot list a node twice, but a
    reply read through a stale or partial view can, and a duplicate becomes
    a duplicated row and an inflated count on every figure downstream."""
    seen: Dict[str, RawNode] = {}
    out: List[RawNode] = []
    for node in nodes:
        key = node.node_id or f"@{node.endpoint}"
        if key in seen:
            continue
        seen[key] = node
        out.append(node)
    return out


def endpoint_collisions(nodes: Sequence[RawNode]) -> Dict[str, List[str]]:
    """Endpoints that more than one node id resolves to.

    Two nodes reached at one address is not a topology this page can
    describe: the endpoint is what every downstream reading, cache entry
    and table row is keyed by, so the two become one row shown twice with
    the same figures. It happens when an ``addressRemap`` points several
    nodes at one gateway, or when ``cluster-announce-hostname`` is set to a
    headless service name so every pod announces the same host. The
    cross-pod fan-out already refuses to run in this state; here it is
    reported, because a view that refuses to load helps nobody.
    """
    by_endpoint: Dict[str, List[str]] = {}
    for node in nodes:
        # Nodes the cluster gives no address share a placeholder rather than
        # an address. They are already reported as undialable, each with its
        # reason; calling that a collision would be a second, wrong alarm.
        if node.node_id and node.dialable:
            by_endpoint.setdefault(node.endpoint, []).append(node.node_id)
    return {e: ids for e, ids in by_endpoint.items() if len(ids) > 1}


def group_shards(
    nodes: Sequence[RawNode],
) -> Tuple[List[Tuple[RawNode, List[RawNode]]], List[RawNode]]:
    """Masters (ordered by their first slot) each with their replicas, and
    everything the cluster knows that belongs to no shard.

    A master with no slots sorts last: it is in the cluster and owns
    nothing — a state worth seeing rather than hiding. A node mid-MEET is
    not a master at all and gets no shard.

    A replica is placed under the master it names, following a chain to the
    master at its head. One whose master this view cannot see is NOT
    attached to the first shard: doing that asserted a replication
    relationship the cluster never described, put its lag and its findings
    under a master it has nothing to do with, and inflated that shard's
    replica count. It goes to ``unplaced`` with the id it named.
    """
    masters = [n for n in nodes if n.role == "master"]
    by_id = {n.node_id: n for n in nodes if n.node_id}
    master_ids = {n.node_id for n in masters if n.node_id}

    def _head(node: RawNode) -> Optional[str]:
        """The master at the head of this replica's chain, if it is in view."""
        seen: set = set()
        current = node.master_id
        while current and current not in seen:
            if current in master_ids:
                return current
            seen.add(current)
            nxt = by_id.get(current)
            current = nxt.master_id if nxt is not None else None
        return None

    replicas: Dict[str, List[RawNode]] = {}
    unplaced: List[RawNode] = [n for n in nodes if n.role == "joining"]
    for node in nodes:
        if node.role != "replica":
            continue
        head = _head(node)
        if head is None:
            unplaced.append(node)
        else:
            replicas.setdefault(head, []).append(node)

    masters.sort(key=lambda n: (n.slots[0][0] if n.slots else 1 << 20, n.endpoint))
    shards = [
        (m, sorted(replicas.get(m.node_id or "", []), key=lambda r: r.endpoint))
        for m in masters
    ]
    return shards, sorted(unplaced, key=lambda n: n.endpoint)


def _coverage(shards: Sequence[Tuple[RawNode, List[RawNode]]]) -> Tuple[int, Optional[str]]:
    from backend.app.providers.falkordb_connection import _missing_slot_ranges

    covered: set = set()
    for master, _ in shards:
        for lo, hi in master.slots:
            covered.update(range(lo, hi + 1))
    if len(covered) >= 16384:
        return 16384, None
    return len(covered), _missing_slot_ranges(covered)


def _seed_order(
    cfg: FalkorDBConnConfig, extra: Sequence[Tuple[str, int]],
) -> List[Tuple[str, int]]:
    """Nodes to ask, best first, without repeats.

    Whatever answered last time comes first: a provider's configured seeds
    are its masters as they were on the day it was set up, and masters move.
    """
    out: List[Tuple[str, int]] = []
    seen: set = set()
    for host, port in list(extra or []) + list(cfg.cluster_nodes or []):
        key = f"{host}:{port}"
        if key not in seen:
            seen.add(key)
            out.append((host, int(port)))
    return out


async def discover_cluster(
    cfg: FalkorDBConnConfig, budget: float,
    extra_seeds: Sequence[Tuple[str, int]] = (),
) -> RawTopology:
    """Every node of a cluster, from the first seed that answers.

    ``CLUSTER NODES`` is the primary source: it names every node, its role,
    its slots, its node id and what the cluster bus thinks of it. When a
    deployment's ACL refuses it, fall back to the slot map redis-py builds
    (roles and slots, no ids or gossip). No seed answering at all is the
    only case that leaves the instance unreachable.
    """
    last_error: Optional[str] = None
    for host, port in _seed_order(cfg, extra_seeds):
        async def _attempt(c: FalkorDBConnConfig, _host=host, _port=port):
            client = node_client(c, _host, _port, socket_timeout=budget)
            # The reply text, not redis-py's dict: its dict is keyed on
            # ``ip:port``, so every node the cluster has no address for
            # collapses onto the key ``":0"`` and all but one are lost.
            client.set_response_callback("CLUSTER NODES", lambda reply: reply)
            try:
                async with asyncio.timeout(budget):
                    text = await client.execute_command("CLUSTER NODES")
                    try:
                        info = await client.execute_command("CLUSTER INFO")
                    except Exception:                 # noqa: BLE001 — optional
                        info = None
                    return text, info
            finally:
                await _aclose(client)

        try:
            text, info = await with_auth_negotiation(cfg, _attempt)
        except Exception as exc:                      # noqa: BLE001 — try the next seed
            last_error = _err(exc)
            logger.debug("graph store: seed %s:%s did not answer CLUSTER NODES: %s",
                         host, port, last_error)
            continue
        nodes = parse_cluster_nodes_text(_decode(text), cfg, seed=(host, port))
        if not nodes:
            last_error = "CLUSTER NODES returned no nodes"
            continue
        shards, unplaced = group_shards(nodes)
        covered, missing = _coverage(shards)
        return RawTopology(
            shards=shards, unplaced=unplaced, discovered_via="clusterNodes",
            seed_used=f"{host}:{port}", slots_covered=covered, slots_missing=missing,
            collisions=endpoint_collisions(nodes),
            cluster_info=info_parse.parse_info_text(_decode(info)) if info else {},
        )
    fallback = await _shards_from_slot_map(cfg, budget)
    if fallback is not None:
        # Why CLUSTER NODES was refused is the whole reason this path ran —
        # without it the page shows a healthy store and never says that an
        # ACL is hiding half of what it could tell you.
        fallback.error = last_error
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


async def discover(
    cfg: FalkorDBConnConfig, *, budget: Optional[float] = None,
    extra_seeds: Sequence[Tuple[str, int]] = (),
) -> RawTopology:
    """Every node of one instance, whatever its topology."""
    b = budget if budget is not None else connect_verify_budget(cfg, 1.5)
    if cfg.mode == "cluster":
        return await discover_cluster(cfg, b, extra_seeds)
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
