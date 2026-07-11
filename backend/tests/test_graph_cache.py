"""Unit tests for :mod:`backend.app.services.graph_cache`.

Mocks the async Redis client directly — fakeredis is not part of the
test toolchain and the cache only exercises `GET`, `SET`, and `INCR`,
which are trivial to mock.
"""
from __future__ import annotations

import asyncio
from typing import Any
from unittest.mock import AsyncMock

import pytest
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
    ENDPOINT_TRACE_EXPAND,
    GraphCache,
    _build_key,
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


def _make_redis() -> AsyncMock:
    """An AsyncMock with the surface graph_cache touches: get/set/incr."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.incr = AsyncMock(return_value=1)
    return redis


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
    redis.set.assert_awaited_once()
    # The value was serialized as JSON
    set_args = redis.set.call_args
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

    set_kwargs = redis.set.call_args.kwargs
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
    cache it so it can't crowd out hundreds of normal entries."""
    import logging
    monkeypatch.setattr(graph_cache, "_MAX_PAYLOAD_BYTES", 50)

    redis = _make_redis()
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
    assert redis.set.await_count == 0
    # WARNING line was emitted with the diagnostic shape.
    assert any("payload_too_large" in rec.message for rec in caplog.records)


# ─── stale-on-error fallback (P1.1) ────────────────────────────────────

@pytest.mark.asyncio
async def test_stale_fallback_serves_lkg_when_compute_raises_provider_unavailable() -> None:
    from backend.common.adapters import ProviderUnavailable

    redis = _make_redis()
    # First GET = generation (returns "0"); second GET = primary key (miss);
    # third GET = LKG key (hit with last-known-good payload).
    redis.get = AsyncMock(side_effect=[
        "0",
        None,
        _Result(value=123).model_dump_json(by_alias=True),
    ])
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
    redis.get = AsyncMock(side_effect=[
        "0",
        None,
        _Result(value=77).model_dump_json(by_alias=True),
    ])
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
    # generation miss, primary miss, LKG miss
    redis.get = AsyncMock(side_effect=["0", None, None])
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
    assert redis.set.await_count == 2
    keys = [call.args[0] for call in redis.set.await_args_list]
    assert any(graph_cache._KEY_PREFIX in k for k in keys)
    assert any(graph_cache._LKG_PREFIX in k for k in keys)


# ─── trace endpoint caching (P1.2) ─────────────────────────────────────

@pytest.mark.asyncio
async def test_trace_endpoint_cache_miss_then_hit() -> None:
    """Two identical /trace/v2 calls — first computes + caches,
    second returns the cached payload without invoking compute."""
    redis = _make_redis()
    # First call: gen=0, primary miss → compute runs and SETs primary + LKG
    # Second call: gen=0, primary hit → no compute, no SET
    redis.get = AsyncMock(side_effect=[
        "0", None,                                                              # call 1: gen, miss
        "0", _TraceLike(nodes=[1, 2], label="ok").model_dump_json(by_alias=True),  # call 2: gen, hit
    ])
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
    redis.get = AsyncMock(side_effect=[
        "0",
        None,
        _TraceLike(nodes=[1], label="stale").model_dump_json(by_alias=True),
    ])
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
    keys = [call.args[0] for call in redis.set.await_args_list]
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
