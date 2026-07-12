"""
Aggregation event publisher (cross-service state-sync path).

Appends cross-service status events to the Redis Stream
``aggregation.events.stream``. The single consumer is
``backend/app/services/aggregation/event_listener.py`` (hosted in the
Control Plane), which mirrors state into
``workspace_data_sources.aggregation_status`` so the viz-service has
fresh data for its own endpoints.

Co-existence with the Job Platform. ``backend/app/jobs/`` delivers
events via ``JobBroker`` (Redis Streams) for SSE clients. The two
paths are intentionally independent:

* **This file** — a single Redis Stream + consumer group, one logical
  consumer, used for cross-service state sync. ``event_listener.py``
  consumes here via ``XREADGROUP`` (each event to exactly one consumer
  across the fleet — the reason it moved off Pub/Sub, which fanned every
  event out to every web replica).
* **JobBroker** — Redis Streams, per-job + per-tenant fan-out,
  replay-able, used for live SSE delivery.

The aggregation worker calls both in parallel on terminal events:
``self._events.job_completed(...)`` writes here (for the state-sync
consumer), ``await emitter.terminal(...)`` writes to the broker (for
SSE). There's no double-counting because the consumer sets are disjoint.

Why a separate stream from the JobBroker. State-sync needs exactly-once
delivery (one write per event across the fleet); the JobBroker fans every
event out to every SSE subscriber. A dedicated stream + consumer group is
the simpler seam than a consumer-group read against a fan-out stream.

Event structure (unchanged from before):
    {
        "type": "job.completed",
        "payload": {
            "job_id": "agg_abc123",
            "data_source_id": "ds_xyz",
            "status": "ready",
            ...
        },
        "ts": "2026-04-16T12:00:00+00:00"
    }
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, Callable, Optional

logger = logging.getLogger(__name__)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class AggregationEventPublisher:
    """Publishes aggregation status events to the Redis events stream."""

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    async def publish(self, event_type: str, payload: dict) -> None:
        """Append a status event to the aggregation events stream."""
        from .redis_client import EVENTS_STREAM, EVENTS_STREAM_MAXLEN

        message = json.dumps({
            "type": event_type,
            "payload": payload,
            "ts": _now(),
        })
        try:
            await self._redis.xadd(
                EVENTS_STREAM, {"data": message},
                maxlen=EVENTS_STREAM_MAXLEN, approximate=True,
            )
            logger.debug("Published event %s: %s", event_type, payload.get("job_id", ""))
        except Exception as e:
            # Stream-append failures are non-fatal — the DB is the source of
            # truth. The viz-service can poll the Control Plane API as a
            # fallback.
            logger.warning("Failed to publish event %s: %s", event_type, e)

    # ── Convenience methods for common events ────────────────────────

    async def job_pending(self, job_id: str, data_source_id: str) -> None:
        await self.publish("job.pending", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            "status": "pending",
        })

    async def job_started(self, job_id: str, data_source_id: str) -> None:
        await self.publish("job.started", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            "status": "running",
        })

    async def job_progress(
        self,
        job_id: str,
        data_source_id: str,
        progress: int,
        processed_edges: int,
        total_edges: int,
    ) -> None:
        await self.publish("job.progress", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            "progress": progress,
            "processed_edges": processed_edges,
            "total_edges": total_edges,
        })

    async def job_completed(
        self,
        job_id: str,
        data_source_id: str,
        edge_count: int,
        fingerprint: Optional[str],
        completed_at: str,
        workspace_id: Optional[str] = None,
    ) -> None:
        await self.publish("job.completed", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            # Scopes the listener's graph-cache invalidation (the cache
            # keys are workspace-scoped).
            "workspace_id": workspace_id,
            "status": "ready",
            "edge_count": edge_count,
            "fingerprint": fingerprint,
            "completed_at": completed_at,
        })

    async def job_failed(
        self,
        job_id: str,
        data_source_id: str,
        error_message: Optional[str] = None,
    ) -> None:
        await self.publish("job.failed", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            "status": "failed",
            "error_message": error_message,
        })

    async def job_cancelled(self, job_id: str, data_source_id: str) -> None:
        await self.publish("job.cancelled", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            "status": "cancelled",
        })

    async def purge_completed(
        self,
        job_id: str,
        data_source_id: str,
        workspace_id: Optional[str],
        deleted_edges: int,
    ) -> None:
        """A purge rewrote the :AGGREGATED layer — listeners must sync
        status AND invalidate the aggregated read caches, exactly like a
        completed aggregation run (a purge is the same event with the
        opposite sign)."""
        await self.publish("purge.completed", {
            "job_id": job_id,
            "data_source_id": data_source_id,
            "workspace_id": workspace_id,
            "status": "none",
            "deleted_edges": deleted_edges,
        })

    async def state_updated(
        self,
        data_source_id: str,
        aggregation_status: str,
        **extra: Any,
    ) -> None:
        await self.publish("state.updated", {
            "data_source_id": data_source_id,
            "aggregation_status": aggregation_status,
            **extra,
        })
