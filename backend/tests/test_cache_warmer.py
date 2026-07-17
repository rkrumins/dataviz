"""Unit tests for :mod:`backend.insights_service.cache_warmer`.

The warmer is a pure orchestrator over GraphCache + ContextEngine. We
patch:
  - ``get_redis`` so the SET-NX lock and DELETE are observable
  - ``get_graph_cache`` so ``get_or_compute`` calls are counted
  - ``ContextEngine.for_workspace`` so we don't need a real DB / provider

Everything else (skip-on-size-gate, skip-on-flag-off, lock contention,
per-step error isolation) is testable through these three seams.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.common.adapters import ProviderUnavailable
from backend.insights_service import cache_warmer


def _make_redis(*, lock_acquired: bool = True) -> AsyncMock:
    redis = AsyncMock()
    # SET NX returns truthy on acquisition, falsy when another holder exists.
    redis.set = AsyncMock(return_value=True if lock_acquired else None)
    redis.delete = AsyncMock(return_value=1)
    return redis


def _make_cache_with_top_level(top_urns: list[str], children_per: int = 0) -> MagicMock:
    """Build a GraphCache mock whose ``get_or_compute`` returns a top-level
    result containing ``top_urns`` for the top-level endpoint and a
    children result with ``children_per`` children for the children endpoint."""
    children_payload = SimpleNamespace(
        children=[SimpleNamespace(urn=f"{u}/c{i}") for u in top_urns for i in range(children_per)],
    )

    async def fake_get_or_compute(*, endpoint, **_kw):
        if endpoint == cache_warmer.ENDPOINT_TOP_LEVEL:
            return SimpleNamespace(nodes=[SimpleNamespace(urn=u) for u in top_urns])
        if endpoint == cache_warmer.ENDPOINT_CHILDREN:
            return children_payload
        if endpoint == cache_warmer.ENDPOINT_AGGREGATED:
            return SimpleNamespace(aggregated_edges=[])
        return SimpleNamespace()

    cache = MagicMock()
    cache.get_or_compute = AsyncMock(side_effect=fake_get_or_compute)
    return cache


@pytest.mark.asyncio
async def test_warm_skipped_when_feature_flag_off(monkeypatch) -> None:
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", False)
    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )
    assert result.skipped_reason == "feature_flag_off"


@pytest.mark.asyncio
async def test_warm_over_cap_fills_top_level_but_skips_fanout(monkeypatch) -> None:
    """Above MAX_NODE_COUNT only the expensive aggregated/children fan-out
    is skipped — the top-level entry (cheap via the materialized payload)
    is still warmed, which is exactly what large graphs need."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 100)
    redis = _make_redis()
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: redis)
    cache = _make_cache_with_top_level(top_urns=["urn:a"], children_per=1)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=MagicMock()),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", node_count=10_000, session=MagicMock(),
    )

    assert result.top_level_filled is True
    assert result.skipped_reason and "over_cap" in result.skipped_reason
    assert result.aggregated_filled is False
    assert result.children_filled == 0
    endpoints = [kw["endpoint"] for _, kw in cache.get_or_compute.await_args_list]
    assert endpoints == [cache_warmer.ENDPOINT_TOP_LEVEL]


@pytest.mark.asyncio
async def test_warm_skipped_when_lock_held_elsewhere(monkeypatch) -> None:
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 0)
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: _make_redis(lock_acquired=False))

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )
    assert result.skipped_reason == "lock_held_elsewhere"


@pytest.mark.asyncio
async def test_warm_happy_path_fills_all_three_endpoints(monkeypatch) -> None:
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 0)
    monkeypatch.setattr(cache_warmer, "CHILDREN_FANOUT", 5)
    monkeypatch.setattr(cache_warmer, "ONE_DOWN_FANOUT", 2)
    # Step-4 is opt-in after P2.2.6; enable for this test which exercises it.
    monkeypatch.setattr(cache_warmer, "ENABLE_ONE_DOWN", True)

    redis = _make_redis()
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: redis)
    cache = _make_cache_with_top_level(top_urns=["urn:a", "urn:b"], children_per=2)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=MagicMock()),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )

    assert result.top_level_filled is True
    assert result.aggregated_filled is True
    # 2 top-level URNs, each producing children calls
    assert result.children_filled == 2
    # Each top-level has 2 children, one-down fanout = 2 ⇒ 2 × 2 = 4 one-down calls
    assert result.one_down_filled == 4
    assert result.errors == []
    # Lock released
    redis.delete.assert_awaited_once()


@pytest.mark.asyncio
async def test_warm_skips_one_down_when_flag_is_off(monkeypatch) -> None:
    """Regression for P2.2.6: step 4 must be opt-in. With the default
    ENABLE_ONE_DOWN=False the warmer fills top-level + aggregated +
    children but does NOT fan out one level further, regardless of
    ONE_DOWN_FANOUT."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 0)
    monkeypatch.setattr(cache_warmer, "CHILDREN_FANOUT", 5)
    monkeypatch.setattr(cache_warmer, "ONE_DOWN_FANOUT", 2)
    monkeypatch.setattr(cache_warmer, "ENABLE_ONE_DOWN", False)

    redis = _make_redis()
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: redis)
    cache = _make_cache_with_top_level(top_urns=["urn:a", "urn:b"], children_per=2)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=MagicMock()),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )

    assert result.top_level_filled is True
    assert result.aggregated_filled is True
    assert result.children_filled == 2
    # Critical: zero one-down calls when the flag is off.
    assert result.one_down_filled == 0


@pytest.mark.asyncio
async def test_warm_aborts_on_provider_unavailable_in_children(monkeypatch) -> None:
    """A ProviderUnavailable mid-children must stop adding load — no
    one-down calls should fire, but earlier steps' results stand."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 0)
    monkeypatch.setattr(cache_warmer, "CHILDREN_FANOUT", 5)
    monkeypatch.setattr(cache_warmer, "ONE_DOWN_FANOUT", 2)
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: _make_redis())

    async def cache_calls(*, endpoint, **_kw):
        if endpoint == cache_warmer.ENDPOINT_TOP_LEVEL:
            return SimpleNamespace(nodes=[SimpleNamespace(urn="urn:a")])
        if endpoint == cache_warmer.ENDPOINT_AGGREGATED:
            return SimpleNamespace(aggregated_edges=[])
        if endpoint == cache_warmer.ENDPOINT_CHILDREN:
            raise ProviderUnavailable("falkordb", "breaker open")
        return SimpleNamespace()

    cache = MagicMock()
    cache.get_or_compute = AsyncMock(side_effect=cache_calls)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=MagicMock()),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )

    assert result.top_level_filled is True
    assert result.aggregated_filled is True
    assert result.children_filled == 0
    assert result.one_down_filled == 0
    assert any("children" in e and "ProviderUnavailable" in e for e in result.errors)


@pytest.mark.asyncio
async def test_warm_empty_top_level_short_circuits(monkeypatch) -> None:
    """When a DS has zero top-level nodes (e.g. brand new), the warmer
    fills top-level (so the empty answer is cached negatively) but does
    not pursue aggregated/children — there's nothing to fan out from."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 0)
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: _make_redis())

    cache = _make_cache_with_top_level(top_urns=[], children_per=0)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=MagicMock()),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )

    assert result.top_level_filled is True
    assert result.aggregated_filled is False
    assert result.children_filled == 0
    assert result.one_down_filled == 0


@pytest.mark.asyncio
async def test_shutdown_cancels_inflight_and_refuses_new_warms(monkeypatch) -> None:
    """Shutdown must cancel tracked warm tasks (they hold READONLY-pool
    sessions that must be released before engine disposal) and refuse
    any warm scheduled afterwards."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "_shutting_down", False)
    monkeypatch.setattr(cache_warmer, "JITTER_SECS", 0.0)

    started = asyncio.Event()

    async def hang(**_kw):
        started.set()
        await asyncio.sleep(3600)

    monkeypatch.setattr(cache_warmer, "warm_data_source", hang)

    task = cache_warmer.schedule_warm(ws_id="ws1", ds_id="ds1")
    assert task is not None
    await started.wait()

    await cache_warmer.shutdown(timeout=1.0)

    assert task.cancelled()
    # New warms are refused post-shutdown.
    assert cache_warmer.schedule_warm(ws_id="ws1", ds_id="ds2") is None


@pytest.mark.asyncio
async def test_shutdown_with_no_inflight_tasks_is_a_noop(monkeypatch) -> None:
    monkeypatch.setattr(cache_warmer, "_shutting_down", False)
    await cache_warmer.shutdown(timeout=0.1)  # must not raise or hang


@pytest.mark.asyncio
async def test_warm_top_level_compute_serves_from_materialized_payload(monkeypatch) -> None:
    """On a cache miss the warm's top-level compute must consult the
    materialized Postgres payload first — warming a large graph is a
    Postgres read → Redis fill, never a live O(N) scan."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 100)
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: _make_redis())

    cache = MagicMock()

    async def fake_get_or_compute(*, compute, **_kw):
        return await compute()  # cache MISS → compute runs

    cache.get_or_compute = AsyncMock(side_effect=fake_get_or_compute)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)

    served = SimpleNamespace(nodes=[])
    serve_spy = AsyncMock(return_value=(served, 42))
    monkeypatch.setattr(cache_warmer, "try_serve_top_level", serve_spy)

    engine = MagicMock()
    engine.get_top_level_or_orphan_nodes = AsyncMock(
        side_effect=AssertionError("live query must not run"),
    )
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=engine),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", node_count=10_000, session=MagicMock(),
    )

    assert result.top_level_filled is True
    serve_spy.assert_awaited_once()
    engine.get_top_level_or_orphan_nodes.assert_not_called()


@pytest.mark.asyncio
async def test_warm_top_level_compute_falls_back_live_with_known_total(monkeypatch) -> None:
    """When the materialized payload can't serve the page but knows the
    total, the live fallback forwards it as known_total_count (skipping
    the O(N) count scan)."""
    monkeypatch.setattr(cache_warmer, "CACHE_PREWARM_ENABLED", True)
    monkeypatch.setattr(cache_warmer, "MAX_NODE_COUNT", 0)
    monkeypatch.setattr(cache_warmer, "get_redis", lambda: _make_redis())

    cache = MagicMock()

    async def fake_get_or_compute(*, compute, endpoint, **_kw):
        if endpoint == cache_warmer.ENDPOINT_TOP_LEVEL:
            return await compute()
        return SimpleNamespace(aggregated_edges=[], children=[])

    cache.get_or_compute = AsyncMock(side_effect=fake_get_or_compute)
    monkeypatch.setattr(cache_warmer, "get_graph_cache", lambda: cache)

    serve_spy = AsyncMock(return_value=(None, 42))
    monkeypatch.setattr(cache_warmer, "try_serve_top_level", serve_spy)

    engine = MagicMock()
    engine.get_top_level_or_orphan_nodes = AsyncMock(
        return_value=SimpleNamespace(nodes=[]),
    )
    monkeypatch.setattr(
        cache_warmer.ContextEngine, "for_workspace",
        AsyncMock(return_value=engine),
    )

    result = await cache_warmer.warm_data_source(
        ws_id="ws1", ds_id="ds1", session=MagicMock(),
    )

    assert result.top_level_filled is True
    live_kwargs = engine.get_top_level_or_orphan_nodes.await_args.kwargs
    assert live_kwargs["known_total_count"] == 42
