"""Redis messaging for the versioning projection worker.

A wake-up signal ONLY — ``ProjectionStateORM`` (Postgres) is the durable queue.
The projector's poll loop is the correctness backstop; the stream just lowers
projection latency after a publish/merge. Shares the broker Redis (``REDIS_URL``,
same instance the aggregation worker uses for dispatch).
"""
from __future__ import annotations

import logging
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

PROJECTION_STREAM = "versioning.projection"
CONSUMER_GROUP = "versioning-projectors"

_client: Optional[aioredis.Redis] = None


def get_broker_redis() -> aioredis.Redis:
    """Singleton async Redis client for the projection wake-up stream.

    Built by ``build_bus_redis`` — the SAME builder the aggregation/insights bus
    uses — so topology (single node or Sentinel), auth and TLS are resolved from the
    same env vars for every bus consumer. This used to call ``from_url(REDIS_URL)``
    directly, which ignored ``REDIS_PASSWORD``, the ``REDIS_TLS_*`` settings and
    ``REDIS_SENTINEL_*``: the day the coordination bus gained auth/TLS or moved
    behind Sentinel, every other consumer would have followed and this one client
    alone would have started failing — costing the projector its wake-up signal (the
    Postgres queue + 5s poll loop remain the correctness backstop, so the price is
    latency and error noise, not data loss — but it is an avoidable landmine).
    """
    global _client
    if _client is None:
        from backend.common.adapters.redis_bus import build_bus_redis

        _client = build_bus_redis(
            decode_responses=True,
            max_connections=10,
            socket_connect_timeout=5,
            socket_timeout=10,
        )
    return _client


async def close_broker_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def ensure_consumer_group() -> None:
    """Create the consumer group if absent (idempotent)."""
    try:
        await get_broker_redis().xgroup_create(
            PROJECTION_STREAM, CONSUMER_GROUP, id="0", mkstream=True,
        )
    except aioredis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


async def nudge_projection(graph_id: str) -> None:
    """Best-effort wake-up after a publish/merge. **Never raises** — if the broker
    is down, the projector's poll loop still catches the lagging graph up."""
    try:
        await get_broker_redis().xadd(PROJECTION_STREAM, {"graph_id": graph_id})
    except Exception as exc:   # pragma: no cover - infra
        logger.warning("projection nudge for %s failed (poll loop will catch up): %s", graph_id, exc)
