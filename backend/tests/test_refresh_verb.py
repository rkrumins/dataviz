"""Unit tests for ``AggregationService.refresh_source`` — the unified
operator refresh verb that dispatches four scopes over the existing
convergence primitives.

The collaborators (the signal, content-cache clear, hierarchy
invalidation, aggregated-LKG purge, stats nudge, stale marker, rebuild
trigger, job poll, audit emit) are mocked and record their call ORDER;
what is under test is the per-scope dispatch:

    auto        → delegate verbatim to signal_source_changed (reuse ITS
                  event id; emit NO second event)
    read-caches → clear_content_caches → invalidate_hierarchy_reads →
                  purge_lkg(aggregated) → mark_stats_changed
                  (no gate, no marker, no trigger)
    rollups     → mark_source_stale → trigger (fresh refresh-rollups: key)
    full        → read-caches steps, then rollups steps
    clear       → the read-caches steps, THEN clear_source_stale (un-sticks
                  a stuck source; no gate, no cooldown, no trigger)

Exactly one audit event per call; an unknown ds 404s before any side
effect; ``wait='complete'`` polls a queued rebuild to a terminal status.
"""
import asyncio
import types

import pytest

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services import graph_cache as graph_cache_mod
from backend.app.services.aggregation import service as svc_mod
from backend.app.services.aggregation.models import AggregationDataSourceStateORM
from backend.app.services.aggregation.service import (
    AggregationService,
    ConflictError,
    NotFoundError,
)
from backend.insights_service import enqueue as enqueue_mod


def _run(coro):
    return asyncio.run(coro)


# ── Fakes ───────────────────────────────────────────────────────────────


class _FakeProvider:
    def __init__(self, order):
        self._order = order

    async def clear_content_caches(self):
        self._order.append("clear_content_caches")


class _FakeRegistry:
    def __init__(self, provider):
        self._provider = provider

    async def get_provider_for_workspace(self, ws, session, data_source_id=None):
        return self._provider


class _FakeSession:
    """Dispatches ``.get`` on the ORM class the service asks for."""

    def __init__(self, *, state=None, ds=None):
        self._state = state
        self._ds = ds

    async def get(self, orm, key):
        if orm is AggregationDataSourceStateORM:
            return self._state
        if orm is WorkspaceDataSourceORM:
            return self._ds
        return None


class _FakeCache:
    """Stand-in for the GraphCache singleton — only ``purge_lkg`` is
    exercised by the read-caches scope (aggregated LKG override)."""

    def __init__(self, order, purge_count=3):
        self._order = order
        self._purge_count = purge_count

    async def purge_lkg(self, scope, endpoint):
        self._order.append("purge_lkg_aggregated")
        return self._purge_count


def _state(ws="ws-1"):
    return types.SimpleNamespace(
        data_source_id="ds-1", workspace_id=ws, aggregation_status="ready",
        graph_fingerprint="STORED", last_aggregated_at=None,
    )


def _ds_row(ws="ws-1"):
    return types.SimpleNamespace(id="ds-1", workspace_id=ws, deleted_at=None)


def _build(
    monkeypatch,
    *,
    state=None,
    ds=None,
    trigger_job_id="agg_new",
    trigger_exc=None,
    invalidate_purge_count=2,
    agg_purge_count=3,
    emit_raises=False,
):
    """Wire a service with all collaborators mocked to record call order.
    Returns (svc, session, order, captured). Emitted audit-event kwargs
    land on ``svc._events``."""
    order = []
    captured = {}
    provider = _FakeProvider(order)
    svc = AggregationService(
        dispatcher=None, registry=_FakeRegistry(provider), session_factory=None,
    )

    events = []
    svc._events = events

    async def _fake_emit(session_factory_or_none, **kwargs):
        if emit_raises:
            raise RuntimeError("emit boom")
        events.append(kwargs)
        return f"evt_{len(events)}"

    from backend.app.db.repositories import refresh_events_repo as refresh_events_repo_mod
    monkeypatch.setattr(refresh_events_repo_mod, "emit_refresh_event", _fake_emit)

    async def _fake_invalidate(ws, ds_):
        order.append("invalidate_hierarchy_reads")
        return invalidate_purge_count

    monkeypatch.setattr(graph_cache_mod, "invalidate_hierarchy_reads", _fake_invalidate)

    monkeypatch.setattr(
        graph_cache_mod, "get_graph_cache",
        lambda: _FakeCache(order, purge_count=agg_purge_count),
    )

    async def _fake_mark_stale(ws, ds_, reason):
        order.append("mark_source_stale")
        captured["mark_reason"] = reason

    monkeypatch.setattr(graph_cache_mod, "mark_source_stale", _fake_mark_stale)

    async def _fake_clear_stale(ws, ds_):
        order.append("clear_source_stale")

    monkeypatch.setattr(graph_cache_mod, "clear_source_stale", _fake_clear_stale)

    async def _fake_stats(ds_, ws):
        order.append("mark_stats_changed")

    monkeypatch.setattr(enqueue_mod, "mark_stats_changed", _fake_stats)

    async def _fake_trigger(ds_id, request, trigger_source, session):
        order.append("trigger")
        captured.setdefault("requests", []).append(request)
        captured["trigger_source"] = trigger_source
        if trigger_exc is not None:
            raise trigger_exc
        return types.SimpleNamespace(id=trigger_job_id)

    monkeypatch.setattr(svc, "trigger", _fake_trigger)

    session = _FakeSession(state=state, ds=ds)
    return svc, session, order, captured


_READ_CACHES_SEQUENCE = [
    "clear_content_caches",
    "invalidate_hierarchy_reads",
    "purge_lkg_aggregated",
    "mark_stats_changed",
]
_ROLLUPS_SEQUENCE = ["mark_source_stale", "trigger"]


# ── auto: delegate verbatim, reuse the signal's event ───────────────────


def test_auto_delegates_verbatim_and_reuses_signal_event(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())

    async def _fake_signal(ds_id, sess, *, force=False, origin="api",
                           actor="internal", reason=None):
        captured["signal"] = dict(
            ds_id=ds_id, force=force, origin=origin, actor=actor, reason=reason,
        )
        return types.SimpleNamespace(
            changed=True, job_id="agg_123", deferred=False, event_id="evt_signal",
        )

    monkeypatch.setattr(svc, "signal_source_changed", _fake_signal)

    resp = _run(svc.refresh_source(
        "ds-1", session, scope="auto", reason="drift",
        origin="api", actor="internal",
    ))

    # Delegated with force/origin/actor passthrough.
    assert captured["signal"]["force"] is False
    assert captured["signal"]["origin"] == "api"
    assert captured["signal"]["actor"] == "internal"
    assert captured["signal"]["reason"] == "drift"
    # Response mapped from the signal; its event id reused, NOT re-emitted.
    assert resp.scope == "auto"
    assert resp.gate == "changed"
    assert resp.changed is True
    assert resp.job_id == "agg_123"
    assert resp.event_id == "evt_signal"
    assert resp.actions == ["rebuild_queued"]
    assert svc._events == []  # auto emits NO event of its own


def test_auto_force_passthrough_maps_forced_gate(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())

    async def _fake_signal(ds_id, sess, *, force=False, **kw):
        captured["force"] = force
        return types.SimpleNamespace(
            changed=True, job_id="agg_1", deferred=False, event_id="evt_x",
        )

    monkeypatch.setattr(svc, "signal_source_changed", _fake_signal)

    resp = _run(svc.refresh_source("ds-1", session, scope="auto", force=True))
    assert captured["force"] is True
    assert resp.gate == "forced"


def test_auto_unchanged_gate_maps_to_noop(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())

    async def _fake_signal(ds_id, sess, *, force=False, **kw):
        return types.SimpleNamespace(
            changed=False, job_id=None, deferred=False, event_id="evt_noop",
        )

    monkeypatch.setattr(svc, "signal_source_changed", _fake_signal)

    resp = _run(svc.refresh_source("ds-1", session, scope="auto"))
    assert resp.gate == "unchanged"
    assert resp.changed is False
    assert resp.job_id is None
    assert resp.actions == []


# ── read-caches: four actions in order, no marker/trigger/gate ──────────


def test_read_caches_runs_four_actions_in_order(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())
    resp = _run(svc.refresh_source("ds-1", session, scope="read-caches"))

    assert order == _READ_CACHES_SEQUENCE
    assert "mark_source_stale" not in order
    assert "trigger" not in order
    assert resp.scope == "read-caches"
    assert resp.gate == "n/a"
    assert resp.changed is True
    assert resp.job_id is None
    assert resp.actions == [
        "content_cleared", "hierarchy_invalidated",
        "aggregated_lkg_purged", "stats_nudged",
    ]
    # Exactly one event, scope read-caches, outcome accepted, no marker/job.
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["scope"] == "read-caches"
    assert evt["gate"] == "n/a"
    assert evt["outcome"] == "accepted"
    assert evt["actions"]["marker_set"] is False
    assert evt["actions"]["content_cleared"] is True
    assert evt["actions"]["job_id"] is None
    assert evt["actions"]["aggregated_lkg_purged"] == 3
    assert resp.event_id == "evt_1"


def test_read_caches_stats_nudge_failure_does_not_raise(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())

    async def _boom(ds_, ws):
        order.append("mark_stats_changed")
        raise RuntimeError("stats down")

    monkeypatch.setattr(enqueue_mod, "mark_stats_changed", _boom)

    resp = _run(svc.refresh_source("ds-1", session, scope="read-caches"))
    # The prior invalidation still ran and the verb still succeeded.
    assert resp.changed is True
    assert order == _READ_CACHES_SEQUENCE
    assert len(svc._events) == 1


# ── rollups: marker + trigger with a fresh refresh-rollups key ──────────


def test_rollups_marks_and_triggers_with_refresh_key(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(), trigger_job_id="agg_roll",
    )
    resp = _run(svc.refresh_source("ds-1", session, scope="rollups"))

    assert order == _ROLLUPS_SEQUENCE
    assert "clear_content_caches" not in order
    assert captured["mark_reason"] == "source_changed"
    key = captured["requests"][0].idempotency_key
    assert key.startswith("refresh-rollups:")
    assert key != "refresh-rollups:"
    assert resp.scope == "rollups"
    assert resp.gate == "n/a"
    assert resp.job_id == "agg_roll"
    assert resp.actions == ["marker_set", "rebuild_queued"]
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["scope"] == "rollups"
    assert evt["outcome"] == "accepted"
    assert evt["actions"]["marker_set"] is True
    assert evt["actions"]["job_id"] == "agg_roll"


def test_rollups_key_is_unique_per_call(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())
    _run(svc.refresh_source("ds-1", session, scope="rollups"))
    _run(svc.refresh_source("ds-1", session, scope="rollups"))
    keys = [r.idempotency_key for r in captured["requests"]]
    assert len(keys) == 2
    assert keys[0] != keys[1]  # fresh key every call = dedup bypass


def test_rollups_conflict_yields_conflict_no_job(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(),
        trigger_exc=ConflictError("job already active"),
    )
    resp = _run(svc.refresh_source("ds-1", session, scope="rollups"))
    # Marker set, trigger attempted then swallowed — no exception to caller.
    assert order == _ROLLUPS_SEQUENCE
    assert resp.job_id is None
    assert resp.changed is True
    assert resp.actions == ["marker_set", "rebuild_conflict"]
    assert len(svc._events) == 1
    assert svc._events[0]["outcome"] == "conflict"
    assert svc._events[0]["actions"]["job_id"] is None


# ── full: read-caches ∪ rollups, in order, one event ────────────────────


def test_full_runs_read_caches_then_rollups_in_order(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(), trigger_job_id="agg_full",
    )
    resp = _run(svc.refresh_source("ds-1", session, scope="full"))

    assert order == _READ_CACHES_SEQUENCE + _ROLLUPS_SEQUENCE
    assert resp.scope == "full"
    assert resp.gate == "n/a"
    assert resp.job_id == "agg_full"
    assert resp.actions == [
        "content_cleared", "hierarchy_invalidated",
        "aggregated_lkg_purged", "stats_nudged",
        "marker_set", "rebuild_queued",
    ]
    # One event total, scope full, union of what ran.
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["scope"] == "full"
    assert evt["actions"]["marker_set"] is True
    assert evt["actions"]["content_cleared"] is True
    assert evt["actions"]["job_id"] == "agg_full"


# ── clear: read-caches steps + un-stick the marker, no trigger ─────────


def test_clear_runs_read_caches_then_clears_marker(monkeypatch):
    svc, session, order, captured = _build(monkeypatch, state=_state())
    resp = _run(svc.refresh_source("ds-1", session, scope="clear"))

    assert order == _READ_CACHES_SEQUENCE + ["clear_source_stale"]
    assert "mark_source_stale" not in order
    assert "trigger" not in order
    assert resp.scope == "clear"
    assert resp.gate == "n/a"
    assert resp.changed is True
    assert resp.job_id is None
    assert resp.actions == [
        "content_cleared", "hierarchy_invalidated",
        "aggregated_lkg_purged", "stats_nudged", "marker_cleared",
    ]
    # Exactly one event, scope clear, marker recorded cleared not set.
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["scope"] == "clear"
    assert evt["gate"] == "n/a"
    assert evt["outcome"] == "accepted"
    assert evt["actions"]["marker_set"] is False
    assert evt["actions"]["marker_cleared"] is True
    assert evt["actions"]["job_id"] is None
    assert resp.event_id == "evt_1"


def test_clear_does_not_touch_marker_when_workspace_unresolved(monkeypatch):
    deleted = types.SimpleNamespace(id="ds-1", workspace_id="ws-1",
                                    deleted_at="2026-07-18T00:00:00Z")
    svc, session, order, captured = _build(monkeypatch, state=None, ds=deleted)
    resp = _run(svc.refresh_source("ds-1", session, scope="clear"))
    assert "clear_source_stale" not in order  # workspace_id unresolved
    assert "marker_cleared" not in resp.actions


# ── unknown ds → NotFoundError BEFORE any side effect ───────────────────


@pytest.mark.parametrize("scope", ["auto", "read-caches", "rollups", "full", "clear"])
def test_unknown_ds_raises_notfound_before_side_effects(monkeypatch, scope):
    svc, session, order, captured = _build(monkeypatch, state=None, ds=None)

    async def _fake_signal(*a, **k):
        order.append("signal")  # must NOT be reached
        return types.SimpleNamespace(
            changed=True, job_id=None, deferred=False, event_id=None,
        )

    monkeypatch.setattr(svc, "signal_source_changed", _fake_signal)

    with pytest.raises(NotFoundError):
        _run(svc.refresh_source("ds-1", session, scope=scope))
    assert order == []           # no collaborator ran
    assert svc._events == []     # no audit event emitted


def test_soft_deleted_ds_row_still_counts_as_existing(monkeypatch):
    # A row exists (soft-deleted) but no state row → NOT a 404 (a row is
    # present); workspace stays unresolved so workspace-scoped steps skip.
    deleted = types.SimpleNamespace(id="ds-1", workspace_id="ws-1",
                                    deleted_at="2026-07-18T00:00:00Z")
    svc, session, order, captured = _build(monkeypatch, state=None, ds=deleted)
    resp = _run(svc.refresh_source("ds-1", session, scope="read-caches"))
    assert resp.scope == "read-caches"
    assert "invalidate_hierarchy_reads" not in order  # workspace_id unresolved


# ── wait=complete: poll a queued rebuild to terminal ────────────────────


def _fast_sleep(monkeypatch):
    async def _no_sleep(*a, **k):
        return None
    monkeypatch.setattr(svc_mod.asyncio, "sleep", _no_sleep)


def test_wait_complete_polls_to_completed(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(), trigger_job_id="agg_w",
    )
    _fast_sleep(monkeypatch)

    statuses = iter(["pending", "running", "completed"])

    async def _fake_get_job(ds_id, job_id, sess):
        return types.SimpleNamespace(id=job_id, status=next(statuses))

    monkeypatch.setattr(svc, "get_job", _fake_get_job)

    resp = _run(svc.refresh_source(
        "ds-1", session, scope="rollups", wait="complete",
    ))
    assert resp.job_id == "agg_w"
    assert resp.actions[-1] == "job:completed"
    # The terminal status is response-only — never in the audit event.
    assert "job:completed" not in str(svc._events[0]["actions"])


def test_wait_complete_times_out(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(), trigger_job_id="agg_w",
    )
    _fast_sleep(monkeypatch)
    monkeypatch.setattr(svc_mod, "_REFRESH_WAIT_TIMEOUT_S", 4)
    monkeypatch.setattr(svc_mod, "_REFRESH_WAIT_INTERVAL_S", 2)

    async def _never_done(ds_id, job_id, sess):
        return types.SimpleNamespace(id=job_id, status="running")

    monkeypatch.setattr(svc, "get_job", _never_done)

    resp = _run(svc.refresh_source(
        "ds-1", session, scope="rollups", wait="complete",
    ))
    assert resp.actions[-1] == "job:timeout"


def test_wait_none_never_polls(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(), trigger_job_id="agg_w",
    )

    async def _boom_get_job(*a, **k):
        raise AssertionError("get_job must not be called for wait='none'")

    monkeypatch.setattr(svc, "get_job", _boom_get_job)
    resp = _run(svc.refresh_source("ds-1", session, scope="rollups"))
    assert all(not a.startswith("job:") for a in resp.actions)


# ── exactly one event per call, correct scope ───────────────────────────


@pytest.mark.parametrize(
    "scope,expected", [
        ("read-caches", "read-caches"),
        ("rollups", "rollups"),
        ("full", "full"),
        ("clear", "clear"),
    ],
)
def test_one_event_per_call_with_correct_scope(monkeypatch, scope, expected):
    svc, session, order, captured = _build(monkeypatch, state=_state())
    _run(svc.refresh_source("ds-1", session, scope=scope))
    assert len(svc._events) == 1
    assert svc._events[0]["scope"] == expected


def test_emit_failure_does_not_break_refresh(monkeypatch):
    # Audit emit is best-effort — a raise must not fail the operation.
    svc, session, order, captured = _build(
        monkeypatch, state=_state(), emit_raises=True,
    )
    resp = _run(svc.refresh_source("ds-1", session, scope="rollups"))
    assert resp.changed is True
    assert resp.job_id == "agg_new"
    assert resp.event_id is None


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
