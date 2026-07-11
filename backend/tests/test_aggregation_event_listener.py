"""AggregationEventListener contract: a ``job.completed`` event syncs
the local workspace_data_sources row AND invalidates the aggregated-edge
graph cache (generation bump + LKG purge).

The invalidation half is the fix for the observed stale-canvas class:
the aggregated-edge LKG entries survive generation bumps by design, so
without an explicit purge a completed aggregation run kept serving
pre-run (often empty) answers for up to the LKG TTL.
"""
import asyncio
from unittest.mock import AsyncMock

from backend.app.services.aggregation.event_listener import AggregationEventListener
from backend.app.services import graph_cache as gc_module


def _run(coro):
    return asyncio.run(coro)


def _listener():
    lst = AggregationEventListener.__new__(AggregationEventListener)
    lst._session_factory = None
    return lst


def test_job_completed_invalidates_aggregated_cache(monkeypatch):
    lst = _listener()
    synced = {}

    async def fake_sync(ds_id, **fields):
        synced["ds"] = ds_id
        synced.update(fields)

    lst._sync_data_source = fake_sync

    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=3)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)
    gc_module._cache = None  # never let a real singleton leak in

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {
            "job_id": "agg_1",
            "data_source_id": "ds_1",
            "workspace_id": "ws_1",
            "edge_count": 1840,
            "completed_at": "2026-07-11T00:00:00Z",
            "fingerprint": "fp",
        },
    }))

    assert synced["ds"] == "ds_1"
    assert synced["aggregation_edge_count"] == 1840
    cache.bump_generation.assert_awaited_once()
    scope = cache.bump_generation.await_args.args[0]
    assert (scope.workspace_id, scope.data_source_id) == ("ws_1", "ds_1")
    cache.purge_lkg.assert_awaited_once()
    assert cache.purge_lkg.await_args.args[1] == gc_module.ENDPOINT_AGGREGATED


def test_job_completed_without_workspace_skips_invalidation(monkeypatch):
    """Events from workers that predate the workspace_id field must not
    guess a scope — sync still happens, invalidation is skipped."""
    lst = _listener()
    synced = {}

    async def fake_sync(ds_id, **fields):
        synced["ds"] = ds_id

    lst._sync_data_source = fake_sync
    cache = AsyncMock()
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1"},
    }))

    assert synced["ds"] == "ds_1"
    cache.bump_generation.assert_not_awaited()
    cache.purge_lkg.assert_not_awaited()
