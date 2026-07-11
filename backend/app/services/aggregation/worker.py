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
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.common.adapters import ProviderUnavailable, ProviderBusy
from backend.app.providers.falkordb_materialize import (
    MaterializationBudgetExceeded,
    MaterializationPreconditionFailed,
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
_STALL_TIMEOUT_SECS: int = int(os.getenv("AGGREGATION_STALL_TIMEOUT_SECS", "900"))
_MAX_WALL_SECS: int = int(os.getenv("AGGREGATION_JOB_MAX_WALL_SECS", "86400"))


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


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
            job = await session.get(AggregationJobORM, job_id)
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

            # Transition to running
            job.status = "running"
            job.started_at = job.started_at or _now()
            job.updated_at = _now()
            # Which worker executed this job — fleet attribution for the UI.
            if self._worker_id and hasattr(job, "worker_id"):
                job.worker_id = self._worker_id
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
                job.graph_fingerprint_before = await compute_graph_fingerprint(provider)
                await session.commit()

                # Run materialization with retries under a progress-aware
                # watchdog: the job is killed only when it stops making
                # forward progress for the stall window (checkpoints and
                # intra-batch heartbeats both count as progress), or when
                # it exceeds the wall-clock safety net. A steadily
                # progressing multi-hour job is never killed by a timer.
                stall_timeout = job.timeout_secs or _STALL_TIMEOUT_SECS
                progress_marker = {"at": time.monotonic()}

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
                        now = time.monotonic()
                        stalled_for = now - progress_marker["at"]
                        if stalled_for > stall_timeout:
                            timeout_reason = (
                                f"no forward progress for {int(stalled_for)}s "
                                f"(stall timeout {stall_timeout}s)"
                            )
                        elif now - wall_start > _MAX_WALL_SECS:
                            timeout_reason = (
                                f"exceeded wall-clock safety net {_MAX_WALL_SECS}s"
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

                # Success
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
                if hasattr(job, "run_stats") and isinstance(result.get("run_stats"), dict):
                    try:
                        job.run_stats = json.dumps(result["run_stats"])
                    except (TypeError, ValueError):
                        pass
                job.graph_fingerprint_after = await compute_graph_fingerprint(provider)

                # Update aggregation-owned data source state
                await self._update_ds_state(
                    session,
                    job.data_source_id,
                    aggregation_status="ready",
                    last_aggregated_at=job.completed_at,
                    aggregation_edge_count=job.created_edges,
                    graph_fingerprint=job.graph_fingerprint_after,
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

                logger.info(
                    "Aggregation job %s completed: %d edges processed, %d AGGREGATED created",
                    job_id, job.processed_edges, job.created_edges,
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
            if ds is None:
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
        if not flat.lineage_edge_types:
            raise ValueError(
                "No lineage edge types configured — the pinned ontology "
                f"{job.ontology_id!r} classifies no relationship as "
                "lineage (trigger_source="
                f"{job.trigger_source!r})"
            )
        levels = derive_level_map(
            SimpleNamespace(entity_type_definitions=entity_defs)
        )
        job.containment_edge_types = json.dumps(list(flat.containment_edge_types))
        job.lineage_edge_types = json.dumps(list(flat.lineage_edge_types))
        if hasattr(job, "entity_type_levels"):
            job.entity_type_levels = json.dumps(levels)
        job.updated_at = _now()
        await session.commit()
        logger.warning(
            "Aggregation job %s had no frozen edge types "
            "(trigger_source=%r) — re-froze from pinned ontology %s "
            "(%d lineage, %d containment types)",
            job.id, job.trigger_source, job.ontology_id,
            len(flat.lineage_edge_types), len(flat.containment_edge_types),
        )
        return (
            list(flat.containment_edge_types),
            list(flat.lineage_edge_types),
            levels,
        )

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

        # Phase 2 — quiesce events (ProviderBusy raised by the provider
        # when write p95 climbs above the trigger) are flow control,
        # not failures. They do NOT count against ``max_retries``; the
        # worker simply parks the job for ``retry_after_seconds`` and
        # re-attempts. A safety cap on consecutive quiesce events
        # prevents an indefinitely-overloaded provider from hanging
        # the job forever — after the cap the job moves to ``failed``.
        max_quiesce_events = int(os.getenv("AGGREGATION_MAX_QUIESCE_EVENTS", "20"))
        quiesce_event_count = 0
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

        while True:
            try:
                return await self._materialize_with_checkpoints(
                    session=session,
                    job=job,
                    provider=provider,
                    containment_types=containment_types,
                    lineage_types=lineage_types,
                    cancel_event=cancel_event,
                    emitter=emitter,
                    scope=scope,
                    progress_marker=progress_marker,
                )
            except JobCancelled:
                # Cooperative cancel — control-flow signal, not a transient
                # failure. Skip the retry mill and bubble straight up to the
                # outer run() handler, which marks the job 'cancelled' and
                # emits the terminal event with last_cursor preserved.
                raise
            except (MaterializationBudgetExceeded, MaterializationPreconditionFailed):
                # Both are deterministic — every retry recomputes the same
                # outcome and burns another full EXTRACT+COMPUTE pass. Fail
                # terminally with the guidance message intact.
                raise
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
                await asyncio.sleep(delay)
                _mark_alive()
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
                    last_progress = job.processed_edges or 0
                provider_unavailable_count += 1
                job.retry_count = attempt + 1

                # Second occurrence whose reason is "Circuit open" — fail fast.
                # Retrying further is pointless: the breaker has already
                # decided the downstream is sick.
                if (
                    provider_unavailable_count >= 2
                    and "circuit open" in (e.reason or "").lower()
                ):
                    job.error_message = (
                        f"Provider {e.provider_name} unavailable after "
                        f"{attempt + 1} attempts; circuit breaker open"
                    )[:2000]
                    job.updated_at = _now()
                    await session.commit()
                    logger.warning(
                        "Aggregation job %s: aborting — provider %s circuit "
                        "open after %d attempts",
                        job.id, e.provider_name, attempt + 1,
                    )
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
                    await asyncio.sleep(delay)
                    _mark_alive()
                    attempt += 1
                else:
                    # Final attempt exhausted — let the caller handle it
                    raise
            except Exception as e:
                last_error = e
                if (job.processed_edges or 0) > last_progress:
                    # Resumed past the failure point — fresh failure; reset
                    # the budget so steady forward progress survives transient
                    # resets indefinitely.
                    attempt = 0
                    provider_unavailable_count = 0
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
                    await asyncio.sleep(delay)
                    _mark_alive()
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

        async def checkpoint(
            processed: int, total: int, cursor: Optional[str],
            aggregated: int = 0, phase: Optional[str] = None,
            *, progress_pct: Optional[int] = None,
            stats: Optional[dict] = None,
        ) -> None:
            nonlocal last_commit_monotonic, batches_since_commit, is_first_checkpoint
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
            batches_since_commit += 1
            elapsed = time.monotonic() - last_commit_monotonic
            should_commit = (
                is_first_checkpoint
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
                },
            )

        async def intra_batch_heartbeat(running_aggregated: int) -> None:
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
            await emitter.publish(
                job_id=job.id,
                kind="aggregation",
                scope=scope,
                type="progress",
                payload={
                    "boundary": "intra_batch",
                    "created_edges": running_aggregated,
                },
                live_state={
                    "created_edges": running_aggregated,
                    "last_heartbeat_at": _now(),
                },
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

        try:
            job_tuning = json.loads(getattr(job, "tuning_json", None) or "{}") or {}
        except (TypeError, ValueError):
            job_tuning = {}
        result = await provider.materialize_aggregated_edges_batch(
            containment_edge_types=containment_types,
            lineage_edge_types=lineage_types,
            batch_size=job.batch_size,
            tuning=job_tuning,
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
