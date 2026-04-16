"""
Aggregation event publisher and consumer.

Uses Redis Pub/Sub for real-time status propagation:
  - Workers publish: job.started, job.progress, job.completed, job.failed
  - Control Plane publishes: job.pending, job.cancelled, state.updated
  - Viz-service subscribes: syncs workspace_data_sources.aggregation_status

Event structure:
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
