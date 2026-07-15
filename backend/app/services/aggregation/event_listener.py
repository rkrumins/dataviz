"""
Aggregation state-sync consumer.

Consumes the Redis Stream ``aggregation.events.stream`` via the
``viz-state-sync`` consumer group and syncs aggregation state changes
into ``public.workspace_data_sources``.

Hosted in the Control Plane (NOT the viz-service web tier). The former
design ran this as a Redis Pub/Sub subscriber inside every web replica,
so N replicas each received every event and independently re-applied the
same ``workspace_data_sources`` write, contending on the row. A stream +
consumer group delivers each event to exactly ONE consumer across the
fleet; the web tier is now stateless.

Delivery semantics. ``XREADGROUP`` is at-least-once: a consumer that
crashes after handling an event but before ``XACK`` will see it
redelivered (reclaimed from the group's Pending Entry List by
``XAUTOCLAIM`` on restart). Every handler here is idempotent — a repeated
``UPDATE ... aggregation_status='ready'`` or cache invalidation is a
no-op — so redelivery is safe.

Correctness backstop. ``workspace_data_sources.aggregation_status`` is a
denormalized HINT; the authoritative source is the control-plane readiness
endpoint (``aggregation_data_source_state`` / ``aggregation_jobs``). If a
rare cross-consumer reorder leaves a briefly-stale hint, an on-demand
readiness read reconciles it.
"""
import asyncio
import json
import logging
import os
import platform
from typing import Any

logger = logging.getLogger(__name__)


class AggregationEventListener:
    """Consumes aggregation status events and syncs the local state row."""

    def __init__(self, redis_client: Any, session_factory: Any) -> None:
        self._redis = redis_client
        self._session_factory = session_factory
        self._running = False
        self._consumer_name = f"statesync-{platform.node()}-{os.getpid()}"

    async def start(self) -> None:
        """Consume status events via the consumer group until stopped."""
        from .redis_client import (
            EVENTS_STREAM, STATE_SYNC_GROUP, ensure_state_sync_group,
        )

        self._running = True
        await ensure_state_sync_group()
        logger.info(
            "Aggregation state-sync consumer started "
            "(stream='%s', group='%s', consumer='%s')",
            EVENTS_STREAM, STATE_SYNC_GROUP, self._consumer_name,
        )

        # Reclaim events delivered to a consumer that crashed before ACK.
        await self._recover_pending()

        while self._running:
            try:
                entries = await self._redis.xreadgroup(
                    STATE_SYNC_GROUP,
                    self._consumer_name,
                    {EVENTS_STREAM: ">"},
                    count=64,
                    block=5000,
                )
            except asyncio.CancelledError:
                break
            except Exception as e:
                # Auth-class errors (rotated/wrong bus password) log an
                # actionable line and back off long; blips keep the 2s retry.
                from backend.common.adapters.redis_bus import bus_error_retry_delay
                await asyncio.sleep(
                    bus_error_retry_delay(e, logger, what="state-sync XREADGROUP")
                )
                continue

            if not entries:
                continue

            # entries = [(stream_name, [(msg_id, {field: value}), ...])]
            for _stream_name, messages in entries:
                for msg_id, fields in messages:
                    await self._process(msg_id, fields)

    async def _recover_pending(self) -> None:
        """Reclaim events idle > 60s in the group's Pending Entry List —
        delivered to a consumer that died before ``XACK``. Idempotent
        handlers make reprocessing safe."""
        from .redis_client import EVENTS_STREAM, STATE_SYNC_GROUP

        try:
            result = await self._redis.xautoclaim(
                EVENTS_STREAM, STATE_SYNC_GROUP, self._consumer_name,
                min_idle_time=60000, start_id="0-0", count=128,
            )
        except Exception as e:
            logger.warning("state-sync PEL recovery failed: %s", e)
            return
        if not result or len(result) < 2:
            return
        claimed = result[1] or []
        if claimed:
            logger.info(
                "state-sync PEL recovery: reprocessing %d event(s)",
                len(claimed),
            )
        for msg_id, fields in claimed:
            await self._process(msg_id, fields)

    async def _process(self, msg_id: Any, fields: dict) -> None:
        """Handle one stream entry, then ACK it. ACK happens even on a
        handler error: the handlers swallow their own exceptions (the DB /
        readiness backstop reconciles), so a poison message must never
        wedge the group by lingering in the PEL forever."""
        from .redis_client import EVENTS_STREAM, STATE_SYNC_GROUP

        try:
            raw = (fields or {}).get("data")
            if raw:
                await self._handle_event(json.loads(raw))
        except json.JSONDecodeError:
            logger.warning(
                "Invalid JSON in event %s: %s", msg_id, str(fields)[:200],
            )
        except Exception as e:
            logger.error(
                "Event handler error (%s): %s", msg_id, e, exc_info=True,
            )
        finally:
            try:
                await self._redis.xack(EVENTS_STREAM, STATE_SYNC_GROUP, msg_id)
            except Exception as e:
                logger.warning("state-sync XACK failed for %s: %s", msg_id, e)

    async def stop(self) -> None:
        """Signal the consumer loop to stop after its current iteration."""
        self._running = False

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
                await self._invalidate_aggregated_cache(
                    payload.get("workspace_id"), data_source_id,
                )
            case "purge.completed":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="none",
                    aggregation_edge_count=0,
                )
                await self._invalidate_aggregated_cache(
                    payload.get("workspace_id"), data_source_id,
                )
            case "job.failed":
                await self._sync_data_source(
                    data_source_id,
                    aggregation_status="failed",
                )
                # A failed run may have PARTIALLY written before dying —
                # cached pre-run answers no longer match the store.
                await self._invalidate_aggregated_cache(
                    payload.get("workspace_id"), data_source_id,
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
                await self._invalidate_aggregated_cache(
                    payload.get("workspace_id"), data_source_id,
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

    async def _invalidate_aggregated_cache(
        self, workspace_id: Any, data_source_id: str,
    ) -> None:
        """Any event that rewrote the :AGGREGATED layer (run completed,
        purge, failed/cancelled mid-write) invalidates the aggregated
        read caches through the shared choke point. Events from workers
        that predate the workspace_id field skip silently (the cache
        keys are workspace-scoped, so the scope can't be built without
        it)."""
        if not workspace_id:
            logger.debug(
                "aggregation event for %s carried no workspace_id — "
                "skipping aggregated-cache invalidation", data_source_id,
            )
            return
        try:
            from backend.app.services.graph_cache import invalidate_aggregated_reads
            await invalidate_aggregated_reads(str(workspace_id), data_source_id)
        except Exception as e:
            logger.warning(
                "Aggregated-edge cache invalidation failed for %s: %s",
                data_source_id, e,
            )

    async def _sync_data_source(self, data_source_id: str, **fields: Any) -> None:
        """Update workspace_data_sources with the given fields.

        Only updates fields that are not None — partial updates are safe.
        """
        try:
            async with self._session_factory() as session:
                from backend.app.db.models import WorkspaceDataSourceORM
                ds = await session.get(WorkspaceDataSourceORM, data_source_id)
                if ds is None or ds.deleted_at is not None:
                    logger.debug(
                        "Data source %s not found or deleted — skipping sync", data_source_id
                    )
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
