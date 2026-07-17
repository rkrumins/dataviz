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


def test_purge_completed_syncs_and_invalidates(monkeypatch):
    """A purge is the same cache-relevant event as a completed run with
    the opposite sign: status resets AND the aggregated read caches are
    invalidated, or canvases keep serving pre-purge answers."""
    lst = _listener()
    synced = {}

    async def fake_sync(ds_id, **fields):
        synced["ds"] = ds_id
        synced.update(fields)

    lst._sync_data_source = fake_sync
    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=1)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    _run(lst._handle_event({
        "type": "purge.completed",
        "payload": {
            "job_id": "agg_p1",
            "data_source_id": "ds_1",
            "workspace_id": "ws_1",
            "deleted_edges": 1323,
        },
    }))

    assert synced["ds"] == "ds_1"
    assert synced["aggregation_status"] == "none"
    cache.bump_generation.assert_awaited_once()
    cache.purge_lkg.assert_awaited_once()


def test_job_completed_clears_stale_marker(monkeypatch):
    """A completed rebuild is the authority that clears the
    stale-while-revalidate marker so the staleness banner self-clears."""
    lst = _listener()
    lst._sync_data_source = AsyncMock()

    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=0)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    clear_mock = AsyncMock()
    monkeypatch.setattr(gc_module, "clear_source_stale", clear_mock)

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

    clear_mock.assert_awaited_once_with("ws_1", "ds_1")


def test_job_failed_does_not_clear_stale_marker(monkeypatch):
    """A failed rebuild leaves the marker set — the reconciler retries
    after cooldown, and that retry loop depends on the marker persisting."""
    lst = _listener()
    lst._sync_data_source = AsyncMock()

    cache = AsyncMock()
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    clear_mock = AsyncMock()
    monkeypatch.setattr(gc_module, "clear_source_stale", clear_mock)

    _run(lst._handle_event({
        "type": "job.failed",
        "payload": {
            "job_id": "agg_1",
            "data_source_id": "ds_1",
            "workspace_id": "ws_1",
        },
    }))

    clear_mock.assert_not_awaited()


def test_job_completed_without_workspace_skips_stale_clear(monkeypatch):
    """Mirrors the invalidation skip: the marker key is workspace-scoped
    and can't be built without a workspace_id, so the clear is skipped
    silently rather than guessing."""
    lst = _listener()
    lst._sync_data_source = AsyncMock()

    cache = AsyncMock()
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    clear_mock = AsyncMock()
    monkeypatch.setattr(gc_module, "clear_source_stale", clear_mock)

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1"},
    }))

    clear_mock.assert_not_awaited()
