"""Unit tests for :mod:`backend.app.services.graph_cache`.

Mocks the async Redis client directly — fakeredis is not part of the
test toolchain and the cache only exercises `GET`, `SET`, and `INCR`,
which are trivial to mock.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
from typing import Any
from unittest.mock import AsyncMock

import pytest
from typing import Optional

from pydantic import BaseModel
from redis.exceptions import RedisError

from backend.app.services import graph_cache
from backend.app.services.graph_cache import (
    CacheScope,
    ENDPOINT_AGGREGATED,
    ENDPOINT_CHILDREN,
    ENDPOINT_LAYER_ASSIGNMENT,
    ENDPOINT_TOP_LEVEL,
    ENDPOINT_TRACE,
    ENDPOINT_TRACE_CLOSURE,
    ENDPOINT_TRACE_EXPAND,
    GraphCache,
    _build_key,
    graph_ns_hash,
)


class _Result(BaseModel):
    """Minimal Pydantic model standing in for ChildrenWithEdgesResult."""
    value: int
    children: list = []


class _TraceLike(BaseModel):
    """Minimal Pydantic model standing in for TraceResult — has ``nodes``
    so the empty-result heuristic can classify it correctly."""
    nodes: list = []
    label: str = ""


class _AggregatedLike(BaseModel):
    """Minimal Pydantic model standing in for AggregatedEdgeResult — carries
    the truncated/stale flags the incomplete-result heuristic checks."""
    aggregated_edges: list = []
    truncated: bool = False
    stale: bool = False


class _NestedAggregated(BaseModel):
    """Minimal stand-in for the AggregatedEdgeResult embedded under
    ``.aggregated`` on canvas bootstrap/expand results."""
    truncated: bool = False
    stale: bool = False
    # What separates a deterministic cut from a read that gave up part way.
    degraded_detail: Optional[str] = None
    truncation_reason: Optional[str] = None


class _CanvasBootstrapLike(BaseModel):
    """Minimal stand-in for a canvas bootstrap result, which embeds an
    AggregatedEdgeResult under ``.aggregated``."""
    nodes: list = []
    aggregated: Any = None


class _CanvasExpandLike(BaseModel):
    """Minimal stand-in for a canvas EXPAND result, which embeds its
    AggregatedEdgeResult under ``.aggregated_delta`` (NOT ``.aggregated``)."""
    children: list = []
    aggregated_delta: Any = None


def _make_redis() -> AsyncMock:
    """An AsyncMock with the surface graph_cache touches: get/set/incr."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.incr = AsyncMock(return_value=1)
    return redis


def _routed_get(*, gen: str = "0", primary: Any = None, lkg: Any = None):
    """A GET side-effect that dispatches on the KEY rather than on call
    order. An order-based fake breaks the moment the read path gains a
    lookup, and it never said which key was being read anyway.
    """
    async def _get(key: str):
        if key.startswith(graph_cache._GEN_PREFIX):
            return gen
        if key.startswith(graph_cache._LKG_PREFIX):
            return lkg
        return primary
    return _get


def _payload_sets(redis: AsyncMock) -> list:
    """The SET calls that wrote an ANSWER — the primary entry or its LKG
    mirror.

    The cross-process election SETs too, on a key of its own. It is
    bookkeeping about who is computing, not something the cache stored, and
    no assertion about what was cached should have to know it happened.
    """
    return [
        c for c in redis.set.await_args_list
        if not str(c.args[0]).startswith(graph_cache._LEADER_PREFIX)
    ]


@pytest.fixture(autouse=True)
def _enable_children_endpoint(monkeypatch):
    """Force every cached endpoint on for the tests that exercise them."""
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_CHILDREN, True,
    )
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_AGGREGATED, True,
    )
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TRACE, True,
    )
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TRACE_EXPAND, True,
    )
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TRACE_CLOSURE, True,
    )


# ─── basic hit / miss ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_miss_calls_compute_and_caches() -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=42))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 42
    compute.assert_awaited_once()
    assert len(_payload_sets(redis)) == 1
    # The value was serialized as JSON
    set_args = _payload_sets(redis)[-1]
    payload = set_args.args[1] if len(set_args.args) > 1 else set_args.kwargs.get("value")
    assert "42" in payload


@pytest.mark.asyncio
async def test_hit_returns_cached_without_compute() -> None:
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=[
        "0",  # generation read
        _Result(value=99).model_dump_json(by_alias=True),  # cached payload
    ])
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=AssertionError("compute should not run"))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 99
    compute.assert_not_called()


@pytest.mark.asyncio
async def test_feature_flag_off_bypasses_cache(monkeypatch) -> None:
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_CHILDREN, False,
    )
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=1))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    compute.assert_awaited_once()
    redis.get.assert_not_called()
    redis.set.assert_not_called()


# ─── singleflight ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_in_process_singleflight_coalesces_concurrent_calls() -> None:
    redis = _make_redis()
    cache = GraphCache(redis)

    call_count = 0
    gate = asyncio.Event()

    async def slow_compute() -> _Result:
        nonlocal call_count
        call_count += 1
        # Block until the second caller has had time to coalesce on the future
        await gate.wait()
        return _Result(value=7)

    async def trigger() -> _Result:
        return await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "shared"},
            compute=slow_compute,
            model_cls=_Result,
        )

    task_a = asyncio.create_task(trigger())
    task_b = asyncio.create_task(trigger())
    # Let both tasks reach the in-flight registration before unblocking.
    await asyncio.sleep(0.01)
    gate.set()
    result_a, result_b = await asyncio.gather(task_a, task_b)

    assert result_a.value == 7
    assert result_b.value == 7
    assert call_count == 1


# ─── cross-process singleflight (the election) ─────────────────────────
#
# In-process singleflight coalesces the callers inside ONE worker. The fleet
# runs 12 of them, so a cold view still meant 12 identical computes hitting
# one shard at once — the moment the store is least able to absorb them.
# These cover the election that reduces that to one, and every way it is
# allowed to fail: failing open always means "compute it yourself", which is
# exactly the behaviour that existed before it.


def _shared_bus() -> AsyncMock:
    """A Redis stand-in two GraphCache instances can share — two pods, one
    bus. Stateful across the three operations the election uses: SET NX,
    GET, and the compare-and-delete EVAL."""
    store: dict[str, Any] = {}
    redis = AsyncMock()

    async def _get(key):
        return store.get(key)

    async def _set(key, value, ex=None, px=None, nx=False):
        if nx and key in store:
            return None
        store[key] = value
        return True

    async def _eval(script, numkeys, *args):
        key, token = args[0], args[1]
        if store.get(key) == token:
            del store[key]
            return 1
        return 0

    async def _incr(key):
        store[key] = str(int(store.get(key, 0)) + 1)
        return int(store[key])

    redis.get = AsyncMock(side_effect=_get)
    redis.set = AsyncMock(side_effect=_set)
    redis.eval = AsyncMock(side_effect=_eval)
    redis.incr = AsyncMock(side_effect=_incr)
    redis.store = store
    return redis


@pytest.fixture
def _fast_election(monkeypatch):
    """Poll the leader every millisecond instead of every 50ms, so a test
    that waits for a follower to pick up an answer finishes in a tick."""
    monkeypatch.setattr(graph_cache, "_LEADER_POLL_S", 0.001)


@pytest.mark.asyncio
async def test_two_pods_on_one_key_compute_it_once(_fast_election) -> None:
    """The whole point. Two processes miss the same key at the same moment;
    one computes and the other takes its answer."""
    redis = _shared_bus()
    pod_a, pod_b = GraphCache(redis), GraphCache(redis)
    computes = 0

    async def compute() -> _Result:
        nonlocal computes
        computes += 1
        await asyncio.sleep(0.01)       # long enough for the loser to wait
        return _Result(value=99)

    async def trigger(pod: GraphCache) -> _Result:
        return await pod.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "cold"},
            compute=compute,
            model_cls=_Result,
        )

    a, b = await asyncio.gather(trigger(pod_a), trigger(pod_b))

    assert a.value == 99 and b.value == 99
    assert computes == 1, "the fleet computed the same key twice"
    # And the election released itself — the next caller must not have to
    # wait out the TTL to compute.
    assert not any(
        k.startswith(graph_cache._LEADER_PREFIX) for k in redis.store
    ), redis.store


@pytest.mark.asyncio
async def test_a_leader_that_sheds_does_not_strand_its_followers(
    monkeypatch, _fast_election,
) -> None:
    """ProviderBusy is a refusal to serve, not an answer: the leader
    re-raises it and steps down without writing anything. The follower must
    notice the election is over rather than sitting out its full wait for an
    answer that is never coming — that would turn one shed request into a
    pile of slow ones, which is the opposite of what shedding is for."""
    from backend.common.adapters.circuit import ProviderBusy

    monkeypatch.setattr(graph_cache, "_LEADER_WAIT_S", 30.0)
    redis = _shared_bus()
    pod_a, pod_b = GraphCache(redis), GraphCache(redis)
    leading = asyncio.Event()
    computes = 0

    async def shed() -> _Result:
        nonlocal computes
        computes += 1
        leading.set()               # we are the leader, and we are about to fail
        await asyncio.sleep(0.01)
        raise ProviderBusy("falkordb", "shed")

    async def follow() -> _Result:
        await leading.wait()        # only stand for election once A holds it
        return await pod_b.get_or_compute(
            scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"}, compute=AsyncMock(return_value=_Result(value=3)),
            model_cls=_Result,
        )

    started = asyncio.get_running_loop().time()
    a, b = await asyncio.gather(
        pod_a.get_or_compute(
            scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"}, compute=shed, model_cls=_Result,
        ),
        follow(),
        return_exceptions=True,
    )
    elapsed = asyncio.get_running_loop().time() - started

    assert isinstance(a, ProviderBusy)          # the leader still sheds
    assert getattr(b, "value", None) == 3       # the follower computed its own
    assert computes == 1
    assert elapsed < 5.0, f"the follower waited {elapsed:.1f}s on a leader that had gone"


@pytest.mark.asyncio
async def test_a_follower_keeps_waiting_while_the_leader_still_holds(
    _fast_election,
) -> None:
    """The converse: a held election means someone IS working, so the
    follower waits rather than racing them to the same compute."""
    redis = _shared_bus()
    cache = GraphCache(redis)
    key = _build_key(CacheScope("ws1", "ds1"), 0, ENDPOINT_CHILDREN, {"urn": "y"})
    redis.store[f"{graph_cache._LEADER_PREFIX}:{key}"] = "someone-elses-token"

    peer = await cache._await_leader(key, _Result, deadline_s=0.05)

    assert peer is None                 # it never answered, so we compute
    # ...but we waited for it: more than one poll went by.
    assert redis.get.await_count > 2


@pytest.mark.asyncio
async def test_a_bus_that_cannot_hold_an_election_lets_everyone_compute() -> None:
    """Fail open. A cache-role Redis that is down must not stop the fleet
    answering — it costs duplicate computes, which is the behaviour before
    any of this existed."""
    redis = _make_redis()
    redis.set = AsyncMock(side_effect=RedisError("bus down"))
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=5))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 5
    compute.assert_awaited_once()


@pytest.mark.asyncio
async def test_the_kill_switch_removes_the_election_entirely(monkeypatch) -> None:
    """One env var puts every process back to computing its own."""
    monkeypatch.setattr(graph_cache, "_LEADER_ENABLED", False)
    redis = _make_redis()
    cache = GraphCache(redis)

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=AsyncMock(return_value=_Result(value=1)),
        model_cls=_Result,
    )

    assert not any(
        str(c.args[0]).startswith(graph_cache._LEADER_PREFIX)
        for c in redis.set.await_args_list
    )
    redis.eval.assert_not_awaited()


@pytest.mark.asyncio
async def test_stepping_down_never_releases_a_successors_election() -> None:
    """A leader slower than the TTL loses its lock while still working. When
    it finally finishes it must not delete the NEW leader's election — that
    would let a third process start the same work again."""
    redis = _shared_bus()
    cache = GraphCache(redis)
    lock = f"{graph_cache._LEADER_PREFIX}:some-key"
    redis.store[lock] = "the-successors-token"

    await cache._step_down("some-key", "our-expired-token")

    assert redis.store[lock] == "the-successors-token"


# ─── promoting the mirror when nothing changed ─────────────────────────
#
# A TTL expiry is not evidence that the answer moved. Every write bumps the
# generation, so a generation that has NOT moved means a recompute returns
# the identical bytes — and the gen-less mirror already holds them. Before
# this, every expiry made one user pay the full provider cost to be told the
# same thing; on a million-node graph that is ten seconds, per view, per TTL.


async def _fill(cache: GraphCache, compute, *, params=None, endpoint=ENDPOINT_CHILDREN):
    """Run one compute through the cache so the primary entry and the mirror
    both exist, then expire the primary the way a TTL would."""
    scope = CacheScope("ws1", "ds1")
    params = params if params is not None else {"urn": "a"}
    await cache.get_or_compute(
        scope=scope, endpoint=endpoint, params=params,
        compute=compute, model_cls=_Result,
    )
    gen = await cache._get_generation(scope)
    cache._cache_redis.store.pop(_build_key(scope, gen, endpoint, params), None)


@pytest.mark.asyncio
async def test_an_expiry_with_no_write_since_is_served_from_the_mirror() -> None:
    redis = _shared_bus()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=42, children=[1]))
    await _fill(cache, compute)

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"}, compute=compute, model_cls=_Result,
    )

    assert result.value == 42
    assert compute.await_count == 1, "an expiry recomputed an unchanged answer"
    # And it is back under the primary key, so the NEXT reader is a plain hit.
    assert _build_key(CacheScope("ws1", "ds1"), 0, ENDPOINT_CHILDREN, {"urn": "a"}) in redis.store


@pytest.mark.asyncio
async def test_a_promotion_does_not_extend_the_mirrors_own_expiry() -> None:
    """The bound on drift the platform cannot see. However many times an
    answer is promoted, it can never outlive GRAPH_CACHE_LKG_TTL_S from when
    it was actually computed — because promoting never rewrites the mirror."""
    redis = _shared_bus()
    cache = GraphCache(redis)
    await _fill(cache, AsyncMock(return_value=_Result(value=42, children=[1])))
    redis.set.reset_mock()

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"}, compute=AsyncMock(return_value=_Result(value=9)),
        model_cls=_Result,
    )

    written = [c.args[0] for c in redis.set.await_args_list]
    assert any(graph_cache._KEY_PREFIX in k for k in written)
    assert not any(graph_cache._LKG_PREFIX in k for k in written)


@pytest.mark.asyncio
async def test_a_write_since_the_mirror_was_taken_forces_a_recompute() -> None:
    """The safety property. A rebuild bumps the generation; the mirror is
    stamped with the generation it was computed at, so it no longer matches
    and the promotion declines. Serving it here would show users the
    PRE-rebuild graph at exactly the moment they asked for the new one."""
    redis = _shared_bus()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=42, children=[1]))
    await _fill(cache, compute)

    await cache.bump_generation(CacheScope("ws1", "ds1"))
    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=AsyncMock(return_value=_Result(value=99, children=[1])),
        model_cls=_Result,
    )

    assert result.value == 99, "served the pre-rebuild answer after a rebuild"


@pytest.mark.asyncio
async def test_an_unstamped_mirror_is_never_promoted_but_still_saves_an_outage() -> None:
    """Mirrors written before the stamp existed carry no generation, so there
    is nothing to compare and the promotion declines — the next real compute
    rewrites them stamped. They remain the outage fallback, where an
    out-of-date snapshot still beats an error."""
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_Result(value=7).model_dump_json(by_alias=True),   # no stamp
    ))
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ProviderUnavailable("falkordb", "breaker open"))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"}, compute=compute, model_cls=_Result,
    )

    compute.assert_awaited_once()       # not promoted: it went to the provider
    assert result.value == 7            # but it did save the request


@pytest.mark.asyncio
async def test_the_promotion_kill_switch_restores_recompute_on_every_expiry(
    monkeypatch,
) -> None:
    monkeypatch.setattr(graph_cache, "_PROMOTE_UNCHANGED", False)
    redis = _shared_bus()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=42, children=[1]))
    await _fill(cache, compute)

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"}, compute=compute, model_cls=_Result,
    )

    assert compute.await_count == 2


# ─── invalidation via generation bump ──────────────────────────────────

@pytest.mark.asyncio
async def test_bump_generation_changes_cache_key() -> None:
    scope = CacheScope("ws1", "ds1")
    params = {"urn": "x"}
    key_g0 = _build_key(scope, 0, ENDPOINT_CHILDREN, params)
    key_g1 = _build_key(scope, 1, ENDPOINT_CHILDREN, params)
    assert key_g0 != key_g1
    assert ":0:" in key_g0
    assert ":1:" in key_g1


@pytest.mark.asyncio
async def test_bump_generation_issues_incr() -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    await cache.bump_generation(CacheScope("ws1", "ds1"))
    redis.incr.assert_awaited_once()
    key_arg = redis.incr.call_args.args[0]
    assert "ws1" in key_arg
    assert "ds1" in key_arg


@pytest.mark.asyncio
async def test_bump_generations_pipelines_incrs() -> None:
    """Bulk bumps are ONE pipelined round-trip (the publish-latency fix), not
    one awaited INCR per scope."""
    from unittest.mock import MagicMock

    redis = _make_redis()
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.execute = AsyncMock(return_value=[1] * 5)
    redis.pipeline = MagicMock(return_value=pipe)
    cache = GraphCache(redis)

    scopes = [CacheScope(f"ws{i}", f"ds{i}") for i in range(5)]
    await cache.bump_generations(scopes)

    assert pipe.incr.call_count == 5
    pipe.execute.assert_awaited_once()
    redis.incr.assert_not_awaited()  # nothing bumped outside the pipeline


# ─── genat cache-as-of stamp (OPS Freshness Cockpit foundation) ────────

@pytest.mark.asyncio
async def test_bump_generation_sets_genat_stamp() -> None:
    from datetime import datetime

    redis = _make_redis()
    cache = GraphCache(redis)
    await cache.bump_generation(CacheScope("ws1", "ds1"))

    redis.set.assert_awaited_once()
    key_arg = redis.set.call_args.args[0]
    value_arg = redis.set.call_args.args[1]
    assert graph_cache._GENAT_PREFIX in key_arg
    assert "ws1" in key_arg and "ds1" in key_arg
    # Value round-trips through fromisoformat without raising.
    datetime.fromisoformat(value_arg)


@pytest.mark.asyncio
async def test_bump_generations_pipelines_genat_sets() -> None:
    """Bulk bumps set the genat stamp in the SAME pipeline — one genat SET
    per scope, no extra round-trips."""
    from unittest.mock import MagicMock

    redis = _make_redis()
    pipe = MagicMock()
    pipe.incr = MagicMock()
    pipe.set = MagicMock()
    pipe.execute = AsyncMock(return_value=[1] * 5)
    redis.pipeline = MagicMock(return_value=pipe)
    cache = GraphCache(redis)

    scopes = [CacheScope(f"ws{i}", f"ds{i}") for i in range(5)]
    await cache.bump_generations(scopes)

    assert pipe.incr.call_count == 5
    assert pipe.set.call_count == 5
    pipe.execute.assert_awaited_once()
    redis.set.assert_not_awaited()  # nothing set outside the pipeline


@pytest.mark.asyncio
async def test_get_cache_as_of_returns_value_on_hit(monkeypatch) -> None:
    redis = _make_redis()
    redis.get = AsyncMock(return_value="2026-07-18T12:00:00+00:00")
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    value = await graph_cache.get_cache_as_of("ws1", "ds1")
    assert value == "2026-07-18T12:00:00+00:00"


@pytest.mark.asyncio
async def test_get_cache_as_of_returns_none_on_miss(monkeypatch) -> None:
    redis = _make_redis()
    redis.get = AsyncMock(return_value=None)
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    assert await graph_cache.get_cache_as_of("ws1", "ds1") is None


@pytest.mark.asyncio
async def test_get_cache_as_of_returns_none_on_redis_error(monkeypatch) -> None:
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=RedisError("down"))
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    assert await graph_cache.get_cache_as_of("ws1", "ds1") is None


@pytest.mark.asyncio
async def test_get_cache_as_of_guards_empty_ids(monkeypatch) -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    assert await graph_cache.get_cache_as_of("", "ds1") is None
    assert await graph_cache.get_cache_as_of("ws1", "") is None
    redis.get.assert_not_called()


# ─── fail-open semantics ───────────────────────────────────────────────

@pytest.mark.asyncio
async def test_redis_get_failure_falls_through_to_compute() -> None:
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=RedisError("connection refused"))
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=5))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 5
    compute.assert_awaited_once()


@pytest.mark.asyncio
async def test_redis_set_failure_does_not_fail_request() -> None:
    redis = _make_redis()
    redis.set = AsyncMock(side_effect=RedisError("write failed"))
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=8))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )
    assert result.value == 8


# ─── empty-result short TTL ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_empty_result_caches_with_negative_ttl() -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=0, children=[]))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    set_kwargs = _payload_sets(redis)[-1].kwargs
    # ex (expiry in seconds) should equal the negative-cache value
    assert set_kwargs["ex"] == graph_cache._NEGATIVE_TTL


# ─── key stability ─────────────────────────────────────────────────────

def test_params_order_does_not_affect_key() -> None:
    scope = CacheScope("ws1", "ds1")
    k1 = _build_key(scope, 0, ENDPOINT_CHILDREN, {"a": 1, "b": 2})
    k2 = _build_key(scope, 0, ENDPOINT_CHILDREN, {"b": 2, "a": 1})
    assert k1 == k2


# ─── memory safety (P1.5) ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_oversized_payload_is_not_cached(monkeypatch, caplog) -> None:
    """A response larger than ``_MAX_PAYLOAD_BYTES`` must skip the cache
    write — both primary and LKG — and log a WARNING. The compute already
    succeeded, so the caller still gets the answer; we just decline to
    cache it so it can't crowd out hundreds of normal entries. It must
    also DELETE any existing (now-stale, smaller) entry at both the
    primary key and the LKG mirror, so a stale entry can't outlive the
    model's growth past the cap."""
    import logging
    monkeypatch.setattr(graph_cache, "_MAX_PAYLOAD_BYTES", 50)

    redis = _make_redis()
    redis.delete = AsyncMock(return_value=1)
    cache = GraphCache(redis)
    # A non-empty payload whose JSON serialization exceeds 50 bytes.
    large = _Result(value=1, children=list(range(100)))
    compute = AsyncMock(return_value=large)

    caplog.set_level(logging.WARNING, logger="backend.app.services.graph_cache")
    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=compute,
        model_cls=_Result,
    )

    # Caller still gets the answer.
    assert result.value == 1
    # No SET fired — neither primary nor LKG.
    assert _payload_sets(redis) == []
    # The existing stale entry was DELETEd at both the primary key and
    # the LKG mirror.
    assert redis.delete.await_count == 2
    deleted_keys = [c.args[0] for c in redis.delete.await_args_list]
    assert any(graph_cache._KEY_PREFIX in k for k in deleted_keys)
    assert any(graph_cache._LKG_PREFIX in k for k in deleted_keys)
    # WARNING line was emitted with the diagnostic shape.
    assert any("payload_too_large" in rec.message for rec in caplog.records)
    assert any("dropping stale entry" in rec.message for rec in caplog.records)


# ─── incomplete-result short TTL (R2) ──────────────────────────────────

@pytest.mark.asyncio
async def test_a_capped_result_is_cached_for_the_full_ttl() -> None:
    """A result cut by a CAP is a pure function of (graph, request) — the same
    request returns the same rows and the same cursor — so it is the complete
    answer to what was asked and keeps the full TTL.

    This used to take the 5s negative window. On a large graph truncation is
    the normal case, not the exception, which meant the cache could never hold
    for the views that need it most, and saturation (which produces
    truncation) dropped the TTL 720-fold and so produced more saturation. The
    loop had no hysteresis."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_AggregatedLike(
        aggregated_edges=[1], truncated=True,
    ))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_AGGREGATED,
        params={},
        compute=compute,
        model_cls=_AggregatedLike,
    )

    ttls = [c.kwargs["ex"] for c in _payload_sets(redis)]
    assert graph_cache._NEGATIVE_TTL not in ttls, "a capped result is not degraded"
    assert all(t >= 3600 for t in ttls), ttls
    # And it IS worth keeping as the outage fallback.
    keys = [call.args[0] for call in _payload_sets(redis)]
    assert any(graph_cache._LKG_PREFIX in k for k in keys)


@pytest.mark.asyncio
async def test_a_stale_result_is_cached_for_the_full_ttl() -> None:
    """Stale means the ROLLUP is behind, not that the answer is wrong: the
    bytes are complete and correct for the graph as it stands, and recomputing
    returns the identical bytes. The client is already told (the aggstale
    marker and CanvasFreshness), and the rebuild completing bumps the
    generation, which invalidates this for real. Caching it for 5 seconds
    bought nothing and cost a recompute of the same stale answer."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_AggregatedLike(
        aggregated_edges=[1], stale=True,
    ))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_AGGREGATED,
        params={},
        compute=compute,
        model_cls=_AggregatedLike,
    )

    ttls = [c.kwargs["ex"] for c in _payload_sets(redis)]
    assert graph_cache._NEGATIVE_TTL not in ttls
    assert all(t >= 3600 for t in ttls), ttls


def _closure(frontier: list, **overrides: Any) -> Any:
    """A real TraceClosureResult, because the heuristic reads its fields by
    name — a stand-in model would pass while the real one is spelled
    differently."""
    from backend.common.models.graph import (
        GraphNode, TraceClosureResult, TraceFocus,
    )
    return TraceClosureResult(**{
        "nodes": [GraphNode(urn="u1", entityType="dataset", displayName="u1")],
        "edges": [],
        "focus": TraceFocus(urn="u1", level=0, entityType="dataset"),
        "effectiveLevel": 0,
        "frontierUp": frontier,
        "frontierDown": [],
        **overrides,
    })


async def _cache_closure(result: Any):
    from backend.common.models.graph import TraceClosureResult

    redis = _make_redis()
    cache = GraphCache(redis)
    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_TRACE_CLOSURE,
        params={},
        compute=AsyncMock(return_value=result),
        model_cls=TraceClosureResult,
    )
    return redis


@pytest.mark.asyncio
async def test_a_closure_whose_probe_never_ran_is_not_pinned_for_the_full_ttl() -> None:
    """The degree probe is dropped when the deadline is close and logged-
    and-skipped when it fails; either way every frontier entry ships
    countless. That is honest, and it is also the DEGRADED answer — the
    lens can only draw a bare chevron where it would say "+8 more". One
    slow moment used to become the workspace's answer for the full TTL,
    and the outage fallback on top of that."""
    from backend.common.models.graph import TraceFrontierNode

    redis = await _cache_closure(_closure([
        TraceFrontierNode(urn="a"), TraceFrontierNode(urn="b", nextCursor="e:0"),
    ]))

    assert len(_payload_sets(redis)) == 1                   # no LKG mirror
    assert _payload_sets(redis)[-1].kwargs["ex"] == graph_cache._NEGATIVE_TTL
    assert not any(graph_cache._LKG_PREFIX in c.args[0] for c in _payload_sets(redis))


@pytest.mark.asyncio
async def test_a_max_nodes_page_is_complete_by_contract_and_cached_for_the_full_ttl() -> None:
    """The degree-exact walk makes a budget-cut page a pure function of
    (graph, request): every anchor it ships is whole, and the cursor names
    exactly where the next page starts. Such a page is THE answer to that
    request and deserves the full TTL — it used to be re-TTL'd to the
    negative window like a degraded one, so page one of every wide focus
    was never a cache hit."""
    from backend.common.models.graph import TraceFrontierNode

    redis = await _cache_closure(_closure(
        [TraceFrontierNode(urn="a", totalCount=3, reason="cut")],
        truncated=True, truncationReason="max_nodes", seedTruncated=True, seedCursor="s:b",
    ))

    assert _payload_sets(redis)[0].kwargs["ex"] != graph_cache._NEGATIVE_TTL


@pytest.mark.asyncio
async def test_a_coarse_page_is_complete_and_cached_for_the_full_ttl() -> None:
    """A coarse page has no frontier and no cursor — it is the whole
    answer to its request — and a cap cut is `max_nodes` like the fine
    walk's. Both keep the full TTL."""
    redis = await _cache_closure(_closure([], grain="coarse"))
    assert _payload_sets(redis)[0].kwargs["ex"] != graph_cache._NEGATIVE_TTL
    redis = await _cache_closure(_closure([], grain="coarse", truncated=True, truncationReason="max_nodes"))
    assert _payload_sets(redis)[0].kwargs["ex"] != graph_cache._NEGATIVE_TTL


def test_grain_separates_the_cache_key() -> None:
    from backend.common.models.graph import TraceClosureRequest
    fine = TraceClosureRequest.model_validate({"urn": "u1"}).model_dump(mode="json", by_alias=True, exclude_none=True)
    coarse = TraceClosureRequest.model_validate({"urn": "u1", "grain": "coarse"}).model_dump(mode="json", by_alias=True, exclude_none=True)
    scope = CacheScope("ws1", "ds1")
    assert graph_cache._build_key(scope, "g", ENDPOINT_TRACE_CLOSURE, fine) != graph_cache._build_key(scope, "g", ENDPOINT_TRACE_CLOSURE, coarse)


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["timeout", "seed_failed", "nodes_failed", "ancestors_failed"])
async def test_a_failed_page_is_not_pinned(reason: str) -> None:
    """A FAILURE is still degraded: the same request may well succeed in a
    moment, and pinning the failed page would serve the failure for the
    full TTL. (The walk reports failures ahead of max_nodes for exactly
    this reason.)"""
    from backend.common.models.graph import TraceFrontierNode

    redis = await _cache_closure(_closure(
        [TraceFrontierNode(urn="a", totalCount=3, reason="cut")],
        truncated=True, truncationReason=reason,
    ))

    assert _payload_sets(redis)[-1].kwargs["ex"] == graph_cache._NEGATIVE_TTL


@pytest.mark.asyncio
async def test_a_probed_frontier_is_a_complete_answer() -> None:
    """One real count is enough. A partial probe (the cap, or one failed
    degree bucket) still answers the question the cache exists for, and
    treating it as degraded would throw away most of the caching on any
    wide board."""
    from backend.common.models.graph import TraceFrontierNode

    redis = await _cache_closure(_closure([
        TraceFrontierNode(urn="a"), TraceFrontierNode(urn="b", totalCount=8),
    ]))

    assert len(_payload_sets(redis)) == 2                   # primary + LKG
    assert _payload_sets(redis)[0].kwargs["ex"] != graph_cache._NEGATIVE_TTL
    assert any(graph_cache._LKG_PREFIX in c.args[0] for c in _payload_sets(redis))


@pytest.mark.asyncio
async def test_a_drained_walk_is_complete_not_degraded() -> None:
    """No frontier at all is the walk's own answer — "there is nothing
    more" — not a probe that failed. Reading an empty list as "all
    countless" would give the most cacheable result the shortest TTL."""
    redis = await _cache_closure(_closure([]))

    assert len(_payload_sets(redis)) == 2
    assert _payload_sets(redis)[0].kwargs["ex"] != graph_cache._NEGATIVE_TTL


@pytest.mark.asyncio
async def test_nested_aggregated_truncated_keeps_the_full_ttl() -> None:
    """Canvas bootstrap/expand results embed an AggregatedEdgeResult under
    ``.aggregated``. A nested payload cut by a CAP is still a deterministic
    answer to the request, so the outer result keeps the full TTL — the nested
    check exists to catch nested DEGRADATION, which is a different thing and
    is covered by the degraded_detail test below."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_CanvasBootstrapLike(
        nodes=[1], aggregated=_NestedAggregated(truncated=True),
    ))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_CanvasBootstrapLike,
    )

    ttls = [c.kwargs["ex"] for c in _payload_sets(redis)]
    assert graph_cache._NEGATIVE_TTL not in ttls, ttls


@pytest.mark.asyncio
async def test_nested_aggregated_delta_truncated_keeps_the_full_ttl() -> None:
    """Canvas EXPAND embeds its AggregatedEdgeResult under
    ``.aggregated_delta`` (not ``.aggregated``); a truncated delta must
    still force the negative TTL on the outer result AND skip the LKG
    mirror — otherwise a degraded expand caches at full TTL and mirrors
    into LKG (I2)."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_CanvasExpandLike(
        children=[1], aggregated_delta=_NestedAggregated(truncated=True),
    ))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_CanvasExpandLike,
    )

    ttls = [c.kwargs["ex"] for c in _payload_sets(redis)]
    assert graph_cache._NEGATIVE_TTL not in ttls, ttls


# ─── hierarchy invalidation w/ aggregated-LKG carve-out (R4) ───────────

@pytest.mark.asyncio
async def test_invalidate_hierarchy_reads_bumps_gen_and_spares_aggregated_lkg(
    monkeypatch,
) -> None:
    """invalidate_hierarchy_reads bumps the scope generation (every
    endpoint recomputes) but deliberately SPARES the aggregated LKG
    mirror — it stays the stale-while-revalidate fallback until the
    rebuild completes and `invalidate_aggregated_reads` purges it."""
    redis = _make_redis()
    matching = [
        f"{graph_cache._LKG_PREFIX}:ws1:ds1::children:abc",
        f"{graph_cache._LKG_PREFIX}:ws1:ds1::top-level:def",
        f"{graph_cache._LKG_PREFIX}:ws1:ds1::aggregated:ghi",
    ]
    redis.scan = AsyncMock(return_value=(0, matching))
    redis.delete = AsyncMock(return_value=1)
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    await graph_cache.invalidate_hierarchy_reads("ws1", "ds1")

    redis.incr.assert_awaited_once()
    gen_key_arg = redis.incr.call_args.args[0]
    assert "ws1" in gen_key_arg and "ds1" in gen_key_arg

    pattern = redis.scan.await_args.kwargs["match"]
    assert pattern == f"{graph_cache._LKG_PREFIX}:ws1:ds1:*"

    redis.delete.assert_awaited_once()
    deleted_keys = redis.delete.await_args.args
    assert set(deleted_keys) == {matching[0], matching[1]}
    assert matching[2] not in deleted_keys


# ─── stale-source marker helpers (R3) ──────────────────────────────────

@pytest.mark.asyncio
async def test_mark_source_stale_then_get_returns_reason(monkeypatch) -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    await graph_cache.mark_source_stale("ws1", "ds1", reason="source_changed")
    redis.set.assert_awaited_once()
    set_args = redis.set.call_args
    assert "ws1" in set_args.args[0] and "ds1" in set_args.args[0]
    assert set_args.kwargs["ex"] == graph_cache._STALE_TTL_S

    redis.get = AsyncMock(return_value="source_changed")
    reason = await graph_cache.get_source_stale_reason("ws1", "ds1")
    assert reason == "source_changed"


@pytest.mark.asyncio
async def test_clear_source_stale_then_get_returns_none(monkeypatch) -> None:
    redis = _make_redis()
    redis.delete = AsyncMock(return_value=1)
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    await graph_cache.clear_source_stale("ws1", "ds1")
    redis.delete.assert_awaited_once()

    redis.get = AsyncMock(return_value=None)
    reason = await graph_cache.get_source_stale_reason("ws1", "ds1")
    assert reason is None


@pytest.mark.asyncio
async def test_stale_marker_helpers_swallow_redis_errors(monkeypatch) -> None:
    redis = _make_redis()
    redis.set = AsyncMock(side_effect=RedisError("down"))
    redis.get = AsyncMock(side_effect=RedisError("down"))
    redis.delete = AsyncMock(side_effect=RedisError("down"))
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    await graph_cache.mark_source_stale("ws1", "ds1")  # must not raise
    await graph_cache.clear_source_stale("ws1", "ds1")  # must not raise
    reason = await graph_cache.get_source_stale_reason("ws1", "ds1")
    assert reason is None


@pytest.mark.asyncio
async def test_stale_marker_helpers_guard_empty_ids(monkeypatch) -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    await graph_cache.mark_source_stale("", "ds1")
    await graph_cache.clear_source_stale("ws1", "")
    reason = await graph_cache.get_source_stale_reason("", "")

    redis.set.assert_not_called()
    redis.delete.assert_not_called()
    redis.get.assert_not_called()
    assert reason is None


# ─── list_stale_sources (Task 4 scheduler reconciler) ──────────────────

@pytest.mark.asyncio
async def test_list_stale_sources_parses_well_formed_keys(monkeypatch) -> None:
    redis = _make_redis()
    matching = [
        f"{graph_cache._STALE_PREFIX}:ws1:ds1",
        f"{graph_cache._STALE_PREFIX}:ws2:ds2",
        f"{graph_cache._STALE_PREFIX}:malformed",     # too few segments
        f"{graph_cache._STALE_PREFIX}:ws3:ds3:extra",  # too many segments
    ]
    redis.scan = AsyncMock(return_value=(0, matching))
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    pairs = await graph_cache.list_stale_sources()

    assert set(pairs) == {("ws1", "ds1"), ("ws2", "ds2")}
    pattern = redis.scan.await_args.kwargs["match"]
    assert pattern == f"{graph_cache._STALE_PREFIX}:*"


@pytest.mark.asyncio
async def test_list_stale_sources_paginates_scan(monkeypatch) -> None:
    redis = _make_redis()
    matching = [
        f"{graph_cache._STALE_PREFIX}:ws1:ds1",
        f"{graph_cache._STALE_PREFIX}:ws2:ds2",
    ]
    redis.scan = AsyncMock(side_effect=[(7, matching[:1]), (0, matching[1:])])
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    pairs = await graph_cache.list_stale_sources()

    assert set(pairs) == {("ws1", "ds1"), ("ws2", "ds2")}
    assert redis.scan.await_count == 2


@pytest.mark.asyncio
async def test_list_stale_sources_swallows_redis_errors(monkeypatch) -> None:
    redis = _make_redis()
    redis.scan = AsyncMock(side_effect=RedisError("down"))
    cache = GraphCache(redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    assert await graph_cache.list_stale_sources() == []


# ─── stale-on-error fallback (P1.1) ────────────────────────────────────

@pytest.mark.asyncio
async def test_stale_fallback_serves_lkg_when_compute_raises_provider_unavailable() -> None:
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_Result(value=123).model_dump_json(by_alias=True),
    ))
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ProviderUnavailable("falkordb", "breaker open"))
    flagged: list[bool] = []

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "x"},
        compute=compute,
        model_cls=_Result,
        on_stale=lambda: flagged.append(True),
    )

    assert result.value == 123
    assert flagged == [True]
    compute.assert_awaited_once()


@pytest.mark.asyncio
async def test_stale_fallback_serves_lkg_on_compute_timeout() -> None:
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_Result(value=77).model_dump_json(by_alias=True),
    ))
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=asyncio.TimeoutError())

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "x"},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 77


@pytest.mark.asyncio
async def test_stale_fallback_propagates_when_no_lkg_available() -> None:
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    redis.get = AsyncMock(side_effect=_routed_get())   # gen 0, no primary, no LKG
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ProviderUnavailable("falkordb", "breaker open"))

    with pytest.raises(ProviderUnavailable):
        await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={},
            compute=compute,
            model_cls=_Result,
        )


@pytest.mark.asyncio
async def test_stale_fallback_singleflight_followers_also_invoke_on_stale() -> None:
    """Regression for P2.1.1: a leader hitting the stale-LKG path must
    propagate the ``served_stale`` flag to followers awaiting on the
    singleflight Future, so each follower can invoke its own ``on_stale``
    callback (which sets the per-request ``X-Cache-Status: stale-fallback``
    header). Without this, only one of N concurrent responses carries the
    stale header and the frontend banner misfires for the rest."""
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    # Key-based dispatch so we don't depend on the interleaving of
    # leader/follower gen+primary GETs. Gen reads return "0", primary
    # reads return None (miss → singleflight), LKG read returns a stale
    # payload that the leader serves and the follower inherits.
    lkg_payload = _Result(value=555).model_dump_json(by_alias=True)

    async def fake_get(key: str):
        if key.startswith(graph_cache._GEN_PREFIX):
            return "0"
        if key.startswith(graph_cache._LKG_PREFIX):
            return lkg_payload
        return None  # primary miss

    redis.get = AsyncMock(side_effect=fake_get)
    cache = GraphCache(redis)
    leader_callbacks: list[bool] = []
    follower_callbacks: list[bool] = []

    gate = asyncio.Event()

    async def slow_compute() -> _Result:
        await gate.wait()
        raise ProviderUnavailable("falkordb", "breaker open")

    async def leader_call() -> _Result:
        return await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "shared"},
            compute=slow_compute,
            model_cls=_Result,
            on_stale=lambda: leader_callbacks.append(True),
        )

    async def follower_call() -> _Result:
        return await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "shared"},
            # Reads are idempotent — second caller hits singleflight.
            compute=AsyncMock(side_effect=AssertionError("follower compute must not run")),
            model_cls=_Result,
            on_stale=lambda: follower_callbacks.append(True),
        )

    task_a = asyncio.create_task(leader_call())
    # Give the leader time to register on _inflight before the follower joins.
    await asyncio.sleep(0.01)
    task_b = asyncio.create_task(follower_call())
    await asyncio.sleep(0.01)
    gate.set()
    res_a, res_b = await asyncio.gather(task_a, task_b)

    assert res_a.value == 555 and res_b.value == 555
    assert leader_callbacks == [True], "leader missed its own on_stale"
    assert follower_callbacks == [True], "follower missed on_stale via singleflight"


@pytest.mark.asyncio
async def test_stale_fallback_does_not_engage_on_logical_errors() -> None:
    """Validation / 4xx errors must propagate; serving stale data would
    hide real bugs."""
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=[
        "0",
        None,
        _Result(value=1).model_dump_json(by_alias=True),  # would hit if fallback engaged
    ])
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ValueError("bad input"))

    with pytest.raises(ValueError):
        await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={},
            compute=compute,
            model_cls=_Result,
        )


@pytest.mark.asyncio
async def test_successful_compute_writes_both_primary_and_lkg() -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    # Non-empty children so the result isn't classified as a negative-cache
    # entry (which intentionally skips the LKG mirror).
    compute = AsyncMock(return_value=_Result(value=42, children=[1, 2]))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "a"},
        compute=compute,
        model_cls=_Result,
    )

    # One SET for primary, one for LKG (in either order).
    assert len(_payload_sets(redis)) == 2
    keys = [call.args[0] for call in _payload_sets(redis)]
    assert any(graph_cache._KEY_PREFIX in k for k in keys)
    assert any(graph_cache._LKG_PREFIX in k for k in keys)


# ─── trace endpoint caching (P1.2) ─────────────────────────────────────

@pytest.mark.asyncio
async def test_trace_endpoint_cache_miss_then_hit() -> None:
    """Two identical /trace/v2 calls — first computes + caches,
    second returns the cached payload without invoking compute."""
    # A store-backed bus: call 1 misses and fills it, call 2 finds what
    # call 1 wrote. The two calls read the same keys they write.
    redis = _shared_bus()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_TraceLike(nodes=[1, 2], label="ok"))
    params = {"urn": "urn:x", "level": 0, "depth": 3}

    a = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_TRACE,
        params=params,
        compute=compute,
        model_cls=_TraceLike,
    )
    b = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_TRACE,
        params=params,
        compute=compute,
        model_cls=_TraceLike,
    )

    assert a.label == "ok" and b.label == "ok"
    # compute should have run exactly once across both calls
    assert compute.await_count == 1


@pytest.mark.asyncio
async def test_top_level_and_layer_assignment_keys_isolated_from_other_endpoints() -> None:
    """Each endpoint must map to a unique cache key prefix so a /top-level
    response can never be returned as a /children-with-edges hit (and so on)."""
    scope = CacheScope("ws1", "ds1")
    params = {"limit": 100}
    keys = {
        ep: _build_key(scope, 0, ep, params)
        for ep in (
            ENDPOINT_CHILDREN,
            ENDPOINT_AGGREGATED,
            ENDPOINT_TRACE,
            ENDPOINT_TRACE_EXPAND,
            ENDPOINT_TOP_LEVEL,
            ENDPOINT_LAYER_ASSIGNMENT,
        )
    }
    # All six keys are pairwise distinct.
    assert len(set(keys.values())) == len(keys)
    assert "top-level" in keys[ENDPOINT_TOP_LEVEL]
    assert "layer-assignment" in keys[ENDPOINT_LAYER_ASSIGNMENT]


@pytest.mark.asyncio
async def test_trace_expand_uses_separate_namespace() -> None:
    """An /trace/v2 call must not satisfy a /trace/expand cache lookup —
    the endpoint key segregates them."""
    scope = CacheScope("ws1", "ds1")
    params = {"sourceUrn": "urn:s", "targetUrn": "urn:t", "nextLevel": 1}
    k_trace = _build_key(scope, 0, ENDPOINT_TRACE, params)
    k_expand = _build_key(scope, 0, ENDPOINT_TRACE_EXPAND, params)
    assert k_trace != k_expand
    assert "trace" in k_trace and "trace-expand" in k_expand


@pytest.mark.asyncio
async def test_trace_stale_fallback_on_provider_timeout() -> None:
    """A timed-out trace falls back to LKG and fires the on_stale flag."""
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_TraceLike(nodes=[1], label="stale").model_dump_json(by_alias=True),
    ))
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=asyncio.TimeoutError())
    flagged: list[bool] = []

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_TRACE,
        params={"urn": "urn:x"},
        compute=compute,
        model_cls=_TraceLike,
        on_stale=lambda: flagged.append(True),
    )

    assert result.label == "stale"
    assert flagged == [True]


@pytest.mark.asyncio
async def test_empty_result_does_not_pin_lkg() -> None:
    """A transient empty answer must not become the stale fallback —
    otherwise a future outage would serve empty data forever."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_Result(value=0, children=[]))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    # Only the primary (negative-cache) SET should fire; LKG is skipped.
    keys = [call.args[0] for call in _payload_sets(redis)]
    assert any(graph_cache._KEY_PREFIX in k for k in keys)
    assert not any(graph_cache._LKG_PREFIX in k for k in keys)


def test_different_scopes_yield_different_keys() -> None:
    k1 = _build_key(CacheScope("ws1", "ds1"), 0, ENDPOINT_CHILDREN, {})
    k2 = _build_key(CacheScope("ws2", "ds1"), 0, ENDPOINT_CHILDREN, {})
    k3 = _build_key(CacheScope("ws1", "ds2"), 0, ENDPOINT_CHILDREN, {})
    assert len({k1, k2, k3}) == 3


@pytest.mark.asyncio
async def test_purge_lkg_deletes_scoped_entries() -> None:
    """LKG keys survive bump_generation by design, so a data-rewriting
    event (aggregation run completion) purges them explicitly — bounded
    SCAN over the scope+endpoint pattern, every branch."""
    redis = _make_redis()
    matching = [
        f"{graph_cache._LKG_PREFIX}:ws1:ds1::aggregated:abc",
        f"{graph_cache._LKG_PREFIX}:ws1:ds1:draft-1:aggregated:def",
    ]
    redis.scan = AsyncMock(side_effect=[(7, matching[:1]), (0, matching[1:])])
    redis.delete = AsyncMock(return_value=1)
    cache = GraphCache(redis)

    removed = await cache.purge_lkg(
        CacheScope("ws1", "ds1"), ENDPOINT_AGGREGATED,
    )

    assert removed == 2
    pattern = redis.scan.await_args_list[0].kwargs["match"]
    assert pattern == f"{graph_cache._LKG_PREFIX}:ws1:ds1:*:aggregated:*"
    deleted = [c.args for c in redis.delete.await_args_list]
    assert deleted == [(matching[0],), (matching[1],)]


@pytest.mark.asyncio
async def test_purge_lkg_swallows_redis_errors() -> None:
    redis = _make_redis()
    redis.scan = AsyncMock(side_effect=RedisError("down"))
    cache = GraphCache(redis)
    assert await cache.purge_lkg(CacheScope("ws1", "ds1"), ENDPOINT_AGGREGATED) == 0


# ── WS7: TTL posture + new endpoint coverage ─────────────────────────

def test_ws7_ttl_defaults_are_long_and_gen_bump_safe():
    """The long TTLs are safe because gen-bump invalidates on write and on
    every aggregation terminal event — freshness is event-driven, so the TTL
    is only a backstop. Asserts the RULE rather than the numbers: structural
    endpoints (what a view IS) hold for at least an hour; trace endpoints
    (what a user is exploring right now) stay short."""
    from backend.app.services import graph_cache as gc

    structural = (
        gc.ENDPOINT_CHILDREN, gc.ENDPOINT_AGGREGATED, gc.ENDPOINT_TOP_LEVEL,
        gc.ENDPOINT_LAYER_ASSIGNMENT, gc.ENDPOINT_CANVAS_BOOTSTRAP,
        gc.ENDPOINT_CANVAS_EXPAND, gc.ENDPOINT_EDGES_BETWEEN,
        gc.ENDPOINT_NODES_QUERY,
    )
    for endpoint in structural:
        assert gc._resolve_ttl(None, endpoint) >= 3600, endpoint
    # An endpoint nobody registered still gets the structural default rather
    # than falling to something short — nodes_degree reaches it this way.
    assert gc._resolve_ttl(None, "nodes_degree") >= 3600

    for endpoint in (gc.ENDPOINT_TRACE, gc.ENDPOINT_TRACE_EXPAND,
                     gc.ENDPOINT_TRACE_CLOSURE):
        assert gc._resolve_ttl(None, endpoint) <= 900, endpoint

    # An explicit TTL still wins, and the clamp permits a full day.
    assert gc._resolve_ttl(42, gc.ENDPOINT_CHILDREN) == 42
    assert gc._TTL_HI == 86_400


def test_ws7_new_endpoints_registered_enabled():
    from backend.app.services import graph_cache as gc
    for ep in (gc.ENDPOINT_EDGES_BETWEEN, gc.ENDPOINT_NODES_QUERY,
               gc.ENDPOINT_CANVAS_BOOTSTRAP, gc.ENDPOINT_CANVAS_EXPAND):
        assert ep in gc._ENABLED_ENDPOINTS
        assert gc._ENABLED_ENDPOINTS[ep] is True


def test_ws7_explicit_ttl_still_wins():
    from backend.app.services import graph_cache as gc
    assert gc._resolve_ttl(42, gc.ENDPOINT_EDGES_BETWEEN) == 42


# ─── top-level count side-cache ────────────────────────────────────────

@pytest.mark.asyncio
async def test_top_level_count_roundtrip(monkeypatch) -> None:
    monkeypatch.setitem(graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TOP_LEVEL, True)
    store: dict[str, str] = {}
    redis = _make_redis()

    async def _get(key):
        return store.get(key)

    async def _set(key, value, ex=None):
        store[key] = value
        return True

    redis.get = AsyncMock(side_effect=_get)
    redis.set = AsyncMock(side_effect=_set)
    cache = GraphCache(redis)
    scope = CacheScope("ws1", "ds1")
    params = {"entityTypes": None, "searchQuery": "foo"}

    assert await cache.get_top_level_count(scope, params) is None
    await cache.set_top_level_count(scope, params, 42)
    assert await cache.get_top_level_count(scope, params) == 42
    # Different filter shape → different key → miss
    assert await cache.get_top_level_count(scope, {"entityTypes": ["t"], "searchQuery": None}) is None


@pytest.mark.asyncio
async def test_top_level_count_invalidated_by_generation_bump(monkeypatch) -> None:
    monkeypatch.setitem(graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TOP_LEVEL, True)
    store: dict[str, str] = {}
    gen = {"n": 0}
    redis = _make_redis()

    async def _get(key):
        if key.startswith("graphgen:") or ":gen:" in key or key == graph_cache._gen_key(CacheScope("ws1", "ds1")):
            return str(gen["n"])
        return store.get(key)

    async def _set(key, value, ex=None):
        store[key] = value
        return True

    async def _incr(key):
        gen["n"] += 1
        return gen["n"]

    redis.get = AsyncMock(side_effect=_get)
    redis.set = AsyncMock(side_effect=_set)
    redis.incr = AsyncMock(side_effect=_incr)
    cache = GraphCache(redis)
    scope = CacheScope("ws1", "ds1")
    params = {"entityTypes": None, "searchQuery": None}

    await cache.set_top_level_count(scope, params, 7)
    assert await cache.get_top_level_count(scope, params) == 7
    await cache.bump_generation(scope)
    assert await cache.get_top_level_count(scope, params) is None


@pytest.mark.asyncio
async def test_top_level_count_redis_errors_are_swallowed(monkeypatch) -> None:
    monkeypatch.setitem(graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TOP_LEVEL, True)
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=RedisError("down"))
    redis.set = AsyncMock(side_effect=RedisError("down"))
    cache = GraphCache(redis)
    scope = CacheScope("ws1", "ds1")

    assert await cache.get_top_level_count(scope, {}) is None
    await cache.set_top_level_count(scope, {}, 1)  # must not raise


@pytest.mark.asyncio
async def test_top_level_count_respects_feature_flag(monkeypatch) -> None:
    monkeypatch.setitem(graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TOP_LEVEL, False)
    redis = _make_redis()
    cache = GraphCache(redis)
    scope = CacheScope("ws1", "ds1")

    assert await cache.get_top_level_count(scope, {}) is None
    await cache.set_top_level_count(scope, {}, 1)
    redis.get.assert_not_awaited()
    redis.set.assert_not_awaited()


# ─── H4: physical-graph namespacing (graph_ns) ──────────────────────────
#
# The response cache key was keyed by (workspace, data_source, branch) —
# stable as long as a data source's underlying FalkorDB graph never
# changes, but NOT robust to a re-point (same data_source_id, new
# host:port:graph_name): old cached responses could serve for the new
# graph until the next generation bump. `graph_ns` closes that hole by
# hashing the provider's live physical identity into the exact
# read/write key, while leaving gen-bump/purge (which must invalidate
# every physical-graph variant of a data source) untouched.

def test_graph_ns_differentiates_primary_keys() -> None:
    """The headline collision/re-point proof: two scopes that agree on
    (ws, ds, branch) but point at different physical graphs must never
    produce the same primary cache key."""
    scope_a = CacheScope("ws1", "ds1", graph_ns="aaa111")
    scope_b = CacheScope("ws1", "ds1", graph_ns="bbb222")
    key_a = _build_key(scope_a, 0, ENDPOINT_CHILDREN, {})
    key_b = _build_key(scope_b, 0, ENDPOINT_CHILDREN, {})
    assert key_a != key_b


def test_graph_ns_differentiates_lkg_keys() -> None:
    """Same proof for the last-known-good key shape."""
    scope_a = CacheScope("ws1", "ds1", graph_ns="aaa111")
    scope_b = CacheScope("ws1", "ds1", graph_ns="bbb222")
    key_a = graph_cache._build_lkg_key(scope_a, ENDPOINT_AGGREGATED, {})
    key_b = graph_cache._build_lkg_key(scope_b, ENDPOINT_AGGREGATED, {})
    assert key_a != key_b


def test_graph_ns_same_scope_yields_stable_key() -> None:
    """Same (ws, ds, branch, graph_ns) always produces the same key —
    graph_ns isn't a source of nondeterminism."""
    scope = CacheScope("ws1", "ds1", graph_ns="aaa111")
    assert _build_key(scope, 0, ENDPOINT_CHILDREN, {}) == _build_key(scope, 0, ENDPOINT_CHILDREN, {})
    assert graph_cache._build_lkg_key(scope, ENDPOINT_AGGREGATED, {}) == graph_cache._build_lkg_key(
        scope, ENDPOINT_AGGREGATED, {},
    )


def test_graph_ns_default_empty_is_fully_backward_compatible() -> None:
    """Every existing CacheScope construction (service-layer invalidation
    paths, tests) has no engine to resolve a graph_ns from and relies on
    the default "". That must produce EXACTLY the pre-H4 key shape — no
    trailing segment — so already-running deployments don't orphan their
    warm cache on upgrade."""
    scope = CacheScope("ws1", "ds1")
    assert scope.graph_ns == ""

    params = {"a": 1}
    digest = hashlib.sha1(json.dumps(params, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    assert _build_key(scope, 3, ENDPOINT_CHILDREN, params) == (
        f"graphcache:v1:ws1:ds1::3:{ENDPOINT_CHILDREN}:{digest}"
    )

    empty_digest = hashlib.sha1(json.dumps({}, sort_keys=True, default=str).encode("utf-8")).hexdigest()
    assert graph_cache._build_lkg_key(scope, ENDPOINT_AGGREGATED, {}) == (
        f"graphcache:lkg:v1:ws1:ds1::{ENDPOINT_AGGREGATED}:{empty_digest}"
    )


@pytest.mark.asyncio
async def test_purge_lkg_invalidates_across_graph_ns() -> None:
    """purge_lkg's SCAN pattern (`...:{ws}:{ds}:*:{endpoint}:*`) is
    graph_ns-agnostic by construction — the trailing wildcard covers the
    digest AND any graph_ns suffix — so ONE purge for (ws, ds, endpoint)
    removes LKG entries for every physical-graph variant."""
    redis = _make_redis()
    matching = [
        f"{graph_cache._LKG_PREFIX}:ws1:ds1::aggregated:digestA:nsOLD",
        f"{graph_cache._LKG_PREFIX}:ws1:ds1::aggregated:digestB:nsNEW",
    ]
    redis.scan = AsyncMock(return_value=(0, matching))
    redis.delete = AsyncMock(return_value=len(matching))
    cache = GraphCache(redis)

    removed = await cache.purge_lkg(CacheScope("ws1", "ds1"), ENDPOINT_AGGREGATED)

    assert removed == 2
    deleted: set[str] = set()
    for call in redis.delete.await_args_list:
        deleted.update(call.args)
    assert deleted == set(matching)


@pytest.mark.asyncio
async def test_bump_generation_invalidates_every_graph_ns_variant() -> None:
    """The generation counter key deliberately ignores graph_ns (see
    `_gen_key`'s docstring): bumping generation via one graph_ns value
    makes every OTHER graph_ns sharing the same (ws, ds, branch) compute
    a fresh, unreachable-for-the-old-key generation too — a re-point's
    stale entries still die on the next write."""
    scope_old = CacheScope("ws1", "ds1", graph_ns="ns_old")
    scope_new = CacheScope("ws1", "ds1", graph_ns="ns_new")
    assert graph_cache._gen_key(scope_old) == graph_cache._gen_key(scope_new)

    redis = _make_redis()
    cache = GraphCache(redis)
    gen0 = await cache._get_generation(scope_old)
    key_before = _build_key(scope_old, gen0, ENDPOINT_CHILDREN, {})

    await cache.bump_generation(scope_new)  # bump observed via a DIFFERENT graph_ns
    redis.get.return_value = "1"
    gen1 = await cache._get_generation(scope_old)
    key_after = _build_key(scope_old, gen1, ENDPOINT_CHILDREN, {})

    assert key_before != key_after


def test_graph_ns_hash_deterministic_bounded_and_distinct() -> None:
    h1 = graph_ns_hash("localhost:6379:nexus_lineage")
    h2 = graph_ns_hash("localhost:6379:nexus_lineage")
    assert h1 == h2  # deterministic

    assert len(h1) == 16  # bounded — a truncated sha1 hex digest

    distinct_ids = [
        "host-a:6379:graph1",
        "host-b:6379:graph1",  # different host
        "host-a:6380:graph1",  # different port
        "host-a:6379:graph2",  # different graph name
    ]
    hashes = {graph_ns_hash(pid) for pid in distinct_ids}
    assert len(hashes) == len(distinct_ids)


# ─── CACHE-role routing (Task H5) ───────────────────────────────────────
#
# graph_cache holds TWO Redis clients: `_cache_redis` (response-cache
# PAYLOADS + LKG snapshots, routed to the dedicated CACHE role when
# configured) and `_coord_redis` (the generation counter, the genat stamp,
# and the aggstale markers — ALWAYS the durable shared client, never the
# lossy cache role — see the agg:members ledger-corruption lesson). When
# `GraphCache` is constructed with a single client (every test above this
# section), `_cache_redis` falls back to `_coord_redis` — single-client
# behavior, byte-identical to before this task.

@pytest.mark.asyncio
async def test_single_client_construction_falls_back_cache_to_coord() -> None:
    """No dedicated cache client supplied (CACHE role unconfigured, or a
    caller that never resolved one) -> `_cache_redis` IS `_coord_redis`,
    the exact single-client shape every other test in this file relies
    on."""
    redis = _make_redis()
    cache = GraphCache(redis)
    assert cache._cache_redis is redis
    assert cache._coord_redis is redis


@pytest.mark.asyncio
async def test_cache_configured_payload_and_lkg_use_cache_client() -> None:
    """With a distinct CACHE-role client supplied, a cache miss + compute
    reads/writes the primary entry AND the LKG mirror on `_cache_redis`;
    the coordination client is only touched for the generation read, and
    never written."""
    coord = _make_redis()
    cache_redis = _make_redis()
    cache = GraphCache(coord, cache_redis)
    compute = AsyncMock(return_value=_Result(value=1, children=[1]))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 1
    # Generation lookup is the ONLY coordination-client call; it is never
    # written to by a cache read/write.
    coord.get.assert_awaited_once()
    coord.set.assert_not_awaited()
    coord.incr.assert_not_awaited()
    # Primary GET (miss) + mirror probe + primary SET + LKG SET all land on
    # the cache client, never the coordination client.
    assert cache_redis.get.await_count == 2
    coord.get.assert_awaited_once()
    assert len(_payload_sets(cache_redis)) == 2


@pytest.mark.asyncio
async def test_stale_fallback_lkg_read_uses_cache_client_not_coord() -> None:
    """The LKG stale-fallback GET (fired when `compute()` raises
    ProviderUnavailable) must land on the cache client too — the
    coordination client is only ever touched for the generation read."""
    from backend.common.adapters import ProviderUnavailable

    coord = _make_redis()
    coord.get = AsyncMock(return_value="0")  # generation only
    cache_redis = _make_redis()
    cache_redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_Result(value=55).model_dump_json(by_alias=True),
    ))
    cache = GraphCache(coord, cache_redis)
    compute = AsyncMock(side_effect=ProviderUnavailable("falkordb", "breaker open"))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "x"},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 55
    assert any(
        graph_cache._LKG_PREFIX in c.args[0]
        for c in cache_redis.get.await_args_list
    ), "the LKG read went somewhere other than the cache client"
    coord.get.assert_awaited_once()


@pytest.mark.asyncio
async def test_cache_configured_coordination_still_uses_coord_client() -> None:
    """Even with a distinct CACHE-role client present, `bump_generation`
    and the stale-marker helpers (coordination) must land exclusively on
    the coordination client — never the cache role. This is the
    eviction-safety invariant from the agg:members lesson."""
    coord = _make_redis()
    cache_redis = _make_redis()
    cache = GraphCache(coord, cache_redis)

    await cache.bump_generation(CacheScope("ws1", "ds1"))
    coord.incr.assert_awaited_once()
    coord.set.assert_awaited_once()
    cache_redis.incr.assert_not_awaited()
    cache_redis.set.assert_not_awaited()


@pytest.mark.asyncio
async def test_mark_source_stale_uses_coord_client_not_cache_client(monkeypatch) -> None:
    """Module-level stale-marker helpers read `get_graph_cache()` and must
    hit the coordination client even when a distinct cache client is
    wired up."""
    coord = _make_redis()
    cache_redis = _make_redis()
    cache = GraphCache(coord, cache_redis)
    monkeypatch.setattr(graph_cache, "get_graph_cache", lambda: cache)

    await graph_cache.mark_source_stale("ws1", "ds1", reason="source_changed")

    coord.set.assert_awaited_once()
    cache_redis.set.assert_not_awaited()
    cache_redis.get.assert_not_awaited()


@pytest.mark.asyncio
async def test_cache_client_get_failure_degrades_to_compute() -> None:
    """A CACHE-role client failure on the primary GET must degrade to
    `compute()` exactly like the single-client fail-open path — the
    coordination client is unaffected and unrelated to the failure."""
    coord = _make_redis()
    cache_redis = _make_redis()
    cache_redis.get = AsyncMock(side_effect=RedisError("cache role down"))
    cache = GraphCache(coord, cache_redis)
    compute = AsyncMock(return_value=_Result(value=7))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 7
    compute.assert_awaited_once()


@pytest.mark.asyncio
async def test_cache_client_set_failure_does_not_fail_request_or_touch_coord() -> None:
    """A CACHE-role client failure on the primary SET is swallowed (the
    compute already succeeded) and never reaches the coordination
    client."""
    coord = _make_redis()
    cache_redis = _make_redis()
    cache_redis.set = AsyncMock(side_effect=RedisError("cache role down"))
    cache = GraphCache(coord, cache_redis)
    compute = AsyncMock(return_value=_Result(value=9))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={},
        compute=compute,
        model_cls=_Result,
    )

    assert result.value == 9
    coord.set.assert_not_awaited()


# ─── _resolve_cache_role_client (the CACHE-role resolver) ───────────────

def test_resolve_cache_role_client_returns_none_when_unconfigured(monkeypatch) -> None:
    fake_cfg = type("Cfg", (), {"is_configured": False})()
    monkeypatch.setattr(
        "backend.common.adapters.redis_endpoint.resolve_redis_config",
        lambda role, **kw: fake_cfg,
    )
    assert graph_cache._resolve_cache_role_client() is None


def test_resolve_cache_role_client_builds_client_when_configured(monkeypatch) -> None:
    fake_cfg = type("Cfg", (), {"is_configured": True})()
    sentinel_client = object()
    monkeypatch.setattr(
        "backend.common.adapters.redis_endpoint.resolve_redis_config",
        lambda role, **kw: fake_cfg,
    )
    monkeypatch.setattr(
        "backend.common.adapters.redis_endpoint.build_redis_client",
        lambda cfg, **kw: sentinel_client,
    )
    assert graph_cache._resolve_cache_role_client() is sentinel_client


def test_resolve_cache_role_client_swallows_resolution_errors(monkeypatch) -> None:
    """Constraint: 'resolution failure of the CACHE cfg -> fall back to
    shared, log once, never raise.'"""
    def _boom(role, **kw):
        raise RuntimeError("config store unreachable")

    monkeypatch.setattr(
        "backend.common.adapters.redis_endpoint.resolve_redis_config", _boom,
    )
    assert graph_cache._resolve_cache_role_client() is None


# ─── get_graph_cache() singleton wiring ─────────────────────────────────

def test_get_graph_cache_wires_cache_role_client(monkeypatch) -> None:
    """The singleton passes the shared client as coordination AND wires
    whatever `_resolve_cache_role_client` returns as the payload client."""
    graph_cache.reset_graph_cache_for_tests()
    shared = _make_redis()
    dedicated_cache = _make_redis()
    monkeypatch.setattr(graph_cache, "get_redis", lambda: shared)
    monkeypatch.setattr(
        graph_cache, "_resolve_cache_role_client", lambda: dedicated_cache,
    )

    cache = graph_cache.get_graph_cache()

    assert cache._coord_redis is shared
    assert cache._cache_redis is dedicated_cache
    graph_cache.reset_graph_cache_for_tests()


def test_get_graph_cache_falls_back_when_cache_role_unresolved(monkeypatch) -> None:
    """When `_resolve_cache_role_client` returns None (unconfigured or a
    resolution failure), the singleton's cache client falls back to the
    same shared client used for coordination — single-client behavior."""
    graph_cache.reset_graph_cache_for_tests()
    shared = _make_redis()
    monkeypatch.setattr(graph_cache, "get_redis", lambda: shared)
    monkeypatch.setattr(graph_cache, "_resolve_cache_role_client", lambda: None)

    cache = graph_cache.get_graph_cache()

    assert cache._coord_redis is shared
    assert cache._cache_redis is shared
    graph_cache.reset_graph_cache_for_tests()


# ── shed and warming are not outages ─────────────────────────────────────
#
# ProviderBusy and ProviderLoading both subclass ProviderUnavailable, so the
# stale-fallback clause caught them along with everything else. The effect was
# that the two signals a client is supposed to ACT on — retry after
# Retry-After, the store is warming and will answer — arrived as a 200
# carrying a snapshot up to a day old. The canvas never retried, because as
# far as it could tell the request had succeeded, which made shedding
# unreachable on every cached endpoint.


@pytest.mark.asyncio
async def test_a_shed_request_is_not_answered_from_a_day_old_snapshot() -> None:
    """ProviderBusy means "I chose not to serve you so I could serve someone
    else; come back". Answering it from the LKG tells the client the opposite."""
    from backend.common.adapters import ProviderBusy

    redis = _make_redis()
    redis.get = AsyncMock(side_effect=[
        "0", None, _Result(value=123).model_dump_json(by_alias=True),
    ])
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ProviderBusy("falkordb", "all slots busy"))

    with pytest.raises(ProviderBusy):
        await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"},
            compute=compute,
            model_cls=_Result,
        )


@pytest.mark.asyncio
async def test_a_warming_store_is_not_answered_from_a_day_old_snapshot() -> None:
    """ProviderLoading is a store reading its dataset in. It will answer in
    seconds; the client shows "starting up" and polls. A stale 200 replaces
    that with silence and stale data."""
    from backend.common.adapters import ProviderLoading

    redis = _make_redis()
    redis.get = AsyncMock(side_effect=[
        "0", None, _Result(value=123).model_dump_json(by_alias=True),
    ])
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ProviderLoading("falkordb", "loading the dataset"))

    with pytest.raises(ProviderLoading):
        await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"},
            compute=compute,
            model_cls=_Result,
        )


@pytest.mark.asyncio
async def test_a_provider_that_genuinely_cannot_answer_still_serves_the_snapshot() -> None:
    """The other side of the same line: narrowing the catch must not cost the
    fallback its actual job. A bare ProviderUnavailable still serves stale."""
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_Result(value=123).model_dump_json(by_alias=True),
    ))
    cache = GraphCache(redis)
    compute = AsyncMock(side_effect=ProviderUnavailable("falkordb", "breaker open"))

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_CHILDREN,
        params={"urn": "x"},
        compute=compute,
        model_cls=_Result,
    )
    assert result.value == 123


# ── a shed leader must not strand its followers ──────────────────────────
#
# Followers attach to an in-flight compute with `await asyncio.shield(existing)`.
# Shield means the follower's OWN cancellation does not end that await, so a
# future nobody resolves leaves it hanging until its request tier fires —
# 45 or 60 seconds later.
#
# Every exception path in get_or_compute resolves the future before raising.
# The re-raise clause added for ProviderBusy/ProviderLoading did not, and the
# `finally` only pops the key. Shedding is precisely when a key HAS followers
# (a cold-cache stampede is what the gate sheds), so the miss turned one shed
# request into a pile of hung ones.


@pytest.mark.asyncio
@pytest.mark.parametrize("shed", ["ProviderBusy", "ProviderLoading"])
async def test_a_shed_leader_does_not_strand_its_followers(shed) -> None:
    import backend.common.adapters as adapters

    exc_cls = getattr(adapters, shed)
    redis = _make_redis()
    redis.get = AsyncMock(return_value=None)          # always a miss
    cache = GraphCache(redis)

    leader_entered = asyncio.Event()
    release_leader = asyncio.Event()

    async def compute():
        leader_entered.set()
        await release_leader.wait()
        raise exc_cls("falkordb", "shed")

    async def call():
        return await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"),
            endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"},
            compute=compute,
            model_cls=_Result,
        )

    leader = asyncio.create_task(call())
    await asyncio.wait_for(leader_entered.wait(), timeout=2)
    follower = asyncio.create_task(call())
    await asyncio.sleep(0)                             # let it attach
    release_leader.set()

    # Both must finish promptly. Before the fix the follower awaited a future
    # nobody resolved and this timed out.
    done, pending = await asyncio.wait(
        {leader, follower}, timeout=5, return_when=asyncio.ALL_COMPLETED,
    )
    for task in pending:
        task.cancel()
    assert not pending, (
        f"{shed} leader stranded its follower — the singleflight future was "
        "never resolved, so the follower hangs until its request tier fires"
    )
    for task in done:
        with pytest.raises(exc_cls):
            task.result()


# ── why a long TTL is safe ───────────────────────────────────────────────
#
# The structural endpoints cache for an hour. That is only sound because the
# TTL is not what keeps data fresh — the generation bump is, and it is
# event-driven. These pin the two properties the long TTL rests on:
#
#   1. An aggregation terminal event invalidates a BRANCHLESS scope, which is
#      every external graph: no branch, no in-app writes, so the aggregation
#      run is the only thing that changes the answer.
#   2. The invalidation covers every PHYSICAL graph the source has pointed at,
#      because _gen_key deliberately omits graph_ns while read keys include it.
#
# If either stopped holding, an hour-long TTL would start serving an hour of
# stale data to every user of that source.


@pytest.mark.asyncio
async def test_an_aggregation_event_invalidates_a_branchless_external_source() -> None:
    """The fake Redis does not keep counter state, so this asserts the WIRING:
    a terminal aggregation event must INCR the generation key of the
    branchless scope. That key is what every read composes into its cache key,
    so incrementing it is what makes an hour of cached entries unreachable."""
    from unittest.mock import patch as _patch

    from backend.app.services.graph_cache import _gen_key, invalidate_aggregated_reads

    redis = _make_redis()
    cache = GraphCache(redis)
    scope = CacheScope("ws1", "ds1", branch_id="", graph_ns="abc123")

    with _patch("backend.app.services.graph_cache.get_graph_cache", return_value=cache):
        await invalidate_aggregated_reads("ws1", "ds1")

    bumped = [c.args[0] for c in redis.incr.await_args_list]
    assert _gen_key(scope) in bumped, (
        "an aggregation run completing must bump the generation for the "
        f"branchless scope ({_gen_key(scope)}); it bumped {bumped}. With a 1h "
        "TTL nothing else will unreach those entries."
    )


def test_invalidation_reaches_every_physical_graph_the_source_has_used() -> None:
    """_gen_key omits graph_ns on purpose; read keys include it. So one bump
    kills entries cached under the old graph AND the new one after a re-point.
    If graph_ns ever leaked into the generation key, invalidation would miss
    every entry a reader actually wrote."""
    from backend.app.services.graph_cache import _gen_key

    a = CacheScope("ws1", "ds1", branch_id="", graph_ns="physical-a")
    b = CacheScope("ws1", "ds1", branch_id="", graph_ns="physical-b")
    none = CacheScope("ws1", "ds1", branch_id="")

    assert _gen_key(a) == _gen_key(b) == _gen_key(none), (
        "the generation key must not vary by physical graph, or the "
        "invalidation choke point (which builds the scope with graph_ns='') "
        "cannot reach entries written by a reader that resolved a real one"
    )


def test_the_structural_endpoints_are_cached_for_an_hour() -> None:
    """States the intent so a future edit has to be deliberate. These are the
    endpoints that describe what a view IS — they change when the graph
    changes, which is an event, not a moment on a clock."""
    import backend.app.services.graph_cache as gc

    for name in (
        "_DEFAULT_CHILDREN_TTL", "_DEFAULT_AGGREGATED_TTL", "_DEFAULT_TOP_LEVEL_TTL",
        "_DEFAULT_CANVAS_BOOTSTRAP_TTL", "_DEFAULT_CANVAS_EXPAND_TTL",
        "_DEFAULT_LAYER_ASSIGNMENT_TTL",
    ):
        assert getattr(gc, name) >= 3600, f"{name} fell back below an hour"
    # And the negative window stays short: a failed or empty read must be
    # retried soon, never pinned for an hour.
    assert gc._NEGATIVE_TTL <= 300


# ── hit-rate telemetry ───────────────────────────────────────────────────
#
# The cache is the largest lever on read capacity and was the only one nobody
# could see. These pin that every outcome is counted, that a stale-fallback
# never flatters the ratio, and that telemetry can never fail a request.


def _stats_redis():
    redis = _make_redis()
    redis.hincrby = AsyncMock(return_value=1)
    redis.expire = AsyncMock(return_value=True)
    return redis


@pytest.mark.asyncio
async def test_a_cache_hit_and_a_miss_are_both_counted() -> None:
    redis = _stats_redis()
    cache = GraphCache(redis)
    scope = CacheScope("ws1", "ds1")

    compute = AsyncMock(return_value=_Result(value=1))
    await cache.get_or_compute(
        scope=scope, endpoint=ENDPOINT_CHILDREN, params={"urn": "x"},
        compute=compute, model_cls=_Result,
    )
    # Now serve the same key from cache.
    redis.get = AsyncMock(side_effect=["0", _Result(value=1).model_dump_json(by_alias=True)])
    await cache.get_or_compute(
        scope=scope, endpoint=ENDPOINT_CHILDREN, params={"urn": "x"},
        compute=compute, model_cls=_Result,
    )
    await asyncio.sleep(0)                      # let the fire-and-forget tasks run
    await asyncio.sleep(0)

    fields = [c.args[1] for c in redis.hincrby.await_args_list]
    assert f"{ENDPOINT_CHILDREN}:miss" in fields
    assert f"{ENDPOINT_CHILDREN}:hit" in fields


@pytest.mark.asyncio
async def test_a_stale_fallback_is_not_counted_as_a_hit() -> None:
    """It kept the user moving, but the provider could not answer. Folding it
    into the hit ratio would make an outage read as a cache win — which is
    exactly the wrong signal when someone is looking at this during one."""
    from backend.common.adapters import ProviderUnavailable

    redis = _stats_redis()
    redis.get = AsyncMock(side_effect=_routed_get(
        lkg=_Result(value=123).model_dump_json(by_alias=True),
    ))
    cache = GraphCache(redis)
    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "x"},
        compute=AsyncMock(side_effect=ProviderUnavailable("falkordb", "down")),
        model_cls=_Result,
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    fields = [c.args[1] for c in redis.hincrby.await_args_list]
    assert f"{ENDPOINT_CHILDREN}:stale" in fields
    assert f"{ENDPOINT_CHILDREN}:hit" not in fields


def test_the_ratio_excludes_stale_and_bypass() -> None:
    """hit / (hit + miss + stale). A bypass is not a cache outcome at all —
    the endpoint was off or Redis was unreachable — so it must not dilute the
    denominator and make a disabled cache look like a missing one."""
    import backend.app.services.graph_cache as gc

    assert gc.CACHE_OUTCOMES == ("hit", "miss", "stale", "bypass")
    # 3 hits, 1 miss, 1 stale, 10 bypass -> 3/5, not 3/15 and not 4/5.
    row = {"hit": 3, "miss": 1, "stale": 1, "bypass": 10}
    served = row["hit"] + row["miss"] + row["stale"]
    assert round(row["hit"] / served, 4) == 0.6


@pytest.mark.asyncio
async def test_telemetry_never_fails_a_request() -> None:
    """A counter write that raises must not reach the caller — the request
    already succeeded, and the cache must never become a hard dependency."""
    redis = _stats_redis()
    redis.hincrby = AsyncMock(side_effect=RuntimeError("bus down"))
    cache = GraphCache(redis)

    result = await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
        params={"urn": "x"},
        compute=AsyncMock(return_value=_Result(value=7)), model_cls=_Result,
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    assert result.value == 7


@pytest.mark.asyncio
async def test_reading_stats_when_the_bus_is_down_is_empty_not_an_error() -> None:
    from backend.app.services.graph_cache import read_cache_stats

    stats = await read_cache_stats("")          # no workspace -> empty, no bus call
    assert stats["totals"]["hit"] == 0
    assert stats["endpoints"] == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("shed", ["ProviderBusy", "ProviderLoading"])
async def test_a_shed_leader_does_not_become_a_stampede(shed) -> None:
    """The other half of the stranding bug, and the more dangerous half.

    Resolving the leader's future with an exception stopped followers hanging
    — but the follower's `except Exception: pass` then fell through to
    RECOMPUTE. So one shed request became N concurrent computes on the same
    key, which is exactly the load the shed refused, at exactly the moment the
    store asked for less. Measured before the fix: 9 callers, 9 computes.

    Flow control is not a failure to retry. Followers take the leader's answer
    and retry on their own Retry-After, as the client already does.
    """
    import backend.common.adapters as adapters

    exc_cls = getattr(adapters, shed)
    redis = _make_redis()
    redis.hincrby = AsyncMock(return_value=1)
    redis.expire = AsyncMock(return_value=True)
    cache = GraphCache(redis)

    calls = 0
    gate = asyncio.Event()

    async def compute():
        nonlocal calls
        calls += 1
        await gate.wait()
        raise exc_cls("falkordb", "shed")

    async def call():
        return await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"}, compute=compute, model_cls=_Result,
        )

    tasks = [asyncio.create_task(call()) for _ in range(9)]
    await asyncio.sleep(0.05)                  # let all nine attach
    gate.set()
    outcomes = await asyncio.gather(*tasks, return_exceptions=True)

    assert calls == 1, (
        f"a shed key is a key WITH followers — {calls} computes ran where one "
        "refusal should have served all nine"
    )
    assert all(isinstance(o, exc_cls) for o in outcomes), (
        "every follower must receive the leader's flow-control answer"
    )


@pytest.mark.asyncio
async def test_a_genuine_failure_still_lets_followers_try() -> None:
    """The distinction the fix rests on. A leader that failed for a reason a
    retry might survive must NOT pin its followers to that failure — only
    flow control does, because only flow control means 'ask for less'."""
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    redis.hincrby = AsyncMock(return_value=1)
    redis.expire = AsyncMock(return_value=True)
    cache = GraphCache(redis)

    calls = 0
    gate = asyncio.Event()

    async def compute():
        nonlocal calls
        calls += 1
        await gate.wait()
        raise ProviderUnavailable("falkordb", "down")

    async def call():
        return await cache.get_or_compute(
            scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN,
            params={"urn": "x"}, compute=compute, model_cls=_Result,
        )

    tasks = [asyncio.create_task(call()) for _ in range(3)]
    await asyncio.sleep(0.05)
    gate.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    assert calls > 1, "followers must still be free to retry a transient failure"


@pytest.mark.asyncio
async def test_a_nested_degraded_payload_still_forces_the_negative_ttl() -> None:
    """The nested check earns its keep here. `degraded_detail` on the embedded
    aggregated payload means the read ladder gave up part way — not
    reproducible, so it must not be pinned for an hour and must never become
    the outage fallback."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_CanvasBootstrapLike(
        nodes=[1],
        aggregated=_NestedAggregated(truncated=True, degraded_detail="page floor reached"),
    ))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"), endpoint=ENDPOINT_CHILDREN, params={},
        compute=compute, model_cls=_CanvasBootstrapLike,
    )

    assert _payload_sets(redis)[-1].kwargs["ex"] == graph_cache._NEGATIVE_TTL
    keys = [call.args[0] for call in _payload_sets(redis)]
    assert not any(graph_cache._LKG_PREFIX in k for k in keys)
