"""FalkorDB :AGGREGATED edge materialization pipeline.

Single, resumable materialization strategy: EXTRACT → COMPUTE → RECONCILE
→ APPLY. Replaces the three legacy strategies (wipe-first bulk rebuild,
epoch-swept streaming rebuild, cursor-paged MERGE loop).

Design principles
-----------------
* **FalkorDB is a serving store, not a compute engine.** The aggregation
  is a pure function of two small relations — containment ``(child,
  parent)`` and lineage ``(src, tgt, type)`` — extracted once with cheap
  read-only ID-range scans and aggregated entirely in worker memory.
  Ancestor chains are dict walks, not variable-length-path Cypher.
* **Write only the diff.** The current :AGGREGATED set is scanned once,
  stale edges are deleted precisely, changed edges are updated in place,
  and only missing edges are created. A re-run after a small source
  change performs near-zero writes. There is no epoch bookkeeping and no
  destructive end-of-run sweep: a failed run never deletes good edges.
* **Resume is restart-from-zero for the cheap phases.** EXTRACT/COMPUTE
  are deterministic and take minutes, so their checkpoint is simply
  "re-run me"; only RECONCILE (range cursor) and APPLY (sorted-key
  cursor) resume positionally. The first checkpoint always persists a
  parseable ``v3:`` cursor — a NULL cursor can no longer cause the
  wipe-and-restart failure mode of the v2 streaming path.

Semantics contract (ontology-driven, unchanged from the legacy paths)
---------------------------------------------------------------------
Given a containment hierarchy ``Domain ⊃ Application ⊃ Database ⊃ Table
⊃ Column``, a lineage edge from column A to column B produces AGGREGATED
edges for the full cross-product of both ancestor chains (column→table,
table→table, table→database, domain→domain, …), each weighted by the
number of underlying lineage edges, with ``sourceLevel``/``targetLevel``
stamped from the ontology's entity-type levels. Containment and lineage
edge types are the ontology-frozen sets carried on the job row. Ragged
hierarchies and multi-parent nodes follow the legacy longest-chain rule.

**Level-based materialization boundary (the scale contract):** only
CANONICAL LEVEL-BRIDGED pairs are materialized: for each raw lineage
edge and each ontology level L, the pair of each side's deepest
non-leaf ancestor at level ≤ L. On aligned chains that is exactly the
same-level diagonal (table→table, database→database, domain→domain);
on RAGGED chains (a column hanging directly under a domain, skipping
levels) it is the mixed-level cell the canvas shows at that granularity
(table→domain) — the cell a pure level-equality filter would silently
drop. Cross-level raw lineage falls out of the same rule. Each raw
edge contributes at most ONE pair per level, and the per-level sets
shrink monotonically going up (a quotient graph per level) — the
minimal spanning set. Everything else is served ON DEMAND by
``get_aggregated_edges_between``, bounded by the requested visible set:
leaf-involving pairs (column→table, column→domain, column→column:
edges × depth if stored — the 5.6M-pair OOM) from raw lineage fan-out
+ upward containment walks, and mixed-level container pairs whose cell
is not directly canonical from the finer endpoint's materialized cells
+ a strict upward walk (the read path ADDS the disjoint stored and
derived portions — exact weights even on doubly-ragged graphs). Same
answers, same response shape; the graph stops storing millions of
precomputed answers. ``AGGREGATION_MATERIALIZE_FINE_PAIRS`` restores
the legacy full cube (guarded by the write budget); jobs without an
ontology level map fall back to it automatically.

Cursor format
-------------
``v3:{run_start_ms}:{phase}:{pos}`` with phases:

* ``aggregate`` — extract+compute in progress; ``pos`` = edges scanned
  (diagnostic only; resume restarts the phase).
* ``reconcile`` — scanning current AGGREGATED edges; ``pos`` = the next
  ID-range lower bound to scan.
* ``apply`` — creating missing edges; ``pos`` = last applied packed pair
  key (progress display only: resume re-runs RECONCILE, whose rebuilt
  ``existing`` set already excludes everything the prior attempt wrote —
  fast-forwarding past ``pos`` would skip pairs that are new since then).

``run_start_ms`` is minted once per logical run and survives resume: it
is the ``latestUpdate`` guard that protects edges written during the run
(by this run's own overflow flushes, a prior attempt of the same run, or
``on_lineage_edge_written``) from the reconcile delete pass.
"""

from __future__ import annotations

import asyncio
import logging
import os
import random
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

from backend.app.providers.process_memory import MemoryGauge
from backend.app.providers.shard_capacity import (
    ShardMemory, WriteBudget, bytes_per_edge_default, calibrate_bytes_per_edge,
    compute_write_budget, estimate_margin_pct_default, format_refusal,
    human_bytes, read_shard_memory, shard_reserve_pct_default,
)
from backend.common.providers.identity import (
    node_identity_expr as _shared_identity_expr,
)
from backend.common.providers.pair_rules import (
    ancestor_closure,
    boundary_pairs,
    cube_pairs,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Tunables (env-overridable; defaults sized for 2M+ node / 5M+ edge graphs)
# ---------------------------------------------------------------------------

def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(lo, min(hi, int(raw)))
    except (TypeError, ValueError):
        logger.warning("%s=%r is not an integer; using default %d", name, raw, default)
        return default


def _env_float(name: str, default: float, lo: float, hi: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return max(lo, min(hi, float(raw)))
    except (TypeError, ValueError):
        logger.warning("%s=%r is not a float; using default %.2f", name, raw, default)
        return default


def _scan_range_width() -> int:
    """Fixed ID-range width for edge scans. Wider = fewer queries but
    larger result payloads; 200k rows of 2-3 ints is a few MB."""
    return _env_int("AGGREGATION_SCAN_RANGE_WIDTH", 200_000, 10_000, 5_000_000)


def _max_pending_pairs() -> int:
    """Count cap on the in-worker pair accumulator AND the raw-pair base
    map. Crossing it triggers a lattice roll-up (base) or an early flush
    to the graph (accumulator) — memory stays bounded on pathological
    graphs at the cost of extra writes.

    Default 50M keeps every graph up to that size on the flush-free diff
    path: overflow is exact but costs extra write round-trips, and the
    target scale (1M nodes / 2M edges → ~3-4M boundary pairs) never comes
    close to the cap. The cap is the FLUSH-FREE ceiling, not the memory
    wall: under a cgroup limit the memory-aware flush
    (``AGGREGATION_FLUSH_MEM_PCT``, ``_memory_pressure``) flushes the
    accumulator when the worker's RSS crosses that share of the limit,
    however many pairs it holds, so a graph that produces more pairs than
    the worker can hold flushes instead of OOM-killing the pod."""
    return _env_int("AGGREGATION_MAX_PENDING_PAIRS", 50_000_000, 50_000, 50_000_000)


def _flush_mem_pct() -> int:
    """Share of the worker's cgroup memory limit at which the pipeline
    flushes its accumulator early — the memory-aware flush. Read only when
    both the RSS and the limit are known (fail-open otherwise: the pair cap
    still bounds memory). Fleet-wide as ``flushMemPct``."""
    return _env_int("AGGREGATION_FLUSH_MEM_PCT", 60, 30, 90)


def _flush_min_pairs() -> int:
    """How many pairs the accumulator must hold before a memory-aware flush
    may fire: a worker whose RSS is high for another reason (a large base
    map, a neighbour job in the same process) must not flush a handful of
    pairs over and over."""
    return _env_int("AGGREGATION_FLUSH_MIN_PAIRS", 100_000, 10_000, 50_000_000)


def _replica_ack_min() -> int:
    """How many replicas of the node the rollups land on must acknowledge a
    write batch before the pipeline sends the next one.

    This is the backpressure that keeps a rebuild from taking a shard down.
    FalkorDB replicates a write below ``EFFECTS_THRESHOLD`` by having every
    replica RE-RUN the query — on the replica's main thread, with no
    timeout — so a rebuild that paces itself only against the master's
    latency can run the replicas into their output buffers, a full resync,
    and a health probe that kills a node busy applying. Waiting for the
    acknowledgement makes the replicas' real capacity the write rate.

    0 disables the wait (a deployment with no replicas, or one that
    deliberately lets them fall behind). Fleet-wide and per job as
    ``replicaAckMin``; raisable and lowerable on a RUNNING job."""
    return _env_int("AGGREGATION_REPLICA_ACK_MIN", 1, 0, 5)


def _replica_ack_timeout_ms() -> int:
    """How long one acknowledgement wait may block before the pipeline
    treats the replicas as behind and holds. Not a failure — the hold
    heartbeats, re-reads the replication state and tries again."""
    return _env_int("AGGREGATION_REPLICA_ACK_TIMEOUT_MS", 5_000, 500, 60_000)


def _store_outage_hold_s() -> int:
    """How long one run waits out a graph store node that is not answering
    before it gives up and keeps its checkpoint.

    A node that goes away mid-rebuild — an OOM kill, a health-probe
    restart, a drained pod, a failover — used to end the attempt at once:
    a refused connection was not "pressure", so it flew past the ladder and
    the job burned a retry re-running EXTRACT from zero. Waiting is almost
    always right: the node comes back (a full AOF replay of a large shard
    is minutes), the run reconnects to it or to the replica promoted in its
    place, and carries on from where it was."""
    return _env_int("AGGREGATION_STORE_OUTAGE_HOLD_S", 900, 30, 7_200)


def _delete_chunk() -> int:
    return _env_int("AGGREGATION_DELETE_CHUNK", 10_000, 100, 50_000)


def _apply_chunk() -> int:
    return _env_int("AGGREGATION_APPLY_CHUNK", 20_000, 1_000, 200_000)


def _pacing_ratio() -> float:
    """Sleep between write sub-batches for ``last_batch_duration × ratio``
    — bounds this job's FalkorDB write duty cycle, leaving query threads
    for interactive readers. Higher = GENTLER (and slower): 1.0 → ≤ ~50%
    duty cycle, 0.5 → ≤ ~66%, 0.0 → no sleep at all."""
    return _env_float("AGGREGATION_WRITE_PACING_RATIO", 1.0, 0.0, 10.0)


def _read_pressure_pacing_ratio() -> float:
    """Pacing ratio used INSTEAD of ``AGGREGATION_WRITE_PACING_RATIO`` while
    the web tier reports interactive reads starving on this endpoint (see
    ``services/aggregation/read_pressure.py``): 4.0 → ≤ ~20% write duty
    cycle, leaving the server's query threads to readers. The larger of the
    two ratios wins, so this can only make a job gentler."""
    return _env_float("AGGREGATION_READ_PRESSURE_PACING_RATIO", 4.0, 0.0, 20.0)


def _scan_timeout_s() -> float:
    return _env_float("FALKORDB_SCAN_RANGE_TIMEOUT", 30.0, 5.0, 600.0)


def _node_identity_expr(identity_property: Optional[str]) -> str:
    """Cypher expression for a node's canonical identity, bound to the ``n``
    variable this module's directory scans use.

    Thin alias over :func:`backend.common.providers.identity.node_identity_expr`
    — shared with the read path so the aggregation directory and a canvas read
    can never resolve a node's identity differently. It does NOT fix the
    AGGREGATED write (which MERGEs on the ``urn`` PROPERTY and cannot key on a
    coalesce expression); ``stamp_identity_urns`` is what makes writes attach.
    """
    return _shared_identity_expr(identity_property, "n")


def _extract_concurrency() -> int:
    """Concurrent read-only range scans (extract/reconcile/node directory).
    Bounded well below the server's THREAD_COUNT so interactive readers
    always have query threads. Default 1 (serial) is the gentlest setting
    — raise it toward the ceiling of 4 to shorten EXTRACT on large graphs
    at the cost of provider load."""
    return _env_int("AGGREGATION_EXTRACT_CONCURRENCY", 1, 1, 4)


def _scan_shrink_floor() -> int:
    """Narrowest ID-range width the pressure ladder descends to. Default 1:
    the ladder keeps halving until a single row is all a query reads, so
    "too large for the per-query ceiling" is only ever said of ONE row. A
    higher floor stops the descent early (faster failure, less certainty);
    per job it is the ``scanShrinkFloor`` tuning knob."""
    return _env_int("AGGREGATION_SCAN_SHRINK_FLOOR", 1, 1, 5_000_000)


def _scan_timeout_retries() -> int:
    """How many times a floor-width scan that keeps timing out is re-issued
    (with exponential backoff and heartbeats) before the run gives up and
    reports a graph-store outage. 0 = give up at once."""
    return _env_int("AGGREGATION_SCAN_TIMEOUT_RETRIES", 6, 0, 20)


def _reconcile_keys_only_width() -> int:
    """Width at or below which a RECONCILE scan under pressure switches to
    the keys-only strategy (two passes: a light key projection, then an
    index seek for the desired keys) instead of halving further. Key rows
    are ~10x lighter than the 11-column projection, so the width can stay
    where it is."""
    return _env_int("AGGREGATION_RECONCILE_KEYS_ONLY_WIDTH", 5_000, 1, 5_000_000)


def _write_timeout_s() -> float:
    """Per-query budget for the pipeline's write and delete queries; the
    same env the provider's bulk-CREATE timeout reads, but the pipeline
    allows up to 600s because the server clamps every query at its own
    ``TIMEOUT_MAX`` anyway (``FALKORDB_SERVER_TIMEOUT_MAX_MS``)."""
    return _env_float("FALKORDB_BULK_CREATE_TIMEOUT_S", 60.0, 5.0, 600.0)


def _stall_timeout_secs() -> int:
    """The worker's no-forward-progress window, read here only so the
    settings API can report it beside the other knobs (the worker keeps its
    own reader as the final fallback). Per job: ``timeoutSecs`` on the job,
    then the ``stallTimeoutSecs`` tuning knob, then this env."""
    return _env_int("AGGREGATION_STALL_TIMEOUT_SECS", 10_800, 60, 604_800)


def _max_wall_secs() -> int:
    """The worker's wall-clock safety net, mirrored here for the settings
    API like ``_stall_timeout_secs``. Never lower than the job's stall
    window. Per job: the ``maxWallSecs`` tuning knob."""
    return _env_int("AGGREGATION_JOB_MAX_WALL_SECS", 86_400, 3_600, 604_800)


def _materialize_leaf_pairs() -> bool:
    return os.getenv(
        "AGGREGATION_MATERIALIZE_LEAF_PAIRS", "false"
    ).strip().lower() in ("1", "true", "yes", "on")


def _materialize_fine_pairs_mode() -> str:
    """FULL-CUBE materialization mode: EVERY ancestor-pair combination
    (leaf→table, table→table, column→domain, …) physically stored.

    ``true`` (default): always store the full cube, so the canvas answers
    at EVERY granularity from storage alone and no drill can come back
    thin — including on self-nesting types, where boundary mode's
    on-demand reader still reasons in ontology type levels and can return
    incomplete mixed-granularity answers.

    ``auto``: ESTIMATE the cube volume up front (one counting pass over
    the raw edges using the ancestor walks the run already performs) and
    store the full cube only while the estimate fits
    ``AGGREGATION_MAX_CUBE_EDGES``. Above the ceiling it falls back to
    the structural depth-diagonal + on-demand reads (the scale mode; the
    cube scales as edges × depth² and OOM'd real instances: 1.17M edges
    → 5.6M pairs). ``false`` forces the diagonal.

    THE COST OF THE DEFAULT, stated plainly: a FORCED cube skips the
    estimate entirely (see ``_decide_materialization_mode``), so a graph
    whose cube exceeds ``AGGREGATION_MAX_MATERIALIZED_EDGES`` is not
    refused up front — it fails terminally mid-apply, leaving a partial
    cube over the previous generation's cells because the reconcile
    delete pass never runs. ``auto`` can never pick a cube that exceeds
    the budget and is the mode that degrades instead of failing. Operators
    move a fleet back to it from Ingestion → Freshness → Automation
    (③ Act → Advanced) without a redeploy, or by setting this env var.
    """
    raw = os.getenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "true").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return "true"
    if raw in ("0", "false", "no", "off"):
        return "false"
    return "auto"


#: Upper bound on the explicit edge ceiling. A 256GB shard holds ~400M edges
#: at 512 B each; the old 50M bound was a wall an operator with the memory
#: could not get past.
_MAX_EDGES_BOUND = 500_000_000


def _max_materialized_edges() -> int:
    """Hard write budget: the pipeline refuses (fails the job loudly with
    guidance) rather than writing more :AGGREGATED edges than this into
    the shared FalkorDB instance. The materialized result lives in
    FalkorDB's RAM at ~0.5KB/edge — exceeding the instance's memory
    kills it for every graph it hosts.

    Default 25M ≈ 12.5GB at 0.5KB/edge. Sized against ONE SHARD, because a
    FalkorDB graph key lives entirely on one node — Redis Cluster does not
    split a graph, so sharding scales the NUMBER of graphs, not the size
    of any one (see ``falkordb_connection`` module docstring). The
    reference cluster runs ``maxmemory 40gb`` per shard at ~22GB planned
    usage, so ~18GB of headroom; this budget claims ~70% of that.

    Boundary pairs run ~1.5-2x raw edge count, so 25M covers a graph of
    roughly 12-16M edges — 6-8x the 1M-node / 2M-edge floor the defaults
    target, which is the point: that floor is a MINIMUM, not the ceiling.

    NOTE this is ABOVE the ~8GB "largest single graph" figure in
    ``docs/INFRASTRUCTURE_LAUNCH_SCALE.md`` §2.2, and that doc's headroom
    covers skew + largest graph + growth together. Because keyslot
    placement is not load-aware, two graphs near this budget landing on
    one shard is the case that gets tight — watch per-shard
    ``used_memory`` and rebalance by moving a graph, per that doc.

    It is a backstop, not a sizing guard: it exists so a pathological
    result fails LOUDLY here rather than filling the shard. That matters
    more on a cluster than standalone — ``noeviction`` at the shard cap
    fails writes for every graph on that shard, and with
    ``cluster-require-full-coverage no`` the rest of the cluster keeps
    serving, so it degrades partially instead of obviously. It is now the
    FALLBACK rule: when the owning shard can be measured, the shard's real
    headroom governs (see ``shard_capacity``) and this count applies only
    as an explicit ceiling set in tuning."""
    return _env_int("AGGREGATION_MAX_MATERIALIZED_EDGES", 25_000_000, 10_000, _MAX_EDGES_BOUND)


def _max_cube_edges() -> int:
    """Ceiling on the AUTO-mode full-cube estimate — deliberately separate
    from ``_max_materialized_edges``.

    Auto mode stores the full cube when its estimate fits, and the cube
    scales as edges × depth² (observed: 1.17M edges → 5.6M pairs → OOM).
    Sharing the write budget would mean raising that backstop silently
    flipped auto into full-cube for nearly every real graph — turning
    "Auto" into "Always full detail". This knob keeps the cube decision
    pinned to what the owning SHARD can actually hold (~8M edges ≈ 4GB at
    0.5KB/edge) while the write budget stays a runaway backstop. Keep it
    strictly below ``_max_materialized_edges`` — a cube the write budget
    would reject should never be selected in the first place (the run
    warns when a Defaults value sits above an explicit ceiling). Fleet-wide
    from the Defaults dialog as ``maxCubeEdges``; this is the env default."""
    return _env_int("AGGREGATION_MAX_CUBE_EDGES", 8_000_000, 10_000, 50_000_000)


def _budget_recheck_edges() -> int:
    """How many first-touch edges APPLY writes between re-reads of the
    owning shard. The post-compute check answered for the whole result at
    one instant; a shard shared with another graph's rebuild can fill up
    while a multi-million-edge apply is still landing, and under
    ``noeviction`` the write that fills it fails every graph's writes on
    that shard. Re-measuring every N edges turns that into a loud refusal
    a person can resume from the cursor once memory is freed."""
    return _env_int("AGGREGATION_BUDGET_RECHECK_EDGES", 1_000_000, 100_000, 100_000_000)


def env_tuning_defaults() -> Dict[str, Any]:
    """Every tuning knob's ENV-resolved default, read live and keyed the way
    ``tuning_json`` stores them — so the settings API can tell the editors
    what "empty" really means instead of each editor hard-coding a guess.
    ``estimate_margin_pct``, ``max_cube_edges``, ``budget_recheck_edges``,
    ``scan_timeout_retries``, ``reconcile_keys_only_width``,
    ``server_timeout_max_ms`` and ``flush_min_pairs`` are information only:
    env-only, shown, never settable through ``AggregationTuning``."""
    from backend.app.config import resilience
    return {
        "scan_range_width": _scan_range_width(),
        "max_pending_pairs": _max_pending_pairs(),
        "apply_chunk": _apply_chunk(),
        "delete_chunk": _delete_chunk(),
        "write_pacing_ratio": _pacing_ratio(),
        "extract_concurrency": _extract_concurrency(),
        "materialize_leaf_pairs": _materialize_leaf_pairs(),
        "materialize_fine_pairs": _materialize_fine_pairs_mode(),
        "max_materialized_edges": _max_materialized_edges(),
        "shard_reserve_pct": shard_reserve_pct_default(),
        "bytes_per_edge": bytes_per_edge_default(),
        "scan_shrink_floor": _scan_shrink_floor(),
        "scan_timeout_s": _scan_timeout_s(),
        "write_timeout_s": _write_timeout_s(),
        "stall_timeout_secs": _stall_timeout_secs(),
        "max_wall_secs": _max_wall_secs(),
        "ignore_observed": False,
        "estimate_margin_pct": estimate_margin_pct_default(),
        "max_cube_edges": _max_cube_edges(),
        "budget_recheck_edges": _budget_recheck_edges(),
        "scan_timeout_retries": _scan_timeout_retries(),
        "reconcile_keys_only_width": _reconcile_keys_only_width(),
        "server_timeout_max_ms": int(resilience.FALKORDB_SERVER_TIMEOUT_MAX_MS),
        "flush_mem_pct": _flush_mem_pct(),
        "replica_ack_min": _replica_ack_min(),
        "replica_ack_timeout_ms": _replica_ack_timeout_ms(),
        "flush_min_pairs": _flush_min_pairs(),
    }


def resolve_effective_tuning(
    tuning: Optional[Dict[str, Any]], hints: Optional[Dict[str, Any]], *,
    bulk_timeout_default: float = 60.0,
) -> Tuple[Dict[str, Any], Dict[str, str]]:
    """Every knob's value for a run and where each came from —
    ``"job"`` (the frozen tuning), ``"hint"`` (what a previous run of the
    same source measured; bytes per edge only), or ``"env"``. Resolves
    exactly as the pipeline's own readers do (same bounds, same env
    fallbacks), so the record a run leaves in ``run_stats`` is what it
    actually ran with. Pure; also used by tests to pin the parity."""
    t = dict(tuning or {})
    h = dict(hints or {})
    values: Dict[str, Any] = {}
    sources: Dict[str, str] = {}

    def _num(name: str, env_default: Callable[[], Any], lo: Any, hi: Any, cast: Callable) -> None:
        raw = t.get(name)
        if raw is None:
            values[name], sources[name] = env_default(), "env"
            return
        try:
            values[name], sources[name] = max(lo, min(hi, cast(raw))), "job"
        except (TypeError, ValueError):
            values[name], sources[name] = env_default(), "env"

    _num("scan_range_width", _scan_range_width, 10_000, 5_000_000, int)
    _num("max_pending_pairs", _max_pending_pairs, 50_000, 50_000_000, int)
    _num("apply_chunk", _apply_chunk, 1_000, 200_000, int)
    _num("delete_chunk", _delete_chunk, 100, 50_000, int)
    _num("write_pacing_ratio", _pacing_ratio, 0.0, 10.0, float)
    _num("extract_concurrency", _extract_concurrency, 1, 4, int)
    _num("shard_reserve_pct", shard_reserve_pct_default, 0, 90, int)
    _num("scan_shrink_floor", _scan_shrink_floor, 1, 5_000_000, int)
    _num("scan_timeout_s", _scan_timeout_s, 5.0, 600.0, float)
    _num("write_timeout_s", lambda: float(bulk_timeout_default), 5.0, 600.0, float)
    _num("flush_mem_pct", _flush_mem_pct, 30, 90, int)
    _num("max_cube_edges", _max_cube_edges, 10_000, 50_000_000, int)
    _num("replica_ack_min", _replica_ack_min, 0, 5, int)
    _num("replica_ack_timeout_ms", _replica_ack_timeout_ms, 500, 60_000, int)
    _num("estimate_margin_pct", estimate_margin_pct_default, 0, 100, int)
    values["scan_shrink_floor"] = min(values["scan_shrink_floor"], values["scan_range_width"])

    for name, env_default in (
        ("materialize_leaf_pairs", _materialize_leaf_pairs),
        ("ignore_observed", lambda: False),
    ):
        raw = t.get(name)
        values[name], sources[name] = (bool(raw), "job") if raw is not None else (env_default(), "env")

    raw_fine = t.get("materialize_fine_pairs")
    if raw_fine is None:
        values["materialize_fine_pairs"], sources["materialize_fine_pairs"] = (
            _materialize_fine_pairs_mode(), "env",
        )
    elif isinstance(raw_fine, str) and raw_fine.strip().lower() == "auto":
        values["materialize_fine_pairs"], sources["materialize_fine_pairs"] = "auto", "job"
    else:
        values["materialize_fine_pairs"] = "true" if raw_fine else "false"
        sources["materialize_fine_pairs"] = "job"

    raw_cap = t.get("max_materialized_edges")
    try:
        cap = int(raw_cap) if raw_cap is not None else None
    except (TypeError, ValueError):
        cap = None
    # None = no explicit ceiling: the measured shard governs (the env count
    # cap applies only when the shard cannot be measured).
    values["max_materialized_edges"], sources["max_materialized_edges"] = (
        (cap, "job") if cap else (None, "env")
    )

    raw_bpe = t.get("bytes_per_edge")
    hint_bpe = h.get("bytes_per_edge_observed")
    if raw_bpe is not None:
        values["bytes_per_edge"], sources["bytes_per_edge"] = int(raw_bpe), "job"
    elif hint_bpe:
        values["bytes_per_edge"], sources["bytes_per_edge"] = int(hint_bpe), "hint"
    else:
        values["bytes_per_edge"], sources["bytes_per_edge"] = bytes_per_edge_default(), "env"
    return values, sources


class MaterializationBudgetExceeded(ValueError):
    """The result would not fit the owning shard's headroom — or, when the
    shard cannot be measured, exceeds ``max_materialized_edges``.

    Deterministic: recomputing yields the same count, so the worker must
    fail the job terminally instead of consuming its retry budget."""


class MaterializationPreconditionFailed(ValueError):
    """Graph/ontology state makes materialization impossible in a way a
    retry cannot fix (e.g. the graph has content but no node matches any
    non-leaf ontology label). Deterministic: the worker fails the job
    terminally instead of re-running EXTRACT once per retry."""


class MaterializationQueryMemoryExceeded(ValueError):
    """A scan query exceeded the server's per-query memory ceiling
    (``QUERY_MEM_CAPACITY``) even at the narrowest ID-range width the
    shrink ladder descends to.

    Deterministic at a fixed width: the engine buffers the whole result set
    inside the tracked per-query budget, so re-issuing the same query over
    the same slice fails identically. The worker fails the job terminally
    rather than re-running EXTRACT once per retry.

    Subclasses ``ValueError`` on purpose, exactly like the two guards above:
    ``ValueError`` is in the circuit breaker's ignored set, so this reaches
    the worker unwrapped instead of being relabelled ``ProviderUnavailable``
    and counted against the breaker. A query too large for its slice is not
    a sick provider."""


class TerminalStoreFailure(Exception):
    """A verdict the run has already reached — no ladder may narrow its way
    out of it.

    Both terminal failures below quote the underlying redis error in their
    message so a failed run names the node. Classification is by text, so
    without this marker ``MaterializationStoreUnreachable`` reads back as
    ordinary ``"connection"`` pressure and lands in the ladder that called
    it: the ladder would halve a page it cannot deliver to a node that is
    not there, re-enter the spent outage budget on each half, and — because
    the narrowing is sticky — leave the run limping at the floor width long
    after the node came back. The classifier tests this marker first, so a
    terminal failure propagates whatever its message happens to say.
    """


class MaterializationScanTimedOut(TerminalStoreFailure, TimeoutError):
    """A floor-width scan (or a minimum-size write/delete) kept timing out
    through every backoff retry the ladder allows.

    At the narrowest width the pipeline can read, a timeout is no longer a
    payload problem but a graph store that is not answering — an outage.
    Subclasses ``TimeoutError`` (which ``asyncio.TimeoutError`` IS on 3.11+)
    so it counts toward the circuit breaker exactly as the raw timeout did
    and the worker's ordinary transient-retry path resumes the job from its
    checkpoint; unlike the raw timeout it carries a message that names the
    scan, the width, the budget and the server cap instead of arriving at
    the worker as an empty string that was then reported as a watchdog
    kill."""


class MaterializationStoreUnreachable(TerminalStoreFailure, ConnectionError):
    """The graph store node the run writes to stopped answering and did not
    come back inside the run's outage budget.

    Not the same failure as a query the store refuses: nothing about the
    query is wrong, and the run holds every byte of progress it had. It
    subclasses ``ConnectionError`` so the worker's existing transient path
    resumes the job from its checkpoint, and it carries the endpoint and how
    long the wait was — the two facts a failed run used to lose entirely,
    because the breaker's "Circuit open" text overwrote the only message
    that named the node."""


# ---------------------------------------------------------------------------
# Pressure ladder primitives — pure, so they are unit-testable without a
# provider. The pipeline reacts to two kinds of per-query pressure the same
# way: it reads LESS per query (and, first, reads serially) until the query
# fits, and only when a single row is all it reads does it conclude.
# ---------------------------------------------------------------------------


def _pressure_kind(exc: BaseException) -> Optional[str]:
    """``"timeout"`` / ``"memory"`` / ``"connection"`` — the three signals
    the pipeline reacts to; ``None`` for everything else (which propagates).

    A timeout is EITHER the client deadline (``asyncio.TimeoutError`` /
    ``TimeoutError``) OR the server's own ``Query timed out`` refusal — the
    latter is what production actually produces, because every query goes
    out with ``TIMEOUT = budget − 500 ms`` and the server aborts first."""
    # A verdict the run already reached is not a signal to react to: it is
    # the end of reacting. Tested first, before any text matching.
    if isinstance(exc, TerminalStoreFailure):
        return None
    # One classifier, shared with the aggregated-edge read ladder.
    from backend.app.providers.falkordb_provider import _pressure_kind as _kind
    return _kind(exc)
    return None


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


def _backoff_s(attempt: int) -> float:
    """Exponential backoff with jitter for floor-width timeout retries:
    2s, 4s, 8s … capped at 60s, plus up to 1s of jitter."""
    return min(60.0, 2.0 ** (attempt + 1)) + random.uniform(0.0, 1.0)


def _next_scan_width(
    sticky: Optional[int], ceiling: int, fail_width: Optional[int], streak: int,
) -> Optional[int]:
    """The re-grow rule for the sticky scan width after ``streak``
    consecutive successes: double after 8, but never back up to a width
    that failed for this scan this run unless the streak has reached 64 —
    a bounded probe instead of a sawtooth that re-fails every ninth query.
    Returns the new sticky width (``None`` = back at the knob width)."""
    if sticky is None:
        return None
    if streak < 8:
        return sticky
    doubled = sticky * 2
    if fail_width is not None and doubled >= fail_width and streak < 64:
        return sticky
    return None if doubled >= ceiling else doubled


class _StickyCap:
    """A sticky size cap for write/delete batches under pressure: halves
    toward ``floor`` on a failure, re-grows by doubling after 8 successes,
    and remembers the smallest size it needed this run."""

    __slots__ = ("value", "floor", "streak", "shrinks", "minimum")

    def __init__(self, floor: int, value: Optional[int] = None) -> None:
        self.value: Optional[int] = value      # None = no cap in force
        self.floor = max(1, floor)
        self.streak = 0
        self.shrinks = 0
        self.minimum: Optional[int] = value

    def apply(self, size: int) -> int:
        return max(self.floor, min(size, self.value)) if self.value else max(self.floor, size)

    def shrink(self, current: int) -> int:
        """Halve from ``current`` toward the floor; returns the new cap."""
        half = max(self.floor, current // 2)
        if self.value is None or half < self.value:
            self.value = half
        if self.minimum is None or half < self.minimum:
            self.minimum = half
        self.shrinks += 1
        self.streak = 0
        return self.value

    def note_success(self) -> None:
        if self.value is None:
            return
        self.streak += 1
        if self.streak >= 8:
            self.streak = 0
            self.value = self.value * 2

    def at_floor(self, current: int) -> bool:
        return current <= self.floor


# ---------------------------------------------------------------------------
# Pair-key packing.
#
# Pairs are keyed by ``(src_node_id << _ID_SHIFT) | tgt_node_id`` — a
# single small int per pair keeps the accumulator dicts far leaner than
# tuple keys at multi-million-pair scale. 35 bits ≈ 34 billion node IDs.
# ---------------------------------------------------------------------------

_ID_SHIFT = 35
_ID_MASK = (1 << _ID_SHIFT) - 1


def _pack(sid: int, tid: int) -> int:
    return (sid << _ID_SHIFT) | tid


def _unpack(key: int) -> Tuple[int, int]:
    return key >> _ID_SHIFT, key & _ID_MASK


# ---------------------------------------------------------------------------
# Cursor
# ---------------------------------------------------------------------------

_CURSOR_PREFIX = "v3"
PHASE_AGGREGATE = "aggregate"
PHASE_RECONCILE = "reconcile"
PHASE_APPLY = "apply"
_PHASES = (PHASE_AGGREGATE, PHASE_RECONCILE, PHASE_APPLY)


def make_cursor(run_start_ms: int, phase: str, pos: int) -> str:
    return f"{_CURSOR_PREFIX}:{run_start_ms}:{phase}:{pos}"


def parse_cursor(cursor: Optional[str]) -> Optional[Tuple[int, str, int]]:
    """Parse ``v3:{run_start_ms}:{phase}:{pos}``. Returns None for absent,
    legacy (``v2:``/composite) or malformed cursors — the pipeline then
    starts a fresh run, which is always safe because no phase of this
    pipeline ever deletes edges it cannot prove stale."""
    if not cursor:
        return None
    parts = str(cursor).split(":")
    if len(parts) != 4 or parts[0] != _CURSOR_PREFIX or parts[2] not in _PHASES:
        return None
    try:
        return int(parts[1]), parts[2], int(parts[3])
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Packed pair values: value = (weight << T) | edge_type_mask, where T is
# the number of effective lineage types this run. Python ints are
# arbitrary precision, so T is unbounded.
# ---------------------------------------------------------------------------

class _PairValues:
    def __init__(self, type_count: int) -> None:
        self._t = max(type_count, 1)
        self._mask_bits = (1 << self._t) - 1

    def make(self, weight: int, type_mask: int) -> int:
        return (weight << self._t) | type_mask

    def merge(self, value: int, weight: int, mask: int) -> int:
        # Weight bits add (mask bits never carry — they are only OR'd),
        # then the type mask unions.
        return (value + (weight << self._t)) | mask

    def weight(self, value: int) -> int:
        return value >> self._t

    def mask(self, value: int) -> int:
        return value & self._mask_bits


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------

class AggregationPipeline:
    """One materialization run against one provider/graph.

    The pipeline uses only the provider's existing primitives —
    ``_ro_query`` / ``_proj_ro_query`` / ``_proj_query`` (timeout-guarded,
    semaphore-gated, quiesce-aware), ``_alias_rel_types``,
    ``_get_containment_edge_types``, ``_entity_type_levels``,
    ``_level_digest``, and the AIMD sub-batch state — so every FalkorDB
    protection (server-side timeouts, write semaphore, latency quiesce,
    distributed admission) applies transparently.
    """

    def __init__(
        self,
        provider: Any,
        *,
        containment_edge_types: Optional[List[str]],
        lineage_edge_types: Optional[List[str]],
        last_cursor: Optional[str],
        progress_callback: Optional[Any],
        intra_batch_callback: Optional[Callable[[int], Awaitable[None]]],
        should_cancel: Optional[Callable[[], bool]],
        tuning: Optional[Dict[str, Any]] = None,
        job_id: Optional[str] = None,
        capacity_hints: Optional[Dict[str, Any]] = None,
        live_limits: Optional[Dict[str, Any]] = None,
    ) -> None:
        self.p = provider
        self._job_id = job_id or ""
        # What the worker knows that the shard does not: the bytes-per-edge
        # a previous run of THIS graph measured. Never tuning — an operator
        # override of the same figure comes through ``tuning`` instead.
        self._capacity_hints: Dict[str, Any] = dict(capacity_hints or {})
        self._last_budget: Optional[WriteBudget] = None
        # This job's entry in the owning node's reservation ledger: the
        # bytes it may still write that the node's ``used`` does not show.
        # Held from the first passed budget check, shrunk at each recheck,
        # released with the lease.
        self._reservation: Optional[Any] = None
        self._used_before: Optional[int] = None
        self._edges_before: int = 0
        self._calibration: Optional[Dict[str, Any]] = None
        self._fresh_run: bool = True
        self._budget_rechecks: int = 0       # mid-apply shard re-reads this run
        # Per-job tuning overrides (frozen on the job row at trigger time)
        # layered over env defaults — see _knob_int/_knob_float/_knob_bool.
        self._tuning: Dict[str, Any] = dict(tuning or {})
        self._containment_arg = containment_edge_types
        self._lineage_arg = lineage_edge_types
        self._last_cursor = last_cursor
        self._progress_cb = progress_callback
        self._cb_accepts_pct: Optional[bool] = None
        self._intra_cb = intra_batch_callback
        self._should_cancel = should_cancel

        self._entity_levels: Dict[str, int] = (
            getattr(provider, "_entity_type_levels", None) or {}
        )
        self._level_digest: str = getattr(provider, "_level_digest", None) or ""
        # ID → (urn, label) directory, loaded lazily with ID-range scans
        # the first time a write/delete needs URN resolution. NEVER
        # resolved with ``WHERE ID(n) = x`` under UNWIND — FalkorDB does
        # not drive that from a NodeByIdSeek, so it degrades to a full
        # node scan PER ROW (observed 30s+ per 5k-row batch on a 500k-node
        # graph and the direct cause of the timeout death spiral this
        # replaces).
        self._node_dir: Optional[Dict[int, Tuple[str, str]]] = None
        self._indexed_labels: Set[str] = set()
        # STRUCTURAL boundary: container node ID → containment DEPTH
        # (rank). A container is any containment PARENT — independent of
        # its ontology type, so self-nesting types roll up correctly.
        # Bounded by CONTAINER counts, never by edge or leaf counts.
        # None = boundary inactive (no containment / fine-pairs mode).
        self._nonleaf_levels: Optional[Dict[int, int]] = None
        # Container node ID → ontology TYPE level (the read path's stamp
        # dimension); missing when the label has no declared level.
        self._nonleaf_type_level: Dict[int, int] = {}
        # All containment-parent ids (set once containment is loaded).
        self._struct_parents: Optional[Set[int]] = None
        # Cube (full ancestor cross-product) vs boundary — decided per
        # run by _decide_materialization_mode. The auto estimate is kept
        # for run_stats so an over-budget fallback is never silent.
        self._cube_mode: Optional[bool] = None
        self._cube_estimate: Optional[int] = None
        # The raw sum before the measured ratio is applied — reported so the
        # estimator's accuracy is visible per run instead of only inferable
        # from which jobs failed.
        self._cube_estimate_upper: Optional[int] = None
        # Memoized ancestor closures ({ancestor_or_self: depth}) keyed by
        # CONTAINER id only — bounded by container count (every strict
        # ancestor is a containment parent); leaf closures are derived
        # from their parents' cached closures and never stored. Reset
        # when the parent map reloads.
        self._closure_memo: Dict[int, Dict[int, int]] = {}
        # Containment depth per node (roots 0, child = 1 + max over
        # parents) — one int per touched node; feeds ranks, the
        # sourceDepth/targetDepth stamps and the auto-mode estimate.
        self._depth_memo: Dict[int, int] = {}
        # Deepest depth stamped onto any written endpoint this run —
        # persisted as _AggMeta.maxDepth for the structural readers.
        self._max_stamped_depth = 0
        self._fine_merges_skipped = 0
        # Level map re-keyed by observed label spellings, built lazily —
        # see _levels_by_observed_label.
        self._levels_by_spelling: Optional[Dict[str, int]] = None

        # Run state
        self._run_start_ms: int = 0
        self._containment: List[str] = []
        self._effective_types: List[str] = []
        self._type_bit: Dict[str, int] = {}
        self._values = _PairValues(1)
        # Containment DAG: child id → ALL parent ids. Multi-parent nodes
        # keep every parent — each ancestry gets its rollups (the
        # longest-chain collapse silently dropped the others).
        self._parents: Dict[int, Tuple[int, ...]] = {}
        self._acc: Dict[int, int] = {}       # pair key → packed (weight, mask)
        self._flushed: Set[int] = set()      # keys early-applied this run
        self._writes = 0                     # AGGREGATED edges written this run
        self._deletes = 0
        self._scanned = 0                    # source lineage edges scanned
        self._total = 0                      # total source lineage edges
        self._progress_pct = 0
        self._max_applied_key = 0

        self._pacing_ratio = self._knob_float("write_pacing_ratio", _pacing_ratio, 0.0, 10.0)
        self._read_pressure_pacing_ratio = self._knob_float(
            "read_pressure_pacing_ratio", _read_pressure_pacing_ratio, 0.0, 20.0,
        )
        self._yielding_to_reads = False      # last write batch was paced for readers
        self._read_pressure_yields = 0       # write batches paced at the read-pressure ratio
        self._phase_started = time.monotonic()
        self._phase_timings: Dict[str, float] = {}
        # Shrink-on-pressure scan state (see _fetch_range): a per-query
        # timeout OR a per-query memory-ceiling refusal halves the effective
        # sub-range width for the REST of the run (sticky), re-growing after
        # sustained successes. None = the knob width is healthy.
        self._scan_subwidth: Optional[int] = None
        self._scan_success_streak = 0
        # Narrowest width this run actually needed, and how many times the
        # ladder engaged. Unlike _scan_subwidth these are never re-grown —
        # they are the run's high-water mark of provider pressure, reported
        # in run_stats so a run that succeeded only BY degrading is visible.
        self._scan_min_width: Optional[int] = None
        self._scan_shrinks = 0
        # The rest of the pressure ladder's state. ``_scan_conc_cap`` pins
        # wave concurrency (to 1 after the first pressure event of the run);
        # ``_scan_fail_width`` remembers, per scan label, the narrowest
        # width that FAILED so re-growth does not saw-tooth back into it;
        # ``_reconcile_strategy`` flips to keys-only when halving the
        # 11-column RECONCILE projection stops being the cheapest move;
        # the three sticky caps bound the MERGE sub-batch, the delete chunk
        # and the keys-only lookup batch under write/delete pressure.
        self._scan_conc_cap: Optional[int] = None
        self._scan_fail_width: Dict[str, int] = {}
        self._scan_timeout_retries = 0
        self._reconcile_strategy = "full"
        self._write_cap = _StickyCap(1)
        self._delete_cap = _StickyCap(1)
        self._lookup_cap = _StickyCap(1)
        self._pressure_log: List[Dict[str, Any]] = []   # last 8 events
        self._by_scan: Dict[str, Dict[str, Any]] = {}   # per label, ≤ 12
        self._last_hb_mono = 0.0
        self._query_mem_capacity: Optional[int] = None
        # The memory-aware flush: the worker's RSS against its cgroup limit,
        # sampled at most once a second from the merge loops; the
        # accumulator flushes early when RSS crosses ``flush_mem_pct`` of
        # the limit and holds at least ``flush_min_pairs``. Fail-open when
        # either reading is unknown — the pair cap still bounds memory.
        self._mem = MemoryGauge()
        self._flush_pct = self._knob_int("flush_mem_pct", _flush_mem_pct, 30, 90)
        self._flush_min_pairs = _flush_min_pairs()
        self._memory_flushes = 0
        self._memory_rollups = 0
        # Replication backpressure: how many replicas must acknowledge each
        # write batch, how long one wait may block, and what the waiting
        # cost this run (for the record and the run settings panel).
        self._replica_ack_min = self._knob_int("replica_ack_min", _replica_ack_min, 0, 5)
        self._replica_ack_timeout_ms = self._knob_int(
            "replica_ack_timeout_ms", _replica_ack_timeout_ms, 500, 60_000)
        self._replica_waits = 0
        self._replica_wait_s = 0.0
        self._replica_holds = 0
        self._replica_max_lag_bytes = 0
        self._repl_state: Dict[str, Any] = {}
        self._repl_state_at = 0.0
        self._no_replicas_logged = False
        self._replication_advisory: Optional[Dict[str, Any]] = None
        # Waiting out a node that is not answering, and what the node said
        # about itself when it came back.
        self._outage_hold_s = _store_outage_hold_s()
        self._outage_holds = 0
        self._outage_s = 0.0
        #: When the CURRENT outage began, or None while the store answers.
        #: Separate from the run totals above because the budget is spent
        #: per outage: a rebuild running for hours meets several rolling
        #: restarts, and timing the second from the first one's blip would
        #: fail it instantly with a wait it never made.
        self._outage_since: Optional[float] = None
        self._outage_holds_now = 0
        self._node_restarts: List[Dict[str, Any]] = []
        self._node_identity: Dict[str, Tuple[Optional[str], Optional[int]]] = {}
        self._rss_high_water_mb: Optional[float] = None
        self._mem_limit_mb: Optional[float] = None
        # Values an operator may raise on a RUNNING job (stall/wall windows
        # live in the worker; the per-query budgets are read here per
        # query). The worker owns the dict and refreshes it from the job
        # row; the pipeline only ever reads it.
        self._live: Dict[str, Any] = live_limits if live_limits is not None else {}
        ceiling = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        self._scan_floor = min(
            self._knob_int("scan_shrink_floor", _scan_shrink_floor, 1, 5_000_000), ceiling,
        )
        self._scan_timeout_knob = self._knob_float("scan_timeout_s", _scan_timeout_s, 5.0, 600.0)
        self._write_timeout_knob = self._knob_float(
            "write_timeout_s", lambda: float(getattr(self.p, "_bulk_create_timeout_s", 60.0)),
            5.0, 600.0,
        )
        # What the last run of this source learned under pressure, applied
        # only where it is STRICTER than the knob in force (a hint never
        # widens anything) and unless the operator opted out.
        self._hints_applied: Dict[str, Any] = {}
        if not self._knob_bool("ignore_observed", lambda: False):
            self._apply_hints(ceiling)
        # What this run ran with, and where each value came from — the
        # per-run record the worker persists at the first checkpoint, so a
        # run that fails or is cancelled still shows its settings.
        self._effective, self._effective_sources = resolve_effective_tuning(
            self._tuning, self._capacity_hints,
            bulk_timeout_default=float(getattr(self.p, "_bulk_create_timeout_s", 60.0)),
        )

        # ── Conformance diagnostics (Phase IV — loud, never silent) ──
        # Structured advisories surfaced in run_stats (and thus the job-detail
        # UI), so a zero-edge run whose cause is a conformance gap is
        # diagnosable WITHOUT trawling worker logs. Advisory-only: they never
        # fail an otherwise-clean run (a genuinely flat source stays green).
        self._dropped_endpoints = 0                 # pairs dropped: no identity
        self._empty_directory = False               # nodes exist, none resolved
        self._unmatched_types: List[str] = []       # declared spellings scanning 0 edges
        self._identity_candidates: Dict[str, int] = {}  # empty-dir probe: prop -> populated count
        self._identity_sample_total = 0             # nodes sampled by that probe
        self._identity_autohealed = False           # ran the auto-detect + stamp recovery once
        self._autohealed_identity: Optional[str] = None  # property the auto-heal adopted

    # -- tuning knob resolution ---------------------------------------------

    def _knob_int(self, name: str, env_default: Callable[[], int], lo: int, hi: int) -> int:
        raw = self._tuning.get(name)
        if raw is None:
            return env_default()
        try:
            return max(lo, min(hi, int(raw)))
        except (TypeError, ValueError):
            return env_default()

    def _knob_float(self, name: str, env_default: Callable[[], float], lo: float, hi: float) -> float:
        raw = self._tuning.get(name)
        if raw is None:
            return env_default()
        try:
            return max(lo, min(hi, float(raw)))
        except (TypeError, ValueError):
            return env_default()

    def _knob_bool(self, name: str, env_default: Callable[[], bool]) -> bool:
        raw = self._tuning.get(name)
        if raw is None:
            return env_default()
        return bool(raw)

    def _apply_hints(self, ceiling: int) -> None:
        """Seed the ladder from ``capacity_hints`` (the previous run's
        ``observed_tuning``): start the scans at the width that run needed,
        pin concurrency if it had to read serially, start the reconcile in
        keys-only if it switched, cap the write batch / delete chunk where
        it settled. Each applies only when stricter than the knob; the
        ladder's normal re-growth then probes upward during the run, so a
        graph that no longer needs the narrowing is found out within it."""
        hints = self._capacity_hints

        def _pos_int(key: str) -> Optional[int]:
            try:
                value = int(hints.get(key))
            except (TypeError, ValueError):
                return None
            return value if value > 0 else None

        width = _pos_int("scan_width_observed")
        if width is not None and width < ceiling:
            self._scan_subwidth = max(self._scan_floor, width)
            self._hints_applied["scan_width"] = self._scan_subwidth
        conc = _pos_int("extract_concurrency_observed")
        if conc is not None and conc < self._knob_int(
            "extract_concurrency", _extract_concurrency, 1, 4,
        ):
            self._scan_conc_cap = conc
            self._hints_applied["extract_concurrency"] = conc
        if hints.get("reconcile_strategy_observed") == "keys_only":
            self._reconcile_strategy = "keys_only"
            self._hints_applied["reconcile_strategy"] = "keys_only"
        batch = _pos_int("write_batch_observed")
        if batch is not None and batch < getattr(self.p, "_MERGE_SUB_BATCH_SIZE", 500):
            self._write_cap.value = batch
            self._hints_applied["write_batch"] = batch
        chunk = _pos_int("delete_chunk_observed")
        if chunk is not None and chunk < self._knob_int(
            "delete_chunk", _delete_chunk, 100, 50_000,
        ):
            self._delete_cap.value = chunk
            self._hints_applied["delete_chunk"] = chunk
        if self._hints_applied:
            logger.info(
                "aggregation pipeline on %s: starting from what the last run "
                "learned — %s.", self.p._graph_name, self._hints_applied,
            )

    def _scan_timeout(self) -> float:
        """Per-query budget for scans: the live override an operator raised
        on the running job, else the ``scanTimeoutS`` knob, else env. Read
        per query so a raise applies to the NEXT query, no restart."""
        live = self._live.get("scan_timeout_s")
        try:
            return max(5.0, min(600.0, float(live))) if live else self._scan_timeout_knob
        except (TypeError, ValueError):
            return self._scan_timeout_knob

    def _write_timeout(self) -> float:
        """Per-query budget for writes and deletes — same resolution as
        :meth:`_scan_timeout` over the ``writeTimeoutS`` knob."""
        live = self._live.get("write_timeout_s")
        try:
            return max(5.0, min(600.0, float(live))) if live else self._write_timeout_knob
        except (TypeError, ValueError):
            return self._write_timeout_knob

    def _live_pacing_ratio(self) -> float:
        """The pacing ratio in force: a value set on the running job (PATCH
        …/limits; 0 = no pacing) wins over the knob, from the next write."""
        live = self._live.get("write_pacing_ratio")
        if live is None:
            return self._pacing_ratio
        try:
            return max(0.0, min(10.0, float(live)))
        except (TypeError, ValueError):
            return self._pacing_ratio

    def _live_scan_width(self) -> Optional[int]:
        """A cap on the scan width set on the running job, clamped to
        [scan floor, the width knob]; None when none is set. Applied on
        every READ of the sticky width and never written into it, so the
        ladder's own narrowing and re-growth stay its own."""
        live = self._live.get("scan_width")
        if not live:
            return None
        try:
            width = int(live)
        except (TypeError, ValueError):
            return None
        ceiling = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        return max(self._scan_floor, min(ceiling, width))

    def _live_replica_ack_min(self) -> int:
        """How many replicas must acknowledge each write, in force now: a
        value set on the RUNNING job wins over the knob (0 ends a hold
        immediately — the operator's escape hatch)."""
        live = self._live.get("replica_ack_min")
        if live is None:
            return self._replica_ack_min
        try:
            return max(0, min(5, int(live)))
        except (TypeError, ValueError):
            return self._replica_ack_min

    def _live_replica_ack_timeout_ms(self) -> int:
        live = self._live.get("replica_ack_timeout_ms")
        if live is None:
            return self._replica_ack_timeout_ms
        try:
            return max(500, min(60_000, int(live)))
        except (TypeError, ValueError):
            return self._replica_ack_timeout_ms

    async def _replication_state(self, *, max_age_s: float = 60.0) -> Dict[str, Any]:
        """The write node's replication state, re-read at most every
        ``max_age_s``. One INFO a minute, not one per batch."""
        now = time.monotonic()
        if self._repl_state and now - self._repl_state_at < max_age_s:
            return self._repl_state
        read = getattr(self.p, "replication_state", None)
        state = await read() if read is not None else {}
        self._repl_state = state or {}
        self._repl_state_at = now
        return self._repl_state

    def _note_replica_lag(self, state: Dict[str, Any]) -> Optional[int]:
        lags = [r.get("lagBytes") for r in state.get("replicas", [])
                if r.get("lagBytes") is not None]
        worst = max(lags) if lags else None
        if worst is not None:
            self._replica_max_lag_bytes = max(self._replica_max_lag_bytes, int(worst))
        return worst

    async def _replica_gate(self) -> float:
        """Hold until the write node's replicas have caught up.

        Returns the seconds spent waiting, which the caller folds into the
        write's own duration — so a replica-bound shard shrinks batches and
        paces longer exactly as a slow master does, instead of the pipeline
        cheerfully writing faster than the replicas can apply.

        Never fails a run. No replicas attached, no way to ask, or a
        governor turned off: the write proceeds. Replicas that are simply
        behind: the pipeline waits, heartbeating, until they are not — the
        job's stall window and wall clock (both raisable while it runs)
        remain the only bound, and lowering ``replicaAckMin`` to 0 ends any
        hold at once.
        """
        want = self._live_replica_ack_min()
        if want <= 0:
            return 0.0
        state = await self._replication_state()
        attached = int(state.get("connectedReplicas") or 0)
        if attached <= 0:
            if not self._no_replicas_logged:
                self._no_replicas_logged = True
                logger.info(
                    "aggregation pipeline on %s: the write node reports no "
                    "replicas — replication backpressure is off for this run.",
                    self.p._graph_name,
                )
            return 0.0
        # Never wait for more replicas than exist: a fleet default of 2
        # against a one-replica shard would hold on every batch forever.
        target = min(want, attached)
        wait_for = getattr(self.p, "wait_for_replicas", None)
        if wait_for is None:
            return 0.0
        started = time.monotonic()
        acked = await wait_for(
            min_replicas=target, timeout_ms=self._live_replica_ack_timeout_ms())
        waited = time.monotonic() - started
        if acked is None:
            return 0.0
        self._replica_waits += 1
        self._replica_wait_s += waited
        if acked >= target:
            return waited
        return waited + await self._hold_for_replicas(target)

    async def _hold_for_replicas(self, target: int) -> float:
        """Wait out replicas that are behind, saying why, until they catch
        up or the operator lowers the bar."""
        self._replica_holds += 1
        started = time.monotonic()
        attempt = 0
        while True:
            if self._live_replica_ack_min() <= 0:
                logger.info(
                    "aggregation pipeline on %s: replica acknowledgement turned "
                    "off while waiting — continuing.", self.p._graph_name,
                )
                break
            self._cancel_check()
            await self._ladder_heartbeat()
            state = await self._replication_state(max_age_s=0.0)
            lag = self._note_replica_lag(state)
            attached = int(state.get("connectedReplicas") or 0)
            if attached <= 0:
                # The replicas went away entirely: that is the topology's
                # problem, not this batch's — the Graph store page says so.
                break
            waiting_on = min(target, attached)
            if attempt == 0 or attempt % 4 == 0:
                logger.warning(
                    "aggregation pipeline on %s: waiting for %d replica(s) of the "
                    "write node to catch up%s — the rebuild is going at the "
                    "replicas' pace.",
                    self.p._graph_name, waiting_on,
                    f" (up to {lag:,} bytes behind)" if lag else "",
                )
            await asyncio.sleep(_backoff_s(min(attempt, 4)))
            attempt += 1
            acked = await self.p.wait_for_replicas(
                min_replicas=waiting_on,
                timeout_ms=self._live_replica_ack_timeout_ms(),
            )
            if acked is None or acked >= waiting_on:
                break
        held = time.monotonic() - started
        if held >= 60.0:
            self._pressure_log.append({
                "scan": "apply", "kind": "replica_lag",
                "held_s": round(held, 1),
                "lag_bytes": self._replica_max_lag_bytes or None,
            })
            if len(self._pressure_log) > 8:
                del self._pressure_log[0]
        return held

    async def _through_outage(
        self, attempt: Callable[[], Awaitable[Any]], *, op: str,
    ) -> Any:
        """Run ``attempt``; if the store is not answering, wait for it and
        run the SAME thing again.

        Deliberately no narrowing: a node that is restarting does not care
        how small the next query is, and shrinking the scan would leave the
        run limping at a fraction of its width long after the node
        recovered. The ladder handles queries the store refuses; this
        handles the store not being there.
        """
        while True:
            try:
                result = await attempt()
            except Exception as exc:
                if _pressure_kind(exc) != "connection":
                    raise
                await self._hold_for_store(exc, op)
            else:
                if self._outage_since is not None:
                    logger.info(
                        "aggregation pipeline on %s: the graph store answered "
                        "again after %.0fs during %s — carrying on from the "
                        "checkpoint.", self.p._graph_name,
                        time.monotonic() - self._outage_since, op,
                    )
                    self._outage_since = None
                    self._outage_holds_now = 0
                return result

    async def _hold_for_store(self, exc: Exception, op: str) -> None:
        """One wait for a node that is not answering. Raises
        :class:`MaterializationStoreUnreachable` once the run has waited
        longer than it is allowed to."""
        endpoint = self._store_endpoint()
        if self._outage_since is None:
            self._outage_since = time.monotonic()
            await self._note_node_identity(endpoint)
            logger.warning(
                "aggregation pipeline on %s: the graph store node %s is not "
                "answering (%s) during %s — waiting for it; the run keeps its "
                "checkpoint.", self.p._graph_name, endpoint, type(exc).__name__, op,
            )
            self._on_pressure(op, "connection", 0, 0, size=0)
        waited = time.monotonic() - self._outage_since
        if waited >= self._outage_hold_s:
            raise MaterializationStoreUnreachable(
                f"the graph store node {endpoint} did not answer for "
                f"{waited / 60:.0f} minute(s) during {op} ({type(exc).__name__}: "
                f"{str(exc)[:160]}). The run keeps its checkpoint — Resume it "
                f"once the node is back, and check whether the container was "
                f"killed for memory or by its health probe."
            )
        self._outage_holds += 1
        self._outage_holds_now += 1
        await self._ladder_heartbeat()
        self._cancel_check()
        # Widens within THIS outage; a later one starts patient again.
        delay = _backoff_s(min(self._outage_holds_now, 4))
        await asyncio.sleep(delay)
        self._outage_s += delay
        # A restarted pod comes back at a new address and a failover moves
        # the graph to a promoted replica: re-resolve rather than redial.
        reconnect = getattr(self.p, "reconnect_owner", None)
        if reconnect is not None:
            await reconnect()
        await self._note_node_identity(endpoint)

    def _store_endpoint(self) -> str:
        shard = self._last_budget.shard if self._last_budget is not None else None
        endpoint = getattr(shard, "endpoint", None)
        if endpoint and endpoint != "unknown":
            return endpoint
        label = getattr(self.p, "_endpoint_label", None)
        return label() if label is not None else "the graph store"

    async def _note_node_identity(self, endpoint: str) -> None:
        """Remember (and compare) what the node says about itself.

        A run id is regenerated on every start, so one that CHANGED while
        the run was waiting is proof the node restarted rather than merely
        being slow — the evidence a failed run never had."""
        try:
            shard = await self._read_shard()
        except Exception:                             # noqa: BLE001 — evidence is optional
            return
        run_id = getattr(shard, "run_id", None)
        uptime = getattr(shard, "uptime_s", None)
        if run_id is None and uptime is None:
            return
        before = self._node_identity.get(endpoint)
        if before is not None:
            was_run, was_uptime = before
            restarted = (
                (run_id is not None and was_run is not None and run_id != was_run)
                or (uptime is not None and was_uptime is not None and uptime < was_uptime)
            )
            if restarted:
                self._node_restarts.append({
                    "endpoint": endpoint,
                    "uptime_s": uptime,
                    "at": _now_iso(),
                })
                logger.warning(
                    "aggregation pipeline on %s: node %s RESTARTED during this run "
                    "(up %ss). Check whether the container was killed for memory or "
                    "by its health probe.",
                    self.p._graph_name, endpoint, uptime,
                )
        self._node_identity[endpoint] = (run_id, uptime)

    def _effective_conc(self) -> int:
        """Wave concurrency in force: the knob, capped by a value set on the
        running job, pinned by the ladder to 1 after the first pressure
        event of the run (a graph store refusing one query for size or time
        gets nothing from three more of them)."""
        conc = self._knob_int("extract_concurrency", _extract_concurrency, 1, 4)
        live = self._live.get("extract_concurrency")
        if live:
            try:
                conc = min(conc, max(1, int(live)))
            except (TypeError, ValueError):
                pass
        return min(conc, self._scan_conc_cap) if self._scan_conc_cap else conc

    def _mark_phase(self, name: str) -> None:
        """Close the previous timing bucket and open ``name``."""
        now = time.monotonic()
        elapsed = now - self._phase_started
        if elapsed > 0 and getattr(self, "_current_timing", None):
            self._phase_timings[self._current_timing] = round(
                self._phase_timings.get(self._current_timing, 0.0) + elapsed, 2,
            )
        self._current_timing = name
        self._phase_started = now

    # -- public entry ------------------------------------------------------

    async def run(self) -> Dict[str, Any]:
        # Every read this run makes goes to the MASTER. The pipeline reads
        # what it has just written — RECONCILE over the cells APPLY wrote,
        # the estimate scans, the budget reads — and a replica that is a
        # second behind would show it a graph it has already changed.
        from backend.app.providers.falkordb_provider import read_from_master_only

        with read_from_master_only():
            return await self._run()

    async def _run(self) -> Dict[str, Any]:
        resume = parse_cursor(self._last_cursor)
        self._fresh_run = resume is None
        if resume is not None:
            self._run_start_ms, phase, pos = resume
            logger.info(
                "aggregation pipeline on %s: resuming run=%d phase=%s pos=%d",
                self.p._graph_name, self._run_start_ms, phase, pos,
            )
        else:
            self._run_start_ms = await self._server_now_ms()
            phase, pos = PHASE_AGGREGATE, 0
            if self._last_cursor:
                logger.info(
                    "aggregation pipeline on %s: non-v3 cursor %r — starting a "
                    "fresh run (existing AGGREGATED edges are NOT wiped; the "
                    "reconcile phase updates them in place).",
                    self.p._graph_name, self._last_cursor,
                )

        await self._resolve_types()
        if not self._effective_types:
            logger.warning(
                "aggregation pipeline on %s: no effective lineage types; "
                "nothing to materialize.", self.p._graph_name,
            )
            return self._result()
        self._values = _PairValues(len(self._effective_types))

        admission = getattr(self.p, "_admission_controller", None)
        lease = None
        if admission is not None:
            lease = await admission.acquire_graph_lease(
                self.p, owner=self._job_id,
            )
        try:
            # Persist a parseable cursor IMMEDIATELY — before any graph
            # work — so an early crash resumes instead of restarting with
            # a NULL cursor (the v2 wipe-on-resume failure mode).
            self._current_timing = "extract_s"
            self._phase_started = time.monotonic()
            await self._checkpoint(PHASE_AGGREGATE, 0, phase_label="extracting")

            # What the graph already stores and what the shard holds now:
            # the growth budget and the calibration both start from here.
            await self._capacity_baseline()

            # EXTRACT + COMPUTE always re-run (deterministic, minutes).
            await self._extract_and_compute()
            # Hard write budget: refuse a result the owning shard cannot
            # take BEFORE the first apply write reaches it.
            await self._check_write_budget()
            self._snapshot_pairs_by_level()
            self._mark_phase("reconcile_s")

            # RECONCILE: resume from the recorded range when the prior
            # attempt died mid-scan; earlier ranges' deletes/updates are
            # already durable and idempotent.
            reconcile_from = pos if phase == PHASE_RECONCILE else 0
            existing = await self._reconcile(start_lo=reconcile_from)

            # APPLY: create pairs the reconcile scan did not observe. On
            # resume past a mid-apply crash RECONCILE just re-ran fully and
            # rebuilt ``existing`` — including everything the prior attempt
            # already wrote — so remaining keys are exactly the still-
            # missing ones. (No cursor fast-forward here: bisecting past
            # the recorded pos skipped pairs that were NEW since the
            # crashed attempt but sorted before it; the recorded pos is
            # progress display only.)
            self._mark_phase("apply_s")
            await self._apply_missing(existing)
            self._mark_phase("done")

            final_total = len(self._flushed | set(self._acc.keys()))
            await self._stamp_run_meta(final_total)
            await self._calibrate()
            self._progress_pct = 100
            await self._checkpoint(
                PHASE_APPLY, self._max_applied_key, phase_label="applying",
            )
            logger.info(
                "aggregation pipeline on %s complete: scanned=%d pairs=%d "
                "writes=%d deletes=%d (run=%d)",
                self.p._graph_name, self._scanned, final_total,
                self._writes, self._deletes, self._run_start_ms,
            )
            return self._result(final_total)
        finally:
            if admission is not None and self._reservation is not None:
                await admission.release(self._reservation)
                self._reservation = None
            if admission is not None and lease is not None:
                await admission.release_graph_lease(lease)

    # -- shared helpers ------------------------------------------------------

    def _pair_bucket(self, node_id: int) -> str:
        """Histogram bucket for one endpoint: containment DEPTH — the
        dimension pair selection actually runs on, meaningful on any
        graph shape (type levels are degenerate for self-nesting types)."""
        return f"d{self._depth_of(node_id)}"

    def _snapshot_pairs_by_level(self) -> None:
        """Depth-pair histogram of the computed result, persisted into
        run_stats — makes a MISSING rank (e.g. no domain→domain pairs
        because the containment types didn't match the graph) visible in
        the job detail instead of requiring a graph query to diagnose."""
        counts: Dict[str, int] = {}
        for key in set(self._acc) | self._flushed:
            sid, tid = _unpack(key)
            name = f"{self._pair_bucket(sid)}->{self._pair_bucket(tid)}"
            counts[name] = counts.get(name, 0) + 1
        self._pairs_by_level = counts
        logger.info(
            "aggregation pipeline on %s: computed pairs by level: %s",
            self.p._graph_name,
            ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none",
        )

    def _conformance_advisories(self) -> List[Dict[str, Any]]:
        """Structured, operator-facing advisories for the conformance gaps that
        silently zero out a run — identity (no resolvable node id) and casing
        (declared edge types matching nothing observed). Recorded in run_stats
        so the job detail shows WHY a run produced few/zero edges, instead of a
        green ``completed`` that looks like an empty source. Advisory-only: an
        otherwise-clean run stays ``completed`` and a genuinely flat source
        yields no advisories at all."""
        advisories: List[Dict[str, Any]] = []
        if self._empty_directory:
            # Report the property THIS run actually resolved on — the fix
            # differs by case, and a hardcoded "urn" hid which one applied:
            #   • ran as `urn` → the configured Node Identity Property did NOT
            #     reach this run (frozen before the change, or a stale build) →
            #     re-aggregate so the new value freezes onto the job.
            #   • ran as e.g. `id` but still empty → the run DID use it, but no
            #     node carries `urn` OR `id` → the property name is wrong for
            #     THIS physical graph (case-sensitive), not merely unset.
            _ident = str(getattr(self.p, "_node_identity_property", None) or "urn")
            # Auto-detected populated identity properties (from the empty-dir
            # probe) — names the fix and disambiguates "set id but didn't take".
            _cands = getattr(self, "_identity_candidates", None) or {}
            _found = ", ".join(
                f"`{k}` ({v})" for k, v in sorted(_cands.items(), key=lambda kv: -kv[1])
                if k != _ident and v
            )
            _resolvable = {k for k, v in _cands.items() if v and k != _ident}
            if _ident == "urn":
                _detail = (
                    "this run keyed identity on `urn` only and no node carries it."
                )
                if _resolvable:
                    _detail += (
                        f" Nodes DO carry: {_found}. Your Node Identity Property "
                        "did not reach this run — confirm it's saved (it should "
                        "still show after a refresh) and re-aggregate."
                    )
                else:
                    _detail += (
                        " If this is an onboarded graph keyed by another property, "
                        "set the data source's Node Identity Property and re-aggregate."
                    )
            else:
                _detail = (
                    f"this run resolved identity as coalesce(urn, {_ident}) but no "
                    f"node carries `urn` OR `{_ident}`."
                )
                if _resolvable:
                    _detail += f" Nodes DO carry: {_found} — set the property to one of those."
                else:
                    _detail += (
                        f" Confirm `{_ident}` is the exact (case-sensitive) property "
                        "that holds the node id on this graph, then re-aggregate."
                    )
            advisories.append({
                "kind": "identity_unresolved",
                "severity": "error",
                "identity_property": _ident,
                "resolvable_properties": sorted(_resolvable),
                "message": "No node resolved a canonical identity — " + _detail,
            })
        elif self._dropped_endpoints:
            advisories.append({
                "kind": "endpoints_unresolved",
                "severity": "warning",
                "dropped_pairs": self._dropped_endpoints,
                "message": (
                    f"{self._dropped_endpoints} aggregation pair(s) were dropped "
                    "because an endpoint had no resolvable identity (a deleted "
                    "node, or a missing `urn`/identity property)."
                ),
            })
        if self._autohealed_identity:
            advisories.append({
                "kind": "identity_autohealed",
                "severity": "warning",
                "identity_property": self._autohealed_identity,
                "message": (
                    "Node identity was not configured (or resolved nothing), so this "
                    f"run auto-detected `{self._autohealed_identity}` and stamped `urn` "
                    "from it to attach aggregated edges. Set the data source's Node "
                    f"Identity Property to `{self._autohealed_identity}` to make it "
                    "permanent and skip this recovery next run."
                ),
            })
        if self._unmatched_types:
            advisories.append({
                "kind": "edge_types_unmatched",
                "severity": "warning",
                "types": self._unmatched_types[:16],
                "message": (
                    f"{len(self._unmatched_types)} declared edge-type "
                    "spelling(s) matched nothing in the graph's observed "
                    "vocabulary and scanned zero edges: "
                    + ", ".join(self._unmatched_types[:8])
                    + ". Check the ontology's edge-type casing against the "
                    "physical graph."
                ),
            })
        # Containment was declared but the DAG came back EMPTY (maxDepth 0):
        # aggregation degenerates to a flat leaf-only cube — the roll-up the
        # user expects never happens, and on a FRESH graph this was silent
        # (no precondition failure since there were no stored cells to wipe).
        # Surface WHY: either the containment type isn't classified/frozen, or
        # its physical spelling differs from the declared one and wasn't folded.
        _struct = getattr(self, "_struct_parents", None)
        if self._containment and _struct is not None and not _struct:
            advisories.append({
                "kind": "containment_empty",
                "severity": "warning",
                "types": sorted(self._containment)[:16],
                "message": (
                    "Containment edge type(s) "
                    + ", ".join(sorted(self._containment)[:8])
                    + " were declared but matched ZERO edges in the graph, so "
                    "the containment hierarchy is empty (maxDepth 0) and edges "
                    "do not roll up past the leaf level. Confirm the type is "
                    "classified as Containment AND spelled as the physical graph "
                    "has it (FalkorDB is case-sensitive — declared HAS vs "
                    "physical Has)."
                ),
            })
        return advisories

    def _result(self, affected: int = 0) -> Dict[str, Any]:
        advisories = self._conformance_advisories()
        if self._replication_advisory is not None:
            advisories = [*advisories, self._replication_advisory]
        return {
            "processed": self._scanned,
            "aggregated_edges_affected": affected,
            "input_edges_processed": self._scanned,
            "errors": 0,
            "writes": self._writes,
            "deletes": self._deletes,
            "run_stats": {
                **{k: v for k, v in self._phase_timings.items() if k != "done"},
                "writes": self._writes,
                "deletes": self._deletes,
                "pairs": affected,
                "scanned_edges": self._scanned,
                "fine_merges_skipped": self._fine_merges_skipped,
                # Storage-regime decision, DURABLE — never a silent
                # fallback buried in worker logs: operators must see WHY
                # a 2.9M-edge graph stored ~600k cells (boundary =
                # canonical depth-diagonal stored, finer granularities
                # served on demand) and what budget forced the choice.
                **(
                    {
                        "regime": (
                            "boundary" if self._fine_filter_active() else "cube"
                        ),
                        "materialize_budget": self._governing_allowance(),
                    }
                    if self._cube_mode is not None else {}
                ),
                # The capacity decision, durable on the job: what the owning
                # shard allowed, which rule governed, and what this run
                # taught us about bytes per edge (or why it could not).
                **(
                    {"write_budget": self._last_budget.as_stats()}
                    if self._last_budget is not None else {}
                ),
                **(self._calibration or {}),
                # All three numbers, so the estimator can be held to account:
                # what the upper bound counted, what the measured ratio
                # corrected it to, and what the run actually stored. Nothing
                # compared the first to the last before, which is how a
                # systematic overshoot of fifty times stayed invisible.
                **(
                    {"cube_estimate": self._cube_estimate}
                    if getattr(self, "_cube_estimate", None) is not None
                    else {}
                ),
                **(
                    {"cube_estimate_upper": self._cube_estimate_upper}
                    if getattr(self, "_cube_estimate_upper", None) is not None
                    else {}
                ),
                **(
                    {"cell_ratio_used": self._cell_ratio()}
                    if self._cell_ratio() is not None else {}
                ),
                **(
                    {
                        "cells_exact": affected,
                        "cell_ratio_observed": self._observed_cell_ratio(affected),
                    }
                    if self._observed_cell_ratio(affected) is not None else {}
                ),
                **(
                    {"pairs_by_level": self._pairs_by_level}
                    if getattr(self, "_pairs_by_level", None) else {}
                ),
                # Provider-pressure high-water mark. Present ONLY when the
                # scan ladder actually engaged, so a clean run's run_stats
                # is unchanged. A run that completed only BY degrading is
                # the signal that the next size increment fails outright —
                # it must not be invisible. (The terminal path carries its
                # own diagnostics in the exception message instead:
                # run_stats is persisted on success only.)
                **(
                    {
                        "scan_width_min": self._scan_min_width,
                        "scan_shrinks": self._scan_shrinks,
                    }
                    if self._scan_min_width is not None else {}
                ),
                # Mid-apply shard re-reads — present only when APPLY was long
                # enough to need one, same convention as the ladder above.
                **(
                    {"budget_rechecks": self._budget_rechecks}
                    if self._budget_rechecks else {}
                ),
                # Everything the pressure ladder changed this run — width,
                # concurrency, reconcile strategy, batch sizes, timeout
                # retries — bounded, and absent on a run that ran at its
                # settings. The per-run "what did it adapt to" record.
                **(
                    {"adapted": self._adapted_snapshot()}
                    if (
                        self._pressure_log or self._scan_min_width is not None
                        or self._hints_applied or self._live
                        or self._memory_flushes or self._memory_rollups
                        or self._replica_waits or self._replica_holds
                        or self._outage_holds or self._node_restarts
                    ) else {}
                ),
                # The per-query ceiling the ladder narrows against, when the
                # shard could say — always present, None when unknown.
                "query_mem_capacity": self._query_mem_capacity,
                # What the run ran with and where each value came from.
                "effective_tuning": {**self._effective, "sources": dict(self._effective_sources)},
                # Conformance advisories (identity / casing gaps) — present
                # only when a gap was detected, so a clean run's run_stats is
                # unchanged. Advisory-only: never flips the job off "completed".
                **({"advisories": advisories} if advisories else {}),
            },
        }

    def _cancel_check(self) -> None:
        if self._should_cancel is not None and self._should_cancel():
            from datetime import datetime, timezone
            from backend.app.services.aggregation.cancel import JobCancelled
            raise JobCancelled(
                job_id="<aggregation-pipeline>",
                observed_at=datetime.now(timezone.utc).isoformat(),
            )

    async def _checkpoint(self, phase: str, pos: int, *, phase_label: str) -> None:
        self._cancel_check()
        if self._progress_cb is None:
            return
        cursor = make_cursor(self._run_start_ms, phase, pos)
        args = (
            self._scanned, max(self._total, self._scanned), cursor,
            self._writes, phase_label,
        )
        live_stats: Dict[str, Any] = {"writes": self._writes, "deletes": self._deletes}
        # ~40 scalars: what the run runs with (sent every checkpoint so the
        # worker needs no acknowledgement) and what the ladder has changed
        # so far (only when it has).
        live_stats["effective_tuning"] = {**self._effective, "sources": dict(self._effective_sources)}
        adapted = self._adapted_snapshot()
        if adapted:
            live_stats["adapted"] = adapted
        from backend.app.services.aggregation.cancel import JobCancelled
        try:
            if self._cb_accepts_pct is False:
                await self._progress_cb(*args)
            else:
                try:
                    await self._progress_cb(
                        *args, progress_pct=self._progress_pct, stats=live_stats,
                    )
                    self._cb_accepts_pct = True
                except TypeError:
                    if self._cb_accepts_pct is True:
                        raise  # a genuine TypeError from inside the callback
                    self._cb_accepts_pct = False
                    await self._progress_cb(*args)
        except JobCancelled:
            raise
        except Exception as exc:
            # Progress reporting must never fail the materialization.
            logger.error(
                "aggregation checkpoint callback failed (continuing): %s",
                exc, exc_info=True,
            )

    async def _heartbeat(self) -> None:
        if self._intra_cb is None:
            return
        try:
            await self._intra_cb(self._writes)
        except Exception as exc:  # pragma: no cover - logging only
            logger.error(
                "aggregation heartbeat callback failed (continuing): %s", exc,
            )

    async def _paced_write(self, coro_factory: Callable[[], Awaitable[Any]]) -> Any:
        """Run one write query under distributed admission control, then
        sleep ``duration × pacing_ratio`` so this job never saturates the
        provider's write path — stretched to ``duration ×
        read_pressure_pacing_ratio`` while the web tier reports interactive
        reads starving on this endpoint. Interactive reads come first: a
        rebuild finishing later costs nobody a page; a canvas queued behind
        a MERGE batch costs every user of that graph."""
        admission = getattr(self.p, "_admission_controller", None)
        t0 = time.monotonic()
        if admission is not None:
            async with admission.write_slot(self.p):
                result = await coro_factory()
        else:
            result = await coro_factory()
        elapsed = time.monotonic() - t0
        # Wait for the replicas before the next batch. Their wait counts as
        # part of THIS write's duration, so the AIMD sizer and the pacing
        # sleep both see a replica-bound shard for what it is: a slow write
        # path that wants smaller batches and more room between them.
        elapsed += await self._replica_gate()

        # The ratio in force is the LIVE one (an operator can set
        # write_pacing_ratio on a running job; 0 means no pacing) — but read
        # pressure raises the floor regardless. Interactive reads starving is
        # a fact about the shard, not a preference about this job, so a job
        # told not to pace itself still yields while users are being starved.
        ratio = self._live_pacing_ratio()
        check = getattr(admission, "read_pressure", None)
        pressure = await check(self.p) if check is not None else None
        if pressure:
            ratio = max(ratio, self._read_pressure_pacing_ratio)
            self._read_pressure_yields += 1
        if bool(pressure) != self._yielding_to_reads:
            self._yielding_to_reads = bool(pressure)
            if pressure:
                logger.info(
                    "aggregation on %s yielding to interactive reads (%s): "
                    "write pacing ratio %g",
                    getattr(self.p, "_graph_name", "?"), pressure, ratio,
                )
            else:
                logger.info(
                    "aggregation on %s: read pressure cleared, write pacing ratio back to %g",
                    getattr(self.p, "_graph_name", "?"), ratio,
                )
        pace = elapsed * ratio
        if pace > 0:
            await asyncio.sleep(min(pace, 30.0))
        return elapsed, result

    # -- type resolution -----------------------------------------------------

    async def _observed_vocabulary(self) -> None:
        """Fetch the graph's OBSERVED relationship types and labels once
        per run. FalkorDB matching is case-SENSITIVE and the alias map is
        the only other spelling seam — a casing present in the graph but
        missing from the map was silently not scanned (and the worker
        injects no entity aliases at all). Probe failure ⇒ empty sets ⇒
        alias-only behavior."""
        rels: Set[str] = set()
        labels: Set[str] = set()
        try:
            res = await self.p._ro_query(
                "CALL db.relationshipTypes()", timeout=self._scan_timeout(),
            )
            rels = {str(r[0]) for r in (res.result_set or []) if r and r[0]}
            res = await self.p._ro_query(
                "CALL db.labels()", timeout=self._scan_timeout(),
            )
            labels = {str(r[0]) for r in (res.result_set or []) if r and r[0]}
        except Exception as exc:
            logger.info(
                "aggregation pipeline on %s: vocabulary probe failed (%s) "
                "— alias-map-only spelling matching this run.",
                self.p._graph_name, exc,
            )
        # The schema-catalog procedure can return EMPTY even when the graph
        # holds edges (a stale/partial catalog on some engines) — the exact
        # failure that left declared ``TO`` scanning nothing and folded the
        # hierarchy flat. Recover the observed vocabulary with the SAME
        # edge-type scan ``get_ontology_metadata`` already falls back to, so
        # the case-fold union below always has a real vocabulary to match
        # against. O(#edges), but only on the empty path (never for a healthy
        # catalog), and the scan-timeout still bounds it.
        if not rels:
            try:
                res = await self.p._ro_query(
                    "MATCH ()-[r]->() RETURN DISTINCT type(r)",
                    timeout=self._scan_timeout(),
                )
                rels = {str(r[0]) for r in (res.result_set or []) if r and r[0]}
                if rels:
                    logger.info(
                        "aggregation pipeline on %s: db.relationshipTypes() was "
                        "empty; recovered %d edge type(s) via edge scan.",
                        self.p._graph_name, len(rels),
                    )
            except Exception as exc:
                logger.warning(
                    "aggregation pipeline on %s: edge-type fallback scan failed "
                    "(%s) — declared casing only this run.",
                    self.p._graph_name, exc,
                )
        self._observed_rels = rels
        self._observed_labels = labels

    @staticmethod
    def _fold_expand(declared: List[str], observed: Set[str], *, kind: str) -> List[str]:
        """Union every observed case-fold variant of each declared
        spelling (a graph can hold SEVERAL casings of one type — scanning
        only one leaves broken containment chains / missing weights).
        Exact-case graphs are a no-op."""
        by_fold: Dict[str, List[str]] = {}
        for o in observed:
            by_fold.setdefault(o.casefold(), []).append(o)
        out = [str(d) for d in declared if d]
        have = set(out)
        for d in list(out):
            for variant in by_fold.get(d.casefold(), []):
                if variant not in have and variant != "AGGREGATED":
                    have.add(variant)
                    out.append(variant)
                    logger.info(
                        "aggregation pipeline: case-fold matched declared "
                        "%s type %r to observed %r", kind, d, variant,
                    )
        return out

    def _spellings_for_label(self, label: str) -> List[str]:
        """Every spelling to scan for one declared label: alias-map
        translations ∪ observed case-fold variants."""
        spellings = [
            str(s) for s in
            getattr(self.p, "_alias_entity_types", lambda t: t)([label])
        ]
        have = set(spellings)
        fold = str(label).casefold()
        for o in getattr(self, "_observed_labels", None) or ():
            if o.casefold() == fold and o not in have:
                have.add(o)
                spellings.append(o)
        return spellings

    async def _resolve_types(self) -> None:
        p = self.p
        await self._observed_vocabulary()
        if self._containment_arg:
            self._containment = list(p._alias_rel_types(list(self._containment_arg)))
        else:
            self._containment = list(p._get_containment_edge_types())
        self._containment = self._fold_expand(
            self._containment, self._observed_rels, kind="containment",
        )
        if self._lineage_arg:
            effective = p._alias_rel_types(
                [t for t in self._lineage_arg if t and t != "AGGREGATED"]
            )
        else:
            effective = await p._derive_lineage_types_from_cache(self._containment)
        effective = self._fold_expand(
            [str(t) for t in effective if t], self._observed_rels, kind="lineage",
        )
        # Sorted + deduped so edge-type bitmask indices are deterministic
        # across restarts of the same run.
        self._effective_types = sorted({str(t) for t in effective if t})
        self._type_bit = {t: 1 << i for i, t in enumerate(self._effective_types)}
        # Observability: the ACTUAL physical spellings this run will scan, after
        # alias translation + case-fold expansion. If the graph spells a type
        # differently from the ontology (declared HAS, physical Has), the folded
        # set MUST include the physical spelling or that type scans nothing.
        # "declared" is what froze on the job; the folded lists are what runs.
        logger.info(
            "aggregation pipeline on %s: scanning containment=%s lineage=%s "
            "(declared containment=%s lineage=%s; %d rel type(s) observed in graph)",
            self.p._graph_name,
            sorted(self._containment), self._effective_types,
            sorted(str(t) for t in (self._containment_arg or [])),
            sorted(str(t) for t in (self._lineage_arg or []) if t and t != "AGGREGATED"),
            len(self._observed_rels or ()),
        )
        # Completeness diagnosability: a declared/derived spelling that
        # matches NOTHING observed (not exact, not alias, not case-fold)
        # scans zero edges — silently missing aggregations would look
        # like an empty source. WARN with the leftovers.
        if self._observed_rels:
            observed_folds = {o.casefold() for o in self._observed_rels}
            unmatched = sorted(
                t for t in {*self._containment, *self._effective_types}
                if t not in self._observed_rels
                and t.casefold() not in observed_folds
            )
            if unmatched:
                # Surface on the job (run_stats advisory), not just the log.
                self._unmatched_types = unmatched
                logger.warning(
                    "aggregation pipeline on %s: %d edge-type spelling(s) "
                    "match NOTHING in the graph's observed vocabulary and "
                    "will scan zero edges: %s. Check the ontology's edge "
                    "types / source aliases.",
                    self.p._graph_name, len(unmatched),
                    ", ".join(unmatched[:8]),
                )

    # -- EXTRACT + COMPUTE -----------------------------------------------------

    async def _max_edge_id(self, cypher_pattern: str, *, proj: bool) -> int:
        q = f"MATCH {cypher_pattern} RETURN max(ID(r))"
        runner = self.p._proj_ro_query if proj else self.p._ro_query
        res = await runner(q, timeout=self._scan_timeout())
        rows = res.result_set or []
        if rows and rows[0] and rows[0][0] is not None:
            return int(rows[0][0])
        return -1

    async def _count_type(self, safe_type: str) -> int:
        res = await self.p._ro_query(
            f"MATCH ()-[r:`{safe_type}`]->() RETURN count(r)",
            timeout=self._scan_timeout(),
        )
        rows = res.result_set or []
        return int(rows[0][0] or 0) if rows and rows[0] else 0

    def _shrink_scan_width(
        self, width: int, floor: int, lo: int, hi: int,
        label: str, reason: str,
    ) -> None:
        """Halve the sticky effective scan width after a failed range."""
        half = max(floor, width // 2)
        if self._scan_subwidth is None or half < self._scan_subwidth:
            self._scan_subwidth = half
        if self._scan_min_width is None or half < self._scan_min_width:
            self._scan_min_width = half
        self._scan_shrinks += 1
        self._scan_success_streak = 0
        logger.warning(
            "aggregation pipeline on %s: scan %s [%d, %d) %s — shrinking "
            "effective range width to %d and re-fetching.",
            self.p._graph_name, label, lo, hi, reason, self._scan_subwidth,
        )

    # -- the pressure ladder -------------------------------------------------

    _SCAN_PROJECTIONS = {
        "extract:containers": "container directory (ID, identity, labels)",
        "apply:node-directory": "node directory (ID, identity, labels)",
        "reconcile:AGGREGATED": "current :AGGREGATED rollups (11 columns "
                                "including aggKey and sourceEdgeTypes)",
        "reconcile:lookup": ":AGGREGATED rollups by aggKey (index seek)",
        "reconcile:delete": "stale :AGGREGATED rollups by aggKey (UNWIND delete)",
        "apply:merge": ":AGGREGATED rollups (UNWIND MERGE by label pair)",
    }

    def _describe_scan(self, label: str) -> str:
        if label.startswith("extract:") and label not in self._SCAN_PROJECTIONS:
            return f"source edges of type {label[len('extract:'):]} (two IDs per row)"
        return self._SCAN_PROJECTIONS.get(label, label)

    def _on_pressure(self, label: str, kind: str, lo: int, hi: int, *, size: int) -> None:
        """Book-keeping shared by every ladder step: the first pressure
        event of a run pins wave concurrency to 1, and every event is
        recorded (bounded) for run_stats."""
        if self._scan_conc_cap is None:
            self._scan_conc_cap = 1
            logger.warning(
                "aggregation pipeline on %s: %s on %s — dropping wave "
                "concurrency to 1 for the rest of the run.",
                self.p._graph_name,
                "per-query memory refusal" if kind == "memory" else "query timeout",
                label,
            )
        event = {"scan": label, "kind": kind, "lo": lo, "hi": hi, "size": size}
        self._pressure_log.append(event)
        if len(self._pressure_log) > 8:
            del self._pressure_log[0]
        entry = self._by_scan.get(label)
        if entry is None and len(self._by_scan) < 12:
            entry = self._by_scan[label] = {"events": 0, "min_size": size, "kind": kind}
        if entry is not None:
            entry["events"] += 1
            entry["min_size"] = min(entry["min_size"], size)
            entry["kind"] = kind

    async def _ladder_heartbeat(self) -> None:
        """Heartbeat at most every 2s from inside the ladder, so a run that
        is reading one narrow slice at a time keeps the stall watchdog fed."""
        now = time.monotonic()
        if now - self._last_hb_mono >= 2.0:
            self._last_hb_mono = now
            await self._heartbeat()

    async def _retry_at_floor(
        self, attempt: Callable[[], Awaitable[Any]], *, label: str, lo: int, hi: int,
        size: int, budget: float,
    ) -> Any:
        """A minimum-size query that timed out: back off and re-issue up to
        ``AGGREGATION_SCAN_TIMEOUT_RETRIES`` times, heartbeating between
        attempts so the watchdog sees the wait as progress. When every
        attempt times out the graph store is not answering — raise
        :class:`MaterializationScanTimedOut` (a TimeoutError) so the worker
        resumes from the checkpoint through its ordinary outage path."""
        retries = _scan_timeout_retries()
        for n in range(retries):
            self._scan_timeout_retries += 1
            await self._heartbeat()
            delay = _backoff_s(n)
            logger.warning(
                "aggregation pipeline on %s: %s [%d, %d) timed out at its "
                "narrowest size (%d) — retry %d/%d after %.1fs.",
                self.p._graph_name, label, lo, hi, size, n + 1, retries, delay,
            )
            await asyncio.sleep(delay)
            self._cancel_check()
            try:
                return await attempt()
            except Exception as exc:
                if _pressure_kind(exc) != "timeout":
                    raise
        cap_ms = self._server_timeout_cap_ms()
        cap_text = f"{cap_ms / 1000:.0f}s" if cap_ms > 0 else "none"
        raise MaterializationScanTimedOut(
            f"scan {label} over ID range [{lo}, {hi}) (width {size}) timed out "
            f"{retries + 1} times in a row at the narrowest width (query timeout "
            f"{budget:.0f}s, graph store cap {cap_text}) — treating as a "
            f"graph-store outage; the job resumes from its checkpoint. Check the "
            f"graph store, then Resume; raise the scan timeout (scanTimeoutS) if "
            f"the store is merely slow, or run the Gentle profile if this recurs."
        )

    def _server_timeout_cap_ms(self) -> int:
        """The store's per-query time cap as the provider knows it — read
        from the node the graph lives on — else the env mirror. 0 = none."""
        fn = getattr(self.p, "_server_timeout_cap_ms", None)
        if callable(fn):
            return int(fn() or 0)
        from backend.app.config import resilience
        return int(getattr(resilience, "FALKORDB_SERVER_TIMEOUT_MAX_MS", 0) or 0)

    def _query_memory_guidance(
        self, label: str, lo: int, hi: int, *, kind: str = "scan", size: Optional[int] = None,
    ) -> str:
        """Terminal message for a minimum-size query-memory failure.

        Everything an operator needs must be HERE: ``run_stats`` is only
        persisted on a successful run, so on the terminal path the worker's
        ``job.error_message`` (``str(exc)``) is the entire record.

        Deliberately avoids the substrings ``classify_failure`` matches
        earlier than ``query_memory`` — ``OOM`` (case-sensitive, so no
        "headroom"/"room" either), ``timeout``, ``ontology``, ``conflict``
        — so this text cannot be mis-bucketed into someone else's
        resolution guidance."""
        size = (hi - lo) if size is None else size
        if kind == "scan":
            what = (
                f"scan {label} — {self._describe_scan(label)} — over ID range "
                f"[{lo}, {hi})"
            )
            unit = "row" if size == 1 else "rows"
            narrowed = (
                f"The pipeline had already dropped read concurrency to 1"
                + (
                    " and switched the reconcile to the keys-only strategy"
                    if self._reconcile_strategy == "keys_only" else ""
                )
                + f", and this slice is {size} {unit} wide"
            )
            if size <= 1:
                narrowed += (
                    ": a SINGLE row of this projection is larger than the "
                    "ceiling, so no narrower read exists"
                )
            else:
                narrowed += (
                    f": the descent was stopped at {size} by the scan floor "
                    f"(scanShrinkFloor / AGGREGATION_SCAN_SHRINK_FLOOR) — set it "
                    f"to 1 to let the ladder narrow to a single row"
                )
        else:
            what = (
                f"{kind} query {label} — {self._describe_scan(label)} — with "
                f"{size} rows"
            )
            narrowed = (
                f"The pipeline had already halved the batch down to {size} "
                f"rows, the smallest it issues"
            )
        cap = self._query_mem_capacity
        cap_text = f" ({human_bytes(cap)})" if cap else ""
        return (
            f"{what} exceeded the graph store's per-query memory ceiling "
            f"(QUERY_MEM_CAPACITY{cap_text}). The graph store reported: "
            f"\"Query's mem consumption exceeded capacity\". {narrowed}. The "
            f"engine buffers a query's whole result set inside that ceiling, "
            f"so this is deterministic and the job is NOT retried. "
            f"Fixes: (1) raise the server's QUERY_MEM_CAPACITY, but only "
            f"together with the container memory limit — see "
            f"docs/FALKORDB_DEPLOYMENT.md for the sizing formula, since the "
            f"ceiling is charged per concurrent query on top of maxmemory; "
            f"(2) the Gentle profile and Auto rollup storage lighten every "
            f"query BEFORE this point but cannot shrink one row — use them "
            f"once the ceiling has room for it."
        )

    def _adapted_snapshot(self) -> Dict[str, Any]:
        """What the ladder changed this run, bounded, for run_stats and the
        live overlay. Empty when the run ran at its settings."""
        out: Dict[str, Any] = {}
        if self._scan_subwidth is not None:
            out["scan_width"] = self._scan_subwidth
        if self._scan_min_width is not None:
            out["scan_width_min"] = self._scan_min_width
        if self._scan_shrinks:
            out["scan_shrinks"] = self._scan_shrinks
        if self._scan_conc_cap is not None:
            out["extract_concurrency"] = self._effective_conc()
        if self._reconcile_strategy != "full":
            out["reconcile_strategy"] = self._reconcile_strategy
        if self._write_cap.value is not None or self._write_cap.shrinks:
            out["write_batch"] = self._write_cap.value
            out["write_batch_min"] = self._write_cap.minimum
            out["write_shrinks"] = self._write_cap.shrinks
        if self._delete_cap.value is not None or self._delete_cap.shrinks:
            out["delete_chunk"] = self._delete_cap.value
            out["delete_chunk_min"] = self._delete_cap.minimum
            out["delete_shrinks"] = self._delete_cap.shrinks
        if self._scan_timeout_retries:
            out["timeout_retries"] = self._scan_timeout_retries
        if self._budget_rechecks:
            out["budget_rechecks"] = self._budget_rechecks
        if self._pressure_log:
            out["pressure"] = list(self._pressure_log)
        if self._by_scan:
            out["by_scan"] = {k: dict(v) for k, v in self._by_scan.items()}
        if self._hints_applied:
            out["from_last_run"] = dict(self._hints_applied)
        if self._outage_holds or self._node_restarts:
            out["store_outage_holds"] = self._outage_holds
            out["store_outage_s"] = round(self._outage_s, 1)
            if self._node_restarts:
                out["node_restarts"] = list(self._node_restarts)
        if self._replica_waits or self._replica_holds:
            out["replica_waits"] = self._replica_waits
            out["replica_wait_s"] = round(self._replica_wait_s, 1)
            if self._replica_holds:
                out["replica_holds"] = self._replica_holds
            if self._replica_max_lag_bytes:
                out["replica_max_lag_bytes"] = self._replica_max_lag_bytes
        if self._memory_flushes or self._memory_rollups:
            out["memory_flushes"] = self._memory_flushes
            out["memory_rollups"] = self._memory_rollups
            if self._rss_high_water_mb is not None:
                out["rss_high_water_mb"] = round(self._rss_high_water_mb)
            if self._mem_limit_mb is not None:
                out["mem_limit_mb"] = round(self._mem_limit_mb)
        # What an operator changed on the running job, in force now.
        live = {
            k: v for k, v in self._live.items()
            if isinstance(v, (int, float, str)) and not isinstance(v, bool)
        }
        if live:
            out["live"] = live
        return out

    async def _fetch_range(
        self, run_one: Callable[[int, int], Awaitable[list]],
        lo: int, hi: int, *, label: str,
    ) -> list:
        """Run one ID-range scan, absorbing per-query pressure until the
        query fits.

        Two signals are absorbed the same way — a per-query TIMEOUT (the
        client deadline or, far more often, the server's own ``Query timed
        out`` refusal) and the per-query MEMORY ceiling
        (``Query's mem consumption exceeded capacity``): the first event of
        the run pins wave concurrency to 1; a RECONCILE scan switches to the
        keys-only strategy once halving would take it under
        ``AGGREGATION_RECONCILE_KEYS_ONLY_WIDTH``; otherwise the sticky
        effective width halves and the slice is re-fetched, down to the
        floor (default 1 row). The sticky width re-grows after sustained
        successes, never straight back into a width that failed for this
        scan (``_next_scan_width``).

        At the floor the two diverge: a timeout is retried with backoff and
        heartbeats and only then declared an outage
        (:class:`MaterializationScanTimedOut`, resumable); a memory
        failure on a single row is a fact no retry can alter and raises the
        terminal :class:`MaterializationQueryMemoryExceeded` naming the
        scan. Every sub-range heartbeats and honours a cancel, so however
        narrow the ladder goes the watchdog sees progress."""
        floor = self._scan_floor
        width = hi - lo
        sticky = self._scan_subwidth
        live_cap = self._live_scan_width()
        if live_cap is not None:
            sticky = live_cap if sticky is None else min(sticky, live_cap)
        if sticky is not None and width > sticky:
            rows: list = []
            cur = lo
            while cur < hi:
                self._cancel_check()
                await self._ladder_heartbeat()
                rows.extend(await self._fetch_range(
                    run_one, cur, min(cur + sticky, hi), label=label,
                ))
                cur = min(cur + sticky, hi)
            return rows
        try:
            rows = await self._through_outage(lambda: run_one(lo, hi), op=label)
        except Exception as exc:
            kind = _pressure_kind(exc)
            if kind is None:
                raise
            self._on_pressure(label, kind, lo, hi, size=width)
            reason = (
                "exceeded the per-query memory ceiling" if kind == "memory"
                else "timed out"
            )
            if (
                label == "reconcile:AGGREGATED"
                and self._reconcile_strategy == "full"
                and max(floor, width // 2) <= _reconcile_keys_only_width()
            ):
                # Halving the 11-column projection again would cost more
                # queries than reading keys only at this width: switch
                # strategy instead and re-read the same slice.
                self._reconcile_strategy = "keys_only"
                self._scan_success_streak = 0
                logger.warning(
                    "aggregation pipeline on %s: reconcile scan [%d, %d) %s — "
                    "switching to the keys-only reconcile strategy at width %d.",
                    self.p._graph_name, lo, hi, reason, width,
                )
                return await self._fetch_range(run_one, lo, hi, label=label)
            if width > floor:
                self._scan_fail_width[label] = min(
                    width, self._scan_fail_width.get(label, width),
                )
                self._shrink_scan_width(width, floor, lo, hi, label, reason)
                return await self._fetch_range(run_one, lo, hi, label=label)
            if kind == "memory":
                logger.error(
                    "aggregation pipeline on %s: narrowest scan %s [%d, %d) "
                    "still exceeded the per-query memory ceiling — failing "
                    "terminally.", self.p._graph_name, label, lo, hi,
                )
                raise MaterializationQueryMemoryExceeded(
                    self._query_memory_guidance(label, lo, hi)
                ) from exc
            logger.error(
                "aggregation pipeline on %s: narrowest scan %s [%d, %d) "
                "timed out — retrying with backoff before declaring an outage.",
                self.p._graph_name, label, lo, hi,
            )
            rows = await self._retry_at_floor(
                lambda: run_one(lo, hi), label=label, lo=lo, hi=hi, size=width,
                budget=self._scan_timeout(),
            )
        self._scan_success_streak += 1
        if self._scan_subwidth is not None:
            ceiling = self._knob_int(
                "scan_range_width", _scan_range_width, 10_000, 5_000_000,
            )
            nxt = _next_scan_width(
                self._scan_subwidth, ceiling, self._scan_fail_width.get(label),
                self._scan_success_streak,
            )
            if nxt != self._scan_subwidth:
                self._scan_success_streak = 0
                self._scan_subwidth = nxt
                logger.info(
                    "aggregation pipeline on %s: scans healthy — effective "
                    "range width back to %s.",
                    self.p._graph_name, self._scan_subwidth or ceiling,
                )
        return rows

    async def _scan_type_ranges(self, safe_type: str, *, proj: bool = False):
        """Yield ``(range_lo, rows)`` for one edge type in fixed ID-range
        partitions, fetched in bounded-concurrency WAVES.

        ``WHERE ID(r) >= lo AND ID(r) < hi`` with no ORDER BY / LIMIT: each
        range is one relation-matrix iteration with a cheap ID filter, so a
        full scan costs O(E × ranges) matrix hops instead of the legacy
        O(E²) sorted re-scans. Ranges are deterministic → resumable. Waves
        of ``extract_concurrency`` read-only queries run in parallel —
        FalkorDB serves reads on THREAD_COUNT threads, so this hides the
        per-range round-trip latency without touching the write path.
        """
        width = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        max_id = await self._max_edge_id(f"()-[r:`{safe_type}`]->()", proj=proj)
        runner = self.p._proj_ro_query if proj else self.p._ro_query

        async def run_one(lo: int, hi: int):
            res = await runner(
                f"MATCH (s)-[r:`{safe_type}`]->(t) "
                f"WHERE ID(r) >= $lo AND ID(r) < $hi "
                f"RETURN ID(s), ID(t)",
                params={"lo": lo, "hi": hi},
                timeout=self._scan_timeout(),
            )
            return res.result_set or []

        async def fetch(lo: int):
            return lo, await self._fetch_range(
                run_one, lo, lo + width, label=f"extract:{safe_type}",
            )

        lows = list(range(0, max_id + 1, width))
        start = 0
        while start < len(lows):
            self._cancel_check()
            # Re-read per wave: the ladder pins concurrency to 1 after the
            # first pressure event, and that must take effect at the NEXT
            # wave boundary, not at the next phase.
            wave = lows[start:start + self._effective_conc()]
            start += len(wave)
            results = await asyncio.gather(*(fetch(lo) for lo in wave))
            for lo, rows in results:
                yield lo, rows

    async def _extract_and_compute(self) -> None:
        """Load containment into a child→parent map, stream lineage edges
        into a raw-pair base map, and roll the base up through the ancestor
        lattice into the final accumulator — all in worker memory."""
        from backend.app.providers.falkordb_provider import _sanitize_label

        # ---- containment → parent DAG (child_id → all parent_ids) ----
        parent_lists: Dict[int, List[int]] = {}
        multi_parent_count = 0
        for ctype in sorted({str(t) for t in self._containment if t}):
            safe = _sanitize_label(ctype)
            async for _lo, rows in self._scan_type_ranges(safe):
                for parent_id, child_id in rows:
                    if parent_id is None or child_id is None:
                        continue
                    parent_id, child_id = int(parent_id), int(child_id)
                    existing = parent_lists.get(child_id)
                    if existing is None:
                        parent_lists[child_id] = [parent_id]
                    elif parent_id not in existing:
                        if len(existing) == 1:
                            multi_parent_count += 1
                        existing.append(parent_id)
        parents: Dict[int, Tuple[int, ...]] = {
            c: tuple(ps) for c, ps in parent_lists.items()
        }
        self._break_cycles(parents)
        self._parents = parents
        # Closures/depths derive from the fresh parent map.
        self._closure_memo = {}
        self._depth_memo = {}
        logger.info(
            "aggregation pipeline on %s: containment loaded — %d child→parent "
            "entries (%d multi-parent nodes, every ancestry kept).",
            self.p._graph_name, len(parents), multi_parent_count,
        )

        # ---- materialization mode + structural boundary ----
        await self._decide_materialization_mode()
        await self._load_nonleaf_ids()

        # ---- total lineage count (honest processed/total display) ----
        totals = 0
        for etype in self._effective_types:
            totals += await self._count_type(_sanitize_label(etype))
        self._total = totals

        # ---- stream lineage edges → base map → lattice roll-ups ----
        values = self._values
        cap = self._pair_cap()
        base: Dict[int, int] = {}

        for etype in self._effective_types:
            type_bit = self._type_bit[etype]
            safe = _sanitize_label(etype)
            async for _lo, rows in self._scan_type_ranges(safe):
                for sid, tid in rows:
                    if sid is None or tid is None:
                        continue
                    key = _pack(int(sid), int(tid))
                    cur = base.get(key)
                    base[key] = (
                        values.make(1, type_bit) if cur is None
                        else values.merge(cur, 1, type_bit)
                    )
                self._scanned += len(rows)
                if self._total < self._scanned:
                    self._total = self._scanned
                self._progress_pct = min(
                    45, int(45 * self._scanned / self._total) if self._total else 0,
                )
                await self._checkpoint(
                    PHASE_AGGREGATE, self._scanned, phase_label="extracting",
                )
                if len(base) >= cap or (
                    len(base) >= self._flush_min_pairs and self._memory_pressure()
                ):
                    # Roll-ups are linear: rolling partial bases and summing
                    # equals rolling the whole base. Collapse now to bound
                    # memory; the accumulator merges across partials (and
                    # flushes on memory pressure as it goes).
                    if len(base) < cap:
                        self._memory_rollups += 1
                    await self._rollup_base(base)
                    base = {}

        self._progress_pct = 45
        self._mark_phase("compute_s")
        await self._checkpoint(
            PHASE_AGGREGATE, self._scanned, phase_label="computing",
        )
        await self._rollup_base(base)
        self._progress_pct = 55
        await self._checkpoint(
            PHASE_AGGREGATE, self._scanned, phase_label="computing",
        )

    @staticmethod
    def _break_cycles(parents: Dict[int, Tuple[int, ...]]) -> None:
        """Defensively break containment cycles (bad data) so DAG walks
        terminate. Removes exactly the parent LINK that closes each
        detected cycle — other parents of the same child survive."""
        state: Dict[int, int] = {}  # 0 = on current DFS path, 1 = done
        for start in list(parents.keys()):
            if state.get(start) == 1:
                continue
            state[start] = 0
            stack: List[Tuple[int, Any]] = [
                (start, iter(parents.get(start, ()))),
            ]
            while stack:
                cur, it = stack[-1]
                advanced = False
                for p in it:
                    s = state.get(p)
                    if s == 0 or p == cur:
                        # ``cur → p`` closes a cycle (or self-parents) — cut
                        # this one link only.
                        remaining = tuple(x for x in parents[cur] if x != p)
                        if remaining:
                            parents[cur] = remaining
                        else:
                            del parents[cur]
                        logger.warning(
                            "aggregation pipeline: containment cycle detected "
                            "at node %d; breaking parent link %d→%d.",
                            p, cur, p,
                        )
                        continue
                    if s == 1:
                        continue
                    if p not in parents:
                        state[p] = 1  # root: nothing above to explore
                        continue
                    state[p] = 0
                    stack.append((p, iter(parents[p])))
                    advanced = True
                    break
                if not advanced:
                    stack.pop()
                    state[cur] = 1

    async def _rollup_base(self, base: Dict[int, int]) -> None:
        """Merge every materialized cell derived from one (partial) base
        map into the run accumulator.

        With the boundary active (``self._nonleaf_levels`` loaded), each
        raw pair produces its CANONICAL DEPTH-BRIDGED pairs via the shared
        ``pair_rules.boundary_pairs`` rule: for every containment depth
        present on either side's non-leaf ancestry, pair each side's reps
        at its deepest depth ≤ that rank. On aligned single-parent chains
        this is exactly the same-depth diagonal (table→table,
        domain→domain); ragged chains yield the mixed-depth cell the
        canvas shows at each granularity; multi-parent nodes contribute a
        rep SET per depth, so every ancestry is linked.

        Without the boundary (cube mode) ``pair_rules.cube_pairs`` merges
        the full ancestor-closure cross-product; the (0,0) raw mirror is
        included only when ``AGGREGATION_MATERIALIZE_LEAF_PAIRS`` is on.
        Closures have SET semantics, so a diamond's shared grandparent
        receives each raw edge's weight exactly once. Equal-endpoint
        pairs are excluded in both modes (legacy ``sa == ta`` parity).
        """
        if not base:
            return
        values = self._values

        if self._nonleaf_levels is not None:
            await self._merge_canonical_pairs(base)
            return

        include_mirror = self._knob_bool(
            "materialize_leaf_pairs", _materialize_leaf_pairs,
        )
        acc = self._acc
        n = 0
        for key, val in base.items():
            sid, tid = _unpack(key)
            s_cl = self._closure(sid)
            t_cl = self._closure(tid)
            for sp, tp in cube_pairs(
                s_cl, t_cl, include_leaf_mirror=include_mirror, s=sid, t=tid,
            ):
                nk = _pack(sp, tp)
                cur = acc.get(nk)
                acc[nk] = val if cur is None else values.merge(
                    cur, values.weight(val), values.mask(val),
                )
            n += 1
            if n % 1024 == 0:
                await self._maybe_overflow_flush()
                # The flush swaps self._acc for a fresh dict — rebind or
                # every later merge lands in the orphaned snapshot and is
                # silently discarded (missing edges, undercounted weights).
                acc = self._acc
                await asyncio.sleep(0)  # yield during long CPU stretches
        await self._maybe_overflow_flush()

    def _closure(self, node: int) -> Dict[int, int]:
        """Ancestors-or-self → containment depth for ``node``. Container
        closures are memoized (every strict ancestor is a containment
        parent, so the memo is bounded by container count); a leaf's own
        entry is evicted after the call so leaf-count never inflates it."""
        struct = self._struct_parents or set()
        closure = ancestor_closure(self._parents, node, memo=self._closure_memo)
        if node not in struct:
            self._closure_memo.pop(node, None)
        return closure

    def _depth_of(self, node: int) -> int:
        """Containment depth of ANY node (roots and uncontained nodes 0,
        child = 1 + max over parents — the same rule the closures use).
        One int per touched node; feeds the boundary ranks and the
        sourceDepth/targetDepth stamps in both modes. Assumes
        ``_break_cycles`` already ran (the parent map is acyclic)."""
        memo = self._depth_memo
        hit = memo.get(node)
        if hit is not None:
            return hit
        parents = self._parents
        stack: List[int] = [node]
        while stack:
            cur = stack[-1]
            if cur in memo:
                stack.pop()
                continue
            pending = [
                p for p in parents.get(cur, ())
                if p != cur and p not in memo
            ]
            if pending:
                stack.extend(pending)
                continue
            ps = [p for p in parents.get(cur, ()) if p != cur]
            memo[cur] = 1 + max(memo[p] for p in ps) if ps else 0
            stack.pop()
        return memo[node]

    def _rep_set(self, node: int) -> Dict[int, int]:
        """Non-leaf ancestors-or-self of ``node`` with containment depths
        — one side's input to the shared ``boundary_pairs`` rule. Leaf
        endpoints contribute their full container ancestry (the closure
        walks through leaf-only gaps); isolated leaves yield {}."""
        struct = self._struct_parents or set()
        return {
            a: d for a, d in self._closure(node).items() if a in struct
        }

    async def _merge_canonical_pairs(self, base: Dict[int, int]) -> None:
        """Boundary-mode rollup: canonical depth-bridged pairs per raw
        pair via the shared rule. Weight semantics: each raw pair's value
        contributes ONCE to each distinct canonical pair (a pair repeated
        across ranks — the ragged case — is merged once; a diamond's
        shared ancestor is merged once)."""
        values = self._values
        acc = self._acc
        skipped = 0
        n = 0
        for key, val in base.items():
            sid, tid = _unpack(key)
            pairs = boundary_pairs(self._rep_set(sid), self._rep_set(tid))
            if not pairs:
                skipped += 1
                continue
            for sp, tp in pairs:
                nk = _pack(sp, tp)
                cur = acc.get(nk)
                acc[nk] = val if cur is None else values.merge(
                    cur, values.weight(val), values.mask(val),
                )
            n += 1
            if n % 4096 == 0:
                await self._maybe_overflow_flush()
                # The flush swaps self._acc for a fresh dict — rebind or
                # every later merge lands in the orphaned snapshot and is
                # silently discarded (missing edges, undercounted weights).
                acc = self._acc
                await asyncio.sleep(0)
        self._fine_merges_skipped += skipped
        await self._maybe_overflow_flush()

    async def _server_now_ms(self) -> int:
        """FalkorDB server clock. ``latestUpdate`` is stamped with the
        server's ``timestamp()``, so the reconcile delete guard
        (``latestUpdate < run_start``) must compare within the SAME clock
        domain — a worker clock a few seconds ahead of the DB would let
        the guard delete a concurrent ``on_lineage_edge_written`` write.
        Falls back to local time if the probe fails."""
        try:
            res = await self.p._proj_ro_query(
                "RETURN timestamp()", timeout=self._scan_timeout(),
            )
            rows = res.result_set or []
            if rows and rows[0] and rows[0][0] is not None:
                return int(rows[0][0])
        except Exception as exc:
            logger.warning(
                "aggregation pipeline on %s: server clock probe failed "
                "(%s) — using worker clock for run_start.",
                self.p._graph_name, exc,
            )
        return int(time.time() * 1000)

    def _pair_cap(self) -> int:
        return self._knob_int("max_pending_pairs", _max_pending_pairs, 50_000, 50_000_000)

    # -- capacity: the owning shard decides, the operator overrides ----------

    def _explicit_ceiling(self) -> Optional[int]:
        """``maxMaterializedEdges`` only when tuning set it — an operator's
        ceiling on the TOTAL, layered over whichever rule governs."""
        raw = self._tuning.get("max_materialized_edges")
        if raw is None:
            return None
        try:
            return max(10_000, min(_MAX_EDGES_BOUND, int(raw)))
        except (TypeError, ValueError):
            return None

    def _static_cap(self) -> int:
        """The count rule that governs when the shard cannot be measured:
        the explicit ceiling if set, else the env default."""
        return self._explicit_ceiling() or _max_materialized_edges()

    def _governing_allowance(self) -> int:
        """For ``run_stats``: how many edges the rule in force allowed."""
        b = self._last_budget
        if b is not None and b.governed_by == "shard":
            return int(b.allowed_growth_edges or 0)
        return self._static_cap()

    async def _read_shard(self) -> ShardMemory:
        """The shard that owns the graph the rollups land on — the
        projection graph in dedicated mode, which may live on a different
        shard from the source graph. Read through the client the provider
        holds NOW and never cached: a failover rebuilds that client, and
        re-reading is what follows it."""
        p = self.p
        dedicated = getattr(p, "_projection_mode", None) == "dedicated"
        db = (getattr(p, "_proj_db", None) if dedicated else None) or getattr(p, "_db", None)
        key = f"{p._graph_name}_proj" if dedicated else p._graph_name
        cfg = getattr(p, "_conn_cfg", None)
        return await read_shard_memory(
            db, mode=getattr(cfg, "mode", None), graph_key=key,
            timeout=float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
        )

    async def _budget(self) -> WriteBudget:
        """A fresh reading plus the operator's limits. Bytes per edge:
        tuning → what a previous run of this graph measured → env."""
        shard = await self._read_shard()
        cap = getattr(shard, "query_mem_capacity", None)
        if cap:
            self._query_mem_capacity = int(cap)
        # Teach the provider what the node the rollups land on allows, so
        # its per-query clamp follows the server (a cap raised at runtime
        # from Infrastructure) rather than the env mirror.
        note = getattr(self.p, "note_server_limits", None)
        if note is not None:
            note(
                shard.endpoint,
                timeout_max_ms=getattr(shard, "timeout_max_ms", None),
                query_mem_capacity=cap or None,
                thread_count=getattr(shard, "thread_count", None),
                timeout_default_ms=getattr(shard, "timeout_default_ms", None),
            )
        raw_bpe = self._tuning.get("bytes_per_edge")
        hint = self._capacity_hints.get("bytes_per_edge_observed")
        if raw_bpe is not None:
            bpe, source = raw_bpe, "tuning"
        elif hint:
            bpe, source = hint, "calibrated"
        else:
            bpe, source = None, "default"
        reserved_bytes, reserved_count = await self._reserved_by_others(shard)
        budget = compute_write_budget(
            shard,
            reserve_pct=self._tuning.get("shard_reserve_pct"),
            bytes_per_edge=bpe, bpe_source=source,
            explicit_ceiling=self._explicit_ceiling(),
            static_cap=self._static_cap(),
            reserved_bytes=reserved_bytes, reserved_count=reserved_count,
        )
        self._last_budget = budget
        return budget

    def _ledger(self, shard: ShardMemory) -> Optional[Any]:
        """The admission controller, when there is one and the node it
        would keep a ledger for is known and measurable."""
        admission = getattr(self.p, "_admission_controller", None)
        if admission is None or not shard.measurable or shard.endpoint == "unknown":
            return None
        return admission

    async def _reserved_by_others(self, shard: ShardMemory) -> Tuple[int, int]:
        """What other rebuilds hold in the node's ledger — allowed to write,
        not yet in ``used``. ``(0, 0)`` without a controller or a bus."""
        admission = self._ledger(shard)
        read = getattr(admission, "reserved_by_others", None)
        if read is None:
            return 0, 0
        return await read(shard.endpoint, self._job_id)

    async def _reserve(self, shard: ShardMemory, nbytes: int) -> None:
        """Hold what this job may still write in the node's ledger, so a
        rebuild racing onto the same node budgets against it too. The
        figure is what ``used`` does not show yet: the whole growth before
        the apply, one wave for an overflow flush, the remainder at a
        mid-apply recheck — replaced, never summed. Fail-open like the
        rest of admission: no bus, nothing held."""
        admission = self._ledger(shard)
        if admission is None:
            return
        if self._reservation is not None and self._reservation.endpoint != shard.endpoint:
            await admission.release(self._reservation)      # the graph moved (failover)
            self._reservation = None
        if self._reservation is None:
            reserve = getattr(admission, "reserve", None)
            if reserve is not None:
                self._reservation = await reserve(shard.endpoint, self._job_id, nbytes)
        else:
            await admission.update(self._reservation, nbytes)

    async def _count_aggregated(self) -> int:
        """How many :AGGREGATED edges the graph holds — what a rebuild
        re-materialises rather than grows. Best-effort: unknown reads as 0,
        which budgets every cell as growth (the conservative direction)."""
        try:
            res = await self.p._proj_ro_query(
                "MATCH ()-[r:AGGREGATED]->() RETURN count(r)",
                timeout=self._scan_timeout(),
            )
            rows = res.result_set or []
            return int(rows[0][0] or 0) if rows and rows[0] else 0
        except Exception as exc:
            logger.info(
                "aggregation pipeline on %s: existing rollup count unavailable "
                "(%s) — budgeting every cell as growth.", self.p._graph_name, exc,
            )
            return 0

    async def _capacity_baseline(self) -> None:
        """E0 for the growth budget on every run; the shard's ``used`` for
        the calibration on a FRESH run only (a resumed run's start is gone).
        Also the run's first look at how the write node replicates."""
        self._edges_before = await self._count_aggregated()
        if self._fresh_run:
            shard = await self._read_shard()
            self._used_before = shard.used if shard.measurable else None
        await self._check_replication_shape()

    async def _check_replication_shape(self) -> None:
        """Warn when this shard's replicas will RE-RUN every rollup batch.

        FalkorDB ships a write to its replicas as a compact change log only
        when the average time per modification exceeds ``EFFECTS_THRESHOLD``
        (300 µs by default). A rollup batch is thousands of cheap MERGEs, so
        it falls below that and each replica repeats the whole query on its
        main thread, answering no health check while it works. The rebuild
        still completes — it paces itself against the acknowledgements — but
        the fix is one setting, so the run says so.
        """
        state = await self._replication_state()
        attached = int(state.get("connectedReplicas") or 0)
        if attached <= 0:
            return
        self._note_replica_lag(state)
        shard = self._last_budget.shard if self._last_budget is not None else None
        threshold = getattr(shard, "effects_threshold_us", None) if shard else None
        if threshold is None:
            threshold = getattr(await self._read_shard(), "effects_threshold_us", None)
        if threshold is None or threshold <= 0:
            return
        endpoint = getattr(shard, "endpoint", None) or self.p._endpoint_label()
        self._replication_advisory = {
            "kind": "effects_threshold",
            "endpoint": endpoint,
            "effects_threshold_us": int(threshold),
            "replicas": attached,
            "detail": (
                f"{attached} replica(s) of {endpoint} re-run every rollup write on "
                f"their main thread (effects threshold {threshold} µs). Set it to 0 "
                f"from Admin → Graph store so they apply a change log instead."
            ),
        }
        logger.warning(
            "aggregation pipeline on %s: %s",
            self.p._graph_name, self._replication_advisory["detail"],
        )

    async def _calibrate(self) -> None:
        """What this run actually cost the shard per NEW edge, for the next
        run's budget. The gates (fresh run, material growth, positive delta,
        clamp) live in ``shard_capacity``; the outcome lands in run_stats
        either way, so a run that could not calibrate says why."""
        if not self._fresh_run:
            self._calibration = {"calibration": "skipped_resume"}
            return
        if self._used_before is None:
            self._calibration = {"calibration": "skipped_unmeasured"}
            return
        shard = await self._read_shard()
        edges_after = await self._count_aggregated()
        observed = calibrate_bytes_per_edge(
            used_before=self._used_before,
            used_after=shard.used if shard.measurable else None,
            edges_before=self._edges_before, edges_after=edges_after,
        )
        self._calibration = (
            {"bytes_per_edge_observed": observed, "calibration": "measured"}
            if observed is not None else {"calibration": "skipped_small_growth"}
        )

    def _memory_pressure(self) -> bool:
        """True when the worker's RSS is at or over the flush share of its
        cgroup limit. Fail-open: an unknown RSS or no limit reads as no
        pressure, and the pair cap still bounds memory. Records the peak
        RSS and the limit for the run's record."""
        rss, limit = self._mem.sample()
        if rss is None or limit is None:
            return False
        self._rss_high_water_mb = max(self._rss_high_water_mb or 0.0, rss)
        self._mem_limit_mb = limit
        return rss * 100.0 >= limit * self._flush_pct

    def _should_flush(self, size: int) -> Tuple[bool, str]:
        """Whether the accumulator (``size`` pairs) flushes now, and why:
        ``"cap"`` at the pair cap, ``"memory"`` when the worker is under
        memory pressure with enough pairs to make a flush worth its writes."""
        if size >= self._pair_cap():
            return True, "cap"
        if size >= self._flush_min_pairs and self._memory_pressure():
            return True, "memory"
        return False, ""

    async def _maybe_overflow_flush(self) -> None:
        """Early-apply the accumulator when it exceeds the pair cap, or when
        the worker is under memory pressure (``_should_flush``).

        The first flush of a key this run OVERWRITES the stored weight
        (discarding any stale value or prior attempt's partial); repeat
        flushes ADD. Flushed edges carry ``latestUpdate >= run_start_ms``
        so the reconcile delete pass never removes them. Weights therefore
        stay EXACT across flushes and across restart-from-zero resumes."""
        flush, reason = self._should_flush(len(self._acc))
        if not flush:
            return
        if reason == "memory":
            self._memory_flushes += 1
        flushed = self._flushed
        overwrite = [k for k in self._acc if k not in flushed]
        add = [k for k in self._acc if k in flushed]
        # This wave's growth is exactly its first-touch keys; the shard is
        # re-read, so the waves before it are already inside ``used``.
        await self._check_write_budget(wave=overwrite)
        if reason == "memory":
            logger.info(
                "aggregation pipeline on %s: worker at %.0f MB of its %.0f MB limit "
                "(flush at %d%%) with %d pending pairs — early flush on memory "
                "(%d first-touch overwrite, %d add).",
                self.p._graph_name, self._rss_high_water_mb or 0.0, self._mem_limit_mb or 0.0,
                self._flush_pct, len(self._acc), len(overwrite), len(add),
            )
        else:
            logger.info(
                "aggregation pipeline on %s: accumulator hit cap %d — early "
                "flush (%d first-touch overwrite, %d add).",
                self.p._graph_name, self._pair_cap(), len(overwrite), len(add),
            )
        snapshot = self._acc
        self._acc = {}
        await self._write_keys(snapshot, overwrite, weight_mode="overwrite")
        await self._write_keys(snapshot, add, weight_mode="add")
        flushed.update(snapshot.keys())


    # -- STRUCTURAL materialization boundary ----------------------------------

    def _fine_mode(self) -> str:
        """Resolved materialization mode: job tuning (bool or "auto")
        beats the env tri-state."""
        raw = self._tuning.get("materialize_fine_pairs")
        if raw is None:
            return _materialize_fine_pairs_mode()
        if isinstance(raw, str) and raw.strip().lower() == "auto":
            return "auto"
        return "true" if raw else "false"

    def _fine_filter_active(self) -> bool:
        """True when the structural depth-diagonal boundary is in force
        (cube mode OFF). Valid only after _decide_materialization_mode."""
        if not getattr(self, "_struct_parents", None):
            return False
        return not bool(self._cube_mode)

    def _cell_ratio(self) -> Optional[float]:
        """Distinct cells this source stores per cell the estimate counts.

        Measured by the last complete run and carried on the state row. It is
        a property of the graph's SHAPE — how much lineage repeats between the
        same pair of containers — so it is stable run to run in a way the
        absolute counts are not.

        None means never measured, and a None ratio may not refuse anything.
        Clamped to (0, 1]: the estimate is a sound upper bound, so a ratio
        above 1 would mean one of the two numbers is not what it claims, and
        the answer to that is to distrust the correction, not to act on it.
        """
        raw = self._capacity_hints.get("cell_ratio_observed")
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None
        if not (0.0 < value <= 1.0):
            logger.warning(
                "aggregation pipeline on %s: stored cell ratio %r is outside "
                "(0, 1] — ignoring it and treating this run as uncalibrated.",
                self.p._graph_name, raw,
            )
            return None
        return value

    def _corrected_estimate(self, upper: int, ratio: Optional[float]) -> int:
        """The upper bound scaled by what this source actually stores.

        Uncalibrated, the upper bound stands as-is — it is still the honest
        thing to REPORT, it simply may not be used to refuse.
        """
        if ratio is None:
            return upper
        return max(1, int(upper * ratio)) if upper > 0 else 0

    def _observed_cell_ratio(self, exact_cells: int) -> Optional[float]:
        """What this run just taught us, for the next one to start from.

        Only from a run that computed BOTH numbers: no estimate pass (the
        mode was decided without one) or no cells means nothing to learn, and
        writing a ratio from half a measurement would be worse than none.
        """
        upper = getattr(self, "_cube_estimate_upper", None)
        if not upper or upper <= 0 or exact_cells <= 0:
            return None
        ratio = exact_cells / upper
        if not (0.0 < ratio <= 1.0):
            # The "upper bound" was exceeded, so it is not one. Say so loudly
            # rather than storing a correction that would inflate next time.
            logger.warning(
                "aggregation pipeline on %s: %d cells stored against an upper "
                "bound of %d — the bound is not bounding. Not calibrating.",
                self.p._graph_name, exact_cells, upper,
            )
            return None
        return round(ratio, 6)

    async def _decide_materialization_mode(self) -> None:
        """Pick cube vs boundary for this run (see
        ``_materialize_fine_pairs_mode``). The auto estimator is one
        counting scan over the raw lineage edges: Σ (ancestors(src)+1) ×
        (ancestors(tgt)+1) — a conservative upper bound on distinct cube
        cells (dedupe only shrinks it), so auto can never pick a cube
        that terminally exceeds the budget."""
        self._struct_parents = {
            p for ps in self._parents.values() for p in ps
        }
        if not self._struct_parents and self._containment:
            # Containment types are DECLARED but matched zero edges. If
            # the graph holds rollup cells, EITHER mode would recompute a
            # result without container cells and reconcile would delete
            # every stored one as stale. Refuse loudly (types/alias/
            # casing problem) instead of wiping.
            probe = await self.p._proj_ro_query(
                "MATCH ()-[r:AGGREGATED]->() RETURN 1 LIMIT 1",
                timeout=self._scan_timeout(),
            )
            if probe.result_set:
                raise MaterializationPreconditionFailed(
                    "declared containment edge types matched ZERO edges in "
                    "the graph, but :AGGREGATED rollups exist — continuing "
                    "would recompute a leaf-only result and delete every "
                    "stored container cell as stale. Check the ontology's "
                    "containment types / source aliases / casing."
                )
        mode = self._fine_mode()
        if not self._struct_parents:
            # No containment at all: the lattice degenerates to the leaf
            # mirror; the boundary has nothing to rank. Legacy path.
            self._cube_mode = True
            return
        if mode == "false":
            self._cube_mode = False
            return
        # Forced full detail used to skip the estimate and fail mid-apply,
        # leaving a partial cube over the previous generation's cells. It
        # now pays the same counting scan Auto does, so a cube the owning
        # shard cannot take is refused BEFORE compute and before any write.
        forced = mode == "true"
        parents = self._parents
        cnt_memo: Dict[int, int] = {}

        def anc_count(node: int) -> int:
            """Upper bound on |ancestors-or-self| over the containment DAG:
            1 + Σ over parents. Exact on single-parent chains; diamonds
            overcount shared ancestors, which only PUSHES the estimate up —
            auto can still never pick a cube that exceeds the budget, and
            an int-per-node memo keeps the counting scan linear."""
            hit = cnt_memo.get(node)
            if hit is not None:
                return hit
            stack: List[int] = [node]
            while stack:
                cur = stack[-1]
                if cur in cnt_memo:
                    stack.pop()
                    continue
                pending = [
                    p for p in parents.get(cur, ())
                    if p != cur and p not in cnt_memo
                ]
                if pending:
                    stack.extend(pending)
                    continue
                cnt_memo[cur] = 1 + sum(
                    cnt_memo[p] for p in parents.get(cur, ()) if p != cur
                )
                stack.pop()
            return cnt_memo[node]

        from backend.app.providers.falkordb_provider import _sanitize_label
        estimate = 0
        for etype in self._effective_types:
            safe = _sanitize_label(etype)
            async for _lo, rows in self._scan_type_ranges(safe):
                for sid, tid in rows:
                    if sid is None or tid is None:
                        continue
                    estimate += (anc_count(int(sid))) * (anc_count(int(tid)))
        # What was just summed is cells PRODUCED: for every raw lineage edge,
        # the product of its endpoints' ancestor-chain lengths. What the graph
        # STORES is cells DISTINCT — the write is a MERGE on aggKey, so many
        # raw edges collapse onto one cell and bump its weight. The two differ
        # by roughly the mean weight, and aggregation exists to make that
        # number large: a graph compressing 50:1 estimates 50× its real size.
        # Refusing on the raw figure refuses graphs for aggregating WELL.
        self._cube_estimate_upper = estimate
        ratio = self._cell_ratio()
        estimate = self._corrected_estimate(estimate, ratio)
        self._cube_estimate = estimate

        budget = await self._budget()
        margin = self._knob_int("estimate_margin_pct", estimate_margin_pct_default, 0, 100)
        verdict = budget.verdict(
            projected=estimate, growth_edges=max(0, estimate - self._edges_before),
            margin_pct=margin,
        )
        if forced:
            self._cube_mode = True
            # An UNCALIBRATED estimate may not refuse. The upper bound only
            # ever supports one conclusion — if it fits, the real thing fits —
            # and "it does not fit" proves nothing at all about a number that
            # can be fifty times too high. Proceed and let the exact
            # post-compute check refuse, which it does before a single write
            # reaches the shard. Under-estimating is the safe direction
            # precisely because that gate is there and is exact.
            if not verdict.ok and ratio is not None:
                raise MaterializationBudgetExceeded(format_refusal(
                    budget, verdict, graph=self.p._graph_name,
                    composition=(
                        f"full cube, estimated before compute "
                        f"(upper bound {self._cube_estimate_upper:,} cells × "
                        f"measured ratio {ratio:.4f})"
                    ),
                    from_estimate=True, margin_pct=margin,
                ))
            if not verdict.ok:
                logger.info(
                    "aggregation pipeline on %s: forced full cube — the upper "
                    "bound (~%d cells) does not fit, but this source has no "
                    "measured cell ratio yet, and the bound counts cells "
                    "PRODUCED rather than STORED. Proceeding; the exact check "
                    "after compute refuses before any write if it must.",
                    self.p._graph_name, self._cube_estimate_upper,
                )
                return
            logger.info(
                "aggregation pipeline on %s: forced full cube — estimate ~%d "
                "cells (upper bound %d%s); the %s rule allows it.",
                self.p._graph_name, estimate, self._cube_estimate_upper,
                f", measured ratio {ratio:.4f}" if ratio is not None else ", uncalibrated",
                budget.governed_by,
            )
            return
        # The cube ceiling is deliberately NOT the write budget: it is Auto's
        # appetite, a product choice, while the budget is what the shard can
        # take. Auto keeps its ceiling AND never picks a cube the shard would
        # refuse. See _max_cube_edges.
        cap = self._knob_int("max_cube_edges", _max_cube_edges, 10_000, 50_000_000)
        ceiling = self._explicit_ceiling()
        if ceiling is not None and cap > ceiling:
            logger.warning(
                "aggregation pipeline on %s: the cube ceiling (%d) sits above the "
                "explicit edge ceiling maxMaterializedEdges=%d — a cube Auto would "
                "pick could be refused by the budget; keep maxCubeEdges below it.",
                self.p._graph_name, cap, ceiling,
            )
        # Uncalibrated, an over-large upper bound must not push Auto off the
        # cube either: that trades a graph's full detail for the degraded
        # depth-diagonal on the same inflated arithmetic.
        self._cube_mode = estimate <= cap and (verdict.ok or ratio is None)
        logger.info(
            "aggregation pipeline on %s: auto mode — full-cube estimate "
            "~%d cells vs cube ceiling %d (%s rule: %s) → %s.",
            self.p._graph_name, estimate, cap, budget.governed_by,
            "fits" if verdict.ok else "does not fit",
            "FULL CUBE (every ancestor combination stored)"
            if self._cube_mode else
            "structural depth-diagonal (cube exceeds ceiling or budget; mixed "
            "granularities served on demand)",
        )

    async def _load_nonleaf_ids(self) -> None:
        """Build the structural boundary from the containment parent map:

        * non-leaf = any node that IS a containment parent — INDEPENDENT of
          its ontology type. The previous TYPE-LEVEL boundary treated every
          node of the finest type as a leaf, so a self-nesting type
          (``Node ⊃ Node`` — folders, systems, components) materialized
          ONLY the root diagonal and Context View showed no aggregated
          lineage below the roots (observed live: 9 Roots→Roots cells on a
          graph with 246 Node→Node containments).
        * rank = containment DEPTH from the root — the quotient the
          canonical selection runs on. On graphs whose types do encode the
          hierarchy (domain ⊃ table ⊃ column) depth ≡ type level and the
          output is unchanged.
        * one full node-range pass resolves (urn, label) for exactly the
          container ids — the eager node directory for writes — plus each
          container's TYPE level for the read path's sourceLevel/
          targetLevel stamps (None when no level map is injected).
        """
        if self._nonleaf_levels is not None:
            return
        if not self._fine_filter_active():
            return

        ranks = {cid: self._depth_of(cid) for cid in self._struct_parents}

        # One bounded pass over the node matrix: keep (urn, label) for the
        # container ids only — memory scales with CONTAINER count.
        import sys
        levels_by_label = self._levels_by_observed_label()
        directory: Dict[int, Tuple[str, str]] = {}
        type_levels: Dict[int, int] = {}
        width = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        res = await self.p._ro_query(
            "MATCH (n) RETURN max(ID(n))", timeout=self._scan_timeout(),
        )
        rows = res.result_set or []
        max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1

        # Identity-aware (parity with the full-mode directory): resolve `urn`, or the source's
        # URN-equivalent for onboarded graphs whose containers carry no `urn`.
        _ident_expr = _node_identity_expr(getattr(self.p, "_node_identity_property", None))

        async def run_one(lo: int, hi: int):
            r = await self.p._ro_query(
                "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
                f"RETURN ID(n), {_ident_expr}, labels(n)",
                params={"lo": lo, "hi": hi},
                timeout=self._scan_timeout(),
            )
            return r.result_set or []

        async def fetch(lo: int):
            return await self._fetch_range(
                run_one, lo, lo + width, label="extract:containers",
            )

        lows = list(range(0, max_id + 1, width))
        start = 0
        while start < len(lows):
            self._cancel_check()
            wave = lows[start:start + self._effective_conc()]
            start += len(wave)
            for result in await asyncio.gather(*(fetch(lo) for lo in wave)):
                for row in result:
                    nid, urn, labels = row[0], row[1], row[2] or []
                    if nid is None or int(nid) not in ranks:
                        continue
                    nid = int(nid)
                    if urn and labels:
                        label = sys.intern(str(labels[0]))
                        directory[nid] = (urn, label)
                        lv = levels_by_label.get(label)
                        if lv is not None:
                            type_levels[nid] = lv

        self._nonleaf_levels = ranks
        self._nonleaf_type_level = type_levels
        self._node_dir = directory
        by_rank: Dict[int, int] = {}
        for rk in ranks.values():
            by_rank[rk] = by_rank.get(rk, 0) + 1
        logger.info(
            "aggregation pipeline on %s: structural boundary loaded — %d "
            "container nodes by depth: %s. Leaf-involving and mixed-level "
            "pairs are served on demand.",
            self.p._graph_name, len(ranks),
            ", ".join(f"d{rk}={n}" for rk, n in sorted(by_rank.items())),
        )

    async def _check_write_budget(
        self, *, wave: Optional[List[int]] = None,
        growth_edges: Optional[int] = None, note: Optional[str] = None,
    ) -> None:
        """Refuse a write the owning shard cannot take — failing the job
        with the numbers beats OOM-killing a shared instance.

        Growth, not size, is what the shard pays for. Before the apply it is
        every cell the graph does not already hold; for an overflow ``wave``
        it is that wave's first-touch keys, the shard having been re-read so
        the waves before it are already inside ``used``; for a mid-apply
        recheck it is ``growth_edges``, what is still to land. ``note`` rides
        into the refusal so the message says which check refused."""
        # Union, not sum: a key flushed earlier AND re-touched since sits
        # in both sets — summing double-counts it and terminally fails a
        # legitimately under-budget job.
        flushed = self._flushed
        projected = len(flushed) + sum(1 for k in self._acc if k not in flushed)
        if growth_edges is not None:
            growth = max(0, int(growth_edges))
        elif wave is not None:
            growth = len(wave)
        else:
            growth = max(0, projected - self._edges_before)
        budget = await self._budget()
        verdict = budget.verdict(projected=projected, growth_edges=growth)
        if not verdict.ok:
            composition = self._budget_composition()
            if note:
                composition = f"{composition}; {note}"
            raise MaterializationBudgetExceeded(format_refusal(
                budget, verdict, graph=self.p._graph_name, composition=composition,
            ))
        # Passed: hold what is still to land in the node's ledger.
        await self._reserve(budget.shard, int(verdict.needed_bytes or 0))

    def _budget_composition(self) -> str:
        """Per-rank-pair histogram of the would-be result, so operators
        can see WHAT exceeded the budget. Only computed on failure."""
        counts: Dict[str, int] = {}
        for key in list(self._acc) + list(self._flushed):
            sid, tid = _unpack(key)
            name = f"{self._pair_bucket(sid)}→{self._pair_bucket(tid)}"
            counts[name] = counts.get(name, 0) + 1
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
        return ", ".join(f"{name}: {n}" for name, n in top)

    # -- node resolution -------------------------------------------------------

    async def _ensure_node_directory(self) -> Dict[int, Tuple[str, str]]:
        """Load the full node ID → (urn, label) directory with ID-range
        scans — one bounded pass, ~10 queries for 2M nodes.

        FalkorDB does not seek ``WHERE ID(n) = x`` under UNWIND (it scans
        all nodes per row), so per-batch ID lookups are pathological at
        scale; a single range-scanned directory is dramatically cheaper
        and is only built when a write/delete actually needs it (a no-op
        diff run never pays for it). Labels are interned so 2M entries
        stay in the low hundreds of MB."""
        if self._node_dir is not None:
            return self._node_dir
        import sys
        # Boundary mode builds the container-only directory eagerly inside
        # _load_nonleaf_ids (the same node pass that ranks the containers),
        # so reaching this point means legacy full-cube mode: load the FULL
        # node set.
        width = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        # Canonical identity per node: `urn`, or the source's configured URN-equivalent (e.g. `id`)
        # for onboarded third-party graphs whose nodes carry no `urn` (stamp_identity_urns normally
        # populates `urn` first; this coalesce covers any node it hasn't reached).
        ident_prop = getattr(self.p, "_node_identity_property", None)
        ident_expr = _node_identity_expr(ident_prop)
        res = await self.p._ro_query(
            "MATCH (n) RETURN max(ID(n))", timeout=self._scan_timeout(),
        )
        rows = res.result_set or []
        max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
        directory: Dict[int, Tuple[str, str]] = {}

        async def run_one(lo: int, hi: int):
            res = await self.p._ro_query(
                "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
                f"RETURN ID(n), {ident_expr}, labels(n)",
                params={"lo": lo, "hi": hi},
                timeout=self._scan_timeout(),
            )
            return res.result_set or []

        async def fetch(lo: int):
            return await self._fetch_range(
                run_one, lo, lo + width, label="apply:node-directory",
            )

        lows = list(range(0, max_id + 1, width))
        start = 0
        while start < len(lows):
            self._cancel_check()
            wave = lows[start:start + self._effective_conc()]
            start += len(wave)
            for rows in await asyncio.gather(*(fetch(lo) for lo in wave)):
                for row in rows:
                    nid, identity, labels = row[0], row[1], row[2] or []
                    if nid is None or not identity or not labels:
                        continue
                    directory[int(nid)] = (identity, sys.intern(str(labels[0])))
        self._node_dir = directory
        logger.info(
            "aggregation pipeline on %s: node directory loaded — %d entries (identity=%s).",
            self.p._graph_name, len(directory), _node_identity_expr(ident_prop),
        )
        # A totally empty directory on a graph that HAS nodes means identity resolution failed for
        # every node — the classic onboarded-graph symptom (nodes keyed by `id`, not `urn`, and no
        # identity mapping configured). Surface it loudly instead of silently dropping every pair.
        if not directory and max_id >= 0:
            # Auto-detect the fix: which common identity property WOULD resolve?
            # A read-only sample so we can NAME the property (and, on a writable
            # graph, adopt it) instead of dropping every pair.
            self._identity_candidates, self._identity_sample_total = (
                await self._probe_identity_candidates()
            )
            best = self._pick_autoheal_identity()
            # Only a graph we can WRITE to (in_source; a dedicated projection or
            # read-only federated source must not be stamped) and only once.
            writable = getattr(self.p, "_projection_mode", "in_source") != "dedicated"
            if best and writable and not self._identity_autohealed:
                self._identity_autohealed = True
                self._autohealed_identity = best
                logger.warning(
                    "aggregation pipeline on %s: identity %s resolved 0 nodes, but `%s` is "
                    "populated on %d/%d sampled nodes — SELF-HEALING: stamping urn from `%s` "
                    "and rebuilding the directory. Set the source's Node Identity Property to "
                    "`%s` to make this permanent (and skip this recovery next run).",
                    self.p._graph_name, _node_identity_expr(ident_prop), best,
                    self._identity_candidates.get(best, 0), self._identity_sample_total,
                    best, best,
                )
                try:
                    self.p._node_identity_property = best
                    if hasattr(self.p, "stamp_identity_urns"):
                        await self.p.stamp_identity_urns()
                except Exception as exc:
                    logger.warning(
                        "aggregation pipeline on %s: self-heal urn stamp failed (%s) — "
                        "falling back to directory-only coalesce.", self.p._graph_name, exc,
                    )
                # Rebuild ONCE with the adopted property (the guard above stops
                # a second heal; a still-empty directory then advises loudly).
                self._node_dir = None
                return await self._ensure_node_directory()

            self._empty_directory = True            # → run_stats advisory
            _hint = ", ".join(
                f"{k}={v}" for k, v in sorted(
                    self._identity_candidates.items(), key=lambda kv: -kv[1])
            )
            logger.warning(
                "aggregation pipeline on %s: node directory is EMPTY though the graph has nodes — "
                "no node resolved a canonical identity via %s. Sampled properties that WOULD "
                "resolve: %s. Set the source's Node Identity Property to a populated one and "
                "re-aggregate; every aggregation pair is dropped until then.",
                self.p._graph_name, _node_identity_expr(ident_prop), _hint or "none found",
            )
        return directory

    # Likely-UNIQUE canonical keys, in preference order — NEVER `name` (not
    # unique; stamping urn from it would merge distinct nodes).
    _AUTOHEAL_IDENTITY_PRIORITY = ("id", "uuid", "guid", "qualifiedName", "key")

    def _pick_autoheal_identity(self) -> Optional[str]:
        """The best identity property to adopt when the configured one resolved
        nothing: the first likely-unique candidate populated on ~every sampled
        node (≥90%), so the auto-heal never keys on a sparse or non-unique
        property. None ⇒ don't self-heal (fall through to the advisory)."""
        total = self._identity_sample_total or 0
        if total <= 0:
            return None
        for cand in self._AUTOHEAL_IDENTITY_PRIORITY:
            if self._identity_candidates.get(cand, 0) >= 0.9 * total:
                return cand
        return None

    async def _probe_identity_candidates(self) -> Tuple[Dict[str, int], int]:
        """Read-only: over a bounded node sample, how many carry each common
        identity property (and the sample size). Powers the empty-directory
        advisory AND the auto-heal candidate pick — revealing e.g. that nodes DO
        carry `id` while the run keyed on `urn`, the exact "I set id but it says
        missing" case."""
        cands = ["id", "uuid", "guid", "qualifiedName", "key", "name", "urn"]
        parts = ", ".join(
            f"sum(CASE WHEN n.`{c}` IS NOT NULL THEN 1 ELSE 0 END)" for c in cands
        )
        try:
            res = await self.p._ro_query(
                f"MATCH (n) WITH n LIMIT 5000 RETURN count(n), {parts}",
                timeout=self._scan_timeout(),
            )
            row = (res.result_set or [[]])[0] if res.result_set else []
            if not row:
                return {}, 0
            total = int(row[0] or 0)
            counts = {
                c: int(row[i + 1] or 0)
                for i, c in enumerate(cands)
                if i + 1 < len(row) and row[i + 1]
            }
            return counts, total
        except Exception as exc:
            logger.debug("identity candidate probe failed: %s", exc)
            return {}, 0

    async def _resolve_ids(self, ids: List[int]) -> Dict[int, Tuple[str, str]]:
        """Resolve node IDs → (urn, first label) from the range-scanned
        directory. Nodes absent from the directory (deleted mid-run,
        missing urn/label) are absent from the result; callers drop those
        pairs with a warning."""
        directory = await self._ensure_node_directory()
        out: Dict[int, Tuple[str, str]] = {}
        for i in ids:
            hit = directory.get(i)
            if hit is not None:
                out[i] = hit
        return out

    # -- writes ------------------------------------------------------------------

    def _levels_by_observed_label(self) -> Dict[str, int]:
        """The entity-type level map re-keyed by every OBSERVED label
        spelling this source uses (identity on governed graphs). The node
        directory records observed spellings; looking those up in the
        declared-key map stamps NULL levels on alias-variant sources —
        and the on-demand mixed-level reader filters on those stamps
        (``r.targetLevel <= $l``), so NULL stamps blind every mixed-level
        drill-down on such graphs."""
        if self._levels_by_spelling is None:
            out: Dict[str, int] = {}
            for lbl, lv in self._entity_levels.items():
                for spelled in self._spellings_for_label(lbl):
                    out[str(spelled)] = lv
                out[lbl] = lv
            self._levels_by_spelling = out
        return self._levels_by_spelling

    def _build_items(
        self, source: Dict[int, int], keys: List[int],
        resolved: Dict[int, Tuple[str, str]],
    ) -> List[Dict[str, Any]]:
        values = self._values
        levels = self._levels_by_observed_label()
        types = self._effective_types
        items: List[Dict[str, Any]] = []
        dropped = 0
        for key in keys:
            val = source.get(key)
            if val is None:
                continue
            sid, tid = _unpack(key)
            s_res = resolved.get(sid)
            t_res = resolved.get(tid)
            if not s_res or not t_res:
                dropped += 1
                continue
            s_urn, s_label = s_res
            t_urn, t_label = t_res
            mask = values.mask(val)
            sd = self._depth_of(sid)
            td = self._depth_of(tid)
            if sd > self._max_stamped_depth:
                self._max_stamped_depth = sd
            if td > self._max_stamped_depth:
                self._max_stamped_depth = td
            items.append({
                "s": s_urn,
                "t": t_urn,
                "_sl_label": s_label,
                "_tl_label": t_label,
                "k": f"{s_urn}|{t_urn}",
                "w": values.weight(val),
                "et": [t for i, t in enumerate(types) if mask & (1 << i)],
                "sl": levels.get(s_label) if levels else None,
                "tl": levels.get(t_label) if levels else None,
                # Containment depths — the STRUCTURAL stamp dimension the
                # readers filter on (well-defined on any graph, unlike the
                # type levels above, which self-nesting types degenerate).
                "sd": sd,
                "td": td,
            })
        if dropped:
            self._dropped_endpoints += dropped      # → run_stats advisory
            logger.warning(
                "aggregation pipeline on %s: dropped %d pairs with "
                "unresolvable endpoints (deleted nodes or missing urn/label).",
                self.p._graph_name, dropped,
            )
        return items

    def _sub_batch_size(self) -> int:
        # The provider's AIMD sizer targets ~0.8-2.0s per write: start at
        # its conservative base and let sustained-healthy growth raise it,
        # honoring the bulk-create ceiling. Ramping up beats starting big —
        # an oversized first batch on a cold/loaded server stalls the whole
        # write path behind one slow query.
        size = max(100, min(
            self.p._aggregation_sub_batch_size,
            self.p._bulk_create_batch_size,
        ))
        # Under write pressure the ladder's sticky cap wins, down to a
        # single row — below the AIMD floor of 100 / the provider's 50,
        # because a batch the server refuses for size or time is re-issued
        # smaller, never unchanged.
        if self._write_cap.value is not None:
            size = max(1, min(size, self._write_cap.value))
        return size

    async def _write_rows_with_ladder(
        self, cypher: str, rows: List[Dict[str, Any]], *, label: str,
        cap: "_StickyCap", params: Optional[Dict[str, Any]] = None,
        count_as: str = "writes",
    ) -> None:
        """Issue one UNWIND write (MERGE or DELETE) under the pressure
        ladder: a per-query timeout or memory refusal halves the batch and
        re-issues the halves; at the minimum size a timeout is retried with
        backoff and then declared an outage, a memory refusal is terminal.

        Re-issuing after a failure is safe: a write FalkorDB aborts at its
        ``TIMEOUT`` or at the memory ceiling is rolled back, and the
        residual client-deadline race (server completes 500 ms after the
        client gave up) re-applies at most one batch via MERGE ON MATCH /
        an idempotent keyed delete — the bound ``_run_guarded`` already
        accepts for its own connection retries."""
        if not rows:
            return
        p = self.p
        payload_key = "keys" if count_as == "deletes" else "batch"
        base_params = dict(params or {})

        def _issue(batch: List[Dict[str, Any]]):
            return self._paced_write(lambda: p._proj_query(
                cypher, params={**base_params, payload_key: batch},
                timeout=self._write_timeout(),
            ))

        try:
            elapsed, _ = await self._through_outage(lambda: _issue(rows), op=label)
        except Exception as exc:
            kind = _pressure_kind(exc)
            if kind is None:
                raise
            self._on_pressure(label, kind, 0, 0, size=len(rows))
            if not cap.at_floor(len(rows)) and len(rows) > 1:
                new_cap = cap.shrink(len(rows))
                if count_as == "writes":
                    # Pull the provider's AIMD sizer down too, so the NEXT
                    # chunk starts small instead of re-discovering the
                    # ceiling; healthy writes re-grow it additively.
                    p._aggregation_sub_batch_size = max(
                        getattr(p, "_MERGE_SUB_BATCH_MIN", 50),
                        min(p._aggregation_sub_batch_size, new_cap),
                    )
                logger.warning(
                    "aggregation pipeline on %s: %s of %d rows %s — halving "
                    "to %d and re-issuing.", p._graph_name, label, len(rows),
                    "exceeded the per-query memory ceiling" if kind == "memory"
                    else "timed out", new_cap,
                )
                mid = max(1, min(new_cap, len(rows) - 1))
                for part in (rows[:mid], rows[mid:]):
                    if part:
                        await self._write_rows_with_ladder(
                            cypher, part, label=label, cap=cap, params=params,
                            count_as=count_as,
                        )
                return
            if kind == "memory":
                raise MaterializationQueryMemoryExceeded(
                    self._query_memory_guidance(
                        label, 0, 0, kind=count_as[:-1], size=len(rows),
                    )
                ) from exc
            elapsed, _ = await self._retry_at_floor(
                lambda: _issue(rows), label=label, lo=0, hi=0, size=len(rows),
                budget=self._write_timeout(),
            )
        cap.note_success()
        if count_as == "writes":
            self._note_write_latency(elapsed)
            self._writes += len(rows)
        else:
            self._deletes += len(rows)
        await self._heartbeat()

    def _note_write_latency(self, elapsed: float) -> None:
        """Feed the provider's AIMD sizer: sustained slow writes shrink
        sub-batches (multiplicative), healthy ones re-grow (additive)."""
        p = self.p
        current = p._aggregation_sub_batch_size
        if elapsed > p._MERGE_SUB_BATCH_TARGET_HIGH_S:
            p._aggregation_sub_batch_size = max(p._MERGE_SUB_BATCH_MIN, current // 2)
            p._aggregation_sub_batch_under_target_run = 0
        elif elapsed < p._MERGE_SUB_BATCH_TARGET_LOW_S:
            p._aggregation_sub_batch_under_target_run += 1
            if (
                p._aggregation_sub_batch_under_target_run
                >= p._MERGE_SUB_BATCH_GROW_AFTER
                and current < p._MERGE_SUB_BATCH_SIZE
            ):
                p._aggregation_sub_batch_size = min(
                    p._MERGE_SUB_BATCH_SIZE,
                    current + p._MERGE_SUB_BATCH_GROW_STEP,
                )
                p._aggregation_sub_batch_under_target_run = 0
        else:
            p._aggregation_sub_batch_under_target_run = 0

    async def _write_items(
        self, items: List[Dict[str, Any]], *, weight_mode: str,
    ) -> None:
        """MERGE prepared items as :AGGREGATED edges in AIMD-sized, paced
        sub-batches. ``weight_mode='overwrite'`` sets the final weight;
        ``'add'`` accumulates (repeat overflow flushes only).

        Node matching is ALWAYS by (label, urn) — an index seek via the
        per-label URN index. Never by internal ID: FalkorDB does not seek
        ``WHERE ID(a) = item.aid`` under UNWIND, and the resulting
        scan-per-row was the production CPU/timeout death spiral on
        multi-hundred-thousand-node graphs.
        """
        if not items:
            return
        from backend.app.providers.falkordb_provider import _sanitize_label
        dedicated = getattr(self.p, "_projection_mode", "in_source") == "dedicated"
        weight_expr = (
            "coalesce(r.weight, 0) + item.w" if weight_mode == "add" else "item.w"
        )
        set_tail = (
            f"SET r.weight = {weight_expr}, r.sourceEdgeTypes = item.et, "
            "r.sourceLevel = item.sl, r.targetLevel = item.tl, "
            "r.sourceDepth = item.sd, r.targetDepth = item.td, "
            "r.levelDigest = $digest, r.latestUpdate = timestamp()"
        )

        by_label: Dict[Tuple[str, str], List[Dict[str, Any]]] = {}
        for it in items:
            by_label.setdefault((it["_sl_label"], it["_tl_label"]), []).append(it)

        # Per-label URN indexes make every node match below an index seek.
        labels = {lbl for pair in by_label for lbl in pair}
        new_labels = labels - self._indexed_labels
        if new_labels and hasattr(self.p, "_ensure_label_urn_indexes"):
            try:
                await self.p._ensure_label_urn_indexes(new_labels)
            except Exception as exc:
                logger.warning(
                    "aggregation pipeline on %s: label URN index ensure "
                    "failed (%s) — writes may be slower.",
                    self.p._graph_name, exc,
                )
            self._indexed_labels |= new_labels

        # in_source: nodes exist in the source graph → MATCH by label+urn.
        # dedicated: the projection graph is populated on demand → MERGE.
        node_kw = "MERGE" if dedicated else "MATCH"
        groups = [(
            "UNWIND $batch AS item "
            f"{node_kw} (s:{_sanitize_label(sl)} {{urn: item.s}}) "
            f"{node_kw} (t:{_sanitize_label(tl)} {{urn: item.t}}) "
            "MERGE (s)-[r:AGGREGATED {aggKey: item.k}]->(t) "
            + set_tail,
            group_items,
        ) for (sl, tl), group_items in by_label.items()]

        for cypher, batch in groups:
            pos = 0
            while pos < len(batch):
                self._cancel_check()
                size = self._sub_batch_size()
                chunk = batch[pos:pos + size]
                pos += len(chunk)
                # Strip helper-only fields FalkorDB doesn't need.
                payload = [
                    {k: v for k, v in it.items() if not k.startswith("_")}
                    for it in chunk
                ]
                await self._write_rows_with_ladder(
                    cypher, payload, label="apply:merge", cap=self._write_cap,
                    params={"digest": self._level_digest},
                )

    async def _write_keys(
        self, source: Dict[int, int], keys: List[int], *, weight_mode: str,
    ) -> None:
        """Resolve + write the given pair keys in bounded chunks."""
        chunk_size = self._knob_int("apply_chunk", _apply_chunk, 1_000, 200_000)
        for start in range(0, len(keys), chunk_size):
            chunk_keys = keys[start:start + chunk_size]
            ids: Set[int] = set()
            for key in chunk_keys:
                sid, tid = _unpack(key)
                ids.add(sid)
                ids.add(tid)
            resolved = await self._resolve_ids(list(ids))
            items = self._build_items(source, chunk_keys, resolved)
            await self._write_items(items, weight_mode=weight_mode)

    # -- RECONCILE ---------------------------------------------------------------

    async def _reconcile(self, *, start_lo: int = 0) -> Set[int]:
        """Scan current :AGGREGATED edges in ID ranges; per range delete
        stale edges, update changed ones, and record keys that already
        exist. Returns the keys observed existing so APPLY can skip them."""
        dedicated = getattr(self.p, "_projection_mode", "in_source") == "dedicated"
        await self._ensure_agg_index()
        await self._await_agg_index_ready()

        if start_lo == 0:
            # Heal generations that predate the aggKey contract: edges
            # with NULL aggKey (legacy strategies, or the pre-fix
            # incremental hook) can never be reconciled by the keyed
            # delete below — they would double-serve pairs forever. One
            # relationship-bounded pass removes any that this run did
            # not itself write.
            try:
                probe = await self.p._proj_ro_query(
                    "MATCH ()-[r:AGGREGATED]->() WHERE r.aggKey IS NULL "
                    "RETURN 1 LIMIT 1",
                    timeout=self._scan_timeout(),
                )
                if probe.result_set:
                    # Chunked: a legacy generation can hold millions of
                    # NULL-aggKey edges, and one unbounded DELETE times out
                    # on every run — leaving the legacy cube double-serving
                    # pairs forever. LIMIT-bounded passes make progress
                    # each run even if a later pass fails.
                    while True:
                        self._cancel_check()
                        chunk = self._delete_cap.apply(
                            self._knob_int("delete_chunk", _delete_chunk, 100, 50_000)
                        )
                        _, res = await self._paced_write(lambda: self.p._proj_query(
                            "MATCH ()-[r:AGGREGATED]->() "
                            "WHERE r.aggKey IS NULL "
                            "AND (r.latestUpdate IS NULL OR r.latestUpdate < $runStart) "
                            f"WITH r LIMIT {chunk} DELETE r",
                            params={"runStart": self._run_start_ms},
                            timeout=self._write_timeout(),
                        ))
                        removed = getattr(res, "relationships_deleted", None)
                        if removed is not None:
                            if int(removed) < chunk:
                                break
                            continue
                        # Client didn't report a delete count — re-probe.
                        reprobe = await self.p._proj_ro_query(
                            "MATCH ()-[r:AGGREGATED]->() WHERE r.aggKey IS NULL "
                            "AND (r.latestUpdate IS NULL OR r.latestUpdate < $runStart) "
                            "RETURN 1 LIMIT 1",
                            params={"runStart": self._run_start_ms},
                            timeout=self._scan_timeout(),
                        )
                        if not reprobe.result_set:
                            break
            except Exception as exc:
                logger.warning(
                    "aggregation pipeline on %s: legacy (NULL-aggKey) edge "
                    "cleanup failed (%s) — stale legacy cells may double-"
                    "serve until the next run.",
                    self.p._graph_name, exc,
                )

        # In dedicated mode the projection graph has its own node IDs, so
        # membership is matched by aggKey. Resolve the accumulator's URNs
        # once up front (they are needed for the apply phase anyway).
        key_by_aggkey: Dict[str, int] = {}
        if dedicated and self._acc:
            all_ids: Set[int] = set()
            for key in self._acc:
                sid, tid = _unpack(key)
                all_ids.add(sid)
                all_ids.add(tid)
            resolved = await self._resolve_ids(list(all_ids))
            for key in self._acc:
                sid, tid = _unpack(key)
                s_res, t_res = resolved.get(sid), resolved.get(tid)
                if s_res and t_res:
                    key_by_aggkey[f"{s_res[0]}|{t_res[0]}"] = key

        width = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        max_id = await self._max_edge_id("()-[r:AGGREGATED]->()", proj=True)
        runner = self.p._proj_ro_query
        values = self._values
        existing: Set[int] = set()
        digest = self._level_digest
        run_start = self._run_start_ms
        total_ranges = max(1, -(-(max_id + 1) // width)) if max_id >= 0 else 1
        lo = start_lo

        async def run_one(lo_: int, hi_: int):
            # Strategy is read at CALL time: a pressure event inside
            # _fetch_range can flip it between two sub-ranges of the same
            # knob-width range, so one range may mix full and key rows —
            # the classifier below branches on row shape, never on the
            # strategy in force when the range started.
            keys_only = self._reconcile_strategy == "keys_only"
            if not dedicated:
                if keys_only:
                    cypher = (
                        "MATCH (a)-[r:AGGREGATED]->(b) "
                        "WHERE ID(r) >= $lo AND ID(r) < $hi "
                        "RETURN ID(a), ID(b), ID(r), r.aggKey, r.latestUpdate"
                    )
                else:
                    cypher = (
                        "MATCH (a)-[r:AGGREGATED]->(b) "
                        "WHERE ID(r) >= $lo AND ID(r) < $hi "
                        "RETURN ID(a), ID(b), r.aggKey, r.weight, r.levelDigest, "
                        "r.latestUpdate, r.sourceEdgeTypes, r.sourceLevel, "
                        "r.targetLevel, r.sourceDepth, r.targetDepth"
                    )
            else:
                if keys_only:
                    cypher = (
                        "MATCH (a)-[r:AGGREGATED]->(b) "
                        "WHERE ID(r) >= $lo AND ID(r) < $hi "
                        "RETURN ID(r), r.aggKey, r.latestUpdate"
                    )
                else:
                    cypher = (
                        "MATCH (a)-[r:AGGREGATED]->(b) "
                        "WHERE ID(r) >= $lo AND ID(r) < $hi "
                        "RETURN r.aggKey, r.weight, r.levelDigest, r.latestUpdate, "
                        "r.sourceEdgeTypes, r.sourceLevel, r.targetLevel, "
                        "r.sourceDepth, r.targetDepth"
                    )
            res = await runner(
                cypher, params={"lo": lo_, "hi": hi_}, timeout=self._scan_timeout(),
            )
            return res.result_set or []

        full_cols = 11 if not dedicated else 9

        while lo <= max_id:
            hi = lo + width
            self._cancel_check()
            range_rows = await self._fetch_range(
                run_one, lo, hi, label="reconcile:AGGREGATED",
            )
            to_delete: List[str] = []
            to_overwrite: List[int] = []
            to_add: List[int] = []
            # Keys-only rows whose comparison columns still have to be
            # read: aggKey → (pair key, relationship id).
            lookup: Dict[str, Tuple[int, int]] = {}
            for row in range_rows:
                is_full = len(row) >= full_cols
                rid: Optional[int] = None
                weight = row_digest = row_et = row_sl = row_tl = row_sd = row_td = None
                if not dedicated:
                    if is_full:
                        (aid, bid, agg_key, weight, row_digest, latest,
                         row_et, row_sl, row_tl, row_sd, row_td) = row
                    else:
                        aid, bid, rid, agg_key, latest = row
                    if aid is None or bid is None:
                        continue
                    key: Optional[int] = _pack(int(aid), int(bid))
                else:
                    if is_full:
                        (agg_key, weight, row_digest, latest,
                         row_et, row_sl, row_tl, row_sd, row_td) = row
                    else:
                        rid, agg_key, latest = row
                    key = key_by_aggkey.get(agg_key) if agg_key else None
                val = self._acc.get(key) if key is not None else None
                if val is None or key in existing:
                    # Not desired by this run (or a duplicate edge for an
                    # already-matched pair) → stale, UNLESS written during
                    # this run (our own overflow flush, a prior attempt of
                    # this run, or on_lineage_edge_written).
                    latest_i = int(latest) if latest is not None else 0
                    if latest_i >= run_start:
                        continue
                    if (
                        val is not None
                        and key is not None
                        and key in existing
                        and key not in self._flushed
                    ):
                        # Duplicate edge for a DESIRED pair (no unique
                        # constraint on aggKey): the keyed delete below
                        # removes EVERY old edge with this aggKey —
                        # including the matched one we meant to keep. Pull
                        # the pair back out of `existing` so APPLY
                        # re-creates one fresh edge after the duplicates
                        # collapse.
                        existing.discard(key)
                        lookup.pop(agg_key, None)
                    if agg_key:
                        to_delete.append(agg_key)
                    continue
                existing.add(key)
                if key in self._flushed:
                    # The graph already holds this key's flushed partial;
                    # the accumulator holds only the remainder → ADD it
                    # unconditionally (a weight comparison is meaningless).
                    to_add.append(key)
                elif not is_full:
                    # Keys-only row: the comparison columns are read in
                    # pass 2 by aggKey (an index seek) for exactly the
                    # desired, not-yet-flushed keys — never for stale ones.
                    if agg_key and rid is not None:
                        lookup[agg_key] = (key, int(rid))
                    else:
                        to_overwrite.append(key)
                elif (
                    int(weight or 0) != values.weight(val)
                    or (row_digest or "") != digest
                    or self._row_meta_stale(
                        val, row_et, row_sl, row_tl, row_sd, row_td, key,
                    )
                ):
                    to_overwrite.append(key)

            if lookup:
                to_overwrite.extend(await self._lookup_changed(lookup))

            await self._delete_stale(to_delete)
            await self._write_keys(self._acc, to_overwrite, weight_mode="overwrite")
            await self._write_keys(self._acc, to_add, weight_mode="add")
            for key in to_add:
                # Remainder is applied; drop so APPLY doesn't re-add it.
                self._acc.pop(key, None)

            lo = hi
            self._progress_pct = 55 + min(20, int(20 * (lo // width) / total_ranges))
            await self._checkpoint(PHASE_RECONCILE, lo, phase_label="reconciling")

        self._progress_pct = 75
        return existing

    async def _lookup_changed(self, lookup: Dict[str, Tuple[int, int]]) -> List[int]:
        """Keys-only reconcile, pass 2: read the comparison columns for the
        desired keys pass 1 saw, by ``aggKey`` (edge-property index seek),
        in ladder-capped batches, and return the pair keys whose stored
        weight / digest / metadata differ from the accumulator's.

        Matched on ``(aggKey, ID(r))`` so a duplicate aggKey elsewhere in
        the graph cannot stand in for the row pass 1 classified; a key
        whose row is no longer returned (the edge vanished between the two
        passes) is rewritten — the MERGE recreates a desired pair, which is
        idempotent. Rows for other relationship ids are ignored: the range
        that covers their ID classifies them."""
        values = self._values
        digest = self._level_digest
        changed: List[int] = []
        seen: Set[str] = set()
        cypher = (
            "UNWIND $keys AS k "
            "MATCH ()-[r:AGGREGATED {aggKey: k}]->() "
            "RETURN k, ID(r), r.weight, r.levelDigest, r.sourceEdgeTypes, "
            "r.sourceLevel, r.targetLevel, r.sourceDepth, r.targetDepth"
        )
        agg_keys = list(lookup)
        start = 0
        while start < len(agg_keys):
            self._cancel_check()
            size = self._lookup_cap.apply(min(
                2_000, self._knob_int("delete_chunk", _delete_chunk, 100, 50_000),
            ))
            batch = agg_keys[start:start + size]
            start += len(batch)

            async def run_batch(b=batch):
                res = await self.p._proj_ro_query(
                    cypher, params={"keys": b}, timeout=self._scan_timeout(),
                )
                return res.result_set or []

            rows = await self._fetch_batch_with_ladder(run_batch, batch, label="reconcile:lookup")
            for row in rows:
                (k, rid, weight, row_digest, row_et, row_sl, row_tl,
                 row_sd, row_td) = row
                entry = lookup.get(k)
                if entry is None or rid is None or int(rid) != entry[1]:
                    continue
                key = entry[0]
                seen.add(k)
                val = self._acc.get(key)
                if val is None:
                    continue
                if (
                    int(weight or 0) != values.weight(val)
                    or (row_digest or "") != digest
                    or self._row_meta_stale(
                        val, row_et, row_sl, row_tl, row_sd, row_td, key,
                    )
                ):
                    changed.append(key)
        for k, (key, _rid) in lookup.items():
            if k not in seen:
                changed.append(key)
        return changed

    async def _fetch_batch_with_ladder(
        self, run_batch: Callable[..., Awaitable[list]], batch: list, *, label: str,
    ) -> list:
        """The read-side twin of ``_write_rows_with_ladder`` for UNWIND
        reads keyed by a list: halve the key list on pressure, retry a
        one-key timeout with backoff, and treat a one-key memory refusal
        as terminal."""
        try:
            return await self._through_outage(lambda: run_batch(batch), op=label)
        except Exception as exc:
            kind = _pressure_kind(exc)
            if kind is None:
                raise
            self._on_pressure(label, kind, 0, 0, size=len(batch))
            if len(batch) > 1:
                self._lookup_cap.shrink(len(batch))
                mid = len(batch) // 2
                out: list = []
                for part in (batch[:mid], batch[mid:]):
                    await self._ladder_heartbeat()
                    out.extend(await self._fetch_batch_with_ladder(
                        lambda b: run_batch(b), part, label=label,
                    ))
                return out
            if kind == "memory":
                raise MaterializationQueryMemoryExceeded(
                    self._query_memory_guidance(label, 0, 0, kind="lookup", size=1)
                ) from exc
            return await self._retry_at_floor(
                lambda: run_batch(batch), label=label, lo=0, hi=0, size=1,
                budget=self._scan_timeout(),
            )

    def _row_meta_stale(
        self, val: int, row_et: Any, row_sl: Any, row_tl: Any,
        row_sd: Any, row_td: Any, key: int,
    ) -> bool:
        """Weight-preserving drift the weight/digest comparison can't see:
        ``sourceEdgeTypes`` replaced type-for-type (same count, different
        types — a TRANSFORMS-filtered trace would silently drop the edge),
        level stamps written by a pre-alias-fix build (NULL on
        alias-variant sources, which blinds the mixed-level reader), or
        depth stamps that are NULL/stale (pre-depth generations — healed
        in place by the overwrite path with zero weight churn)."""
        mask = self._values.mask(val)
        desired_et = {
            t for i, t in enumerate(self._effective_types) if mask & (1 << i)
        }
        stored_et = set(row_et) if isinstance(row_et, list) else (
            {row_et} if row_et else set()
        )
        if stored_et != desired_et:
            return True
        sid, tid = _unpack(key)
        # Structural depth stamps apply in BOTH modes — the readers'
        # filter dimension on any graph shape.
        if row_sd is None or int(row_sd) != self._depth_of(sid):
            return True
        if row_td is None or int(row_td) != self._depth_of(tid):
            return True
        if self._nonleaf_levels:
            # TYPE-level stamps survive as display metadata.
            desired_sl = self._nonleaf_type_level.get(sid)
            desired_tl = self._nonleaf_type_level.get(tid)
            if desired_sl is not None and (
                row_sl is None or int(row_sl) != desired_sl
            ):
                return True
            if desired_tl is not None and (
                row_tl is None or int(row_tl) != desired_tl
            ):
                return True
        return False

    async def _await_agg_index_ready(
        self, *, budget_s: float = 60.0, interval_s: float = 2.0,
    ) -> None:
        """Bounded wait for the AGGREGATED(aggKey) edge index to finish
        building. FalkorDB constructs indexes in the BACKGROUND: on a
        first run against a large existing :AGGREGATED set, the keyed
        deletes below would run as full relation scans until it is ready.
        Version-tolerant (cell-scan for the status marker; column order
        varies) and never a correctness gate — probe failure, unknown
        shapes and budget exhaustion all WARN + proceed."""
        deadline = time.monotonic() + budget_s
        while True:
            try:
                res = await self.p._proj_ro_query(
                    "CALL db.indexes()", timeout=self._scan_timeout(),
                )
            except Exception as exc:
                logger.info(
                    "aggregation pipeline on %s: db.indexes() probe "
                    "unavailable (%s) — skipping the readiness wait.",
                    self.p._graph_name, exc,
                )
                return
            building = False
            for row in (res.result_set or []):
                cells = [str(c) for c in (row or []) if c is not None]
                if not any("AGGREGATED" in c for c in cells):
                    continue
                if any("UNDER CONSTRUCTION" in c.upper() for c in cells):
                    building = True
                    break
            if not building:
                return
            if time.monotonic() >= deadline:
                logger.warning(
                    "aggregation pipeline on %s: AGGREGATED(aggKey) index "
                    "still building after %.0fs — proceeding; keyed deletes "
                    "may scan until it completes.",
                    self.p._graph_name, budget_s,
                )
                return
            self._cancel_check()
            await asyncio.sleep(interval_s)

    async def _ensure_agg_index(self) -> None:
        """Idempotently ensure the AGGREGATED(aggKey) edge index that keeps
        MERGE-on-aggKey an index seek instead of an O(out_degree) scan —
        plus the depth-stamp indexes the depth-keyed readers (Q3, trace
        structural drill) seek on. A run that writes stampVersion=2 cells
        must leave the graph readable at index speed."""
        # The same declaration ``ensure_indices`` reads, so the projection graph
        # and the source graph cannot drift apart — this list used to be a
        # second copy, three of whose four entries duplicated that one and one
        # of which (targetDepth alone) no query could ever enter through.
        from backend.app.providers.index_policy import edge_index_ddl

        for ddl in edge_index_ddl():
            try:
                await self.p._proj_query(
                    ddl,
                    timeout=float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
                )
            except Exception as exc:
                msg = str(exc).lower()
                if "already" not in msg and "exist" not in msg:
                    logger.warning(
                        "aggregation pipeline on %s: could not ensure "
                        "AGGREGATED index via %r (%s) — reads/deletes may scan.",
                        self.p._graph_name, ddl, exc,
                    )

    async def _delete_stale(self, agg_keys: List[str]) -> None:
        """Delete stale edges by ``aggKey`` (edge-property index seek) in
        paced chunks — never by internal-ID matching, which scans under
        UNWIND. The server-side ``latestUpdate < $runStart`` re-check makes
        the delete safe even if an edge was touched between our scan and
        this delete."""
        if not agg_keys:
            return
        run_start = self._run_start_ms
        cypher = (
            "UNWIND $keys AS k "
            "MATCH ()-[r:AGGREGATED {aggKey: k}]->() "
            "WHERE r.latestUpdate IS NULL OR r.latestUpdate < $runStart "
            "DELETE r"
        )
        start = 0
        while start < len(agg_keys):
            self._cancel_check()
            chunk_size = self._delete_cap.apply(
                self._knob_int("delete_chunk", _delete_chunk, 100, 50_000)
            )
            chunk = agg_keys[start:start + chunk_size]
            start += len(chunk)
            await self._write_rows_with_ladder(
                cypher, chunk, label="reconcile:delete", cap=self._delete_cap,
                params={"runStart": run_start}, count_as="deletes",
            )

    # -- APPLY ---------------------------------------------------------------------

    async def _apply_missing(self, existing: Set[int]) -> None:
        """Create the accumulator pairs the reconcile scan did not observe,
        in sorted key order so the recorded cursor pos tracks progress
        deterministically (writes are idempotent MERGEs; resume relies on
        the reconcile re-scan, never on the recorded pos)."""
        missing = sorted(k for k in self._acc if k not in existing)
        total = len(missing) or 1
        chunk_size = self._knob_int("apply_chunk", _apply_chunk, 1_000, 200_000)
        done = 0
        flushed = self._flushed
        # Only first-touch ("overwrite") keys grow the shard: a flushed key
        # already sits there and its remainder ADDs weight in place. What
        # the mid-apply recheck charges is the first-touch keys still to land.
        first_touch_total = sum(1 for k in missing if k not in flushed)
        first_touch_done = 0
        since_recheck = 0
        recheck_every = _budget_recheck_edges()

        for start in range(0, len(missing), chunk_size):
            chunk = missing[start:start + chunk_size]
            # Flushed keys already carry a partial weight in the graph —
            # their remainder ADDs; everything else overwrites.
            overwrite = [k for k in chunk if k not in flushed]
            add = [k for k in chunk if k in flushed]
            await self._write_keys(self._acc, overwrite, weight_mode="overwrite")
            await self._write_keys(self._acc, add, weight_mode="add")
            done += len(chunk)
            self._max_applied_key = chunk[-1]
            self._progress_pct = 75 + min(25, int(25 * done / total))
            await self._checkpoint(
                PHASE_APPLY, self._max_applied_key, phase_label="applying",
            )
            # Re-measure the owning shard every N first-touch edges: the
            # post-compute check answered at one instant, and a shard shared
            # with another graph's rebuild can fill up while this apply is
            # still landing. The checkpoint above is already committed, so a
            # refusal here resumes from the cursor once memory is freed —
            # deterministic, not retried, and never the write that fills the
            # shard and fails every graph on it. The fresh reading already
            # contains every chunk landed so far; only the remainder is owed.
            first_touch_done += len(overwrite)
            since_recheck += len(overwrite)
            remaining = first_touch_total - first_touch_done
            if since_recheck >= recheck_every and remaining > 0:
                since_recheck = 0
                self._budget_rechecks += 1
                await self._check_write_budget(
                    growth_edges=remaining,
                    note=(
                        f"mid-apply recheck after {done:,} of {len(missing):,} "
                        f"keys; {remaining:,} new edges still to write"
                    ),
                )

    async def _stamp_run_meta(self, edge_count: int) -> None:
        """Persist run metadata IN the graph — atomic with the data it
        describes, immune to Redis loss and topology splits. The previous
        Redis-only stamp silently no-oped whenever the executing
        provider had no Redis attached (the worker topology), so readers
        fell back to probing — and a probed full cube misclassifies as
        'boundary', which double-derives every mixed-level weight (Q3)
        and lets empty reads re-trigger materialization storms.

        ``regime`` is the storage contract the readers dispatch on:
        'cube' = every ancestor combination is stored (serve reads purely
        from storage; only the raw leaf↔leaf mirror may need synthesis);
        'boundary' = canonical depth-diagonal only (depth-keyed on-demand
        derivation fills the rest). ``stampVersion`` 2 = every edge
        carries sourceDepth/targetDepth. The Redis mirror stays for cheap
        reads, in the legacy boundary/fine vocabulary."""
        regime = "boundary" if self._fine_filter_active() else "cube"
        from datetime import datetime, timezone
        now_iso = datetime.now(timezone.utc).isoformat()
        try:
            await self.p._proj_query(
                "MERGE (m:_AggMeta {id: 'singleton'}) "
                "SET m.regime = $regime, m.stampVersion = 2, "
                "m.pairRuleVersion = 2, m.levelDigest = $digest, "
                "m.maxDepth = $maxDepth, m.edgeCount = $edgeCount, "
                "m.runStartMs = $runStart, m.lastMaterializedAt = $now",
                params={
                    "regime": regime,
                    "digest": self._level_digest,
                    "maxDepth": self._max_stamped_depth,
                    "edgeCount": edge_count,
                    "runStart": self._run_start_ms,
                    "now": now_iso,
                },
                timeout=self._write_timeout(),
            )
        except Exception as exc:
            logger.warning(
                "aggregation pipeline on %s: failed to stamp _AggMeta run "
                "metadata (%s) — readers will fall back to marker/probe.",
                self.p._graph_name, exc,
            )
        try:
            if self.p._redis is not None:
                await self.p._redis.set(
                    self.p._agg_last_materialized_key(), now_iso,
                )
                if hasattr(self.p, "_agg_regime_key"):
                    await self.p._redis.set(
                        self.p._agg_regime_key(),
                        "boundary" if regime == "boundary" else "fine",
                    )
        except Exception as exc:
            logger.warning(
                "Failed to stamp aggregated materialization timestamp: %s", exc,
            )


async def materialize_aggregated_edges(
    provider: Any,
    *,
    batch_size: int = 1000,  # retained for API compat; scans are range-based
    containment_edge_types: Optional[List[str]] = None,
    lineage_edge_types: Optional[List[str]] = None,
    last_cursor: Optional[str] = None,
    progress_callback: Optional[Any] = None,
    intra_batch_callback: Optional[Callable[[int], Awaitable[None]]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    resume_processed: int = 0,
    resume_created: int = 0,
    tuning: Optional[Dict[str, Any]] = None,
    job_id: Optional[str] = None,
    capacity_hints: Optional[Dict[str, Any]] = None,
    live_limits: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Entry point used by ``FalkorDBProvider.materialize_aggregated_edges_batch``."""
    pipeline = AggregationPipeline(
        provider,
        containment_edge_types=containment_edge_types,
        lineage_edge_types=lineage_edge_types,
        last_cursor=last_cursor,
        progress_callback=progress_callback,
        intra_batch_callback=intra_batch_callback,
        should_cancel=should_cancel,
        tuning=tuning,
        job_id=job_id,
        capacity_hints=capacity_hints,
        live_limits=live_limits,
    )
    return await pipeline.run()
