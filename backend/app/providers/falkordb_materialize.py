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

**Level-based materialization boundary (the scale contract):** only the
SAME-LEVEL diagonal is materialized — table→table, database→database,
domain→domain — with COMPLETE weights, plus the direct base pair of any
raw lineage edge whose endpoints are both non-leaf (the exact record of
cross-level raw facts). Each raw edge contributes at most ONE pair per
level, and the per-level sets shrink monotonically going up (a quotient
graph per level) — the minimal spanning set. Everything else is served
ON DEMAND by ``get_aggregated_edges_between``, bounded by the requested
visible set: leaf-involving pairs (column→table, column→domain,
column→column: edges × depth if stored — the 5.6M-pair OOM) from raw
lineage fan-out + upward containment walks, and mixed-level container
pairs (table→domain: edges × depth² level combinations if stored —
still 2.33M pairs after only the leaf cut) from the finer endpoint's
materialized same-level cells + a strict upward walk. Same answers,
same response shape; the graph stops storing millions of precomputed
answers. ``AGGREGATION_MATERIALIZE_FINE_PAIRS`` restores the legacy
full cube (guarded by the write budget); jobs without an ontology level
map fall back to it automatically.

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
    larger result payloads; 250k rows of 2-3 ints is a few MB."""
    return _env_int("AGGREGATION_SCAN_RANGE_WIDTH", 250_000, 10_000, 5_000_000)


def _max_pending_pairs() -> int:
    """Memory cap on the in-worker pair accumulator AND the raw-pair base
    map. Crossing it triggers a lattice roll-up (base) or an early flush
    to the graph (accumulator) — memory stays bounded on pathological
    graphs at the cost of extra writes. Default 5M (~500MB packed) keeps
    typical multi-million-edge graphs on the flush-free diff path within
    the worker's 4Gi budget."""
    return _env_int("AGGREGATION_MAX_PENDING_PAIRS", 5_000_000, 50_000, 50_000_000)


def _delete_chunk() -> int:
    return _env_int("AGGREGATION_DELETE_CHUNK", 10_000, 100, 50_000)


def _apply_chunk() -> int:
    return _env_int("AGGREGATION_APPLY_CHUNK", 20_000, 1_000, 200_000)


def _pacing_ratio() -> float:
    """Sleep between write sub-batches for ``last_batch_duration × ratio``
    — bounds this job's FalkorDB write duty cycle (0.5 → ≤ ~66%), leaving
    query threads for interactive readers."""
    return _env_float("AGGREGATION_WRITE_PACING_RATIO", 0.5, 0.0, 10.0)


def _scan_timeout_s() -> float:
    return _env_float("FALKORDB_SCAN_RANGE_TIMEOUT", 30.0, 5.0, 600.0)


def _extract_concurrency() -> int:
    """Concurrent read-only range scans (extract/reconcile/node directory).
    Bounded well below the server's THREAD_COUNT so interactive readers
    always have query threads."""
    return _env_int("AGGREGATION_EXTRACT_CONCURRENCY", 2, 1, 4)


def _scan_shrink_floor() -> int:
    """Smallest ID-range width the shrink-on-timeout ladder descends to.
    A range THIS narrow that still times out is a server outage, not a
    payload problem — the timeout propagates and the run fails."""
    return _env_int("AGGREGATION_SCAN_SHRINK_FLOOR", 10_000, 1, 5_000_000)


def _materialize_leaf_pairs() -> bool:
    return os.getenv(
        "AGGREGATION_MATERIALIZE_LEAF_PAIRS", "false"
    ).strip().lower() in ("1", "true", "yes", "on")


def _materialize_fine_pairs() -> bool:
    """Legacy full-cube mode: materialize EVERY ancestor-pair combination,
    including pairs involving leaf-LEVEL nodes (column→table,
    column→domain, …) and mixed-level container pairs (table→domain).
    The full cube scales as edges × depth² level combinations — the
    blow-up that can exceed the FalkorDB instance's memory (observed:
    1.17M edges → 5.6M pairs → OOM). Default OFF: only same-level
    container pairs are materialized; leaf-involving and mixed-level
    pairs are served on demand by ``get_aggregated_edges_between``, so
    the capability is unchanged while the materialized set stays one
    pair per level per raw edge, shrinking monotonically up the
    hierarchy."""
    return os.getenv(
        "AGGREGATION_MATERIALIZE_FINE_PAIRS", "false"
    ).strip().lower() in ("1", "true", "yes", "on")


def _max_materialized_edges() -> int:
    """Hard write budget: the pipeline refuses (fails the job loudly with
    guidance) rather than writing more :AGGREGATED edges than this into
    the shared FalkorDB instance. The materialized result lives in
    FalkorDB's RAM at ~0.5KB/edge — exceeding the instance's memory
    kills it for every graph it hosts."""
    return _env_int("AGGREGATION_MAX_MATERIALIZED_EDGES", 2_000_000, 10_000, 50_000_000)


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
        # Non-leaf-LEVEL node ID → ontology level (labels whose level is
        # above the finest). Loaded via cheap per-label ID scans when the
        # fine filter is active; the map is bounded by CONTAINER counts
        # (small), never by edge or leaf counts. None = filter inactive.
        self._nonleaf_levels: Optional[Dict[int, int]] = None
        # Memoized (level, id) ancestor rep-chains keyed by non-leaf node
        # — bounded by container count; reset when the parent map reloads.
        self._rep_chain_cache: Dict[int, Tuple[Tuple[int, int], ...]] = {}
        self._fine_merges_skipped = 0
        # Level map re-keyed by observed label spellings, built lazily —
        # see _levels_by_observed_label.
        self._levels_by_spelling: Optional[Dict[str, int]] = None
        self._single_level_logged = False

        # Run state
        self._run_start_ms: int = 0
        self._containment: List[str] = []
        self._effective_types: List[str] = []
        self._type_bit: Dict[str, int] = {}
        self._values = _PairValues(1)
        self._parents: Dict[int, int] = {}
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

            await self._stamp_materialized()
            final_total = len(self._flushed | set(self._acc.keys()))
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

    def _snapshot_pairs_by_level(self) -> None:
        """Level-pair histogram of the computed result, persisted into
        run_stats — makes a MISSING level (e.g. no domain→domain pairs
        because the domain label didn't match the graph) visible in the
        job detail instead of requiring a graph query to diagnose."""
        nonleaf = self._nonleaf_levels
        if nonleaf is None:
            return
        counts: Dict[str, int] = {}
        for key in set(self._acc) | self._flushed:
            sid, tid = _unpack(key)
            ls, lt = nonleaf.get(sid), nonleaf.get(tid)
            name = f"L{ls}->L{lt}" if ls is not None and lt is not None else "unknown"
            counts[name] = counts.get(name, 0) + 1
        self._pairs_by_level = counts
        logger.info(
            "aggregation pipeline on %s: computed pairs by level: %s",
            self.p._graph_name,
            ", ".join(f"{k}={v}" for k, v in sorted(counts.items())) or "none",
        )

    def _result(self, affected: int = 0) -> Dict[str, Any]:
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
                **(
                    {"pairs_by_level": self._pairs_by_level}
                    if getattr(self, "_pairs_by_level", None) else {}
                ),
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

    async def _resolve_types(self) -> None:
        p = self.p
        if self._containment_arg:
            self._containment = list(p._alias_rel_types(list(self._containment_arg)))
        else:
            self._containment = list(p._get_containment_edge_types())
        if self._lineage_arg:
            effective = p._alias_rel_types(
                [t for t in self._lineage_arg if t and t != "AGGREGATED"]
            )
        else:
            effective = await p._derive_lineage_types_from_cache(self._containment)
        # Sorted + deduped so edge-type bitmask indices are deterministic
        # across restarts of the same run.
        self._effective_types = sorted({str(t) for t in effective if t})
        self._type_bit = {t: 1 << i for i, t in enumerate(self._effective_types)}

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

        # ---- containment → parent map (child_id → parent_id) ----
        multi_parents: Dict[int, List[int]] = {}
        parents: Dict[int, int] = {}
        for ctype in sorted({str(t) for t in self._containment if t}):
            safe = _sanitize_label(ctype)
            async for _lo, rows in self._scan_type_ranges(safe):
                for parent_id, child_id in rows:
                    if parent_id is None or child_id is None:
                        continue
                    parent_id, child_id = int(parent_id), int(child_id)
                    existing = parents.get(child_id)
                    if existing is None:
                        parents[child_id] = parent_id
                    elif existing != parent_id:
                        candidates = multi_parents.setdefault(child_id, [existing])
                        if parent_id not in candidates:
                            candidates.append(parent_id)
        if multi_parents:
            self._resolve_multi_parents(parents, multi_parents)
        self._break_cycles(parents)
        self._parents = parents
        self._rep_chain_cache = {}  # chains derive from the fresh parent map
        logger.info(
            "aggregation pipeline on %s: containment loaded — %d child→parent "
            "entries (%d multi-parent nodes resolved by longest chain).",
            self.p._graph_name, len(parents), len(multi_parents),
        )

        # ---- materialization boundary (non-leaf node IDs) ----
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

    def _resolve_multi_parents(
        self, parents: Dict[int, int], multi: Dict[int, List[int]],
    ) -> None:
        """Longest-chain rule for multi-parent nodes — parity with the
        legacy ``_compute_ancestor_chain``'s ``ORDER BY length(path) DESC``
        (ties broken deterministically by smaller node id)."""
        def chain_depth(node: int) -> int:
            depth = 0
            seen: Set[int] = set()
            cur: Optional[int] = node
            while cur is not None and cur not in seen:
                seen.add(cur)
                cur = parents.get(cur)
                if cur is not None:
                    depth += 1
            return depth

        for child, candidates in multi.items():
            best = max(candidates, key=lambda c: (chain_depth(c), -c))
            parents[child] = best

    @staticmethod
    def _break_cycles(parents: Dict[int, int]) -> None:
        """Defensively break containment cycles (bad data) so chain walks
        terminate. Removes the link that closes any detected cycle."""
        state: Dict[int, int] = {}  # 0 = on current path, 1 = done
        for start in list(parents.keys()):
            if state.get(start) == 1:
                continue
            path: List[int] = []
            cur: Optional[int] = start
            while cur is not None:
                s = state.get(cur)
                if s == 1:
                    break
                if s == 0:
                    # ``path[-1] → cur`` closed a cycle — cut it.
                    del parents[path[-1]]
                    logger.warning(
                        "aggregation pipeline: containment cycle detected at "
                        "node %d; breaking parent link of node %d.",
                        cur, path[-1],
                    )
                    break
                state[cur] = 0
                path.append(cur)
                cur = parents.get(cur)
            for n in path:
                state[n] = 1

    async def _rollup_base(self, base: Dict[int, int]) -> None:
        """Merge every materialized cell derived from one (partial) base
        map into the run accumulator.

        With the boundary active (``self._nonleaf_levels`` loaded), each
        raw pair produces its CANONICAL LEVEL-BRIDGED pairs: for every
        ontology level L present on either ancestor chain, the pair of
        each side's deepest non-leaf ancestor at level ≤ L. On aligned
        chains this is exactly the same-level diagonal (table→table,
        domain→domain). On RAGGED chains (a column hanging directly
        under a domain, skipping table/schema) it yields the mixed-level
        cell the canvas shows at each granularity (table→domain) — the
        cell a pure level-equality filter silently drops. Either way the
        bound is at most one pair per level per raw edge. Cross-level
        raw lineage (a raw table→database edge) falls out of the same
        rule — no special base-cell case.

        Without the boundary (legacy full-cube mode) the original
        ancestor-lattice roll produces every cross-product cell; the
        (0,0) raw mirror is merged only when
        ``AGGREGATION_MATERIALIZE_LEAF_PAIRS`` is on. Equal-endpoint
        pairs are excluded from output in both modes (legacy
        ``if sa == ta: continue`` parity).
        """
        if not base:
            return
        values = self._values
        parents = self._parents
        nonleaf = self._nonleaf_levels  # None = boundary inactive

        if nonleaf is not None:
            await self._merge_canonical_pairs(base)
            return

        def roll(cell: Dict[int, int], *, source_side: bool) -> Dict[int, int]:
            out: Dict[int, int] = {}
            for key, val in cell.items():
                sid, tid = _unpack(key)
                p = parents.get(sid if source_side else tid)
                if p is None:
                    continue
                nk = _pack(p, tid) if source_side else _pack(sid, p)
                cur = out.get(nk)
                out[nk] = val if cur is None else values.merge(
                    cur, values.weight(val), values.mask(val),
                )
            return out

        async def merge_cell(cell: Dict[int, int]) -> None:
            acc = self._acc
            for key, val in cell.items():
                sid, tid = _unpack(key)
                if sid == tid:
                    continue
                cur = acc.get(key)
                acc[key] = val if cur is None else values.merge(
                    cur, values.weight(val), values.mask(val),
                )
            await self._maybe_overflow_flush()

        if self._knob_bool("materialize_leaf_pairs", _materialize_leaf_pairs):
            await merge_cell(base)

        row = base
        while True:
            # Target-side roll-ups of the current row: cells (i, 1..k).
            cell = row
            while True:
                cell = roll(cell, source_side=False)
                if not cell:
                    break
                await merge_cell(cell)
                await asyncio.sleep(0)  # yield during long CPU stretches
            # Next source-side row: cell (i+1, 0).
            row = roll(row, source_side=True)
            if not row:
                break
            await merge_cell(row)
            await asyncio.sleep(0)

    def _rep_chain(self, node: int) -> Tuple[Tuple[int, int], ...]:
        """(level, id) of every non-leaf ancestor-or-self of ``node``,
        deepest (largest level) first. Memoized per non-leaf node —
        bounded by container count, shared by every leaf underneath."""
        nonleaf = self._nonleaf_levels
        parents = self._parents
        cache = self._rep_chain_cache
        # Leaf/unknown endpoints climb to their first non-leaf ancestor;
        # visited-guard bounds dirty-data containment cycles.
        cur: Optional[int] = node
        visited: Set[int] = set()
        while cur is not None and cur not in nonleaf:
            if cur in visited:
                return ()
            visited.add(cur)
            cur = parents.get(cur)
        if cur is None:
            return ()
        # Walk upward from the first non-leaf rep until a cache hit,
        # skipping ancestors with no ontology level (unknown labels) —
        # the legacy lattice rolled straight through such gaps too.
        path: List[int] = []
        while cur is not None and cur not in cache:
            if cur in visited:
                break
            visited.add(cur)
            path.append(cur)
            nxt = parents.get(cur)
            while nxt is not None and nxt not in nonleaf:
                if nxt in visited:
                    nxt = None
                    break
                visited.add(nxt)
                nxt = parents.get(nxt)
            cur = nxt
        tail: Tuple[Tuple[int, int], ...] = cache.get(cur, ()) if cur is not None else ()
        for n in reversed(path):
            tail = ((nonleaf[n], n),) + tail
            cache[n] = tail
        return tail

    async def _merge_canonical_pairs(self, base: Dict[int, int]) -> None:
        """Boundary-mode rollup: canonical level-bridged pairs per raw
        pair. Weight semantics: each raw pair's value contributes ONCE
        to each distinct canonical pair (a pair repeated across levels —
        the ragged case — is merged once)."""
        values = self._values
        acc = self._acc
        skipped = 0
        n = 0
        for key, val in base.items():
            sid, tid = _unpack(key)
            cs = self._rep_chain(sid)
            ct = self._rep_chain(tid)
            if not cs or not ct:
                skipped += 1
                continue
            pairs: Set[int] = set()
            for level in {l for l, _ in cs} | {l for l, _ in ct}:
                sp = next((i for l, i in cs if l <= level), None)
                tp = next((i for l, i in ct if l <= level), None)
                if sp is None or tp is None or sp == tp:
                    continue
                pairs.add(_pack(sp, tp))
            if not pairs:
                skipped += 1
                continue
            for nk in pairs:
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


    # -- level-based materialization boundary --------------------------------

    def _fine_filter_active(self) -> bool:
        """True when leaf-involving pairs are excluded from materialization
        (the default). Requires the ontology level map to classify labels;
        legacy jobs without it fall back to full-cube behavior."""
        if not self._entity_levels:
            return False
        if not self._nonleaf_labels():
            # Single-level ontology: every declared type sits at the finest
            # level, so there IS no container boundary — the only content
            # the original full cube stored was the leaf mirror set. Fall
            # back to full-cube behavior (still bounded by the write
            # budget) instead of failing on an empty boundary map.
            if not self._single_level_logged:
                self._single_level_logged = True
                logger.info(
                    "aggregation pipeline on %s: ontology is single-level "
                    "(no non-leaf entity types) — materializing exact "
                    "leaf-to-leaf pairs (full-cube fallback).",
                    self.p._graph_name,
                )
            return False
        return not self._knob_bool("materialize_fine_pairs", _materialize_fine_pairs)

    def _nonleaf_labels(self) -> List[str]:
        finest = max(self._entity_levels.values())
        return [lbl for lbl, lv in self._entity_levels.items() if lv < finest]

    async def _scan_label_nodes(self, label: str, *, want_urn: bool):
        """Yield rows for all nodes of one label via ID-range scans (label
        matrix iteration + cheap ID filter — never an unlabeled scan)."""
        from backend.app.providers.falkordb_provider import _sanitize_label
        safe = _sanitize_label(label)
        width = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        conc = self._knob_int("extract_concurrency", _extract_concurrency, 1, 4)
        res = await self.p._ro_query(
            "MATCH (n) RETURN max(ID(n))", timeout=_scan_timeout_s(),
        )
        rows = res.result_set or []
        max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
        returns = "ID(n), n.urn" if want_urn else "ID(n)"

        async def run_one(lo: int, hi: int):
            r = await self.p._ro_query(
                f"MATCH (n:`{safe}`) WHERE ID(n) >= $lo AND ID(n) < $hi "
                f"RETURN {returns}",
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
                    yield row

    async def _load_nonleaf_ids(self) -> None:
        """Populate the non-leaf node-ID → level map used by the
        materialization boundary. Bounded by container counts — cheap at
        any graph size."""
        if self._nonleaf_levels is not None or not self._fine_filter_active():
            return
        levels: Dict[int, int] = {}
        for label in self._nonleaf_labels():
            level = self._entity_levels[label]
            # Scan under every observed spelling of the declared label
            # (identity on governed graphs) — an alias-variant source
            # must not silently produce an empty boundary map, which
            # would filter EVERY pair and materialize nothing.
            spellings = getattr(self.p, "_alias_entity_types", lambda t: t)([label])
            for spelled in spellings:
                async for row in self._scan_label_nodes(spelled, want_urn=False):
                    if row and row[0] is not None:
                        levels[int(row[0])] = level
        if not levels:
            probe = await self.p._ro_query(
                "MATCH (n) RETURN 1 LIMIT 1", timeout=_scan_timeout_s(),
            )
            if not (probe.result_set or []):
                # The graph has no nodes at all (pre-ingest, onboarding):
                # nothing to materialize and nothing to wipe — an empty
                # boundary map is safe here and the run completes as a
                # clean no-op instead of a failed job.
                logger.info(
                    "aggregation pipeline on %s: graph is empty — nothing "
                    "to materialize (no-op run).", self.p._graph_name,
                )
                self._nonleaf_levels = {}
                return
            raise MaterializationPreconditionFailed(
                "materialization boundary is EMPTY: the graph has nodes "
                "but none matched any non-leaf ontology label. Continuing "
                "would materialize nothing and the reconcile pass would "
                "then delete every existing :AGGREGATED edge as stale — "
                "refusing. Check that the ontology's entity-type labels "
                "(or their source aliases) match the graph's labels."
            )
        self._nonleaf_levels = levels
        by_level: Dict[int, int] = {}
        for lv in levels.values():
            by_level[lv] = by_level.get(lv, 0) + 1
        logger.info(
            "aggregation pipeline on %s: materialization boundary loaded — "
            "%d non-leaf nodes by level: %s (a level with 0 nodes here "
            "CANNOT produce same-level pairs — check that its ontology "
            "label matches the graph). Leaf-involving and mixed-level "
            "pairs are served on demand.",
            self.p._graph_name, len(levels),
            ", ".join(f"L{lv}={n}" for lv, n in sorted(by_level.items())),
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
        """Per-level-pair histogram of the would-be result, so operators
        can see WHAT exceeded the budget. Only computed on failure."""
        nonleaf = self._nonleaf_levels
        counts: Dict[Tuple[Optional[int], Optional[int]], int] = {}
        for key in list(self._acc) + list(self._flushed):
            sid, tid = _unpack(key)
            lk = (
                (nonleaf.get(sid), nonleaf.get(tid))
                if nonleaf is not None else (None, None)
            )
            counts[lk] = counts.get(lk, 0) + 1
        def _name(lv: Optional[int]) -> str:
            return "leaf" if lv is None else f"L{lv}"
        top = sorted(counts.items(), key=lambda kv: -kv[1])[:5]
        return ", ".join(
            f"{_name(ls)}→{_name(lt)}: {n}" for (ls, lt), n in top
        )

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
        if self._fine_filter_active():
            directory: Dict[int, Tuple[str, str]] = {}
            for label in self._nonleaf_labels():
                # Scan and record the OBSERVED spelling — the directory's
                # label feeds the label+urn MERGE writes, which must match
                # the graph's actual labels on alias-variant sources.
                spellings = getattr(self.p, "_alias_entity_types", lambda t: t)([label])
                for spelled in spellings:
                    interned = sys.intern(str(spelled))
                    async for row in self._scan_label_nodes(spelled, want_urn=True):
                        if row and row[0] is not None and row[1]:
                            directory[int(row[0])] = (row[1], interned)
            self._node_dir = directory
            logger.info(
                "aggregation pipeline on %s: node directory loaded — %d "
                "non-leaf entries (leaf nodes excluded by the "
                "materialization boundary).",
                self.p._graph_name, len(directory),
            )
            return directory
        width = self._knob_int("scan_range_width", _scan_range_width, 10_000, 5_000_000)
        conc = self._knob_int("extract_concurrency", _extract_concurrency, 1, 4)
        res = await self.p._ro_query(
            "MATCH (n) RETURN max(ID(n))", timeout=_scan_timeout_s(),
        )
        rows = res.result_set or []
        max_id = int(rows[0][0]) if rows and rows[0] and rows[0][0] is not None else -1
        directory: Dict[int, Tuple[str, str]] = {}

        async def run_one(lo: int, hi: int):
            res = await self.p._ro_query(
                "MATCH (n) WHERE ID(n) >= $lo AND ID(n) < $hi "
                "RETURN ID(n), n.urn, labels(n)",
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
                    nid, urn, labels = row[0], row[1], row[2] or []
                    if nid is None or not urn or not labels:
                        continue
                    directory[int(nid)] = (urn, sys.intern(str(labels[0])))
        self._node_dir = directory
        logger.info(
            "aggregation pipeline on %s: node directory loaded — %d entries.",
            self.p._graph_name, len(directory),
        )
        return directory

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
            expand = getattr(self.p, "_alias_entity_types", lambda t: t)
            out: Dict[str, int] = {}
            for lbl, lv in self._entity_levels.items():
                for spelled in expand([lbl]):
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
            })
        if dropped:
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
                    "r.targetLevel",
                    params={"lo": lo_, "hi": hi_},
                    timeout=_scan_timeout_s(),
                )
            else:
                res = await runner(
                    "MATCH (a)-[r:AGGREGATED]->(b) "
                    "WHERE ID(r) >= $lo AND ID(r) < $hi "
                    "RETURN r.aggKey, r.weight, r.levelDigest, r.latestUpdate, "
                    "r.sourceEdgeTypes, r.sourceLevel, r.targetLevel",
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
                     row_et, row_sl, row_tl) = row
                    if aid is None or bid is None:
                        continue
                    key: Optional[int] = _pack(int(aid), int(bid))
                else:
                    (agg_key, weight, row_digest, latest,
                     row_et, row_sl, row_tl) = row
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
                    or self._row_meta_stale(val, row_et, row_sl, row_tl, key)
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
        self, val: int, row_et: Any, row_sl: Any, row_tl: Any, key: int,
    ) -> bool:
        """Weight-preserving drift the weight/digest comparison can't see:
        ``sourceEdgeTypes`` replaced type-for-type (same count, different
        types — a TRANSFORMS-filtered trace would silently drop the edge)
        or level stamps written by a pre-alias-fix build (NULL on
        alias-variant sources, which blinds the mixed-level reader)."""
        mask = self._values.mask(val)
        desired_et = {
            t for i, t in enumerate(self._effective_types) if mask & (1 << i)
        }
        stored_et = set(row_et) if isinstance(row_et, list) else (
            {row_et} if row_et else set()
        )
        if stored_et != desired_et:
            return True
        nonleaf = self._nonleaf_levels
        if nonleaf:
            sid, tid = _unpack(key)
            desired_sl, desired_tl = nonleaf.get(sid), nonleaf.get(tid)
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
        MERGE-on-aggKey an index seek instead of an O(out_degree) scan."""
        try:
            await self.p._proj_query(
                "CREATE INDEX FOR ()-[r:AGGREGATED]-() ON (r.aggKey)",
                timeout=float(os.getenv("FALKORDB_INIT_TIMEOUT", "3")),
            )
        except Exception as exc:
            msg = str(exc).lower()
            if "already" not in msg and "exist" not in msg:
                logger.warning(
                    "aggregation pipeline on %s: could not ensure "
                    "AGGREGATED(aggKey) index (%s) — MERGE will be slower.",
                    self.p._graph_name, exc,
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

    async def _stamp_materialized(self) -> None:
        try:
            if self.p._redis is not None:
                from datetime import datetime, timezone
                await self.p._redis.set(
                    self.p._agg_last_materialized_key(),
                    datetime.now(timezone.utc).isoformat(),
                )
                # Storage-regime marker for the read path: the mixed-level
                # on-demand derivation (Q3) is only exact against CANONICAL
                # stored cells — running it on a legacy/fine full cube
                # double-counts every mixed-level weight. The reader gates
                # Q3 on this marker (falling back to a graph probe when it
                # is absent).
                if hasattr(self.p, "_agg_regime_key"):
                    await self.p._redis.set(
                        self.p._agg_regime_key(),
                        "boundary" if self._fine_filter_active() else "fine",
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
