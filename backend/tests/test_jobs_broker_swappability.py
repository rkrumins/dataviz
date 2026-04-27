"""Broker-swappability proof.

The strategic claim of the job platform is that the messaging /
streams / event-transport layer is portable: producers and consumers
depend on the ``JobBroker`` interface only; backend swaps require
zero changes to worker / SSE / API code. This test makes that claim
verifiable rather than just rhetorical: the same emit-and-stream
flow runs against both ``InMemoryJobBroker`` and (when a Redis is
available) ``RedisStreamsJobBroker``, with a single env-var flip
selecting the implementation.

If a future Kafka / Pub/Sub / NATS broker adoption is forced into
adding broker-specific branches in the producer or consumer code,
this test will start needing those branches too — and that's the
signal the abstraction has leaked.

The Redis variant is gated on ``RUN_REDIS_INTEGRATION_TESTS=1`` so
the regular CI matrix doesn't try to spin Redis just for this test.
The in-memory variant always runs and is the contract reference.
"""
from __future__ import annotations

import asyncio
import os

import pytest

from backend.app.jobs.broker import JobScope as BrokerJobScope
from backend.app.jobs.consumer import JobEventConsumer
from backend.app.jobs.emitter import JobEmitter
from backend.app.jobs.schemas import JobScope


pytestmark = pytest.mark.asyncio


async def _run_emit_and_stream(emitter: JobEmitter, consumer: JobEventConsumer) -> list:
    """Single test scenario, broker-agnostic.

    Producer publishes one ``state`` + three ``progress`` + one
    ``terminal`` for a single job. Consumer streams from the
    beginning; we collect events until the terminal frame closes
    the stream. Result: a list of (sequence, type) pairs the
    caller can assert against.
    """
    job_id = "agg_broker_swappability_test"
    scope = JobScope(workspace_id="ws_test", data_source_id="ds_test")
    seen: list[tuple[int, str]] = []

    # Subscribe FIRST so the producer's writes hit a tailing
    # consumer (matches real-world: SSE client connects, then
    # observes the running job). For backfill semantics the
    # publish ordering matters; both impls preserve it.
    broker_scope = BrokerJobScope(job_id=job_id)

    async def _consume() -> None:
        async for ev in consumer.stream(broker_scope, from_sequence=None):
            seen.append((ev.sequence, ev.type))
            if ev.type == "terminal":
                return

    consumer_task = asyncio.create_task(_consume())
    # Yield to the loop so the consumer starts blocking on its
    # first read before we start publishing.
    await asyncio.sleep(0.05)

    await emitter.publish(
        job_id=job_id, kind="aggregation", scope=scope, type="state",
        payload={"status": "running"},
        live_state={"status": "running"},
    )
    for i in range(3):
        await emitter.publish(
            job_id=job_id, kind="aggregation", scope=scope, type="progress",
            payload={"processed_edges": (i + 1) * 100},
            live_state={"processed_edges": (i + 1) * 100},
        )
    await emitter.terminal(
        job_id=job_id, kind="aggregation", scope=scope, status="completed",
        payload={"edge_count": 300},
    )

    # Bound the wait so a broken consumer never hangs the suite.
    await asyncio.wait_for(consumer_task, timeout=5.0)
    return seen


# ── In-memory variant — always runs ─────────────────────────────


async def test_emit_and_stream_in_memory() -> None:
    """The contract reference. ``InMemoryJobBroker`` runs in-process
    with no external dependency."""
    from backend.app.jobs.brokers.in_memory import InMemoryJobBroker
    from backend.app.jobs.state_stores.in_memory import InMemoryLiveStateStore

    broker = InMemoryJobBroker()
    state_store = InMemoryLiveStateStore()
    emitter = JobEmitter(broker, state_store)
    consumer = JobEventConsumer(broker)

    seen = await _run_emit_and_stream(emitter, consumer)

    # Five events: state + 3× progress + terminal.
    assert len(seen) == 5
    # Strictly monotonic sequences from 1.
    assert [s for s, _ in seen] == [1, 2, 3, 4, 5]
    # Types in the published order.
    assert [t for _, t in seen] == ["state", "progress", "progress", "progress", "terminal"]


# ── Redis variant — opt-in, gated on real Redis ─────────────────


@pytest.mark.skipif(
    os.getenv("RUN_REDIS_INTEGRATION_TESTS") != "1",
    reason="Redis variant requires a running Redis; "
    "set RUN_REDIS_INTEGRATION_TESTS=1 to enable.",
)
async def test_emit_and_stream_redis_streams() -> None:
    """Same scenario, real Redis backend. Same assertions. The
    abstraction holds if and only if these two tests are
    structurally identical (no broker-specific branches)."""
    import redis.asyncio as aioredis  # type: ignore[import-not-found]
    from backend.app.jobs.brokers.redis_streams import RedisStreamsJobBroker
    from backend.app.jobs.state_stores.redis_hash import RedisHashLiveStateStore

    redis_url = os.getenv("REDIS_URL", "redis://localhost:6380/0")
    client = aioredis.from_url(redis_url)
    try:
        # Clean up any leftover stream from a previous run so this
        # test is hermetic.
        from backend.app.jobs.redis_keys import (
            per_job_events_stream, per_tenant_events_stream, state_key,
        )
        job_id = "agg_broker_swappability_test"
        ws_id = "ws_test"
        await client.delete(per_job_events_stream(job_id))
        await client.delete(per_tenant_events_stream(ws_id))
        await client.delete(state_key(job_id))

        broker = RedisStreamsJobBroker(client)
        state_store = RedisHashLiveStateStore(client)
        emitter = JobEmitter(broker, state_store)
        consumer = JobEventConsumer(broker)

        seen = await _run_emit_and_stream(emitter, consumer)

        # Identical assertions to the in-memory variant — the
        # abstraction holds if and only if these match.
        assert len(seen) == 5
        assert [s for s, _ in seen] == [1, 2, 3, 4, 5]
        assert [t for _, t in seen] == [
            "state", "progress", "progress", "progress", "terminal",
        ]
    finally:
        await client.aclose()
