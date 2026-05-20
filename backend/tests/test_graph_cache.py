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
    ENDPOINT_TOP_LEVEL,
    GraphCache,
    _build_key,
    bump_generation_for,
)


class _Result(BaseModel):
    """Minimal Pydantic model standing in for ChildrenWithEdgesResult."""
    value: int
    children: list = []


class _NodesResult(BaseModel):
    """Stand-in for TopLevelNodesResult / any ``nodes``-shaped response."""
    value: int = 0
    nodes: list = []


def _make_redis() -> AsyncMock:
    """An AsyncMock with the surface graph_cache touches: get/set/incr."""
    redis = AsyncMock()
    redis.get = AsyncMock(return_value=None)
    redis.set = AsyncMock(return_value=True)
    redis.incr = AsyncMock(return_value=1)
    return redis


@pytest.fixture(autouse=True)
def _enable_children_endpoint(monkeypatch):
    """Force the cached-endpoint flags on for tests that exercise them."""
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_CHILDREN, True,
    )
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_AGGREGATED, True,
    )
    monkeypatch.setitem(
        graph_cache._ENABLED_ENDPOINTS, ENDPOINT_TOP_LEVEL, True,
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


def test_different_scopes_yield_different_keys() -> None:
    k1 = _build_key(CacheScope("ws1", "ds1"), 0, ENDPOINT_CHILDREN, {})
    k2 = _build_key(CacheScope("ws2", "ds1"), 0, ENDPOINT_CHILDREN, {})
    k3 = _build_key(CacheScope("ws1", "ds2"), 0, ENDPOINT_CHILDREN, {})
    assert len({k1, k2, k3}) == 3


# ─── Phase 1: top-level endpoint wiring ─────────────────────────────────

def test_top_level_default_enabled() -> None:
    """The top-level endpoint flag must default ON so the cache rolls out
    with the rest of Phase 1 rather than being silently bypassed."""
    assert graph_cache._ENABLED_ENDPOINTS[ENDPOINT_TOP_LEVEL] is True
    assert graph_cache._ENABLED_ENDPOINTS[ENDPOINT_CHILDREN] is True
    assert graph_cache._ENABLED_ENDPOINTS[ENDPOINT_AGGREGATED] is True


def test_top_level_uses_dedicated_ttl() -> None:
    ttl = graph_cache._resolve_ttl(None, ENDPOINT_TOP_LEVEL)
    assert ttl == graph_cache._DEFAULT_TOP_LEVEL_TTL


@pytest.mark.asyncio
async def test_top_level_caches_via_get_or_compute() -> None:
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_NodesResult(value=1, nodes=[{"urn": "u1"}]))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_TOP_LEVEL,
        params={"entityTypes": ["Domain"], "limit": 100},
        compute=compute,
        model_cls=_NodesResult,
    )

    compute.assert_awaited_once()
    redis.set.assert_awaited_once()
    # The key contains the new endpoint marker.
    key = redis.set.call_args.args[0]
    assert f":{ENDPOINT_TOP_LEVEL}:" in key


@pytest.mark.asyncio
async def test_empty_nodes_list_uses_negative_ttl() -> None:
    """Top-level / future NodesListResult responses with an empty ``nodes``
    list must be cached for the short negative-TTL window, not the full
    30s — otherwise a transient miss would pin "no data" on the UI."""
    redis = _make_redis()
    cache = GraphCache(redis)
    compute = AsyncMock(return_value=_NodesResult(value=0, nodes=[]))

    await cache.get_or_compute(
        scope=CacheScope("ws1", "ds1"),
        endpoint=ENDPOINT_TOP_LEVEL,
        params={},
        compute=compute,
        model_cls=_NodesResult,
    )

    assert redis.set.call_args.kwargs["ex"] == graph_cache._NEGATIVE_TTL


# ─── generation-header support for client revalidation ─────────────────

@pytest.mark.asyncio
async def test_current_generation_reads_redis() -> None:
    redis = _make_redis()
    redis.get = AsyncMock(return_value="7")
    cache = GraphCache(redis)
    assert await cache.current_generation(CacheScope("ws1", "ds1")) == 7


@pytest.mark.asyncio
async def test_current_generation_returns_zero_on_miss() -> None:
    redis = _make_redis()  # default get returns None
    cache = GraphCache(redis)
    assert await cache.current_generation(CacheScope("ws1", "ds1")) == 0


@pytest.mark.asyncio
async def test_current_generation_swallows_redis_error() -> None:
    redis = _make_redis()
    redis.get = AsyncMock(side_effect=RedisError("down"))
    cache = GraphCache(redis)
    assert await cache.current_generation(CacheScope("ws1", "ds1")) == 0


# ─── worker-friendly invalidation helper (ingestion path) ──────────────

@pytest.mark.asyncio
async def test_bump_generation_for_invokes_bump(monkeypatch) -> None:
    """The aggregation worker calls this with raw ws/ds strings on job
    completion — it must drive an INCR on the same gen key the API uses."""
    redis = _make_redis()
    graph_cache._cache = GraphCache(redis)
    try:
        await bump_generation_for(workspace_id="ws1", data_source_id="ds1")
        redis.incr.assert_awaited_once()
        key = redis.incr.call_args.args[0]
        assert "ws1" in key and "ds1" in key
    finally:
        graph_cache.reset_graph_cache_for_tests()


@pytest.mark.asyncio
async def test_bump_generation_for_skips_without_workspace() -> None:
    """No workspace = no scope = no key — bumping a malformed scope would
    create unreachable garbage in Redis, so we short-circuit instead."""
    redis = _make_redis()
    graph_cache._cache = GraphCache(redis)
    try:
        await bump_generation_for(workspace_id="", data_source_id="ds1")
        redis.incr.assert_not_called()
    finally:
        graph_cache.reset_graph_cache_for_tests()
