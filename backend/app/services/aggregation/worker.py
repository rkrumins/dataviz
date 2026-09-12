"""
AggregationWorker — stateless batch materializer.

Executes aggregation jobs. Fully stateless and crash-recoverable.
This class has NO dependency on FastAPI, HTTP, the API layer,
or the ontology module. It is a pure executor.

CRASH RECOVERY CONTRACT:
- Progress state is checkpointed to DB on a coalesced cadence: commit
  whenever ≥2s has elapsed since the last commit OR ≥5 batches have
  accumulated, whichever comes first. The outer run()'s finally block
  always commits on completion/failure, so no progress is ever lost
  beyond the ≤2s window.
- Worker reads `last_cursor` on start — resumes from checkpoint
- MERGE-based writes are idempotent — replaying the ≤2s gap is safe
- Recovery is handled by AggregationService (not this class)

WHY COALESCED COMMITS: previously committed per batch, which under
SQLite with 1000+ batches created sustained write pressure that blocked
readiness polling. Coalescing cuts write volume ~5× without weakening
recovery (MERGE idempotency absorbs the replay window).

CURSOR-BASED PAGINATION (CRIT-2):
- Uses stable cursor on sorted edge identifiers, NOT SKIP/OFFSET
- Eliminates O(n²) performance degradation for multi-million edge graphs
- Safe under concurrent graph mutations
"""
import asyncio
import json
import logging
import os
import random
import time
import types
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.adapters import (
    ProviderBusy,
    ProviderFailingOver,
    ProviderUnavailable,
)

from .steps import StepLedger
from backend.app.providers.falkordb_materialize import (
    MaterializationBudgetExceeded,
    MaterializationPreconditionFailed,
    MaterializationQueryMemoryExceeded,
    MaterializationScanTimedOut,
    MaterializationStoreUnreachable,
)

from backend.app.jobs import (
    JobScope as PlatformJobScope,
    get_emitter,
)
from backend.app.jobs.audit import record_terminal
from backend.app.jobs.metrics import increment as metrics_increment

from .cancel import JobCancelled, get_registry as get_cancel_registry
from .models import AggregationJobORM
from .fingerprint import compute_graph_fingerprint

logger = logging.getLogger(__name__)

_CHECKPOINT_MAX_INTERVAL_SECS: float = 2.0
_CHECKPOINT_MAX_BATCHES: int = 5
# Progress-aware watchdog (replaces the old fixed AGGREGATION_JOB_TIMEOUT_SECS
# kill that terminated 3h+ jobs at 2h regardless of forward progress):
# a job is killed only when it makes NO forward progress for the stall
# window, or exceeds the (very generous) wall-clock safety net.
# ``job.timeout_secs`` — when set on the job row — overrides the stall
# window, preserving the column's "how long may this hang" intent.
#
# 3h, matching what every UI trigger path sends explicitly. It used to be
# 900s, and the gap was invisible because only the MACHINE paths leave
# ``timeout_secs`` NULL: reconciliation drift and first builds, the cron
# drift sweep, the stale-marker reconciler, Refresh rollups, the projector
# heal hook and blank-model provisioning. Those are exactly the rebuilds
# nobody is watching, on exactly the graphs big enough to go quiet for more
# than fifteen minutes, and they were being killed for slowness the same
# rebuild started from the Re-trigger dialog would have tolerated. Raising
# the DEFAULT rather than passing 10800 at each call site is deliberate:
# the per-call-site pattern is how the divergence happened, it leaves the
# env var meaningful (freezing the value onto job rows would not), and it
# covers already-queued NULL rows. Must stay below the control plane's
# stale-job backstop at 2x AGGREGATION_JOB_TIMEOUT_SECS (4h by default) so
# the worker still kills a wedged job first.
_STALL_TIMEOUT_SECS: int = int(os.getenv("AGGREGATION_STALL_TIMEOUT_SECS", "10800"))
_MAX_WALL_SECS: int = int(os.getenv("AGGREGATION_JOB_MAX_WALL_SECS", "86400"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


#: ``run_stats.adapted`` scalars the live overlay carries (HSET / SSE
#: payload values must be str|int|float): what the ladder has changed so far.
_ADAPTED_LIVE_KEYS = ("scan_width", "scan_width_min", "scan_shrinks",
                      "extract_concurrency", "reconcile_strategy", "write_batch",
                      "delete_chunk", "timeout_retries", "memory_flushes",
                      "rss_high_water_mb", "mem_limit_mb",
                      "replica_waits", "replica_holds", "replica_max_lag_bytes")

#: The pipeline knobs an operator may change on the RUNNING job (PATCH
#: …/limits): the worker's watchdog re-reads them from the row and hands
#: them to the pipeline through the shared ``live`` dict — per-query
#: budgets read per query, pacing per write, concurrency per wave, the scan
#: width cap on every read of the sticky width.
_LIVE_PIPELINE_KEYS = ("scan_timeout_s", "write_timeout_s", "write_pacing_ratio",
                       "extract_concurrency", "scan_width",
                       "replica_ack_min", "replica_ack_timeout_ms",
                       "write_batch_max", "write_batch_target_s")


def _pace_scalars(pace: Any) -> dict:
    """The write pace as flat ``pace_<key>`` scalars for ``live_state`` —
    how the run is writing right now: rows per batch, seconds per batch,
    the pause after it, the rolling duty cycle and rate, and whether it is
    holding or eased, and why."""
    if not isinstance(pace, dict):
        return {}
    return {
        f"pace_{key}": value for key, value in pace.items()
        if isinstance(value, (str, int, float)) and not isinstance(value, bool)
    }


def _adapted_scalars(adapted: Any) -> dict:
    """The scalar subset of an ``adapted`` record, for ``live_state`` —
    the ladder's own state, plus the live changes in force flattened as
    ``adapted_live_<key>``."""
    if not isinstance(adapted, dict):
        return {}
    out = {}
    for key in _ADAPTED_LIVE_KEYS:
        value = adapted.get(key)
        if isinstance(value, (str, int, float)) and not isinstance(value, bool):
            out[f"adapted_{key}"] = value
    live = adapted.get("live")
    if isinstance(live, dict):
        for key, value in live.items():
            if isinstance(value, (str, int, float)) and not isinstance(value, bool):
                out[f"adapted_live_{key}"] = value
    return out


def _record_steps(job: Any, ledger: "StepLedger") -> None:
    """Fold the step ledger into the row's ``run_stats``. Called wherever
    the ledger moves outside the checkpoint callback (the two bookends and
    the terminal seal), so the record on the row is never behind the run
    it describes. Best-effort, like every other ``run_stats`` write: a
    serialization failure must not fail a job."""
    if not hasattr(job, "run_stats"):
        return
    try:
        doc = json.loads(getattr(job, "run_stats", None) or "{}")
        if not isinstance(doc, dict):
            doc = {}
        doc["steps"] = ledger.snapshot()
        job.run_stats = json.dumps(doc)
    except (TypeError, ValueError):
        pass


def _merge_run_doc(existing: Any, incoming: Any) -> dict:
    """``run_stats`` is written progressively: the effective-tuning snapshot
    and the live ``adapted`` record at checkpoints, the pipeline's full
    stats on success. Later values win key by key, so the snapshot a
    checkpoint wrote survives the success write and a failed run keeps
    whatever it had recorded."""
    out = dict(existing) if isinstance(existing, dict) else {}
    if isinstance(incoming, dict):
        out.update(incoming)
    return out


#: Learned-state keys the worker persists per source and hands back as
#: capacity hints (``<key>_observed``). Every one only ever makes the next
#: run STRICTER; the pipeline ignores a hint looser than the knob in force.
#: One wall clock for the whole before/after fingerprint, not one per scan.
#: The fingerprint is three full graph scans; each used to carry the 30s env
#: ceiling on its own, so a job could spend a minute and a half measuring a
#: graph it was about to measure again.
_FINGERPRINT_BUDGET_S = float(os.getenv("FALKORDB_STATS_QUERY_TIMEOUT_SECS", "30"))

_LEARNED_KEYS = ("scan_width", "extract_concurrency", "reconcile_strategy",
                 "write_batch", "delete_chunk", "apply_rows_per_s")


def _learned_from(run_stats: Any, *, job_id: Optional[str] = None) -> dict:
    """What this run's ``adapted`` record teaches the next run of the same
    source: the narrowest scan width it needed, whether it read serially,
    the reconcile strategy it switched to, the write batch / delete chunk it
    settled on. Learned from THIS run's pressure only — a run that hit no
    pressure returns ``{}``, which CLEARS the previous lesson (a hinted run
    re-grows its width during the run, so a graph that no longer needs the
    narrowing is found out within that run, e.g. after a QUERY_MEM_CAPACITY
    raise)."""
    if not isinstance(run_stats, dict):
        return {}
    out: dict = {}
    # The rate this run wrote at is a MEASUREMENT, not a lesson learned
    # under pressure: it is carried on every run that wrote anything, and
    # it is what the next run projects the cube's apply time from. The
    # pressure keys below keep their clear-on-a-clean-run contract.
    rate = run_stats.get("apply_rows_per_s_observed")
    if isinstance(rate, (int, float)) and not isinstance(rate, bool) and rate > 0:
        out["apply_rows_per_s"] = float(rate)
    adapted = run_stats.get("adapted")
    if not isinstance(adapted, dict) or not adapted.get("pressure"):
        if out:
            out["observed_at"] = _now()
            if job_id:
                out["job_id"] = job_id
        return out
    if adapted.get("scan_width_min"):
        out["scan_width"] = int(adapted["scan_width_min"])
    if adapted.get("extract_concurrency") == 1:
        out["extract_concurrency"] = 1
    if adapted.get("reconcile_strategy") == "keys_only":
        out["reconcile_strategy"] = "keys_only"
    if adapted.get("write_batch_min"):
        out["write_batch"] = int(adapted["write_batch_min"])
    if adapted.get("delete_chunk_min"):
        out["delete_chunk"] = int(adapted["delete_chunk_min"])
    if out:
        out["observed_at"] = _now()
        if job_id:
            out["job_id"] = job_id
    return out


def _merge_live_limits(stall_timeout: int, wall_base: int, fresh: dict) -> tuple:
    """``(stall, wall)`` after a live re-read: the row's ``timeout_secs``
    replaces the stall window when set; the raised wall clock (else the
    job's base) is never below the stall window."""
    stall = int(fresh.get("timeout_secs") or stall_timeout)
    wall = int(fresh.get("max_wall_secs") or wall_base)
    return stall, max(wall, stall)


#: How many times one attempt waits out a node that is being replaced before
#: calling it a failure. ~3 s apiece, so half a minute of moving slots.
_FAILOVER_PARKS_MAX = 10


def _tuning_int(tuning: dict, key: str) -> Optional[int]:
    """A positive int from a tuning dict, or None (absent / unparsable)."""
    try:
        value = int(tuning.get(key))
    except (TypeError, ValueError):
        return None
    return value if value > 0 else None


def _named_failure(
    exc: ProviderUnavailable, first_failure: Optional[str]
) -> Optional[ProviderUnavailable]:
    """Re-word a breaker verdict so it still names the node that died.

    Once the breaker is open its reason is "Circuit open; will probe
    downstream again in ~28s" — true, and useless to an operator, because
    the text that named the shard ("Error 111 connecting to 10.0.0.3:6379")
    belonged to the failure three attempts ago. Returns ``None`` when the
    reason already says everything.
    """
    first = (first_failure or "").strip()
    if not first or first in (exc.reason or ""):
        return None
    return ProviderUnavailable(
        exc.provider_name,
        f"{exc.reason}. First failure: {first}",
        exc.retry_after_seconds,
    )


class AggregationWorker:
    """Pure executor — no Dispatcher reference, no orchestration.

    Args:
        session_factory: Async context manager yielding AsyncSession
        registry: ProviderRegistry to look up graph providers
        event_publisher: Optional AggregationEventPublisher for status events
    """

    def __init__(
        self,
        session_factory: Any,
        registry: Any,
        event_publisher: Any = None,
        worker_id: Optional[str] = None,
    ) -> None:
        self._session_factory = session_factory
        self._registry = registry
        self._events = event_publisher
        self._worker_id = worker_id

    async def run(self, job_id: str) -> None:
        """Full materialization pipeline.

        All parameters are read from AggregationJobORM — truly stateless.

        Cursor-based batch loop:
        1. Read job record from DB (includes last_cursor, frozen edge types)
        2. Parse containment/lineage types from job record
        3. Count total lineage edges (if not already counted)
        4. Resume from last_cursor (null = beginning)
        5. For each batch:
           a. Fetch next batch WHERE cursor > last_cursor ORDER BY cursor
           b. Compute ancestor chains for source+target
           c. MERGE AGGREGATED edges (idempotent)
           d. UPDATE job: processed_edges, last_cursor, updated_at, progress
           e. COMMIT checkpoint to DB
        6. On completion: update status='completed', compute fingerprint
        7. On failure: update status='failed', preserve checkpoint for resume
        """
        async with self._session_factory() as session:
            # Row-locked (FOR UPDATE on Postgres, a no-op on SQLite) so the
            # start below and ``service.cancel`` are mutually exclusive:
            # whichever commits first, the other sees its status. The lock
            # is held only until the running-transition commit below.
            job = await session.get(AggregationJobORM, job_id, with_for_update=True)
            if not job:
                logger.error("Aggregation job %s not found", job_id)
                return

            if job.trigger_source == "purge":
                # A purge row must never run the aggregation pipeline —
                # it belongs to the insights purge stream. Checked BEFORE
                # any mutation: the old in-pipeline guard flipped the
                # purge row to running and then failed it, corrupting the
                # purge's own state whenever a mis-dispatch happened.
                logger.error(
                    "Aggregation job %s is a PURGE row mis-dispatched to "
                    "the aggregation worker (trigger_source=purge) — "
                    "ignoring without touching the row. Find and fix the "
                    "dispatcher that sent it here.", job_id,
                )
                return

            if job.status not in ("pending", "running"):
                # A cancel (or another executor's completion) landed after
                # this job was picked up. Never flip a terminal row back to
                # running — the one guard the in-process dispatcher, which
                # skips the consumer's status check, gets. ``running`` is
                # accepted: the stuck-job reconciler re-dispatches a job
                # whose executor died without resetting its row.
                logger.info(
                    "Aggregation job %s is %s — not starting it",
                    job_id, job.status,
                )
                return

            # Transition to running
            job.status = "running"
            job.started_at = job.started_at or _now()
            job.updated_at = _now()
            # Which worker executed this job — fleet attribution for the UI.
            if self._worker_id and hasattr(job, "worker_id"):
                job.worker_id = self._worker_id
            # Open the run's step ledger on the SAME commit that flips the
            # row to running. Everything between here and the pipeline's
            # first checkpoint — the indexes, the identity stamp, the
            # before-fingerprint — used to run with no phase at all: on a
            # large graph, minutes of a running job with nothing on the
            # page. It is a step of the run, so it is a step in the record.
            ledger = StepLedger()
            ledger.enter("preparing")
            _record_steps(job, ledger)
            await session.commit()

            # Register a cooperative cancel event before any heavy work so
            # ``service.cancel`` can request a clean exit between sub-batches
            # rather than ``task.cancel()``-ing mid-Cypher and orphaning the
            # FalkorDB transaction. The event is unregistered in the finally
            # block below.
            cancel_registry = get_cancel_registry()
            cancel_event = cancel_registry.register(job_id)
            provider = None
            admission_attached = False

            # Platform JobEmitter — the only path for live progress
            # updates. Seed its per-job sequence counter from the
            # durable high-water-mark in PG so resume-after-crash
            # never re-uses a sequence already published.
            emitter = get_emitter()
            emitter.seed_sequence(job_id, job.last_sequence or 0)
            scope = PlatformJobScope(
                workspace_id=job.workspace_id or "",
                data_source_id=job.data_source_id,
            )
            await emitter.publish(
                job_id=job_id,
                kind="aggregation",
                scope=scope,
                type="state",
                payload={"status": "running", "trigger_source": job.trigger_source},
                live_state={
                    "status": "running",
                    "started_at": job.started_at or "",
                    "processed_edges": job.processed_edges,
                    "total_edges": job.total_edges,
                    "created_edges": job.created_edges,
                    "progress": job.progress,
                    "last_cursor": job.last_cursor or "",
                    "trigger_source": job.trigger_source,
                },
            )

            logger.info(
                "Aggregation job %s started for data source %s (resume from: %s)",
                job_id, job.data_source_id, job.last_cursor or "beginning",
            )

            try:
                # Read frozen edge types from job record
                containment_types = json.loads(job.containment_edge_types or "[]")
                lineage_types = json.loads(job.lineage_edge_types or "[]")
                # Entity-type → level map frozen at trigger time (may be
                # absent on legacy rows). Used to inject levels into the
                # provider and to drive per-label index creation without
                # an ontology-module dependency in this executor.
                entity_type_levels = json.loads(
                    getattr(job, "entity_type_levels", None) or "{}"
                )
                # URN-equivalent node-identity property frozen at trigger time.
                # NULL on legacy rows → "urn" (no behaviour change). Injected
                # into the provider below so endpoint resolution reads
                # coalesce(n.urn, n[identity_property]) for onboarded graphs
                # that key nodes by e.g. "id" instead of the canonical urn.
                identity_property = getattr(job, "identity_property", None) or "urn"
                # Node display-name property, frozen likewise (default "name").
                # Stamped onto `displayName` so the whole read stack renders it.
                name_property = getattr(job, "name_property", None) or "name"

                if not lineage_types:
                    # Self-heal instead of failing a doomed row: re-freeze
                    # the edge-type lists from the pinned ontology at
                    # pickup. Whatever entry path produced a row without
                    # frozen types (legacy row, partial write, manual
                    # insert), the pinned ontology is still the source of
                    # truth the trigger would have used.
                    containment_types, lineage_types, entity_type_levels = (
                        await self._refreeze_edge_types(session, job)
                    )
                    # The self-heal also re-derived identity_property and
                    # name_property from the data source — pick up the refreshed
                    # values (read above from the un-frozen row, which would have
                    # been the defaults "urn"/"name").
                    identity_property = getattr(job, "identity_property", None) or "urn"
                    name_property = getattr(job, "name_property", None) or "name"

                # Worker-side gate re-validation. Closes the trigger →
                # pickup race: if the user edited the ontology between
                # ``trigger`` (which froze the edge types) and now, the
                # frozen lists may no longer match the user's intent.
                # Compare the fingerprint computed at trigger time to a
                # fresh one over the pinned ontology row — any drift
                # fails the job with an actionable reason rather than
                # silently producing aggregations against a stale shape.
                # Old jobs that pre-date the fingerprint column skip
                # the check (NULL == "no fingerprint, trust the freeze").
                if job.ontology_fingerprint and job.ontology_id:
                    from backend.app.db.models import OntologyORM
                    from backend.app.ontology import gate as _ontology_gate
                    pinned = await session.get(OntologyORM, job.ontology_id)
                    if pinned is None:
                        raise ValueError(
                            "ontology_resolution_changed: pinned ontology "
                            f"{job.ontology_id!r} no longer exists"
                        )
                    current_fp = _ontology_gate.compute_fingerprint_from_ontology_orm(
                        pinned
                    )
                    if current_fp != job.ontology_fingerprint:
                        raise ValueError(
                            "ontology_resolution_changed: assigned ontology "
                            f"{job.ontology_id!r} has been edited since the "
                            "job was triggered; retrigger to pick up the new "
                            "containment / lineage classifications"
                        )

                # Get provider for this data source.
                #
                # P2.5 — implicit preflight gate. The manager's
                # ``get_provider`` consults the warmup cache at the top
                # of its method (P1.2): when the background warmup loop
                # has recently observed this provider as unhealthy, it
                # raises ProviderUnavailable in <1ms with NO socket I/O.
                # The catch at line 477 maps that to status="failed",
                # so a worker slot is occupied for ~50ms instead of
                # 10s+ in the slow connect path. retry_eligible stays
                # true so the job re-dispatches when the warmup loop
                # observes recovery.
                provider = await self._registry.get_provider_for_workspace(
                    "", session, data_source_id=job.data_source_id
                )

                # Configure projection mode from the job record.  The provider
                # is cached and shared, so we set this per-job to route
                # AGGREGATED edges to the correct graph (source or dedicated).
                await provider.set_projection_mode(job.projection_mode or "in_source")

                # Configure the provider with the data source's specific structural mapping
                # so physical queries can correctly differentiate lineage vs containment.
                # The provider's ancestors cache is keyed by a fingerprint of these
                # types, so a change in classification automatically routes reads to
                # a fresh cache namespace — no manual invalidation needed.
                provider.set_containment_edge_types(containment_types)

                # Inject the frozen node-identity mapping so the provider's
                # directory build resolves endpoints as
                # coalesce(n.urn, n[identity_property]) and the conformance
                # stamp knows which properties to fill from. Defaults are a
                # no-op (the historical hardcoded behaviour). Unconditional —
                # the provider is cached and shared per (provider_id,
                # graph_name), so an unset call would leave the PREVIOUS job's
                # mapping in place.
                if hasattr(provider, "set_node_identity"):
                    provider.set_node_identity(identity_property, name_property)

                # Per-source vocabulary alignment (Task E): the frozen containment/lineage
                # types carry the ontology's DECLARED casing, but this graph may spell them
                # differently (has/to vs HAS/TO) and FalkorDB matches types case-sensitively.
                # Derive declared->observed aliases from live introspection and inject them so
                # materialization's containment/lineage patterns match a case-variant graph
                # (else no AGGREGATED edges get written). Best-effort; identity for governed
                # graphs and a no-op if the provider or introspection can't supply it.
                if hasattr(provider, "set_source_type_aliases"):
                    try:
                        from backend.app.ontology.source_alignment import derive_alignment
                        _meta = await provider.get_ontology_metadata()
                        _observed = list((_meta.edge_type_metadata or {}).keys())
                        _align = derive_alignment(
                            declared_relationship_types=list(containment_types) + list(lineage_types),
                            declared_entity_types=[],
                            observed_relationship_types=_observed,
                            observed_entity_types=[],
                        )
                        provider.set_source_type_aliases(_align.rel_alias_map())
                    except Exception as exc:
                        logger.warning(
                            "Aggregation job %s: source-alignment injection skipped "
                            "(continuing unaligned): %s", job.id, exc,
                        )

                # Inject the frozen entity-type level map so ancestor-chain
                # depth adapts to deep ontologies (max_depth derives from
                # the level count) and AGGREGATED edges carry correct
                # source/target level + levelDigest stamps. Best-effort:
                # legacy jobs without a frozen map degrade to max_depth=10
                # and the label-scan trace fallback (both correct).
                if entity_type_levels and hasattr(provider, "set_entity_type_levels"):
                    try:
                        provider.set_entity_type_levels(entity_type_levels)
                    except Exception as exc:
                        logger.warning(
                            "Aggregation job %s: set_entity_type_levels failed "
                            "(continuing with default depth): %s", job.id, exc,
                        )

                # Ensure per-label URN indexes for the ontology's entity
                # types BEFORE the scan/flush so every MATCH/MERGE on
                # (label {urn}) is an index seek. Driven by the frozen
                # level-map keys (ontology entity types) — schema-agnostic,
                # not the provider's hardcoded defaults. Best-effort.
                if entity_type_levels and hasattr(provider, "ensure_indices"):
                    try:
                        await provider.ensure_indices(list(entity_type_levels.keys()))
                    except Exception as exc:
                        logger.warning(
                            "Aggregation job %s: ensure_indices failed "
                            "(continuing; first query will surface a missing "
                            "index if any): %s", job.id, exc,
                        )

                # Onboarded-graph identity: copy the source's URN-equivalent
                # (e.g. `id`) onto `urn` for any node missing one, AFTER the
                # indexes exist, so the urn-keyed write/read/trace stack actually
                # attaches AGGREGATED edges to the real nodes. No-op for
                # conforming (urn) sources and dedicated projections; best-effort
                # (a failure degrades to the directory-only coalesce).
                if hasattr(provider, "stamp_identity_urns"):
                    try:
                        await provider.stamp_identity_urns()
                    except Exception as exc:
                        logger.warning(
                            "Aggregation job %s: identity-urn stamp failed "
                            "(continuing): %s", job.id, exc,
                        )

                # Distributed write-admission control: N workers × M pods
                # share one write budget per FalkorDB endpoint (per-graph
                # lease + per-endpoint slots) instead of each pod throttling
                # only itself. Best-effort: without it the provider's
                # per-process gates still apply.
                if hasattr(provider, "set_admission_controller"):
                    try:
                        from .admission import AggregationAdmission
                        from .redis_client import get_redis
                        provider.set_admission_controller(
                            AggregationAdmission(get_redis())
                        )
                        admission_attached = True
                    except Exception as exc:
                        logger.warning(
                            "Aggregation job %s: admission controller not "
                            "attached (continuing with per-process limits): %s",
                            job.id, exc,
                        )

                # Compute fingerprint before aggregation
                job.graph_fingerprint_before = await compute_graph_fingerprint(
                    provider, budget_s=_FINGERPRINT_BUDGET_S)
                await session.commit()

                # Run materialization with retries under a progress-aware
                # watchdog: the job is killed only when it stops making
                # forward progress for the stall window (checkpoints and
                # intra-batch heartbeats both count as progress), or when
                # it exceeds the wall-clock safety net. A steadily
                # progressing multi-hour job is never killed by a timer.
                # Stall window: the job's own value, else the fleet's
                # ``stallTimeoutSecs`` default frozen in its tuning, else
                # env. The wall clock likewise comes from tuning and is
                # never lower than the stall window — an operator who
                # allowed a job 48h of quiet meant it to run that long.
                job_tuning = self._job_tuning(job)
                stall_timeout = (
                    job.timeout_secs
                    or _tuning_int(job_tuning, "stall_timeout_secs")
                    or _STALL_TIMEOUT_SECS
                )
                wall_limit = max(
                    _tuning_int(job_tuning, "max_wall_secs") or _MAX_WALL_SECS,
                    stall_timeout,
                )
                progress_marker = {"at": time.monotonic()}

                # Per-query budgets an operator may raise on the running
                # job: the pipeline reads this dict per query; the watchdog
                # tick below refreshes it from the row.
                live: dict = {}
                limits = {"stall_timeout": stall_timeout, "wall_limit": wall_limit, "live": live}
                wall_base = _tuning_int(job_tuning, "max_wall_secs") or _MAX_WALL_SECS
                ticks = 0
                materialize_task = asyncio.create_task(
                    self._materialize_with_retries(
                        session=session,
                        job=job,
                        provider=provider,
                        containment_types=containment_types,
                        lineage_types=lineage_types,
                        cancel_event=cancel_event,
                        emitter=emitter,
                        scope=scope,
                        progress_marker=progress_marker,
                        limits=limits,
                        ledger=ledger,
                    )
                )
                wall_start = time.monotonic()
                timeout_reason = ""
                try:
                    while True:
                        done, _ = await asyncio.wait(
                            {materialize_task}, timeout=10.0,
                        )
                        if done:
                            result = materialize_task.result()
                            break
                        # Durable-cancel poll. The two cooperative checkpoints
                        # inside the pipeline read only ``cancel_event``, which
                        # is set by the Redis pub/sub CancelListener — and a
                        # broadcast that arrives while that listener is backing
                        # off through a Redis flap is simply lost, leaving this
                        # job running to completion while the DB already says
                        # ``cancelled``. The API also wrote a durable
                        # ``agg:cancel:{job_id}`` flag (read today only at job
                        # pickup); re-reading it on this existing 10s tick sets
                        # the event within one tick of a lost delivery, and
                        # both checkpoints then exit at the next boundary with
                        # a resumable cursor. That cooperative exit is strictly
                        # better than a hard task.cancel() mid-Cypher, which
                        # is what leaves a partial cube — so no hard fallback
                        # is added for the queue dispatchers. One GET per job
                        # per 10s; a Redis error must never kill a healthy
                        # job, so it is swallowed and retried next tick.
                        if not cancel_event.is_set() and await self._durable_cancel_set(job.id):
                            logger.info(
                                "Aggregation job %s: durable cancel flag seen "
                                "(pub/sub delivery missed) — stopping at the "
                                "next checkpoint", job.id,
                            )
                            cancel_event.set()
                        # Limits raised on the RUNNING job (PATCH …/limits):
                        # one indexed read per 30s, through a fresh session —
                        # never the job's own, which the materialize task is
                        # using. Lowering is honoured too.
                        ticks += 1
                        if ticks % 3 == 0:
                            fresh = await self._live_limits(job.id)
                            # None = the row could not be read this tick: keep
                            # every live value in force (a hiccup never clears
                            # a cap) and try again next tick.
                            if fresh is not None:
                                new_stall, new_wall = _merge_live_limits(
                                    stall_timeout, wall_base, fresh,
                                )
                                if (new_stall, new_wall) != (stall_timeout, wall_limit):
                                    logger.info(
                                        "Aggregation job %s: time limits changed while "
                                        "running — stall window %ss → %ss, wall clock "
                                        "%ss → %ss", job.id, stall_timeout, new_stall,
                                        wall_limit, new_wall,
                                    )
                                    stall_timeout, wall_limit = new_stall, new_wall
                                    limits["stall_timeout"], limits["wall_limit"] = new_stall, new_wall
                                for key in _LIVE_PIPELINE_KEYS:
                                    if key in fresh:
                                        if live.get(key) != fresh[key]:
                                            logger.info(
                                                "Aggregation job %s: %s set to %s while running "
                                                "— applies from the next query", job.id, key, fresh[key],
                                            )
                                            live[key] = fresh[key]
                                    elif key in live:
                                        logger.info(
                                            "Aggregation job %s: live %s cleared — back to the "
                                            "job's settings from the next query", job.id, key,
                                        )
                                        live.pop(key, None)
                        now = time.monotonic()
                        stalled_for = now - progress_marker["at"]
                        if stalled_for > stall_timeout:
                            timeout_reason = (
                                f"no forward progress for {int(stalled_for)}s "
                                f"(stall timeout {stall_timeout}s)"
                            )
                        elif now - wall_start > wall_limit:
                            timeout_reason = (
                                f"exceeded wall-clock safety net {wall_limit}s"
                            )
                        if timeout_reason:
                            materialize_task.cancel()
                            try:
                                await materialize_task
                            except asyncio.CancelledError:
                                pass
                            except Exception as inner_exc:
                                # Surface the task's REAL terminal error
                                # alongside the watchdog reason instead of
                                # misreporting it as a pure timeout.
                                timeout_reason += f" (task error: {inner_exc})"
                            raise asyncio.TimeoutError(timeout_reason)
                except asyncio.CancelledError:
                    # run() itself was cancelled (exec-lock lost, consumer
                    # drain). asyncio.wait does NOT propagate cancellation
                    # into the awaited task — without this, the pipeline
                    # keeps writing as an orphan whose lease-renew task
                    # holds the per-graph write lease indefinitely while
                    # the reconciler re-dispatches the job elsewhere.
                    materialize_task.cancel()
                    try:
                        await materialize_task
                    except (asyncio.CancelledError, Exception):
                        pass
                    raise

                # Success — but not finished. The after-fingerprint is
                # three full graph scans and the state row, the workspace
                # row, the audit row and the terminal events all follow.
                # That stretch used to show as "Applying, 100%", which is
                # why a run looked wedged at the end on a large graph.
                ledger.enter("finalizing")
                _record_steps(job, ledger)
                job.status = "completed"
                job.progress = 100
                job.completed_at = _now()
                # Clear transient park/retry text — without this, a job
                # that quiesce-parked once ("write lease held ...") shows
                # that message as a red error FOREVER after completing.
                job.error_message = None
                job.created_edges = result.get("aggregated_edges_affected", 0)
                # Durable per-phase timings + write/delete counters for the
                # job detail UI (best-effort; NULL on legacy providers).
                # Merged over what the checkpoints already recorded (the
                # effective-tuning snapshot, the live adapted record): the
                # pipeline's final values win key by key, the snapshot
                # survives.
                if hasattr(job, "run_stats") and isinstance(result.get("run_stats"), dict):
                    try:
                        job.run_stats = json.dumps(
                            _merge_run_doc(self._job_run_stats(job), result["run_stats"])
                        )
                    except (TypeError, ValueError):
                        pass
                    # The pipeline's document has no ``steps`` key, so a
                    # key-by-key merge would leave the one the checkpoints
                    # wrote — but it is now a step behind (``finalizing``
                    # just opened). Re-stamp it.
                    _record_steps(job, ledger)
                # An EMPTY fingerprint means the probe could not answer, not
                # that the graph has no shape. Storing it poisons the change
                # gate forever: every later signal compares against "" and
                # reads as changed, which bumps the read generation (no cached
                # read of this source survives) and queues another rebuild.
                # None leaves the previous figure standing — ``_update_ds_state``
                # skips None — so the gate keeps the last fingerprint it could
                # actually take.
                job.graph_fingerprint_after = await compute_graph_fingerprint(
                    provider, budget_s=_FINGERPRINT_BUDGET_S) or None

                # Update aggregation-owned data source state
                await self._update_ds_state(
                    session,
                    job.data_source_id,
                    aggregation_status="ready",
                    last_aggregated_at=job.completed_at,
                    aggregation_edge_count=job.created_edges,
                    graph_fingerprint=job.graph_fingerprint_after,
                    # What this run measured per new edge on its shard — the
                    # next run's budget starts from it. None (no calibration
                    # this run) leaves the previous figure standing.
                    observed_bytes_per_edge=(
                        (result.get("run_stats") or {}).get("bytes_per_edge_observed")
                        if isinstance(result.get("run_stats"), dict) else None
                    ),
                    # Distinct cells stored per cell the pre-compute estimate
                    # counted. None (this run measured only one of the two)
                    # leaves the previous figure standing, exactly as above.
                    observed_cell_ratio=(
                        (result.get("run_stats") or {}).get("cell_ratio_observed")
                        if isinstance(result.get("run_stats"), dict) else None
                    ),
                    # What this run learned under per-query pressure, for
                    # the next run to start from. Always written: a clean
                    # run stores "{}", which clears the previous lesson
                    # (``_update_ds_state`` skips None, so a string it is).
                    observed_tuning=json.dumps(
                        _learned_from(result.get("run_stats"), job_id=job.id)
                    ),
                )
                await self._sync_workspace_ds_row(
                    session, job,
                    aggregation_status="ready",
                    last_aggregated_at=job.completed_at,
                    aggregation_edge_count=job.created_edges,
                    graph_fingerprint=job.graph_fingerprint_after,
                )

                # Audit-log row written in this same transaction so the
                # durable status flip + the audit trail land or roll
                # back together. Sequence is the next one the emitter
                # would assign — we don't actually emit yet (the
                # platform terminal event below does), but the audit
                # row needs a stable monotonic seq.
                terminal_seq = emitter.current_sequence(job_id) + 1
                await record_terminal(
                    session,
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    sequence=terminal_seq,
                    status="completed",
                    payload={
                        "edge_count": job.created_edges,
                        "fingerprint": job.graph_fingerprint_after,
                        "completed_at": job.completed_at,
                    },
                )

                # Platform terminal event — closes the SSE stream
                # cleanly so frontend ``useJob`` unsubscribes and
                # the row's React-Query cache flips to the durable
                # API response.
                await emitter.terminal(
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    status="completed",
                    payload={
                        "edge_count": job.created_edges,
                        "fingerprint": job.graph_fingerprint_after,
                        "completed_at": job.completed_at,
                    },
                )

                # Publish event for viz-service to sync its own tables
                # and invalidate its aggregated-edge graph cache.
                if self._events:
                    await self._events.job_completed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        edge_count=job.created_edges,
                        fingerprint=job.graph_fingerprint_after,
                        completed_at=job.completed_at,
                        workspace_id=job.workspace_id,
                    )

                # Aggregated-edge materialization changed the graph's edge
                # counts — nudge the insights counts poll (cooldown-
                # throttled, never raises).
                if job.workspace_id:
                    from backend.insights_service.enqueue import mark_stats_changed
                    await mark_stats_changed(job.data_source_id, job.workspace_id)

                # created_edges is the desired-cube total (used for the
                # readiness edge count). It is NOT how many edges this run
                # wrote — a steady-state re-run finds the cube already present
                # and writes zero. Report both so a genuine write is never
                # confused with a no-op reconcile ("49747 created" while
                # writes=0 previously read as if 49747 edges were persisted).
                _run_writes = result.get("writes", 0)
                _run_deletes = result.get("deletes", 0)
                logger.info(
                    "Aggregation job %s completed: %d edges processed, "
                    "%d AGGREGATED edges in cube (%d written, %d deleted this run)",
                    job_id, job.processed_edges, job.created_edges,
                    _run_writes, _run_deletes,
                )

            except MaterializationStoreUnreachable as store_exc:
                # A node went away mid-run and did not come back inside the
                # run's outage budget. Everything computed so far is intact
                # and the cursor is committed, so this is a Resume, not a
                # re-run — and the message NAMES the node, which the
                # breaker's "Circuit open" text used to overwrite.
                job.status = "failed"
                job.error_message = str(store_exc)[:2000]
                logger.error(
                    "Aggregation job %s: graph store node unreachable: %s",
                    job_id, store_exc,
                )

                await self._update_ds_state(session, job.data_source_id, aggregation_status="failed")
                await self._sync_workspace_ds_row(session, job, aggregation_status="failed")

                terminal_seq = emitter.current_sequence(job_id) + 1
                for send in (
                    lambda payload: record_terminal(
                        session, job_id=job_id, kind="aggregation", scope=scope,
                        sequence=terminal_seq, status="failed", payload=payload,
                    ),
                    lambda payload: emitter.terminal(
                        job_id=job_id, kind="aggregation", scope=scope,
                        status="failed", payload=payload,
                    ),
                ):
                    await send({"error_message": job.error_message, "reason": "connection"})

                if self._events:
                    await self._events.job_failed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        error_message=job.error_message,
                    )

            except MaterializationScanTimedOut as scan_exc:
                # The pipeline's own verdict after every backoff retry at
                # the narrowest scan: the graph store is not answering. A
                # TimeoutError like the watchdog's, but its message names
                # the scan, the width, the budget and the cap — it must
                # not be reported as a watchdog kill.
                job.status = "failed"
                job.error_message = str(scan_exc)[:2000]
                logger.error(
                    "Aggregation job %s: graph store stopped answering: %s",
                    job_id, scan_exc,
                )

                await self._update_ds_state(session, job.data_source_id, aggregation_status="failed")
                await self._sync_workspace_ds_row(session, job, aggregation_status="failed")

                terminal_seq = emitter.current_sequence(job_id) + 1
                await record_terminal(
                    session,
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    sequence=terminal_seq,
                    status="failed",
                    payload={"error_message": job.error_message, "reason": "timeout"},
                )
                await emitter.terminal(
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    status="failed",
                    payload={"error_message": job.error_message, "reason": "timeout"},
                )

                if self._events:
                    await self._events.job_failed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        error_message=job.error_message,
                    )

            except asyncio.TimeoutError as timeout_exc:
                reason = str(timeout_exc) or "watchdog timeout"
                job.status = "failed"
                job.error_message = (
                    f"Job killed by watchdog: {reason}. "
                    f"Progress: {job.processed_edges}/{job.total_edges} edges. "
                    f"Resume from last_cursor is possible."
                )
                logger.error(
                    "Aggregation job %s killed by watchdog: %s", job_id, reason,
                )

                await self._update_ds_state(session, job.data_source_id, aggregation_status="failed")
                await self._sync_workspace_ds_row(session, job, aggregation_status="failed")

                terminal_seq = emitter.current_sequence(job_id) + 1
                await record_terminal(
                    session,
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    sequence=terminal_seq,
                    status="failed",
                    payload={"error_message": job.error_message, "reason": "timeout"},
                )
                await emitter.terminal(
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    status="failed",
                    payload={"error_message": job.error_message, "reason": "timeout"},
                )

                if self._events:
                    await self._events.job_failed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        error_message=job.error_message,
                    )

            except JobCancelled as cancel_exc:
                # Cooperative cancel observed at a safe boundary. The
                # cursor + processed_edges committed by the last
                # successful checkpoint reflect work that durably
                # landed; resume from there is sound. We mark the row
                # cancelled here rather than letting the API tier do
                # it pre-emptively, so the terminal state lines up
                # with the moment the worker actually stopped.
                job.status = "cancelled"
                job.completed_at = _now()
                job.error_message = (
                    f"Cancelled at {cancel_exc.observed_at}. "
                    f"Progress preserved: {job.processed_edges}/{job.total_edges} edges. "
                    "Resume from last_cursor is possible."
                )
                logger.info(
                    "Aggregation job %s cancelled cooperatively (cursor=%s, processed=%d)",
                    job_id, job.last_cursor, job.processed_edges,
                )
                metrics_increment(
                    "cooperative_cancels_observed_total",
                    kind="aggregation",
                )

                await self._update_ds_state(session, job.data_source_id, aggregation_status="cancelled")
                await self._sync_workspace_ds_row(session, job, aggregation_status="none")

                terminal_seq = emitter.current_sequence(job_id) + 1
                await record_terminal(
                    session,
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    sequence=terminal_seq,
                    status="cancelled",
                    payload={
                        "observed_at": cancel_exc.observed_at,
                        "last_cursor": job.last_cursor,
                        "processed_edges": job.processed_edges,
                    },
                )
                await emitter.terminal(
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    status="cancelled",
                    payload={
                        "observed_at": cancel_exc.observed_at,
                        "last_cursor": job.last_cursor,
                        "processed_edges": job.processed_edges,
                    },
                )

                if self._events:
                    await self._events.job_cancelled(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                    )

            except Exception as e:
                job.status = "failed"
                job.error_message = str(e)[:2000]
                logger.error("Aggregation job %s failed: %s", job_id, e, exc_info=True)

                await self._update_ds_state(session, job.data_source_id, aggregation_status="failed")
                await self._sync_workspace_ds_row(session, job, aggregation_status="failed")

                terminal_seq = emitter.current_sequence(job_id) + 1
                await record_terminal(
                    session,
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    sequence=terminal_seq,
                    status="failed",
                    payload={"error_message": job.error_message},
                )
                await emitter.terminal(
                    job_id=job_id,
                    kind="aggregation",
                    scope=scope,
                    status="failed",
                    payload={"error_message": job.error_message},
                )

                if self._events:
                    await self._events.job_failed(
                        job_id=job_id,
                        data_source_id=job.data_source_id,
                        error_message=job.error_message,
                    )

            finally:
                # Close the open step with the run's terminal state, on the
                # one commit every path — success, failure, cancel, store
                # outage — passes through. A failed run's ledger then NAMES
                # the step it died in, which is the first question anyone
                # asks of a failure.
                ledger.seal(job.status)
                _record_steps(job, ledger)
                job.updated_at = _now()
                await session.commit()
                # Always unregister the cancel event, including on
                # uncaught exceptions, so a future job re-using this
                # job_id (resume) starts with a fresh event.
                cancel_registry.unregister(job_id)
                # Detach the per-job admission controller from the shared
                # provider instance so a non-aggregation caller never runs
                # under a stale job's admission gates.
                if admission_attached and provider is not None:
                    try:
                        provider.set_admission_controller(None)
                    except Exception:
                        pass

    async def _capacity_hints(self, session: AsyncSession, data_source_id: str) -> dict:
        """What the worker knows about this graph that the pipeline cannot
        measure before it runs: the bytes per new edge a previous successful
        rebuild observed, and what that rebuild LEARNED under per-query
        pressure (``observed_tuning``: the narrowest scan width it needed,
        serial reads, the reconcile strategy, the write batch / delete
        chunk), each handed over as ``<key>_observed``. Best-effort — no row,
        no column, unparsable JSON: no hint."""
        from .models import AggregationDataSourceStateORM

        try:
            state = await session.get(AggregationDataSourceStateORM, data_source_id)
        except Exception as exc:
            logger.debug("capacity hints unavailable for %s: %s", data_source_id, exc)
            return {}
        hints: dict = {}
        observed = getattr(state, "observed_bytes_per_edge", None)
        if observed:
            hints["bytes_per_edge_observed"] = observed
        ratio = getattr(state, "observed_cell_ratio", None)
        if ratio:
            hints["cell_ratio_observed"] = ratio
        learned = self._job_tuning(types.SimpleNamespace(
            tuning_json=getattr(state, "observed_tuning", None),
        ))
        for key in _LEARNED_KEYS:
            value = learned.get(key) if isinstance(learned, dict) else None
            if value:
                hints[f"{key}_observed"] = value
        return hints

    async def _update_ds_state(
        self,
        session: AsyncSession,
        data_source_id: str,
        **fields: Any,
    ) -> None:
        """Update the aggregation-owned data source state table.

        Uses AggregationDataSourceStateORM (in the aggregation schema)
        instead of WorkspaceDataSourceORM (in the public schema).
        Creates the row if it doesn't exist (upsert).
        """
        from .models import AggregationDataSourceStateORM

        try:
            state = await session.get(AggregationDataSourceStateORM, data_source_id)
            if state is None:
                state = AggregationDataSourceStateORM(data_source_id=data_source_id)
                # workspace_id is required — try to read from the job
                state.workspace_id = fields.pop("workspace_id", "")
                session.add(state)
            for key, value in fields.items():
                if value is not None and hasattr(state, key):
                    setattr(state, key, value)
        except Exception as e:
            logger.warning("Failed to update data source state for %s: %s", data_source_id, e)

    async def _sync_workspace_ds_row(
        self,
        session: AsyncSession,
        job: Any,
        **fields: Any,
    ) -> None:
        """Best-effort DIRECT sync of the viz-service's
        ``workspace_data_sources`` row in the same transaction as the
        job's terminal state — covers single-DB topologies where no
        aggregation event listener runs (the observed gap: a graph held
        1,840 rollups while the row said status=none/count=0). In
        split-DB topologies the table is absent from the jobs DB, the
        get fails harmlessly and the event listener owns the sync."""
        try:
            from backend.app.db.models import WorkspaceDataSourceORM

            ds = await session.get(WorkspaceDataSourceORM, job.data_source_id)
            if ds is None or ds.deleted_at is not None:
                return
            for key, value in fields.items():
                if value is not None and hasattr(ds, key):
                    setattr(ds, key, value)
        except Exception as e:
            logger.debug(
                "workspace_data_sources direct sync skipped for %s: %s",
                job.data_source_id, e,
            )

    async def _break_zombie_lease(
        self, session: AsyncSession, provider: Any, my_job_id: str,
    ) -> bool:
        """True when the graph lease was held by a job whose row is
        already terminal and we cleared it (atomically, value-compared —
        a freshly acquired live lease is never touched)."""
        admission = getattr(provider, "_admission_controller", None)
        if admission is None:
            return False
        try:
            holder = await admission.get_lease_holder(provider)
            if not holder:
                return True  # already expired — retry immediately
            holder_job_id, holder_value = holder
            if not holder_job_id or holder_job_id in ("unattributed", my_job_id):
                return False
            row = await session.get(AggregationJobORM, holder_job_id)
            if row is None or row.status in ("completed", "failed", "cancelled"):
                broken = await admission.break_lease_if_holder(
                    provider, holder_value,
                )
                if broken:
                    logger.warning(
                        "Aggregation job %s: broke ZOMBIE graph lease held "
                        "by %s (job row status=%s) — retrying immediately.",
                        my_job_id, holder_job_id,
                        row.status if row else "missing",
                    )
                return broken
        except Exception as exc:
            logger.warning(
                "Aggregation job %s: zombie-lease check failed: %s",
                my_job_id, exc,
            )
        return False

    async def _refreeze_edge_types(
        self, session: AsyncSession, job: AggregationJobORM,
    ) -> tuple:
        """Re-derive (containment, lineage, levels) from the job's pinned
        ontology when the frozen lists are empty, persisting them back
        onto the row so a resume stays stable. Raises ValueError when no
        ontology is pinned or it yields no lineage types — with enough
        context to identify the entry path that produced the bad row."""
        if not job.ontology_id:
            raise ValueError(
                "No lineage edge types configured — cannot aggregate "
                f"(trigger_source={job.trigger_source!r}, no pinned "
                "ontology to re-freeze from; retrigger this data source)"
            )
        from backend.app.db.models import OntologyORM
        from backend.app.ontology.resolver import (
            parse_entity_definitions,
            parse_relationship_definitions,
            derive_flat_lists,
        )
        from backend.app.services.ontology_levels import derive_level_map
        from types import SimpleNamespace

        pinned = await session.get(OntologyORM, job.ontology_id)
        if pinned is None:
            raise ValueError(
                f"No lineage edge types configured and pinned ontology "
                f"{job.ontology_id!r} no longer exists — retrigger"
            )
        entity_defs = parse_entity_definitions(
            json.loads(pinned.entity_type_definitions or "{}")
        )
        rel_defs = parse_relationship_definitions(
            json.loads(pinned.relationship_type_definitions or "{}")
        )
        flat = derive_flat_lists(entity_defs, rel_defs)
        # Union the ontology's PERSISTED containment/lineage lists with the per-rel flags, matching
        # both resolver.resolve_ontology and AggregationService._resolve_ontology. derive_flat_lists
        # reads only the per-rel flags, so a list-only classification would otherwise re-freeze an
        # empty hierarchy and roll up nothing.
        containment_types = list(flat.containment_edge_types)
        lineage_types = list(flat.lineage_edge_types)
        _seen_containment = {t.upper() for t in containment_types}
        _seen_lineage = {t.upper() for t in lineage_types}
        for t in json.loads(pinned.containment_edge_types or "[]"):
            if t and t.upper() not in _seen_containment:
                containment_types.append(t)
                _seen_containment.add(t.upper())
        for t in json.loads(pinned.lineage_edge_types or "[]"):
            if t and t.upper() not in _seen_lineage:
                lineage_types.append(t)
                _seen_lineage.add(t.upper())
        if not lineage_types:
            raise ValueError(
                "No lineage edge types configured — the pinned ontology "
                f"{job.ontology_id!r} classifies no relationship as "
                "lineage (trigger_source="
                f"{job.trigger_source!r})"
            )
        levels = derive_level_map(
            SimpleNamespace(entity_type_definitions=entity_defs)
        )
        job.containment_edge_types = json.dumps(containment_types)
        job.lineage_edge_types = json.dumps(lineage_types)
        if hasattr(job, "entity_type_levels"):
            job.entity_type_levels = json.dumps(levels)
        # Re-derive the node-identity property from the SOURCE's scope chain too
        # (identity is a per-source property, not an ontology one). Without
        # this, a legacy/partial row on an id-keyed source would self-heal its
        # edge types yet keep identity_property NULL → "urn", so the urn
        # stamp/directory would still drop every id-keyed node — an asymmetric
        # half-heal.
        if hasattr(job, "identity_property"):
            try:
                from backend.app.services.node_identity import load_node_identity
                identity = await load_node_identity(session, job.data_source_id)
                job.identity_property = identity.identity_property
                # Display-name property is per-source too — re-derive it in
                # the same pass so the label stamp heals symmetrically.
                if hasattr(job, "name_property"):
                    job.name_property = identity.name_property
            except Exception as exc:
                logger.warning(
                    "Aggregation job %s: identity_property re-derive failed "
                    "during self-heal (keeping frozen value): %s", job.id, exc,
                )
        job.updated_at = _now()
        await session.commit()
        logger.warning(
            "Aggregation job %s had no frozen edge types "
            "(trigger_source=%r) — re-froze from pinned ontology %s "
            "(%d lineage, %d containment types)",
            job.id, job.trigger_source, job.ontology_id,
            len(lineage_types), len(containment_types),
        )
        return (
            list(flat.containment_edge_types),
            list(flat.lineage_edge_types),
            levels,
        )

    async def _live_limits(self, job_id: str) -> Optional[dict]:
        """The job row's current live limits — ``timeout_secs`` and the
        ``live_overrides`` document — read through a FRESH session (the
        job's own session belongs to the materialize task). Never raises:
        ``None`` means the row could not be read this tick (nothing changes,
        retried next tick); a dict is the truth, and a key absent from it
        has been cleared."""
        if self._session_factory is None:
            return None
        try:
            from sqlalchemy import select
            async with self._session_factory() as s:
                row = (await s.execute(
                    select(AggregationJobORM.timeout_secs, AggregationJobORM.live_overrides)
                    .where(AggregationJobORM.id == job_id)
                )).first()
        except Exception as exc:
            logger.debug("live limits unavailable for %s: %s", job_id, exc)
            return None
        if row is None:
            return None
        timeout_secs, raw = row[0], row[1]
        out: dict = {}
        if timeout_secs:
            out["timeout_secs"] = int(timeout_secs)
        doc = self._job_tuning(types.SimpleNamespace(tuning_json=raw))
        for key in ("max_wall_secs", "scan_timeout_s", "write_timeout_s"):
            value = doc.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0:
                out[key] = value
        # Pacing may be set to 0 (no pacing); the two caps are positive ints.
        pacing = doc.get("write_pacing_ratio")
        if isinstance(pacing, (int, float)) and not isinstance(pacing, bool) and pacing >= 0:
            out["write_pacing_ratio"] = float(pacing)
        for key in ("extract_concurrency", "scan_width", "write_batch_max"):
            value = _tuning_int(doc, key)
            if value is not None:
                out[key] = value
        target = doc.get("write_batch_target_s")
        if isinstance(target, (int, float)) and not isinstance(target, bool) and target > 0:
            out["write_batch_target_s"] = float(target)
        return out

    @staticmethod
    def _job_run_stats(job: Any) -> dict:
        """The row's ``run_stats`` document (``{}`` when NULL or unparsable)."""
        try:
            doc = json.loads(getattr(job, "run_stats", None) or "{}")
        except (TypeError, ValueError):
            return {}
        return doc if isinstance(doc, dict) else {}

    @staticmethod
    def _job_tuning(job: Any) -> dict:
        """The job's frozen tuning dict (``{}`` when NULL or unparsable)."""
        try:
            return json.loads(getattr(job, "tuning_json", None) or "{}") or {}
        except (TypeError, ValueError):
            return {}

    @staticmethod
    async def _durable_cancel_set(job_id: str) -> bool:
        """True when the API's durable cancel flag for *job_id* is set.

        The same read ``__main__._is_cancelled`` does at job pickup; polled
        here for the running case. Never raises — a failed read is "not
        cancelled as far as we can tell", retried on the next tick."""
        try:
            from .redis_client import cancel_flag_key, get_redis
            return bool(await get_redis().get(cancel_flag_key(job_id)))
        except Exception:
            return False

    async def _materialize_with_retries(
        self,
        session: AsyncSession,
        job: AggregationJobORM,
        provider: Any,
        containment_types: list[str],
        lineage_types: list[str],
        cancel_event: asyncio.Event,
        emitter: Any,
        scope: PlatformJobScope,
        progress_marker: Optional[dict] = None,
        limits: Optional[dict] = None,
        ledger: Optional[StepLedger] = None,
    ) -> dict:
        """Retry wrapper around _materialize_with_checkpoints.

        On transient failures (provider timeout, connection error,
        AggregationBatchAbort), retries up to ``job.max_retries``
        CONSECUTIVE times with exponential backoff + jitter.  Each retry
        resumes from ``job.last_cursor`` (set by the checkpoint callback),
        so no work is repeated beyond the ≤2s coalescing window. The
        budget counts only failures *without* forward progress: whenever
        ``processed_edges`` advances, the counter resets, so a large job
        making steady progress survives arbitrarily many transient
        FalkorDB connection resets — only a truly stuck job exhausts it.

        The retry count and error message are persisted to the job
        record on each attempt so the frontend can display progress.
        """
        max_attempts = (job.max_retries or 3) + 1
        last_error: Exception | None = None
        provider_unavailable_count = 0
        first_provider_error: Optional[str] = None

        # Phase 2 — quiesce events (ProviderBusy raised by the provider
        # when write p95 climbs above the trigger) are flow control,
        # not failures. They do NOT count against ``max_retries``; the
        # worker simply parks the job for ``retry_after_seconds`` and
        # re-attempts. A safety cap on consecutive quiesce events
        # prevents an indefinitely-overloaded provider from hanging
        # the job forever — after the cap the job moves to ``failed``.
        max_quiesce_events = int(os.getenv("AGGREGATION_MAX_QUIESCE_EVENTS", "20"))
        quiesce_event_count = 0
        failover_parks = 0
        zombie_breaks = 0

        # Progress-aware retry budget: a job that keeps moving forward past
        # transient FalkorDB connection resets must survive arbitrarily many
        # of them. ``attempt`` counts CONSECUTIVE failures since the last
        # forward progress; it resets to 0 whenever ``processed_edges``
        # advances (the streaming rebuild resumes from ``last_cursor`` on
        # every retry). Only ``max_attempts`` failures WITHOUT any progress
        # exhaust the budget — a steadily-progressing large job never fails
        # on transient resets alone.
        attempt = 0
        last_progress = job.processed_edges or 0

        def _mark_alive() -> None:
            # Deliberate waiting (quiesce park, retry backoff) is not a
            # stall — keep the watchdog's progress marker fresh so it only
            # fires on genuine hangs.
            if progress_marker is not None:
                progress_marker["at"] = time.monotonic()

        async def _park(reason: str, delay: float) -> None:
            """Wait, visibly. A retry backoff, a quiesce park and a failover
            park are real time the run spends NOT running, and they used to
            read exactly like a hang: the same step, the same frozen
            counters, nothing said. Mark the open step parked and say what
            for; the next checkpoint clears it. The pipeline is not running
            in any of these handlers, so the commit is safe."""
            if ledger is not None and ledger.waiting(reason):
                _record_steps(job, ledger)
                try:
                    await session.commit()
                except Exception as park_exc:
                    logger.debug(
                        "Aggregation job %s: park not recorded: %s", job.id, park_exc,
                    )
                    try:
                        await session.rollback()
                    except Exception:
                        pass
            await asyncio.sleep(delay)
            _mark_alive()

        while True:
            try:
                return await self._materialize_with_checkpoints(
                    session=session,
                    job=job,
                    provider=provider,
                    containment_types=containment_types,
                    lineage_types=lineage_types,
                    cancel_event=cancel_event,
                    ledger=ledger,
                    emitter=emitter,
                    scope=scope,
                    progress_marker=progress_marker,
                    limits=limits,
                )
            except JobCancelled:
                # Cooperative cancel — control-flow signal, not a transient
                # failure. Skip the retry mill and bubble straight up to the
                # outer run() handler, which marks the job 'cancelled' and
                # emits the terminal event with last_cursor preserved.
                raise
            except (
                MaterializationBudgetExceeded,
                MaterializationPreconditionFailed,
                MaterializationQueryMemoryExceeded,
            ) as e:
                # All three are deterministic — every retry recomputes the
                # same outcome and burns another full EXTRACT+COMPUTE pass.
                # (The query-memory case additionally used to arrive here as
                # a breaker-counted ProviderUnavailable, so its three retries
                # were exactly enough to open the breaker on every reader of
                # this provider.) Fail terminally with the guidance message
                # intact, and stamp the terminal-backoff key so the read
                # path's widened self-heal trigger doesn't re-enqueue the
                # identical doomed job every damping window. TTL 6h; a
                # manual trigger clears it (the user is explicitly asking
                # for a retry, e.g. after raising the budget in the tuning
                # dialog, or switching the source to Auto rollup storage).
                try:
                    redis = getattr(provider, "_redis", None)
                    if redis is not None and getattr(job, "data_source_id", None):
                        await redis.set(
                            f"materialize:terminal:{job.data_source_id}",
                            str(e)[:500], ex=6 * 3600,
                        )
                except Exception as mark_exc:
                    logger.debug("terminal-backoff stamp failed: %s", mark_exc)
                raise
            except ProviderFailingOver as e:
                # A node is being replaced. Like a quiesce park and unlike a
                # failure: the store is not broken, the cluster is moving the
                # slots, and in a few seconds the promoted replica answers.
                # So no attempt is consumed — a rebuild must not burn its
                # retry budget on a routine pod rotation. Bounded, because
                # "failing over" that never ends IS a failure.
                # Progress since the last park means the store came back and
                # the run used it — a NEW rotation, not the same one dragging
                # on. A rebuild running for hours rides out several routine
                # rotations, and must not fail on the eleventh having
                # successfully waited out the first ten.
                if (job.processed_edges or 0) > last_progress:
                    failover_parks = 0
                    last_progress = job.processed_edges or 0
                failover_parks += 1
                if failover_parks > _FAILOVER_PARKS_MAX:
                    job.error_message = (
                        f"The graph store node {e.endpoint or 'holding this graph'} "
                        f"was still not answering after {_FAILOVER_PARKS_MAX} waits. "
                        f"The run keeps its checkpoint — Resume once the node is back."
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    raise
                delay = (e.retry_after_seconds or 3) + random.uniform(0, 2)
                logger.info(
                    "Aggregation job %s: node %s is failing over — waiting %.0fs "
                    "(wait %d/%d, attempt %d not consumed).",
                    job.id, e.endpoint or "?", delay, failover_parks,
                    _FAILOVER_PARKS_MAX, attempt + 1,
                )
                await _park(
                    f"the graph store node {e.endpoint or 'holding this graph'} "
                    f"is failing over ({failover_parks}/{_FAILOVER_PARKS_MAX})",
                    delay,
                )
                continue
            except ProviderBusy as e:
                # ZOMBIE-LEASE takeover: if the park is a graph-lease
                # conflict and the named holder's job row is already
                # TERMINAL (crashed before releasing, or an orphan from a
                # pre-cancellation-fix build renewing forever), break the
                # lease atomically and retry immediately instead of
                # parking 30s at a time on a lease nobody living holds.
                if (
                    "write lease held" in (e.reason or "")
                    and zombie_breaks < 3
                    and await self._break_zombie_lease(session, provider, job.id)
                ):
                    zombie_breaks += 1
                    _mark_alive()
                    continue
                # Phase 2 — park-and-resume on quiesce. NOT a retry:
                # don't increment ``retry_count``, don't consume the
                # ``max_attempts`` budget. Effectively re-runs the same
                # ``attempt`` after the cooldown by decrementing the
                # loop counter via a continue-with-rewound iterator.
                quiesce_event_count += 1
                if quiesce_event_count > max_quiesce_events:
                    logger.error(
                        "Aggregation job %s: hit %d consecutive quiesce "
                        "events; provider appears persistently overloaded. "
                        "Failing the job rather than parking indefinitely.",
                        job.id, max_quiesce_events,
                    )
                    job.error_message = (
                        f"Provider {e.provider_name} stayed quiesced for "
                        f"{max_quiesce_events} cooldown windows — abandoned. "
                        f"Underlying p95 never recovered below trigger."
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    raise
                delay = (e.retry_after_seconds or 30) + random.uniform(0, 2)
                job.error_message = (
                    f"Quiesce {quiesce_event_count}/{max_quiesce_events}: {e}"
                )[:2000]
                job.updated_at = _now()
                await session.commit()
                logger.info(
                    "Aggregation job %s: quiesce park for %.0fs "
                    "(event %d/%d, attempt %d not consumed) — %s",
                    job.id, delay, quiesce_event_count, max_quiesce_events,
                    attempt + 1, e,
                )
                await _park(
                    f"the provider is quiesced "
                    f"({quiesce_event_count}/{max_quiesce_events})",
                    delay,
                )
                # Re-enter the OUTER loop without consuming the retry
                # budget (``attempt`` is only incremented by the failure
                # handlers below). The previous nested re-call loop only
                # caught ProviderBusy, so any other exception raised
                # inside it propagated OUT of this handler and skipped
                # every retry-budget handler — with graph-lease parks now
                # routine, the first transient error after a park
                # terminally failed the job with zero retries.
                continue
            except ProviderUnavailable as e:
                last_error = e
                if (job.processed_edges or 0) > last_progress:
                    # Resumed past the failure point — this is a fresh
                    # failure, not a consecutive one. Reset the budget so
                    # steady forward progress never exhausts retries.
                    attempt = 0
                    provider_unavailable_count = 0
                    # …and the evidence with it: a node named hours ago, from
                    # a fault the run has long since worked past, would point
                    # the operator at a node that has been healthy since.
                    failover_parks = 0
                    first_provider_error = None
                    last_progress = job.processed_edges or 0
                provider_unavailable_count += 1
                job.retry_count = attempt + 1
                reason_text = (e.reason or "").strip()
                if (
                    first_provider_error is None
                    and "circuit open" not in reason_text.lower()
                ):
                    # Keep the reason that started this: by the time the
                    # breaker trips, its own text no longer names the node.
                    first_provider_error = reason_text

                # Second occurrence whose reason is "Circuit open" — fail fast.
                # Retrying further is pointless: the breaker has already
                # decided the downstream is sick.
                if (
                    provider_unavailable_count >= 2
                    and "circuit open" in (e.reason or "").lower()
                ):
                    named = _named_failure(e, first_provider_error)
                    job.error_message = (
                        f"Provider {e.provider_name} unavailable after "
                        f"{attempt + 1} attempts; circuit breaker open"
                        + (f". First failure: {first_provider_error}"
                           if first_provider_error else "")
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: aborting — provider %s circuit "
                        "open after %d attempts (first failure: %s)",
                        job.id, e.provider_name, attempt + 1,
                        first_provider_error or "n/a",
                    )
                    if named is not None:
                        raise named from e
                    raise

                if attempt < max_attempts - 1:
                    exp_backoff = min(5.0 * (2 ** attempt), 120.0) + random.uniform(0, 2)
                    # Breaker is open for at least retry_after_seconds; sleep
                    # at least that long (plus jitter) so the next attempt
                    # arrives after the probe window has elapsed rather than
                    # fast-failing against an OPEN breaker.
                    breaker_delay = (e.retry_after_seconds or 0) + random.uniform(0, 2)
                    delay = max(exp_backoff, breaker_delay)
                    job.error_message = (
                        f"Retry {attempt + 1}/{job.max_retries}: {e}"
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: retry %d/%d after %.0fs (provider unavailable) — %s",
                        job.id, attempt + 1, job.max_retries, delay, e,
                    )
                    await _park(
                        f"retry {attempt + 1}/{job.max_retries} — "
                        f"provider {e.provider_name} unavailable",
                        delay,
                    )
                    attempt += 1
                else:
                    # Final attempt exhausted — let the caller handle it,
                    # still carrying the reason that started the run of
                    # failures rather than only the breaker's verdict.
                    named = _named_failure(e, first_provider_error)
                    if named is not None:
                        raise named from e
                    raise
            except Exception as e:
                last_error = e
                if (job.processed_edges or 0) > last_progress:
                    # Resumed past the failure point — fresh failure; reset
                    # the budget so steady forward progress survives transient
                    # resets indefinitely.
                    attempt = 0
                    provider_unavailable_count = 0
                    failover_parks = 0
                    first_provider_error = None
                    last_progress = job.processed_edges or 0
                job.retry_count = attempt + 1

                if attempt < max_attempts - 1:
                    delay = min(5.0 * (2 ** attempt), 120.0) + random.uniform(0, 2)
                    job.error_message = (
                        f"Retry {attempt + 1}/{job.max_retries}: {e}"
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: retry %d/%d after %.0fs — %s",
                        job.id, attempt + 1, job.max_retries, delay, e,
                    )
                    await _park(f"retry {attempt + 1}/{job.max_retries}", delay)
                    attempt += 1
                else:
                    # Final attempt exhausted — let the caller handle it
                    raise

        # Unreachable, but satisfies the type checker
        raise last_error  # type: ignore[misc]

    async def _materialize_with_checkpoints(
        self,
        session: AsyncSession,
        job: AggregationJobORM,
        provider: Any,
        containment_types: list[str],
        lineage_types: list[str],
        cancel_event: asyncio.Event,
        emitter: Any,
        scope: PlatformJobScope,
        progress_marker: Optional[dict] = None,
        limits: Optional[dict] = None,
        ledger: Optional[StepLedger] = None,
    ) -> dict:
        """Run batch materialization with coalesced DB checkpointing.

        Delegates the actual graph work to the provider's
        materialize_aggregated_edges_batch() method, passing a
        progress_callback that updates ORM state every batch and commits
        on a coalesced cadence (see module docstring). The outer run()'s
        finally block performs the definitive final commit.
        """
        last_commit_monotonic = time.monotonic()
        batches_since_commit = 0
        # Force the first checkpoint to commit no matter how fast the
        # first batch was. Without this, a fast first batch (under the
        # _CHECKPOINT_MAX_INTERVAL_SECS=2.0 threshold and below the
        # 5-batch count) would not commit, leaving the UI showing
        # ``processed_edges = 0`` for up to 5 batches × batch_duration.
        # The first commit is what flips the UI off "0" — make it
        # happen immediately.
        is_first_checkpoint = True

        # The per-run record, seeded from the row (a resume keeps what the
        # previous attempt recorded) and updated from what the pipeline
        # hands over at each checkpoint. Dumped onto the row only inside
        # the coalesced commit below — never an extra write.
        run_doc: dict = _merge_run_doc(self._job_run_stats(job), None)
        run_doc_dirty = False
        job_tuning = self._job_tuning(job)
        stall_timeout = (limits or {}).get("stall_timeout") or (
            job.timeout_secs or _tuning_int(job_tuning, "stall_timeout_secs") or _STALL_TIMEOUT_SECS
        )
        wall_limit = (limits or {}).get("wall_limit") or max(
            _tuning_int(job_tuning, "max_wall_secs") or _MAX_WALL_SECS, stall_timeout,
        )

        async def checkpoint(
            processed: int, total: int, cursor: Optional[str],
            aggregated: int = 0, phase: Optional[str] = None,
            *, progress_pct: Optional[int] = None,
            stats: Optional[dict] = None,
        ) -> None:
            nonlocal last_commit_monotonic, batches_since_commit, is_first_checkpoint
            nonlocal run_doc_dirty
            # Cooperative cancel point at the outer-batch boundary. The
            # checkpoint that just fired captured ``cursor`` for the
            # batch we've now committed; raising here means the next
            # outer batch never starts, the FalkorDB MERGE just
            # completed cleanly, and resume from ``cursor`` is sound.
            if cancel_event.is_set():
                raise JobCancelled(job.id, _now())
            # Any checkpoint is forward progress — feed the watchdog.
            if progress_marker is not None:
                progress_marker["at"] = time.monotonic()
            job.processed_edges = processed
            job.total_edges = total
            job.last_cursor = cursor
            if aggregated > 0:
                job.created_edges = aggregated
            # Surface the active phase to the UI. The pipeline passes a
            # short ID (extracting/computing/reconciling/applying); None
            # keeps the generic UI label working.
            if phase is not None:
                job.current_phase = phase
            # Move the step ledger with it. ``enter`` is idempotent for the
            # step already open, so this costs a dict lookup per checkpoint
            # and only marks the record dirty when the run actually moved.
            # ``step`` is the phase's OWN unit of work — extract counts
            # lineage edges, reconcile counts scan ranges, apply counts
            # aggregated edges — the numbers each phase already had and
            # used to fold into the percentage and throw away.
            step_changed = False
            if ledger is not None:
                step_changed = ledger.enter(phase) if phase is not None else False
                moved = step_changed
                step_units = (stats or {}).get("step")
                if isinstance(step_units, dict):
                    # Read the three keys by name rather than splatting the
                    # dict: a rolling deploy can pair this worker with a
                    # pipeline that sends a fourth, and a TypeError here
                    # would skip the checkpoint's PG commit, not just the
                    # ledger.
                    moved = ledger.note(
                        done=step_units.get("done"),
                        total=step_units.get("total"),
                        unit=step_units.get("unit"),
                    ) or moved
                if moved:
                    run_doc["steps"] = ledger.snapshot()
                    run_doc_dirty = True
            # The pipeline supplies a phase-weighted 0-100 percentage so
            # the bar is monotonic across phases; without it, fall back to
            # the processed/total ratio (clamped — ``total`` can lag when
            # driven off a stale estimate). Clamped monotonic per job row:
            # a transient-failure retry restarts the (cheap) extract phase
            # from zero, and without the floor the UI bar would snap from
            # 45% back to 0% on every retry.
            if progress_pct is not None:
                computed_pct = max(0, min(100, int(progress_pct)))
            else:
                computed_pct = min(100, int((processed / total) * 100)) if total > 0 else 0
            job.progress = max(job.progress or 0, computed_pct)
            job.updated_at = _now()
            job.last_checkpoint_at = _now()
            # What the run ran with (once is enough, but it is ~40 scalars
            # and arrives every time) and what the ladder has changed so
            # far. The stall window and wall clock are the worker's, not
            # the pipeline's, so they are added here with their sources.
            if isinstance(stats, dict):
                # Which graph store node this run writes. Durable on the row
                # so Job History can group the running jobs by node without
                # asking the store, and re-read every checkpoint so it
                # follows a failover.
                node = stats.get("node")
                if isinstance(node, str) and node and run_doc.get("node") != node:
                    run_doc["node"] = node
                    run_doc_dirty = True
                effective = stats.get("effective_tuning")
                if isinstance(effective, dict) and run_doc.get("effective_tuning") != effective:
                    doc = dict(effective)
                    src = dict(doc.get("sources") or {})
                    doc["stall_timeout_secs"] = stall_timeout
                    src["stall_timeout_secs"] = (
                        "job" if (job.timeout_secs or _tuning_int(job_tuning, "stall_timeout_secs")) else "env"
                    )
                    doc["max_wall_secs"] = wall_limit
                    src["max_wall_secs"] = "job" if _tuning_int(job_tuning, "max_wall_secs") else "env"
                    doc["max_retries"] = job.max_retries
                    src["max_retries"] = "job"
                    doc["sources"] = src
                    run_doc["effective_tuning"] = doc
                    run_doc_dirty = True
                adapted = stats.get("adapted")
                if isinstance(adapted, dict) and run_doc.get("adapted") != adapted:
                    run_doc["adapted"] = adapted
                    run_doc_dirty = True
            batches_since_commit += 1
            elapsed = time.monotonic() - last_commit_monotonic
            should_commit = (
                is_first_checkpoint
                # A step boundary is what the operator is watching for, and
                # there are five of them in a run. Riding the cadence means
                # the row can say EXTRACT while the run is a minute into
                # RECONCILE — one slow scan range is longer than the
                # two-second window. Land it now; it costs five commits.
                or step_changed
                or elapsed >= _CHECKPOINT_MAX_INTERVAL_SECS
                or batches_since_commit >= _CHECKPOINT_MAX_BATCHES
            )
            if not should_commit:
                return

            # Wrap commit in a recover-from-failure block. If a single
            # commit fails (transient DB blip, conflicting transaction,
            # etc.) without rolling back, the SQLAlchemy session enters
            # an invalid state and EVERY subsequent operation raises —
            # silently swallowed by the FalkorDB provider's
            # ``progress_callback`` try/except, leaving the UI stuck on
            # ``processed_edges = 0`` for the full duration of the
            # aggregation while FalkorDB happily keeps materialising
            # edges. Rollback restores the session so the next batch
            # can re-attempt the checkpoint with the latest in-memory
            # mutations on ``job`` (preserved across rollback because
            # the JOBS sessionmaker uses ``expire_on_commit=False``).
            # Advance the per-job sequence counter at outer-batch
            # boundaries. ``job.last_sequence`` is the durable
            # high-water-mark Phase-1's JobEmitter will use as the
            # ``(job_id, sequence)`` idempotency key on every event;
            # bumping it here means a crash + resume hands the new
            # worker a counter that won't collide with sequences
            # already published from this same boundary.
            job.last_sequence = (job.last_sequence or 0) + 1
            if run_doc_dirty and hasattr(job, "run_stats"):
                try:
                    job.run_stats = json.dumps(run_doc)
                    run_doc_dirty = False
                except (TypeError, ValueError):
                    pass
            try:
                await session.commit()
                last_commit_monotonic = time.monotonic()
                batches_since_commit = 0
                is_first_checkpoint = False
                logger.info(
                    "Aggregation job %s checkpoint: %d/%d edges (%d%%, %d written this run; "
                    "diff apply skips unchanged edges) [committed seq=%d]",
                    job.id, processed, total, job.progress, job.created_edges, job.last_sequence,
                )
            except Exception as commit_exc:
                logger.error(
                    "Aggregation job %s checkpoint commit failed (rolling back to "
                    "recover session for next batch): %s",
                    job.id, commit_exc, exc_info=True,
                )
                try:
                    await session.rollback()
                except Exception as rb_exc:
                    logger.error(
                        "Aggregation job %s session rollback after checkpoint commit failure also failed: %s",
                        job.id, rb_exc, exc_info=True,
                    )
                # Reset the cadence counters so the next batch tries
                # to commit again immediately. ``is_first_checkpoint``
                # stays True until a successful commit lands.
                last_commit_monotonic = time.monotonic()
                batches_since_commit = 0

            # Publish the outer-batch progress event AFTER the PG
            # commit lands. SSE clients merge this with their cached
            # API response; the live HSET captures the same fields so
            # late-arriving subscribers see the correct snapshot
            # immediately.
            await emitter.publish(
                job_id=job.id,
                kind="aggregation",
                scope=scope,
                type="progress",
                payload={
                    "boundary": "outer_batch",
                    "processed_edges": processed,
                    "total_edges": total,
                    "created_edges": job.created_edges,
                    "progress": job.progress,
                    "last_cursor": cursor or "",
                    "current_phase": job.current_phase or "",
                    "writes": (stats or {}).get("writes"),
                    "deletes": (stats or {}).get("deletes"),
                    **_adapted_scalars((stats or {}).get("adapted")),
                    **_pace_scalars((stats or {}).get("pace")),
                },
                live_state={
                    "status": "running",
                    "processed_edges": processed,
                    "total_edges": total,
                    "created_edges": job.created_edges,
                    "progress": job.progress,
                    "last_cursor": cursor or "",
                    "last_checkpoint_at": job.last_checkpoint_at or "",
                    "current_phase": job.current_phase or "",
                    "writes": (stats or {}).get("writes", 0) or 0,
                    "deletes": (stats or {}).get("deletes", 0) or 0,
                    **_adapted_scalars((stats or {}).get("adapted")),
                    **_pace_scalars((stats or {}).get("pace")),
                },
            )

        async def intra_batch_heartbeat(
            running_aggregated: int, *, pace: Optional[dict] = None,
        ) -> None:
            """Per Cypher MERGE sub-batch heartbeat. **Redis-only** —
            no PG writes mid-batch. The previous PG-writing version
            put ~30× sustained write pressure on the JOBS pool during
            a long aggregation; the platform's liveness/durability
            split makes those writes purely transient and they belong
            in Redis HSET, not PostgreSQL.

            Updates ``created_edges`` (cumulative, monotonically
            rising) and ``last_heartbeat_at`` so the UI's "Checkpoint
            Xm ago" badge stays current. Deliberately does NOT touch
            ``processed_edges``, ``total_edges``, or ``last_cursor``:
            those advance only at the boundary between outer batches
            and live in PG.
            """
            if progress_marker is not None:
                progress_marker["at"] = time.monotonic()
            # The pressure ladder heartbeats from inside EXTRACT too, when
            # nothing has been written yet; publishing ``created_edges: 0``
            # there would flicker a resumed job's count back to zero.
            counted = {"created_edges": running_aggregated} if running_aggregated > 0 else {}
            # How the run is writing right now — batch size, the pause, the
            # duty cycle, whether it is holding for the node and why — so
            # the job's progress says what the operator would otherwise
            # only learn from the logs.
            pacing = _pace_scalars(pace)
            await emitter.publish(
                job_id=job.id,
                kind="aggregation",
                scope=scope,
                type="progress",
                payload={"boundary": "intra_batch", **counted, **pacing},
                live_state={**counted, "last_heartbeat_at": _now(), **pacing},
            )

        # Cooperative cancel hook handed to the provider. The pipeline
        # checks this between scan ranges and write
        # sub-batches inside a single outer batch; True there raises
        # JobCancelled out of the provider, which the worker's outer
        # try/except catches and converts to a terminal ``cancelled``.
        # Cheap synchronous predicate — no asyncio import in the
        # provider, no coupling to this module's specific event type.
        def should_cancel() -> bool:
            return cancel_event.is_set()

        # What a previous run of this graph measured on its shard — a hint,
        # never tuning: an operator's override of the same figure arrives in
        # ``job_tuning`` and wins over it.
        capacity_hints = await self._capacity_hints(session, job.data_source_id)
        result = await provider.materialize_aggregated_edges_batch(
            containment_edge_types=containment_types,
            lineage_edge_types=lineage_types,
            batch_size=job.batch_size,
            tuning=job_tuning,
            capacity_hints=capacity_hints,
            # Per-query budgets an operator may raise on the running job —
            # the watchdog refreshes this dict; the pipeline reads it per query.
            live_limits=(limits or {}).get("live"),
            job_id=job.id,
            last_cursor=job.last_cursor,
            progress_callback=checkpoint,
            intra_batch_callback=intra_batch_heartbeat,
            should_cancel=should_cancel,
            # Resume baselines so a resumed job's progress continues from its
            # last checkpoint instead of resetting the bar to 0% (the streaming
            # rebuild applies these only when last_cursor parses).
            resume_processed=job.processed_edges or 0,
            resume_created=job.created_edges or 0,
        )

        return result
