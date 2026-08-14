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
import time
from typing import Any, Awaitable, Callable, Dict, List, Optional, Set, Tuple

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
    """Memory cap on the in-worker pair accumulator AND the raw-pair base
    map. Crossing it triggers a lattice roll-up (base) or an early flush
    to the graph (accumulator) — memory stays bounded on pathological
    graphs at the cost of extra writes.

    Default 50M keeps every graph up to that size on the flush-free diff
    path: overflow is exact but costs extra write round-trips, and the
    target scale (1M nodes / 2M edges → ~3-4M boundary pairs) never comes
    close to the cap. NOTE the cap is what bounds WORKER RSS (not graph
    memory — unaffected by FalkorDB topology): 50M pairs is ~5GB packed,
    ABOVE the worker's 4Gi budget, so a graph that truly accumulates that
    many pairs will OOM rather than flush. Lower this (or raise the worker
    limit) before aggregating beyond ~30M pairs."""
    return _env_int("AGGREGATION_MAX_PENDING_PAIRS", 50_000_000, 50_000, 50_000_000)


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


def _scan_timeout_s() -> float:
    return _env_float("FALKORDB_SCAN_RANGE_TIMEOUT", 30.0, 5.0, 600.0)


def _node_identity_expr(identity_property: Optional[str]) -> str:
    """Cypher expression for a node's canonical identity: the platform ``urn``, falling back to the
    source's configured URN-equivalent property when a node has no ``urn``.

    Every consumer keys on ``urn``, but an ONBOARDED third-party graph identifies nodes by ``id``
    (or ``name``), not ``urn``. The DEFINITIVE fix is :meth:`FalkorDBProvider.stamp_identity_urns`,
    which copies the identity property onto ``urn`` for every node at aggregation start — after it
    runs, the whole urn-keyed write / index / read / trace stack works unchanged. This expression is
    defense-in-depth for the directory scans: it still resolves identity if the stamp was skipped
    (e.g. a read-only source) or hasn't reached a freshly-added node yet. It does NOT fix the
    AGGREGATED write (which MERGEs on the ``urn`` PROPERTY and cannot key on a coalesce expression) —
    the stamp is what makes writes attach.

    Default is ``urn`` (OPT-IN — no behavior change for conforming graphs); a source sets it to its
    URN-equivalent (e.g. ``id``)."""
    prop = identity_property or "urn"
    safe = str(prop).replace("`", "")
    if not safe or safe == "urn":
        return "n.`urn`"
    return f"coalesce(n.`urn`, n.`{safe}`)"


def _extract_concurrency() -> int:
    """Concurrent read-only range scans (extract/reconcile/node directory).
    Bounded well below the server's THREAD_COUNT so interactive readers
    always have query threads. Default 1 (serial) is the gentlest setting
    — raise it toward the ceiling of 4 to shorten EXTRACT on large graphs
    at the cost of provider load."""
    return _env_int("AGGREGATION_EXTRACT_CONCURRENCY", 1, 1, 4)


def _scan_shrink_floor() -> int:
    """Smallest ID-range width the shrink-on-timeout ladder descends to.
    A range THIS narrow that still times out is a server outage, not a
    payload problem — the timeout propagates and the run fails."""
    return _env_int("AGGREGATION_SCAN_SHRINK_FLOOR", 10_000, 1, 5_000_000)


def _materialize_leaf_pairs() -> bool:
    return os.getenv(
        "AGGREGATION_MATERIALIZE_LEAF_PAIRS", "false"
    ).strip().lower() in ("1", "true", "yes", "on")


def _materialize_fine_pairs_mode() -> str:
    """FULL-CUBE materialization mode: EVERY ancestor-pair combination
    (leaf→table, table→table, column→domain, …) physically stored.

    ``auto`` (default): the pipeline ESTIMATES the cube volume up front
    (one counting pass over the raw edges using the ancestor walks it
    already performs) and materializes the full cube whenever the
    estimate fits ``AGGREGATION_MAX_MATERIALIZED_EDGES`` — the canvas
    then answers at EVERY granularity from storage alone. Above budget
    it falls back to the structural depth-diagonal + on-demand reads
    (the scale mode; the cube scales as edges × depth² and OOM'd real
    instances: 1.17M edges → 5.6M pairs). ``true``/``false`` force a
    mode (a forced cube over budget fails terminally, loudly)."""
    raw = os.getenv("AGGREGATION_MATERIALIZE_FINE_PAIRS", "auto").strip().lower()
    if raw in ("1", "true", "yes", "on"):
        return "true"
    if raw in ("0", "false", "no", "off"):
        return "false"
    return "auto"


def _max_materialized_edges() -> int:
    """Hard write budget: the pipeline refuses (fails the job loudly with
    guidance) rather than writing more :AGGREGATED edges than this into
    the shared FalkorDB instance. The materialized result lives in
    FalkorDB's RAM at ~0.5KB/edge — exceeding the instance's memory
    kills it for every graph it hosts.

    Default 16M ≈ 8GB at 0.5KB/edge. Sized against ONE SHARD, because a
    FalkorDB graph key lives entirely on one node — Redis Cluster does not
    split a graph, so sharding scales the NUMBER of graphs, not the size
    of any one (see ``falkordb_connection`` module docstring). The
    reference cluster runs ``maxmemory 40gb`` per shard at ~22GB planned
    usage, so ~18GB of headroom, and its capacity model assumes a largest
    single graph of ~8GB — this budget matches that and still clears the
    ~3-4M boundary pairs a 1M-node / 2M-edge graph produces by ~4x.

    It is a backstop, not a sizing guard: it exists so a pathological
    result fails LOUDLY here rather than filling the shard. That matters
    more on a cluster than standalone — ``noeviction`` at the shard cap
    fails writes for every graph on that shard, and with
    ``cluster-require-full-coverage no`` the rest of the cluster keeps
    serving, so it degrades partially instead of obviously. Raise it per
    job (ceiling 50M) only on an instance with the headroom to match."""
    return _env_int("AGGREGATION_MAX_MATERIALIZED_EDGES", 16_000_000, 10_000, 50_000_000)


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
    would reject should never be selected in the first place."""
    return _env_int("AGGREGATION_MAX_CUBE_EDGES", 8_000_000, 10_000, 50_000_000)


class MaterializationBudgetExceeded(ValueError):
    """The computed result is larger than ``max_materialized_edges``.

    Deterministic: recomputing yields the same count, so the worker must
    fail the job terminally instead of consuming its retry budget."""


class MaterializationPreconditionFailed(ValueError):
    """Graph/ontology state makes materialization impossible in a way a
    retry cannot fix (e.g. the graph has content but no node matches any
    non-leaf ontology label). Deterministic: the worker fails the job
    terminally instead of re-running EXTRACT once per retry."""


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
    ) -> None:
        self.p = provider
        self._job_id = job_id or ""
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
        self._phase_started = time.monotonic()
        self._phase_timings: Dict[str, float] = {}
        # Shrink-on-timeout scan state (see _fetch_range): a per-query
        # timeout halves the effective sub-range width for the REST of the
        # run (sticky), re-growing after sustained successes. None = the
        # knob width is healthy.
        self._scan_subwidth: Optional[int] = None
        self._scan_success_streak = 0

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
        resume = parse_cursor(self._last_cursor)
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

            # EXTRACT + COMPUTE always re-run (deterministic, minutes).
            await self._extract_and_compute()
            # Hard write budget: refuse a result that cannot fit in the
            # FalkorDB instance BEFORE the first write reaches it.
            self._check_write_budget()
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
                        "materialize_budget": self._knob_int(
                            "max_materialized_edges",
                            _max_materialized_edges, 10_000, 50_000_000,
                        ),
                    }
                    if self._cube_mode is not None else {}
                ),
                **(
                    {"cube_estimate": self._cube_estimate}
                    if getattr(self, "_cube_estimate", None) is not None
                    else {}
                ),
                **(
                    {"pairs_by_level": self._pairs_by_level}
                    if getattr(self, "_pairs_by_level", None) else {}
                ),
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
        live_stats = {"writes": self._writes, "deletes": self._deletes}
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
        provider's write path."""
        admission = getattr(self.p, "_admission_controller", None)
        t0 = time.monotonic()
        if admission is not None:
            async with admission.write_slot(self.p):
                result = await coro_factory()
        else:
            result = await coro_factory()
        elapsed = time.monotonic() - t0
        pace = elapsed * self._pacing_ratio
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
                "CALL db.relationshipTypes()", timeout=_scan_timeout_s(),
            )
            rels = {str(r[0]) for r in (res.result_set or []) if r and r[0]}
            res = await self.p._ro_query(
                "CALL db.labels()", timeout=_scan_timeout_s(),
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
                    timeout=_scan_timeout_s(),
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
        res = await runner(q, timeout=_scan_timeout_s())
        rows = res.result_set or []
        if rows and rows[0] and rows[0][0] is not None:
            return int(rows[0][0])
        return -1

    async def _count_type(self, safe_type: str) -> int:
        res = await self.p._ro_query(
            f"MATCH ()-[r:`{safe_type}`]->() RETURN count(r)",
            timeout=_scan_timeout_s(),
        )
        rows = res.result_set or []
        return int(rows[0][0] or 0) if rows and rows[0] else 0

    async def _fetch_range(self, run_one, lo: int, hi: int) -> list:
        """Run ``run_one(lo, hi) -> rows`` with shrink-on-timeout.

        A per-query ``asyncio.TimeoutError`` (deliberately never retried at
        the connection layer — a slow query must not be multiplied) used to
        fail the WHOLE run, sending the job back through worker retry into
        a full EXTRACT re-run. Instead: halve the effective width — sticky
        for the rest of the run so later ranges don't re-discover it — and
        re-fetch as sub-ranges; only a floor-width range that still times
        out (a real outage, not payload size) propagates. Eight consecutive
        un-split successes double the width back toward the knob ceiling.
        Outer loops keep knob-width strides, so RECONCILE cursor positions
        (absolute range lower bounds) are unaffected."""
        floor = _scan_shrink_floor()
        width = hi - lo
        sticky = self._scan_subwidth
        if sticky is not None and width > sticky:
            rows: list = []
            cur = lo
            while cur < hi:
                rows.extend(await self._fetch_range(run_one, cur, min(cur + sticky, hi)))
                cur = min(cur + sticky, hi)
            return rows
        try:
            rows = await run_one(lo, hi)
        except asyncio.TimeoutError:
            if width <= floor:
                logger.error(
                    "aggregation pipeline on %s: floor-width scan "
                    "[%d, %d) still timed out — treating as a provider "
                    "outage.", self.p._graph_name, lo, hi,
                )
                raise
            half = max(floor, width // 2)
            if self._scan_subwidth is None or half < self._scan_subwidth:
                self._scan_subwidth = half
            self._scan_success_streak = 0
            logger.warning(
                "aggregation pipeline on %s: scan [%d, %d) timed out — "
                "shrinking effective range width to %d and re-fetching.",
                self.p._graph_name, lo, hi, self._scan_subwidth,
            )
            return await self._fetch_range(run_one, lo, hi)
        self._scan_success_streak += 1
        if self._scan_subwidth is not None and self._scan_success_streak >= 8:
            self._scan_success_streak = 0
            ceiling = self._knob_int(
                "scan_range_width", _scan_range_width, 10_000, 5_000_000,
            )
            doubled = self._scan_subwidth * 2
            self._scan_subwidth = None if doubled >= ceiling else doubled
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
        conc = self._knob_int("extract_concurrency", _extract_concurrency, 1, 4)
        max_id = await self._max_edge_id(f"()-[r:`{safe_type}`]->()", proj=proj)
        runner = self.p._proj_ro_query if proj else self.p._ro_query

        async def run_one(lo: int, hi: int):
            res = await runner(
                f"MATCH (s)-[r:`{safe_type}`]->(t) "
                f"WHERE ID(r) >= $lo AND ID(r) < $hi "
                f"RETURN ID(s), ID(t)",
                params={"lo": lo, "hi": hi},
                timeout=_scan_timeout_s(),
            )
            return res.result_set or []

        async def fetch(lo: int):
            return lo, await self._fetch_range(run_one, lo, lo + width)

        lows = list(range(0, max_id + 1, width))
        for start in range(0, len(lows), conc):
            self._cancel_check()
            wave = lows[start:start + conc]
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
                if len(base) >= cap:
                    # Roll-ups are linear: rolling partial bases and summing
                    # equals rolling the whole base. Collapse now to bound
                    # memory; the accumulator merges across partials.
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
                "RETURN timestamp()", timeout=_scan_timeout_s(),
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

    async def _maybe_overflow_flush(self) -> None:
        """Early-apply the accumulator when it exceeds the memory cap.

        The first flush of a key this run OVERWRITES the stored weight
        (discarding any stale value or prior attempt's partial); repeat
        flushes ADD. Flushed edges carry ``latestUpdate >= run_start_ms``
        so the reconcile delete pass never removes them. Weights therefore
        stay EXACT across flushes and across restart-from-zero resumes."""
        cap = self._pair_cap()
        if len(self._acc) < cap:
            return
        self._check_write_budget()
        flushed = self._flushed
        overwrite = [k for k in self._acc if k not in flushed]
        add = [k for k in self._acc if k in flushed]
        logger.info(
            "aggregation pipeline on %s: accumulator hit cap %d — early "
            "flush (%d first-touch overwrite, %d add).",
            self.p._graph_name, cap, len(overwrite), len(add),
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
                timeout=_scan_timeout_s(),
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
        if mode == "true":
            self._cube_mode = True
            return
        if mode == "false":
            self._cube_mode = False
            return
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
        # The cube ceiling is deliberately NOT the write budget: the budget
        # is a runaway backstop sized well above any real result, while the
        # cube decision must stay pinned to what the instance can hold.
        # Sharing them would make raising the backstop silently turn "Auto"
        # into "Always full detail". See _max_cube_edges.
        cap = _max_cube_edges()
        write_budget = self._knob_int(
            "max_materialized_edges", _max_materialized_edges, 10_000, 50_000_000,
        )
        self._cube_estimate = estimate
        self._cube_mode = estimate <= cap
        logger.info(
            "aggregation pipeline on %s: auto mode — full-cube estimate "
            "~%d cells vs cube ceiling %d (write budget %d) → %s.",
            self.p._graph_name, estimate, cap, write_budget,
            "FULL CUBE (every ancestor combination stored)"
            if self._cube_mode else
            "structural depth-diagonal (cube exceeds ceiling; mixed "
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
        conc = self._knob_int("extract_concurrency", _extract_concurrency, 1, 4)
        res = await self.p._ro_query(
            "MATCH (n) RETURN max(ID(n))", timeout=_scan_timeout_s(),
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
                timeout=_scan_timeout_s(),
            )
            return r.result_set or []

        async def fetch(lo: int):
            return await self._fetch_range(run_one, lo, lo + width)

        lows = list(range(0, max_id + 1, width))
        for start in range(0, len(lows), conc):
            self._cancel_check()
            wave = lows[start:start + conc]
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

    def _check_write_budget(self) -> None:
        """Refuse to exceed the FalkorDB write budget — failing the job with
        guidance beats OOM-killing the shared instance."""
        cap = self._knob_int(
            "max_materialized_edges", _max_materialized_edges, 10_000, 50_000_000,
        )
        # Union, not sum: a key flushed earlier AND re-touched since sits
        # in both sets — summing double-counts it and terminally fails a
        # legitimately under-budget job.
        flushed = self._flushed
        projected = len(flushed) + sum(1 for k in self._acc if k not in flushed)
        if projected > cap:
            raise MaterializationBudgetExceeded(
                f"aggregation would materialize ~{projected} :AGGREGATED edges "
                f"({self._budget_composition()}), exceeding "
                f"max_materialized_edges={cap} for graph "
                f"'{self.p._graph_name}'. Writing this would risk exhausting the "
                f"FalkorDB instance's memory. This count is deterministic — the "
                f"job is not retried. Fixes: keep the default level-based "
                f"materialization (materialize_fine_pairs=false) so only "
                f"same-level container pairs are stored; raise the cap via "
                f"tuning only if the instance has headroom (~0.5KB per edge)."
            )

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
        conc = self._knob_int("extract_concurrency", _extract_concurrency, 1, 4)
        # Canonical identity per node: `urn`, or the source's configured URN-equivalent (e.g. `id`)
        # for onboarded third-party graphs whose nodes carry no `urn` (stamp_identity_urns normally
        # populates `urn` first; this coalesce covers any node it hasn't reached).
        ident_prop = getattr(self.p, "_node_identity_property", None)
        ident_expr = _node_identity_expr(ident_prop)
        res = await self.p._ro_query(
            "MATCH (n) RETURN max(ID(n))", timeout=_scan_timeout_s(),
        )
        rows = res.result_set or []
        max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
        directory: Dict[int, Tuple[str, str]] = {}

        async def run_one(lo: int, hi: int):
            res = await self.p._ro_query(
                "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
                f"RETURN ID(n), {ident_expr}, labels(n)",
                params={"lo": lo, "hi": hi},
                timeout=_scan_timeout_s(),
            )
            return res.result_set or []

        async def fetch(lo: int):
            return await self._fetch_range(run_one, lo, lo + width)

        lows = list(range(0, max_id + 1, width))
        for start in range(0, len(lows), conc):
            self._cancel_check()
            wave = lows[start:start + conc]
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
                timeout=_scan_timeout_s(),
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
        return max(100, min(
            self.p._aggregation_sub_batch_size,
            self.p._bulk_create_batch_size,
        ))

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
                elapsed, _ = await self._paced_write(
                    lambda c=cypher, b=payload: self.p._proj_query(
                        c, params={"batch": b, "digest": self._level_digest},
                        timeout=self.p._bulk_create_timeout_s,
                    )
                )
                self._note_write_latency(elapsed)
                self._writes += len(chunk)
                await self._heartbeat()

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
                    timeout=_scan_timeout_s(),
                )
                if probe.result_set:
                    # Chunked: a legacy generation can hold millions of
                    # NULL-aggKey edges, and one unbounded DELETE times out
                    # on every run — leaving the legacy cube double-serving
                    # pairs forever. LIMIT-bounded passes make progress
                    # each run even if a later pass fails.
                    chunk = self._knob_int("delete_chunk", _delete_chunk, 100, 50_000)
                    while True:
                        self._cancel_check()
                        _, res = await self._paced_write(lambda: self.p._proj_query(
                            "MATCH ()-[r:AGGREGATED]->() "
                            "WHERE r.aggKey IS NULL "
                            "AND (r.latestUpdate IS NULL OR r.latestUpdate < $runStart) "
                            f"WITH r LIMIT {chunk} DELETE r",
                            params={"runStart": self._run_start_ms},
                            timeout=self.p._bulk_create_timeout_s,
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
                            timeout=_scan_timeout_s(),
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
            if not dedicated:
                res = await runner(
                    "MATCH (a)-[r:AGGREGATED]->(b) "
                    "WHERE ID(r) >= $lo AND ID(r) < $hi "
                    "RETURN ID(a), ID(b), r.aggKey, r.weight, r.levelDigest, "
                    "r.latestUpdate, r.sourceEdgeTypes, r.sourceLevel, "
                    "r.targetLevel, r.sourceDepth, r.targetDepth",
                    params={"lo": lo_, "hi": hi_},
                    timeout=_scan_timeout_s(),
                )
            else:
                res = await runner(
                    "MATCH (a)-[r:AGGREGATED]->(b) "
                    "WHERE ID(r) >= $lo AND ID(r) < $hi "
                    "RETURN r.aggKey, r.weight, r.levelDigest, r.latestUpdate, "
                    "r.sourceEdgeTypes, r.sourceLevel, r.targetLevel, "
                    "r.sourceDepth, r.targetDepth",
                    params={"lo": lo_, "hi": hi_},
                    timeout=_scan_timeout_s(),
                )
            return res.result_set or []

        while lo <= max_id:
            hi = lo + width
            self._cancel_check()
            range_rows = await self._fetch_range(run_one, lo, hi)
            to_delete: List[str] = []
            to_overwrite: List[int] = []
            to_add: List[int] = []
            for row in range_rows:
                if not dedicated:
                    (aid, bid, agg_key, weight, row_digest, latest,
                     row_et, row_sl, row_tl, row_sd, row_td) = row
                    if aid is None or bid is None:
                        continue
                    key: Optional[int] = _pack(int(aid), int(bid))
                else:
                    (agg_key, weight, row_digest, latest,
                     row_et, row_sl, row_tl, row_sd, row_td) = row
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
                    if agg_key:
                        to_delete.append(agg_key)
                    continue
                existing.add(key)
                if key in self._flushed:
                    # The graph already holds this key's flushed partial;
                    # the accumulator holds only the remainder → ADD it
                    # unconditionally (a weight comparison is meaningless).
                    to_add.append(key)
                elif (
                    int(weight or 0) != values.weight(val)
                    or (row_digest or "") != digest
                    or self._row_meta_stale(
                        val, row_et, row_sl, row_tl, row_sd, row_td, key,
                    )
                ):
                    to_overwrite.append(key)

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
                    "CALL db.indexes()", timeout=_scan_timeout_s(),
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
        for ddl in (
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.aggKey)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth, r.targetDepth)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.sourceDepth)",
            "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.targetDepth)",
        ):
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
        chunk_size = self._knob_int("delete_chunk", _delete_chunk, 100, 50_000)
        run_start = self._run_start_ms
        cypher = (
            "UNWIND $keys AS k "
            "MATCH ()-[r:AGGREGATED {aggKey: k}]->() "
            "WHERE r.latestUpdate IS NULL OR r.latestUpdate < $runStart "
            "DELETE r"
        )
        for start in range(0, len(agg_keys), chunk_size):
            self._cancel_check()
            chunk = agg_keys[start:start + chunk_size]
            params: Dict[str, Any] = {"keys": chunk, "runStart": run_start}
            await self._paced_write(lambda c=cypher, p=params: self.p._proj_query(
                c, params=p, timeout=self.p._bulk_create_timeout_s,
            ))
            self._deletes += len(chunk)
            await self._heartbeat()

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
                timeout=self.p._bulk_create_timeout_s,
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
    )
    return await pipeline.run()
