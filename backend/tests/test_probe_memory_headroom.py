"""Warn BEFORE FalkorDB stops accepting writes.

The incident this closes: FalkorDB crossed its ``maxmemory`` under
``noeviction`` and began refusing every write with ``OOM command not
allowed``. A publish then triggered a projection heal that could not
write, the watermark was held back, and one data source lost its whole
aggregated-lineage layer for 14 hours. Nothing anywhere said the
database was full — the shared INFO subset collected
``used_memory_human`` and neither ``used_memory`` nor ``maxmemory``, so
no consumer could compute headroom.

These tests pin the four things that make such a warning trustworthy:
the numbers reach every probe that shares ``_redis_info_detail``; they
are carried PER SHARD (a tier 60% full on average can hold a shard at
97%); the verdict fires on real pressure; and it stays SILENT on
``maxmemory: 0`` (unlimited), on absent fields, and under an eviction
policy — where sitting at the cap is the design, not an outage.
"""
import sys
import types

import pytest


# ── fixtures ─────────────────────────────────────────────────────────

def _info(used=None, maxmemory=None, policy=None):
    """A FalkorDB/Redis INFO dict, memory fields optional (Memorystore and
    replicas omit them; absence must never read as a fault)."""
    info = {"redis_version": "7.2.0", "aof_enabled": 0,
            "rdb_last_bgsave_status": "ok"}
    if used is not None:
        info["used_memory"] = used
        info["used_memory_human"] = f"{used / 1024 ** 3:.2f}G"
    if maxmemory is not None:
        info["maxmemory"] = maxmemory
    if policy is not None:
        info["maxmemory_policy"] = policy
    return info


G = 1024 ** 3


@pytest.fixture
def fake_redis(monkeypatch):
    """Fake redis.asyncio whose INFO is set PER NODE, so one shard can be
    full while the rest are fine."""
    state = {"down": set(), "info": {}, "graphs": {}, "default_info": _info()}

    class FakeRedis:
        def __init__(self, host=None, port=None, **kwargs):
            self.host, self.port = host, port

        @property
        def _key(self):
            return f"{self.host}:{self.port}"

        async def ping(self):
            if self._key in state["down"]:
                raise ConnectionError("connection refused")
            return True

        async def info(self, *a, **kw):
            return state["info"].get(self._key, state["default_info"])

        async def execute_command(self, cmd, *a):
            return state["graphs"].get(self._key, [])

        async def dbsize(self):
            return 0

        async def aclose(self):
            return None

    redis_asyncio = types.ModuleType("redis.asyncio")
    redis_asyncio.Redis = FakeRedis
    redis_asyncio.from_url = lambda *a, **kw: FakeRedis()

    # `import redis.asyncio as aioredis` binds off the PARENT package, so
    # patching sys.modules alone would leave the real submodule in play and
    # the probe would dial the live FalkorDB.
    import redis as _redis_pkg

    monkeypatch.setitem(sys.modules, "redis.asyncio", redis_asyncio)
    monkeypatch.setattr(_redis_pkg, "asyncio", redis_asyncio)
    return state


@pytest.fixture
def standalone(monkeypatch):
    monkeypatch.delenv("FALKORDB_MODE", raising=False)
    monkeypatch.setenv("FALKORDB_HOST", "falkordb")
    monkeypatch.setenv("FALKORDB_PORT", "6379")


@pytest.fixture(autouse=True)
def default_thresholds(monkeypatch):
    monkeypatch.delenv("REDIS_MEMORY_WARN_PCT", raising=False)
    monkeypatch.delenv("REDIS_MEMORY_CRITICAL_PCT", raising=False)


def _cluster(monkeypatch, nodes):
    monkeypatch.setenv("FALKORDB_MODE", "cluster")
    monkeypatch.setenv("FALKORDB_CLUSTER_NODES", "n1:7000")

    from backend.app.providers import falkordb_connection

    async def fake_primaries(cfg, timeout):
        return nodes

    monkeypatch.setattr(falkordb_connection, "cluster_primary_nodes", fake_primaries)


# ── 1. the numbers reach the SHARED detail ───────────────────────────

def test_shared_detail_carries_the_numbers_headroom_needs():
    """``used_memory_human`` alone cannot be compared to a cap. Every probe
    that shares this helper gains the numeric pair + the derived percent."""
    from backend.app.services.system_status.probes import _redis_info_detail

    detail = _redis_info_detail(_info(used=6 * G, maxmemory=12 * G,
                                      policy="noeviction"))
    assert detail["usedMemory"] == 6 * G
    assert detail["maxmemory"] == 12 * G
    assert detail["maxmemoryPolicy"] == "noeviction"
    assert detail["memoryUsedPct"] == 50.0
    # The human string stays — it is what the tile already prints.
    assert detail["usedMemoryHuman"] == "6.00G"


def test_info_values_arriving_as_strings_are_still_comparable():
    """Some clients/parsers hand INFO numbers back as strings; a percentage
    computed from them must not silently become None."""
    from backend.app.services.system_status.probes import _redis_info_detail

    detail = _redis_info_detail(
        {"used_memory": str(9 * G), "maxmemory": str(12 * G),
         "maxmemory_policy": "noeviction"})
    assert detail["memoryUsedPct"] == 75.0


# ── 2. under / over threshold ────────────────────────────────────────

@pytest.mark.asyncio
async def test_under_threshold_stays_healthy_and_silent(fake_redis, standalone):
    """The reference topology's planned steady state (~22G of 40G) must not
    light the dashboard up."""
    fake_redis["default_info"] = _info(used=22 * G, maxmemory=40 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["memoryUsedPct"] == 55.0
    assert "memoryPressure" not in res["detail"]
    assert "reasons" not in res["detail"]


@pytest.mark.asyncio
async def test_over_warn_threshold_degrades_with_an_actionable_message(
        fake_redis, standalone):
    fake_redis["default_info"] = _info(used=int(10.8 * G), maxmemory=12 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "degraded"
    pressure = res["detail"]["memoryPressure"]
    assert pressure["level"] == "warn"
    assert pressure["usedPct"] == 90.0
    assert pressure["scope"] == "falkordb:6379"
    assert pressure["usedMemory"] == int(10.8 * G)
    assert pressure["maxmemory"] == 12 * G
    reason = pressure["reason"]
    # Names the node, the numbers, and the CONSEQUENCE in operator terms.
    assert "falkordb:6379" in reason and "90%" in reason
    assert "10.80G" in reason and "12.00G" in reason
    assert "OOM" in reason and "aggregated lineage" in reason
    # ``detail.reasons`` is the house channel the tile renders (``error`` is
    # reserved for what an unreachable probe threw).
    assert res["detail"]["reasons"] == [reason]


@pytest.mark.asyncio
async def test_over_critical_threshold_says_critical_not_warn(
        fake_redis, standalone):
    """The live dev instance: ~11.4G against a 12G cap."""
    fake_redis["default_info"] = _info(used=int(11.4 * G), maxmemory=12 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "degraded"
    assert res["detail"]["memoryPressure"]["level"] == "critical"
    assert res["detail"]["memoryPressure"]["usedPct"] == 95.0


@pytest.mark.asyncio
async def test_pressure_never_reports_down(fake_redis, standalone):
    """A full instance still answers PING and serves READS. "down" in this
    dashboard means unreachable — spending it here would mask a real outage."""
    fake_redis["default_info"] = _info(used=12 * G, maxmemory=12 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "degraded"


# ── 3. never false-alarm ─────────────────────────────────────────────

@pytest.mark.asyncio
async def test_maxmemory_zero_is_unlimited_not_full(fake_redis, standalone):
    """``maxmemory: 0`` means no cap. 20G used against it is 0% of nothing,
    not 100% full — the single most obvious way to cry wolf."""
    fake_redis["default_info"] = _info(used=20 * G, maxmemory=0,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["maxmemory"] == 0
    assert res["detail"]["memoryUsedPct"] is None
    assert "memoryPressure" not in res["detail"]


@pytest.mark.asyncio
async def test_absent_memory_fields_stay_silent(fake_redis, standalone):
    """A replica, a Memorystore instance that omits the section, a single-node
    dev instance: absence is not a fault (the house rule in
    ``_redis_persistence_reasons``)."""
    fake_redis["default_info"] = _info()
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["usedMemory"] is None
    assert res["detail"]["maxmemory"] is None
    assert res["detail"]["memoryUsedPct"] is None
    assert "memoryPressure" not in res["detail"]


@pytest.mark.asyncio
async def test_used_without_a_cap_stays_silent(fake_redis, standalone):
    """Half the pair is not a headroom figure."""
    fake_redis["default_info"] = _info(used=30 * G)
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["memoryUsedPct"] is None


@pytest.mark.asyncio
async def test_eviction_policy_at_the_cap_is_the_design_not_an_outage(
        fake_redis, standalone):
    """A cache under ``allkeys-lru`` is SUPPOSED to sit at its cap — it evicts,
    it does not refuse writes. Degrading on that is how a dashboard becomes
    wallpaper. The numbers are still reported."""
    fake_redis["default_info"] = _info(used=int(11.9 * G), maxmemory=12 * G,
                                       policy="allkeys-lru")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert res["detail"]["memoryUsedPct"] > 95
    assert "memoryPressure" not in res["detail"]


# ── 4. per shard, not just per tier ──────────────────────────────────

@pytest.mark.asyncio
async def test_one_full_shard_degrades_the_tier_and_is_named(
        fake_redis, monkeypatch):
    """The case the tier average hides: two shards at 30%, one at 97%. The
    tier is one publish from the outage, and the operator must be told WHICH
    shard to rebalance."""
    _cluster(monkeypatch, [("n1", 7000), ("n2", 7001), ("n3", 7002)])
    fake_redis["info"] = {
        "n1:7000": _info(used=12 * G, maxmemory=40 * G, policy="noeviction"),
        "n2:7001": _info(used=12 * G, maxmemory=40 * G, policy="noeviction"),
        "n3:7002": _info(used=int(38.8 * G), maxmemory=40 * G,
                         policy="noeviction"),
    }
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "degraded"
    assert res["detail"]["shardsUp"] == 3          # nothing is unreachable

    shards = {s["endpoint"]: s for s in res["detail"]["shards"]}
    assert shards["n1:7000"]["memoryUsedPct"] == 30.0
    assert shards["n1:7000"]["memoryLevel"] is None
    assert shards["n3:7002"]["memoryLevel"] == "critical"
    assert shards["n3:7002"]["usedMemory"] == int(38.8 * G)
    assert shards["n3:7002"]["maxmemory"] == 40 * G

    # The tile-level verdict names the worst shard, not an average.
    assert res["detail"]["memoryPressure"]["scope"] == "n3:7002"
    assert res["detail"]["memoryPressure"]["level"] == "critical"
    assert res["detail"]["reasons"] == [res["detail"]["memoryPressure"]["reason"]]
    assert "n3:7002" in res["error"]


@pytest.mark.asyncio
async def test_a_full_shard_and_a_dead_shard_are_separate_reasons(
        fake_redis, monkeypatch):
    """"Nearly full" must not be mistaken for "unreachable" — the tile carries
    both reasons, and ``memoryPressure`` is the signal that distinguishes them."""
    _cluster(monkeypatch, [("n1", 7000), ("n2", 7001)])
    fake_redis["down"].add("n2:7001")
    fake_redis["info"] = {
        "n1:7000": _info(used=int(39 * G), maxmemory=40 * G, policy="noeviction"),
    }
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "degraded"
    reasons = res["detail"]["reasons"]
    assert any("n2:7001 unreachable" in r for r in reasons)
    assert any("OOM" in r and "n1:7000" in r for r in reasons)
    assert res["detail"]["memoryPressure"]["scope"] == "n1:7000"


@pytest.mark.asyncio
async def test_healthy_cluster_reports_numbers_without_pressure(
        fake_redis, monkeypatch):
    _cluster(monkeypatch, [("n1", 7000), ("n2", 7001)])
    fake_redis["default_info"] = _info(used=8 * G, maxmemory=40 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["status"] == "healthy"
    assert "memoryPressure" not in res["detail"]
    assert all(s["memoryUsedPct"] == 20.0 for s in res["detail"]["shards"])


@pytest.mark.asyncio
async def test_a_down_shard_contributes_no_memory_numbers(
        fake_redis, monkeypatch):
    """A shard that never answered INFO must not read as 0% or as pressure."""
    _cluster(monkeypatch, [("n1", 7000), ("n2", 7001)])
    fake_redis["down"].add("n2:7001")
    fake_redis["default_info"] = _info(used=8 * G, maxmemory=40 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    shards = {s["endpoint"]: s for s in res["detail"]["shards"]}
    assert shards["n2:7001"]["memoryUsedPct"] is None
    assert shards["n2:7001"]["memoryLevel"] is None


# ── 5. thresholds are an operator knob, not a literal ────────────────

@pytest.mark.asyncio
async def test_thresholds_are_operator_tunable(fake_redis, standalone,
                                               monkeypatch):
    fake_redis["default_info"] = _info(used=6 * G, maxmemory=12 * G,
                                       policy="noeviction")
    monkeypatch.setenv("REDIS_MEMORY_WARN_PCT", "40")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["detail"]["memoryPressure"]["level"] == "warn"

    monkeypatch.setenv("REDIS_MEMORY_CRITICAL_PCT", "45")
    res = await probes.probe_falkordb()
    assert res["detail"]["memoryPressure"]["level"] == "critical"


@pytest.mark.asyncio
async def test_a_junk_threshold_falls_back_to_the_default(fake_redis,
                                                          standalone,
                                                          monkeypatch):
    """A typo in an env var must not disable the warning."""
    monkeypatch.setenv("REDIS_MEMORY_WARN_PCT", "not-a-number")
    fake_redis["default_info"] = _info(used=int(11.4 * G), maxmemory=12 * G,
                                       policy="noeviction")
    from backend.app.services.system_status import probes

    res = await probes.probe_falkordb()
    assert res["detail"]["memoryPressure"]["level"] == "critical"


# ── 6. every tier that shares the helper gains it ────────────────────

@pytest.mark.asyncio
async def test_bus_redis_gains_the_same_cliff_warning(fake_redis):
    """The bus Redis has a cap and the same cliff: at it, XADD is refused and
    jobs stop being queued at all."""
    from backend.app.services.system_status import probes

    class _Client:
        async def ping(self):
            return True

        async def info(self, *a, **kw):
            return _info(used=int(3.9 * G), maxmemory=4 * G, policy="noeviction")

    res = await probes._redis_probe("busRedis", "Redis · Bus", _Client(), 1.0)
    assert res["status"] == "degraded"
    assert res["detail"]["memoryPressure"]["level"] == "critical"
    # No graph tier in the message — the lineage consequence is FalkorDB's.
    assert "aggregated lineage" not in res["detail"]["memoryPressure"]["reason"]


# ── 7. the tile the numbers have to LAND on ──────────────────────────

@pytest.mark.asyncio
async def test_falkordb_tile_key_is_falkordb_on_every_topology(
        fake_redis, standalone, monkeypatch):
    """FOUND BROKEN: the node probe stamps its own ``falkordbNode`` key, and the
    standalone/sentinel branches returned it unchanged — so the dashboard, which
    switches on ``key === 'falkordb'``, rendered NO work signal for the tile on
    the commonest topology. These memory numbers would have landed nowhere."""
    from backend.app.services.system_status import probes

    assert (await probes.probe_falkordb())["key"] == "falkordb"

    _cluster(monkeypatch, [("n1", 7000)])
    assert (await probes.probe_falkordb())["key"] == "falkordb"

    # Sentinel is the branch most easily forgotten — it is where the bug lived.
    monkeypatch.setenv("FALKORDB_MODE", "sentinel")
    monkeypatch.setenv("FALKORDB_SENTINEL_MASTER", "mymaster")
    monkeypatch.setenv("FALKORDB_SENTINEL_NODES", "s1:26379")

    from backend.app.providers import falkordb_connection

    async def fake_master(cfg, timeout):
        return ("falkordb", 6379)

    monkeypatch.setattr(falkordb_connection, "resolve_sentinel_master", fake_master)
    res = await probes.probe_falkordb()
    assert res["key"] == "falkordb" and res["detail"]["mode"] == "sentinel"
