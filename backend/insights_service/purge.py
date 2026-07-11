"""Async aggregation-edge purge handler.

Replaces the FastAPI ``BackgroundTasks`` plumbing that sat in
``aggregation.py`` / ``service.execute_purge``. Purge runs as a regular
insights-service Redis Streams job, which gets us, for free:

* Retry on transient errors (delivery-count + DLQ).
* Crash recovery via XAUTOCLAIM at worker startup.
* Per-graph semaphore so concurrent purges of the same upstream graph
  serialise.
* Per-provider admission gate (token bucket + circuit breaker).
* Soft-retry path when the provider is unavailable — no DLQ cascade.

The durable job record lives in ``aggregation_jobs`` (same table as
trigger/skip aggregation jobs); the worker only updates that row.
That keeps Job History uniform across kinds.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_jobs_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.jobs import JobScope as PlatformJobScope, get_emitter
from backend.app.jobs.audit import record_terminal
from backend.app.providers.manager import provider_manager
from backend.app.services.aggregation.cancel import (
    JobCancelled,
    get_registry as get_cancel_registry,
)
from backend.app.services.aggregation.models import (
    AggregationDataSourceStateORM,
    AggregationJobORM,
)

from . import admission, dispatcher
from .schemas import PurgeJobEnvelope

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def collect(envelope: PurgeJobEnvelope) -> None:
    """Run a purge for one data source.

    Updates the pre-existing ``AggregationJobORM`` row through the
    states ``pending`` → ``running`` → ``completed`` (or ``failed`` on
    a non-recoverable error). Soft-retry exceptions
    (``AdmissionDenied`` / ``ProviderUnavailable``) propagate out for
    the worker to handle; the job stays ``running`` and will be picked
    up again on the next dispatch (delivery-count is not bumped).

    Session discipline: purge is the DOCUMENTED EXCEPTION to the
    "handlers open short sessions around DB phases" rule — it holds one
    JOBS session for its whole run because the ORM job/state rows carry
    a mid-run commit (the ``running`` flip at the COUNT step) and the
    cancel path re-reads them (``session.refresh``). Restructuring that
    lifecycle isn't worth the blast radius; revisit only if JOBS-pool
    pressure is observed.

    Idempotency: ``MATCH ... DELETE`` is safe to repeat — already-
    deleted edges are no-ops, and the data_source_state reset only
    needs to land once.
    """
    reagg_job = None
    async with get_jobs_session() as session:
        reagg_job = await _collect_in_session(session, envelope)
    # Post-purge re-aggregation fires only AFTER the outer commit above
    # has landed the purge row's ``completed`` status. Firing inside the
    # transaction made the control plane's active-job guard see the
    # still-``running`` purge row → 409 → the auto re-aggregation
    # silently never happened.
    if reagg_job is not None:
        await _maybe_trigger_reaggregation(reagg_job)


async def _collect_in_session(
    session: AsyncSession, envelope: PurgeJobEnvelope,
) -> "SimpleNamespace | None":
    """Returns a detached post-purge re-aggregation payload on successful
    completion (fired by the caller AFTER the outer commit), else None."""
    job = await session.get(AggregationJobORM, envelope.job_id)
    if job is None:
        # Producer raced a job-deletion. Nothing to update; let the
        # message ACK silently rather than DLQ.
        logger.warning(
            "purge.job_missing job_id=%s ds=%s — dropping",
            envelope.job_id, envelope.data_source_id,
        )
        return

    # If the row is already terminal (a previous attempt finished or an
    # operator cancelled it), don't re-run the provider call.
    if job.status in ("completed", "failed", "cancelled"):
        logger.info(
            "purge.already_terminal job_id=%s status=%s — skipping",
            job.id, job.status,
        )
        return

    state = await session.get(AggregationDataSourceStateORM, job.data_source_id)
    if state is None:
        job.status = "failed"
        job.error_message = "data_source_state row missing — purge aborted"
        job.completed_at = _now()
        job.updated_at = _now()
        return

    ds_orm = await session.get(WorkspaceDataSourceORM, job.data_source_id)
    if ds_orm is None:
        job.status = "failed"
        job.error_message = "workspace_data_source row missing — purge aborted"
        job.completed_at = _now()
        job.updated_at = _now()
        return
    actual_mode = (
        job.projection_mode
        or ds_orm.projection_mode
        or "in_source"
    )

    provider = await provider_manager.get_provider_for_workspace(
        state.workspace_id, session, data_source_id=job.data_source_id,
    )
    await provider.set_projection_mode(actual_mode)

    # Platform JobEmitter — the only path for live progress updates.
    # Same pattern as AggregationWorker: per-batch DB writes go away;
    # heartbeat lives in Redis HSET and per-job stream.
    emitter = get_emitter()
    emitter.seed_sequence(job.id, job.last_sequence or 0)
    scope = PlatformJobScope(
        workspace_id=job.workspace_id or "",
        data_source_id=job.data_source_id,
    )

    # Register a cooperative cancel event so the cross-process cancel
    # bridge (CancelListener subscribed to the Redis Pub/Sub control
    # channel) can flip this purge into a clean exit. Same shape as
    # the aggregation worker — checked between DELETE batches via the
    # ``should_cancel`` predicate handed to the provider; raises
    # ``JobCancelled`` from the loop when set. The ``finally`` block
    # below unregisters so a future job re-using this id (resume)
    # starts fresh.
    cancel_registry = get_cancel_registry()
    cancel_event = cancel_registry.register(job.id)

    def _should_cancel() -> bool:
        return cancel_event.is_set()

    start_ts = asyncio.get_event_loop().time()
    try:
        async with admission.gate(ds_orm.provider_id, op_kind="purge"):
            # Inside the gate so admission accounts for both the COUNT and
            # the DELETE batches. Order:
            #   1. COUNT first  → we have a denominator for progress.
            #   2. Commit ``running`` + ``total_edges`` ONCE so the Job
            #      History UI flips off "Pending" immediately. After this,
            #      mid-purge progress lives only in Redis (no DB writes
            #      until the terminal commit at the end).
            #   3. Iterate DELETE in batches; each batch publishes a
            #      ``progress`` event via JobEmitter — Redis HSET +
            #      per-job stream. PG is silent until terminal.
            total = await provider.count_aggregated_edges()
            job.status = "running"
            if not job.started_at:
                job.started_at = _now()
            job.total_edges = total
            job.processed_edges = 0
            job.progress = 0
            job.updated_at = _now()
            await session.commit()

            # Emit ``state`` event once we've durably committed running.
            await emitter.publish(
                job_id=job.id,
                kind="purge",
                scope=scope,
                type="state",
                payload={"status": "running", "total_edges": total},
                live_state={
                    "status": "running",
                    "started_at": job.started_at or "",
                    "total_edges": total,
                    "processed_edges": 0,
                    "progress": 0,
                },
            )

            async def _checkpoint(deleted_so_far: int) -> None:
                """Per-batch progress hook. Redis-only; the PG ``running``
                row is updated only at terminal. The 2-second JobEmitter
                cadence (Redis HSET + Stream XADD) replaces the previous
                PG commit cadence — drops sustained JOBS-pool write
                pressure and keeps the UI smooth via SSE."""
                progress = int((deleted_so_far / total) * 100) if total > 0 else 0
                await emitter.publish(
                    job_id=job.id,
                    kind="purge",
                    scope=scope,
                    type="progress",
                    payload={
                        "boundary": "batch",
                        "deleted_so_far": deleted_so_far,
                        "total_edges": total,
                        "progress": progress,
                    },
                    live_state={
                        "processed_edges": deleted_so_far,
                        "progress": progress,
                        "last_heartbeat_at": _now(),
                    },
                )

            deleted = await provider.purge_aggregated_edges(
                batch_size=10_000,
                progress_callback=_checkpoint,
                should_cancel=_should_cancel,
            )
        duration = asyncio.get_event_loop().time() - start_ts

        # Reset aggregation-owned state alongside the job finalisation so a
        # crash between the two can't leave inconsistent records.
        state.aggregation_status = "none"
        state.last_aggregated_at = None
        state.aggregation_edge_count = 0
        state.graph_fingerprint = None

        job.status = "completed"
        job.progress = 100
        job.total_edges = deleted
        job.processed_edges = deleted
        job.completed_at = _now()
        job.updated_at = _now()

        # Audit row + terminal event in the same transaction as the
        # status flip; the worker's outer commit lands all three or
        # rolls all back together.
        terminal_seq = emitter.current_sequence(job.id) + 1
        await record_terminal(
            session,
            job_id=job.id,
            kind="purge",
            scope=scope,
            sequence=terminal_seq,
            status="completed",
            payload={
                "deleted_edges": deleted,
                "duration_secs": duration,
                "completed_at": job.completed_at,
            },
        )
        await emitter.terminal(
            job_id=job.id,
            kind="purge",
            scope=scope,
            status="completed",
            payload={
                "deleted_edges": deleted,
                "duration_secs": duration,
                "completed_at": job.completed_at,
            },
        )

        logger.info(
            "purge.completion job_id=%s ds=%s deleted=%d duration_secs=%.2f",
            job.id, job.data_source_id, deleted, duration,
        )

        # Edge counts just changed — nudge the insights counts poll
        # (cooldown-throttled, never raises).
        from .enqueue import mark_stats_changed
        await mark_stats_changed(envelope.data_source_id, envelope.workspace_id)

        # The purge rewrote the :AGGREGATED layer — invalidate the
        # aggregated read caches THROUGH THE SHARED CHOKE POINT (bump the
        # scoped generation + purge the last-known-good entries). Without
        # this a purge was invisible to the canvas: the primary cache
        # expired in ~60s but every degraded read kept serving pre-purge
        # LKG answers for up to its TTL ("edges still there after a
        # verified delete"). Best-effort direct call (same-Redis
        # topologies) + a bus event so the viz-service listener covers
        # split topologies. Both must never fail a purge whose deletes
        # already landed.
        try:
            from backend.app.services.graph_cache import invalidate_aggregated_reads
            await invalidate_aggregated_reads(
                envelope.workspace_id or "", envelope.data_source_id,
            )
        except Exception as exc:
            logger.warning(
                "purge.cache_invalidation_failed ds=%s: %s",
                envelope.data_source_id, exc,
            )
        try:
            from backend.app.services.aggregation.events import AggregationEventPublisher
            from backend.app.services.aggregation.redis_client import get_redis
            await AggregationEventPublisher(get_redis()).purge_completed(
                job_id=job.id,
                data_source_id=job.data_source_id,
                workspace_id=envelope.workspace_id,
                deleted_edges=deleted,
            )
        except Exception as exc:
            logger.warning(
                "purge.event_publish_failed ds=%s: %s",
                envelope.data_source_id, exc,
            )

        # PURGE QUARANTINE for the opt-out case: skipping the post-purge
        # re-aggregation is meaningless if the read path's empty-result
        # backfill resurrects the cells on the next canvas load. Arm the
        # backfill's own damping key (shared contract with
        # context_engine._trigger_materialize_in_background) so a
        # skip-reaggregate purge STAYS purged for the damping window
        # unless the user re-aggregates explicitly.
        await _arm_purge_quarantine(provider, job)

        # Post-purge re-aggregation (default ON, opt-out rides the job
        # row): container-level lineage is BLIND until the canonical
        # cells are rebuilt — same-level container pairs cannot be
        # derived on demand at scale. The caller fires the trigger AFTER
        # the outer commit; hand it a detached snapshot of the fields it
        # needs (the ORM row is unusable once the session closes).
        return SimpleNamespace(
            id=job.id,
            data_source_id=job.data_source_id,
            projection_mode=job.projection_mode,
            tuning_json=getattr(job, "tuning_json", None),
        )

    except JobCancelled as cancel_exc:
        # Cooperative cancel observed between DELETE batches. The
        # previous batch's MATCH ... DELETE landed cleanly in
        # FalkorDB before the predicate fired, so we never orphan a
        # Cypher transaction. ``processed_edges`` reflects work that
        # genuinely completed; the row's terminal status lines up
        # with where the worker actually stopped.
        duration = asyncio.get_event_loop().time() - start_ts
        # Re-fetch the row to capture whatever the running-state
        # commit landed before we observed the cancel.
        await session.refresh(job)
        job.status = "cancelled"
        job.completed_at = _now()
        job.error_message = (
            f"Cancelled at {cancel_exc.observed_at}. "
            f"Progress preserved: {job.processed_edges}/{job.total_edges} edges deleted. "
            "Resume by triggering a new Purge."
        )
        job.updated_at = _now()
        state.aggregation_status = "cancelled"

        terminal_seq = emitter.current_sequence(job.id) + 1
        await record_terminal(
            session,
            job_id=job.id,
            kind="purge",
            scope=scope,
            sequence=terminal_seq,
            status="cancelled",
            payload={
                "observed_at": cancel_exc.observed_at,
                "processed_edges": job.processed_edges,
                "total_edges": job.total_edges,
                "duration_secs": duration,
            },
        )
        await emitter.terminal(
            job_id=job.id,
            kind="purge",
            scope=scope,
            status="cancelled",
            payload={
                "observed_at": cancel_exc.observed_at,
                "processed_edges": job.processed_edges,
                "total_edges": job.total_edges,
                "duration_secs": duration,
            },
        )
        logger.info(
            "purge.cancelled job_id=%s ds=%s deleted=%d/%d duration_secs=%.2f",
            job.id, job.data_source_id,
            job.processed_edges, job.total_edges, duration,
        )

        # A cancelled purge still deleted the batches that completed
        # before the cancel — counts changed, nudge the poll.
        from .enqueue import mark_stats_changed
        await mark_stats_changed(envelope.data_source_id, envelope.workspace_id)

    finally:
        # Always unregister the cancel event so a future job re-using
        # this id (cancellation + retrigger) starts with a fresh event.
        cancel_registry.unregister(job.id)


async def record_failure(
    job_id: str,
    error: str,
) -> None:
    """Mark a purge job as ``failed`` with an error message. Called by
    the worker after delivery attempts exhaust — see
    ``worker._handle_failure``. Opens its own short JOBS session."""
    async with get_jobs_session() as session:
        job = await session.get(AggregationJobORM, job_id)
        if job is None:
            return
        job.status = "failed"
        job.error_message = error[:2000]
        job.completed_at = _now()
        job.updated_at = _now()


async def _arm_purge_quarantine(provider, job) -> None:
    """When the purge row carries ``{"skip_reaggregate": true}``, damp the
    read-path backfill for its 15-minute window by pre-setting its dedupe
    key. Never raises."""
    import json as _json
    try:
        opts = _json.loads(getattr(job, "tuning_json", None) or "{}") or {}
    except (TypeError, ValueError):
        opts = {}
    if not opts.get("skip_reaggregate"):
        return
    redis = getattr(provider, "_redis", None)
    if redis is None:
        return
    try:
        await redis.set(
            f"materialize:in-flight:{job.data_source_id}",
            "purge-quarantine", ex=900,
        )
        logger.info(
            "purge.quarantine_armed ds=%s (read-path backfill damped for "
            "15m; re-aggregate manually to rebuild)", job.data_source_id,
        )
    except Exception as exc:
        logger.warning("purge.quarantine_failed ds=%s: %s", job.data_source_id, exc)


async def _maybe_trigger_reaggregation(job: AggregationJobORM) -> None:
    """Fire a normal aggregation job after a successful purge unless the
    row carries ``{"skip_reaggregate": true}`` (the UI opt-out). Routed
    through the control plane so the run is a first-class job — visible
    in the jobs UI, on the worker fleet, holding the graph lease under
    its own name. Never raises."""
    import json as _json
    import os as _os
    try:
        opts = _json.loads(getattr(job, "tuning_json", None) or "{}") or {}
    except (TypeError, ValueError):
        opts = {}
    if opts.get("skip_reaggregate"):
        logger.info(
            "purge.reaggregate_skipped job_id=%s ds=%s (user opt-out)",
            job.id, job.data_source_id,
        )
        return
    base = _os.getenv("AGGREGATION_SERVICE_URL", "http://localhost:8091")
    try:
        import httpx
        async with httpx.AsyncClient(
            base_url=base, timeout=httpx.Timeout(10.0, connect=3.0),
        ) as client:
            resp = await client.post(
                f"/aggregation/data-sources/{job.data_source_id}/jobs",
                params={"triggerSource": "post_purge"},
                json={
                    "projectionMode": job.projection_mode or "in_source",
                    "batchSize": 1000,
                },
            )
        if resp.status_code in (200, 202):
            logger.info(
                "purge.reaggregate_triggered job_id=%s ds=%s",
                job.id, job.data_source_id,
            )
        elif resp.status_code == 409:
            logger.info(
                "purge.reaggregate_already_active job_id=%s ds=%s",
                job.id, job.data_source_id,
            )
        else:
            logger.error(
                "purge.reaggregate_rejected job_id=%s ds=%s status=%s body=%s "
                "— the promised post-purge re-aggregation did NOT run; "
                "trigger aggregation manually to restore container-level "
                "lineage",
                job.id, job.data_source_id, resp.status_code, resp.text[:300],
            )
    except Exception as exc:
        logger.error(
            "purge.reaggregate_failed job_id=%s ds=%s: %s — the promised "
            "post-purge re-aggregation did NOT run (is AGGREGATION_SERVICE_URL "
            "set for this service? base=%s); trigger aggregation manually to "
            "restore container-level lineage",
            job.id, job.data_source_id, exc, base,
        )


# Self-register with the dispatcher.
dispatcher.register_handler("purge", collect)
