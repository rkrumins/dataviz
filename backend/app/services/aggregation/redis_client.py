"""
Redis connection factory for aggregation service messaging.

Provides a singleton async Redis client used by:
- RedisStreamDispatcher (Control Plane): XADD to dispatch jobs
- Worker consumer (__main__.py): XREADGROUP to consume jobs
- AggregationEventPublisher: XADD status events to the events stream
- State-sync consumer (event_listener.py): XREADGROUP status events

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

EVENTS_STREAM = "aggregation.events.stream"
"""Redis Stream for aggregation status events (the workspace_data_sources
state-sync fast path). Replaces the former ``aggregation.events`` Pub/Sub
channel: a stream + consumer group hands each event to exactly ONE consumer
across the fleet. Pub/Sub fanned every event out to every subscriber, so the
N viz-service (web) replicas each re-applied the same workspace_data_sources
write and contended on the row. The sole consumer is now the aggregation
Control Plane's state-sync loop; the web tier is stateless and no longer
subscribes."""

STATE_SYNC_GROUP = "viz-state-sync"
"""Consumer group for the workspace_data_sources projection. Every Control
Plane replica joins it; Redis hands each event to exactly one consumer, so
scaling the control plane no longer multiplies the projection write."""

EVENTS_STREAM_MAXLEN = int(os.getenv("AGG_EVENTS_STREAM_MAXLEN", "10000"))
"""Approximate cap on the events stream (``XADD ... MAXLEN ~``). Status
events are a fast-path hint backstopped by the control-plane readiness
endpoint (the authoritative source), so trimming old entries is safe."""

MAX_DELIVERY_ATTEMPTS = 5
"""After this many failed delivery attempts (tracked by Redis PEL),
the message is moved to the DLQ."""

# ── Single-active execution lock + durable cancel flag ──────────────

EXEC_LOCK_TTL_MS = int(os.getenv("AGG_EXEC_LOCK_TTL_MS", "90000"))
"""Per-job execution lock TTL (ms). The holder renews it every ~TTL/3 while
running; if the holder dies, the lock expires after at most this long and the
reconciler re-dispatches the job to resume from its last checkpoint. This is
the single source of truth for "is a runner alive for this job?" — it makes
XAUTOCLAIM reclaims, duplicate dispatch, restarts and replicas all safe."""

CANCEL_FLAG_TTL_SECS = int(os.getenv("AGG_CANCEL_FLAG_TTL_SECS", "3600"))
"""Durable cancel flag TTL (s). Set by the cancel endpoint so a job that is
reclaimed/redispatched AFTER a cancel never resumes."""


def exec_lock_key(job_id: str) -> str:
    """Redis key for the per-job single-active execution lock."""
    return f"agg:exec:{job_id}"


def cancel_flag_key(job_id: str) -> str:
    """Redis key for the durable cancel flag."""
    return f"agg:cancel:{job_id}"

# ── Singleton client ────────────────────────────────────────────────

_client: Optional[aioredis.Redis] = None


def get_redis() -> aioredis.Redis:
    """Return the singleton async Redis client.

    Lazily initialized on first call. The client uses a connection pool
    internally — safe to share across coroutines. Topology (single node or
    Sentinel) + auth + TLS are resolved from env by ``build_bus_redis``;
    Redis Cluster is intentionally unsupported for the bus (it raises a clear
    error). The aggregation control-plane/worker AND the insights service share
    this singleton, so both inherit Sentinel/TLS identically.
    """
    global _client
    if _client is None:
        from backend.common.adapters.redis_bus import build_bus_redis

        _client = build_bus_redis(
            decode_responses=True,
            max_connections=20,
            socket_connect_timeout=5,
            socket_timeout=10,
        )
        logger.info("Redis client initialized")
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


async def ensure_state_sync_group() -> None:
    """Create the workspace_data_sources state-sync consumer group if it
    doesn't exist. Idempotent — safe on every control-plane startup.

    id='0' so a freshly-created group still receives events that were
    XADDed just before this consumer first joined (no lost first-sync —
    the failure mode that a Pub/Sub subscriber, which drops anything sent
    while it was down, is prone to)."""
    client = get_redis()
    try:
        await client.xgroup_create(
            EVENTS_STREAM, STATE_SYNC_GROUP, id="0", mkstream=True,
        )
        logger.info(
            "Created consumer group '%s' on stream '%s'",
            STATE_SYNC_GROUP, EVENTS_STREAM,
        )
    except aioredis.ResponseError as e:
        if "BUSYGROUP" in str(e):
            logger.debug("Consumer group '%s' already exists", STATE_SYNC_GROUP)
        else:
            raise
