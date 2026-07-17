"""Registry-vs-observed drift reconciliation in the discovery worker.

GRAPH.LIST says what the provider holds NOW; the registry (catalog +
versioning projection_state) says what SHOULD be resident. These tests pin
the expected-set arithmetic — most critically that routine versioning cache
EVICTION (which physically drops FalkorDB graphs by design) never alarms —
and that ``collect()`` stamps the drift message onto the list-all cache row
only, without ever failing the sweep.
"""
from contextlib import asynccontextmanager
from types import SimpleNamespace

import pytest

from backend.insights_service import discovery


class _ExecSession:
    """Fake async session whose ``execute`` returns canned rows."""

    def __init__(self, rows):
        self._rows = rows

    async def execute(self, _stmt):
        rows = self._rows
        return SimpleNamespace(all=lambda: rows)


def _wire_sessions(monkeypatch, *, catalog_rows, projection_rows,
                   graphver_raises=False):
    """catalog_rows: [(source_identifier,)]; projection_rows:
    [(falkor_graph_name, status, projected_commit_seq, last_projected_at)]."""

    @asynccontextmanager
    async def _jobs_session():
        yield _ExecSession(catalog_rows)

    monkeypatch.setattr(discovery, "get_jobs_session", _jobs_session)

    import backend.app.services.versioning.db as graphver_db

    if graphver_raises:
        def _factory():
            raise RuntimeError("graphver store not bootstrapped")
    else:
        def _factory():
            @asynccontextmanager
            async def _session():
                yield _ExecSession(projection_rows)

            return _session

    monkeypatch.setattr(graphver_db, "get_session_factory", _factory)


@pytest.mark.asyncio
async def test_missing_registered_graph_reports_drift(monkeypatch):
    _wire_sessions(
        monkeypatch,
        catalog_rows=[("g1",), ("g2",), ("g3",)],
        projection_rows=[],
    )
    msg = await discovery._detect_registry_drift("p1", observed={"g1", "g3"})
    assert msg is not None and msg.startswith("graph_drift:")
    assert "g2" in msg and "1 registered graph(s)" in msg


@pytest.mark.asyncio
async def test_no_drift_when_everything_observed(monkeypatch):
    _wire_sessions(
        monkeypatch,
        catalog_rows=[("g1",)],
        projection_rows=[("gv_1", "idle", 42, "2020-01-01T00:00:00+00:00")],
    )
    assert await discovery._detect_registry_drift(
        "p1", observed={"g1", "gv_1", "unregistered_extra"},
    ) is None


@pytest.mark.asyncio
async def test_evicted_graph_absence_never_alarms(monkeypatch):
    # Routine budget eviction physically drops the graph AND its name can
    # also sit in the catalog — subtracted from the whole union.
    _wire_sessions(
        monkeypatch,
        catalog_rows=[("gv_cold",)],
        projection_rows=[("gv_cold", "evicted", 42, "2020-01-01T00:00:00+00:00")],
    )
    assert await discovery._detect_registry_drift("p1", observed=set()) is None


@pytest.mark.asyncio
async def test_resident_versioned_graph_absence_alarms(monkeypatch):
    _wire_sessions(
        monkeypatch,
        catalog_rows=[],
        projection_rows=[("gv_hot", "idle", 42, "2020-01-01T00:00:00+00:00")],
    )
    msg = await discovery._detect_registry_drift("p1", observed=set())
    assert msg is not None and "gv_hot" in msg


@pytest.mark.asyncio
async def test_midflight_and_never_projected_rows_do_not_alarm(monkeypatch):
    # projecting/rebuilding are mid-flight; idle with seq=0 was never
    # materialized — none of them is expected to physically exist yet.
    _wire_sessions(
        monkeypatch,
        catalog_rows=[],
        projection_rows=[
            ("gv_a", "projecting", 0, None),
            ("gv_b", "rebuilding", 10, None),
            ("gv_c", "idle", 0, None),
        ],
    )
    assert await discovery._detect_registry_drift("p1", observed=set()) is None


@pytest.mark.asyncio
async def test_recently_projected_graph_gets_a_settling_window(monkeypatch):
    # TOCTOU guard: a projection that completed AFTER the observed GRAPH.LIST
    # snapshot must not alarm this sweep (it alarms from the NEXT one if the
    # graph is still missing).
    from datetime import datetime, timezone

    _wire_sessions(
        monkeypatch,
        catalog_rows=[],
        projection_rows=[
            ("gv_fresh", "idle", 42, datetime.now(timezone.utc).isoformat()),
        ],
    )
    assert await discovery._detect_registry_drift("p1", observed=set()) is None


@pytest.mark.asyncio
async def test_settling_window_shields_catalog_twin_too(monkeypatch):
    # The just-projected name may ALSO be an active catalog item — the
    # settling window must shield the whole union, not just the versioned set.
    from datetime import datetime, timezone

    _wire_sessions(
        monkeypatch,
        catalog_rows=[("gv_fresh",)],
        projection_rows=[
            ("gv_fresh", "idle", 42, datetime.now(timezone.utc).isoformat()),
        ],
    )
    assert await discovery._detect_registry_drift("p1", observed=set()) is None


@pytest.mark.asyncio
async def test_graphver_failure_is_best_effort(monkeypatch):
    # An unbootstrapped graphver store must never fail the sweep — and must
    # not alarm on a half-computed expected set.
    _wire_sessions(
        monkeypatch,
        catalog_rows=[("g1",)],
        projection_rows=[],
        graphver_raises=True,
    )
    assert await discovery._detect_registry_drift("p1", observed=set()) is None


# ── collect() wiring: drift lands on the list-all row only ──────────

def _wire_collect(monkeypatch, *, graphs, drift_msg, provider_type="falkordb"):
    async def fake_get_provider(session, pid):
        return SimpleNamespace(
            provider_type=provider_type, host="falkordb", port=6379,
            tls_enabled=False, extra_config=None,
        )

    async def fake_creds(session, pid):
        return {}

    class _Inst:
        async def preflight(self, deadline_s=2.0):
            return SimpleNamespace(ok=True, reason="ok", elapsed_ms=1)

        async def list_graphs(self):
            return list(graphs)

        async def get_stats(self):
            return {"nodeCount": 1}

        async def close(self):
            pass

    monkeypatch.setattr(discovery, "get_provider_orm", fake_get_provider)
    monkeypatch.setattr(discovery, "get_credentials", fake_creds)
    monkeypatch.setattr(
        discovery.provider_manager, "_create_provider_instance",
        lambda **kw: _Inst(),
    )

    from contextlib import asynccontextmanager as _acm

    @_acm
    async def _noop_gate(*a, **k):
        yield

    monkeypatch.setattr(discovery.admission, "gate", _noop_gate)

    @_acm
    async def _fake_session():
        yield SimpleNamespace()

    monkeypatch.setattr(discovery, "get_jobs_session", _fake_session)

    drift_calls = []

    async def fake_drift(provider_id, observed):
        drift_calls.append((provider_id, set(observed)))
        return drift_msg

    monkeypatch.setattr(discovery, "_detect_registry_drift", fake_drift)

    ups = []

    async def fake_upsert(session, **kw):
        ups.append(kw)

    monkeypatch.setattr(discovery, "_upsert_cache", fake_upsert)
    return drift_calls, ups


@pytest.mark.asyncio
async def test_collect_stamps_drift_on_list_all_row(monkeypatch):
    drift_calls, ups = _wire_collect(
        monkeypatch, graphs=["g1"], drift_msg="graph_drift: 1 registered ...",
    )
    await discovery.collect(SimpleNamespace(provider_id="p1", asset_name=""))
    assert drift_calls == [("p1", {"g1"})]
    assert len(ups) == 1
    assert ups[0]["status"] == "fresh"                       # payload still served
    assert ups[0]["last_error"] == "graph_drift: 1 registered ..."


@pytest.mark.asyncio
async def test_collect_clears_drift_when_none(monkeypatch):
    _, ups = _wire_collect(monkeypatch, graphs=["g1"], drift_msg=None)
    await discovery.collect(SimpleNamespace(provider_id="p1", asset_name=""))
    assert ups[0]["last_error"] is None                      # self-clearing


@pytest.mark.asyncio
async def test_collect_never_runs_drift_for_per_asset_jobs(monkeypatch):
    drift_calls, ups = _wire_collect(
        monkeypatch, graphs=["g1"], drift_msg="graph_drift: nope",
    )
    await discovery.collect(SimpleNamespace(provider_id="p1", asset_name="g1"))
    assert drift_calls == []
    assert ups[0]["last_error"] is None


@pytest.mark.asyncio
async def test_collect_never_runs_drift_for_non_falkordb_providers(monkeypatch):
    # DataHub's list_graphs() returns [] BY DESIGN — comparing a catalog item
    # against it would stamp a permanent false drift banner.
    drift_calls, ups = _wire_collect(
        monkeypatch, graphs=[], drift_msg="graph_drift: nope",
        provider_type="datahub",
    )
    await discovery.collect(SimpleNamespace(provider_id="p1", asset_name=""))
    assert drift_calls == []
    assert ups[0]["last_error"] is None
