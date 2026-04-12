"""
Dispatcher protocol + InProcessDispatcher for aggregation jobs.

The Dispatcher is the ONLY seam that changes when migrating from
in-process (asyncio) to message-queue-based (K8s) deployment.

Current:  AggregationService → InProcessDispatcher → asyncio.create_task()
Future:   AggregationService → MessageQueueDispatcher → broker.publish()
"""
import asyncio
import logging
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from .worker import AggregationWorker

logger = logging.getLogger(__name__)


class AggregationDispatcher(Protocol):
    """Single-parameter dispatch — all job data lives on the DB record."""

    async def dispatch(self, job_id: str) -> None: ...


class InProcessDispatcher:
    """Runs worker in-process via asyncio with full task lifecycle management.

    Key guarantees (CRIT-3):
    - Tasks are stored in _active_tasks to prevent GC collection
    - done_callback logs unhandled exceptions (safety net)
    - Worker's run() handles DB status updates; this is the last-resort guard
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


# Future (K8s):
# class MessageQueueDispatcher:
#     """Publishes job_id to a message broker — consumed by standalone worker pod."""
#     def __init__(self, broker):
#         self._broker = broker
#     async def dispatch(self, job_id: str) -> None:
#         await self._broker.publish("aggregation.jobs", {"jobId": job_id})
