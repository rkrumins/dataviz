"""
Dispatcher protocol + concrete implementations for aggregation jobs.

The Dispatcher is the ONLY seam that changes when migrating from
in-process (asyncio) to standalone-process (Postgres NOTIFY) to
message-queue-based (Redis Streams) deployment.

    dev / single-process:  InProcessDispatcher    → asyncio.create_task()
    legacy standalone:     PostgresDispatcher      → NOTIFY aggregation_jobs
    production:            RedisStreamDispatcher   → XADD aggregation.jobs
    migration:             DualDispatcher          → NOTIFY + XADD (zero-downtime)
"""
import asyncio
import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Protocol

from sqlalchemy import text

if TYPE_CHECKING:
    from .worker import AggregationWorker

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AggregationDispatcher(Protocol):
    """Single-parameter dispatch — all job data lives on the DB record."""

    async def dispatch(self, job_id: str) -> None: ...


class InProcessDispatcher:
    """Runs worker in-process via asyncio with full task lifecycle management.

    Cross-process duplicate-dispatch protection comes from the upstream
    Postgres advisory lock in `reservation.claim_exclusive` — by the time
    a job_id reaches `dispatch()`, exactly one caller has the right to
    create it. We don't need a per-DS asyncio.Lock here on top.

    Tasks are stored in _active_tasks to prevent GC collection; done_callback
    logs unhandled exceptions (safety net).
    """

    def __init__(self, worker: "AggregationWorker") -> None:
        self._worker = worker
        self._active_tasks: dict[str, asyncio.Task] = {}

    async def dispatch(self, job_id: str) -> None:
        task = asyncio.create_task(
            self._worker.run(job_id), name=f"aggregation-{job_id}"
        )
        self._active_tasks[job_id] = task
        task.add_done_callback(lambda t: self._on_done(job_id, t))

    def cancel_task(self, job_id: str) -> None:
        """Cancel the asyncio task for a job as a backup signal."""
        task = self._active_tasks.get(job_id)
        if task and not task.done():
            task.cancel()

    def _on_done(self, job_id: str, task: asyncio.Task) -> None:
        self._active_tasks.pop(job_id, None)
        if task.cancelled():
            logger.warning("Aggregation task %s was cancelled", job_id)
        elif exc := task.exception():
            logger.error(
                "Aggregation task %s unhandled failure: %s",
                job_id, exc, exc_info=exc,
            )


class PostgresDispatcher:
    """Dispatches jobs to a standalone worker via Postgres NOTIFY.

    The job row in ``aggregation_jobs`` IS the message — persistent by
    definition.  NOTIFY provides instant wake-up; the worker's polling
    loop (5s fallback) catches any missed notifications (e.g. if the
    worker was restarting when NOTIFY fired).

    Used when ``AGGREGATION_DISPATCH_MODE=postgres``.  The viz-service
    (web tier) uses this dispatcher; the standalone aggregation-worker
    process consumes the notifications.
    """

    def __init__(self, session_factory: Any) -> None:
        self._session_factory = session_factory

    async def dispatch(self, job_id: str) -> None:
        async with self._session_factory() as session:
            await session.execute(
                text("SELECT pg_notify('aggregation_jobs', :job_id)"),
                {"job_id": job_id},
            )
            await session.commit()
        logger.info("PostgresDispatcher: notified channel 'aggregation_jobs' for job %s", job_id)


class RedisStreamDispatcher:
    """Dispatches jobs via Redis Streams — consumed by worker pods.

    The job row in ``aggregation_jobs`` IS the source of truth. The stream
    entry is a lightweight wake-up signal containing only ``{job_id}``.
    ``maxlen`` trims acknowledged entries; losing old entries is safe
    because the data lives in Postgres.

    Consumer groups (XREADGROUP) distribute messages across worker replicas.
    The Pending Entry List (PEL) handles crash recovery — unACKed messages
    are re-claimed by surviving workers via XAUTOCLAIM.

    Used when ``AGGREGATION_DISPATCH_MODE=redis``.
    """

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    async def dispatch(self, job_id: str) -> None:
        from .redis_client import JOBS_STREAM

        await self._redis.xadd(
            JOBS_STREAM,
            {"job_id": job_id, "dispatched_at": _now()},
            maxlen=50000,
        )
        logger.info(
            "RedisStreamDispatcher: published job %s to stream '%s'",
            job_id, JOBS_STREAM,
        )


class DualDispatcher:
    """Zero-downtime migration dispatcher — writes to BOTH Postgres NOTIFY
    and Redis Streams simultaneously.

    Use during the transition period when old workers may still be listening
    on Postgres NOTIFY while new workers consume from Redis Streams.
    Once all workers are migrated to Redis, switch to RedisStreamDispatcher.
    """

    def __init__(
        self,
        postgres_dispatcher: PostgresDispatcher,
        redis_dispatcher: RedisStreamDispatcher,
    ) -> None:
        self._postgres = postgres_dispatcher
        self._redis = redis_dispatcher

    async def dispatch(self, job_id: str) -> None:
        # Redis first (primary), Postgres second (fallback for legacy workers)
        await self._redis.dispatch(job_id)
        try:
            await self._postgres.dispatch(job_id)
        except Exception as e:
            # Postgres failure is non-fatal during migration — Redis is primary
            logger.warning(
                "DualDispatcher: Postgres NOTIFY failed for job %s (non-fatal): %s",
                job_id, e,
            )
