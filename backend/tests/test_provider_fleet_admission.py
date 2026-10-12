"""The compute shed must be ONE number, not one per gunicorn worker.

``_bounded_compute`` wraps every cache miss in ``acquire_provider_slot``,
whose docstring promises that "a slow provider with 8 concurrent requests in
flight should refuse the 9th". It returned an ``asyncio.Semaphore`` — per
process — and the deployed shape runs 3 replicas x 4 workers, so the real
ceiling was 96 concurrent calls against a shard running THREAD_COUNT 6. The
shed that exists to protect the store admitted sixteen times what it said.

These tests pin the fleet-wide count that closes that gap, and — just as
importantly — that it FAILS OPEN: the bus is not a hard dependency of the
read path, so no Redis must mean today's per-process bound and not an
outage.
"""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import pytest

from backend.app.providers import manager as manager_mod
from backend.app.providers.manager import ProviderManager
from backend.common.adapters import ProviderBusy

pytestmark = pytest.mark.asyncio


class _FakeRedis:
    """Only what the slot counter issues: EVAL of the acquire script, ZREM."""

    def __init__(self) -> None:
        self.zsets: dict = {}
        self.fail = False

    async def eval(self, script, numkeys, *args):
        if self.fail:
            raise RuntimeError("bus down")
        key = args[0]
        now, stale, limit, member = (
            float(args[1]), float(args[2]), int(args[3]), args[4],
        )
        z = self.zsets.setdefault(key, {})
        for held, score in list(z.items()):
            if score <= now - stale:
                del z[held]
        if len(z) < limit:
            z[member] = now
            return 1
        return 0

    async def zrem(self, key, member):
        if self.fail:
            raise RuntimeError("bus down")
        return int(self.zsets.get(key, {}).pop(member, None) is not None)


@pytest.fixture
def bus(monkeypatch):
    """One Redis shared by every ProviderManager the test builds — which is
    the whole point: these stand for separate processes."""
    fake = _FakeRedis()
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", lambda: fake,
    )
    # Shed fast; the retry budget is exercised on its own below.
    monkeypatch.setattr(manager_mod, "_SEMAPHORE_ACQUIRE_BUDGET_S", 0.05)
    return fake


# ── The number is shared ─────────────────────────────────────────────


async def test_two_processes_cannot_both_admit_past_the_cap(bus, monkeypatch) -> None:
    """The regression that matters: the cap holds ACROSS managers."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 2)
    one, two = ProviderManager(), ProviderManager()

    async with one.fleet_slot("prov", "g"):
        async with two.fleet_slot("prov", "g"):
            # Two of two taken, by two different "processes".
            with pytest.raises(ProviderBusy) as exc_info:
                async with two.fleet_slot("prov", "g"):
                    pytest.fail("admitted past the fleet cap")
    assert "fleet-wide concurrency (2)" in exc_info.value.reason
    assert exc_info.value.retry_after_seconds == 1
    assert two.stats["fleet_slots_shed"] == 1
    # Both slots given back on exit — the next caller is admitted.
    async with one.fleet_slot("prov", "g"):
        pass


async def test_each_graph_gets_its_own_count(bus, monkeypatch) -> None:
    """A busy source must not shed a quiet one: the key carries the graph."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    mgr = ProviderManager()
    async with mgr.fleet_slot("prov", "g1"):
        async with mgr.fleet_slot("prov", "g2"):
            pass
        with pytest.raises(ProviderBusy):
            async with mgr.fleet_slot("prov", "g1"):
                pytest.fail("admitted past the fleet cap")


async def test_a_shed_caller_waits_out_the_budget_first(bus, monkeypatch) -> None:
    """Short queries clear in ~100ms; shedding the tail of one burst costs
    the client a whole 429 + backoff round trip. The budget is the same one
    the per-process semaphore spends, and for the same reason."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    monkeypatch.setattr(manager_mod, "_SEMAPHORE_ACQUIRE_BUDGET_S", 0.6)
    mgr = ProviderManager()
    holder = await mgr.fleet_slot("prov", "g").__aenter__()
    freed = asyncio.get_running_loop().call_later(
        0.2, lambda: asyncio.ensure_future(holder.__aexit__()),
    )
    t0 = time.monotonic()
    async with mgr.fleet_slot("prov", "g"):
        waited = time.monotonic() - t0
    freed.cancel()
    assert 0.15 < waited < 0.6, f"did not wait for the slot to free ({waited:.2f}s)"
    assert mgr.stats["fleet_slots_shed"] == 0


# ── Fail open ────────────────────────────────────────────────────────


async def test_no_bus_means_no_bound_not_an_outage(monkeypatch) -> None:
    def _boom():
        raise RuntimeError("no redis configured")

    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis", _boom,
    )
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    mgr = ProviderManager()
    async with mgr.fleet_slot("prov", "g"):
        async with mgr.fleet_slot("prov", "g"):
            pass
    assert mgr.stats["fleet_slots_fail_open"] == 2
    assert mgr.stats["fleet_slots_shed"] == 0


async def test_a_bus_error_mid_flight_fails_open(bus, monkeypatch) -> None:
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    mgr = ProviderManager()
    bus.fail = True
    async with mgr.fleet_slot("prov", "g"):
        pass
    assert mgr.stats["fleet_slots_fail_open"] == 1
    assert mgr.stats["fleet_slots_shed"] == 0


async def test_a_release_that_cannot_reach_the_bus_is_not_an_error(
    bus, monkeypatch,
) -> None:
    """The score-based prune reclaims the slot after _FLEET_SLOT_STALE_S; a
    failed ZREM must not surface as a 500 on a request that succeeded."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    mgr = ProviderManager()
    slot = mgr.fleet_slot("prov", "g")
    await slot.__aenter__()
    bus.fail = True
    await slot.__aexit__()


async def test_a_stale_holder_is_pruned_not_leaked(bus, monkeypatch) -> None:
    """A process that dies mid-call must not hold a slot for good."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    mgr = ProviderManager()
    await mgr.fleet_slot("prov", "g").__aenter__()   # never released
    key, = bus.zsets.keys()
    (member,), = (list(bus.zsets[key]),)
    bus.zsets[key][member] = time.time() - manager_mod._FLEET_SLOT_STALE_S - 1
    async with mgr.fleet_slot("prov", "g"):
        pass


# ── Sizing ───────────────────────────────────────────────────────────


async def test_the_cap_comes_from_the_nodes_own_thread_count(bus, monkeypatch) -> None:
    """A node cannot execute more queries at once than it has query threads;
    admitting past that only lengthens everybody's queue."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 0)
    mgr = ProviderManager()
    mgr._providers[("prov", "g")] = SimpleNamespace(
        server_thread_count=lambda: 6,
    )
    assert mgr._fleet_slot_limit(("prov", "g")) == 6


async def test_sizing_falls_back_and_never_goes_below_the_floor(
    bus, monkeypatch,
) -> None:
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 0)
    mgr = ProviderManager()
    # Nothing read yet → the per-process default stands in.
    assert mgr._fleet_slot_limit(("prov", "g")) == manager_mod._MAX_PROVIDER_CONCURRENCY
    # A tiny or misread THREAD_COUNT must not shed the store to a trickle.
    mgr._providers[("prov", "g")] = SimpleNamespace(server_thread_count=lambda: 1)
    assert mgr._fleet_slot_limit(("prov", "g")) == manager_mod._FLEET_MIN_CONCURRENCY
    # A provider that cannot answer is not a failure.
    def _boom():
        raise RuntimeError("not connected")
    mgr._providers[("prov", "g")] = SimpleNamespace(server_thread_count=_boom)
    assert mgr._fleet_slot_limit(("prov", "g")) == manager_mod._MAX_PROVIDER_CONCURRENCY


async def test_the_env_override_wins_over_the_reading(bus, monkeypatch) -> None:
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 32)
    mgr = ProviderManager()
    mgr._providers[("prov", "g")] = SimpleNamespace(server_thread_count=lambda: 6)
    assert mgr._fleet_slot_limit(("prov", "g")) == 32


async def test_the_fleet_count_can_be_turned_off(monkeypatch) -> None:
    """A negative value is the escape hatch: back to per-process caps only,
    with no bus round trip at all."""
    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", -1)
    monkeypatch.setattr(
        "backend.app.services.aggregation.redis_client.get_redis",
        lambda: pytest.fail("asked the bus with the fleet count disabled"),
    )
    mgr = ProviderManager()
    async with mgr.fleet_slot("prov", "g"):
        pass


# ── Wired into the read path ─────────────────────────────────────────


async def test_bounded_compute_sheds_on_the_fleet_count(bus, monkeypatch) -> None:
    """Both processes' semaphores are free; the shared count is what sheds."""
    from backend.app.api.v1.endpoints.graph import _bounded_compute

    monkeypatch.setattr(manager_mod, "_FLEET_MAX_CONCURRENCY", 1)
    mgr = ProviderManager()
    monkeypatch.setattr(
        "backend.app.api.v1.endpoints.graph.provider_manager", mgr,
    )
    engine = SimpleNamespace(
        provider=SimpleNamespace(manager_cache_key=("prov", "g")),
    )
    release, in_flight = asyncio.Event(), asyncio.Event()

    async def slow_compute():
        in_flight.set()
        await release.wait()
        return "done"

    first = asyncio.create_task(_bounded_compute(engine, slow_compute)())
    await in_flight.wait()

    async def fast_compute():
        return "second"

    with pytest.raises(ProviderBusy):
        await _bounded_compute(engine, fast_compute)()
    # The per-process semaphore was NOT the thing that shed, and it must be
    # given back: a fleet shed that leaked a local slot would turn one busy
    # store into a permanently narrowed process.
    assert mgr._get_provider_semaphore(("prov", "g"))._value == (
        manager_mod._MAX_PROVIDER_CONCURRENCY - 1
    )

    release.set()
    assert await first == "done"
    assert await _bounded_compute(engine, fast_compute)() == "second"
