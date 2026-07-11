"""Unit tests for the distributed write-admission controller.

Uses a minimal in-memory fake of the job-bus Redis (only the commands the
controller issues: SET NX PX / GET / PEXPIRE / EVAL / ZREM) so we can
assert the lease exclusivity, the slot semaphore, and — critically — the
fail-OPEN behavior when Redis is down.
"""
import asyncio
import time

import pytest

from backend.app.services.aggregation import admission as adm
from backend.common.adapters import ProviderBusy


class _FakeProvider:
    _graph_name = "g1"
    _conn_cfg = None


class _FakeRedis:
    def __init__(self):
        self.kv = {}
        self.zsets = {}

    async def set(self, key, value, nx=False, px=None):
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    async def get(self, key):
        return self.kv.get(key)

    async def pexpire(self, key, ms):
        return key in self.kv

    async def eval(self, script, numkeys, *args):
        key = args[0]
        if "SET" in script and "PX" in script:  # takeover compare-and-replace
            if self.kv.get(key) == args[1]:
                self.kv[key] = args[2]
                return 1
            return 0
        if "ZCARD" in script:  # slot acquire
            now, stale, limit, member = float(args[1]), float(args[2]), int(args[3]), args[4]
            z = self.zsets.setdefault(key, {})
            for m, score in list(z.items()):
                if score <= now - stale:
                    del z[m]
            if len(z) < limit:
                z[member] = now
                return 1
            return 0
        # lease release: compare-and-del
        token = args[1]
        if self.kv.get(key) == token:
            del self.kv[key]
            return 1
        return 0

    async def zrem(self, key, member):
        self.zsets.get(key, {}).pop(member, None)
        return 1


class _DownRedis:
    def __getattr__(self, name):
        async def _fail(*a, **k):
            raise ConnectionError("redis down")
        return _fail


def _run(coro):
    # asyncio.run gives each test a fresh loop — immune to other test
    # modules closing or replacing the default loop.
    return asyncio.run(coro)


def test_graph_lease_is_exclusive_and_released():
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        b = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        lease = await a.acquire_graph_lease(provider)
        assert lease is not None

        # Second job on the same graph parks with ProviderBusy.
        with pytest.raises(ProviderBusy) as exc:
            await b.acquire_graph_lease(provider)
        assert exc.value.retry_after_seconds

        await a.release_graph_lease(lease)
        # Now the second job can acquire.
        lease2 = await b.acquire_graph_lease(provider)
        assert lease2 is not None
        await b.release_graph_lease(lease2)

    _run(scenario())


def test_graph_lease_conflict_names_the_holder():
    """A conflicting claimant must be told WHO holds the lease — an
    anonymous 'lease held' was undiagnosable in production when a shadow
    in-process run held it while user jobs parked."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        b = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        lease = await a.acquire_graph_lease(provider, owner="agg_12345")
        assert lease is not None
        with pytest.raises(ProviderBusy) as exc:
            await b.acquire_graph_lease(provider, owner="agg_67890")
        assert "agg_12345" in str(exc.value)
        await a.release_graph_lease(lease)

    _run(scenario())


def test_own_stale_lease_is_reacquired_not_parked():
    """A retry of the SAME job must not park on its own previous
    attempt's unexpired lease — it takes it over (the previous attempt
    is dead by definition; the exec lock enforces one executor/job)."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        first = await a.acquire_graph_lease(provider, owner="agg_self")
        assert first is not None
        first.renew_task.cancel()   # simulate dead attempt, lease left behind

        second = await a.acquire_graph_lease(provider, owner="agg_self")
        assert second is not None   # took over, no ProviderBusy
        await a.release_graph_lease(second)

    _run(scenario())


def test_zombie_lease_holder_break():
    """A claimant can atomically break a lease whose observed value is
    unchanged — and never clobbers a lease re-acquired in between."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        b = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        lease = await a.acquire_graph_lease(provider, owner="agg_dead")
        lease.renew_task.cancel()
        holder = await b.get_lease_holder(provider)
        assert holder is not None and holder[0] == "agg_dead"

        # Value changed under us (a live job re-acquired) → break refuses.
        assert not await b.break_lease_if_holder(provider, holder[1] + "x")
        # Exact observed value → break succeeds, next acquire is clean.
        assert await b.break_lease_if_holder(provider, holder[1])
        fresh = await b.acquire_graph_lease(provider, owner="agg_new")
        assert fresh is not None
        await b.release_graph_lease(fresh)

    _run(scenario())


def test_write_slots_cap_concurrency():
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()
        key = f"agg:writeslots:{adm.endpoint_key(provider)}"

        s1 = a.write_slot(provider)
        s2 = a.write_slot(provider)
        await s1.__aenter__()
        await s2.__aenter__()
        assert len(redis.zsets[key]) == 2  # limit default = 2

        # Third acquire finds no slot; with a zero wait budget it fails
        # open (returns without a member) instead of deadlocking.
        orig = adm._SLOT_WAIT_MAX_SECS
        adm._SLOT_WAIT_MAX_SECS = 0.0
        try:
            s3 = a.write_slot(provider)
            await s3.__aenter__()
            assert len(redis.zsets[key]) == 2  # over-admitted but not added
            await s3.__aexit__(None, None, None)
        finally:
            adm._SLOT_WAIT_MAX_SECS = orig

        await s1.__aexit__(None, None, None)
        await s2.__aexit__(None, None, None)
        assert len(redis.zsets[key]) == 0

    _run(scenario())


def test_stale_slot_holders_are_pruned():
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()
        key = f"agg:writeslots:{adm.endpoint_key(provider)}"
        # A holder that died long ago.
        redis.zsets[key] = {"dead": time.time() - 10_000}

        async with a.write_slot(provider):
            assert "dead" not in redis.zsets[key]

    _run(scenario())


def test_fail_open_when_redis_down():
    async def scenario():
        a = adm.AggregationAdmission(_DownRedis())
        provider = _FakeProvider()

        # Lease: no exception, returns None (degraded to local limits).
        lease = await a.acquire_graph_lease(provider)
        assert lease is None
        await a.release_graph_lease(lease)

        # Slot: enters and exits without raising.
        async with a.write_slot(provider):
            pass

    _run(scenario())


def test_endpoint_key_prefers_host_port():
    class _Cfg:
        host = "falkordb.internal"
        port = 6379

    class _P:
        _graph_name = "g"
        _conn_cfg = _Cfg()

    assert adm.endpoint_key(_P()) == "falkordb.internal:6379"
    assert adm.endpoint_key(_FakeProvider()) == "graph:g1"
