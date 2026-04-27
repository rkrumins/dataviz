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

from sqlalchemy.ext.asyncio import AsyncSession

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


async def collect(session: AsyncSession, envelope: PurgeJobEnvelope) -> None:
    """Run a purge for one data source.

    Updates the pre-existing ``AggregationJobORM`` row through the
    states ``pending`` → ``running`` → ``completed`` (or ``failed`` on
    a non-recoverable error). Soft-retry exceptions
    (``AdmissionDenied`` / ``ProviderUnavailable``) propagate out for
    the worker to handle; the job stays ``running`` and will be picked
    up again on the next dispatch (delivery-count is not bumped).

    Idempotency: ``MATCH ... DELETE`` is safe to repeat — already-
    deleted edges are no-ops, and the data_source_state reset only
    needs to land once.
    """
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

    finally:
        # Always unregister the cancel event so a future job re-using
        # this id (cancellation + retrigger) starts with a fresh event.
        cancel_registry.unregister(job.id)


async def record_failure(
    session: AsyncSession,
    job_id: str,
    error: str,
) -> None:
    """Mark a purge job as ``failed`` with an error message. Called by
    the worker after delivery attempts exhaust — see
    ``worker._handle_failure``."""
    job = await session.get(AggregationJobORM, job_id)
    if job is None:
        return
    job.status = "failed"
    job.error_message = error[:2000]
    job.completed_at = _now()
    job.updated_at = _now()


# Self-register with the dispatcher.
dispatcher.register_handler("purge", collect)
