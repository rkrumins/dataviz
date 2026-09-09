"""
Slowness is not an outage.

Users opened views and saw "graph service unavailable" while FalkorDB was
serving fine. The chain: a heavy query exceeded its per-operation
``asyncio.wait_for`` budget → the breaker proxy counted the ``TimeoutError``
as a network failure → three of them opened the breaker for 30s → every read
503'd, ``/health/providers`` reported ``unhealthy`` and responses carried
``X-Provider-Health: unreachable``. A second chain did the same with a 1.5s
health PING against a busy instance.

These tests pin the new contract:

  1. The proxy never counts a deadline miss; it surfaces ``ProviderTimeout``,
     which is BOTH a ``ProviderUnavailable`` (stale-fallback cache, worker
     retry budget keep working) AND a ``TimeoutError`` (every existing
     ``except asyncio.TimeoutError`` still sees a timeout).
  2. A server error REPLY (bad Cypher, per-query memory cap) is not counted
     either; a demoted-master ``ReadOnlyError`` still is.
  3. Connection-class failures still open the breaker — resilience kept.
  4. The request-path preflight is skipped for a provider real traffic just
     reached, and a timeout-class miss must persist before it gates.
  5. Warmup pre-trips the instantiation breaker later for timeout-class
     reasons than for a refused connection.
"""
from __future__ import annotations

import asyncio
import time

import pytest

from backend.app.providers.manager import (
    ProviderManager,
    _REACHABLE_AMBIGUOUS_PERSISTENCE,
)
from backend.app.providers.state import _READ_GATE_PERSISTENCE, is_ambiguous_probe_reason
from backend.common.adapters import (
    BreakerState,
    CircuitBreakerProxy,
    ProviderTimeout,
    ProviderUnavailable,
)
from backend.common.interfaces.preflight import PreflightResult


class _Provider:
    """Async provider double whose next call raises ``raise_exc`` (if set)."""

    def __init__(self) -> None:
        self.calls = 0
        self.raise_exc: BaseException | None = None

    @property
    def name(self) -> str:
        return "slow-provider"

    async def get_nodes(self) -> list:
        self.calls += 1
        if self.raise_exc is not None:
            raise self.raise_exc
        return []

    async def close(self) -> None:  # pragma: no cover - not exercised
        pass


# ── 1. Deadline misses are not counted ─────────────────────────────────


async def test_deadline_timeout_surfaces_as_provider_timeout_without_counting() -> None:
    target = _Provider()
    target.raise_exc = asyncio.TimeoutError("nodes.query exceeded 20s provider budget")
    proxy = CircuitBreakerProxy(target, name="t", fail_max=3, reset_timeout=30)

    for _ in range(10):
        with pytest.raises(ProviderTimeout) as exc_info:
            await proxy.get_nodes()
        # It reads as BOTH: the cache's stale-fallback catches
        # ProviderUnavailable, older call sites catch asyncio.TimeoutError.
        assert isinstance(exc_info.value, ProviderUnavailable)
        assert isinstance(exc_info.value, asyncio.TimeoutError)
        assert "20s provider budget" in exc_info.value.reason

    assert proxy.breaker_state == "closed"
    assert proxy.breaker.fail_counter == 0
    assert target.calls == 10, "every call must reach the target — no fast-fail"


async def test_provider_timeout_is_catchable_as_asyncio_timeout() -> None:
    """The reason for the dual base class: ``except asyncio.TimeoutError``
    around a provider call keeps classifying a slow query as a timeout."""
    target = _Provider()
    target.raise_exc = asyncio.TimeoutError()
    proxy = CircuitBreakerProxy(target, name="t", fail_max=1)

    caught: BaseException | None = None
    try:
        await proxy.get_nodes()
    except asyncio.TimeoutError as exc:
        caught = exc
    assert isinstance(caught, ProviderTimeout)
    assert caught.retry_after_seconds > 0


async def test_nested_provider_timeout_is_not_counted_by_an_outer_proxy() -> None:
    """A ProviderTimeout raised by an inner (already proxied) provider passes
    through an outer proxy untouched — it is registered as a logical
    exception, so the ``except ProviderUnavailable`` counting clause never
    sees it."""
    target = _Provider()
    target.raise_exc = ProviderTimeout("inner", "slow")
    proxy = CircuitBreakerProxy(target, name="outer", fail_max=1)

    for _ in range(3):
        with pytest.raises(ProviderTimeout):
            await proxy.get_nodes()
    assert proxy.breaker_state == "closed"


# ── 2. Server error replies are not counted; ReadOnlyError is ──────────


async def test_query_response_error_does_not_count_and_is_not_relabelled() -> None:
    from redis.exceptions import ResponseError

    target = _Provider()
    target.raise_exc = ResponseError("Query's mem consumption exceeded capacity")
    proxy = CircuitBreakerProxy(target, name="t", fail_max=2)

    for _ in range(5):
        with pytest.raises(ResponseError):   # not ProviderUnavailable
            await proxy.get_nodes()
    assert proxy.breaker_state == "closed"


async def test_read_only_reply_still_counts() -> None:
    """A write reaching a demoted master after a failover IS a topology
    problem the breaker should react to."""
    from redis.exceptions import ReadOnlyError

    target = _Provider()
    target.raise_exc = ReadOnlyError("READONLY You can't write against a read only replica.")
    proxy = CircuitBreakerProxy(target, name="t", fail_max=2)

    for _ in range(2):
        with pytest.raises(ProviderUnavailable):
            await proxy.get_nodes()
    assert proxy.breaker_state == "open"


# ── 3. Connection-class failures still open the breaker ────────────────


async def test_redis_socket_timeout_and_refused_connection_still_count() -> None:
    from redis.exceptions import TimeoutError as RedisTimeoutError

    for exc in (RedisTimeoutError("Timeout reading from socket"), ConnectionError("refused")):
        target = _Provider()
        target.raise_exc = exc
        proxy = CircuitBreakerProxy(target, name="t", fail_max=2)
        for _ in range(2):
            with pytest.raises(ProviderUnavailable) as exc_info:
                await proxy.get_nodes()
            assert not isinstance(exc_info.value, ProviderTimeout)
        assert proxy.breaker_state == "open"


async def test_breaker_records_last_success_time() -> None:
    target = _Provider()
    proxy = CircuitBreakerProxy(target, name="t")
    assert proxy.breaker.last_success_at is None
    before = time.monotonic()
    await proxy.get_nodes()
    assert proxy.breaker.last_success_at is not None
    assert proxy.breaker.last_success_at >= before


# ── 4. Request-path preflight ──────────────────────────────────────────


class _PreflightProvider:
    """Raw provider whose ``preflight`` returns a scripted verdict and
    counts how often it ran."""

    def __init__(self, results: list[PreflightResult]) -> None:
        self._results = list(results)
        self.probes = 0

    async def preflight(self, *, deadline_s: float = 1.5) -> PreflightResult:
        self.probes += 1
        return self._results.pop(0) if len(self._results) > 1 else self._results[0]

    async def get_nodes(self) -> list:
        return []

    async def close(self) -> None:  # pragma: no cover
        pass


def _slow() -> PreflightResult:
    return PreflightResult.failure("connect_timeout", 2500)


def _refused() -> PreflightResult:
    return PreflightResult.failure("tcp_refused", 3)


async def test_preflight_is_skipped_when_real_traffic_just_succeeded() -> None:
    mgr = ProviderManager()
    key = ("p", "g")
    raw = _PreflightProvider([_refused()])   # would gate if it ran
    proxy = CircuitBreakerProxy(raw, name="p:g")
    await proxy.get_nodes()                  # real traffic: breaker records success

    await mgr._ensure_reachable(key, proxy)  # must not raise, must not probe
    assert raw.probes == 0


async def test_single_timeout_class_miss_lets_the_request_through() -> None:
    mgr = ProviderManager()
    mgr._reachable_probe.clear()
    key = ("p", "g")
    raw = _PreflightProvider([_slow()])
    proxy = CircuitBreakerProxy(raw, name="p:g")   # never served traffic

    # First miss: the request proceeds to its own deadline-bounded query.
    await mgr._ensure_reachable(key, proxy)
    assert raw.probes == 1
    assert mgr._reachable_misses[key] == 1


async def test_persistent_timeout_class_misses_gate_the_request() -> None:
    mgr = ProviderManager()
    key = ("p", "g")
    raw = _PreflightProvider([_slow()])
    proxy = CircuitBreakerProxy(raw, name="p:g")

    for _ in range(_REACHABLE_AMBIGUOUS_PERSISTENCE - 1):
        await mgr._ensure_reachable(key, proxy)
        mgr._reachable_probe.pop(key, None)   # expire the verdict cache
    with pytest.raises(ProviderUnavailable) as exc_info:
        await mgr._ensure_reachable(key, proxy)
    assert "timed out" in exc_info.value.reason
    assert not isinstance(exc_info.value, ProviderTimeout)


async def test_refused_connection_gates_on_first_probe() -> None:
    """Resilience kept: a definitive failure still fast-fails immediately."""
    mgr = ProviderManager()
    key = ("p", "g")
    raw = _PreflightProvider([_refused()])
    proxy = CircuitBreakerProxy(raw, name="p:g")
    with pytest.raises(ProviderUnavailable):
        await mgr._ensure_reachable(key, proxy)


async def test_an_ok_probe_resets_the_miss_streak() -> None:
    mgr = ProviderManager()
    key = ("p", "g")
    raw = _PreflightProvider([_slow(), PreflightResult.success("h:1", 5)])
    proxy = CircuitBreakerProxy(raw, name="p:g")
    await mgr._ensure_reachable(key, proxy)
    mgr._reachable_probe.pop(key, None)
    await mgr._ensure_reachable(key, proxy)
    assert key not in mgr._reachable_misses


# ── 4b. Slot queue: bounded waiters, counted decisions ─────────────────


async def test_slot_queue_sheds_immediately_once_the_waiter_cap_is_reached() -> None:
    """A request that finds every slot busy waits (up to the budget) for one
    — but only while the queue is short. Beyond the cap it is shed at once,
    so a burst cannot hold GRAPH_READ DB sessions for the whole wait."""
    from backend.app.providers import manager as manager_mod
    from backend.common.adapters import ProviderBusy

    m = ProviderManager()
    key = ("prov-busy", "g")
    sem = m._get_provider_semaphore(key)
    # Occupy every slot.
    held = [await sem.acquire() for _ in range(manager_mod._MAX_PROVIDER_CONCURRENCY)]
    assert sem.locked()

    # Fill the queue to the cap with waiters (they block on acquire).
    waiters = [
        asyncio.create_task(m.acquire_provider_slot("prov-busy", "g"))
        for _ in range(manager_mod._SLOT_MAX_WAITERS)
    ]
    await asyncio.sleep(0)   # let them register as waiting
    assert m._slot_waiters[key] == manager_mod._SLOT_MAX_WAITERS

    # The next arrival is shed immediately — no wait budget spent.
    t0 = time.monotonic()
    with pytest.raises(ProviderBusy) as exc_info:
        await m.acquire_provider_slot("prov-busy", "g")
    assert (time.monotonic() - t0) < 0.5
    assert "queue full" in exc_info.value.reason
    assert m.stats["slots_shed_queue_full"] == 1

    # Release the slots: the queued waiters drain and the counter returns to 0.
    for _ in held:
        sem.release()
    for w in waiters:
        got = await w
        got.release()
    assert m._slot_waiters[key] == 0


async def test_slot_wait_timeout_is_counted_as_shed() -> None:
    from backend.app.providers import manager as manager_mod
    from backend.common.adapters import ProviderBusy

    m = ProviderManager()
    key = ("prov-slow", "g")
    sem = m._get_provider_semaphore(key)
    held = [await sem.acquire() for _ in range(manager_mod._MAX_PROVIDER_CONCURRENCY)]
    original = manager_mod._SEMAPHORE_ACQUIRE_BUDGET_S
    manager_mod._SEMAPHORE_ACQUIRE_BUDGET_S = 0.05
    try:
        with pytest.raises(ProviderBusy):
            await m.acquire_provider_slot("prov-slow", "g")
    finally:
        manager_mod._SEMAPHORE_ACQUIRE_BUDGET_S = original
        for _ in held:
            sem.release()
    assert m.stats["slots_shed_wait_timeout"] == 1
    assert m._slot_waiters[key] == 0


async def test_preflight_decisions_are_counted() -> None:
    mgr = ProviderManager()
    key = ("p", "g")
    raw = _PreflightProvider([_slow()])
    proxy = CircuitBreakerProxy(raw, name="p:g")
    await proxy.get_nodes()                      # real traffic → skip
    await mgr._ensure_reachable(key, proxy)
    assert mgr.stats["preflight_skipped_recent_ok"] == 1

    cold = CircuitBreakerProxy(_PreflightProvider([_slow()]), name="p:g2")
    await mgr._ensure_reachable(("p", "g2"), cold)
    assert mgr.stats["preflight_slow_misses"] == 1


async def test_breaker_counters_distinguish_not_counted_from_counted() -> None:
    from backend.common.adapters.circuit import breaker_stats

    before = breaker_stats()
    target = _Provider()
    proxy = CircuitBreakerProxy(target, name="t", fail_max=1)

    target.raise_exc = asyncio.TimeoutError("slow")
    with pytest.raises(ProviderTimeout):
        await proxy.get_nodes()
    target.raise_exc = ConnectionError("refused")
    with pytest.raises(ProviderUnavailable):
        await proxy.get_nodes()

    after = breaker_stats()
    assert after["deadline_timeouts_not_counted"] == before["deadline_timeouts_not_counted"] + 1
    assert after["network_failures_counted"] == before["network_failures_counted"] + 1
    assert after["breaker_opens"] == before["breaker_opens"] + 1


# ── 5. Warmup pre-trip: timeout-class reasons need persistence ─────────


def test_ambiguous_reason_classifier() -> None:
    for reason in ("connect_timeout", "warmup_wall_clock_exceeded", "empty_reply"):
        assert is_ambiguous_probe_reason(reason) is True
    for reason in ("tcp_refused", "dns_unresolvable", "os_error: No route to host", None):
        assert is_ambiguous_probe_reason(reason) is False


async def test_connect_timeouts_pretrip_only_after_the_read_gate_persistence() -> None:
    m = ProviderManager()
    key = ("prov-busy", "g")
    m._ensure_state(key)
    breaker = m._get_instantiation_breaker(key)

    for _ in range(_READ_GATE_PERSISTENCE - 1):
        await m.record_probe_failure("prov-busy", reason="connect_timeout", source="warmup")
    assert breaker.current_state != BreakerState.OPEN.value
    assert m._provider_states[key].blocks_reads() is False

    await m.record_probe_failure("prov-busy", reason="connect_timeout", source="warmup")
    assert breaker.current_state == BreakerState.OPEN.value
    assert m._provider_states[key].blocks_reads() is True


async def test_refused_connections_still_pretrip_after_two() -> None:
    m = ProviderManager()
    key = ("prov-dead", "g")
    m._ensure_state(key)
    breaker = m._get_instantiation_breaker(key)
    for _ in range(m._PRE_TRIP_AFTER_N):
        await m.record_probe_failure("prov-dead", reason="tcp_refused", source="warmup")
    assert breaker.current_state == BreakerState.OPEN.value
