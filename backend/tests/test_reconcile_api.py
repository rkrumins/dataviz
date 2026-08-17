"""Unit tests for the reconciliation API surface.

Same direct-handler-call style as ``test_freshness_endpoints.py``: handlers
are exercised with fakes, and RBAC is asserted by inspecting the live route
objects.

The two behaviours worth guarding hardest:

  * the per-source PATCH must apply ONLY the fields the caller sent — every
    field treats explicit null as "clear", so applying absent ones would make
    a partial update silently destructive,
  * saving the reconciliation policy must not clobber the rebuild cadence,
    which shares the same ``cadence_json`` column.
"""
from __future__ import annotations

import asyncio
import inspect
import json
from datetime import datetime, timezone

import pytest

from backend.app.api.v1.endpoints import freshness as fresh_mod
from backend.app.api.v1.endpoints.aggregation import _REQUIRE_DS_MANAGE
from backend.app.services.aggregation import service as svc_mod
from backend.app.services.aggregation.schemas import (
    FreshnessSettingsRequest,
    ReconcilePolicyRequest,
)


def _run(coro):
    return asyncio.run(coro)


# ── Route gates ─────────────────────────────────────────────────────────


def _route(path, method):
    for r in fresh_mod.router.routes:
        if r.path == path and method in r.methods:
            return r
    raise AssertionError(f"no {method} {path}")


def _dep_fns(route):
    return {
        getattr(d.call, "__name__", repr(d.call))
        for d in route.dependant.dependencies
    }


def test_reconciliation_read_is_behind_the_ingestion_gate():
    names = _dep_fns(_route("/freshness/reconciliation", "GET"))
    assert "_require_ingestion_read" in names


def test_activity_read_is_behind_the_ingestion_gate():
    names = _dep_fns(_route("/freshness/reconciliation/activity", "GET"))
    assert "_require_ingestion_read" in names


def test_policy_write_is_platform_admin_only():
    """The policy governs every workspace's sources, so it cannot be a
    per-data-source gate."""
    route = _route("/freshness/reconciliation", "PUT")
    assert fresh_mod._REQUIRE_PROVIDER_MANAGE in [
        d.call for d in route.dependant.dependencies
    ]


def test_on_demand_sweep_is_platform_admin_only():
    route = _route("/freshness/reconcile-now", "POST")
    params = inspect.signature(fresh_mod.reconcile_now).parameters
    assert params["user"].default.dependency is fresh_mod._REQUIRE_PROVIDER_MANAGE


def test_settings_patch_keeps_the_per_source_manage_gate():
    route = _route("/data-sources/{ds_id}/freshness-settings", "PATCH")
    assert _REQUIRE_DS_MANAGE in [d.call for d in route.dependant.dependencies]


# ── Partial-update semantics ────────────────────────────────────────────


class _RecordingSvc:
    def __init__(self):
        self.rebuild_calls = []
        self.reconcile_calls = []

    async def set_source_rebuild_interval(self, ds_id, secs, session):
        self.rebuild_calls.append(secs)
        return secs

    async def set_source_reconcile_settings(self, ds_id, session, **kw):
        self.reconcile_calls.append(kw)
        return {
            "reconcile_enabled": kw.get("enabled"),
            "reconcile_check_interval_secs": kw.get("check_interval_secs"),
        }


def _patch(**body):
    return FreshnessSettingsRequest(**body)


def test_a_reconcile_only_patch_leaves_the_rebuild_interval_alone(monkeypatch):
    """Sending only ``autoReconcileEnabled`` must not clear the rebuild
    override — which is exactly what would happen if absent fields were
    treated as explicit nulls."""
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", False)
    svc = _RecordingSvc()
    resp = _run(fresh_mod.patch_freshness_settings(
        "ds_1", _patch(autoReconcileEnabled=False),
        request=None, svc=svc, session=None,
    ))
    assert svc.rebuild_calls == []                     # untouched
    assert svc.reconcile_calls == [{"enabled": False}]
    assert resp.auto_reconcile_enabled is False


def test_an_interval_only_patch_leaves_reconcile_settings_alone(monkeypatch):
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", False)
    svc = _RecordingSvc()
    _run(fresh_mod.patch_freshness_settings(
        "ds_1", _patch(rebuildMinIntervalSecs=1800),
        request=None, svc=svc, session=None,
    ))
    assert svc.rebuild_calls == [1800]
    assert svc.reconcile_calls == []


def test_an_explicit_null_clears_that_override(monkeypatch):
    """Null is a real value here: it means "stop overriding, inherit the
    global" — so it must reach the service, unlike an absent field."""
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", False)
    svc = _RecordingSvc()
    _run(fresh_mod.patch_freshness_settings(
        "ds_1", _patch(autoReconcileEnabled=None),
        request=None, svc=svc, session=None,
    ))
    assert svc.reconcile_calls == [{"enabled": None}]


def test_both_groups_can_be_patched_together(monkeypatch):
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", False)
    svc = _RecordingSvc()
    _run(fresh_mod.patch_freshness_settings(
        "ds_1",
        _patch(rebuildMinIntervalSecs=900, reconcileCheckIntervalSecs=7200),
        request=None, svc=svc, session=None,
    ))
    assert svc.rebuild_calls == [900]
    assert svc.reconcile_calls == [{"check_interval_secs": 7200}]


# ── Policy persistence ──────────────────────────────────────────────────


class _FakeSettingsRow:
    def __init__(self, cadence_json=None):
        self.id = "global"
        self.cadence_json = cadence_json
        self.tuning_json = None
        self.updated_at = None
        self.updated_by = None


class _FakeSession:
    def __init__(self, row):
        self._row = row
        self.committed = False

    async def get(self, _model, _pk):
        return self._row

    def add(self, _obj):
        pass

    async def commit(self):
        self.committed = True


def _save(row, body, sent):
    session = _FakeSession(row)
    resp = _run(svc_mod.save_reconcile_policy(session, body, sent=sent))
    return resp, json.loads(row.cadence_json)


def test_saving_the_policy_preserves_the_rebuild_cadence():
    """Both live in ``cadence_json``. A replace instead of a merge here would
    silently wipe a deliberately-configured rebuild window."""
    row = _FakeSettingsRow(json.dumps({
        "rebuildMinIntervalSecs": 1800, "driftAutoRebuild": False,
    }))
    _, stored = _save(
        row, ReconcilePolicyRequest(enabled=False), {"enabled"},
    )
    assert stored["rebuildMinIntervalSecs"] == 1800
    assert stored["driftAutoRebuild"] is False
    assert stored["reconcileEnabled"] is False


def test_saving_the_rebuild_cadence_preserves_the_reconciliation_policy():
    """The mirror of the test above, and the one that actually bit: the
    cadence dialog sends only its own two fields, so a REPLACE of
    ``cadence_json`` erased every reconciliation setting. Whichever editor
    saved last won."""
    from backend.app.services.aggregation.schemas import AggregationCadence
    from backend.app.services.aggregation.service import AggregationService

    row = _FakeSettingsRow(json.dumps({
        "reconcileEnabled": False,
        "reconcileCheckIntervalSecs": 7200,
        "reconcileDetectors": ["raw_drift"],
    }))
    session = _FakeSession(row)
    svc = AggregationService.__new__(AggregationService)

    async def _get_settings(_s):
        return None
    svc.get_settings = _get_settings

    _run(svc.put_settings(
        session,
        cadence=AggregationCadence(
            rebuildMinIntervalSecs=1800, driftAutoRebuild=True,
        ),
    ))
    stored = json.loads(row.cadence_json)
    assert stored["reconcileEnabled"] is False
    assert stored["reconcileCheckIntervalSecs"] == 7200
    assert stored["reconcileDetectors"] == ["raw_drift"]
    assert stored["rebuildMinIntervalSecs"] == 1800


def test_clearing_the_rebuild_interval_still_works():
    """Merging must not break "leave blank to use the default" — an
    explicitly-sent null still removes the key."""
    from backend.app.services.aggregation.schemas import AggregationCadence
    from backend.app.services.aggregation.service import AggregationService

    row = _FakeSettingsRow(json.dumps({"rebuildMinIntervalSecs": 1800}))
    session = _FakeSession(row)
    svc = AggregationService.__new__(AggregationService)

    async def _get_settings(_s):
        return None
    svc.get_settings = _get_settings

    _run(svc.put_settings(
        session,
        cadence=AggregationCadence(rebuildMinIntervalSecs=None, driftAutoRebuild=True),
    ))
    stored = json.loads(row.cadence_json)
    assert "rebuildMinIntervalSecs" not in stored
    assert stored["driftAutoRebuild"] is True


def test_an_explicit_null_unsets_a_policy_field_back_to_the_env_default():
    row = _FakeSettingsRow(json.dumps({"reconcileCheckIntervalSecs": 7200}))
    resp, stored = _save(
        row,
        ReconcilePolicyRequest(checkIntervalSecs=None),
        {"check_interval_secs"},
    )
    assert "reconcileCheckIntervalSecs" not in stored
    assert resp.check_interval_secs is None
    # …and the response still reports the env fallback the sweep will use.
    assert resp.env_check_interval_secs == 3600


def test_an_empty_detector_list_persists_as_all_off():
    """``[]`` is a real configuration, not a missing one. A truthiness check
    anywhere in this path would silently re-enable every detector."""
    row = _FakeSettingsRow()
    resp, stored = _save(
        row, ReconcilePolicyRequest(detectors=[]), {"detectors"},
    )
    assert stored["reconcileDetectors"] == []
    assert resp.detectors == []


def test_unsent_fields_are_not_written():
    row = _FakeSettingsRow()
    _, stored = _save(
        row, ReconcilePolicyRequest(enabled=True), {"enabled"},
    )
    assert set(stored) == {"reconcileEnabled"}


def test_policy_response_carries_the_env_defaults_for_seeding():
    """The editor seeds from ``persisted ?? envDefault``, so a no-op save
    round-trips the real current default instead of pinning a wrong value."""
    row = _FakeSettingsRow()
    resp, _ = _save(row, ReconcilePolicyRequest(), set())
    assert resp.env_enabled is True
    assert resp.env_check_interval_secs == 3600
    assert resp.env_max_actions_per_run == 10
    assert resp.env_shrink_tolerance_pct == 10
    assert set(resp.all_detectors) == {
        "overlay_missing", "overlay_shrunk", "never_aggregated", "raw_drift",
    }


# ── Validation ──────────────────────────────────────────────────────────


def test_check_interval_has_a_floor():
    """A mistyped 10s would hammer the whole fleet."""
    with pytest.raises(Exception):
        ReconcilePolicyRequest(checkIntervalSecs=10)


def test_per_source_check_interval_has_the_same_floor():
    with pytest.raises(Exception):
        FreshnessSettingsRequest(reconcileCheckIntervalSecs=10)


def test_check_interval_floor_is_the_same_number_in_both_requests():
    """One stored value, several writers, one floor.

    The global request said 300 while every sibling said 30, so a 60s interval
    passed the UI's own minimum and then 422'd against the only endpoint the
    Automation modal writes the global policy through — a value the per-source
    endpoint accepted happily the whole time.
    """
    assert ReconcilePolicyRequest(checkIntervalSecs=60).check_interval_secs == 60
    assert (
        FreshnessSettingsRequest(reconcileCheckIntervalSecs=60)
        .reconcile_check_interval_secs == 60
    )


def test_activity_since_defaults_to_24h():
    from backend.app.services.aggregation.service import parse_activity_since

    cutoff = parse_activity_since(None)
    age = (datetime.now(timezone.utc) - cutoff).total_seconds()
    assert 23 * 3600 < age < 25 * 3600


def test_activity_since_accepts_a_duration():
    from backend.app.services.aggregation.service import parse_activity_since

    cutoff = parse_activity_since("6h")
    age = (datetime.now(timezone.utc) - cutoff).total_seconds()
    assert 5.5 * 3600 < age < 6.5 * 3600


def test_activity_since_accepts_3h_and_7d():
    from backend.app.services.aggregation.service import parse_activity_since

    three = parse_activity_since("3h")
    week = parse_activity_since("7d")
    now = datetime.now(timezone.utc)
    assert 2.5 * 3600 < (now - three).total_seconds() < 3.5 * 3600
    assert 6.5 * 86400 < (now - week).total_seconds() < 7.5 * 86400


def test_activity_since_rejects_garbage():
    from backend.app.services.aggregation.service import parse_activity_since

    with pytest.raises(ValueError, match="ISO timestamp"):
        parse_activity_since("yesterday")


def test_activity_since_clamps_to_the_retention_window():
    """Run rows are trimmed at 30 days, so a wider window only widens the
    scan (one row per sweep tick), never the result."""
    from backend.app.services.aggregation.service import parse_activity_since

    now = datetime.now(timezone.utc)
    for raw in ("9999d", "2000-01-01T00:00:00+00:00"):
        cutoff = parse_activity_since(raw)
        assert (now - cutoff).total_seconds() <= 30 * 86400 + 60
