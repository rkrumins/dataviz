"""Graph Store outbox relay — drains the Graph Store DB's own
``outbox_events`` table to Redis Streams.

This is the Phase-0 critical-path dependency: a graph write + its
``graph_change_event`` audit row + the outbox event commit atomically
in the Graph Store DB (see :mod:`graph_store_outbox_repo`); this relay
is what then delivers those events durably to downstream consumers (the
materialization worker, collaboration SSE, management-side projections).

Design mirrors the aggregation dispatch substrate:

* ``FOR UPDATE SKIP LOCKED`` batch claim so multiple relay replicas
  never double-deliver and a slow publish can't block other rows.
* The claim + publish + ``processed=True`` all happen inside the
  JOBS-pool session's single transaction — the row is only marked
  processed if the publish succeeded, and the lock is held until
  commit (at-least-once delivery; consumers must be idempotent, which
  the existing aggregation consumers already are).
* Bounded poll loop with idle backoff, runnable as a lifespan task.

The Postgres row is the source of truth; the stream is a wake-up /
fan-out signal (same contract the aggregation jobs stream documents).
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import AsyncIterator, Awaitable, Callable, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.graph_store_engine import get_graph_store_jobs_session
from backend.app.db.models_graph import GraphStoreOutboxEventORM

logger = logging.getLogger(__name__)

# Redis Stream the relay fans out to. The materialization worker (and
# any other consumer) joins a consumer group on this stream. Named
# parallel to aggregation's `aggregation.jobs`.
GRAPH_OUTBOX_STREAM = "graph.outbox"

# A publish callback: given a drained event, deliver it. Returns when
# the event is durably handed off. Raising aborts the batch (the row is
# left unprocessed and retried next poll — at-least-once).
PublishFn = Callable[[GraphStoreOutboxEventORM], Awaitable[None]]


async def _redis_stream_publish(event: GraphStoreOutboxEventORM) -> None:
    """Default publisher — XADD onto :data:`GRAPH_OUTBOX_STREAM`.

    Reuses the shared aggregation Redis client (same Redis 7 instance
    used for job dispatch / events — not FalkorDB's Redis)."""
    from backend.app.services.aggregation.redis_client import get_redis

    redis = get_redis()
    await redis.xadd(
        GRAPH_OUTBOX_STREAM,
        {
            "event_id": event.id,
            "event_type": event.event_type,
            "event_version": str(event.event_version),
            "aggregate_type": event.aggregate_type or "",
            "aggregate_id": event.aggregate_id or "",
            "payload": json.dumps(event.payload or {}),
        },
    )


async def drain_once(
    session: AsyncSession,
    publish: PublishFn,
    *,
    batch_size: int = 100,
) -> int:
    """Claim and deliver up to *batch_size* unprocessed events.

    Selects the oldest unprocessed rows ``FOR UPDATE SKIP LOCKED`` so
    concurrent relay replicas partition the work, publishes each, and
    marks it processed. The caller's session scope owns the commit —
    the row-locks (and therefore at-most-one-relay-per-row) hold until
    that commit, and a publish failure rolls the whole batch back
    (events stay unprocessed and are retried). Returns the number of
    events delivered.
    """
    stmt = (
        select(GraphStoreOutboxEventORM)
        .where(GraphStoreOutboxEventORM.processed.is_(False))
        .order_by(GraphStoreOutboxEventORM.created_at)
        .limit(batch_size)
        .with_for_update(skip_locked=True)
    )
    rows = (await session.execute(stmt)).scalars().all()
    if not rows:
        return 0

    for event in rows:
        await publish(event)
        event.processed = True

    logger.debug("Graph outbox relay drained %d event(s)", len(rows))
    return len(rows)


async def run_graph_outbox_relay(
    *,
    stop_event: Optional[asyncio.Event] = None,
    publish: Optional[PublishFn] = None,
    batch_size: int = 100,
    idle_sleep_secs: float = 1.0,
    busy_sleep_secs: float = 0.0,
) -> None:
    """Bounded poll loop — drain, sleep, repeat until *stop_event*.

    Runs on the Graph Store JOBS pool (isolated from request handlers).
    When a poll drains a full batch it loops again immediately (drain
    backlog fast); when idle it backs off ``idle_sleep_secs``. Transient
    errors (DB/Redis blip) are logged and retried after the idle sleep —
    the loop is the unit of recovery, no row is lost (unprocessed rows
    are simply re-claimed next poll).

    Intended to be launched as a lifespan background task, gated to the
    same recovery/control role as the aggregation reconciler.
    """
    publisher = publish or _redis_stream_publish
    logger.info(
        "Graph outbox relay started (stream=%s, batch=%d)",
        GRAPH_OUTBOX_STREAM, batch_size,
    )
    while stop_event is None or not stop_event.is_set():
        try:
            async with get_graph_store_jobs_session() as session:
                drained = await drain_once(
                    session, publisher, batch_size=batch_size
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop is the recovery unit
            logger.warning("Graph outbox relay poll failed (retrying): %s", exc)
            drained = 0

        if drained >= batch_size:
            # Full batch — likely more waiting; loop with minimal pause.
            if busy_sleep_secs:
                await asyncio.sleep(busy_sleep_secs)
            continue
        try:
            await asyncio.wait_for(
                (stop_event.wait() if stop_event else asyncio.sleep(idle_sleep_secs)),
                timeout=idle_sleep_secs,
            )
        except asyncio.TimeoutError:
            pass

    logger.info("Graph outbox relay stopped")


# ─── SSE fan-out subscriber ─────────────────────────────────────────
#
# Per-tab read-side of the outbox stream. Each subscriber maintains its
# own cursor (no consumer group) — every UI tab must see every commit
# on the branch it has open, not get a partitioned slice. The endpoint
# wraps this generator in a FastAPI ``StreamingResponse``.


def _sse_frame(stream_id: str, event_name: str, data: dict) -> str:
    return (
        f"id: {stream_id}\n"
        f"event: {event_name}\n"
        f"data: {json.dumps(data, separators=(',', ':'))}\n\n"
    )


def _format_event(
    stream_id: str,
    fields: dict,
    *,
    graph_id: str,
    branch: str,
    user_id: str | None,
) -> str | None:
    """Filter + shape one Redis stream entry into an SSE frame, or
    ``None`` if this entry is not for this subscriber.

    Supported event types:
    - ``visualization.graph.committed`` → broadcast to every subscriber
      on the matching ``(graph_id, branch)`` (the multi-user signal).
    - ``visualization.working_set.advanced`` → forwarded only to the
      originating user's own subscribers (the two-tab signal). Filter
      requires ``user_id`` to be passed in.
    """
    event_type = fields.get("event_type", "")
    if event_type not in (
        "visualization.graph.committed",
        "visualization.working_set.advanced",
    ):
        return None
    try:
        payload = json.loads(fields.get("payload") or "{}")
    except json.JSONDecodeError:
        logger.warning("SSE: malformed payload on stream id %s", stream_id)
        return None
    if payload.get("graph_id") != graph_id or payload.get("branch") != branch:
        return None

    if event_type == "visualization.graph.committed":
        return _sse_frame(
            stream_id,
            "commit",
            {
                "commit_id": payload.get("commit_id"),
                "commit_hash": payload.get("commit_hash"),
                "root_hash": payload.get("root_hash"),
                "actor": payload.get("actor"),
                "delta_summary": payload.get("delta_summary") or {},
            },
        )

    # working_set.advanced — same-user only.
    if user_id is None or payload.get("user_id") != user_id:
        return None
    return _sse_frame(
        stream_id,
        "working_set_advanced",
        {
            "ws_change_version": payload.get("ws_change_version"),
        },
    )


async def sse_subscribe(
    *,
    graph_id: str,
    branch: str,
    user_id: str | None = None,
    last_event_id: str | None = None,
    stop_event: Optional[asyncio.Event] = None,
    block_ms: int = 5000,
    heartbeat_secs: float = 15.0,
    redis_client=None,
) -> AsyncIterator[str]:
    """Yield SSE-formatted frames for one subscriber on ``(graph_id, branch)``.

    Reads :data:`GRAPH_OUTBOX_STREAM` via ``XREAD BLOCK`` (no consumer
    group — fan-out). Honors a ``Last-Event-ID`` cursor for replay; if
    absent, starts from ``$`` (only events after subscription).
    Emits an SSE comment heartbeat after ``heartbeat_secs`` of silence
    so intermediate proxies don't close the connection.

    ``user_id`` is required for the per-user ``working_set_advanced``
    fan-out; the multi-user ``commit`` fan-out works without it. Pass
    the authenticated user id from the endpoint.

    The generator exits when ``stop_event`` is set or the consumer
    stops iterating (FastAPI handles client disconnect that way).
    Transient Redis errors back off and retry; the loop is the
    recovery unit.
    """
    redis = redis_client
    if redis is None:
        from backend.app.services.aggregation.redis_client import get_redis
        redis = get_redis()

    cursor = last_event_id or "$"
    last_emit = time.monotonic()

    # Initial heartbeat so the client knows the connection is live.
    yield ": connected\n\n"

    while stop_event is None or not stop_event.is_set():
        try:
            entries = await redis.xread(
                {GRAPH_OUTBOX_STREAM: cursor}, block=block_ms
            )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — loop recovers
            logger.warning("SSE XREAD failed (retrying): %s", exc)
            await asyncio.sleep(1.0)
            continue

        if entries:
            for _stream_name, msgs in entries:
                for stream_id, fields in msgs:
                    cursor = stream_id
                    frame = _format_event(
                        stream_id, fields,
                        graph_id=graph_id, branch=branch,
                        user_id=user_id,
                    )
                    if frame is not None:
                        yield frame
                        last_emit = time.monotonic()

        # Heartbeat after extended silence (covers idle branches and
        # the case where every event was filtered out).
        if time.monotonic() - last_emit >= heartbeat_secs:
            yield ": heartbeat\n\n"
            last_emit = time.monotonic()


__all__ = [
    "GRAPH_OUTBOX_STREAM",
    "drain_once",
    "run_graph_outbox_relay",
    "sse_subscribe",
    "PublishFn",
]
