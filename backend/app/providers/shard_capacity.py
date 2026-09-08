"""Shard capacity for aggregation writes — measured, overridable, explained.

Why this module exists. The write budget used to be a static edge count
(``AGGREGATION_MAX_MATERIALIZED_EDGES``, default 25M, bound 50M) compared
against the computed result. It never read the instance, so adding memory to
a shard changed nothing, and the number could not exceed its own bound. A
rebuild now asks the shard that owns the graph how much room it has and
decides from that — with every figure overridable one layer up (per-job
tuning → global Defaults → env) and every decision recorded with its
reasons, on the job when it succeeds and in the refusal when it does not.

Shape, so the next resource or scope is an input rather than a rewrite:

* :class:`ShardMemory` — one measurement of one shard: what it holds, what
  it may hold, and whether the reading is real. ``source == "unavailable"``
  is a first-class answer, never an exception — measurement can inform a
  decision but must never fail a job on its own.
* :class:`WriteBudget` — the allowance derived from a measurement and the
  operator's limits, naming the rule in force (``shard`` when measured, the
  static cap otherwise) and the explicit ceiling if one is set.
* :class:`Verdict` — one write's answer, with the numbers a person needs:
  what it needs, what is there, and by how much it falls short.

Layering: this is the provider layer (beside ``falkordb_connection``), so it
knows redis clients and topologies and nothing about jobs, workers or the
settings table. The pipeline hands it the resolved limits.

Growth, not size. A rebuild that re-materialises cells the graph already
holds does not grow the shard; only NEW cells do. So the budget is checked
against ``max(0, projected − existing)`` before the first write, and against
the size of each overflow wave before that wave — by then a fresh reading
already contains the waves that landed.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# ── Operator limits: env defaults and the bounds every layer clamps to ──

#: Share of ``maxmemory`` the pipeline will never fill. A shard is shared:
#: under ``noeviction`` the write that fills it fails EVERY graph's writes
#: on that shard, so the reserve protects the neighbours, not this graph.
RESERVE_PCT_DEFAULT = 20
RESERVE_PCT_LO, RESERVE_PCT_HI = 0, 90

#: Bytes one stored :AGGREGATED edge costs on the shard, until a run has
#: measured it. The historical planning figure (~0.5KB) — an estimate that
#: nothing ever multiplied before this module existed.
BYTES_PER_EDGE_DEFAULT = 512
BYTES_PER_EDGE_LO, BYTES_PER_EDGE_HI = 64, 16_384

#: How far an UPPER-BOUND estimate may exceed the allowance before the run
#: is refused up front. The estimate counts cells that dedupe away (parallel
#: raw edges, diamonds, excluded self and leaf cells) — up to ~25% high on
#: depth-3 trees — so refusing at exactly the allowance would turn away
#: rebuilds that fit. The exact post-compute check stands behind this one.
ESTIMATE_MARGIN_PCT_DEFAULT = 25
ESTIMATE_MARGIN_PCT_LO, ESTIMATE_MARGIN_PCT_HI = 0, 100

#: A calibration run must have grown the graph by at least this many edges:
#: below it, a neighbour's activity or lazy slot reclamation dominates the
#: memory delta and the ratio is noise.
CALIBRATION_MIN_GROWTH_EDGES = 100_000


def _clamp(value: Any, lo: int, hi: int, default: int) -> int:
    try:
        return max(lo, min(hi, int(value)))
    except (TypeError, ValueError):
        return default


def _env_clamped(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    value = _clamp(raw, lo, hi, default)
    if str(value) != raw.strip():
        logger.warning("%s=%r is outside [%d, %d] or not an integer; using %d",
                       name, raw, lo, hi, value)
    return value


def shard_reserve_pct_default() -> int:
    return _env_clamped("AGGREGATION_SHARD_RESERVE_PCT", RESERVE_PCT_DEFAULT,
                        RESERVE_PCT_LO, RESERVE_PCT_HI)


def bytes_per_edge_default() -> int:
    return _env_clamped("AGGREGATION_BYTES_PER_EDGE", BYTES_PER_EDGE_DEFAULT,
                        BYTES_PER_EDGE_LO, BYTES_PER_EDGE_HI)


def estimate_margin_pct_default() -> int:
    return _env_clamped("AGGREGATION_ESTIMATE_MARGIN_PCT", ESTIMATE_MARGIN_PCT_DEFAULT,
                        ESTIMATE_MARGIN_PCT_LO, ESTIMATE_MARGIN_PCT_HI)


# ── The measurement ─────────────────────────────────────────────────────


@dataclass(frozen=True)
class ShardMemory:
    """One reading of one shard. ``source`` says whether it is real."""
    endpoint: str
    used: Optional[int]
    maxmemory: Optional[int]
    policy: Optional[str]
    observed_at: float
    source: str                     # "measured" | "unavailable"
    note: Optional[str] = None      # why unavailable, or "no maxmemory"

    @property
    def measurable(self) -> bool:
        """A reading the budget can use: real, with a ceiling to measure
        against. ``maxmemory 0`` is unlimited from Redis's point of view and
        unknowable from ours — it reads as not measurable, never as full."""
        return (
            self.source == "measured"
            and self.used is not None
            and (self.maxmemory or 0) > 0
        )

    @property
    def why_not(self) -> str:
        """The coarse reason a reading cannot govern — for the message.
        Coarse on purpose: raw client errors carry words ("connection",
        "timeout") that route the failure into the wrong resolution bucket."""
        if self.source != "measured":
            return "the shard's memory could not be measured"
        if not (self.maxmemory or 0) > 0:
            return "the shard reports no maxmemory"
        return "the shard's memory reading was incomplete"

    def as_stats(self) -> Dict[str, Any]:
        return {
            "endpoint": self.endpoint,
            "used": self.used,
            "maxmemory": self.maxmemory,
            "policy": self.policy,
            "source": self.source,
            **({"note": self.note} if self.note else {}),
        }


def _as_int(value: Any) -> Optional[int]:
    """INFO numbers arrive as int or str depending on client and parser."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _parse_info(raw: Any) -> Dict[str, Any]:
    """Accept what the clients hand back: a parsed dict, a ``{node: dict}``
    map from a cluster call, or the raw ``key:value`` text."""
    if isinstance(raw, dict):
        if "used_memory" in raw or "maxmemory" in raw:
            return raw
        inner = [v for v in raw.values() if isinstance(v, dict)]
        if len(inner) == 1:
            return inner[0]
        return raw
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode("utf-8", "replace")
    out: Dict[str, Any] = {}
    if isinstance(raw, str):
        for line in raw.splitlines():
            if ":" in line and not line.startswith("#"):
                k, _, v = line.partition(":")
                out[k.strip()] = v.strip()
    return out


def _endpoint_of(conn: Any) -> str:
    pool = getattr(conn, "connection_pool", None)
    kw = getattr(pool, "connection_kwargs", None) or {}
    host, port = kw.get("host"), kw.get("port")
    return f"{host}:{port}" if host else "unknown"


async def _owner(
    conn: Any, mode: Optional[str], graph_key: str, *, refresh: bool = True,
) -> tuple:
    """``(endpoint, node)`` for the node that owns ``graph_key`` through
    ``conn`` — ``node`` is the cluster node to target, ``None`` outside
    cluster mode (one node; the sentinel client follows failover inside its
    pool). Raises like the client does; the callers decide what that means.

    ``refresh`` re-fetches the cluster's slot map first (one ``CLUSTER
    SLOTS``), which is what a reading that must follow a failover wants.
    A fleet sweep placing hundreds of graphs wants the client's CURRENT map
    instead — the one its writes route by, kept fresh by the client on any
    MOVED — and pays that round trip only when the map is not there yet."""
    if mode == "cluster":
        init = getattr(conn, "initialize", None)
        have_map = bool(getattr(getattr(conn, "nodes_manager", None), "slots_cache", None))
        if init is not None and (refresh or not have_map):
            await init()
        node = conn.nodes_manager.get_node_from_slot(conn.keyslot(graph_key))
        return f"{getattr(node, 'host', '?')}:{getattr(node, 'port', '?')}", node
    return _endpoint_of(conn), None


async def owner_endpoint(
    db: Any, *, mode: Optional[str], graph_key: str, timeout: float,
) -> str:
    """Which node ``graph_key`` lives on — ``host:port`` — WITHOUT reading
    its memory. A fleet view groups graphs by this and pays one ``INFO`` per
    node instead of one per graph. Never raises: ``"unknown"`` when the
    client cannot say."""
    conn = getattr(db, "connection", None)
    if conn is None:
        return "unknown"
    try:
        async with asyncio.timeout(timeout):
            endpoint, _ = await _owner(conn, mode, graph_key, refresh=False)
            return endpoint
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.info("owner of %r unknown: %s", graph_key, exc)
        return "unknown"


async def read_shard_memory(
    db: Any, *, mode: Optional[str], graph_key: str, timeout: float,
) -> ShardMemory:
    """``INFO memory`` from the shard that owns ``graph_key`` — through the
    client the pipeline already holds (``db.connection``: the redis client
    ``falkordb_over`` wrapped, already carrying auth, TLS and the address
    remap). Never raises.

    * standalone / sentinel: one node; the sentinel client follows failover
      inside its pool.
    * cluster: ``db.connection`` is the ``RedisCluster`` the writes route by,
      so its slot map names the owner the writes will actually hit;
      ``target_nodes`` sends INFO there. Read fresh each time and never
      cached — a failover rebuilds the client, and re-reading follows it.

    Called directly on the connection, not through the provider's guarded
    query path: a probe blip must not count against the circuit breaker.
    """
    now = time.monotonic()
    conn = getattr(db, "connection", None)
    if conn is None:
        return ShardMemory("unknown", None, None, None, now, "unavailable",
                           "no client")
    endpoint = "unknown"
    try:
        async with asyncio.timeout(timeout):
            endpoint, node = await _owner(conn, mode, graph_key)
            if node is not None:
                raw = await conn.execute_command("INFO", "memory", target_nodes=node)
            else:
                raw = await conn.info("memory")
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.info("shard memory for %r via %s unavailable: %s",
                    graph_key, endpoint, exc)
        return ShardMemory(endpoint, None, None, None, now, "unavailable",
                           type(exc).__name__)
    info = _parse_info(raw)
    used = _as_int(info.get("used_memory"))
    maxmemory = _as_int(info.get("maxmemory"))
    policy = info.get("maxmemory_policy")
    if used is None:
        return ShardMemory(endpoint, None, maxmemory, policy, now, "unavailable",
                           "no used_memory in INFO")
    return ShardMemory(endpoint, used, maxmemory or 0,
                       str(policy) if policy is not None else None, now, "measured")


# ── The allowance ────────────────────────────────────────────────────────


@dataclass(frozen=True)
class Verdict:
    ok: bool
    blocked_by: Optional[str]           # None | "shard" | "ceiling" | "static"
    projected: int
    growth_edges: int
    needed_bytes: Optional[int]
    available_bytes: Optional[int]
    shortfall_bytes: Optional[int]
    shortfall_edges: int


@dataclass(frozen=True)
class WriteBudget:
    """What this run may write, and why. ``governed_by`` is the rule in
    force: ``shard`` when the owning shard was measured, else ``static``
    (today's count cap). An ``explicit_ceiling`` — ``maxMaterializedEdges``
    set in tuning — caps the TOTAL on top of either rule."""
    shard: ShardMemory
    governed_by: str                    # "shard" | "static"
    bytes_per_edge: int
    bpe_source: str                     # "tuning" | "calibrated" | "default"
    reserve_pct: int
    reserve_bytes: Optional[int]
    available_bytes: Optional[int]
    allowed_growth_edges: Optional[int]
    explicit_ceiling: Optional[int]
    static_cap: int

    def verdict(self, *, projected: int, growth_edges: int, margin_pct: int = 0) -> Verdict:
        """May ``growth_edges`` new edges land, as part of ``projected`` in
        total? ``margin_pct`` widens the allowance (shard or static) for an
        upper-bound estimate; it never widens an explicit ceiling."""
        growth = max(0, int(growth_edges))
        if self.explicit_ceiling is not None and projected > self.explicit_ceiling:
            return Verdict(False, "ceiling", projected, growth,
                           growth * self.bytes_per_edge, self.available_bytes, None,
                           projected - self.explicit_ceiling)
        if self.governed_by == "shard":
            needed = growth * self.bytes_per_edge
            available = self.available_bytes or 0
            allowance = available * (100 + max(0, margin_pct)) // 100
            if needed > allowance:
                short = needed - available
                return Verdict(False, "shard", projected, growth, needed, available,
                               short, -(-short // self.bytes_per_edge))
            return Verdict(True, None, projected, growth, needed, available, 0, 0)
        # The static rule is a count on the TOTAL; the margin stretches it for
        # an upper-bound estimate exactly as it stretches the shard allowance.
        if projected > self.static_cap * (100 + max(0, margin_pct)) // 100:
            return Verdict(False, "static", projected, growth,
                           growth * self.bytes_per_edge, None, None,
                           projected - self.static_cap)
        return Verdict(True, None, projected, growth, growth * self.bytes_per_edge,
                       None, 0, 0)

    def as_stats(self) -> Dict[str, Any]:
        return {
            "governed_by": self.governed_by,
            "bytes_per_edge": self.bytes_per_edge,
            "bytes_per_edge_source": self.bpe_source,
            "reserve_pct": self.reserve_pct,
            "reserve_bytes": self.reserve_bytes,
            "available_bytes": self.available_bytes,
            "allowed_growth_edges": self.allowed_growth_edges,
            "explicit_ceiling": self.explicit_ceiling,
            "static_cap": self.static_cap,
            "shard": self.shard.as_stats(),
        }


def compute_write_budget(
    shard: ShardMemory, *,
    reserve_pct: Optional[int],
    bytes_per_edge: Optional[int],
    bpe_source: str,
    explicit_ceiling: Optional[int],
    static_cap: int,
) -> WriteBudget:
    """Pure. ``reserve_pct`` / ``bytes_per_edge`` are the RESOLVED operator
    values (``None`` → env default); ``explicit_ceiling`` is present only
    when tuning set it; ``static_cap`` is the fallback count rule."""
    reserve = (shard_reserve_pct_default() if reserve_pct is None
               else _clamp(reserve_pct, RESERVE_PCT_LO, RESERVE_PCT_HI, RESERVE_PCT_DEFAULT))
    bpe = (bytes_per_edge_default() if bytes_per_edge is None
           else _clamp(bytes_per_edge, BYTES_PER_EDGE_LO, BYTES_PER_EDGE_HI,
                       BYTES_PER_EDGE_DEFAULT))
    if shard.measurable:
        maxmemory = int(shard.maxmemory or 0)
        reserve_bytes = maxmemory * reserve // 100
        available = max(0, maxmemory - reserve_bytes - int(shard.used or 0))
        return WriteBudget(
            shard=shard, governed_by="shard", bytes_per_edge=bpe, bpe_source=bpe_source,
            reserve_pct=reserve, reserve_bytes=reserve_bytes, available_bytes=available,
            allowed_growth_edges=available // bpe, explicit_ceiling=explicit_ceiling,
            static_cap=static_cap,
        )
    return WriteBudget(
        shard=shard, governed_by="static", bytes_per_edge=bpe, bpe_source=bpe_source,
        reserve_pct=reserve, reserve_bytes=None, available_bytes=None,
        allowed_growth_edges=None, explicit_ceiling=explicit_ceiling, static_cap=static_cap,
    )


# ── Calibration ─────────────────────────────────────────────────────────


def calibrate_bytes_per_edge(
    *, used_before: Optional[int], used_after: Optional[int],
    edges_before: int, edges_after: int,
    min_growth: int = CALIBRATION_MIN_GROWTH_EDGES,
) -> Optional[int]:
    """The shard's memory delta over the run, per NET new edge. ``None``
    when the run cannot calibrate: no reading on either side, growth below
    ``min_growth`` (noise dominates), or a non-positive delta (a neighbour
    shrank while we wrote). Clamped, so one odd run cannot poison the next
    budget in either direction."""
    if used_before is None or used_after is None:
        return None
    growth = edges_after - edges_before
    delta = used_after - used_before
    if growth < min_growth or delta <= 0:
        return None
    return _clamp(delta // growth, BYTES_PER_EDGE_LO, BYTES_PER_EDGE_HI,
                  BYTES_PER_EDGE_DEFAULT)


# ── The refusal ─────────────────────────────────────────────────────────

#: Stable prefix ``classify_failure`` keys on. The rest of the message must
#: avoid the substrings earlier buckets match (``OOM``, ``used memory >
#: 'maxmemory'``, ``mem consumption exceeded``, ``timeout``, ``ontology``,
#: ``conflict``, ``unavailable``, ``unreachable``, ``connection``).
REFUSAL_MARKER = "write budget:"


def human_bytes(n: Optional[int]) -> str:
    if n is None:
        return "?"
    value = float(n)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(value) < 1024 or unit == "TB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    return f"{value:.1f} TB"


def format_refusal(
    budget: WriteBudget, verdict: Verdict, *, graph: str, composition: str,
    from_estimate: bool = False, margin_pct: int = 0,
) -> str:
    """The failure text — the whole record of a terminal refusal, since a
    failed job persists no ``run_stats``. Every number a person needs, then
    the ways out, in the order they should try them."""
    shard = budget.shard
    bpe = f"~{budget.bytes_per_edge} B/edge ({budget.bpe_source})"
    what = (
        f"{REFUSAL_MARKER} aggregation would materialize ~{verdict.projected:,} "
        f":AGGREGATED edges ({composition}) for graph '{graph}'"
    )
    if from_estimate:
        what += f" — an upper-bound estimate, checked with a {margin_pct}% margin"
    fixes_auto = "set Rollup storage to Auto (stores the depth-diagonal instead of the full cube)"
    tail = (
        "This count is deterministic — the job is not retried. "
    )
    if verdict.blocked_by == "ceiling":
        room = (
            f"the shard {shard.endpoint} itself has {human_bytes(budget.available_bytes)} free "
            f"after the {budget.reserve_pct}% reserve"
            if budget.governed_by == "shard" else shard.why_not
        )
        return (
            f"{what}, exceeding the explicit ceiling maxMaterializedEdges="
            f"{budget.explicit_ceiling:,} set in tuning by {verdict.shortfall_edges:,} edges "
            f"({room}). {tail}"
            f"Fixes: raise or clear the ceiling in the Defaults dialog or the job's "
            f"Advanced tuning so the measured shard budget governs; or {fixes_auto}."
        )
    if verdict.blocked_by == "shard":
        return (
            f"{what}: ~{verdict.growth_edges:,} of them new, needing "
            f"{human_bytes(verdict.needed_bytes)} at {bpe}, but shard {shard.endpoint} has "
            f"{human_bytes(verdict.available_bytes)} free of {human_bytes(shard.maxmemory)} "
            f"after the {budget.reserve_pct}% reserve ({human_bytes(shard.used)} used) — "
            f"short by {human_bytes(verdict.shortfall_bytes)}. Writing it would fill the "
            f"shard, and under noeviction that fails every graph's writes on it. {tail}"
            f"Fixes: {fixes_auto}; free or add memory on that shard, or move this graph "
            f"(a dedicated projection lands on its own shard); or lower shardReservePct / "
            f"correct bytesPerEdge in tuning if you know the headroom is real."
        )
    # static: the shard could not govern, so today's count cap did.
    return (
        f"{what}, exceeding max_materialized_edges={budget.static_cap:,}. "
        f"{shard.why_not.capitalize()}, so the static cap governed instead of real "
        f"headroom — set maxmemory on the FalkorDB instance and the budget will read "
        f"the shard, or raise the cap via tuning (~{budget.bytes_per_edge} B per edge). "
        f"{tail}Fixes: {fixes_auto}; or raise maxMaterializedEdges only on an instance "
        f"with the memory to match."
    )
