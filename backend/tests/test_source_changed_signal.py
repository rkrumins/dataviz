"""Unit tests for ``AggregationService.signal_source_changed`` — the
change-gated "source changed" convergence signal external loaders call.

The collaborators (fingerprint, stale marker, content-cache clear,
hierarchy invalidation, stats nudge, job trigger) are mocked; what's
under test is the change gate and the exact best-effort sequence:

    mark_source_stale → clear_content_caches → invalidate_hierarchy_reads
    → mark_stats_changed → trigger

Trigger failures after invalidation must never fail the signal.
"""
import asyncio
import types
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services import graph_cache as graph_cache_mod
from backend.app.services.aggregation import fingerprint as fingerprint_mod
from backend.app.services.aggregation import scheduler as scheduler_mod
from backend.app.services.aggregation import service as svc_mod
from backend.app.services.aggregation.models import AggregationDataSourceStateORM
from backend.app.services.aggregation.service import (
    AggregationService,
    ConflictError,
    OntologyResolutionError,
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


class _MemRedis:
    """In-memory async Redis stand-in — enough for the real
    mark_source_stale/get_source_stale_reason marker round-trip (C1)."""

    def __init__(self):
        self.store = {}

    async def set(self, key, value, ex=None):
        self.store[key] = value
        return True

    async def get(self, key):
        return self.store.get(key)

    async def delete(self, *keys):
        removed = 0
        for k in keys:
            if k in self.store:
                del self.store[k]
                removed += 1
        return removed


def _state(status="ready", fp="STORED", ws="ws-1", last_aggregated_at=None):
    return types.SimpleNamespace(
        data_source_id="ds-1",
        workspace_id=ws,
        aggregation_status=status,
        graph_fingerprint=fp,
        last_aggregated_at=last_aggregated_at,
    )


def _secs_ago(seconds: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(seconds=seconds)).isoformat()


def _ds_row(ws="ws-1"):
    return types.SimpleNamespace(id="ds-1", workspace_id=ws, deleted_at=None)


def _build(
    monkeypatch,
    *,
    state=None,
    ds=None,
    current_fp="NEW",
    fp_timeout=False,
    trigger_job_id="agg_new",
    trigger_exc=None,
    cooldown=None,
    emit_raises=False,
    invalidate_purge_count=2,
):
    """Wire a service with all collaborators mocked to record their call
    order. Returns (svc, session, order, captured). The audit emit
    (``emit_refresh_event``) is monkeypatched for every test in this file
    (real DB access has no place in a pure-unit harness); captured event
    kwargs land on ``svc._events`` so new tests can assert on them without
    changing this function's return arity. ``emit_raises=True`` simulates
    a hypothetical break of the "emit never raises" contract, to prove
    the signal still succeeds regardless."""
    if cooldown is not None:
        monkeypatch.setattr(
            svc_mod, "AGGREGATION_REBUILD_MIN_INTERVAL_SECS", cooldown,
        )
    order = []
    captured = {}
    provider = _FakeProvider(order)
    registry = _FakeRegistry(provider)
    svc = AggregationService(dispatcher=None, registry=registry, session_factory=None)

    events = []
    svc._events = events

    async def _fake_emit(session_factory_or_none, **kwargs):
        if emit_raises:
            raise RuntimeError("emit boom")
        events.append(kwargs)
        return f"evt_{len(events)}"

    from backend.app.db.repositories import refresh_events_repo as refresh_events_repo_mod
    monkeypatch.setattr(refresh_events_repo_mod, "emit_refresh_event", _fake_emit)

    async def _fake_fp(prov):
        if fp_timeout:
            raise asyncio.TimeoutError()
        return current_fp

    monkeypatch.setattr(svc_mod, "compute_graph_fingerprint", _fake_fp)

    async def _fake_mark_stale(ws, ds_, reason):
        order.append("mark_source_stale")
        captured["mark_reason"] = reason

    monkeypatch.setattr(graph_cache_mod, "mark_source_stale", _fake_mark_stale)

    async def _fake_clear_stale(ws, ds_):
        order.append("clear_source_stale")

    monkeypatch.setattr(graph_cache_mod, "clear_source_stale", _fake_clear_stale)

    async def _fake_invalidate(ws, ds_):
        order.append("invalidate_hierarchy_reads")
        return invalidate_purge_count

    monkeypatch.setattr(graph_cache_mod, "invalidate_hierarchy_reads", _fake_invalidate)

    async def _fake_stats(ds_, ws):
        order.append("mark_stats_changed")

    monkeypatch.setattr(enqueue_mod, "mark_stats_changed", _fake_stats)

    async def _fake_trigger(ds_id, request, trigger_source, session):
        order.append("trigger")
        captured["request"] = request
        captured["trigger_source"] = trigger_source
        if trigger_exc is not None:
            raise trigger_exc
        return types.SimpleNamespace(id=trigger_job_id)

    monkeypatch.setattr(svc, "trigger", _fake_trigger)

    session = _FakeSession(state=state, ds=ds)
    return svc, session, order, captured


_FULL_SEQUENCE = [
    "mark_source_stale",
    "clear_content_caches",
    "invalidate_hierarchy_reads",
    "mark_stats_changed",
    "trigger",
]


# ── Scenario 1: fingerprints match → no-op ──────────────────────────────


def test_fingerprint_match_is_noop(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="ready", fp="SAME"), current_fp="SAME",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is False
    assert resp.job_id is None
    assert resp.current_fingerprint == "SAME"
    assert resp.stored_fingerprint == "SAME"
    # Nothing after the gate ran.
    assert order == []


# ── Scenario 2: mismatch → full sequence IN ORDER ───────────────────────


def test_mismatch_runs_full_sequence_in_order(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        trigger_job_id="agg_123",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id == "agg_123"
    assert resp.current_fingerprint == "NEW"
    assert resp.stored_fingerprint == "OLD"
    assert order == _FULL_SEQUENCE
    assert captured["trigger_source"] == "api"
    assert captured["request"].idempotency_key == "source-changed:NEW"
    # C1: the marker is written with the literal the overlay/FE contract on,
    # NOT the signal reason ("external_load" here).
    assert captured["mark_reason"] == "source_changed"


# ── Scenario 3: force overrides a matching gate ─────────────────────────


def test_force_runs_sequence_despite_match(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="ready", fp="SAME"), current_fp="SAME",
    )
    resp = _run(svc.signal_source_changed("ds-1", session, force=True))
    assert resp.changed is True
    assert order == _FULL_SEQUENCE
    assert captured["request"].idempotency_key == "source-changed:SAME"


# ── Scenario 4: ConflictError from trigger is benign ────────────────────


def test_trigger_conflict_yields_changed_no_job(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        trigger_exc=ConflictError("job already active"),
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id is None
    # Invalidation still happened; trigger was attempted then swallowed.
    assert order == _FULL_SEQUENCE


@pytest.mark.parametrize(
    "exc",
    [
        ValueError("ontology not assigned"),
        OntologyResolutionError(types.SimpleNamespace(blocking_reasons=["no_lineage"])),
    ],
)
def test_trigger_resolution_failure_yields_changed_no_job(monkeypatch, exc):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        trigger_exc=exc,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id is None
    assert order == _FULL_SEQUENCE


# ── Scenario 5: no state row → invalidate, skip trigger, stored None ────


def test_no_state_row_invalidates_but_skips_trigger(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=None, ds=_ds_row(ws="ws-1"), current_fp="NEW",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id is None
    assert resp.stored_fingerprint is None
    # No state row → status "none" → aggregation not applicable → the marker
    # is NOT set (nothing would clear it) and any prior marker is cleared,
    # but hierarchy convergence + stats still run. (C2)
    assert "mark_source_stale" not in order
    assert "clear_source_stale" in order
    assert "clear_content_caches" in order
    assert "invalidate_hierarchy_reads" in order
    assert "mark_stats_changed" in order
    # No state row → status "none" → aggregation not applicable → no trigger.
    assert "trigger" not in order


# ── C2: applicability decided before marking ────────────────────────────


def test_not_applicable_status_clears_marker_and_skips_trigger(monkeypatch):
    # A state row exists but its status makes aggregation not applicable
    # ("skipped"): the marker is NOT set, any prior marker is cleared, and
    # hierarchy + stats still converge — but no rebuild is queued. (C2)
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="skipped", fp="OLD"), current_fp="NEW",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id is None
    assert "mark_source_stale" not in order
    assert order == [
        "clear_source_stale",
        "clear_content_caches",
        "invalidate_hierarchy_reads",
        "mark_stats_changed",
    ]
    assert "trigger" not in order


# ── C1: marker WRITE → overlay READ, no mocking of the marker value ─────


def test_signal_marker_reads_back_as_source_changed_via_overlay(monkeypatch):
    """Integration seam whose absence hid C1: the marker the signal WRITES
    (real mark_source_stale) must READ back through the graph.py overlay's
    real get_source_stale_reason as the literal 'source_changed' — whatever
    the signal reason. Neither the marker value nor the read is mocked."""
    from backend.app.api.v1.endpoints import graph as graph_module

    real_cache = graph_cache_mod.GraphCache(_MemRedis())
    monkeypatch.setattr(graph_cache_mod, "get_graph_cache", lambda: real_cache)

    order = []
    svc = AggregationService(
        dispatcher=None, registry=_FakeRegistry(_FakeProvider(order)),
        session_factory=None,
    )

    async def _fake_fp(prov):
        return "NEW"

    monkeypatch.setattr(svc_mod, "compute_graph_fingerprint", _fake_fp)

    async def _noop_invalidate(ws, ds_):
        pass

    monkeypatch.setattr(graph_cache_mod, "invalidate_hierarchy_reads", _noop_invalidate)

    async def _noop_stats(ds_, ws):
        pass

    monkeypatch.setattr(enqueue_mod, "mark_stats_changed", _noop_stats)

    async def _fake_trigger(ds_id, request, trigger_source, session):
        return types.SimpleNamespace(id="agg_x")

    monkeypatch.setattr(svc, "trigger", _fake_trigger)

    session = _FakeSession(state=_state(status="ready", fp="OLD", ws="ws-1"))
    resp = _run(svc.signal_source_changed("ds-1", session, reason="drift"))
    assert resp.changed is True
    assert resp.reason == "drift"  # response reason is untouched

    # The read the overlay in graph.py performs (same function object).
    surfaced = _run(graph_module.get_source_stale_reason("ws-1", "ds-1"))
    assert surfaced == "source_changed"


# ── Scenario 6: fingerprint compute times out → treated as changed ──────


def test_fingerprint_timeout_treated_as_changed(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="ready", fp="OLD"), fp_timeout=True,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.current_fingerprint == ""
    assert order == _FULL_SEQUENCE
    # Empty fp → the idempotency key falls back to a random token.
    assert captured["request"].idempotency_key.startswith("source-changed:")
    assert captured["request"].idempotency_key != "source-changed:"


# ── Rebuild cooldown (eventual-consistency throttle, Task 3b) ────────────


def test_rebuild_within_cooldown_defers_trigger(monkeypatch):
    # Change detected, last rebuild 100s ago, cooldown 900 → invalidate but
    # defer the rebuild to the reconciler.
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD", last_aggregated_at=_secs_ago(100)),
        current_fp="NEW",
        cooldown=900,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id is None
    assert resp.deferred is True
    # Steps 4-7 ran; the trigger did not.
    assert order == [
        "mark_source_stale",
        "clear_content_caches",
        "invalidate_hierarchy_reads",
        "mark_stats_changed",
    ]
    assert "trigger" not in order


def test_force_bypasses_cooldown(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD", last_aggregated_at=_secs_ago(100)),
        current_fp="NEW",
        cooldown=900,
    )
    resp = _run(svc.signal_source_changed("ds-1", session, force=True))
    assert resp.changed is True
    assert resp.deferred is False
    assert order == _FULL_SEQUENCE


def test_rebuild_past_cooldown_triggers(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD", last_aggregated_at=_secs_ago(2000)),
        current_fp="NEW",
        cooldown=900,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.deferred is False
    assert resp.job_id == "agg_new"
    assert order == _FULL_SEQUENCE


def test_cooldown_disabled_always_triggers(monkeypatch):
    # Cooldown 0 → always trigger even with a very recent rebuild.
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD", last_aggregated_at=_secs_ago(5)),
        current_fp="NEW",
        cooldown=0,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.deferred is False
    assert order == _FULL_SEQUENCE


# ── Audit emission: exactly one refresh_events event per invocation ─────


def test_noop_emits_single_noop_event(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="ready", fp="SAME"), current_fp="SAME",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is False
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["origin"] == "api"
    assert evt["actor"] == "internal"
    assert evt["scope"] == "auto"
    assert evt["gate"] == "unchanged"
    assert evt["outcome"] == "noop"
    assert evt["actions"] == {}  # nothing ran — spec §1b
    assert evt["data_source_id"] == "ds-1"
    assert evt["workspace_id"] == "ws-1"
    assert resp.event_id == "evt_1"


def test_changed_accepted_emits_single_event_with_job_id(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        trigger_job_id="agg_123",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["gate"] == "changed"
    assert evt["outcome"] == "accepted"
    assert evt["actions"] == {
        "marker_set": True,
        "gen_bumped": True,
        "lkg_purged": 2,
        "content_cleared": True,
        "stats_nudged": True,
        "job_id": "agg_123",
        "deferred": False,
    }
    assert resp.event_id == "evt_1"


def test_deferred_emits_single_deferred_event(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD", last_aggregated_at=_secs_ago(100)),
        current_fp="NEW",
        cooldown=900,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.deferred is True
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["gate"] == "changed"
    assert evt["outcome"] == "deferred"
    # Steps 4-7 (invalidation) ran before the cooldown throttled only the
    # rebuild — marker/content/gen/stats all show True, job_id stays None.
    assert evt["actions"] == {
        "marker_set": True,
        "gen_bumped": True,
        "lkg_purged": 2,
        "content_cleared": True,
        "stats_nudged": True,
        "job_id": None,
        "deferred": True,
    }


def test_trigger_conflict_emits_conflict_event(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        trigger_exc=ConflictError("job already active"),
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.job_id is None
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["outcome"] == "conflict"
    assert evt["actions"] == {
        "marker_set": True,
        "gen_bumped": True,
        "lkg_purged": 2,
        "content_cleared": True,
        "stats_nudged": True,
        "job_id": None,
        "deferred": False,
    }
    assert evt["detail"] is None


@pytest.mark.parametrize(
    "exc",
    [
        ValueError("ontology not assigned"),
        OntologyResolutionError(types.SimpleNamespace(blocking_reasons=["no_lineage"])),
    ],
)
def test_trigger_resolution_failure_emits_error_event_with_detail(monkeypatch, exc):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        trigger_exc=exc,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.job_id is None
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["outcome"] == "error"
    assert evt["detail"] == type(exc).__name__
    assert evt["actions"]["job_id"] is None
    assert evt["actions"]["marker_set"] is True


def test_not_applicable_emits_noop_event(monkeypatch):
    # Status makes aggregation not applicable — invalidation runs but no
    # trigger is ever attempted; audit still records exactly one event.
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="skipped", fp="OLD"), current_fp="NEW",
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id is None
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["outcome"] == "noop"
    # marker_set is False (clear_source_stale ran instead of mark), but
    # the rest of the invalidation sequence still ran and is recorded.
    assert evt["actions"] == {
        "marker_set": False,
        "gen_bumped": True,
        "lkg_purged": 2,
        "content_cleared": True,
        "stats_nudged": True,
        "job_id": None,
        "deferred": False,
    }


def test_force_gate_recorded_and_flagged_in_actions(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="ready", fp="SAME"), current_fp="SAME",
    )
    resp = _run(svc.signal_source_changed("ds-1", session, force=True))
    assert resp.changed is True
    assert len(svc._events) == 1
    evt = svc._events[0]
    assert evt["gate"] == "forced"
    # force bypassed the matching gate AND the trigger succeeded — both
    # show up in actions.
    assert evt["actions"] == {
        "marker_set": True,
        "gen_bumped": True,
        "lkg_purged": 2,
        "content_cleared": True,
        "stats_nudged": True,
        "job_id": resp.job_id,
        "deferred": False,
        "force": True,
    }


def test_origin_and_actor_passed_through_to_event(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch, state=_state(status="ready", fp="OLD"), current_fp="NEW",
    )
    _run(svc.signal_source_changed(
        "ds-1", session, reason="drift", origin="drift", actor="scheduler",
    ))
    assert svc._events[0]["origin"] == "drift"
    assert svc._events[0]["actor"] == "scheduler"


def test_emit_failure_does_not_break_signal(monkeypatch):
    # emit_refresh_event is contractually never-raising, but the signal's
    # own call site must be defensive regardless — simulate a raise.
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="OLD"),
        current_fp="NEW",
        emit_raises=True,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is True
    assert resp.job_id == "agg_new"
    assert resp.event_id is None
    assert order == _FULL_SEQUENCE


def test_emit_failure_does_not_break_noop_signal(monkeypatch):
    svc, session, order, captured = _build(
        monkeypatch,
        state=_state(status="ready", fp="SAME"),
        current_fp="SAME",
        emit_raises=True,
    )
    resp = _run(svc.signal_source_changed("ds-1", session))
    assert resp.changed is False
    assert resp.event_id is None


# ── Scheduler: act on drift + reconcile stale markers (Task 4) ──────────
#
# The scheduler sweep is the backstop that calls signal_source_changed for
# external writers that never call it directly. These fakes exercise
# AggregationScheduler._tick end to end; the collaborator under real test
# is which ds_id gets signaled, with what reason, and on what session —
# signal_source_changed itself is a bare recorder here (its own gating is
# covered above).


class _SchedRegistry:
    """Registry stub for the drift sweep — compute_graph_fingerprint is
    faked below, so the provider this returns is never actually used."""

    async def get_provider_for_workspace(self, ws, session, data_source_id=None):
        return object()


class _SchedScalars:
    def __init__(self, items):
        self._items = items

    def __iter__(self):
        return iter(self._items)

    def all(self):
        return list(self._items)


class _SchedExecResult:
    def __init__(self, items):
        self._items = list(items)

    def scalars(self):
        return _SchedScalars(self._items)


class _SchedSession:
    """Fake AsyncSession context manager. ``exec_results`` feeds
    successive ``session.execute()`` calls in order; a session created
    for a signal_source_changed call needs none (signal_source_changed
    itself is faked, so it never touches this session)."""

    def __init__(self, exec_results=None, status_by_ds=None):
        self._exec_results = list(exec_results or [])
        self._status_by_ds = status_by_ds or {}

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def execute(self, stmt):
        if self._exec_results:
            return self._exec_results.pop(0)
        return _SchedExecResult([])

    async def get(self, orm, key):
        # The reconciler loads the state row (fresh session) before its
        # in-flight/cooldown pre-check. ``aggregation_status`` defaults to
        # "ready" (neither in-flight nor cooldown) so a source signals
        # unless a test marks it pending/running via ``status_by_ds``.
        return types.SimpleNamespace(
            data_source_id=key, workspace_id="ws", last_aggregated_at=None,
            aggregation_status=self._status_by_ds.get(key, "ready"),
        )


def _sched_state(ds_id="ds-1", ws="ws-1", fp="OLD"):
    return types.SimpleNamespace(
        data_source_id=ds_id, workspace_id=ws, graph_fingerprint=fp,
    )


def _sched_session_factory(states, status_by_ds=None):
    """First call returns the sweep session (drift query returns
    ``states``, the watchdog query after it returns no stale jobs);
    every later call returns a FRESH throwaway session — asserting a
    signal call's session is not the sweep's own proves the "fresh
    session per signal" rule. ``status_by_ds`` seeds the state-row
    ``aggregation_status`` the reconciler's in-flight pre-check reads."""
    created = []

    def factory():
        if not created:
            s = _SchedSession(exec_results=[
                _SchedExecResult(states), _SchedExecResult([]),
            ], status_by_ds=status_by_ds)
        else:
            s = _SchedSession(status_by_ds=status_by_ds)
        created.append(s)
        return s

    factory.created = created
    return factory


class _FakeSchedSvc:
    """Records signal_source_changed calls; ``responses`` maps ds_id to
    the response to return (default: a plain changed=True stand-in).
    ``cooldown_ds`` is the set of ds_ids the reconciler should treat as
    still within the rebuild cooldown (skip, don't signal). ``origins``
    records each call's ``origin`` kwarg in parallel to ``calls`` (kept
    separate so existing 3-tuple unpacking of ``calls`` stays untouched)."""

    def __init__(self, responses=None, cooldown_ds=None):
        self.calls = []
        self.origins = []
        self._responses = responses or {}
        self._cooldown_ds = set(cooldown_ds or [])

    def _within_rebuild_cooldown(self, state):
        return getattr(state, "data_source_id", None) in self._cooldown_ds

    async def signal_source_changed(
        self, ds_id, session, *, reason="external_load", force=False,
        origin="api", actor="internal",
    ):
        self.calls.append((ds_id, reason, session))
        self.origins.append(origin)
        return self._responses.get(ds_id, types.SimpleNamespace(changed=True))


def _no_drift(monkeypatch):
    """compute_graph_fingerprint always matches the stored "OLD" value —
    nothing drifts this tick."""
    async def _fp(provider):
        return "OLD"
    monkeypatch.setattr(fingerprint_mod, "compute_graph_fingerprint", _fp)


def _all_drift(monkeypatch, current="NEW"):
    """compute_graph_fingerprint always returns a value that mismatches
    the stored "OLD" fingerprint — every swept source drifts."""
    async def _fp(provider):
        return current
    monkeypatch.setattr(fingerprint_mod, "compute_graph_fingerprint", _fp)


def _empty_stale(monkeypatch):
    async def _list_stale():
        return []
    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)


def _no_marker(monkeypatch):
    """No source carries a stale marker — the drift path signals every
    drifted source (the marker-skip in I1 never fires)."""
    async def _reason(ws, ds):
        return None
    monkeypatch.setattr(graph_cache_mod, "get_source_stale_reason", _reason)


# ── Scenario 1: drift + default env → signal awaited (ds_id, "drift", session)


def test_scheduler_drift_signals_with_default_env(monkeypatch):
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _all_drift(monkeypatch)
    _no_marker(monkeypatch)
    _empty_stale(monkeypatch)

    fake_svc = _FakeSchedSvc()
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())

    assert len(fake_svc.calls) == 1
    ds_id, reason, session = fake_svc.calls[0]
    assert ds_id == "ds-1"
    assert reason == "drift"
    assert session is not None
    assert session is not factory.created[0]  # fresh session, not the sweep's own
    assert fake_svc.origins == ["drift"]


# ── Scenario 2: flag off → neither path signals; notify-only preserved ──


def test_scheduler_flag_off_disables_both_paths(monkeypatch):
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", False)
    _all_drift(monkeypatch)

    list_calls = []

    async def _list_stale():
        list_calls.append(True)
        return [("ws-1", "ds-9")]

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)

    fake_svc = _FakeSchedSvc()
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())  # drift is still logged (notify-only) — no signal

    assert fake_svc.calls == []
    assert list_calls == []


# ── Scenario 3: a signal failure must not abort the sweep ───────────────


def test_scheduler_signal_failure_does_not_abort_sweep(monkeypatch):
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _all_drift(monkeypatch)
    _no_marker(monkeypatch)
    _empty_stale(monkeypatch)

    class _FailingThenOkSvc:
        def __init__(self):
            self.calls = []

        async def signal_source_changed(
            self, ds_id, session, *, reason="external_load", force=False,
            origin="api", actor="internal",
        ):
            self.calls.append((ds_id, reason))
            if ds_id == "ds-1":
                raise RuntimeError("boom")
            return types.SimpleNamespace(changed=True)

    fake_svc = _FailingThenOkSvc()
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    states = [_sched_state(ds_id="ds-1"), _sched_state(ds_id="ds-2")]
    factory = _sched_session_factory(states)
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())  # must not raise despite ds-1's signal raising

    assert [c[0] for c in fake_svc.calls] == ["ds-1", "ds-2"]


# ── Scenario 4: no active service → no call, no crash ───────────────────


def test_scheduler_no_active_service_is_noop(monkeypatch):
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _all_drift(monkeypatch)
    _no_marker(monkeypatch)

    list_calls = []

    async def _list_stale():
        list_calls.append(True)
        return []

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: None)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())  # must not raise

    # svc is None ⇒ neither the drift path nor the reconciler runs.
    assert list_calls == []


# ── Scenario 5: reconciler dedupes against this tick's drift signals ────


def test_scheduler_reconciler_dedupes_against_drift_signaled(monkeypatch):
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _all_drift(monkeypatch)  # ds-1 (the only swept source) drifts
    _no_marker(monkeypatch)  # ds-1 has no marker → drift path signals it

    async def _list_stale():
        return [("ws-1", "ds-1"), ("ws-2", "ds-2")]

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)

    fake_svc = _FakeSchedSvc()
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())

    reasons_by_ds: dict[str, list[str]] = {}
    for ds_id, reason, _session in fake_svc.calls:
        reasons_by_ds.setdefault(ds_id, []).append(reason)

    # ds-1: only the drift signal fires; the reconciler skips it (already
    # handled this tick). ds-2: only the reconciler signals it.
    assert reasons_by_ds["ds-1"] == ["drift"]
    assert reasons_by_ds["ds-2"] == ["reconcile"]
    # Origins mirror reasons — drift/reconcile carry their own origin.
    assert fake_svc.origins == ["drift", "reconcile"]


# ── Scenario 6: changed=False from a reconcile call clears the marker ───


def test_scheduler_reconciler_clears_marker_when_unchanged(monkeypatch):
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _no_drift(monkeypatch)  # nothing drifts in the sweep itself

    async def _list_stale():
        return [("ws-2", "ds-2")]

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)

    clear_calls = []

    async def _clear(ws, ds):
        clear_calls.append((ws, ds))

    monkeypatch.setattr(graph_cache_mod, "clear_source_stale", _clear)

    fake_svc = _FakeSchedSvc(
        responses={"ds-2": types.SimpleNamespace(changed=False)},
    )
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())

    assert [c[0] for c in fake_svc.calls] == ["ds-2"]
    assert clear_calls == [("ws-2", "ds-2")]


# ── I1: drift path skips already-marked sources; reconciler skips cooldown


def test_scheduler_drift_skips_already_marked_source(monkeypatch):
    # ds-1 drifts AND already carries a stale marker: the drift path must
    # NOT re-signal it (its invalidation happened at first signal); the
    # reconciler owns it from here and signals it with reason="reconcile".
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _all_drift(monkeypatch)

    async def _reason(ws, ds):
        return "source_changed" if ds == "ds-1" else None

    monkeypatch.setattr(graph_cache_mod, "get_source_stale_reason", _reason)

    async def _list_stale():
        return [("ws-1", "ds-1")]

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)

    fake_svc = _FakeSchedSvc()  # ds-1 not in cooldown → reconciler signals it
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())

    reasons_by_ds: dict[str, list[str]] = {}
    for ds_id, reason, _session in fake_svc.calls:
        reasons_by_ds.setdefault(ds_id, []).append(reason)

    # Only the reconciler signaled ds-1 — the drift path skipped it.
    assert reasons_by_ds == {"ds-1": ["reconcile"]}


def test_scheduler_reconciler_skips_in_cooldown_marked_source(monkeypatch):
    # ds-2 (in cooldown) and ds-3 (past cooldown) are both marked stale and
    # neither drifts this tick. The reconciler must skip ds-2 (its
    # invalidation already happened; re-signaling would churn every tick)
    # and signal only ds-3.
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _no_drift(monkeypatch)
    _no_marker(monkeypatch)  # drift path unused (nothing drifts)

    async def _list_stale():
        return [("ws-2", "ds-2"), ("ws-3", "ds-3")]

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)

    fake_svc = _FakeSchedSvc(cooldown_ds={"ds-2"})
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory([_sched_state(ds_id="ds-1")])
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())

    assert [c[0] for c in fake_svc.calls] == ["ds-3"]


def test_scheduler_reconciler_skips_in_flight_rebuild(monkeypatch):
    # Marked sources whose rebuild is already IN FLIGHT — queued ("pending")
    # or actively "running" — must NOT be re-signaled every tick even once
    # the cooldown has elapsed: the running job's job.completed clears the
    # marker and writes the fresh fingerprint. Only a marked source with no
    # in-flight rebuild ("ready") is reconciled.
    monkeypatch.setattr(scheduler_mod, "_DRIFT_AUTO_REBUILD", True)
    _no_drift(monkeypatch)
    _no_marker(monkeypatch)

    async def _list_stale():
        return [("ws-2", "ds-2"), ("ws-3", "ds-3"), ("ws-4", "ds-4")]

    monkeypatch.setattr(graph_cache_mod, "list_stale_sources", _list_stale)

    fake_svc = _FakeSchedSvc()  # nothing in cooldown
    monkeypatch.setattr(svc_mod, "get_active_service", lambda: fake_svc)

    factory = _sched_session_factory(
        [_sched_state(ds_id="ds-1")],
        status_by_ds={"ds-2": "pending", "ds-3": "running"},  # ds-4 → "ready"
    )
    sched = scheduler_mod.AggregationScheduler(factory, _SchedRegistry())

    _run(sched._tick())

    # ds-2 (pending) and ds-3 (running) deferred; only ds-4 (ready) signaled.
    assert [c[0] for c in fake_svc.calls] == ["ds-4"]


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
