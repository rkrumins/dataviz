"""Property-alignment handler — unpack nested containers into native fields.

An onboarded graph nests every user property under one container key. The read
path hydrates it so the drawer looks right, but a nested value is not an
indexable field, so Advanced Search cannot see any of it. This job is what
makes those properties real: it rewrites each node so every scalar leaf becomes
its own FalkorDB property.

It runs here, on the insights service's Redis Streams, for the same reasons
purge does — retry with DLQ, XAUTOCLAIM crash recovery, the per-graph
semaphore, the per-provider admission gate, and a soft-retry path when the
provider is down. The durable status record is the pre-existing
``aggregation_jobs`` row, which also buys mutual exclusion with aggregation
over the same graph: the two must not rewrite the same nodes at once.

The walk itself lives in ``services.property_alignment.run_alignment`` and
proceeds in internal-ID windows, so memory is flat whether the graph holds ten
thousand nodes or ten million, and a cancelled run resumes from a stored
cursor rather than starting over.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_jobs_session
from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.jobs import JobScope as PlatformJobScope, get_emitter
from backend.app.jobs.audit import record_terminal
from backend.app.providers.manager import provider_manager
from backend.app.services.aggregation.cancel import (
    get_registry as get_cancel_registry,
)
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.property_alignment import run_alignment

from . import admission, dispatcher
from .schemas import PropertyAlignmentJobEnvelope

logger = logging.getLogger(__name__)

_KIND = "property_alignment"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


async def collect(envelope: PropertyAlignmentJobEnvelope) -> None:
    """Align one data source's node properties.

    Drives the ``AggregationJobORM`` row through ``pending`` → ``running`` →
    ``completed`` / ``cancelled`` / ``failed``. Soft-retry exceptions
    (``AdmissionDenied`` / ``ProviderUnavailable``) propagate for the worker
    to handle; the row stays ``running`` and the next dispatch resumes it.

    Session discipline follows purge: one JOBS session for the run, because
    the row carries a mid-run commit (the ``running`` flip) and the terminal
    write has to land atomically with the audit row.
    """
    async with get_jobs_session() as session:
        await _collect_in_session(session, envelope)


async def _collect_in_session(
    session: AsyncSession, envelope: PropertyAlignmentJobEnvelope,
) -> None:
    job = await session.get(AggregationJobORM, envelope.job_id)
    if job is None:
        logger.warning(
            "alignment.job_missing job_id=%s ds=%s — dropping",
            envelope.job_id, envelope.data_source_id,
        )
        return
    if job.status in ("completed", "failed", "cancelled"):
        logger.info(
            "alignment.already_terminal job_id=%s status=%s — skipping",
            job.id, job.status,
        )
        return

    ds_orm = await session.get(WorkspaceDataSourceORM, job.data_source_id)
    if ds_orm is None or ds_orm.deleted_at is not None:
        job.status = "failed"
        job.error_message = (
            "workspace_data_source row missing or deleted — alignment aborted"
        )
        job.completed_at = _now()
        job.updated_at = _now()
        return

    provider = await provider_manager.get_provider_for_workspace(
        envelope.workspace_id, session, data_source_id=job.data_source_id,
    )
    mapping = getattr(provider, "_mapping", None)

    emitter = get_emitter()
    emitter.seed_sequence(job.id, job.last_sequence or 0)
    scope = PlatformJobScope(
        workspace_id=job.workspace_id or envelope.workspace_id or "",
        data_source_id=job.data_source_id,
    )

    cancel_registry = get_cancel_registry()
    cancel_event = cancel_registry.register(job.id)

    def _should_cancel() -> bool:
        return cancel_event.is_set()

    # Resume from wherever the last attempt stopped. The cursor is the ID the
    # walk had reached, so a resumed run re-reads nothing it already wrote.
    start_id = envelope.start_id
    if not start_id and job.last_cursor:
        try:
            start_id = int(job.last_cursor)
        except (TypeError, ValueError):
            start_id = 0

    start_ts = asyncio.get_event_loop().time()
    try:
        async with admission.gate(ds_orm.provider_id, op_kind="purge"):
            job.status = "running"
            if not job.started_at:
                job.started_at = _now()
            job.progress = 0
            job.updated_at = _now()
            await session.commit()

            await emitter.publish(
                job_id=job.id, kind=_KIND, scope=scope, type="state",
                payload={"status": "running", "start_id": start_id},
                live_state={
                    "status": "running",
                    "started_at": job.started_at or "",
                    "progress": 0,
                    "currentPhase": "aligning",
                },
            )

            async def _checkpoint(stats: dict) -> None:
                """Per-window progress. Redis only — the PG row stays silent
                until terminal, same as purge, so a long run doesn't hold the
                JOBS pool under sustained write pressure.

                Progress is ID-space coverage, not node count: the walk knows
                how far through the ID range it is long before it knows how
                many nodes carry a container.
                """
                max_id = stats.get("maxId") or 0
                done = min(stats.get("lastId") or 0, max_id)
                progress = int(done / max_id * 100) if max_id > 0 else 0
                await emitter.publish(
                    job_id=job.id, kind=_KIND, scope=scope, type="progress",
                    payload={
                        "boundary": "window",
                        "processed": stats.get("processed", 0),
                        "aligned": stats.get("aligned", 0),
                        "progress": progress,
                    },
                    live_state={
                        "processed_edges": stats.get("aligned", 0),
                        "total_edges": stats.get("processed", 0),
                        "progress": progress,
                        "last_cursor": str(stats.get("lastId") or 0),
                        "last_heartbeat_at": _now(),
                    },
                )

            stats = await run_alignment(
                provider, mapping,
                start_id=start_id,
                progress_cb=_checkpoint,
                should_cancel=_should_cancel,
                dry_run=envelope.dry_run,
            )
        duration = asyncio.get_event_loop().time() - start_ts

        cancelled = bool(stats.get("cancelled"))
        status = "cancelled" if cancelled else "completed"
        # The exact figure, finally — the walk visited every node, so unlike
        # the sampled report this is a count and not an estimate.
        payload = {
            "processed": stats.get("processed", 0),
            "aligned": stats.get("aligned", 0),
            "unparseable": stats.get("unparseable", 0),
            "skippedNoUrn": stats.get("skippedNoUrn", 0),
            "dryRun": stats.get("dryRun", False),
            "duration_secs": duration,
            "completed_at": _now(),
        }

        job.status = status
        job.progress = 0 if cancelled else 100
        job.processed_edges = stats.get("aligned", 0)
        job.total_edges = stats.get("processed", 0)
        # Cursor kept ONLY on cancel — that's what a resume reads. Clearing it
        # on success stops a later re-run from skipping the front of the graph.
        job.last_cursor = str(stats.get("lastId") or 0) if cancelled else None
        job.completed_at = _now()
        job.updated_at = _now()

        terminal_seq = emitter.current_sequence(job.id) + 1
        await record_terminal(
            session, job_id=job.id, kind=_KIND, scope=scope,
            sequence=terminal_seq, status=status, payload=payload,
        )
        await emitter.terminal(
            job_id=job.id, kind=_KIND, scope=scope,
            status=status, payload=payload,
        )

        logger.info(
            "alignment.completion job_id=%s ds=%s status=%s aligned=%d "
            "processed=%d unparseable=%d duration_secs=%.2f",
            job.id, job.data_source_id, status, payload["aligned"],
            payload["processed"], payload["unparseable"], duration,
        )

        # Node properties just changed shape, so the cached storage profile is
        # now wrong — nudge a re-profile rather than leaving the Mapping tab
        # reporting the pre-alignment state until the next sweep.
        if not cancelled and not envelope.dry_run:
            from .enqueue import mark_stats_changed
            await mark_stats_changed(
                envelope.data_source_id, envelope.workspace_id,
            )
    finally:
        cancel_registry.unregister(job.id)


dispatcher.register_handler(_KIND, collect)
