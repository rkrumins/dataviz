"""
Aggregation event listener for the viz-service.

Subscribes to Redis Pub/Sub channel ``aggregation.events`` and syncs
aggregation state changes into ``public.workspace_data_sources``.

This runs as a background asyncio task in the viz-service lifespan.
When the Control Plane or Workers publish status events (job.completed,
job.failed, state.updated, etc.), this listener updates the local
``workspace_data_sources`` table so the viz-service has fresh data
for its own endpoints (e.g. workspace detail, onboarding wizard).

Fallback: if the listener was down and missed events, the viz-service
can poll the Control Plane's readiness endpoint on demand.
"""
import asyncio
import json
import logging
from typing import Any

logger = logging.getLogger(__name__)


class AggregationEventListener:
    """Subscribes to aggregation events and syncs viz-service state."""

    def __init__(self, redis_client: Any, session_factory: Any) -> None:
        self._redis = redis_client
        self._session_factory = session_factory
        self._running = False
        self._pubsub = None

    async def start(self) -> None:
        """Subscribe and process events until stopped. Auto-reconnects."""
        from .redis_client import EVENTS_CHANNEL

        self._running = True
        logger.info("Aggregation event listener starting on channel '%s'", EVENTS_CHANNEL)

        import os
        _SUBSCRIBE_TIMEOUT = float(os.getenv("EVENT_LISTENER_TIMEOUT", "10"))

        while self._running:
            try:
                self._pubsub = self._redis.pubsub()
                await asyncio.wait_for(
                    self._pubsub.subscribe(EVENTS_CHANNEL),
                    timeout=_SUBSCRIBE_TIMEOUT,
                )
                logger.info("Subscribed to '%s'", EVENTS_CHANNEL)

                # Poll-based listen with timeout instead of blocking
                # `async for` iterator. Prevents silent hang if Redis
                # goes down without raising an exception.
                while self._running:
                    message = await asyncio.wait_for(
                        self._pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=1.0,
                        ),
                        timeout=_SUBSCRIBE_TIMEOUT,
                    )
                    if message is None:
                        continue
                    if message["type"] != "message":
                        continue

                    try:
                        event = json.loads(message["data"])
                        await self._handle_event(event)
                    except json.JSONDecodeError:
                        logger.warning("Invalid JSON in event: %s", message["data"][:200])
                    except Exception as e:
                        logger.error("Event handler error: %s", e, exc_info=True)

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Event listener connection lost: %s (reconnecting in 5s)", e)
                await asyncio.sleep(5)
            finally:
                if self._pubsub:
                    try:
                        await self._pubsub.unsubscribe()
                        await self._pubsub.aclose()
                    except Exception:
                        pass
                    self._pubsub = None

    async def stop(self) -> None:
        """Signal the listener to stop."""
        self._running = False
        if self._pubsub:
            try:
                await self._pubsub.unsubscribe()
            except Exception:
                pass

    async def _handle_event(self, event: dict) -> None:
        """Dispatch event to the appropriate handler."""
        event_type = event.get("type", "")
        payload = event.get("payload", {})
        data_source_id = payload.get("data_source_id")

        if not data_source_id:
            return

        match event_type:
            case "job.completed":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="ready",
                    last_aggregated_at=payload.get("completed_at"),
                    aggregation_edge_count=payload.get("edge_count"),
                    graph_fingerprint=payload.get("fingerprint"),
                )
            case "job.failed":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="failed",
                )
            case "job.pending":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="pending",
                )
            case "job.started":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="running",
                )
            case "job.cancelled":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="none",
                )
            case "state.updated":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status=payload.get("aggregation_status"),
                    last_aggregated_at=payload.get("last_aggregated_at"),
                    aggregation_edge_count=payload.get("aggregation_edge_count"),
                    graph_fingerprint=payload.get("graph_fingerprint"),
                    aggregation_schedule=payload.get("aggregation_schedule"),
                )

    async def _sync_data_source(self, data_source_id: str, **fields: Any) -> None:
        """Update workspace_data_sources with the given fields.

        Only updates fields that are not None — partial updates are safe.
        """
        try:
            async with self._session_factory() as session:
                from backend.app.db.models import WorkspaceDataSourceORM
                ds = await session.get(WorkspaceDataSourceORM, data_source_id)
                if ds is None:
                    logger.debug("Data source %s not found — skipping sync", data_source_id)
                    return

                for field, value in fields.items():
                    if value is not None and hasattr(ds, field):
                        setattr(ds, field, value)

                await session.commit()
                logger.debug(
                    "Synced data source %s: %s",
                    data_source_id,
                    {k: v for k, v in fields.items() if v is not None},
                )
        except Exception as e:
            logger.warning("Failed to sync data source %s: %s", data_source_id, e)
