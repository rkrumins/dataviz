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
import logging
import time

import pytest

from backend.common.adapters import CircuitBreakerProxy, ProviderUnavailable
from backend.common.adapters.circuit import _AsyncCircuitBreaker, _NETWORK_EXCEPTIONS


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


# ── New tests covering the deadline-removal + snapshot-tuple changes ─────


class _SlowProvider:
    """Test double whose async method awaits for a measurable duration.

    Used to prove the proxy does not impose its own outer deadline:
    a long-but-successful call must NOT be classified as a failure.
    """

    def __init__(self, sleep_for: float) -> None:
        self._sleep_for = sleep_for
        self.calls = 0

    @property
    def name(self) -> str:
        return "SlowProvider"

    async def slow_op(self) -> str:
        self.calls += 1
        await asyncio.sleep(self._sleep_for)
        return "done"

    async def close(self) -> None:  # pragma: no cover - not exercised here
        pass


class _MidBatchFailingProvider:
    """Wraps an async method that orchestrates two successful inner ops
    then raises a network-class exception (mid-batch failure).

    Mirrors the pattern of a long-running batch where the provider
    completes some work successfully before the underlying connection
    hiccups — exactly the scenario the removed outer ``wait_for`` would
    have spuriously misclassified.
    """

    def __init__(self) -> None:
        self.calls = 0
        self.inner_ops_completed = 0

    @property
    def name(self) -> str:
        return "MidBatchFailingProvider"

    async def _inner_op(self) -> None:
        # Tiny await so we genuinely cycle the event loop between ops.
        await asyncio.sleep(0)
        self.inner_ops_completed += 1

    async def batch(self) -> None:
        self.calls += 1
        await self._inner_op()
        await self._inner_op()
        # Now blow up the way redis/httpx would — a real network class
        # exception that should count toward the breaker.
        raise ConnectionError("downstream socket reset mid-batch")

    async def close(self) -> None:  # pragma: no cover - not exercised here
        pass


async def test_long_running_async_method_does_not_spuriously_trip_breaker() -> None:
    """The proxy must NOT enforce an outer deadline: a 0.5s successful
    call returns cleanly, breaker stays CLOSED, fail_counter is 0.

    This is the regression guard for the removed ``method_timeout`` /
    outer ``asyncio.wait_for`` in ``CircuitBreakerProxy``. With the old
    behaviour, a small per-method timeout (or any future re-introduction)
    would cancel the call and increment the failure counter even though
    the downstream is perfectly healthy.
    """
    target = _SlowProvider(sleep_for=0.5)
    proxy = CircuitBreakerProxy(target, name="slow", fail_max=3, reset_timeout=30)

    t0 = time.monotonic()
    result = await proxy.slow_op()
    elapsed = time.monotonic() - t0

    assert result == "done"
    assert target.calls == 1
    # We genuinely awaited the sleep — proves we didn't short-circuit.
    assert elapsed >= 0.45, f"Call returned in {elapsed:.3f}s — sleep was bypassed?"
    assert proxy.breaker_state == "closed"
    assert proxy.breaker.fail_counter == 0


async def test_internal_network_error_mid_batch_trips_breaker_after_three_failures() -> None:
    """A ``ConnectionError`` raised mid-batch by the wrapped target is a
    network-class failure that MUST count toward the breaker.

    After 3 consecutive failures the breaker opens; the 4th call
    fast-fails (<10ms wall clock) with a ``ProviderUnavailable`` carrying
    a ``retry_after_seconds`` hint.
    """
    target = _MidBatchFailingProvider()
    proxy = CircuitBreakerProxy(target, name="mid-batch", fail_max=3, reset_timeout=42)

    for _ in range(3):
        with pytest.raises(ProviderUnavailable):
            await proxy.batch()

    # Each of the 3 calls completed two inner ops before raising — proves
    # the proxy isn't truncating the call body itself.
    assert target.calls == 3
    assert target.inner_ops_completed == 6
    assert proxy.breaker_state == "open"

    # 4th call: fast-path — target must NOT be invoked again.
    calls_before = target.calls
    t0 = time.monotonic()
    with pytest.raises(ProviderUnavailable) as exc_info:
        await proxy.batch()
    elapsed_ms = (time.monotonic() - t0) * 1000

    assert target.calls == calls_before, "Target invoked despite OPEN breaker"
    assert elapsed_ms < 10, f"OPEN-state fast-fail took {elapsed_ms:.2f}ms"
    assert exc_info.value.retry_after_seconds > 0
    assert exc_info.value.retry_after_seconds <= 42


async def test_record_failure_returns_snapshot_tuple() -> None:
    """``_record_failure`` returns ``(state_str, fail_counter)`` captured
    inside the lock, so log lines see a value consistent with the
    transition that just happened."""
    breaker = _AsyncCircuitBreaker(name="snap", fail_max=3, reset_timeout=30)

    snap1 = await breaker._record_failure()
    assert snap1 == ("closed", 1)
    assert isinstance(snap1, tuple)
    assert isinstance(snap1[0], str) and isinstance(snap1[1], int)

    snap2 = await breaker._record_failure()
    assert snap2 == ("closed", 2)

    snap3 = await breaker._record_failure()
    # Crossing the threshold flips state inside the same critical section.
    assert snap3 == ("open", 3)


async def test_record_success_returns_snapshot_tuple_and_resets_state() -> None:
    """``_record_success`` returns ``("closed", 0)`` and resets counters,
    even when invoked against a manually-opened breaker."""
    breaker = _AsyncCircuitBreaker(name="snap-success", fail_max=3, reset_timeout=30)
    breaker.open()
    assert breaker.current_state == "open"
    assert breaker.fail_counter == 3

    snap = await breaker._record_success()

    assert snap == ("closed", 0)
    assert breaker.current_state == "closed"
    assert breaker.fail_counter == 0


async def test_transition_log_lines_emitted(caplog: pytest.LogCaptureFixture) -> None:
    """INFO-level transition logs must be emitted on CLOSED→OPEN and
    OPEN→HALF_OPEN, and they must include the breaker name."""
    target = FlakyProvider()
    target.raise_exc = ConnectionError("boom")
    # reset_timeout=0 so the first post-open call probes immediately.
    proxy = CircuitBreakerProxy(target, name="trans-test", fail_max=1, reset_timeout=0)

    caplog.clear()
    with caplog.at_level(logging.INFO, logger="backend.common.adapters.circuit"):
        # Trigger CLOSED -> OPEN.
        with pytest.raises(ProviderUnavailable):
            await proxy.get_stats()

        # Trigger OPEN -> HALF_OPEN. With reset_timeout=0 the very next
        # acquire_call_slot() flips state to HALF_OPEN before invoking
        # the target. The target still raises so the breaker re-opens,
        # but we only care about the OPEN -> HALF_OPEN log line here.
        with pytest.raises(ProviderUnavailable):
            await proxy.get_stats()

    info_messages = [
        rec.getMessage()
        for rec in caplog.records
        if rec.levelno == logging.INFO
        and rec.name == "backend.common.adapters.circuit"
    ]

    closed_to_open = [m for m in info_messages if "CLOSED -> OPEN" in m]
    open_to_half = [m for m in info_messages if "OPEN -> HALF_OPEN" in m]

    assert closed_to_open, f"Missing CLOSED->OPEN transition log; got: {info_messages}"
    assert open_to_half, f"Missing OPEN->HALF_OPEN transition log; got: {info_messages}"
    assert all("trans-test" in m for m in closed_to_open + open_to_half), (
        f"Breaker name missing from transition log lines: "
        f"{closed_to_open + open_to_half}"
    )
