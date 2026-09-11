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
from typing import Any, Dict, Optional, Sequence, Tuple

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

#: The copy-on-write allowance over RSS, in percent: what a fork may
#: duplicate while it runs. The deployment guide's ``1.25 ×`` — valid ONLY
#: because the pipeline holds its writes while a fork is in progress
#: (:func:`hold_reason`): a rebuild writing at full speed through a fork
#: dirties most of the dataset's pages, and the child then holds a second
#: copy of nearly all of it, which is the arithmetic that OOM-kills a
#: correctly sized container. With the writer paused, what gets copied is
#: what OTHER clients touch, and a quarter is generous.
FORK_COW_PCT_DEFAULT = 125
FORK_COW_PCT_LO, FORK_COW_PCT_HI = 100, 200

#: The planning figure when a node does not report its THREAD_COUNT.
#:
#: This sizes :func:`container_memory_needed`: how much container memory
#: the node needs for ``threads`` concurrent queries each allowed
#: QUERY_MEM_CAPACITY. The two directions are NOT symmetric. Guess too HIGH
#: and a guard refuses a config that would in fact have fitted —
#: conservative, and the operator sees the numbers. Guess too LOW and it
#: approves a config that OOM-kills the node under exactly the concurrency
#: it was raised to serve. So this is the LARGEST THREAD_COUNT across the
#: shipped manifests, not a typical one; ``test_thread_count_assumption.py``
#: derives the shipped values and fails if this drops below them.
THREAD_COUNT_ASSUMED = 8

#: How far behind a replica may fall before the pipeline holds, when the
#: node's own drop limits cannot be read. A quarter of the shipped replica
#: output-buffer hard limit (2 GiB) is 512 MiB; this is the floor under a
#: node that reports neither limit.
REPLICA_LAG_HOLD_BYTES_DEFAULT = 256 * 1024 ** 2


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


def fork_cow_factor() -> float:
    """``AGGREGATION_FORK_COW_PCT`` as a multiplier over RSS (1.25 default)."""
    return _env_clamped("AGGREGATION_FORK_COW_PCT", FORK_COW_PCT_DEFAULT,
                        FORK_COW_PCT_LO, FORK_COW_PCT_HI) / 100.0


def _as_float(value: Any) -> Optional[float]:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


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
    # The shard's per-query memory ceiling (``QUERY_MEM_CAPACITY``), bytes;
    # None when unlimited, unreadable, or the client cannot ask. A second,
    # separately guarded read — it never costs the memory reading.
    query_mem_capacity: Optional[int] = None
    # The node's other limits beside the ceiling, from the same guarded
    # ``GRAPH.CONFIG`` read: the per-query time cap (``TIMEOUT_MAX``, ms —
    # what every timeout knob is clamped to), its default (``TIMEOUT_DEFAULT``,
    # ms — a cap may never be set below it) and the execution width
    # (``THREAD_COUNT`` — the ceiling is charged PER THREAD, so the container
    # formula multiplies by it). None when unlimited, unreadable, or unknown.
    timeout_max_ms: Optional[int] = None
    timeout_default_ms: Optional[int] = None
    thread_count: Optional[int] = None
    # ``EFFECTS_THRESHOLD``, microseconds per modification: above it a write
    # replicates to the replicas as a compact change log, below it the
    # replicas RE-RUN the whole query on their main thread. A rollup batch
    # is thousands of cheap MERGEs, so it falls below the default (300) and
    # every replica repeats the rebuild's work — the shape that takes a
    # shard down under a large rebuild. 0 = always replicate as effects.
    effects_threshold_us: Optional[int] = None
    # Identity and liveness, read in the same round trip as the memory: a
    # changed ``run_id`` (regenerated on every start) or an uptime shorter
    # than the run itself is PROOF the node restarted mid-rebuild — the
    # evidence that was missing when a run died against a refused
    # connection and nothing could say why.
    uptime_s: Optional[int] = None
    run_id: Optional[str] = None
    loading: Optional[bool] = None
    # ── The rest of the node's picture, read in the same round trip ──────
    # What the process actually holds (``used_memory_rss``): the dataset,
    # allocator fragmentation, and whatever a fork's copy-on-write has
    # duplicated. It is RSS, not ``used_memory``, that the kernel compares
    # with the container limit when it decides to kill the process — so it
    # is RSS the container budget is measured from.
    rss: Optional[int] = None
    fragmentation_ratio: Optional[float] = None
    # A fork in flight, or one about to start: BGSAVE, an AOF rewrite, or a
    # replica full-sync (the master forks to stream it). Every write during
    # a fork costs copy-on-write memory on top of RSS, and the child lives
    # for as long as the snapshot takes to write or stream.
    bgsave_in_progress: Optional[bool] = None
    aof_rewrite_in_progress: Optional[bool] = None
    aof_rewrite_scheduled: Optional[bool] = None
    # Replication as the write node sees it: how many replicas are attached,
    # how many of those are still receiving a full sync rather than applying
    # the stream, and the most any of them still owes the stream.
    connected_replicas: Optional[int] = None
    replicas_syncing: Optional[int] = None
    replica_max_lag_bytes: Optional[int] = None
    # What replication itself holds on this node right now.
    mem_repl_buffers: Optional[int] = None
    # The two limits that decide when a replica is DROPPED — the backlog a
    # reconnecting replica can catch up through, and the output buffer past
    # which the master disconnects it. From the node's own config.
    repl_backlog_bytes: Optional[int] = None
    replica_outbuf_hard_bytes: Optional[int] = None
    # The memory limit the pod is killed at — see :func:`container_limit_bytes`.
    container_limit_bytes: Optional[int] = None

    @property
    def fork_in_progress(self) -> Optional[str]:
        """Which fork, if any — the reason a write has to wait."""
        if self.bgsave_in_progress:
            return "bgsave"
        if self.aof_rewrite_in_progress:
            return "aof_rewrite"
        if self.aof_rewrite_scheduled:
            return "aof_rewrite_scheduled"
        if (self.replicas_syncing or 0) > 0:
            return "replica_sync"
        return None

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
            **(
                {"query_mem_capacity": self.query_mem_capacity}
                if self.query_mem_capacity is not None else {}
            ),
            **(
                {"timeout_max_ms": self.timeout_max_ms}
                if self.timeout_max_ms is not None else {}
            ),
            **(
                {"thread_count": self.thread_count}
                if self.thread_count is not None else {}
            ),
            **(
                {"effects_threshold_us": self.effects_threshold_us}
                if self.effects_threshold_us is not None else {}
            ),
            **{
                name: getattr(self, name)
                for name in (
                    "rss", "fragmentation_ratio", "connected_replicas",
                    "replicas_syncing", "replica_max_lag_bytes", "mem_repl_buffers",
                    "repl_backlog_bytes", "replica_outbuf_hard_bytes",
                    "container_limit_bytes",
                )
                if getattr(self, name) is not None
            },
            **({"fork_in_progress": self.fork_in_progress} if self.fork_in_progress else {}),
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


def _parse_config_reply(
    raw: Any, name: str, *, zero_is_a_value: bool = False,
) -> Optional[int]:
    """The value of one ``GRAPH.CONFIG GET <name>`` reply, whatever shape
    the client hands back: ``[name, value]``, ``{node: [name, value]}`` from
    a cluster call, a ``{name: value}`` map, bytes for either part. ``0``
    means unlimited and reads as None, like an unreadable value."""
    def _text(v: Any) -> str:
        if isinstance(v, (bytes, bytearray)):
            return v.decode("utf-8", "replace")
        return str(v)

    value: Any = None
    if isinstance(raw, dict):
        if name in raw:
            value = raw[name]
        else:
            inner = [v for v in raw.values() if isinstance(v, (list, tuple, dict))]
            if len(inner) == 1:
                return _parse_config_reply(inner[0], name)
            for k, v in raw.items():
                if _text(k).upper() == name:
                    value = v
    elif isinstance(raw, (list, tuple)):
        if len(raw) == 2 and _text(raw[0]).upper() == name:
            value = raw[1]
        elif len(raw) == 1 and isinstance(raw[0], (list, tuple, dict)):
            return _parse_config_reply(raw[0], name)
    else:
        value = raw
    n = _as_int(value)
    if zero_is_a_value:
        return n if n is not None and n >= 0 else None
    return n if n and n > 0 else None


#: The four ``GRAPH.CONFIG`` names the reading carries, and the field each
#: lands in. ``0`` reads as None for all four (unlimited / no default).
_LIMIT_FIELDS: Tuple[Tuple[str, str], ...] = (
    ("QUERY_MEM_CAPACITY", "query_mem_capacity"),
    ("TIMEOUT_MAX", "timeout_max_ms"),
    ("TIMEOUT_DEFAULT", "timeout_default_ms"),
    ("THREAD_COUNT", "thread_count"),
    ("EFFECTS_THRESHOLD", "effects_threshold_us"),
)

#: Fields where ``0`` is a VALUE, not "unset". Every ceiling reads 0 as
#: unlimited, but ``EFFECTS_THRESHOLD 0`` is the setting that makes replicas
#: apply a change log instead of re-running each write — reading it as unset
#: would hide the one configuration that keeps replicas responsive.
_ZERO_IS_A_VALUE = frozenset({"effects_threshold_us"})


def _parse_config_all(raw: Any) -> Dict[str, Any]:
    """``GRAPH.CONFIG GET *`` as ``{NAME: value}``, whatever the client hands
    back: a list of ``[name, value]`` pairs (the server's shape), a flat
    ``[name, value, name, value]`` list, a ``{name: value}`` map, or a
    ``{node: <any of those>}`` map from a cluster call; bytes anywhere."""
    def _text(v: Any) -> str:
        if isinstance(v, (bytes, bytearray)):
            return v.decode("utf-8", "replace")
        return str(v)

    out: Dict[str, Any] = {}
    if isinstance(raw, dict):
        inner = [v for v in raw.values() if isinstance(v, (list, tuple, dict))]
        if inner and len(inner) == len(raw) and not any(
            _text(k).upper() == name for k in raw for name, _ in _LIMIT_FIELDS
        ):
            return _parse_config_all(inner[0])
        for k, v in raw.items():
            out[_text(k).upper()] = v
        return out
    if isinstance(raw, (list, tuple)):
        if raw and all(isinstance(item, (list, tuple)) and len(item) == 2 for item in raw):
            for name, value in raw:
                out[_text(name).upper()] = value
        elif len(raw) % 2 == 0:
            for i in range(0, len(raw), 2):
                out[_text(raw[i]).upper()] = raw[i + 1]
    return out


async def _graph_config(conn: Any, node: Any, *args: Any) -> Any:
    """One ``GRAPH.CONFIG`` round trip, on ``node`` in cluster mode."""
    if node is not None:
        return await conn.execute_command("GRAPH.CONFIG", *args, target_nodes=node)
    return await conn.execute_command("GRAPH.CONFIG", *args)


async def _read_config_int(
    conn: Any, node: Any, name: str, *, zero_is_a_value: bool = False,
) -> Optional[int]:
    """``GRAPH.CONFIG GET <name>`` on the owning node. Never raises."""
    try:
        raw = await _graph_config(conn, node, "GET", name)
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.info("%s unreadable: %s", name, exc)
        return None
    return _parse_config_reply(raw, name, zero_is_a_value=zero_is_a_value)


async def _read_server_limits(conn: Any, node: Any) -> Dict[str, Optional[int]]:
    """The node's own limits, keyed by :class:`ShardMemory` field: one
    ``GRAPH.CONFIG GET *`` when the node answers it, else one GET per name
    (older servers, and clients that cannot route the wildcard). Never
    raises — the memory reading must not lose to a config read."""
    found: Dict[str, Any] = {}
    try:
        found = _parse_config_all(await _graph_config(conn, node, "GET", "*"))
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.debug("GRAPH.CONFIG GET * unavailable, reading per name: %s", exc)
    if any(name in found for name, _ in _LIMIT_FIELDS):
        out: Dict[str, Optional[int]] = {}
        for name, field in _LIMIT_FIELDS:
            n = _as_int(found.get(name))
            if field in _ZERO_IS_A_VALUE:
                out[field] = n if n is not None and n >= 0 else None
            else:
                out[field] = n if n and n > 0 else None
        return out
    return {
        field: await _read_config_int(
            conn, node, name, zero_is_a_value=field in _ZERO_IS_A_VALUE,
        )
        for name, field in _LIMIT_FIELDS
    }


async def _read_query_mem_capacity(conn: Any, node: Any) -> Optional[int]:
    """``GRAPH.CONFIG GET QUERY_MEM_CAPACITY`` on the owning node. Never
    raises — the memory reading must not lose to a config read."""
    return await _read_config_int(conn, node, "QUERY_MEM_CAPACITY")


async def set_graph_config(conn: Any, node: Any, pairs: Sequence[Tuple[str, int]]) -> None:
    """``GRAPH.CONFIG SET`` each ``(name, value)`` in order on ``node`` (the
    cluster node to target; None outside cluster mode). Raises like the
    client does on the first failure — the caller names what was already
    changed. A runtime SET applies now and lasts until the server restarts;
    the launch arguments (``FALKORDB_ARGS``) make it permanent."""
    for name, value in pairs:
        await _graph_config(conn, node, "SET", name, int(value))


GIB = 1024 ** 3
MIB = 1024 ** 2


def container_memory_needed(
    maxmemory: int, concurrent: int, query_mem_capacity: int, *,
    repl_backlog_bytes: int = 0, replicas: int = 0, replica_outbuf_hard_bytes: int = 0,
) -> int:
    """The deployment guide's sizing rule, in bytes::

        1.25 × maxmemory                          dataset + fragmentation + fork COW
        + concurrent × 1.3 × QUERY_MEM_CAPACITY   in-flight queries and their reply buffers
        + repl-backlog-size                       allocated once replication is in use
        + replicas × replica-output-buffer-hard   worst case before a replica is dropped
        + overhead                                256 MiB, 1 GiB from 32 GiB

    ``concurrent`` is how many queries may hold the ceiling at once — at
    most the node's ``THREAD_COUNT``, since the ceiling is charged per
    thread. The replication terms default to zero so an unreplicated node
    (and every caller that never knew them) is unchanged; on a cluster they
    are ~5 GiB the rule used to leave out — a container that fits the
    formula and not the shard."""
    overhead = GIB if maxmemory >= 32 * GIB else 256 * MIB
    return (
        int(1.25 * maxmemory)
        + max(1, int(concurrent)) * int(1.3 * query_mem_capacity)
        + max(0, int(repl_backlog_bytes or 0))
        + max(0, int(replicas or 0)) * max(0, int(replica_outbuf_hard_bytes or 0))
        + overhead
    )


def container_limit_bytes(shard: ShardMemory, *, env_bytes: Optional[int]) -> Optional[int]:
    """The memory limit the node's pod is killed at.

    The app cannot read a cgroup limit over the wire, so the deployment
    states it (``FALKORDB_CONTAINER_MEMORY_BYTES``, checked against the
    manifests by a test). Absent that, the sizing rule evaluated at the
    node's own settings is the smallest limit a correctly sized container
    can have — a conservative stand-in, never a generous one. None when the
    node reports neither a ceiling nor a per-query cap to evaluate it with.
    """
    if env_bytes and env_bytes > 0:
        return int(env_bytes)
    maxmemory = int(shard.maxmemory or 0)
    cap = int(shard.query_mem_capacity or 0)
    if maxmemory <= 0 or cap <= 0:
        return None
    return container_memory_needed(
        maxmemory, int(shard.thread_count or THREAD_COUNT_ASSUMED), cap,
        repl_backlog_bytes=int(shard.repl_backlog_bytes or 0),
        replicas=int(shard.connected_replicas or 0),
        replica_outbuf_hard_bytes=int(shard.replica_outbuf_hard_bytes or 0),
    )


def query_reserve_bytes(shard: ShardMemory) -> int:
    """What the node's in-flight queries may hold at once: every thread at
    the per-query ceiling, plus the reply buffer the ceiling does not count."""
    cap = int(shard.query_mem_capacity or 0)
    if cap <= 0:
        return 0
    return int(shard.thread_count or THREAD_COUNT_ASSUMED) * int(1.3 * cap)


def replication_reserve_bytes(shard: ShardMemory) -> int:
    """What replication may hold before the master drops a replica: the
    backlog plus every attached replica's output buffer at its hard limit.
    Falls back to what replication holds NOW when the limits are unknown."""
    backlog = int(shard.repl_backlog_bytes or 0)
    outbuf = int(shard.replica_outbuf_hard_bytes or 0)
    if backlog or outbuf:
        return backlog + int(shard.connected_replicas or 0) * outbuf
    return int(shard.mem_repl_buffers or 0)


def container_headroom_bytes(
    shard: ShardMemory, *, held: int = 0, fork_factor: Optional[float] = None,
) -> Optional[int]:
    """Bytes of fork-exposed room left inside the container: the limit less
    ``fork_factor × RSS``, the query reserve, the replication reserve, the
    server overhead and what other rebuilds hold. Negative means the node is
    already past the line a fork could be survived at. None when the limit
    or RSS is unknown."""
    limit = shard.container_limit_bytes
    if limit is None or shard.rss is None:
        return None
    f = fork_factor if fork_factor is not None else fork_cow_factor()
    overhead = GIB if int(shard.maxmemory or 0) >= 32 * GIB else 256 * MIB
    return int(
        limit - f * shard.rss - query_reserve_bytes(shard)
        - replication_reserve_bytes(shard) - overhead - max(0, int(held or 0))
    )


def replica_lag_hold_bytes(shard: ShardMemory) -> int:
    """How far behind a replica may fall before the pipeline holds.

    Derived from the node's own drop limits: a quarter of the replica
    output-buffer hard limit (past which the master DISCONNECTS the replica)
    and half the backlog (past which a disconnected replica needs a FULL
    resync). Holding at a fraction of either keeps both events out of a
    rebuild's reach — the master dropping its own replica is how one shard's
    rebuild becomes a fork under full write load.
    ``AGGREGATION_REPLICA_LAG_HOLD_BYTES`` overrides; the floor covers a
    node that reports neither limit."""
    forced = _as_int(os.getenv("AGGREGATION_REPLICA_LAG_HOLD_BYTES"))
    if forced and forced > 0:
        return forced
    candidates = []
    if shard.replica_outbuf_hard_bytes:
        candidates.append(int(shard.replica_outbuf_hard_bytes) // 4)
    if shard.repl_backlog_bytes:
        candidates.append(int(shard.repl_backlog_bytes) // 2)
    return max(1, min(candidates)) if candidates else REPLICA_LAG_HOLD_BYTES_DEFAULT


def hold_reason(
    shard: ShardMemory, *, expected_replicas: Optional[int],
    fork_factor: Optional[float] = None, held: int = 0,
) -> Optional[Tuple[str, str]]:
    """Why a write batch must wait, as ``(kind, detail)`` — or None.

    Pure: the envelope a rebuild may write inside, decided from one reading.
    Every kind names something that is true of the NODE now and false a
    little later, which is what makes a hold the right response rather
    than a refusal:

    * ``loading`` — the node is replaying its dataset.
    * ``fork`` — BGSAVE, an AOF rewrite (running or scheduled), or a replica
      full-sync. Writing through a fork is what turns the dataset's size
      into twice the dataset's size.
    * ``replica_lost`` — fewer replicas attached than the run started with.
      A replica that vanishes during a rebuild almost always vanished
      BECAUSE of it (dropped for an overflowing output buffer); writing on
      is what makes its return a full-sync fork under load.
    * ``replica_lag`` — a replica owes the stream more than a fraction of
      the limit the master drops it at.
    * ``memory`` — RSS is already past what the container could survive a
      fork at; something has to drain before more lands.

    An unmeasured reading never holds: the store not answering is the
    outage path's business, and ignorance is not a reason to wait.
    """
    if shard.source != "measured":
        return None
    if shard.loading:
        return "loading", f"{shard.endpoint} is loading its dataset"
    fork = shard.fork_in_progress
    if fork:
        what = {
            "bgsave": "a background save",
            "aof_rewrite": "an AOF rewrite",
            "aof_rewrite_scheduled": "an AOF rewrite about to start",
            "replica_sync": f"{shard.replicas_syncing} replica(s) receiving a full resync",
        }[fork]
        return "fork", f"{what} on {shard.endpoint}"
    attached = shard.connected_replicas
    if expected_replicas and attached is not None and attached < expected_replicas:
        return "replica_lost", (
            f"{attached} of {expected_replicas} replica(s) attached to {shard.endpoint}"
        )
    lag = shard.replica_max_lag_bytes
    if lag is not None and lag >= replica_lag_hold_bytes(shard):
        return "replica_lag", (
            f"a replica of {shard.endpoint} is {human_bytes(lag)} behind "
            f"(hold threshold {human_bytes(replica_lag_hold_bytes(shard))})"
        )
    headroom = container_headroom_bytes(shard, held=held, fork_factor=fork_factor)
    if headroom is not None and headroom < 0:
        return "memory", (
            f"{shard.endpoint} holds {human_bytes(shard.rss)} RSS against a "
            f"{human_bytes(shard.container_limit_bytes)} container — "
            f"{human_bytes(-headroom)} past what a fork could be survived at"
        )
    return None


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


async def _config_get(conn: Any, node: Any, name: str) -> Dict[str, str]:
    """One Redis-level ``CONFIG GET`` on ``node`` as ``{name: value}``."""
    from backend.app.services.graph_store import info_parse

    if node is not None:
        raw = await conn.execute_command("CONFIG", "GET", name, target_nodes=node)
    else:
        raw = await conn.config_get(name)
    if isinstance(raw, dict) and raw and all(isinstance(v, dict) for v in raw.values()):
        raw = next(iter(raw.values()))          # {node: {name: value}} from a cluster call
    return info_parse.parse_config_pairs(raw)


async def _read_node_config(conn: Any, node: Any) -> Dict[str, Optional[int]]:
    """The two Redis-level settings that decide when the write node DROPS a
    replica. Never raises: a node that will not answer ``CONFIG`` (a managed
    instance, an ACL without it) reads as unknown, and the hold threshold
    falls back to its floor."""
    from backend.app.services.graph_store import info_parse

    out: Dict[str, Optional[int]] = {
        "repl_backlog_bytes": None, "replica_outbuf_hard_bytes": None,
    }
    try:
        pairs = await _config_get(conn, node, "repl-backlog-size")
        out["repl_backlog_bytes"] = info_parse.parse_memory_bytes(pairs.get("repl-backlog-size"))
        pairs = await _config_get(conn, node, "client-output-buffer-limit")
        out["replica_outbuf_hard_bytes"] = info_parse.replica_output_buffer_hard_limit(pairs)
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.debug("node config unreadable: %s", exc)
    return out


def _node_picture(info: Dict[str, Any]) -> Dict[str, Any]:
    """The fork, memory and replication fields of one parsed ``INFO``,
    keyed by :class:`ShardMemory` field."""
    from backend.app.services.graph_store import info_parse

    repl = info_parse.replication_stats(info)
    replicas = repl.get("replicas") or []
    syncing = sum(1 for r in replicas if (r.get("state") or "online") != "online")
    lags = [r["lagBytes"] for r in replicas if r.get("lagBytes") is not None]
    buffers = _as_int(info.get("mem_total_replication_buffers"))
    if buffers is None:
        parts = [_as_int(info.get("mem_clients_slaves")), _as_int(info.get("mem_replication_backlog"))]
        buffers = sum(p for p in parts if p is not None) if any(p is not None for p in parts) else None

    def _flag(name: str) -> Optional[bool]:
        n = _as_int(info.get(name))
        return bool(n) if n is not None else None

    attached = repl.get("connectedReplicas")
    return {
        "rss": _as_int(info.get("used_memory_rss")),
        "fragmentation_ratio": _as_float(info.get("mem_fragmentation_ratio")),
        "bgsave_in_progress": _flag("rdb_bgsave_in_progress"),
        "aof_rewrite_in_progress": _flag("aof_rewrite_in_progress"),
        "aof_rewrite_scheduled": _flag("aof_rewrite_scheduled"),
        "connected_replicas": attached,
        "replicas_syncing": syncing if replicas else (0 if attached == 0 else None),
        "replica_max_lag_bytes": max(lags) if lags else (0 if replicas else None),
        "mem_repl_buffers": buffers,
    }


async def read_shard_memory(
    db: Any, *, mode: Optional[str], graph_key: str, timeout: float,
    include_config: bool = True,
) -> ShardMemory:
    """``INFO memory server persistence replication`` from the shard that
    owns ``graph_key`` — through the client the pipeline already holds
    (``db.connection``: the redis client ``falkordb_over`` wrapped, already
    carrying auth, TLS and the address remap). Never raises.

    One round trip says how full the node is, whether it is the same
    process it was a minute ago, whether it is forked or about to be, and
    how its replicas are keeping up — everything the write governor holds
    on. ``include_config`` adds the two ``CONFIG GET`` round trips for the
    replica drop limits; a per-batch reading passes False and reuses the
    values the run read at its start.

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
    limits: Dict[str, Optional[int]] = {}
    try:
        async with asyncio.timeout(timeout):
            endpoint, node = await _owner(conn, mode, graph_key)
            # "memory" plus "server": the same round trip that says how full
            # the node is says whether it is the same process it was a
            # minute ago. INFO with two sections is one command.
            sections = ("memory", "server", "persistence", "replication")
            if node is not None:
                raw = await conn.execute_command("INFO", *sections, target_nodes=node)
            else:
                raw = await conn.info(*sections)
            # The node's own limits — the per-query ceiling the pressure
            # ladder narrows against, the time cap every timeout knob is
            # clamped to, the thread count the container formula needs —
            # read beside the memory so run_stats, the capacity view and the
            # provider's clamp can name them. Their own guard: a failure
            # here costs nothing above.
            limits = await _read_server_limits(conn, node)
            node_cfg = await _read_node_config(conn, node) if include_config else {}
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.info("shard memory for %r via %s unavailable: %s",
                    graph_key, endpoint, exc)
        return ShardMemory(endpoint, None, None, None, now, "unavailable",
                           type(exc).__name__)
    info = _parse_info(raw)
    used = _as_int(info.get("used_memory"))
    maxmemory = _as_int(info.get("maxmemory"))
    policy = info.get("maxmemory_policy")
    liveness = {
        "uptime_s": _as_int(info.get("uptime_in_seconds")),
        "run_id": info.get("run_id") or None,
        "loading": bool(_as_int(info.get("loading"))) if info.get("loading") is not None else None,
    }
    picture = {**_node_picture(info), **node_cfg}
    if used is None:
        return ShardMemory(endpoint, None, maxmemory, policy, now, "unavailable",
                           "no used_memory in INFO", **limits, **liveness, **picture)
    return ShardMemory(endpoint, used, maxmemory or 0,
                       str(policy) if policy is not None else None, now, "measured",
                       None, **limits, **liveness, **picture)


async def read_query_mem_capacity(
    db: Any, *, mode: Optional[str], graph_key: str, timeout: float,
) -> Optional[int]:
    """Only the per-query ceiling of the shard that owns ``graph_key``, for
    callers that already hold a memory reading. Never raises."""
    conn = getattr(db, "connection", None)
    if conn is None:
        return None
    try:
        async with asyncio.timeout(timeout):
            _endpoint, node = await _owner(conn, mode, graph_key, refresh=False)
            return await _read_query_mem_capacity(conn, node)
    except Exception as exc:                          # noqa: BLE001 — by contract
        logger.info("QUERY_MEM_CAPACITY for %r unknown: %s", graph_key, exc)
        return None


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
    # What OTHER rebuilds hold in the node's reservation ledger — allowed
    # to write, not yet in ``used`` — already taken off ``available_bytes``.
    reserved_bytes: int = 0
    reserved_by_jobs: int = 0
    # The container behind the shard, when it could be resolved: its limit,
    # the fork-exposed room left inside it, and the growth that room allows.
    # ``governed_by == "container"`` when that is the tighter of the two
    # ceilings — the rule that stands between a rebuild and the OOM killer,
    # where ``maxmemory`` only stands between it and a refused write.
    container_limit: Optional[int] = None
    container_headroom: Optional[int] = None
    allowed_growth_by_container: Optional[int] = None

    def verdict(self, *, projected: int, growth_edges: int, margin_pct: int = 0) -> Verdict:
        """May ``growth_edges`` new edges land, as part of ``projected`` in
        total? ``margin_pct`` widens the allowance (shard or static) for an
        upper-bound estimate; it never widens an explicit ceiling."""
        growth = max(0, int(growth_edges))
        if self.explicit_ceiling is not None and projected > self.explicit_ceiling:
            return Verdict(False, "ceiling", projected, growth,
                           growth * self.bytes_per_edge, self.available_bytes, None,
                           projected - self.explicit_ceiling)
        if self.governed_by in ("shard", "container"):
            needed = growth * self.bytes_per_edge
            available = self.available_bytes or 0
            allowance = available * (100 + max(0, margin_pct)) // 100
            if needed > allowance:
                short = needed - available
                return Verdict(False, self.governed_by, projected, growth, needed, available,
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
            "reserved_bytes": self.reserved_bytes,
            "reserved_by_jobs": self.reserved_by_jobs,
            **({"container_limit": self.container_limit} if self.container_limit is not None else {}),
            **({"container_headroom": self.container_headroom} if self.container_headroom is not None else {}),
            **(
                {"allowed_growth_by_container": self.allowed_growth_by_container}
                if self.allowed_growth_by_container is not None else {}
            ),
            "shard": self.shard.as_stats(),
        }


def compute_write_budget(
    shard: ShardMemory, *,
    reserve_pct: Optional[int],
    bytes_per_edge: Optional[int],
    bpe_source: str,
    explicit_ceiling: Optional[int],
    static_cap: int,
    reserved_bytes: int = 0,
    reserved_count: int = 0,
    fork_factor: Optional[float] = None,
) -> WriteBudget:
    """Pure. ``reserve_pct`` / ``bytes_per_edge`` are the RESOLVED operator
    values (``None`` → env default); ``explicit_ceiling`` is present only
    when tuning set it; ``static_cap`` is the fallback count rule.
    ``reserved_bytes`` is what ``reserved_count`` other rebuilds hold in
    the node's ledger — allowed to write, not yet in ``used`` — and comes
    off the free memory exactly as used memory does.

    Two ceilings when the reading carries a container limit. ``maxmemory``
    less the reserve is where writes start being REFUSED; the container
    less ``fork_factor × RSS``, the query and replication reserves and the
    overhead is where the node is KILLED the next time it forks. Growth is
    allowed up to the lower of the two, and growth itself is fork-exposed,
    so the container's room is divided by the factor before it becomes an
    allowance."""
    reserve = (shard_reserve_pct_default() if reserve_pct is None
               else _clamp(reserve_pct, RESERVE_PCT_LO, RESERVE_PCT_HI, RESERVE_PCT_DEFAULT))
    bpe = (bytes_per_edge_default() if bytes_per_edge is None
           else _clamp(bytes_per_edge, BYTES_PER_EDGE_LO, BYTES_PER_EDGE_HI,
                       BYTES_PER_EDGE_DEFAULT))
    held = max(0, int(reserved_bytes or 0))
    holders = max(0, int(reserved_count or 0))
    if shard.measurable:
        maxmemory = int(shard.maxmemory or 0)
        reserve_bytes = maxmemory * reserve // 100
        by_maxmemory = max(0, maxmemory - reserve_bytes - int(shard.used or 0) - held)
        governed, available = "shard", by_maxmemory
        headroom = container_headroom_bytes(shard, held=held, fork_factor=fork_factor)
        by_container: Optional[int] = None
        if headroom is not None:
            f = fork_factor if fork_factor is not None else fork_cow_factor()
            by_container = max(0, int(headroom / f))
            if by_container < by_maxmemory:
                governed, available = "container", by_container
        return WriteBudget(
            shard=shard, governed_by=governed, bytes_per_edge=bpe, bpe_source=bpe_source,
            reserve_pct=reserve, reserve_bytes=reserve_bytes, available_bytes=available,
            allowed_growth_edges=available // bpe, explicit_ceiling=explicit_ceiling,
            static_cap=static_cap, reserved_bytes=held, reserved_by_jobs=holders,
            container_limit=shard.container_limit_bytes, container_headroom=headroom,
            allowed_growth_by_container=by_container,
        )
    return WriteBudget(
        shard=shard, governed_by="static", bytes_per_edge=bpe, bpe_source=bpe_source,
        reserve_pct=reserve, reserve_bytes=None, available_bytes=None,
        allowed_growth_edges=None, explicit_ceiling=explicit_ceiling, static_cap=static_cap,
        reserved_bytes=held, reserved_by_jobs=holders,
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
        # Words chosen to hit no earlier classify_failure bucket.
        held = (
            f", {human_bytes(budget.reserved_bytes)} held by {budget.reserved_by_jobs} other "
            f"rebuild{'s' if budget.reserved_by_jobs != 1 else ''} still writing"
            if budget.reserved_by_jobs else ""
        )
        return (
            f"{what}: ~{verdict.growth_edges:,} of them new, needing "
            f"{human_bytes(verdict.needed_bytes)} at {bpe}, but shard {shard.endpoint} has "
            f"{human_bytes(verdict.available_bytes)} free of {human_bytes(shard.maxmemory)} "
            f"after the {budget.reserve_pct}% reserve ({human_bytes(shard.used)} used{held}) — "
            f"short by {human_bytes(verdict.shortfall_bytes)}. Writing it would fill the "
            f"shard, and under noeviction that fails every graph's writes on it. {tail}"
            f"Fixes: {fixes_auto}; free or add memory on that shard, or move this graph "
            f"(a dedicated projection lands on its own shard); or lower shardReservePct / "
            f"correct bytesPerEdge in tuning if you know the headroom is real."
        )
    if verdict.blocked_by == "container":
        f = fork_cow_factor()
        return (
            f"{what}: ~{verdict.growth_edges:,} of them new, needing "
            f"{human_bytes(verdict.needed_bytes)} at {bpe}, but the container behind shard "
            f"{shard.endpoint} has {human_bytes(verdict.available_bytes)} of fork-safe room "
            f"left: it holds {human_bytes(shard.rss)} resident against a "
            f"{human_bytes(budget.container_limit)} limit, a fork copies up to "
            f"{int(round((f - 1) * 100))}% of that on top, and {human_bytes(query_reserve_bytes(shard))} "
            f"of query memory plus {human_bytes(replication_reserve_bytes(shard))} of replication "
            f"buffers sit beside it — short by {human_bytes(verdict.shortfall_bytes)}. "
            f"Writing it would not fill maxmemory; it would put the node past the size the "
            f"kernel can hold through its next background save, AOF rewrite or replica "
            f"full-sync, and that ends the shard and its replicas for the length of an AOF "
            f"replay. {tail}"
            f"Fixes: {fixes_auto}; grow the container to the sizing rule in "
            f"FALKORDB_DEPLOYMENT.md (the replication terms included) or move this graph "
            f"(a dedicated projection lands on its own shard); or lower AGGREGATION_FORK_COW_PCT "
            f"only on a node you know never forks under load."
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
