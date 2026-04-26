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
from backend.app.providers.manager import provider_manager
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

    start_ts = asyncio.get_event_loop().time()
    async with admission.gate(ds_orm.provider_id, op_kind="purge"):
        # Inside the gate so admission accounts for both the COUNT and
        # the DELETE batches. Order:
        #   1. COUNT first  → we have a denominator for progress.
        #   2. Commit ``running`` + ``total_edges`` so the Job History
        #      UI flips off "Pending" the moment we have data, not
        #      after the entire DELETE finishes (could be minutes).
        #   3. Iterate DELETE in batches; each batch checkpoints
        #      ``processed_edges`` / ``progress`` with a coalesced
        #      commit so polls during the run see the count climb.
        total = await provider.count_aggregated_edges()
        job.status = "running"
        if not job.started_at:
            job.started_at = _now()
        job.total_edges = total
        job.processed_edges = 0
        job.progress = 0
        job.updated_at = _now()
        await session.commit()

        last_commit_ts = asyncio.get_event_loop().time()

        async def _checkpoint(deleted_so_far: int) -> None:
            """Per-batch progress hook handed to the provider's purge
            loop. Mirrors the cadence used by the aggregation worker
            (commit at most every 2s) so a multi-minute purge floods
            neither the DB with commits nor the UI with stale numbers.
            """
            nonlocal last_commit_ts
            job.processed_edges = deleted_so_far
            job.progress = (
                int((deleted_so_far / total) * 100) if total > 0 else 0
            )
            job.updated_at = _now()
            now_ts = asyncio.get_event_loop().time()
            if now_ts - last_commit_ts >= 2.0:
                await session.commit()
                last_commit_ts = now_ts

        deleted = await provider.purge_aggregated_edges(
            batch_size=10_000,
            progress_callback=_checkpoint,
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

    logger.info(
        "purge.completion job_id=%s ds=%s deleted=%d duration_secs=%.2f",
        job.id, job.data_source_id, deleted, duration,
    )


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
