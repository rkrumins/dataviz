"""Provider- and fleet-scope holds: storage, resolution at every gate, and
what the read path reports.

Companion to ``test_automation_holds.py`` (which pins the resolver and the
per-source gates). Everything here is about the two WIDER scopes:

* ``automation_holds`` rows are read by primary key, never cached — a
  "Pause provider" on the web tier is honoured by the very next decision on
  the Control Plane, with no 30s window in which a fleet refresh rebuilds
  what the operator just paused.
* Most restrictive wins across fleet → provider → source, and the widest
  scope is what gets REPORTED, so the operator is pointed at the control
  that will actually release the source.
* A held source is its own bucket in the summaries, never folded into
  ``needsAttention`` — the pause exists to quiet that count, not inflate it.
* ``resetBreaker`` is the manual resume from the circuit breaker that did
  not exist before.
"""
from __future__ import annotations

import asyncio
import inspect
import json
import types
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.aggregation import holds as holds_mod
from backend.app.services.aggregation import service as svc_mod
from backend.app.services.aggregation.holds import (
    FLEET_KEY, Hold, read_scope_holds, resolve_scope_hold, set_scope_hold,
)
from backend.app.services.aggregation.models import AutomationHoldORM
from backend.app.services.aggregation.schemas import (
    AggregationCadence, FreshnessSettingsRequest, ReconcilePolicyRequest,
    ScopeHoldRequest,
)
from backend.app.services.aggregation.service import (
    AggregationService, NotFoundError, hold_for_source_row,
    _summarize_freshness, _summarize_by_provider,
)


def _run(coro):
    return asyncio.run(coro)


def _future(hours=3) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _row(**kw):
    """A stand-in for an ``AutomationHoldORM`` row."""
    base = dict(paused_until=None, stopped_at=None, updated_at=None, updated_by=None)
    base.update(kw)
    return types.SimpleNamespace(**base)


# ── Storage: read by key, write partially, delete when empty ─────────────


class _KeyedSession:
    """``session.get`` by ``(ORM, key)``; records adds/deletes. The shape
    every fake in this suite needs — a hold is a primary-key lookup."""

    def __init__(self, rows=None):
        self.rows = dict(rows or {})
        self.added, self.deleted, self.committed = [], [], False

    async def get(self, orm, key):
        return self.rows.get((orm.__name__, key))

    def add(self, obj):
        self.added.append(obj)

    async def delete(self, obj):
        self.deleted.append(obj)

    async def commit(self):
        self.committed = True


def test_read_scope_holds_reads_the_fleet_row_and_only_the_providers_asked_for():
    fleet = _row(stopped_at="2026-09-01T00:00:00+00:00")
    p1 = _row(paused_until=_future())
    session = _KeyedSession({
        ("AutomationHoldORM", ("fleet", "")): fleet,
        ("AutomationHoldORM", ("provider", "p1")): p1,
        ("AutomationHoldORM", ("provider", "p2")): _row(stopped_at="x"),
    })
    got = _run(read_scope_holds(session, ["p1", None, ""]))
    assert got == {FLEET_KEY: fleet, ("provider", "p1"): p1}


def test_read_scope_holds_never_raises():
    class _Broken:
        async def get(self, *_a):
            raise RuntimeError("relation does not exist")

    assert _run(read_scope_holds(_Broken(), ["p1"])) == {}
    # A session with no ``get`` at all (a scripted execute-only fake) is the
    # same answer: no scope hold, never an error.
    assert _run(read_scope_holds(object(), ["p1"])) == {}


def test_set_scope_hold_upserts_partially_and_stamps_the_stop_once():
    session = _KeyedSession()
    row = _run(set_scope_hold(
        session, scope="provider", scope_id="p1", stopped=True, actor="alice",
    ))
    assert isinstance(row, AutomationHoldORM)
    assert (row.scope, row.scope_id) == ("provider", "p1")
    assert row.stopped_at and row.paused_until is None
    assert row.updated_by == "alice"
    assert session.added == [row]
    first_stop = row.stopped_at

    # Now the row exists; a later pause must not touch the stop stamp — the
    # ORIGINAL stop time is the one worth showing ("stopped 3 days ago").
    session.rows[("AutomationHoldORM", ("provider", "p1"))] = row
    until = _future()
    again = _run(set_scope_hold(
        session, scope="provider", scope_id="p1", paused_until=until,
        stopped=True, actor="bob",
    ))
    assert again is row
    assert row.stopped_at == first_stop
    assert row.paused_until == until
    assert row.updated_by == "bob"
    assert session.deleted == []


def test_set_scope_hold_deletes_a_row_that_holds_nothing():
    row = AutomationHoldORM(scope="fleet", scope_id="", stopped_at="x")
    session = _KeyedSession({("AutomationHoldORM", ("fleet", "")): row})
    out = _run(set_scope_hold(session, scope="fleet", stopped=False))
    assert out is None
    assert session.deleted == [row]


def test_set_scope_hold_does_not_persist_a_fresh_row_that_holds_nothing():
    """Resuming a provider that was never held must not leave an empty row
    (and must not try to delete an object that was never flushed)."""
    session = _KeyedSession()
    out = _run(set_scope_hold(
        session, scope="provider", scope_id="p9", paused_until=None, stopped=False,
    ))
    assert out is None
    assert session.added == [] and session.deleted == []


def test_set_scope_hold_refuses_an_unknown_scope():
    with pytest.raises(ValueError):
        _run(set_scope_hold(_KeyedSession(), scope="source", scope_id="ds"))


# ── Resolution: the widest hold is reported; the provider is looked up ────


class _SourceSession(_KeyedSession):
    """Adds the data-source row a provider lookup needs."""

    def __init__(self, rows=None, *, provider_id="p1", state=None):
        super().__init__(rows)
        self.rows[("WorkspaceDataSourceORM", "ds-1")] = types.SimpleNamespace(
            id="ds-1", provider_id=provider_id, deleted_at=None,
        )
        if state is not None:
            self.rows[("AggregationDataSourceStateORM", "ds-1")] = state


def test_hold_for_source_row_reports_the_provider_hold_over_a_source_pause():
    session = _SourceSession({
        ("AutomationHoldORM", ("provider", "p1")): _row(stopped_at="2026-09-01T00:00:00+00:00"),
    })
    state = types.SimpleNamespace(paused_until=_future(), reconcile_enabled=None)
    hold = _run(hold_for_source_row(session, "ds-1", state, AggregationCadence()))
    assert hold == Hold(scope="provider", kind="stopped", scope_id="p1")


def test_hold_for_source_row_reports_the_fleet_hold_over_everything():
    until = _future()
    session = _SourceSession({
        ("AutomationHoldORM", ("fleet", "")): _row(paused_until=until),
        ("AutomationHoldORM", ("provider", "p1")): _row(stopped_at="x"),
    })
    state = types.SimpleNamespace(paused_until=None, reconcile_enabled=False)
    hold = _run(hold_for_source_row(session, "ds-1", state, AggregationCadence()))
    assert hold == Hold(scope="fleet", kind="paused", until=until)


def test_hold_for_source_row_ignores_another_providers_hold():
    session = _SourceSession({
        ("AutomationHoldORM", ("provider", "p2")): _row(stopped_at="x"),
    }, provider_id="p1")
    state = types.SimpleNamespace(paused_until=None, reconcile_enabled=None)
    assert _run(hold_for_source_row(session, "ds-1", state, AggregationCadence())) is None


def test_hold_for_source_row_survives_a_missing_data_source_row():
    """No provider → no provider hold; the fleet row still applies."""
    session = _KeyedSession({("AutomationHoldORM", ("fleet", "")): _row(stopped_at="x")})
    state = types.SimpleNamespace(paused_until=None, reconcile_enabled=None)
    hold = _run(hold_for_source_row(session, "ds-1", state, AggregationCadence()))
    assert hold is not None and hold.scope == "fleet"


def test_the_service_consults_the_provider_row_for_an_automation_trigger():
    """``trigger()``'s gate goes through ``hold_for_source`` — which now
    reads the wider scopes. Exploding on anything past the gate proves the
    refusal happened before any real work."""
    from backend.app.services.aggregation.holds import HeldError
    from backend.app.services.aggregation.schemas import AggregationTriggerRequest

    class _Session(_SourceSession):
        def __getattr__(self, name):  # pragma: no cover - failure path only
            raise AssertionError(f"request got past the hold gate: {name}")

    session = _Session({
        ("AutomationHoldORM", ("provider", "p1")): _row(stopped_at="x"),
    }, state=types.SimpleNamespace(
        data_source_id="ds-1", paused_until=None, reconcile_enabled=None,
    ))
    svc = AggregationService(dispatcher=None, registry=None, session_factory=None)
    with pytest.raises(HeldError) as exc:
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(idempotency_key="k"), "reconcile", session,
        ))
    assert exc.value.hold.scope == "provider"


# ── Resume from the breaker ──────────────────────────────────────────────


def test_reset_breaker_zeroes_the_count_and_lifts_the_suspension_only():
    state = types.SimpleNamespace(
        reconcile_consecutive_actions=3, drift_state="suspended",
        paused_until="keep", reconcile_enabled=False,
    )
    session = _KeyedSession({("AggregationDataSourceStateORM", "ds-1"): state})
    svc = AggregationService(dispatcher=None, registry=None, session_factory=None)
    out = _run(svc.reset_source_breaker("ds-1", session))
    assert out == {"reset_breaker": True}
    assert state.reconcile_consecutive_actions == 0
    assert state.drift_state is None
    # Nothing else is touched — a resume is not a "turn everything on".
    assert state.paused_until == "keep" and state.reconcile_enabled is False
    assert session.committed


def test_reset_breaker_leaves_a_non_suspended_verdict_alone():
    state = types.SimpleNamespace(reconcile_consecutive_actions=2, drift_state="drifting")
    session = _KeyedSession({("AggregationDataSourceStateORM", "ds-1"): state})
    svc = AggregationService(dispatcher=None, registry=None, session_factory=None)
    _run(svc.reset_source_breaker("ds-1", session))
    assert state.reconcile_consecutive_actions == 0
    assert state.drift_state == "drifting"


def test_reset_breaker_on_an_unknown_source_is_not_found():
    svc = AggregationService(dispatcher=None, registry=None, session_factory=None)
    with pytest.raises(NotFoundError):
        _run(svc.reset_source_breaker("nope", _KeyedSession()))


def test_reset_breaker_is_an_action_on_the_settings_patch_not_a_setting():
    body = FreshnessSettingsRequest.model_validate({"resetBreaker": True})
    assert body.reset_breaker is True
    assert body.model_fields_set == {"reset_breaker"}


# ── The fleet hold rides the policy PUT ──────────────────────────────────


class _SettingsRow:
    def __init__(self, cadence_json=None):
        self.id = "global"
        self.cadence_json = cadence_json
        self.tuning_json = None
        self.updated_at = None
        self.updated_by = None


class _PolicySession(_KeyedSession):
    def __init__(self, settings_row, rows=None):
        super().__init__(rows)
        self.rows[("AggregationSettingsORM", "global")] = settings_row

    async def get(self, orm, key, **_kw):  # with_for_update on Postgres
        return await super().get(orm, key)


def test_saving_the_policy_with_a_fleet_pause_writes_the_hold_row_not_the_cadence():
    row = _SettingsRow(json.dumps({"reconcileEnabled": True}))
    session = _PolicySession(row)
    until = _future()
    body = ReconcilePolicyRequest.model_validate({"pausedUntil": until})
    resp = _run(svc_mod.save_reconcile_policy(
        session, body, sent=body.model_fields_set, actor="alice",
    ))
    assert resp.paused_until == until and resp.stopped_at is None
    # The policy itself is untouched by a hold, and the hold never lands in
    # cadence_json — it is a row of its own.
    assert json.loads(row.cadence_json) == {"reconcileEnabled": True}
    (hold,) = session.added
    assert isinstance(hold, AutomationHoldORM)
    assert (hold.scope, hold.scope_id, hold.paused_until) == ("fleet", "", until)
    assert hold.updated_by == "alice"
    assert session.committed


def test_saving_the_policy_with_stopped_stamps_the_fleet_stop():
    session = _PolicySession(_SettingsRow())
    body = ReconcilePolicyRequest.model_validate({"stopped": True})
    resp = _run(svc_mod.save_reconcile_policy(session, body, sent=body.model_fields_set))
    assert resp.stopped_at is not None
    assert resp.enabled is None  # a hold is not "Check off"


def test_a_plain_policy_save_reports_the_existing_fleet_hold_without_touching_it():
    fleet = AutomationHoldORM(scope="fleet", scope_id="", stopped_at="2026-09-01T00:00:00+00:00")
    session = _PolicySession(_SettingsRow(), {("AutomationHoldORM", ("fleet", "")): fleet})
    body = ReconcilePolicyRequest.model_validate({"enabled": False})
    resp = _run(svc_mod.save_reconcile_policy(session, body, sent=body.model_fields_set))
    assert resp.enabled is False
    assert resp.stopped_at == "2026-09-01T00:00:00+00:00"
    assert session.added == [] and session.deleted == []


def test_resuming_the_fleet_deletes_its_row():
    fleet = AutomationHoldORM(scope="fleet", scope_id="", stopped_at="x", paused_until=None)
    session = _PolicySession(_SettingsRow(), {("AutomationHoldORM", ("fleet", "")): fleet})
    body = ReconcilePolicyRequest.model_validate({"stopped": False, "pausedUntil": None})
    resp = _run(svc_mod.save_reconcile_policy(session, body, sent=body.model_fields_set))
    assert resp.stopped_at is None and resp.paused_until is None
    assert session.deleted == [fleet]


def test_the_fleet_pause_gets_the_same_validation_as_the_source_snooze():
    with pytest.raises(ValueError):
        ReconcilePolicyRequest.model_validate({"pausedUntil": "2001-01-01T00:00:00+00:00"})
    with pytest.raises(ValueError):
        ScopeHoldRequest.model_validate({"pausedUntil": "not a date"})


# ── The provider hold route ──────────────────────────────────────────────


def test_provider_hold_route_upserts_by_provider_and_records_the_actor():
    from backend.app.api.v1.endpoints import freshness as fresh_mod

    session = _KeyedSession()
    body = ScopeHoldRequest.model_validate({"stopped": True})
    user = types.SimpleNamespace(id="usr_admin")
    resp = _run(fresh_mod.put_provider_hold("p1", body, user=user, session=session))
    assert (resp.scope, resp.scope_id) == ("provider", "p1")
    assert resp.stopped_at and resp.paused_until is None
    assert resp.updated_by == "usr_admin"
    assert session.committed
    (row,) = session.added
    assert (row.scope, row.scope_id) == ("provider", "p1")


def test_provider_hold_route_resume_reports_nothing_held():
    from backend.app.api.v1.endpoints import freshness as fresh_mod

    existing = AutomationHoldORM(scope="provider", scope_id="p1", stopped_at="x")
    session = _KeyedSession({("AutomationHoldORM", ("provider", "p1")): existing})
    body = ScopeHoldRequest.model_validate({"stopped": False})
    resp = _run(fresh_mod.put_provider_hold(
        "p1", body, user=types.SimpleNamespace(id="u"), session=session,
    ))
    assert resp.stopped_at is None and resp.paused_until is None
    assert session.deleted == [existing]


def test_provider_hold_and_policy_put_are_platform_admin_only():
    """A provider spans workspaces, so both stay ``system:admin`` — the same
    argument the batch-refresh routes make. Asserted on the live route
    objects, like ``test_freshness_endpoints`` does."""
    from backend.app.api.v1.endpoints import freshness as fresh_mod

    def _route(path, method):
        for r in fresh_mod.router.routes:
            if getattr(r, "path", None) == path and method in getattr(r, "methods", ()):
                return r
        raise AssertionError(f"no route {method} {path}")

    def _dep_names(route):
        return {
            getattr(d.call, "__name__", repr(d.call))
            for d in route.dependant.dependencies
        }

    admin_dep = getattr(fresh_mod._REQUIRE_PROVIDER_MANAGE, "__name__", None)
    for path in ("/freshness/holds/provider/{provider_id}", "/freshness/reconciliation"):
        names = _dep_names(_route(path, "PUT"))
        assert admin_dep in names, (path, names)


# ── What the read path reports ───────────────────────────────────────────


def _full_rows():
    # (ds_id, workspace_id, aggregation_status, provider_id, provider_name)
    return [
        ("ds-a", "ws", "ready", "p1", "Alpha"),
        ("ds-b", "ws", "ready", "p1", "Alpha"),
        ("ds-c", "ws", "failed", "p2", "Beta"),
    ]


def test_held_is_its_own_bucket_and_never_needs_attention():
    rows = _full_rows()
    summary = _summarize_freshness(
        rows, signals={}, running={}, held_ids={"ds-a", "ds-b"},
    )
    assert summary.held == 2
    # ds-c is the only failed row; the two held ones are NOT counted here.
    assert summary.needs_attention == 1


def test_provider_summary_carries_the_providers_own_hold_but_not_a_sources():
    rows = _full_rows()
    until = _future()
    scope_holds = {("provider", "p1"): _row(paused_until=until)}
    out = _summarize_by_provider(
        rows, signals={}, running={}, held_ids={"ds-a", "ds-b", "ds-c"},
        scope_holds=scope_holds,
    )
    by_id = {p.provider_id: p for p in out}
    assert by_id["p1"].held == 2
    assert (by_id["p1"].held_by, by_id["p1"].held_kind, by_id["p1"].held_until) == (
        "provider", "paused", until,
    )
    # p2's source is held at SOURCE scope only — the group header must not
    # claim the provider itself is held.
    assert by_id["p2"].held == 1
    assert by_id["p2"].held_by is None


def test_provider_summary_reports_the_fleet_hold_on_every_provider():
    out = _summarize_by_provider(
        _full_rows(), signals={}, running={},
        scope_holds={FLEET_KEY: _row(stopped_at="x")},
    )
    assert {p.held_by for p in out} == {"fleet"}
    assert {p.held_kind for p in out} == {"stopped"}


def test_row_kwargs_report_the_resolved_hold_and_its_widest_scope():
    ds = types.SimpleNamespace(
        id="ds-a", workspace_id="ws", provider_id="p1", label="A",
        aggregation_status="ready", last_aggregated_at=None, graph_fingerprint=None,
    )
    until = _future()
    kw = svc_mod._freshness_row_kwargs(
        ds, provider_name="Alpha", signals=(None, None, None),
        running_job_id=None, last_event=None,
        state_row={"paused_until": until, "reconcile_enabled": None},
        scope_holds={("provider", "p1"): _row(stopped_at="2026-09-01T00:00:00+00:00")},
    )
    # The source is paused AND its provider is stopped: the provider is
    # what holds it, so that is what the row says.
    assert (kw["held_by"], kw["held_kind"], kw["held_until"]) == ("provider", "stopped", None)
    # The raw source value the drawer edits is still there, untouched.
    assert kw["paused_until"] == until

    kw = svc_mod._freshness_row_kwargs(
        ds, provider_name="Alpha", signals=(None, None, None),
        running_job_id=None, last_event=None,
        state_row={"paused_until": until, "reconcile_enabled": None},
        scope_holds={},
    )
    assert (kw["held_by"], kw["held_kind"], kw["held_until"]) == ("source", "paused", until)

    kw = svc_mod._freshness_row_kwargs(
        ds, provider_name="Alpha", signals=(None, None, None),
        running_job_id=None, last_event=None, state_row=None,
    )
    assert kw["held_by"] is None and kw["held_kind"] is None


def test_the_readers_share_one_key_shape():
    """``resolve_scope_hold`` and ``read_scope_holds`` agree on the map's
    keys — a drift here is a hold that is stored but never seen."""
    fleet = _row(stopped_at="x")
    session = _KeyedSession({("AutomationHoldORM", FLEET_KEY): fleet})
    holds = _run(read_scope_holds(session))
    assert resolve_scope_hold(holds, "any").scope == "fleet"


def test_the_sweeper_and_the_scheduler_read_the_wider_scopes():
    """Structural: both automation loops go through the scope-aware reads,
    so a provider hold cannot be honoured by one and missed by the other."""
    from backend.app.services.aggregation import reconcile_sweeper, scheduler

    sweeper_src = inspect.getsource(reconcile_sweeper.ReconciliationSweeper)
    assert "read_scope_holds(" in sweeper_src
    assert "resolve_scope_hold(scope_holds" in sweeper_src
    sched_src = inspect.getsource(scheduler.AggregationScheduler._reconcile_stale_markers)
    assert "hold_for_source_row(" in sched_src
