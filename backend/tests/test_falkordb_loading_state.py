"""FalkorDB LOADING (warming-up) is a transient, retryable state — NOT an outage.

When FalkorDB replays its RDB snapshot into memory on restart it answers every
query with ``BusyLoadingError`` for a few seconds. Before this fix that tripped
the per-instance circuit breaker (opening it for 30s) and surfaced as a generic
provider-down 503, which the canvas rendered as "no entities" — looking like data
loss. Now it is classified as ``ProviderLoading`` (503 + Retry-After, code
PROVIDER_LOADING) and registered as a logical/ignored breaker exception so the
breaker stays CLOSED and the instance recovers the moment its load finishes.

No live FalkorDB required — the guarded call is a stub that raises BusyLoadingError.
"""
import asyncio

import pytest
from redis.exceptions import BusyLoadingError, ConnectionError as RedisConnectionError

from backend.app.providers.falkordb_provider import FalkorDBProvider, _is_loading_error
from backend.common.adapters import ProviderLoading, ProviderUnavailable
from backend.common.adapters.circuit import _DEFAULT_IGNORED_EXCEPTIONS


_BUSY = BusyLoadingError("LOADING Redis is loading the dataset in memory")


def _make_provider():
    p = FalkorDBProvider(host="x", graph_name="g")

    async def _noop_connect():
        return None

    p._ensure_connected = _noop_connect
    return p


# ── _is_loading_error ────────────────────────────────────────────────

def test_is_loading_error_matches_busyloading():
    assert _is_loading_error(_BUSY)


def test_is_loading_error_matches_message_when_wrapped_as_generic():
    # The signal can arrive as a plain error carrying the message text.
    assert _is_loading_error(Exception("LOADING Redis is loading the dataset in memory"))


def test_is_loading_error_walks_cause_chain():
    outer = RuntimeError("query failed")
    outer.__cause__ = _BUSY
    assert _is_loading_error(outer)


def test_is_loading_error_rejects_unrelated():
    assert not _is_loading_error(RedisConnectionError("Connection reset by peer"))
    assert not _is_loading_error(Exception("syntax error near MATCH"))


# ── breaker classification ───────────────────────────────────────────

def test_provider_loading_is_registered_as_ignored():
    # Registered as a logical/control-flow exception → the breaker re-raises it
    # untouched and does NOT count it toward fail_max.
    assert ProviderLoading in _DEFAULT_IGNORED_EXCEPTIONS


def test_provider_loading_subclasses_unavailable_for_http_reuse():
    # Subclassing ProviderUnavailable lets the existing 503 + Retry-After HTTP
    # mapping apply unchanged (a dedicated handler stamps the distinct code).
    assert issubclass(ProviderLoading, ProviderUnavailable)


# ── _run_guarded integration ─────────────────────────────────────────

def test_run_guarded_raises_provider_loading_on_busyloading():
    p = _make_provider()

    async def _busy_call():
        raise _BUSY

    async def _run():
        with pytest.raises(ProviderLoading):
            await p._run_guarded(_busy_call)

    asyncio.run(_run())


def test_run_guarded_does_not_burn_transient_retries_on_loading():
    # A dataset reload takes many seconds — far longer than the transient
    # backoff budget — so loading must FAST-FAIL, not retry then trip the
    # breaker. Assert the guarded call ran exactly once (no retries).
    p = _make_provider()
    calls = {"n": 0}

    async def _busy_call():
        calls["n"] += 1
        raise _BUSY

    async def _run():
        with pytest.raises(ProviderLoading):
            await p._run_guarded(_busy_call)

    asyncio.run(_run())
    assert calls["n"] == 1
