"""Unit tests for the Freshness Cockpit endpoints (Task F4).

Direct-handler-call style (like ``test_stale_overlay.py``): the route
handlers and the two assembly functions are exercised directly with fakes;
RBAC is asserted by inspecting the live route objects.

What is under test:

  * fleet assembly — one SQL pass + batched Redis/DB lookups, Redis nulls
    tolerated, ``staleOnly`` consults the stale marker, ``total`` = the
    filtered count, and NO provider/FalkorDB access (the function takes no
    registry — the structural guarantee — and completes on DB+Redis fakes).
  * per-source assembly — ``probe=false`` does zero provider work;
    ``probe=true`` makes exactly ONE ``get_schema_stats`` call, wrapped in
    ``asyncio.wait_for``; a provider failure degrades (never raises);
    unknown ds → ``None`` (→ 404 at the route).
  * refresh route — delegates to ``refresh_source`` with the authenticated
    user as actor + ``origin="api"``, and maps ``NotFoundError`` → 404.
  * route dependencies carry the right gate (ingestion-read on the reads,
    the manage gate on the refresh mutation).
"""
from __future__ import annotations

import asyncio
import inspect
import json
import types

import pytest
from fastapi import HTTPException

from backend.app.api.v1.endpoints import freshness as fresh_mod
from backend.app.api.v1.endpoints.aggregation import _REQUIRE_DS_MANAGE
from backend.app.db.repositories import refresh_events_repo as events_repo_mod
from backend.app.services import graph_cache as gc_mod
from backend.app.services.aggregation import service as svc_mod
from backend.app.services.aggregation.schemas import (
    FreshnessDoc,
    RefreshResponse,
)
from backend.app.services.aggregation.service import (
    AggregationService,
    NotFoundError,
    assemble_fleet_freshness,
)


def _run(coro):
    return asyncio.run(coro)


# ── Fakes ───────────────────────────────────────────────────────────────


class _FakeResult:
    def __init__(self, *, scalar=None, rows=None):
        self._scalar = scalar
        self._rows = rows or []

    def scalar(self):
        return self._scalar

    def all(self):
        return self._rows

    def first(self):
        return self._rows[0] if self._rows else None


class _FakeSession:
    """Returns queued results in call order; records queries for assertions."""

    def __init__(self, results):
        self._results = list(results)
        self.executed = []

    async def execute(self, query):
        self.executed.append(query)
        return self._results.pop(0)


def _ds(id="ds-1", ws="ws-1", provider="prov-1", label="Orders DB",
        status="ready", last_agg=None, fp="STORED"):
    return types.SimpleNamespace(
        id=id, workspace_id=ws, provider_id=provider, label=label,
        aggregation_status=status, last_aggregated_at=last_agg,
        graph_fingerprint=fp,
    )


def _event(origin="script", outcome="accepted", ts="2026-07-19T00:00:00+00:00"):
    return types.SimpleNamespace(origin=origin, outcome=outcome, ts=ts)


def _stats(nodes=10, edges=7):
    return types.SimpleNamespace(
        total_nodes=nodes, total_edges=edges,
        entity_type_stats=[types.SimpleNamespace(id="Entity", count=nodes)],
        edge_type_stats=[types.SimpleNamespace(id="REL", count=edges)],
    )


class _FailProvider:
    """Any provider access raises — proves a path took no provider work."""

    async def get_schema_stats(self):
        raise AssertionError("get_schema_stats must not be called")


class _OneShotProvider:
    def __init__(self, stats):
        self._stats = stats
        self.calls = 0

    async def get_schema_stats(self):
        self.calls += 1
        return self._stats


class _FakeRegistry:
    def __init__(self, provider, *, fail_resolve=False):
        self._provider = provider
        self.fail_resolve = fail_resolve
        self.resolve_calls = 0

    async def get_provider_for_workspace(self, ws, session, data_source_id=None):
        self.resolve_calls += 1
        if self.fail_resolve:
            raise AssertionError("provider resolution must not happen")
        return self._provider


def _svc(registry):
    return AggregationService(
        dispatcher=None, registry=registry, session_factory=None,
    )


def _patch_fleet_collaborators(monkeypatch, *, signals=None, events=None,
                               running=None, stale=None):
    async def _sig(pairs):
        return signals if signals is not None else {}
    monkeypatch.setattr(gc_mod, "read_freshness_signals", _sig)

    async def _events(session, ds_ids):
        return events or {}
    monkeypatch.setattr(events_repo_mod, "latest_refresh_event_map", _events)

    async def _running(session, ds_ids):
        return running or {}
    monkeypatch.setattr(svc_mod, "_running_job_map", _running)

    async def _stale():
        return stale or []
    monkeypatch.setattr(gc_mod, "list_stale_sources", _stale)


# ── Fleet assembly ──────────────────────────────────────────────────────


def test_fleet_assembles_rows_and_total(monkeypatch):
    ds_a, ds_b = _ds(id="ds-a"), _ds(id="ds-b", ws="ws-2")
    _patch_fleet_collaborators(
        monkeypatch,
        signals={("ws-1", "ds-a"): (5, "2026-07-19T01:00:00+00:00", "source_changed")},
        events={"ds-a": _event()},
        running={"ds-a": "job-run"},
    )
    session = _FakeSession([
        _FakeResult(scalar=2),
        _FakeResult(rows=[(ds_a, "Prov A"), (ds_b, "Prov B")]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))

    assert resp.total == 2
    assert [r.data_source_id for r in resp.rows] == ["ds-a", "ds-b"]
    a = resp.rows[0]
    assert a.provider_name == "Prov A"
    assert a.generation == 5
    assert a.cache_as_of == "2026-07-19T01:00:00+00:00"
    assert a.stale_reason == "source_changed"
    assert a.running_job_id == "job-run"
    assert a.last_event.origin == "script" and a.last_event.outcome == "accepted"
    assert a.drifted is None  # fleet never probes


def test_fleet_tolerates_redis_nulls(monkeypatch):
    ds_a = _ds(id="ds-a")
    # No signals, no events, no running job → every Redis-sourced field None.
    _patch_fleet_collaborators(monkeypatch, signals={})
    session = _FakeSession([
        _FakeResult(scalar=1),
        _FakeResult(rows=[(ds_a, "Prov A")]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))
    row = resp.rows[0]
    assert row.generation is None
    assert row.cache_as_of is None
    assert row.stale_reason is None
    assert row.running_job_id is None
    assert row.last_event is None
    # DB-sourced fields still present.
    assert row.aggregation_status == "ready"
    assert row.stored_fingerprint == "STORED"


def test_fleet_stale_only_short_circuits_when_no_markers(monkeypatch):
    _patch_fleet_collaborators(monkeypatch, stale=[])  # nothing stale
    session = _FakeSession([])  # must NOT execute any SQL
    resp = _run(assemble_fleet_freshness(session, stale_only=True))
    assert resp.total == 0
    assert resp.rows == []
    assert session.executed == []  # no SQL pass when the marker set is empty


def test_fleet_stale_only_consults_marker_set(monkeypatch):
    seen = {}

    async def _stale():
        seen["called"] = True
        return [("ws-1", "ds-a")]
    monkeypatch.setattr(gc_mod, "list_stale_sources", _stale)
    _patch_fleet_collaborators(monkeypatch, signals={}, stale=[("ws-1", "ds-a")])
    # re-apply the recording stale fn (patch order)
    monkeypatch.setattr(gc_mod, "list_stale_sources", _stale)

    ds_a = _ds(id="ds-a")
    session = _FakeSession([
        _FakeResult(scalar=1),
        _FakeResult(rows=[(ds_a, "Prov A")]),
    ])
    resp = _run(assemble_fleet_freshness(session, stale_only=True))
    assert seen.get("called") is True
    assert resp.total == 1
    assert resp.rows[0].data_source_id == "ds-a"


def test_fleet_takes_no_provider_registry():
    # Structural proof the fleet does zero provider/FalkorDB work: the
    # function has no way to reach a provider — no registry parameter.
    params = set(inspect.signature(assemble_fleet_freshness).parameters)
    assert "registry" not in params
    assert "provider" not in params


# ── Per-source assembly: probe gating ───────────────────────────────────


def _patch_source_collaborators(monkeypatch, *, signals=None, lkg=(2, 120),
                                events=None):
    async def _sig(pairs):
        return signals or {}
    monkeypatch.setattr(gc_mod, "read_freshness_signals", _sig)

    async def _lkg(ws, ds):
        return lkg
    monkeypatch.setattr(gc_mod, "read_lkg_stats", _lkg)

    async def _list_events(session, ds_id, limit=5):
        return events or []
    monkeypatch.setattr(events_repo_mod, "list_refresh_events", _list_events)

    async def _running(session, ds_ids):
        return {}
    monkeypatch.setattr(svc_mod, "_running_job_map", _running)


def test_source_probe_false_does_no_provider_work(monkeypatch):
    registry = _FakeRegistry(_FailProvider(), fail_resolve=True)
    svc = _svc(registry)
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])

    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert isinstance(doc, FreshnessDoc)
    assert registry.resolve_calls == 0  # provider never resolved
    assert doc.live_fingerprint is None
    assert doc.live_node_count is None
    assert doc.drifted is None
    assert doc.lkg_count == 2
    assert doc.lkg_oldest_age_secs == 120


def test_source_probe_true_calls_schema_stats_once_under_wait_for(monkeypatch):
    provider = _OneShotProvider(_stats(nodes=10, edges=7))
    registry = _FakeRegistry(provider)
    svc = _svc(registry)
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([_FakeResult(rows=[(_ds(fp=None), "Prov A")])])

    wait_for_calls = []
    real_wait_for = asyncio.wait_for

    async def _spy_wait_for(awaitable, timeout=None):
        wait_for_calls.append(timeout)
        return await real_wait_for(awaitable, timeout)
    monkeypatch.setattr(svc_mod.asyncio, "wait_for", _spy_wait_for)

    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=True))
    assert provider.calls == 1  # exactly one schema-stats probe
    assert len(wait_for_calls) >= 1  # the probe ran under wait_for
    assert doc.live_node_count == 10
    assert doc.live_edge_count == 7
    assert doc.live_fingerprint  # a real digest
    # No stored baseline (fp=None) → drift verdict stays unknown.
    assert doc.drifted is None


def test_source_probe_true_computes_drift_against_stored(monkeypatch):
    stats = _stats(nodes=10, edges=7)
    from backend.app.services.aggregation.fingerprint import fingerprint_from_stats
    live_fp = fingerprint_from_stats(stats)

    provider = _OneShotProvider(stats)
    svc = _svc(_FakeRegistry(provider))
    _patch_source_collaborators(monkeypatch)
    # Stored fingerprint differs → drifted True.
    session = _FakeSession([_FakeResult(rows=[(_ds(fp="DIFFERENT"), "Prov A")])])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=True))
    assert doc.live_fingerprint == live_fp
    assert doc.drifted is True

    # Stored fingerprint matches → drifted False.
    provider2 = _OneShotProvider(stats)
    svc2 = _svc(_FakeRegistry(provider2))
    _patch_source_collaborators(monkeypatch)
    session2 = _FakeSession([_FakeResult(rows=[(_ds(fp=live_fp), "Prov A")])])
    doc2 = _run(svc2.assemble_source_freshness("ds-1", session2, probe=True))
    assert doc2.drifted is False


def test_source_probe_failure_degrades_without_raising(monkeypatch):
    class _Boom:
        async def get_schema_stats(self):
            raise RuntimeError("provider down")

    svc = _svc(_FakeRegistry(_Boom()))
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=True))
    assert doc.live_fingerprint is None
    assert doc.drifted is None  # probe failed → unknown, not a crash


def test_source_unknown_ds_returns_none(monkeypatch):
    svc = _svc(_FakeRegistry(_FailProvider()))
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([_FakeResult(rows=[])])  # no row
    doc = _run(svc.assemble_source_freshness("nope", session, probe=True))
    assert doc is None


# ── Per-source route: 404 mapping ───────────────────────────────────────


class _FakeSvc:
    def __init__(self, *, doc=None, refresh=None, raises=None):
        self._doc = doc
        self._refresh = refresh
        self._raises = raises
        self.refresh_kwargs = None

    async def assemble_source_freshness(self, ds_id, session, *, probe=False):
        return self._doc

    async def refresh_source(self, ds_id, session, **kwargs):
        self.refresh_kwargs = kwargs
        if self._raises:
            raise self._raises
        return self._refresh


class _FakeRequest:
    def __init__(self, body=b""):
        self._body = body

    async def body(self):
        return self._body


@pytest.fixture
def _direct_mode(monkeypatch):
    """Force the viz-service direct branch (the dev container runs in proxy
    mode, where these routes just forward to the Control Plane)."""
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", False)


def test_get_source_route_maps_missing_to_404(_direct_mode):
    svc = _FakeSvc(doc=None)
    with pytest.raises(HTTPException) as ei:
        _run(fresh_mod.get_source_freshness(
            "ds-x", _FakeRequest(), svc=svc, session=object(), probe=False,
        ))
    assert ei.value.status_code == 404


def test_get_source_route_returns_doc_when_present(_direct_mode):
    doc = FreshnessDoc(data_source_id="ds-1")
    svc = _FakeSvc(doc=doc)
    out = _run(fresh_mod.get_source_freshness(
        "ds-1", _FakeRequest(), svc=svc, session=object(), probe=True,
    ))
    assert out is doc


# ── Refresh route: delegation + actor + 404 ─────────────────────────────


def test_refresh_route_delegates_with_actor_and_origin(_direct_mode):
    resp = RefreshResponse(scope="rollups", gate="n/a", changed=True)
    svc = _FakeSvc(refresh=resp)
    user = types.SimpleNamespace(id="user-42")
    out = _run(fresh_mod.refresh_data_source(
        "ds-1", _FakeRequest(b'{"scope":"rollups","force":true}'),
        user=user, svc=svc, session=object(),
    ))
    assert out is resp
    assert svc.refresh_kwargs["scope"] == "rollups"
    assert svc.refresh_kwargs["force"] is True
    assert svc.refresh_kwargs["actor"] == "user-42"
    assert svc.refresh_kwargs["origin"] == "api"


def test_refresh_route_defaults_empty_body_to_auto(_direct_mode):
    resp = RefreshResponse(scope="auto", gate="changed", changed=True)
    svc = _FakeSvc(refresh=resp)
    user = types.SimpleNamespace(id="u1")
    _run(fresh_mod.refresh_data_source(
        "ds-1", _FakeRequest(b""), user=user, svc=svc, session=object(),
    ))
    assert svc.refresh_kwargs["scope"] == "auto"


def test_refresh_route_maps_notfound_to_404(_direct_mode):
    svc = _FakeSvc(raises=NotFoundError("no such ds"))
    user = types.SimpleNamespace(id="u1")
    with pytest.raises(HTTPException) as ei:
        _run(fresh_mod.refresh_data_source(
            "ds-x", _FakeRequest(b'{"scope":"auto"}'),
            user=user, svc=svc, session=object(),
        ))
    assert ei.value.status_code == 404


def test_refresh_route_proxy_forwards_actor(monkeypatch):
    # Proxy mode (production): the forwarded body must carry the
    # authenticated user id so the CP audits the refresh as the user.
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", True)
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["body"] = body
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    user = types.SimpleNamespace(id="user-42")
    out = _run(fresh_mod.refresh_data_source(
        "ds-1", _FakeRequest(b'{"scope":"rollups"}'),
        user=user, svc=None, session=object(),
    ))
    assert out == "proxied"
    body = json.loads(captured["body"])
    assert body["actor"] == "user-42"
    assert body["scope"] == "rollups"


def test_refresh_route_proxy_overrides_client_origin(monkeypatch):
    # A ds:manage caller must not be able to forge the audit origin: the
    # proxy branch forces origin="api" regardless of the client body.
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", True)
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["body"] = body
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    user = types.SimpleNamespace(id="user-42")
    _run(fresh_mod.refresh_data_source(
        "ds-1", _FakeRequest(b'{"scope":"auto","origin":"connector"}'),
        user=user, svc=None, session=object(),
    ))
    body = json.loads(captured["body"])
    assert body["origin"] == "api"  # client's "connector" overridden


def test_cp_refresh_twin_passes_actor_through():
    # The Control Plane twin forwards the proxied actor to refresh_source.
    from backend.app.services.aggregation import controlplane as cp
    from backend.app.services.aggregation.schemas import RefreshRequestInternal

    svc = _FakeSvc(refresh=RefreshResponse(scope="rollups", gate="n/a", changed=True))
    body = RefreshRequestInternal(scope="rollups", actor="user-99", origin="api")
    _run(cp.refresh_source("ds-1", body=body, svc=svc, session=object()))
    assert svc.refresh_kwargs["actor"] == "user-99"
    assert svc.refresh_kwargs["origin"] == "api"


# ── Provider batch-refresh route: always proxies, forces actor/origin ──


def test_provider_batch_route_forwards_actor_and_forces_origin(monkeypatch):
    # No direct branch for this route (the runner is CP-only) — it always
    # proxies, but the same trust rule applies: the client body never
    # decides actor/origin.
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    user = types.SimpleNamespace(id="user-42")
    out = _run(fresh_mod.refresh_provider_batch(
        "prov-1", _FakeRequest(b'{"scope":"rollups","origin":"connector"}'),
        user=user,
    ))
    assert out == "proxied"
    assert captured["method"] == "POST"
    assert captured["path"] == "/aggregation/providers/prov-1/refresh-batch"
    body = json.loads(captured["body"])
    assert body["actor"] == "user-42"
    assert body["origin"] == "api"  # client's "connector" overridden
    assert body["scope"] == "rollups"


def test_provider_batch_route_defaults_empty_body(monkeypatch):
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["body"] = body
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    user = types.SimpleNamespace(id="user-7")
    _run(fresh_mod.refresh_provider_batch("prov-1", _FakeRequest(b""), user=user))
    body = json.loads(captured["body"])
    assert body["actor"] == "user-7"
    assert body["origin"] == "api"


# ── RBAC: route dependencies carry the right gate ───────────────────────


def _dep_calls(dependant):
    out = [dependant.call]
    for d in dependant.dependencies:
        out += _dep_calls(d)
    return out


def _route(path, method):
    for r in fresh_mod.router.routes:
        if r.path == path and method in r.methods:
            return r
    raise AssertionError(f"route {method} {path} not found")


def test_reads_require_ingestion_gate():
    for path in ("/freshness", "/data-sources/{ds_id}/freshness"):
        fns = _dep_calls(_route(path, "GET").dependant)
        assert any(getattr(f, "__name__", "") == "_require_ingestion_read"
                   for f in fns), path


def test_refresh_requires_manage_gate():
    fns = _dep_calls(_route("/data-sources/{ds_id}/refresh", "POST").dependant)
    assert _REQUIRE_DS_MANAGE in fns


def test_provider_batch_requires_provider_manage_gate():
    fns = _dep_calls(_route("/providers/{provider_id}/refresh", "POST").dependant)
    assert fresh_mod._REQUIRE_PROVIDER_MANAGE in fns


def test_refresh_batch_status_requires_ingestion_gate():
    fns = _dep_calls(_route("/refresh-batches/{batch_id}", "GET").dependant)
    assert any(getattr(f, "__name__", "") == "_require_ingestion_read" for f in fns)


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
