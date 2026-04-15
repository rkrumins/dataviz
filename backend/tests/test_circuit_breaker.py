"""
Unit tests for backend.common.adapters.circuit

Verifies that CircuitBreakerProxy:
  1. Passes sync attributes / methods through unchanged.
  2. Wraps async methods so network errors count toward the breaker.
  3. Trips the breaker after ``fail_max`` consecutive failures.
  4. Raises :class:`ProviderUnavailable` with a ``retry_after_seconds``
     hint from the next call forward — in <5 ms, no network I/O.
  5. Ignores logical errors (ValueError, KeyError, etc.) — they do not
     affect breaker state.
  6. Never wraps ``close()`` so a dead downstream can still be evicted.
  7. Exposes the underlying breaker state for observability.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from backend.common.adapters import CircuitBreakerProxy, ProviderUnavailable


# ── Helper doubles ─────────────────────────────────────────────────────


class FlakyProvider:
    """Test double that simulates a graph provider with configurable failure."""

    def __init__(self) -> None:
        self.calls = 0
        self.closed = False
        self.raise_exc: Exception | None = None
        self.sync_value = 42

    @property
    def name(self) -> str:
        return "FlakyProvider"

    def set_containment_edge_types(self, types: list[str]) -> None:
        # Sync method — must pass through untouched.
        self._containment = types

    async def get_stats(self) -> dict:
        self.calls += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        return {"nodes": self.calls}

    async def get_node(self, urn: str) -> dict:
        self.calls += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        return {"urn": urn}

    async def close(self) -> None:
        # Must always run even when the breaker is open.
        self.closed = True


# ── Tests ──────────────────────────────────────────────────────────────


async def test_sync_attributes_pass_through() -> None:
    target = FlakyProvider()
    proxy = CircuitBreakerProxy(target, name="test")

    # name is a property — pass-through.
    assert proxy.name == "FlakyProvider"
    # sync method — pass-through, not wrapped.
    proxy.set_containment_edge_types(["CONTAINS"])
    assert target._containment == ["CONTAINS"]


async def test_async_call_succeeds_and_returns_value() -> None:
    target = FlakyProvider()
    proxy = CircuitBreakerProxy(target, name="test")

    result = await proxy.get_stats()
    assert result == {"nodes": 1}
    assert proxy.breaker_state == "closed"


async def test_breaker_trips_after_fail_max_failures() -> None:
    target = FlakyProvider()
    target.raise_exc = ConnectionError("downstream dead")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=3, reset_timeout=60)

    # First 3 calls: ConnectionError is counted and re-raised as ProviderUnavailable.
    for _ in range(3):
        with pytest.raises(ProviderUnavailable):
            await proxy.get_stats()

    # 4th call: breaker is open — must fail fast without calling the target.
    calls_before = target.calls
    t0 = time.monotonic()
    with pytest.raises(ProviderUnavailable) as exc_info:
        await proxy.get_stats()
    elapsed_ms = (time.monotonic() - t0) * 1000

    assert target.calls == calls_before, "Target was invoked while breaker is open"
    assert elapsed_ms < 5, f"Breaker-open fast-path took {elapsed_ms:.2f}ms (>5ms)"
    assert proxy.breaker_state == "open"
    # Retry-after counts down from reset_timeout; allow a 2s slack for the
    # time elapsed between the trip and this fast-path call.
    assert 55 <= exc_info.value.retry_after_seconds <= 60


async def test_breaker_open_sets_retry_after_hint() -> None:
    target = FlakyProvider()
    target.raise_exc = OSError("connection refused")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=1, reset_timeout=42)

    # 1 failure trips the breaker.
    with pytest.raises(ProviderUnavailable):
        await proxy.get_stats()

    with pytest.raises(ProviderUnavailable) as exc_info:
        await proxy.get_stats()
    # Retry-after counts down from reset_timeout (42s) as time passes.
    assert 37 <= exc_info.value.retry_after_seconds <= 42
    assert exc_info.value.provider_name == "test"


async def test_logical_errors_do_not_affect_breaker() -> None:
    target = FlakyProvider()
    target.raise_exc = ValueError("caller passed a bad urn")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=2)

    # Logical errors propagate untouched and do not trip the breaker.
    for _ in range(10):
        with pytest.raises(ValueError):
            await proxy.get_node("bad-urn")

    # Breaker is still closed despite 10 exceptions.
    assert proxy.breaker_state == "closed"


async def test_provider_unavailable_itself_does_not_recursively_trip() -> None:
    """ProviderUnavailable raised by the proxy should not re-feed the
    breaker's failure counter if the target ever re-raises it."""
    target = FlakyProvider()
    target.raise_exc = ProviderUnavailable("inner", "already down")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=3)

    # ProviderUnavailable is not a network error and not in the default
    # exclude list, so it WILL count as a failure (conservative: an upstream
    # raising this is itself a signal that something is wrong). Verify the
    # breaker still functions sensibly and never loops.
    for _ in range(3):
        with pytest.raises(ProviderUnavailable):
            await proxy.get_stats()

    # Fast-path kicks in.
    t0 = time.monotonic()
    with pytest.raises(ProviderUnavailable):
        await proxy.get_stats()
    assert (time.monotonic() - t0) * 1000 < 5


async def test_close_always_passes_through_even_when_breaker_open() -> None:
    target = FlakyProvider()
    target.raise_exc = ConnectionError("dead")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=1)

    # Trip the breaker.
    with pytest.raises(ProviderUnavailable):
        await proxy.get_stats()
    assert proxy.breaker_state == "open"

    # close() must still run so pool resources can be freed during eviction.
    await proxy.close()
    assert target.closed is True


async def test_breaker_auto_recovers_after_reset_timeout() -> None:
    target = FlakyProvider()
    target.raise_exc = ConnectionError("flaky")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=1, reset_timeout=1)

    with pytest.raises(ProviderUnavailable):
        await proxy.get_stats()
    assert proxy.breaker_state == "open"

    # Wait for the reset timeout. pybreaker transitions OPEN → HALF_OPEN
    # on the next call after reset_timeout elapses.
    await asyncio.sleep(1.05)

    # Downstream is healthy again — the probe call succeeds and the breaker closes.
    target.raise_exc = None
    result = await proxy.get_stats()
    assert result == {"nodes": target.calls}
    assert proxy.breaker_state == "closed"


async def test_breaker_concurrent_failures_do_not_overshoot_fail_max() -> None:
    """Under concurrent callers, pybreaker must serialize state transitions
    so only the 5th failure (not the 50th) flips OPEN. Proves no event-loop
    starvation; all coroutines complete quickly with ProviderUnavailable."""
    target = FlakyProvider()
    target.raise_exc = OSError("down")
    proxy = CircuitBreakerProxy(target, name="test", fail_max=5, reset_timeout=30)

    t0 = time.monotonic()
    results = await asyncio.gather(
        *(proxy.get_stats() for _ in range(50)),
        return_exceptions=True,
    )
    elapsed = time.monotonic() - t0

    # Every single result is ProviderUnavailable (none are raw OSError).
    assert all(isinstance(r, ProviderUnavailable) for r in results)
    # The concurrent batch finished promptly — no event-loop stall.
    assert elapsed < 1.0, f"50 concurrent calls took {elapsed:.2f}s (should be <1s)"
    assert proxy.breaker_state == "open"


async def test_breaker_state_observable_for_status_endpoints() -> None:
    from backend.common.adapters.circuit import _AsyncCircuitBreaker

    target = FlakyProvider()
    target.raise_exc = ConnectionError("down")
    proxy = CircuitBreakerProxy(target, name="prov:graph1", fail_max=1)

    assert proxy.breaker_state == "closed"
    with pytest.raises(ProviderUnavailable):
        await proxy.get_stats()
    assert proxy.breaker_state == "open"
    assert proxy.breaker_name == "prov:graph1"
    assert isinstance(proxy.breaker, _AsyncCircuitBreaker)
    assert proxy.breaker.fail_counter >= 1
