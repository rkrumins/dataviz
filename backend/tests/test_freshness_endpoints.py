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
    AggregationCadence,
    FreshnessDoc,
    FreshnessRow,
    FreshnessSettingsRequest,
    FreshnessSettingsResponse,
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
    """Returns queued results in call order; records queries for assertions.

    A call beyond the queued results gets an empty ``_FakeResult()`` rather
    than raising — this lets existing fixtures (queued before the H1
    latest-job failure query existed) keep working unchanged: an
    unqueued/absent job query degrades exactly like "no jobs for this
    source", which is the correct real-world default anyway."""

    def __init__(self, results):
        self._results = list(results)
        self.executed = []

    async def execute(self, query):
        self.executed.append(query)
        if self._results:
            return self._results.pop(0)
        return _FakeResult()


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

    # F9: neutralize the cadence reads by default (empty global, no overrides)
    # so existing tests keep their exact queued-result ordering; the cadence
    # tests below override these. Both are batched/cached, not per-row.
    _patch_cadence(monkeypatch)


def _patch_cadence(monkeypatch, *, global_secs=None, overrides=None,
                   drift_auto=None, states=None):
    """Stub the two F9 cadence reads: the cached global cadence and the
    batched per-source state map. Neither touches ``session.execute`` so
    the queued-result ordering the other collaborators rely on is preserved.

    ``overrides`` stays a ``{ds_id: secs}`` shorthand for the rebuild-interval
    column; ``states`` sets any other state-row field (drift verdict, the
    reconcile overrides) for a source."""
    async def _cadence(session):
        return AggregationCadence(
            rebuild_min_interval_secs=global_secs, drift_auto_rebuild=drift_auto,
        )
    monkeypatch.setattr(svc_mod, "read_global_cadence", _cadence)

    merged = {
        ds_id: {"rebuild_min_interval_secs": secs}
        for ds_id, secs in (overrides or {}).items()
    }
    for ds_id, fields in (states or {}).items():
        merged.setdefault(ds_id, {}).update(fields)

    async def _states(session, ds_ids):
        return {k: dict(v) for k, v in merged.items()}
    monkeypatch.setattr(svc_mod, "_state_map", _states)


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
        # summary basis: the workspace/provider-filtered set BEFORE staleOnly
        # — here it happens to be the same single source.
        _FakeResult(rows=[
            (ds_a.id, ds_a.workspace_id, ds_a.aggregation_status,
             ds_a.provider_id, "Prov A"),
        ]),
    ])
    resp = _run(assemble_fleet_freshness(session, stale_only=True))
    assert seen.get("called") is True
    assert resp.total == 1
    assert resp.rows[0].data_source_id == "ds-a"


# ── Fleet summary (Task F7) ──────────────────────────────────────────────


def test_fleet_summary_counts_mixed_fixture(monkeypatch):
    # One of every bucket, plus a marker on a non-failed row AND on the
    # failed row (proving needs_attention doesn't double-count), plus
    # genat stamps on two rows. ds-pending carries the dead
    # aggregation_status=="pending" value (nothing ever writes it in
    # production) — it must NOT count toward `pending`; ds-ready carries a
    # real running job instead, proving `pending` tracks that live signal.
    ds_ready = _ds(id="ds-ready", status="ready")
    ds_pending = _ds(id="ds-pending", status="pending")
    ds_failed = _ds(id="ds-failed", status="failed")
    ds_none = _ds(id="ds-none", status="none")
    ds_skipped = _ds(id="ds-skipped", status="skipped")
    ds_norow = _ds(id="ds-norow", status=None)
    all_ds = [ds_ready, ds_pending, ds_failed, ds_none, ds_skipped, ds_norow]

    signals = {
        ("ws-1", "ds-ready"): (1, "2026-07-19T00:00:00+00:00", "source_changed"),
        ("ws-1", "ds-failed"): (2, "2026-07-19T00:05:00+00:00", "drift"),
    }
    _patch_fleet_collaborators(
        monkeypatch, signals=signals, running={"ds-ready": "job-1"},
    )
    session = _FakeSession([
        _FakeResult(scalar=len(all_ds)),
        _FakeResult(rows=[(ds, f"Prov {ds.id}") for ds in all_ds]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))

    # The page IS the full set (total==len(page)) — no 3rd query needed.
    assert len(session.executed) == 2
    s = resp.summary
    assert s is not None
    assert s.total == 6
    assert s.ready == 1
    assert s.pending == 1  # ds-ready's live job, NOT ds-pending's dead status
    assert s.failed == 1
    assert s.not_built == 3  # none, skipped, no-state-row
    assert s.recomputing == 2  # ds-ready + ds-failed both have markers
    assert s.needs_attention == 2  # ds-ready(marker) + ds-failed(marker&failed, counted once)
    assert s.cache_stamped == 2  # ds-ready + ds-failed have genat
    assert s.suspended == 0


def test_fleet_summary_counts_suspended_in_needs_attention(monkeypatch):
    """A source the breaker tripped is a person-required row: it must
    increment ``suspended`` AND ``needsAttention``, without also counting
    as drifting (the overlay is still wrong; the split is that automation
    will not retry)."""
    ds_ok = _ds(id="ds-ok", status="ready")
    ds_held = _ds(id="ds-held", status="ready")
    _patch_fleet_collaborators(monkeypatch)
    _patch_cadence(
        monkeypatch,
        states={"ds-held": {"drift_state": "suspended"}},
    )
    session = _FakeSession([
        _FakeResult(scalar=2),
        _FakeResult(rows=[(ds_ok, "Prov A"), (ds_held, "Prov A")]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))
    s = resp.summary
    assert s is not None
    assert s.suspended == 1
    assert s.drifting == 0
    assert s.needs_attention == 1


def test_fleet_summary_pending_ignores_dead_status_value(monkeypatch):
    # Regression: workspace_data_sources.aggregation_status is only ever
    # written "ready"/"failed"/"none" in production (job.completed/
    # job.failed listener paths) — "pending"/"running" mirror writes are
    # dead code (job_pending/job_started are never called). `pending` must
    # instead track a live AggregationJobORM row (running_job_id's signal).
    ds_dead_pending = _ds(id="ds-dead-pending", status="pending")  # no live job
    ds_live_job = _ds(id="ds-live-job", status="ready")  # a real rebuild in flight
    _patch_fleet_collaborators(monkeypatch, running={"ds-live-job": "job-42"})
    session = _FakeSession([
        _FakeResult(scalar=2),
        _FakeResult(rows=[(ds_dead_pending, "Prov A"), (ds_live_job, "Prov B")]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))
    assert resp.summary.pending == 1  # only the row with a real running job


def test_fleet_summary_ignores_stale_only_facet(monkeypatch):
    # 3 sources workspace-wide; only ds-b is stale. The staleOnly-filtered
    # rows/total must stay narrow, but summary reflects all 3.
    ds_a = _ds(id="ds-a", status="ready")
    ds_b = _ds(id="ds-b", status="ready")
    ds_c = _ds(id="ds-c", status="failed")
    signals = {
        ("ws-1", "ds-b"): (1, None, "source_changed"),
        ("ws-1", "ds-a"): (None, "2026-07-19T00:00:00+00:00", None),
    }
    _patch_fleet_collaborators(
        monkeypatch, signals=signals, stale=[("ws-1", "ds-b")],
    )
    session = _FakeSession([
        _FakeResult(scalar=1),  # stale-filtered total
        _FakeResult(rows=[(ds_b, "Prov B")]),  # stale-filtered page
        # summary basis query: full workspace/provider-filtered set.
        _FakeResult(rows=[
            (ds.id, ds.workspace_id, ds.aggregation_status, ds.provider_id, "Prov")
            for ds in (ds_a, ds_b, ds_c)
        ]),
    ])
    resp = _run(assemble_fleet_freshness(session, stale_only=True))

    # Rows/total stay staleOnly-filtered (unaffected by this change).
    assert resp.total == 1
    assert [r.data_source_id for r in resp.rows] == ["ds-b"]

    s = resp.summary
    assert s is not None
    assert s.total == 3
    assert s.ready == 2
    assert s.failed == 1
    assert s.not_built == 0
    assert s.recomputing == 1  # ds-b marker
    assert s.needs_attention == 2  # ds-b(marker) + ds-c(failed)
    assert s.cache_stamped == 1  # ds-a genat


def test_fleet_summary_full_set_on_page_2_of_small_page_size(monkeypatch):
    # total=3, pageSize=1, page=2 — the fetched page is a single row, but
    # summary must reflect all 3 filtered sources, not just that row.
    # ds-y also proves the widened running-job lookup covers the full set,
    # not just the page, when the page/full-set ids differ.
    ds_x = _ds(id="ds-x", status="ready")
    ds_y = _ds(id="ds-y", status="pending")  # dead status value; live job below is what counts
    ds_z = _ds(id="ds-z", status="failed")
    signals = {
        ("ws-1", "ds-y"): (3, "2026-07-19T00:00:00+00:00", "source_changed"),
    }
    _patch_fleet_collaborators(
        monkeypatch, signals=signals, running={"ds-y": "job-y"},
    )
    session = _FakeSession([
        _FakeResult(scalar=3),
        _FakeResult(rows=[(ds_y, "Prov Y")]),  # page 2 of pageSize=1
        _FakeResult(rows=[
            (ds.id, ds.workspace_id, ds.aggregation_status, ds.provider_id, "Prov")
            for ds in (ds_x, ds_y, ds_z)
        ]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=2, page_size=1))

    assert resp.total == 3
    assert [r.data_source_id for r in resp.rows] == ["ds-y"]

    s = resp.summary
    assert s is not None
    assert s.total == 3
    assert s.ready == 1
    assert s.pending == 1  # ds-y's live job (widened past the single-row page)
    assert s.failed == 1
    assert s.recomputing == 1
    assert s.needs_attention == 2  # ds-y(marker) + ds-z(failed)
    assert s.cache_stamped == 1


def test_fleet_summary_none_above_1000_sources(monkeypatch):
    _patch_fleet_collaborators(monkeypatch)
    ds_a = _ds(id="ds-a")
    session = _FakeSession([
        _FakeResult(scalar=1500),  # filtered set exceeds the 1000 cutoff
        _FakeResult(rows=[(ds_a, "Prov A")]),  # page still returned normally
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))

    assert resp.total == 1500
    assert len(resp.rows) == 1  # rows still returned
    assert resp.summary is None
    # Bounded work: no 3rd query needed once total already proves >1000.
    assert len(session.executed) == 2


def test_fleet_takes_no_provider_registry():
    # Structural proof the fleet does zero provider/FalkorDB work: the
    # function has no way to reach a provider — no registry parameter.
    params = set(inspect.signature(assemble_fleet_freshness).parameters)
    assert "registry" not in params
    assert "provider" not in params


# ── Per-provider summaries (Task G1, spec §8a) ───────────────────────────


def test_provider_summaries_mixed_fixture(monkeypatch):
    # Provider A: ds-a1 (ready + a live running job — proves the
    # ready/pending overlap is honored per-provider too), ds-a2 (failed +
    # a stale marker, so needs_attention counts once not twice). Provider
    # B: ds-b1 (ready + cache-stamped). No-provider group: ds-n1 (never
    # built). Groups must sort by provider_name with the no-provider
    # group last.
    ds_a1 = _ds(id="ds-a1", provider="prov-a", status="ready")
    ds_a2 = _ds(id="ds-a2", provider="prov-a", status="failed")
    ds_b1 = _ds(id="ds-b1", provider="prov-b", status="ready")
    ds_n1 = _ds(id="ds-n1", provider=None, status="none")
    all_ds = [ds_a1, ds_a2, ds_b1, ds_n1]
    names = {"ds-a1": "Prov A", "ds-a2": "Prov A", "ds-b1": "Prov B", "ds-n1": None}
    signals = {
        ("ws-1", "ds-a2"): (1, None, "drift"),
        ("ws-1", "ds-b1"): (2, "2026-07-19T00:00:00+00:00", None),
    }
    _patch_fleet_collaborators(
        monkeypatch, signals=signals, running={"ds-a1": "job-1"},
    )
    session = _FakeSession([
        _FakeResult(scalar=len(all_ds)),
        _FakeResult(rows=[(ds, names[ds.id]) for ds in all_ds]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))

    ps = resp.provider_summaries
    assert ps is not None
    assert [p.provider_id for p in ps] == ["prov-a", "prov-b", None]
    a, b, none_group = ps
    assert a.provider_name == "Prov A"
    assert a.total == 2
    assert a.ready == 1  # ds-a1 only (ds-a2 is failed)
    assert a.pending == 1  # ds-a1's live running job
    assert a.failed == 1  # ds-a2
    assert a.needs_attention == 1  # ds-a2 (marker & failed, counted once)
    assert a.cache_stamped == 0
    assert b.provider_name == "Prov B"
    assert b.total == 1 and b.ready == 1 and b.cache_stamped == 1
    assert none_group.provider_id is None and none_group.provider_name is None
    assert none_group.total == 1 and none_group.not_built == 1


def test_provider_summaries_none_above_1000_sources(monkeypatch):
    _patch_fleet_collaborators(monkeypatch)
    ds_a = _ds(id="ds-a")
    session = _FakeSession([
        _FakeResult(scalar=1500),  # filtered set exceeds the 1000 cutoff
        _FakeResult(rows=[(ds_a, "Prov A")]),
    ])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))
    assert resp.summary is None
    assert resp.provider_summaries is None


def test_fleet_row_schema_excludes_cache_key_fields():
    # Fleet rows never carry the doc-only cache-key-count fields — they
    # cost a per-source SCAN that must never run on the fleet path.
    assert "cache_key_count" not in FreshnessRow.model_fields
    assert "cache_key_count_by_endpoint" not in FreshnessRow.model_fields
    assert "cache_key_count" in FreshnessDoc.model_fields
    assert "cache_key_count_by_endpoint" in FreshnessDoc.model_fields


# ── count_cache_keys_by_endpoint (Task G1, spec §8b) ─────────────────────


class _ScanFakeRedis:
    """Fake redis whose ``scan`` actually glob-matches against a fixed
    keyspace (unlike the plain AsyncMock stand-ins used elsewhere, which
    just return canned keys regardless of the pattern) — needed here to
    prove the current-generation SCAN pattern genuinely excludes
    stale-gen/LKG keys, not merely that the pattern string looks right."""

    def __init__(self, keyspace, *, gen_value="0"):
        self._keyspace = keyspace
        self._gen_value = gen_value

    async def get(self, key):
        return self._gen_value

    async def scan(self, cursor=0, match="*", count=500):
        import fnmatch
        matched = [k for k in self._keyspace if fnmatch.fnmatch(k, match)]
        return (0, matched)


def test_count_cache_keys_by_endpoint_tallies_current_gen_only(monkeypatch):
    ws, ds = "ws-1", "ds-1"
    keyspace = [
        f"{gc_mod._KEY_PREFIX}:{ws}:{ds}::3:children:aaa",
        f"{gc_mod._KEY_PREFIX}:{ws}:{ds}::3:children:bbb",
        f"{gc_mod._KEY_PREFIX}:{ws}:{ds}::3:aggregated:ccc",
        f"{gc_mod._KEY_PREFIX}:{ws}:{ds}::2:children:stale",  # stale gen
        f"{gc_mod._LKG_PREFIX}:{ws}:{ds}::children:lkg",  # LKG, not primary
    ]
    cache = gc_mod.GraphCache(_ScanFakeRedis(keyspace, gen_value="3"))
    monkeypatch.setattr(gc_mod, "get_graph_cache", lambda: cache)

    result = _run(gc_mod.count_cache_keys_by_endpoint(ws, ds))
    assert result == {"children": 2, "aggregated": 1}


def test_count_cache_keys_by_endpoint_empty_when_nothing_cached(monkeypatch):
    cache = gc_mod.GraphCache(_ScanFakeRedis([], gen_value="0"))
    monkeypatch.setattr(gc_mod, "get_graph_cache", lambda: cache)
    result = _run(gc_mod.count_cache_keys_by_endpoint("ws-1", "ds-1"))
    assert result == {}


def test_count_cache_keys_by_endpoint_none_on_redis_error(monkeypatch):
    class _ErrorRedis:
        async def get(self, key):
            raise Exception("boom")

    cache = gc_mod.GraphCache(_ErrorRedis())
    monkeypatch.setattr(gc_mod, "get_graph_cache", lambda: cache)
    result = _run(gc_mod.count_cache_keys_by_endpoint("ws-1", "ds-1"))
    assert result is None


def test_count_cache_keys_by_endpoint_none_on_empty_ids(monkeypatch):
    class _AssertNoRedisCall:
        async def get(self, key):
            raise AssertionError("must not read generation for empty ids")

        async def scan(self, **kwargs):
            raise AssertionError("must not SCAN for empty ids")

    cache = gc_mod.GraphCache(_AssertNoRedisCall())
    monkeypatch.setattr(gc_mod, "get_graph_cache", lambda: cache)
    assert _run(gc_mod.count_cache_keys_by_endpoint("", "ds-1")) is None
    assert _run(gc_mod.count_cache_keys_by_endpoint("ws-1", "")) is None


# ── F9: cooldownUntil derives from the resolved rebuild interval ────────

from datetime import datetime as _dt, timedelta as _td, timezone as _tz


def _ago(seconds: int) -> str:
    return (_dt.now(_tz.utc) - _td(seconds=seconds)).isoformat()


def test_fleet_cooldown_until_honors_per_source_override(monkeypatch):
    monkeypatch.setattr(svc_mod, "AGGREGATION_REBUILD_MIN_INTERVAL_SECS", 900)
    ds_a = _ds(id="ds-a", last_agg=_ago(120))

    # No override → env 900 window still open → a cooldown IS reported.
    _patch_fleet_collaborators(monkeypatch)
    session = _FakeSession([_FakeResult(scalar=1), _FakeResult(rows=[(ds_a, "Prov A")])])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))
    assert resp.rows[0].cooldown_until is not None

    # 60s per-source override → 120s since last rebuild → window elapsed →
    # the badge derivation reports NO cooldown. Proves the override flows
    # into cooldownUntil (badge-vs-behavior parity).
    _patch_fleet_collaborators(monkeypatch)
    _patch_cadence(monkeypatch, overrides={"ds-a": 60})
    session2 = _FakeSession([_FakeResult(scalar=1), _FakeResult(rows=[(ds_a, "Prov A")])])
    resp2 = _run(assemble_fleet_freshness(session2, page=1, page_size=50))
    assert resp2.rows[0].cooldown_until is None


def test_fleet_cooldown_until_honors_global_cadence(monkeypatch):
    monkeypatch.setattr(svc_mod, "AGGREGATION_REBUILD_MIN_INTERVAL_SECS", 900)
    ds_a = _ds(id="ds-a", last_agg=_ago(120))
    _patch_fleet_collaborators(monkeypatch)
    # Persisted global of 60 (no per-source override) → 120s elapsed → none.
    _patch_cadence(monkeypatch, global_secs=60)
    session = _FakeSession([_FakeResult(scalar=1), _FakeResult(rows=[(ds_a, "Prov A")])])
    resp = _run(assemble_fleet_freshness(session, page=1, page_size=50))
    assert resp.rows[0].cooldown_until is None


def test_source_doc_cooldown_until_honors_override(monkeypatch):
    monkeypatch.setattr(svc_mod, "AGGREGATION_REBUILD_MIN_INTERVAL_SECS", 900)
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))
    _patch_source_collaborators(monkeypatch)
    _patch_cadence(monkeypatch, overrides={"ds-1": 60})
    session = _FakeSession([_FakeResult(rows=[(_ds(last_agg=_ago(120)), "Prov A")])])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.cooldown_until is None


def test_get_settings_reports_effective_env_defaults(monkeypatch):
    # The editor seeds from persisted ?? envDefault, so get_settings must
    # surface the REAL env defaults (here drift-auto OFF) — even with no row.
    monkeypatch.setattr(svc_mod, "AGGREGATION_REBUILD_MIN_INTERVAL_SECS", 900)
    monkeypatch.setattr(svc_mod, "AGGREGATION_DRIFT_AUTO_REBUILD", False)
    svc = _svc(_FakeRegistry(_FailProvider()))

    class _NoRowSession:
        async def get(self, orm, key):
            return None
    resp = _run(svc.get_settings(_NoRowSession()))
    assert resp.cadence is None
    assert resp.env_rebuild_min_interval_secs == 900
    assert resp.env_drift_auto_rebuild is False


def test_source_doc_exposes_resolved_and_source(monkeypatch):
    monkeypatch.setattr(svc_mod, "AGGREGATION_REBUILD_MIN_INTERVAL_SECS", 900)
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))

    # custom: a per-source override wins → source "custom", resolved = override.
    _patch_source_collaborators(monkeypatch)
    _patch_cadence(monkeypatch, global_secs=300, overrides={"ds-1": 60})
    session = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.rebuild_override_secs == 60
    assert doc.resolved_rebuild_interval_secs == 60
    assert doc.rebuild_interval_source == "custom"

    # global: no override, a persisted global → source "global", resolved = global.
    _patch_source_collaborators(monkeypatch)
    _patch_cadence(monkeypatch, global_secs=300)
    session2 = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])
    doc2 = _run(svc.assemble_source_freshness("ds-1", session2, probe=False))
    assert doc2.rebuild_override_secs is None
    assert doc2.resolved_rebuild_interval_secs == 300
    assert doc2.rebuild_interval_source == "global"

    # default: nothing set → source "default", resolved = env default (900).
    _patch_source_collaborators(monkeypatch)
    _patch_cadence(monkeypatch)
    session3 = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])
    doc3 = _run(svc.assemble_source_freshness("ds-1", session3, probe=False))
    assert doc3.rebuild_override_secs is None
    assert doc3.resolved_rebuild_interval_secs == 900
    assert doc3.rebuild_interval_source == "default"


# ── Per-source assembly: probe gating ───────────────────────────────────


def _patch_source_collaborators(monkeypatch, *, signals=None, lkg=(2, 120),
                                events=None, cache_keys=None):
    async def _sig(pairs):
        return signals or {}
    monkeypatch.setattr(gc_mod, "read_freshness_signals", _sig)

    async def _lkg(ws, ds):
        return lkg
    monkeypatch.setattr(gc_mod, "read_lkg_stats", _lkg)

    async def _cache_keys(ws, ds, branch_id=""):
        return {} if cache_keys is None else cache_keys
    monkeypatch.setattr(gc_mod, "count_cache_keys_by_endpoint", _cache_keys)

    async def _list_events(session, ds_id, limit=5):
        return events or []
    monkeypatch.setattr(events_repo_mod, "list_refresh_events", _list_events)

    async def _running(session, ds_ids):
        return {}
    monkeypatch.setattr(svc_mod, "_running_job_map", _running)

    _patch_cadence(monkeypatch)


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


# ── Doc: per-source cache-key counts (Task G1, spec §8b) ─────────────────


def test_source_doc_exposes_cache_key_counts(monkeypatch):
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))
    by_endpoint = {"children": 5, "aggregated": 2}
    _patch_source_collaborators(monkeypatch, cache_keys=by_endpoint)
    session = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])

    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.cache_key_count_by_endpoint == by_endpoint
    assert doc.cache_key_count == 7  # sum(byEndpoint)


def test_source_doc_cache_key_count_none_on_error(monkeypatch):
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))
    _patch_source_collaborators(monkeypatch, cache_keys=None)

    async def _count(ws, ds, branch_id=""):
        return None  # simulates a Redis error / disabled cache
    monkeypatch.setattr(gc_mod, "count_cache_keys_by_endpoint", _count)
    session = _FakeSession([_FakeResult(rows=[(_ds(), "Prov A")])])

    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.cache_key_count_by_endpoint is None
    assert doc.cache_key_count is None


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


# ── classify_failure: category classifier, order matters (H1, spec §9c) ─


@pytest.mark.parametrize(
    "error_message,expected", [
        (None, None),
        ("", None),
        ("OOM command not allowed when used memory > 'maxmemory'.", "out_of_memory"),
        ("redis.exceptions.ResponseError: OutOfMemoryError while allocating", "out_of_memory"),
        # OOM must win even though this message also contains "unavailable" —
        # checked BEFORE provider_unavailable (spec §9c ordering).
        ("provider unavailable: OOM command not allowed when used memory > 'maxmemory'.",
         "out_of_memory"),
        ("asyncio.TimeoutError: query timed out after 30s", "timeout"),
        ("OntologyResolutionError: no ontology assigned to this source", "ontology"),
        ("ConflictError: job already active for this source", "conflict"),
        ("ConnectionError: provider unavailable, connection refused", "provider_unavailable"),
        ("host unreachable", "provider_unavailable"),
        ("some completely unrelated failure", "unknown"),
    ],
)
def test_classify_failure_category_and_order(error_message, expected):
    from backend.app.services.aggregation.service import classify_failure
    assert classify_failure(error_message) == expected


# ── Doc: failure fields from the latest job (H1, spec §9c) ──────────────


def test_source_doc_failure_fields_populated_when_latest_job_failed(monkeypatch):
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([
        _FakeResult(rows=[(_ds(), "Prov A")]),
        _FakeResult(rows=[(
            "failed",
            "OOM command not allowed when used memory > 'maxmemory'.",
            2,
        )]),
    ])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.last_failure_reason == (
        "OOM command not allowed when used memory > 'maxmemory'."
    )
    assert doc.last_failure_category == "out_of_memory"
    assert doc.retry_count == 2


def test_source_doc_failure_fields_none_when_latest_job_ready(monkeypatch):
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([
        _FakeResult(rows=[(_ds(), "Prov A")]),
        _FakeResult(rows=[("completed", None, 0)]),
    ])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.last_failure_reason is None
    assert doc.last_failure_category is None
    assert doc.retry_count is None


def test_source_doc_failure_fields_none_when_no_jobs(monkeypatch):
    svc = _svc(_FakeRegistry(_FailProvider(), fail_resolve=True))
    _patch_source_collaborators(monkeypatch)
    session = _FakeSession([
        _FakeResult(rows=[(_ds(), "Prov A")]),
        _FakeResult(rows=[]),
    ])
    doc = _run(svc.assemble_source_freshness("ds-1", session, probe=False))
    assert doc.last_failure_reason is None
    assert doc.last_failure_category is None
    assert doc.retry_count is None


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


# ── Fleet-wide batch-refresh route (G2): always proxies, forces actor/origin ──


def test_fleet_batch_route_forwards_actor_and_forces_origin(monkeypatch):
    # No direct branch for this route either (same CP-only runner) — it
    # always proxies, but the client body still never decides actor/origin.
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["method"] = method
        captured["path"] = path
        captured["body"] = body
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    user = types.SimpleNamespace(id="user-42")
    out = _run(fresh_mod.refresh_fleet_batch(
        _FakeRequest(b'{"scope":"rollups","origin":"connector"}'),
        user=user,
    ))
    assert out == "proxied"
    assert captured["method"] == "POST"
    assert captured["path"] == "/aggregation/refresh-batch"
    body = json.loads(captured["body"])
    assert body["actor"] == "user-42"
    assert body["origin"] == "api"  # client's "connector" overridden
    assert body["scope"] == "rollups"


def test_fleet_batch_route_defaults_empty_body(monkeypatch):
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["body"] = body
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    user = types.SimpleNamespace(id="user-7")
    _run(fresh_mod.refresh_fleet_batch(_FakeRequest(b""), user=user))
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


def test_fleet_batch_requires_provider_manage_gate():
    fns = _dep_calls(_route("/freshness/refresh-all", "POST").dependant)
    assert fresh_mod._REQUIRE_PROVIDER_MANAGE in fns


def test_refresh_batch_status_requires_ingestion_gate():
    fns = _dep_calls(_route("/refresh-batches/{batch_id}", "GET").dependant)
    assert any(getattr(f, "__name__", "") == "_require_ingestion_read" for f in fns)


# ── F9: per-source rebuild-cadence override PATCH ───────────────────────


class _FakeSettingsSvc:
    def __init__(self, *, raises=None):
        self._raises = raises
        self.called_with = None

    async def set_source_rebuild_interval(self, ds_id, secs, session):
        self.called_with = (ds_id, secs)
        if self._raises:
            raise self._raises
        return secs


def test_freshness_settings_request_validates_bounds():
    from pydantic import ValidationError

    # null clears; 0 (disable) and the 86400 ceiling are valid.
    assert FreshnessSettingsRequest(rebuildMinIntervalSecs=None).rebuild_min_interval_secs is None
    assert FreshnessSettingsRequest(rebuildMinIntervalSecs=0).rebuild_min_interval_secs == 0
    assert FreshnessSettingsRequest(rebuildMinIntervalSecs=86400).rebuild_min_interval_secs == 86400
    # negative / oversized → 422 (schema rejects before the handler runs).
    with pytest.raises(ValidationError):
        FreshnessSettingsRequest(rebuildMinIntervalSecs=-1)
    with pytest.raises(ValidationError):
        FreshnessSettingsRequest(rebuildMinIntervalSecs=86401)


def test_freshness_settings_route_delegates_and_returns(_direct_mode):
    svc = _FakeSettingsSvc()
    body = FreshnessSettingsRequest(rebuildMinIntervalSecs=120)
    out = _run(fresh_mod.patch_freshness_settings(
        "ds-1", body, _FakeRequest(), svc=svc, session=object(),
    ))
    assert svc.called_with == ("ds-1", 120)
    assert isinstance(out, FreshnessSettingsResponse)
    assert out.data_source_id == "ds-1"
    assert out.rebuild_min_interval_secs == 120


def test_freshness_settings_route_null_clears(_direct_mode):
    svc = _FakeSettingsSvc()
    body = FreshnessSettingsRequest(rebuildMinIntervalSecs=None)
    out = _run(fresh_mod.patch_freshness_settings(
        "ds-1", body, _FakeRequest(), svc=svc, session=object(),
    ))
    assert svc.called_with == ("ds-1", None)
    assert out.rebuild_min_interval_secs is None


def test_freshness_settings_route_maps_notfound_to_404(_direct_mode):
    svc = _FakeSettingsSvc(raises=NotFoundError("no such ds"))
    body = FreshnessSettingsRequest(rebuildMinIntervalSecs=60)
    with pytest.raises(HTTPException) as ei:
        _run(fresh_mod.patch_freshness_settings(
            "ds-x", body, _FakeRequest(), svc=svc, session=object(),
        ))
    assert ei.value.status_code == 404


def test_freshness_settings_route_proxies(monkeypatch):
    monkeypatch.setattr(fresh_mod, "_PROXY_ENABLED", True)
    captured = {}

    async def _fake_proxy(method, path, request, body=None):
        captured["method"] = method
        captured["path"] = path
        return "proxied"
    monkeypatch.setattr(fresh_mod, "_proxy", _fake_proxy)

    body = FreshnessSettingsRequest(rebuildMinIntervalSecs=60)
    out = _run(fresh_mod.patch_freshness_settings(
        "ds-1", body, _FakeRequest(b'{"rebuildMinIntervalSecs":60}'),
        svc=None, session=object(),
    ))
    assert out == "proxied"
    assert captured["method"] == "PATCH"
    assert captured["path"] == "/aggregation/data-sources/ds-1/freshness-settings"


def test_freshness_settings_requires_manage_gate():
    fns = _dep_calls(_route("/data-sources/{ds_id}/freshness-settings", "PATCH").dependant)
    assert _REQUIRE_DS_MANAGE in fns


def test_cp_freshness_settings_twin_delegates():
    from backend.app.services.aggregation import controlplane as cp

    svc = _FakeSettingsSvc()
    body = FreshnessSettingsRequest(rebuildMinIntervalSecs=90)
    out = _run(cp.set_freshness_settings("ds-1", body=body, svc=svc, session=object()))
    assert svc.called_with == ("ds-1", 90)
    assert out.rebuild_min_interval_secs == 90


if __name__ == "__main__":
    import sys
    sys.exit(pytest.main([__file__, "-v"]))
