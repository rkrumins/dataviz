"""Redis Streams wiring for the insights service.

The service consumes from multiple streams — one per job kind:

* ``insights.jobs.stats``     — post-registration data-source polling
* ``insights.jobs.discovery`` — pre-registration asset list / per-asset stats
* ``insights.jobs.schema``    — explicit schema cache priming

Each stream has its own consumer group so a worker can XREADGROUP from
all of them in parallel and process each independently. A single DLQ
(``insights.dlq``) collects exhausted messages from any source — the
DLQ entry carries ``kind`` and ``original_stream`` so an operator can
route a redrive back to the right place.

Reuses the singleton async Redis client from
``backend.app.services.aggregation.redis_client`` — one connection
pool per process regardless of how many headless services share it.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass

import redis.asyncio as aioredis

from backend.app.services.aggregation.redis_client import get_redis

logger = logging.getLogger(__name__)


# ── Stream catalog ───────────────────────────────────────────────────

@dataclass(frozen=True)
class StreamConfig:
    """Identity of one Redis Stream + its consumer group + dedup namespace."""
    kind: str            # 'stats_poll' | 'discovery' | 'purge'
    stream: str          # Redis stream key
    group: str           # XREADGROUP consumer group
    dedup_prefix: str    # SET NX key prefix for the producer-side claim


# All streams use one consumer group so a single XREADGROUP call can
# multiplex across them. The per-stream PEL is still tracked
# independently by Redis under the same group name.
SHARED_GROUP = "insights-workers"

STATS_STREAM = StreamConfig(
    kind="stats_poll",
    stream="insights.jobs.stats",
    group=SHARED_GROUP,
    dedup_prefix="insights:stats",
)

DISCOVERY_STREAM = StreamConfig(
    kind="discovery",
    stream="insights.jobs.discovery",
    group=SHARED_GROUP,
    dedup_prefix="insights:discovery",
)

# Purge gets its own stream so the worker's per-graph semaphore + size-
# bucketed timeouts apply uniformly. The dedup prefix is keyed on the
# data_source_id so two purge requests for the same source coalesce.
PURGE_STREAM = StreamConfig(
    kind="purge",
    stream="insights.jobs.purge",
    group=SHARED_GROUP,
    dedup_prefix="insights:purge",
)

ALL_STREAMS: tuple[StreamConfig, ...] = (STATS_STREAM, DISCOVERY_STREAM, PURGE_STREAM)

_BY_KIND: dict[str, StreamConfig] = {s.kind: s for s in ALL_STREAMS}

DLQ_STREAM = "insights.dlq"

# Trim acknowledged entries so streams do not grow unbounded.
# Results live in Postgres; the stream entry is just a wake-up signal.
STREAM_MAXLEN = 10_000
DLQ_MAXLEN = 5_000


# ── Backwards-compat shims for legacy stats-only callers ─────────────
# Keep these so the existing worker.py / scheduler.py code continues to
# work without simultaneous edits. They alias to the stats stream
# specifically — anything new should use the StreamConfig API.

JOBS_STREAM = STATS_STREAM.stream
CONSUMER_GROUP = STATS_STREAM.group


def get_stream(kind: str) -> StreamConfig:
    try:
        return _BY_KIND[kind]
    except KeyError as exc:
        raise ValueError(f"Unknown insights job kind: {kind!r}") from exc


# ── Consumer-group lifecycle ─────────────────────────────────────────

async def ensure_consumer_group(stream: StreamConfig | None = None) -> None:
    """Create the consumer group for one stream — or all of them — idempotently.

    Called once at process start by ``__main__.py``. Safe to re-invoke;
    BUSYGROUP errors are swallowed.
    """
    redis = get_redis()
    targets: tuple[StreamConfig, ...] = (stream,) if stream else ALL_STREAMS
    for cfg in targets:
        try:
            await redis.xgroup_create(cfg.stream, cfg.group, id="0", mkstream=True)
            logger.info(
                "Created consumer group %r on stream %r", cfg.group, cfg.stream
            )
        except aioredis.ResponseError as exc:
            if "BUSYGROUP" in str(exc):
                logger.debug("Consumer group %r already exists", cfg.group)
                continue
            raise


# ── Per-job dedup claim (SET NX + TTL) ───────────────────────────────

def _dedup_key(cfg: StreamConfig, scope_key: str) -> str:
    return f"{cfg.dedup_prefix}:pending:{scope_key}"


# Legacy single-arg helper — keyed implicitly on the stats stream.
def dedup_key(scope_key: str) -> str:
    return _dedup_key(STATS_STREAM, scope_key)


async def try_claim(scope_key: str, ttl_secs: int, *, stream: StreamConfig = STATS_STREAM) -> bool:
    """Atomic set-if-not-exists with TTL. True → caller owns the slot."""
    redis = get_redis()
    return bool(await redis.set(_dedup_key(stream, scope_key), "1", nx=True, ex=ttl_secs))


async def release_claim(scope_key: str, *, stream: StreamConfig = STATS_STREAM) -> None:
    redis = get_redis()
    await redis.delete(_dedup_key(stream, scope_key))


# ── Producer side: XADD ──────────────────────────────────────────────

async def enqueue(fields: dict[str, str], *, stream: StreamConfig = STATS_STREAM) -> str:
    """XADD a job envelope. Returns the stream message ID."""
    redis = get_redis()
    return await redis.xadd(
        stream.stream, fields, maxlen=STREAM_MAXLEN, approximate=True
    )


async def send_to_dlq(
    msg_id: str,
    fields: dict[str, str],
    reason: str,
    *,
    stream: StreamConfig = STATS_STREAM,
) -> None:
    """Forward a message that has exhausted its retries to the shared DLQ.

    The DLQ entry includes ``original_stream`` and ``kind`` so an
    operator's redrive script can route the redrive back to the source.
    """
    redis = get_redis()
    payload = {
        **fields,
        "original_msg_id": msg_id,
        "original_stream": stream.stream,
        "kind": stream.kind,
        "reason": reason,
    }
    await redis.xadd(DLQ_STREAM, payload, maxlen=DLQ_MAXLEN, approximate=True)
