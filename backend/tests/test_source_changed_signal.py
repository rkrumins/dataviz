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

import pytest

from backend.app.db.models import WorkspaceDataSourceORM
from backend.app.services import graph_cache as graph_cache_mod
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


def _state(status="ready", fp="STORED", ws="ws-1"):
    return types.SimpleNamespace(
        data_source_id="ds-1",
        workspace_id=ws,
        aggregation_status=status,
        graph_fingerprint=fp,
    )


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
):
    """Wire a service with all collaborators mocked to record their call
    order. Returns (svc, session, order, captured)."""
    order = []
    provider = _FakeProvider(order)
    registry = _FakeRegistry(provider)
    svc = AggregationService(dispatcher=None, registry=registry, session_factory=None)

    async def _fake_fp(prov):
        if fp_timeout:
            raise asyncio.TimeoutError()
        return current_fp

    monkeypatch.setattr(svc_mod, "compute_graph_fingerprint", _fake_fp)

    async def _fake_mark_stale(ws, ds_, reason):
        order.append("mark_source_stale")

    monkeypatch.setattr(graph_cache_mod, "mark_source_stale", _fake_mark_stale)

    async def _fake_invalidate(ws, ds_):
        order.append("invalidate_hierarchy_reads")

    monkeypatch.setattr(graph_cache_mod, "invalidate_hierarchy_reads", _fake_invalidate)

    async def _fake_stats(ds_, ws):
        order.append("mark_stats_changed")

    monkeypatch.setattr(enqueue_mod, "mark_stats_changed", _fake_stats)

    captured = {}

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
    assert "mark_source_stale" in order
    assert "clear_content_caches" in order
    assert "invalidate_hierarchy_reads" in order
    assert "mark_stats_changed" in order
    # No state row → status "none" → aggregation not applicable → no trigger.
    assert "trigger" not in order


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


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main([__file__, "-v"]))
