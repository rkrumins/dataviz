"""AggregationEventListener contract: a ``job.completed`` event syncs
the local workspace_data_sources row AND invalidates the aggregated-edge
graph cache (generation bump + LKG purge).

The invalidation half is the fix for the observed stale-canvas class:
the aggregated-edge LKG entries survive generation bumps by design, so
without an explicit purge a completed aggregation run kept serving
pre-run (often empty) answers for up to the LKG TTL.
"""
import asyncio
import json
import types
from unittest.mock import AsyncMock

from backend.app.services.aggregation.event_listener import AggregationEventListener
from backend.app.services import graph_cache as gc_module


def _run(coro):
    return asyncio.run(coro)


class _NullSessionCM:
    """Trivial async context manager standing in for a real DB session —
    the fake ``list_refresh_events`` below never touches it."""

    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc):
        return False


def _listener(monkeypatch, *, emit_raises=False, prior_events=None):
    """Builds a bare listener with ``emit_refresh_event``/``list_refresh_events``
    monkeypatched (a pure-unit harness has no business opening a real DB
    session); captured event kwargs land on ``lst._events``.

    ``prior_events`` seeds the fake ``list_refresh_events`` result (a list
    of ``types.SimpleNamespace(outcome=..., actions=<json str>, origin=...,
    actor=...)``) for the origin-provenance lookup tests; defaults to no
    prior events (lookup finds nothing, falls back to origin="api")."""
    lst = AggregationEventListener.__new__(AggregationEventListener)
    lst._session_factory = lambda: _NullSessionCM()

    events = []
    lst._events = events

    async def _fake_emit(session_factory_or_none, **kwargs):
        if emit_raises:
            raise RuntimeError("emit boom")
        events.append(kwargs)
        return f"evt_{len(events)}"

    from backend.app.db.repositories import refresh_events_repo as refresh_events_repo_mod
    monkeypatch.setattr(refresh_events_repo_mod, "emit_refresh_event", _fake_emit)

    async def _fake_list(session, data_source_id, limit=20):
        return prior_events or []

    monkeypatch.setattr(refresh_events_repo_mod, "list_refresh_events", _fake_list)

    return lst


def test_job_completed_invalidates_aggregated_cache(monkeypatch):
    lst = _listener(monkeypatch)
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
    assert len(lst._events) == 1
    evt = lst._events[0]
    assert evt["outcome"] == "completed"
    assert evt["origin"] == "api"
    assert evt["gate"] == "n/a"
    assert evt["detail"] == "listener"
    assert evt["actions"] == {"job_id": "agg_1"}
    assert evt["workspace_id"] == "ws_1"
    assert evt["data_source_id"] == "ds_1"


def test_job_completed_without_workspace_skips_invalidation(monkeypatch):
    """Events from workers that predate the workspace_id field must not
    guess a scope — sync still happens, invalidation is skipped."""
    lst = _listener(monkeypatch)
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
    lst = _listener(monkeypatch)
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
    lst = _listener(monkeypatch)
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
    assert len(lst._events) == 1
    assert lst._events[0]["outcome"] == "completed"


def test_job_completed_event_emitted_after_marker_clear(monkeypatch):
    """The event fires beside the existing marker-clear, not before it —
    prove ordering with a shared side-effect list."""
    lst = _listener(monkeypatch)
    lst._sync_data_source = AsyncMock()

    order = []
    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=0)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    async def _fake_clear(ws, ds):
        order.append("clear_stale_marker")

    monkeypatch.setattr(gc_module, "clear_source_stale", _fake_clear)

    from backend.app.db.repositories import refresh_events_repo as refresh_events_repo_mod

    async def _fake_emit(session_factory_or_none, **kwargs):
        order.append("emit_event")
        return "evt_1"

    monkeypatch.setattr(refresh_events_repo_mod, "emit_refresh_event", _fake_emit)

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {
            "job_id": "agg_1", "data_source_id": "ds_1", "workspace_id": "ws_1",
        },
    }))

    assert order == ["clear_stale_marker", "emit_event"]


def test_job_failed_does_not_clear_stale_marker(monkeypatch):
    """A failed rebuild leaves the marker set — the reconciler retries
    after cooldown, and that retry loop depends on the marker persisting."""
    lst = _listener(monkeypatch)
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
    assert len(lst._events) == 1
    evt = lst._events[0]
    assert evt["outcome"] == "failed"
    assert evt["gate"] == "n/a"
    assert evt["actions"] == {"job_id": "agg_1"}


def test_job_completed_without_workspace_skips_stale_clear(monkeypatch):
    """Mirrors the invalidation skip: the marker key is workspace-scoped
    and can't be built without a workspace_id, so the clear is skipped
    silently rather than guessing."""
    lst = _listener(monkeypatch)
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
    assert len(lst._events) == 1
    assert lst._events[0]["workspace_id"] is None


def test_purge_completed_emits_no_audit_event(monkeypatch):
    """purge.completed is out of scope for this audit emission — only
    job.completed/job.failed are wired."""
    lst = _listener(monkeypatch)
    synced = {}

    async def fake_sync(ds_id, **fields):
        synced["ds"] = ds_id

    lst._sync_data_source = fake_sync
    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=1)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    _run(lst._handle_event({
        "type": "purge.completed",
        "payload": {
            "job_id": "agg_p1", "data_source_id": "ds_1",
            "workspace_id": "ws_1", "deleted_edges": 5,
        },
    }))

    assert lst._events == []


def test_emit_failure_does_not_break_job_completed_handling(monkeypatch):
    """emit_refresh_event is contractually never-raising, but the
    listener's own call site must be defensive regardless."""
    lst = _listener(monkeypatch, emit_raises=True)
    synced = {}

    async def fake_sync(ds_id, **fields):
        synced["ds"] = ds_id

    lst._sync_data_source = fake_sync
    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=0)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)
    clear_mock = AsyncMock()
    monkeypatch.setattr(gc_module, "clear_source_stale", clear_mock)

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1", "workspace_id": "ws_1"},
    }))

    assert synced["ds"] == "ds_1"
    clear_mock.assert_awaited_once()


def test_emit_failure_does_not_break_job_failed_handling(monkeypatch):
    lst = _listener(monkeypatch, emit_raises=True)
    synced = {}

    async def fake_sync(ds_id, **fields):
        synced["ds"] = ds_id

    lst._sync_data_source = fake_sync
    cache = AsyncMock()
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    _run(lst._handle_event({
        "type": "job.failed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1", "workspace_id": "ws_1"},
    }))

    assert synced["ds"] == "ds_1"


# ── Origin-provenance lookup: reuse the accepting signal event's origin ──


def _accepted_row(job_id, origin, actor="internal"):
    return types.SimpleNamespace(
        outcome="accepted",
        actions=json.dumps({"job_id": job_id, "deferred": False}),
        origin=origin,
        actor=actor,
    )


def test_job_completed_reuses_origin_from_matching_accepted_event(monkeypatch):
    """A scheduler-driven drift rebuild's completion must carry
    origin="drift" (not "api") — found via the last 10 refresh_events
    rows for this source, matched by job_id inside the actions JSON."""
    lst = _listener(monkeypatch, prior_events=[
        _accepted_row("agg_9", origin="unrelated", actor="internal"),
        _accepted_row("agg_1", origin="drift", actor="scheduler"),
    ])
    lst._sync_data_source = AsyncMock()
    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=0)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(gc_module, "clear_source_stale", AsyncMock())

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1", "workspace_id": "ws_1"},
    }))

    assert len(lst._events) == 1
    assert lst._events[0]["origin"] == "drift"
    assert lst._events[0]["actor"] == "scheduler"


def test_job_completed_falls_back_to_api_when_no_matching_event(monkeypatch):
    lst = _listener(monkeypatch, prior_events=[
        _accepted_row("agg_other", origin="drift"),  # different job_id
    ])
    lst._sync_data_source = AsyncMock()
    cache = AsyncMock()
    cache.purge_lkg = AsyncMock(return_value=0)
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)
    monkeypatch.setattr(gc_module, "clear_source_stale", AsyncMock())

    _run(lst._handle_event({
        "type": "job.completed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1", "workspace_id": "ws_1"},
    }))

    assert lst._events[0]["origin"] == "api"
    assert lst._events[0]["actor"] == "internal"


def test_job_failed_origin_lookup_failure_falls_back_to_api(monkeypatch):
    """The lookup itself must never break the listener — a raising
    list_refresh_events (or a broken session factory) falls back to
    origin="api" rather than propagating."""
    lst = _listener(monkeypatch)

    async def _raising_list(session, data_source_id, limit=20):
        raise RuntimeError("db boom")

    from backend.app.db.repositories import refresh_events_repo as refresh_events_repo_mod
    monkeypatch.setattr(refresh_events_repo_mod, "list_refresh_events", _raising_list)

    lst._sync_data_source = AsyncMock()
    cache = AsyncMock()
    monkeypatch.setattr(gc_module, "get_graph_cache", lambda: cache)

    _run(lst._handle_event({
        "type": "job.failed",
        "payload": {"job_id": "agg_1", "data_source_id": "ds_1", "workspace_id": "ws_1"},
    }))

    assert len(lst._events) == 1
    assert lst._events[0]["origin"] == "api"
    assert lst._events[0]["actor"] == "internal"
