"""Redis Stream wiring for the stats service.

Reuses the singleton async Redis client from the aggregation module
(``backend.app.services.aggregation.redis_client``) — one connection
pool per process regardless of how many headless services share it.
Stream/group names are local constants; the consumer-group helper is
parameterised here so we don't touch aggregation code.
"""
from __future__ import annotations

import logging

import redis.asyncio as aioredis

from backend.app.services.aggregation.redis_client import get_redis

logger = logging.getLogger(__name__)


JOBS_STREAM = "stats.jobs"
DLQ_STREAM = "stats.dlq"
CONSUMER_GROUP = "stats-workers"

# Trim acknowledged entries so the stream does not grow unbounded.
# Results live in Postgres; the stream entry is just a wake-up signal.
STREAM_MAXLEN = 10_000


async def ensure_consumer_group() -> None:
    """Create the stats-workers consumer group idempotently."""
    redis = get_redis()
    try:
        await redis.xgroup_create(JOBS_STREAM, CONSUMER_GROUP, id="0", mkstream=True)
        logger.info("Created consumer group '%s' on stream '%s'", CONSUMER_GROUP, JOBS_STREAM)
    except aioredis.ResponseError as exc:
        if "BUSYGROUP" in str(exc):
            logger.debug("Consumer group '%s' already exists", CONSUMER_GROUP)
            return
        raise


def dedup_key(ds_id: str) -> str:
    return f"stats:pending:{ds_id}"


async def try_claim(ds_id: str, ttl_secs: int) -> bool:
    """Atomic set-if-not-exists with TTL. True → caller owns the slot."""
    redis = get_redis()
    return bool(await redis.set(dedup_key(ds_id), "1", nx=True, ex=ttl_secs))


async def release_claim(ds_id: str) -> None:
    redis = get_redis()
    await redis.delete(dedup_key(ds_id))


async def enqueue(fields: dict[str, str]) -> str:
    """XADD a job envelope. Returns the stream message ID."""
    redis = get_redis()
    return await redis.xadd(JOBS_STREAM, fields, maxlen=STREAM_MAXLEN, approximate=True)


async def send_to_dlq(msg_id: str, fields: dict[str, str], reason: str) -> None:
    redis = get_redis()
    payload = {**fields, "original_msg_id": msg_id, "reason": reason}
    await redis.xadd(DLQ_STREAM, payload, maxlen=5_000, approximate=True)
