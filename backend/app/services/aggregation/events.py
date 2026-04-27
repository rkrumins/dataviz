"""
Aggregation event publisher (legacy cross-service sync path).

Uses Redis Pub/Sub channel ``aggregation.events`` for cross-service
status propagation. The single consumer is
``backend/app/services/aggregation/event_listener.py``, which mirrors
state into ``workspace_data_sources.aggregation_status`` so the viz-
service has fresh data for its own endpoints.

Co-existence with the new platform. Phase 1 introduced the Job
Platform (``backend/app/jobs/``) which delivers events via
``JobBroker`` (Redis Streams) for SSE clients. The two paths are
intentionally independent:

* **This file (legacy)** — Redis Pub/Sub, single channel, single
  consumer, used for cross-service state sync. ``event_listener.py``
  subscribes here.
* **JobBroker (new)** — Redis Streams, per-job + per-tenant
  fan-out, replay-able, used for live SSE delivery.

The aggregation worker calls both in parallel on terminal events:
``self._events.job_completed(...)`` writes here (for the listener),
``await emitter.terminal(...)`` writes to the broker (for SSE).
There's no double-counting because the consumer sets are disjoint.

When this file retires. Phase 4 cleanup will migrate
``event_listener.py`` to consume from the broker directly (via
``JobEventConsumer``); at that point the Pub/Sub channel can retire
and this class deletes. Until then it stays as-is — refactoring
``AggregationEventPublisher`` to delegate through ``JobEmitter``
without breaking the listener requires a dual-write knob inside
``JobEmitter`` that pollutes the broker abstraction with a
legacy-channel name. Not worth it for Phase 1.

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
    """Publishes aggregation status events to Redis Pub/Sub."""

    def __init__(self, redis_client: Any) -> None:
        self._redis = redis_client

    async def publish(self, event_type: str, payload: dict) -> None:
        """Publish an event to the aggregation events channel."""
        from .redis_client import EVENTS_CHANNEL

        message = json.dumps({
            "type": event_type,
            "payload": payload,
            "ts": _now(),
        })
        try:
            await self._redis.publish(EVENTS_CHANNEL, message)
            logger.debug("Published event %s: %s", event_type, payload.get("job_id", ""))
        except Exception as e:
            # Pub/sub failures are non-fatal — the DB is the source of truth.
            # The viz-service can poll the Control Plane API as a fallback.
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
    ) -> None:
        await self.publish("job.completed", {
            "job_id": job_id,
            "data_source_id": data_source_id,
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
