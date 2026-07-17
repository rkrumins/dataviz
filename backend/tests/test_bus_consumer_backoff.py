"""Every long-lived bus consumer must be auth-aware in its retry loop.

A rotated/wrong REDIS_STREAMS credential makes the blocking read return
immediately with NOAUTH/WRONGPASS — a loop with a fixed short sleep then spins
(1/s, forever) with a generic message that never tells the operator what to
fix. The three primary XREADGROUP loops already classify via
``bus_error_retry_delay``; these tests pin the loops the audit found missing:
the SSE live-tail, the versioning projection stream loop, and the two pub/sub
listeners (cancel + provider invalidation).
"""
import asyncio
import types

import pytest
from redis.exceptions import AuthenticationError
from redis.exceptions import ConnectionError as RedisConnectionError

from backend.common.adapters.redis_bus import (
    BUS_AUTH_RETRY_DELAY_S,
    BUS_TRANSIENT_RETRY_DELAY_S,
)

WRONGPASS = AuthenticationError("WRONGPASS invalid username-password pair")


# ── SSE live-tail (RedisStreamsJobBroker._stream_iter) ──────────────────────

class _TailRedis:
    """xread raises a scripted error once, then cancels to end the tail."""

    def __init__(self, first_error: BaseException):
        self._errors = [first_error, asyncio.CancelledError()]

    async def xread(self, *a, **kw):
        raise self._errors.pop(0)


@pytest.mark.parametrize("error,expected_delay", [
    (WRONGPASS, BUS_AUTH_RETRY_DELAY_S),
    (RedisConnectionError("reset by peer"), BUS_TRANSIENT_RETRY_DELAY_S),
])
@pytest.mark.asyncio
async def test_sse_live_tail_backoff_is_auth_aware(
    monkeypatch, error, expected_delay,
):
    from backend.app.jobs.brokers import redis_streams as mod

    delays: list[float] = []

    async def fake_sleep(d):
        delays.append(d)

    monkeypatch.setattr(mod.asyncio, "sleep", fake_sleep)

    broker = mod.RedisStreamsJobBroker(_TailRedis(error))
    agen = broker._stream_iter("stream:test", None)
    with pytest.raises(asyncio.CancelledError):
        await agen.__anext__()
    assert delays == [expected_delay]


# ── versioning projection stream loop ───────────────────────────────────────

@pytest.mark.parametrize("error,expected_delay", [
    (WRONGPASS, BUS_AUTH_RETRY_DELAY_S),
    (RedisConnectionError("reset by peer"), BUS_TRANSIENT_RETRY_DELAY_S),
])
@pytest.mark.asyncio
async def test_projection_stream_loop_backoff_is_auth_aware(
    monkeypatch, error, expected_delay,
):
    from backend.app.services.versioning import worker as mod

    w = mod.ProjectionWorker(projector=types.SimpleNamespace())

    class _Broker:
        async def xreadgroup(self, *a, **kw):
            raise error

    monkeypatch.setattr(mod, "get_broker_redis", lambda: _Broker())

    delays: list[float] = []

    async def fake_sleep(d):
        delays.append(d)
        w._stop.set()                      # one iteration is enough

    monkeypatch.setattr(mod.asyncio, "sleep", fake_sleep)

    await w._stream_loop()
    assert delays == [expected_delay]


# ── pub/sub listeners (cancel + provider invalidation) ──────────────────────

class _PubsubRedis:
    """pubsub().subscribe raises the scripted error every cycle."""

    def __init__(self, error: BaseException):
        self._error = error

    def pubsub(self, **kw):
        redis = self

        class _Pubsub:
            async def subscribe(self, *a, **kw):
                raise redis._error

        return _Pubsub()


async def _run_pubsub_listener_once(monkeypatch, mod, listener):
    """Drive one error cycle: capture the backoff wait, then stop the loop."""
    waits: list[float] = []

    async def fake_wait_for(awaitable, timeout=None):
        waits.append(timeout)
        listener._shutdown.set()
        # Consume the shutdown.wait() coroutine so nothing leaks a warning.
        await awaitable
        return None

    monkeypatch.setattr(mod.asyncio, "wait_for", fake_wait_for)
    await listener._run_loop()
    return waits


@pytest.mark.parametrize("error,expected_delay", [
    (WRONGPASS, BUS_AUTH_RETRY_DELAY_S),
    (RedisConnectionError("reset by peer"), 1.0),     # first exponential step
])
@pytest.mark.asyncio
async def test_cancel_listener_backoff_is_auth_aware(
    monkeypatch, error, expected_delay,
):
    from backend.app.services.aggregation import cancel as mod

    listener = mod.CancelListener(redis_client=_PubsubRedis(error))
    waits = await _run_pubsub_listener_once(monkeypatch, mod, listener)
    assert waits == [expected_delay]


@pytest.mark.parametrize("error,expected_delay", [
    (WRONGPASS, BUS_AUTH_RETRY_DELAY_S),
    (RedisConnectionError("reset by peer"), 1.0),     # first exponential step
])
@pytest.mark.asyncio
async def test_invalidation_listener_backoff_is_auth_aware(
    monkeypatch, error, expected_delay,
):
    from backend.app.providers import invalidation_bus as mod

    listener = mod.ProviderInvalidationListener(
        redis_client=_PubsubRedis(error),
    )
    waits = await _run_pubsub_listener_once(monkeypatch, mod, listener)
    assert waits == [expected_delay]
