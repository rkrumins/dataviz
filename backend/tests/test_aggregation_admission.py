"""Unit tests for the distributed write-admission controller.

Uses a minimal in-memory fake of the job-bus Redis (only the commands the
controller issues: SET NX PX / GET / PEXPIRE / EVAL / ZREM / HSET /
HGETALL / HDEL) so we can assert the lease exclusivity, the slot semaphore,
the reservation ledger, and — critically — the fail-OPEN behavior when
Redis is down.
"""
import asyncio
import json
import time
import types

import pytest

from backend.app.services.aggregation import admission as adm
from backend.common.adapters import ProviderBusy


class _FakeProvider:
    _graph_name = "g1"
    _conn_cfg = None


GB = 2 ** 30


class _FakeRedis:
    def __init__(self):
        self.kv = {}
        self.zsets = {}
        self.hashes = {}
        self.hset_calls = 0
        # Full TTL by default: a holder that is still renewing.
        self.pttl_ms = adm._GRAPH_LEASE_TTL_MS

    async def set(self, key, value, nx=False, px=None):
        if nx and key in self.kv:
            return None
        self.kv[key] = value
        return True

    async def get(self, key):
        return self.kv.get(key)

    async def pexpire(self, key, ms):
        self.pttl_ms = ms
        return key in self.kv

    async def pttl(self, key):
        """Milliseconds left on the lease. A LIVE holder keeps refreshing it,
        so its observed TTL never falls much below the full value; a dead
        one's decays. Which of those the caller sees is the whole liveness
        test in ``acquire_graph_lease``, so the fake has to model it."""
        if key not in self.kv:
            return -2
        return self.pttl_ms

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

    async def hset(self, key, field, value):
        self.hset_calls += 1
        self.hashes.setdefault(key, {})[field] = value
        return 1

    async def hgetall(self, key):
        return dict(self.hashes.get(key, {}))

    async def hdel(self, key, *fields):
        h = self.hashes.get(key, {})
        return sum(1 for f in fields if h.pop(f, None) is not None)


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
    """A retry of the SAME job must not park for a full TTL on a lease its own
    previous attempt left behind — once that attempt has provably stopped
    renewing it, the retry takes it over."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        first = await a.acquire_graph_lease(provider, owner="agg_self")
        assert first is not None
        first.renew_task.cancel()   # the attempt is gone …
        # … and its lease has decayed past two renew intervals, which is what
        # says so: a live renewer would have pushed it back to the full TTL.
        redis.pttl_ms = adm._GRAPH_LEASE_TTL_MS - int(
            adm._GRAPH_LEASE_RENEW_SECS * 1000 * 2
        ) - 1

        second = await a.acquire_graph_lease(provider, owner="agg_self")
        assert second is not None   # took over, no ProviderBusy
        await a.release_graph_lease(second)

    _run(scenario())


def test_a_still_renewing_predecessor_is_not_taken_over():
    """The dangerous case the self-reacquire used to wave through. The exec
    lock only guarantees the predecessor has been ASKED to stop; its cancel
    lands at the next await and the Cypher already on the wire completes
    server-side. Handing the successor the key while that is true put two
    runs' MERGEs into one graph, interleaving weights that were neither
    run's — under a ``completed`` record, with a fresh fingerprint that then
    suppressed drift detection. A lease whose TTL is still being refreshed is
    proof the predecessor is alive, so the successor parks instead."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        first = await a.acquire_graph_lease(provider, owner="agg_self")
        assert first is not None
        # The renewer is still running, so the TTL stays at its full value.
        with pytest.raises(ProviderBusy):
            await a.acquire_graph_lease(provider, owner="agg_self")
        first.renew_task.cancel()

    _run(scenario())


def test_a_lease_lost_to_another_holder_is_published_to_the_writer():
    """A lease is only a fence if the writer reads it. The renewer stops when
    the key holds somebody else's token; it must also SAY so, or the pipeline
    keeps writing a graph it no longer owns."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()

        # Drive the renewer on a test cadence rather than the production 20s:
        # a unit test that sleeps a renew interval is a unit test nobody runs.
        original = adm._GRAPH_LEASE_RENEW_SECS
        adm._GRAPH_LEASE_RENEW_SECS = 0.01
        try:
            lease = await a.acquire_graph_lease(provider, owner="agg_one")
            assert lease is not None and not lease.is_lost()
            redis.kv[lease.key] = "somebody-else|agg_two|other-host"
            for _ in range(200):
                if lease.is_lost():
                    break
                await asyncio.sleep(0.01)
            assert lease.is_lost()
            lease.renew_task.cancel()
        finally:
            adm._GRAPH_LEASE_RENEW_SECS = original

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


# ── the per-node reservation ledger ─────────────────────────────────────


def test_reservations_are_per_node_exclude_the_holder_and_are_released():
    """Two rebuilds on one node: each budgets against what the OTHER holds,
    a reservation is replaced (never summed) as the apply lands, and a
    release leaves nothing behind."""
    async def scenario():
        redis = _FakeRedis()
        a, b = adm.AggregationAdmission(redis), adm.AggregationAdmission(redis)
        ra = await a.reserve("10.0.0.1:6379", "job-a", 3 * GB)
        assert ra is not None and ra.bytes == 3 * GB and ra.endpoint == "10.0.0.1:6379"
        assert await a.reserved_by_others("10.0.0.1:6379", "job-a") == (0, 0)      # never its own
        assert await b.reserved_by_others("10.0.0.1:6379", "job-b") == (3 * GB, 1)
        assert await b.reserved_by_others("10.0.0.2:6379", "job-b") == (0, 0)      # another node
        rb = await b.reserve("10.0.0.1:6379", "job-b", GB)
        assert await a.reserved_by_others("10.0.0.1:6379", "job-a") == (GB, 1)
        assert await b.reserved_by_others("10.0.0.1:6379", "job-b") == (3 * GB, 1)
        await a.update(ra, GB // 2)                                                  # the remainder shrinks
        assert await b.reserved_by_others("10.0.0.1:6379", "job-b") == (GB // 2, 1)
        await a.release(ra)
        await asyncio.sleep(0)
        assert ra.renew_task.cancelled()
        assert await b.reserved_by_others("10.0.0.1:6379", "job-b") == (0, 0)
        await b.release(rb)
        assert redis.hashes[adm.reservation_key("10.0.0.1:6379")] == {}
        # An unknown node, or no job id, holds nothing.
        assert await a.reserve("unknown", "job-a", GB) is None
        assert await a.reserve("10.0.0.1:6379", "", GB) is None

    _run(scenario())


def test_a_reservation_is_renewed_and_a_dead_holders_entry_expires(monkeypatch):
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        monkeypatch.setattr(adm, "_GRAPH_LEASE_RENEW_SECS", 0.01)
        key = adm.reservation_key("n1")
        r = await a.reserve("n1", "job-a", GB)
        first = json.loads(redis.hashes[key]["job-a"])
        await asyncio.sleep(0.05)
        renewed = json.loads(redis.hashes[key]["job-a"])
        assert redis.hset_calls >= 2 and renewed["expires_at"] >= first["expires_at"]
        assert renewed["bytes"] == GB and renewed["host"]
        await a.release(r)
        # A holder that died leaves an entry whose expiry is past; garbage
        # beside it; a client that answers in bytes. Only the live one counts,
        # and the rest is pruned on the way.
        redis.hashes[key] = {
            "dead": json.dumps({"bytes": 5 * GB, "expires_at": time.time() - 1, "host": "x"}),
            "garbage": "not json",
            b"live": json.dumps({"bytes": GB, "expires_at": time.time() + 60, "host": "y"}).encode(),
        }
        assert await a.reserved_by_others("n1", "me") == (GB, 1)
        assert set(redis.hashes[key]) == {b"live"}
        live = await adm.read_reservations(redis, "n1")
        assert set(live) == {"live"} and live["live"]["bytes"] == GB and live["live"]["host"] == "y"

    _run(scenario())


def test_the_ledger_fails_open_when_redis_is_down():
    async def scenario():
        a = adm.AggregationAdmission(_DownRedis())
        assert await a.reserve("n1", "job", GB) is None              # nothing held
        assert await a.reserved_by_others("n1", "job") == (0, 0)      # the node is measured alone
        await a.update(None, GB)
        await a.release(None)
        with pytest.raises(ConnectionError):
            await adm.read_reservations(_DownRedis(), "n1")           # the raw read raises; callers fail open

    _run(scenario())


def test_read_slots_cap_scans_separately_from_writes():
    """Rebuild SCANS get their own, larger semaphore. A rebuild reads far
    more than it writes and — running under ``read_from_master_only`` — reads
    from the MASTER, so the writes-only cap left the thing that actually
    saturates a node's query threads unbounded. Separate keys, because a
    scan waiting behind a write (or the reverse) is not the trade either
    limit was chosen for."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()
        reads = f"agg:readslots:{adm.endpoint_key(provider)}"
        writes = f"agg:writeslots:{adm.endpoint_key(provider)}"

        held = [a.read_slot(provider) for _ in range(adm._READ_SLOT_LIMIT)]
        for slot in held:
            await slot.__aenter__()
        assert len(redis.zsets[reads]) == adm._READ_SLOT_LIMIT
        assert not redis.zsets.get(writes)

        # A write still admits while every read slot is taken.
        async with a.write_slot(provider):
            assert len(redis.zsets[writes]) == 1

        orig = adm._SLOT_WAIT_MAX_SECS
        adm._SLOT_WAIT_MAX_SECS = 0.0
        try:
            extra = a.read_slot(provider)
            await extra.__aenter__()
            assert len(redis.zsets[reads]) == adm._READ_SLOT_LIMIT  # over-admitted, not added
            await extra.__aexit__(None, None, None)
        finally:
            adm._SLOT_WAIT_MAX_SECS = orig

        for slot in held:
            await slot.__aexit__(None, None, None)
        assert len(redis.zsets[reads]) == 0

    _run(scenario())


def test_a_read_slot_is_keyed_by_the_node_not_the_seed():
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        provider = _FakeProvider()
        async with a.read_slot(provider, node="10.0.0.7:6379"):
            assert list(redis.zsets) == ["agg:readslots:10.0.0.7:6379"]

    _run(scenario())


def test_read_slots_fail_open_when_redis_is_down():
    async def scenario():
        a = adm.AggregationAdmission(_DownRedis())
        async with a.read_slot(_FakeProvider()):
            pass          # a bus outage must never stop a scan

    _run(scenario())


# ── the slots and the node's threads, compared at last ───────────────────
#
# The slot envs live in a ConfigMap and THREAD_COUNT in a StatefulSet, set
# by different people solving different problems. The shipped base pair
# (2 + 4) is exactly the production-cluster overlay's whole query width, and
# nothing anywhere compared the two numbers — the pipeline read the thread
# count off the node on every write batch and never looked at it.


def test_a_node_whose_threads_the_slots_would_fill_says_so_once():
    adm._SLOTS_CHECKED.clear()
    try:
        adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT = 2, 4
        first = adm.check_slot_sizing("10.0.0.1:6379", 6)
        assert first and "THREAD_COUNT 6" in first and "6 of 4 available" in first
        # Once per node per process: this runs on every write batch.
        assert adm.check_slot_sizing("10.0.0.1:6379", 6) is None
        # …and per NODE, because the shards need not be sized alike.
        assert adm.check_slot_sizing("10.0.0.2:6379", 6) is not None
    finally:
        adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT = 2, 4
        adm._SLOTS_CHECKED.clear()


def test_slots_inside_the_budget_are_silent_and_so_is_an_unknown_count():
    adm._SLOTS_CHECKED.clear()
    orig = adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT
    try:
        # The overlay's own patch: 1 + 3 against THREAD_COUNT 6.
        adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT = 1, 3
        assert adm.check_slot_sizing("10.0.0.1:6379", 6) is None
        # Exactly at the line is inside it.
        adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT = 2, 2
        assert adm.check_slot_sizing("10.0.0.2:6379", 6) is None
        # A node that did not say is never warned about — and is not
        # remembered either, so the next reading still gets to check.
        adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT = 8, 8
        assert adm.check_slot_sizing("10.0.0.3:6379", None) is None
        assert adm.check_slot_sizing("10.0.0.3:6379", 0) is None
        assert adm.check_slot_sizing("10.0.0.3:6379", 6) is not None
    finally:
        adm._SLOT_LIMIT, adm._READ_SLOT_LIMIT = orig
        adm._SLOTS_CHECKED.clear()


def test_the_check_runs_where_the_reading_lands():
    """A check nobody calls is a comment. The governor's measured reading is
    the only place the node's THREAD_COUNT and this pod's envs meet."""
    import inspect

    from backend.app.providers.falkordb_materialize import AggregationPipeline

    src = inspect.getsource(AggregationPipeline._governor_reading)
    assert "check_slot_sizing" in src


def test_on_a_cluster_an_unnamed_node_reads_no_pressure_at_all():
    """The stamp half refuses to WRITE the seed key on a cluster, because a
    seed is shared by every shard and a stamp there tells all three shards'
    writers to slow for one shard's starving readers. The reading half kept
    falling back to it — and found whatever a pre-fix stamp had left, on a
    key nothing keyed to a shard ever writes. It fell back exactly when the
    governor had no measured reading to name a node with: under load."""
    async def scenario():
        redis = _FakeRedis()
        a = adm.AggregationAdmission(redis)
        cluster = _FakeProvider()
        cluster._conn_cfg = types.SimpleNamespace(mode="cluster", host="seed", port=6379)
        await redis.set(adm.read_pressure_key("seed:6379"), "queue_full")

        assert await a.read_pressure(cluster) is None
        # Named node, named key: the signal still works where it is aimed.
        await redis.set(adm.read_pressure_key("10.0.0.7:6379"), "queue_full")
        assert await a.read_pressure(cluster, node="10.0.0.7:6379") == "queue_full"

        # Standalone has one node, and the connection endpoint IS that node.
        single = _FakeProvider()
        single._conn_cfg = types.SimpleNamespace(mode="standalone", host="seed", port=6379)
        assert await a.read_pressure(single) == "queue_full"

    _run(scenario())
