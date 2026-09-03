"""Operator holds on automatic rebuilds — the resolver and the trigger gate.

The bug these lock down: ``paused_until`` was read in exactly ONE behavioural
place (the reconcile sweeper's act decision) while seven other paths could
queue a job, and ``reconcile_enabled`` ("Automation off") had the identical
single read. A source paused while a Redis stale marker was set was rebuilt
within a minute, every minute, by the stale-marker reconciler — which is gated
by no automation switch at all. The scheduler- and signal-level cases live in
``test_source_changed_signal.py``; the sweeper case in
``test_reconcile_sweeper.py``; the batch case in
``test_provider_refresh_batch.py``. This file pins the pieces they share.
"""
import asyncio
import inspect
import types
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.services.aggregation import holds
from backend.app.services.aggregation.holds import (
    AUTOMATION_ORIGINS,
    HELD_TRIGGER_SOURCES,
    HeldError,
    Hold,
    resolve_hold,
    skip_for,
)
from backend.app.services.aggregation.models import API_TRIGGER_SOURCES
from backend.app.services.aggregation.schemas import AggregationTriggerRequest
from backend.app.services.aggregation.service import (
    AggregationService,
    hold_for_state,
)
from backend.app.services.aggregation.worker import AggregationWorker


def _run(coro):
    return asyncio.run(coro)


def _iso(hours: float) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _row(**over):
    return types.SimpleNamespace(**{"paused_until": None, "stopped_at": None, **over})


# ── the resolver: most restrictive wins, widest scope reported ───────


@pytest.mark.parametrize(
    "label, scope_holds, provider_id, src_paused, src_enabled, expect",
    [
        ("nothing held", {}, "p1", None, True, None),
        ("source paused", {}, "p1", _iso(3), True, ("source", "paused")),
        ("source stopped (automation off)", {}, "p1", None, False, ("source", "stopped")),
        ("source pause lapsed", {}, "p1", _iso(-3), True, None),
        ("source pause corrupt reads as lapsed", {}, "p1", "not-a-date", True, None),
        ("provider paused", {("provider", "p1"): _row(paused_until=_iso(3))}, "p1", None, True,
         ("provider", "paused")),
        ("provider stopped", {("provider", "p1"): _row(stopped_at="2026-09-01T00:00:00+00:00")},
         "p1", None, True, ("provider", "stopped")),
        ("a different provider's hold does not apply",
         {("provider", "p2"): _row(stopped_at="x")}, "p1", None, True, None),
        ("fleet paused", {("fleet", ""): _row(paused_until=_iso(3))}, "p1", None, True,
         ("fleet", "paused")),
        # Decision 2: no per-source escape from a wider hold. The source is
        # explicitly enabled and un-paused; the provider stop still holds it.
        ("provider stop holds an explicitly resumed source",
         {("provider", "p1"): _row(stopped_at="x")}, "p1", None, True, ("provider", "stopped")),
        # Reporting order: the WIDEST scope in force, so the operator is sent
        # to the control that will actually release the source.
        ("fleet stop reported over provider pause over source stop",
         {("fleet", ""): _row(stopped_at="x"), ("provider", "p1"): _row(paused_until=_iso(3))},
         "p1", None, False, ("fleet", "stopped")),
        ("stopped outranks paused within one scope",
         {("provider", "p1"): _row(stopped_at="x", paused_until=_iso(3))}, "p1", None, True,
         ("provider", "stopped")),
        ("no provider id: provider holds cannot apply",
         {("provider", "p1"): _row(stopped_at="x")}, None, None, True, None),
        ("no scope map at all is 'no scope hold'", None, "p1", None, True, None),
    ],
)
def test_resolve_hold_precedence(label, scope_holds, provider_id, src_paused, src_enabled, expect):
    got = resolve_hold(
        scope_holds=scope_holds, provider_id=provider_id,
        source_paused_until=src_paused, source_reconcile_enabled=src_enabled,
    )
    assert ((got.scope, got.kind) if got else None) == expect, label


def test_a_paused_hold_carries_its_expiry_and_a_provider_hold_its_id():
    until = _iso(2)
    h = resolve_hold(scope_holds={}, provider_id=None, source_paused_until=until)
    assert h == Hold(scope="source", kind="paused", until=until)
    h = resolve_hold(scope_holds={("provider", "p9"): _row(stopped_at="x")}, provider_id="p9")
    assert h.scope_id == "p9" and h.until is None


def test_skip_vocabulary_keeps_source_names_and_adds_wider_scopes():
    """Source-scope holds keep ``disabled`` / ``paused`` so the sweep tallies,
    the docs and the existing tests read as before; only the two wider scopes
    are new words."""
    from backend.app.services.aggregation.reconcile import SKIP_REASONS, _HOLD_SKIPS

    assert skip_for(Hold("source", "stopped")) == "disabled"
    assert skip_for(Hold("source", "paused")) == "paused"
    assert skip_for(Hold("provider", "stopped")) == "provider_held"
    assert skip_for(Hold("provider", "paused")) == "provider_held"
    assert skip_for(Hold("fleet", "paused")) == "fleet_held"
    for word in ("provider_held", "fleet_held"):
        assert word in SKIP_REASONS and word in _HOLD_SKIPS


def test_hold_for_state_resolves_reconcile_enabled_the_way_the_sweeper_does():
    """Per-source override → global → env. An UNSET per-source value inherits
    the fleet's ② Check switch — so turning that off holds every source that
    has not explicitly opted back in, and a source with no state row at all."""
    st = types.SimpleNamespace(paused_until=None, reconcile_enabled=None)
    assert hold_for_state(st, types.SimpleNamespace(reconcile_enabled=False)).kind == "stopped"
    assert hold_for_state(st, types.SimpleNamespace(reconcile_enabled=True)) is None
    assert hold_for_state(None, types.SimpleNamespace(reconcile_enabled=False)) is not None
    assert hold_for_state(None, types.SimpleNamespace(reconcile_enabled=True)) is None
    # An explicit per-source True is honoured over a global False — the
    # pre-existing resolver contract, unchanged.
    on = types.SimpleNamespace(paused_until=None, reconcile_enabled=True)
    assert hold_for_state(on, types.SimpleNamespace(reconcile_enabled=False)) is None


def test_the_discriminators_are_origin_and_trigger_source_and_api_is_in_neither():
    """``trigger_source`` cannot tell automation from a person: every
    scheduler caller of signal_source_changed leaves it at its "api" default,
    which is also what a person's Rebuild and the versioning projector send.
    ``origin`` can, because the HTTP request models restrict it to
    script|connector|api and only internal automation mints the rest."""
    assert "api" not in AUTOMATION_ORIGINS
    assert "api" not in HELD_TRIGGER_SOURCES
    assert {"drift", "reconcile", "reconcile-sweep"} == set(AUTOMATION_ORIGINS)
    assert "manual" not in HELD_TRIGGER_SOURCES
    assert "onboarding" not in HELD_TRIGGER_SOURCES
    assert "post_purge" not in HELD_TRIGGER_SOURCES
    assert HELD_TRIGGER_SOURCES <= set(API_TRIGGER_SOURCES)


# ── trigger(): gate B ────────────────────────────────────────────────


_PAST_THE_GATE = "past the hold gate"


class _HoldSession:
    """A session for one source whose state row says ``reconcile_enabled``
    is False. Any access beyond the two ``get``s the hold needs proves the
    request got PAST the gate — the same exploding-session technique
    ``test_aggregation_trigger_sources`` uses for validation."""

    def __init__(self, *, reconcile_enabled=False, paused_until=None):
        self._state = types.SimpleNamespace(
            data_source_id="ds-1", reconcile_enabled=reconcile_enabled,
            paused_until=paused_until,
        )

    async def get(self, orm, key):
        if orm.__name__ == "AggregationDataSourceStateORM":
            return self._state
        return None  # no persisted global cadence → env defaults

    def __getattr__(self, name):  # pragma: no cover - failure path only
        raise AssertionError(_PAST_THE_GATE)


def _make_service():
    return AggregationService(dispatcher=None, registry=None, session_factory=None)


@pytest.mark.parametrize("source", sorted(HELD_TRIGGER_SOURCES))
def test_trigger_refuses_automation_sources_under_a_hold(source):
    svc = _make_service()
    with pytest.raises(HeldError) as exc:
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(), source,
            _HoldSession(reconcile_enabled=False),
        ))
    assert exc.value.hold == Hold("source", "stopped")
    assert isinstance(exc.value, Exception) and not isinstance(exc.value, ValueError)


def test_trigger_refuses_an_automation_source_that_is_paused():
    svc = _make_service()
    with pytest.raises(HeldError) as exc:
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(), "reconcile",
            _HoldSession(reconcile_enabled=True, paused_until=_iso(1)),
        ))
    assert exc.value.hold.kind == "paused"


@pytest.mark.parametrize("source", ["manual", "onboarding", "post_purge", "api"])
def test_trigger_lets_a_person_and_the_lifecycle_paths_past_a_hold(source):
    """Decision 3: a hold stops automation, not a person. ``onboarding`` is
    provisioning; ``post_purge`` is the purge's own re-aggregate (holding it
    strands the source with no rollups and no automation to heal it); ``api``
    is exempt HERE because its automation subset is caught upstream by the
    origin check in signal_source_changed."""
    svc = _make_service()
    with pytest.raises(AssertionError, match=_PAST_THE_GATE):
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(), source,
            _HoldSession(reconcile_enabled=False),
        ))


def test_trigger_still_validates_the_source_before_consulting_the_hold():
    svc = _make_service()
    with pytest.raises(ValueError, match="invalid trigger_source"):
        _run(svc.trigger(
            "ds-1", AggregationTriggerRequest(), "bogus",
            _HoldSession(reconcile_enabled=False),
        ))


# ── decision 4: nothing in-flight is touched ─────────────────────────


def test_re_dispatch_of_existing_jobs_never_consults_the_hold():
    """Crash recovery and stuck-job re-dispatch resume EXISTING job rows
    straight onto the dispatcher, never through ``trigger()``. A job resuming
    from its cursor is an in-flight job, and a hold blocks the NEXT job
    only. Pin that structurally: every method that re-dispatches by job id
    neither triggers nor resolves a hold."""
    re_dispatchers = [
        name for name, fn in inspect.getmembers(AggregationService, inspect.isfunction)
        if "self._dispatcher.dispatch(job.id)" in inspect.getsource(fn)
        and name != "trigger"
    ]
    assert re_dispatchers, "expected at least one re-dispatch path"
    for name in re_dispatchers:
        src = inspect.getsource(getattr(AggregationService, name))
        assert "self.trigger(" not in src, name
        assert "hold_for_" not in src and "resolve_hold" not in src, name


# ── the cancel poller ────────────────────────────────────────────────


class _FlagRedis:
    def __init__(self, value=None, raise_=False):
        self._value, self._raise = value, raise_
        self.keys = []

    async def get(self, key):
        self.keys.append(key)
        if self._raise:
            raise RuntimeError("redis flap")
        return self._value


def test_durable_cancel_poll_reads_the_pickup_flag(monkeypatch):
    """Same key the worker's pre-run guard reads; a lost pub/sub delivery is
    now caught on the existing 10s watchdog tick instead of never."""
    from backend.app.services.aggregation import redis_client

    r = _FlagRedis(value=b"1")
    monkeypatch.setattr(redis_client, "get_redis", lambda: r)
    assert _run(AggregationWorker._durable_cancel_set("agg_1")) is True
    assert r.keys == [redis_client.cancel_flag_key("agg_1")]


def test_durable_cancel_poll_is_false_when_unset(monkeypatch):
    from backend.app.services.aggregation import redis_client

    monkeypatch.setattr(redis_client, "get_redis", lambda: _FlagRedis(value=None))
    assert _run(AggregationWorker._durable_cancel_set("agg_1")) is False


def test_durable_cancel_poll_never_kills_a_healthy_job_on_a_redis_error(monkeypatch):
    from backend.app.services.aggregation import redis_client

    monkeypatch.setattr(redis_client, "get_redis", lambda: _FlagRedis(raise_=True))
    assert _run(AggregationWorker._durable_cancel_set("agg_1")) is False


def test_the_watchdog_tick_sets_the_event_from_the_durable_flag():
    """The loop body: an unset event plus a set flag → the event is set, so
    both existing cooperative checkpoints exit at their next boundary."""
    src = inspect.getsource(AggregationWorker.run)
    assert "_durable_cancel_set(job.id)" in src
    assert "cancel_event.set()" in src
