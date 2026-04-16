"""
Redis connection factory for aggregation service messaging.

Provides a singleton async Redis client used by:
- RedisStreamDispatcher (Control Plane): XADD to dispatch jobs
- Worker consumer (__main__.py): XREADGROUP to consume jobs
- AggregationEventPublisher: PUBLISH status events
- Event listeners: SUBSCRIBE to status events

Separate from FalkorDB's Redis — this connects to a dedicated Redis 7
instance used exclusively for job dispatch and event propagation.

Configuration:
    REDIS_URL   Redis connection string (default: redis://localhost:6380/0)
"""
import logging
import os
from typing import Optional

import redis.asyncio as aioredis

logger = logging.getLogger(__name__)

# ── Stream / channel constants ──────────────────────────────────────

JOBS_STREAM = "aggregation.jobs"
"""Redis Stream for job dispatch. Each entry contains {job_id, dispatched_at}.
The job row in Postgres is the source of truth; the stream is a wake-up signal."""

CONSUMER_GROUP = "aggregation-workers"
"""Consumer group name. All worker replicas join this group.
Redis distributes messages across consumers automatically."""

DLQ_STREAM = "aggregation.jobs.dlq"
"""Dead letter queue. Messages that fail delivery > MAX_DELIVERY_ATTEMPTS
are moved here for manual inspection / alerting."""

EVENTS_CHANNEL = "aggregation.events"
"""Redis Pub/Sub channel for aggregation status events.
Workers publish job.started / job.progress / job.completed / job.failed.
Control Plane and viz-service subscribe."""

MAX_DELIVERY_ATTEMPTS = 5
"""After this many failed delivery attempts (tracked by Redis PEL),
the message is moved to the DLQ."""

# ── Singleton client ────────────────────────────────────────────────

_client: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    """Return the singleton async Redis client.

    Lazily initialized on first call. The client uses a connection pool
    internally — safe to share across coroutines.
    """
    global _client
    if _client is None:
        url = os.getenv("REDIS_URL", "redis://localhost:6380/0")
        _client = aioredis.from_url(
            url,
            decode_responses=True,
            max_connections=20,
            socket_connect_timeout=5,
            socket_timeout=10,
            retry_on_timeout=True,
        )
        logger.info("Redis client initialized: %s", url)
    return _client


async def close_redis() -> None:
    """Close the Redis connection pool. Call during shutdown."""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        logger.info("Redis client closed")


async def ensure_consumer_group() -> None:
    """Create the consumer group if it doesn't exist.

    Idempotent — safe to call on every worker startup. Uses id='0'
    so new consumers start reading from the beginning of undelivered
    messages (entries not yet read by the group).
    """
    client = get_redis()
    try:
        await client.xgroup_create(
            JOBS_STREAM, CONSUMER_GROUP, id="0", mkstream=True,
        )
        logger.info(
            "Created consumer group '%s' on stream '%s'",
            CONSUMER_GROUP, JOBS_STREAM,
        )
    except aioredis.ResponseError as e:
        if "BUSYGROUP" in str(e):
            logger.debug("Consumer group '%s' already exists", CONSUMER_GROUP)
        else:
            raise
