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
    assert redis.set.await_count == 0
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
async def test_truncated_result_caches_with_negative_ttl_and_no_lkg() -> None:
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

    # Primary SET only, at the negative TTL — no LKG mirror for a
    # truncated snapshot.
    assert redis.set.await_count == 1
    assert redis.set.call_args.kwargs["ex"] == graph_cache._NEGATIVE_TTL
    keys = [call.args[0] for call in redis.set.await_args_list]
    assert not any(graph_cache._LKG_PREFIX in k for k in keys)


@pytest.mark.asyncio
async def test_stale_result_caches_with_negative_ttl_and_no_lkg() -> None:
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

    assert redis.set.await_count == 1
    assert redis.set.call_args.kwargs["ex"] == graph_cache._NEGATIVE_TTL
    keys = [call.args[0] for call in redis.set.await_args_list]
    assert not any(graph_cache._LKG_PREFIX in k for k in keys)


@pytest.mark.asyncio
async def test_nested_aggregated_truncated_forces_negative_ttl() -> None:
    """Canvas bootstrap/expand results embed an AggregatedEdgeResult under
    ``.aggregated``; a truncated nested payload must still force the
    negative TTL on the outer result."""
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

    assert redis.set.call_args.kwargs["ex"] == graph_cache._NEGATIVE_TTL
    # T1-3: an incomplete nested payload must also skip the LKG mirror — a
    # degraded snapshot must never become the outage fallback.
    keys = [call.args[0] for call in redis.set.await_args_list]
    assert not any(graph_cache._LKG_PREFIX in k for k in keys)


@pytest.mark.asyncio
async def test_nested_aggregated_delta_truncated_forces_negative_ttl_and_no_lkg() -> None:
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

    assert redis.set.call_args.kwargs["ex"] == graph_cache._NEGATIVE_TTL
    keys = [call.args[0] for call in redis.set.await_args_list]
    assert not any(graph_cache._LKG_PREFIX in k for k in keys)


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


# ── WS7: TTL posture + new endpoint coverage ─────────────────────────

def test_ws7_ttl_defaults_are_long_and_gen_bump_safe():
    """The long TTLs (5-15 min) are safe because gen-bump invalidates on
    write; assert the defaults landed so a regression to 30/60s is caught."""
    from backend.app.services import graph_cache as gc
    assert gc._resolve_ttl(None, gc.ENDPOINT_CHILDREN) == 900
    assert gc._resolve_ttl(None, gc.ENDPOINT_AGGREGATED) == 900
    assert gc._resolve_ttl(None, gc.ENDPOINT_TOP_LEVEL) == 600
    assert gc._resolve_ttl(None, gc.ENDPOINT_TRACE) == 300
    assert gc._resolve_ttl(None, gc.ENDPOINT_LAYER_ASSIGNMENT) == 900
    # New hydration + canvas endpoints are cache-covered.
    assert gc._resolve_ttl(None, gc.ENDPOINT_EDGES_BETWEEN) == 900
    assert gc._resolve_ttl(None, gc.ENDPOINT_NODES_QUERY) == 900
    assert gc._resolve_ttl(None, gc.ENDPOINT_CANVAS_BOOTSTRAP) == 300
    assert gc._resolve_ttl(None, gc.ENDPOINT_CANVAS_EXPAND) == 300


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
    # Primary GET (miss) + primary SET + LKG SET all land on the cache
    # client, never the coordination client.
    cache_redis.get.assert_awaited_once()
    assert cache_redis.set.await_count == 2


@pytest.mark.asyncio
async def test_stale_fallback_lkg_read_uses_cache_client_not_coord() -> None:
    """The LKG stale-fallback GET (fired when `compute()` raises
    ProviderUnavailable) must land on the cache client too — the
    coordination client is only ever touched for the generation read."""
    from backend.common.adapters import ProviderUnavailable

    coord = _make_redis()
    coord.get = AsyncMock(return_value="0")  # generation only
    cache_redis = _make_redis()
    cache_redis.get = AsyncMock(side_effect=[
        None,  # primary miss
        _Result(value=55).model_dump_json(by_alias=True),  # LKG hit
    ])
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
    assert cache_redis.get.await_count == 2
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
