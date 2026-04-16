"""
Dispatcher protocol + concrete implementations for aggregation jobs.

The Dispatcher is the ONLY seam that changes when migrating from
in-process (asyncio) to standalone-process (Postgres NOTIFY) to
message-queue-based (Redis Streams) deployment.

    dev / single-process:  InProcessDispatcher  → asyncio.create_task()
    standalone worker:     PostgresDispatcher    → NOTIFY aggregation_jobs
    future (K8s scale):    RedisStreamDispatcher → XADD aggregation.jobs
"""
import asyncio
import logging
from typing import TYPE_CHECKING, Any, Protocol

from sqlalchemy import text

if TYPE_CHECKING:
    from .worker import AggregationWorker

logger = logging.getLogger(__name__)


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


# Future (K8s scale):
# class RedisStreamDispatcher:
#     """Publishes job_id to a Redis Stream — consumed by worker pods."""
#     def __init__(self, redis_client):
#         self._redis = redis_client
#     async def dispatch(self, job_id: str) -> None:
#         await self._redis.xadd("aggregation.jobs", {"job_id": job_id}, maxlen=10000)
