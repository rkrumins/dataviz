"""The provider cache must not grow without bound, and the bus client must be built
like every other bus client.

Why the cache matters: one provider is cached per (provider_id, graph_name) — per data
source — and each holds its own connection pool. redis-py pools have NO idle reaper:
a socket, once opened, is returned to the pool and kept open. So a data source used
once at 3am holds its sockets until the pod restarts, and the fleet-wide total
(data sources × peak concurrency × pods) climbs toward FalkorDB's `maxclients`
(10k default). Exhausting it is not graceful: FalkorDB refuses new connections
fleet-wide, which reads as a total graph outage.
"""
import asyncio
import inspect

import pytest

from backend.app.config import resilience
from backend.app.providers.manager import ProviderManager


class _FakeProvider:
    def __init__(self, inflight: int = 0):
        self._inflight = inflight
        self.closed = False

    def inflight_ops(self) -> int:
        return self._inflight

    async def close(self) -> None:
        self.closed = True


def _mgr_with(entries: dict, last_used: dict) -> ProviderManager:
    mgr = ProviderManager()
    mgr._providers.update(entries)
    mgr._last_used.update(last_used)
    return mgr


# ── LRU cap ──────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cap_closes_the_least_recently_used_idle_provider(monkeypatch):
    monkeypatch.setattr(resilience, "PROVIDER_CACHE_MAX", 2)

    old, mid, new = _FakeProvider(), _FakeProvider(), _FakeProvider()
    mgr = _mgr_with(
        {("p", "old"): old, ("p", "mid"): mid, ("p", "new"): new},
        {("p", "old"): 100.0, ("p", "mid"): 200.0, ("p", "new"): 300.0},
    )

    await mgr._enforce_cache_cap()

    assert ("p", "old") not in mgr._providers        # LRU closed
    assert old.closed is True
    assert ("p", "mid") in mgr._providers and ("p", "new") in mgr._providers
    assert len(mgr._providers) == 2


@pytest.mark.asyncio
async def test_cap_never_closes_a_busy_provider(monkeypatch):
    """The cap is a safety net against unbounded socket growth, not a throttle on
    live traffic — closing a provider mid-job would null the graph handle out from
    under a running aggregation."""
    monkeypatch.setattr(resilience, "PROVIDER_CACHE_MAX", 1)

    busy_but_oldest = _FakeProvider(inflight=3)
    idle_newer = _FakeProvider()
    mgr = _mgr_with(
        {("p", "busy"): busy_but_oldest, ("p", "idle"): idle_newer},
        {("p", "busy"): 100.0, ("p", "idle"): 200.0},
    )

    await mgr._enforce_cache_cap()

    assert ("p", "busy") in mgr._providers           # untouched despite being LRU
    assert busy_but_oldest.closed is False
    assert ("p", "idle") not in mgr._providers       # the idle one went instead


@pytest.mark.asyncio
async def test_cap_disabled_by_zero(monkeypatch):
    monkeypatch.setattr(resilience, "PROVIDER_CACHE_MAX", 0)
    mgr = _mgr_with({("p", "a"): _FakeProvider()}, {("p", "a"): 1.0})
    await mgr._enforce_cache_cap()
    assert len(mgr._providers) == 1


# ── idle TTL reaper ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_reaper_closes_only_the_idle_and_stale(monkeypatch):
    import time as _time

    monkeypatch.setattr(resilience, "PROVIDER_CACHE_IDLE_TTL_SECS", 60.0)
    now = _time.monotonic()

    stale, fresh, stale_but_busy = _FakeProvider(), _FakeProvider(), _FakeProvider(inflight=1)
    mgr = _mgr_with(
        {("p", "stale"): stale, ("p", "fresh"): fresh, ("p", "busy"): stale_but_busy},
        {("p", "stale"): now - 600, ("p", "fresh"): now - 5, ("p", "busy"): now - 600},
    )

    closed = await mgr.reap_idle_providers()

    assert closed == 1
    assert stale.closed is True and ("p", "stale") not in mgr._providers
    assert ("p", "fresh") in mgr._providers          # recently used
    assert ("p", "busy") in mgr._providers           # stale but in-flight


@pytest.mark.asyncio
async def test_reaper_disabled_by_zero_ttl(monkeypatch):
    monkeypatch.setattr(resilience, "PROVIDER_CACHE_IDLE_TTL_SECS", 0.0)
    mgr = _mgr_with({("p", "a"): _FakeProvider()}, {("p", "a"): 0.0})
    assert await mgr.reap_idle_providers() == 0
    assert len(mgr._providers) == 1


@pytest.mark.asyncio
async def test_reaping_does_not_invalidate_the_registry_config(monkeypatch):
    """A reap reclaims SOCKETS from a cold provider. It must not drop the registry's
    connection config / graph clients — that is for config CHANGES, and nuking them
    would force every projector client for that instance to rebuild for nothing."""
    import time as _time

    monkeypatch.setattr(resilience, "PROVIDER_CACHE_IDLE_TTL_SECS", 60.0)
    called = {"n": 0}

    async def fake_invalidate(pid):
        called["n"] += 1

    monkeypatch.setattr(
        "backend.app.providers.falkor_graph_registry.invalidate_provider",
        fake_invalidate,
    )

    mgr = _mgr_with(
        {("p", "cold"): _FakeProvider()},
        {("p", "cold"): _time.monotonic() - 600},
    )
    await mgr.reap_idle_providers()

    assert not mgr._providers
    assert called["n"] == 0                          # registry untouched


@pytest.mark.asyncio
async def test_an_admin_eviction_still_invalidates_the_registry(monkeypatch):
    """…while a real eviction (config change / recovery) still does."""
    called = {"n": 0}

    async def fake_invalidate(pid):
        called["n"] += 1

    monkeypatch.setattr(
        "backend.app.providers.falkor_graph_registry.invalidate_provider",
        fake_invalidate,
    )
    mgr = _mgr_with({("p", "g"): _FakeProvider()}, {("p", "g"): 1.0})

    await mgr.evict_data_source("p", "g")

    assert called["n"] == 1
    assert not mgr._providers


def test_the_reaper_is_wired_into_the_warmup_cycle():
    """It must run in the web tier AND the aggregation worker — both start this loop."""
    from backend.app.providers import warmup

    src = inspect.getsource(warmup.start_provider_warmup)
    assert "reap_idle_providers" in src


# ── the projection bus client is built like every other bus client ───

def test_projection_broker_uses_the_shared_bus_builder(monkeypatch):
    """It used to call from_url(REDIS_URL) directly, ignoring REDIS_PASSWORD, the
    REDIS_TLS_* settings and REDIS_SENTINEL_* — so the day the coordination bus gained
    auth/TLS or moved behind Sentinel, every other consumer would have followed and
    this one client alone would have started failing, costing the projector its
    wake-up signal."""
    from backend.app.services.versioning import messaging

    messaging._client = None
    built = {}

    def fake_build_bus_redis(**kwargs):
        built.update(kwargs)
        return object()

    monkeypatch.setattr(
        "backend.common.adapters.redis_bus.build_bus_redis", fake_build_bus_redis,
    )
    try:
        messaging.get_broker_redis()
        assert built["decode_responses"] is True
        assert built["max_connections"] == 10
        assert built["socket_connect_timeout"] == 5 and built["socket_timeout"] == 10
    finally:
        messaging._client = None

    # …and no direct client construction remains (the docstring mentions from_url as
    # the thing it replaced, so check the CODE, not the prose).
    code = [
        line for line in inspect.getsource(messaging.get_broker_redis).splitlines()
        if not line.strip().startswith(("#", '"', "'"))
    ]
    assert any("build_bus_redis(" in line for line in code)
    assert not any("aioredis.from_url" in line for line in code)
