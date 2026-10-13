"""Analytics · Data — what the platform holds, and how it got there.

Entity counts are LEVELS: each bucket is what the platform held at its end,
with every source's last known count carried forward and dropped the day the
source was deleted. These tests seed daily rollups with a gap, a deletion and
a mid-window arrival, and assert the arithmetic.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from backend.app.db.models import (
    DataSourceCountRollupORM,
    ProviderORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import analytics_data_repo, analytics_repo
from backend.app.services import analytics_cache, versioned_sources
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.analytics_scope import PrivacyMode, ViewerScope

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)
DAYS = ["2026-06-08", "2026-06-09", "2026-06-10", "2026-06-11",
        "2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15"]


@pytest.fixture(autouse=True)
def _isolated(monkeypatch):
    analytics_cache.clear()
    # The version-control store is a second database; every test says what it
    # holds, and none of them reaches a real one.
    rows = [versioned_sources.VersionedGraphRow(
        data_source_id="ds_1", workspace_id="ws_a", kind="authoritative",
        created_at="2026-06-10T08:00:00+00:00", deleted_at=None,
    )]

    async def _rows(**_):
        return rows

    monkeypatch.setattr(versioned_sources, "versioned_graph_rows", _rows)
    yield rows
    analytics_cache.clear()


def _roll(ds, day, nodes, edges, ws, provider):
    return DataSourceCountRollupORM(
        data_source_id=ds, grain="day", bucket_start=day, workspace_id=ws,
        provider_id=provider, node_count=nodes, edge_count=edges,
    )


async def _seed(session):
    session.add_all([
        WorkspaceORM(id="ws_a", name="Alpha"),
        WorkspaceORM(id="ws_b", name="Beta"),
        ProviderORM(id="prov_f", name="Prod", provider_type="falkordb"),
        ProviderORM(id="prov_d", name="Catalog", provider_type="datahub"),
        WorkspaceDataSourceORM(
            id="ds_1", workspace_id="ws_a", provider_id="prov_f", graph_name="g1",
            label="Ledger", created_at="2026-04-01T00:00:00+00:00",
        ),
        WorkspaceDataSourceORM(
            id="ds_2", workspace_id="ws_b", provider_id="prov_d", graph_name="g2",
            label="Catalog", created_at="2026-06-12T09:00:00+00:00",
        ),
        WorkspaceDataSourceORM(
            id="ds_gone", workspace_id="ws_a", provider_id="prov_f", graph_name="g3",
            label="Archive", created_at="2026-04-01T00:00:00+00:00",
            deleted_at="2026-06-11T10:00:00+00:00",
        ),
        # Ledger: a baseline before the window, a missing day (06-09) and a
        # quiet stretch (06-11..06-14) that must carry forward.
        _roll("ds_1", "2026-06-05", 100, 200, "ws_a", "prov_f"),
        _roll("ds_1", "2026-06-08", 110, 220, "ws_a", "prov_f"),
        _roll("ds_1", "2026-06-10", 130, 260, "ws_a", "prov_f"),
        _roll("ds_1", "2026-06-15", 150, 300, "ws_a", "prov_f"),
        # Arrives mid-window.
        _roll("ds_2", "2026-06-12", 40, 10, "ws_b", "prov_d"),
        _roll("ds_2", "2026-06-14", 60, 20, "ws_b", "prov_d"),
        # Deleted on 06-11: it counts until then and never after.
        _roll("ds_gone", "2026-06-01", 500, 50, "ws_a", "prov_f"),
        _roll("ds_gone", "2026-06-09", 500, 50, "ws_a", "prov_f"),
        # Its first build finished five hours after it was added.
        AggregationJobORM(
            id="agg_first", data_source_id="ds_2", workspace_id="ws_b",
            status="completed", trigger_source="onboarding", progress=100,
            total_edges=0, processed_edges=0, created_edges=0, batch_size=1000,
            created_at="2026-06-12T10:00:00+00:00",
            completed_at="2026-06-12T14:00:00+00:00",
        ),
    ])
    await session.commit()


async def test_entities_are_levels_carried_forward_and_dropped_when_deleted(db_session):
    await _seed(db_session)
    doc = await analytics_data_repo.platform_data(db_session, days=7, now=NOW)

    growth = doc["growth"]
    assert growth["buckets"] == DAYS
    # 06-09: the Ledger was not reported, so its 06-08 count stands.
    # 06-11: the Archive was deleted that day and stops counting.
    # 06-12: the Catalog arrives.
    assert growth["entities"] == [610, 610, 630, 130, 170, 170, 190, 210]
    assert growth["relationships"][-1] == 300 + 20
    assert growth["totals"]["entities"] == {
        "start": 600, "end": 210, "change": -390, "changePct": -65.0,
    }
    assert growth["totals"]["sources"] == 2


async def test_breaks_growth_down_by_provider_type_and_workspace(db_session):
    await _seed(db_session)
    doc = await analytics_data_repo.platform_data(db_session, days=7, now=NOW)

    by_type = {b["key"]: b["entities"][-1] for b in doc["growth"]["byProviderType"]}
    assert by_type == {"falkordb": 150, "datahub": 60}
    by_ws = {b["name"]: b["entities"] for b in doc["growth"]["byWorkspace"]}
    assert by_ws["Alpha"][0] == 610 and by_ws["Alpha"][-1] == 150
    assert by_ws["Beta"][-1] == 60


async def test_names_the_biggest_movers_largest_change_first(db_session):
    await _seed(db_session)
    doc = await analytics_data_repo.platform_data(db_session, days=7, now=NOW)

    movers = [(m["name"], m["start"], m["end"]) for m in doc["growth"]["movers"]]
    assert movers == [("Archive", 500, 0), ("Catalog", 0, 60), ("Ledger", 100, 150)]
    assert doc["growth"]["movers"][1]["workspaceName"] == "Beta"


async def test_onboarding_splits_versioned_from_external_and_times_the_first_build(db_session):
    await _seed(db_session)
    doc = await analytics_data_repo.platform_data(db_session, days=7, now=NOW)

    onboarding = doc["onboarding"]
    at = DAYS.index("2026-06-12")
    assert onboarding["total"][at] == 1 and sum(onboarding["total"]) == 1
    assert onboarding["external"][at] == 1 and sum(onboarding["versioned"]) == 0
    assert onboarding["byProviderType"] == [{"key": "datahub", "count": 1}]
    # Two live sources; one arrived in the window, none in the one before.
    assert onboarding["totals"]["sources"]["total"] == 2
    assert onboarding["totals"]["sources"]["current"] == 1
    assert onboarding["firstBuild"] == {
        "medianHours": 5.0, "p90Hours": 5.0, "measured": 1, "awaiting": 0,
    }

    vc = doc["versionControl"]
    assert vc["available"] is True
    assert {k["key"]: k["count"] for k in vc["byKind"]}["authoritative"] == 1
    assert vc["share"] == {"versioned": 1, "total": 2}
    adopted = {s["key"]: s["values"] for s in vc["adopted"]["series"]}
    assert adopted["authoritative"][DAYS.index("2026-06-10")] == 1


async def test_version_control_says_unavailable_instead_of_zero(db_session, monkeypatch):
    await _seed(db_session)

    async def _down(**_):
        raise versioned_sources.VersionedLookupUnavailable("graphver unreachable")

    monkeypatch.setattr(versioned_sources, "versioned_graph_rows", _down)
    doc = await analytics_data_repo.platform_data(db_session, days=7, now=NOW)

    assert doc["versionControl"] == {"available": False}
    # The rest of the document is unaffected — only the split is unknown.
    assert doc["onboarding"]["versioned"] is None and doc["onboarding"]["external"] is None
    assert sum(doc["onboarding"]["total"]) == 1
    assert doc["growth"]["entities"][-1] == 210


async def test_a_reader_sees_counts_but_not_the_names_of_workspaces_they_cannot_see(db_session):
    await _seed(db_session)
    doc = await analytics_data_repo.platform_data(db_session, days=7, now=NOW)
    reader = ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}),
        privacy=PrivacyMode.INTERNAL,
    )
    seen = analytics_data_repo.redact_data(doc, reader)

    catalog = next(m for m in seen["growth"]["movers"] if m["end"] == 60)
    assert catalog["name"] == analytics_data_repo.REDACTED_SOURCE
    assert catalog["workspaceName"] == analytics_repo.REDACTED_WORKSPACE
    assert catalog["dataSourceId"] is None and catalog["canOpen"] is False
    ledger = next(m for m in seen["growth"]["movers"] if m["end"] == 150)
    assert ledger["name"] == "Ledger" and ledger["canOpen"] is True
    names = [b["name"] for b in seen["growth"]["byWorkspace"]]
    assert "Beta" not in names and analytics_repo.REDACTED_WORKSPACE in names
    # The totals are the same numbers everyone sees.
    assert seen["growth"]["entities"] == doc["growth"]["entities"]
    assert seen["redaction"]["applied"] is True
    # The cached original is untouched.
    assert any(m["name"] == "Catalog" for m in doc["growth"]["movers"])


async def test_the_document_is_a_bounded_number_of_reads(db_session):
    await _seed(db_session)
    issued = []
    original = db_session.execute

    async def _recording(stmt, *a, **kw):
        issued.append(stmt)
        return await original(stmt, *a, **kw)

    db_session.execute = _recording
    try:
        await analytics_data_repo.platform_data(db_session, days=365, now=NOW)
    finally:
        db_session.execute = original
    assert len(issued) <= 25, f"{len(issued)} reads"


@pytest.mark.parametrize("setting, kept", [(None, 90), ("30", 30), ("0", None), ("ninety", 90)])
async def test_runs_reach_back_as_far_as_the_prune_keeps_them(db_session, monkeypatch, setting, kept):
    """How far back runs reach — what bounds time to first build — is the
    prune's own setting. It was a copy of the default, 90 days, whatever
    AGGREGATION_JOB_RETENTION_DAYS said. ``None``: every run is kept."""
    if setting is None:
        monkeypatch.delenv("AGGREGATION_JOB_RETENTION_DAYS", raising=False)
    else:
        monkeypatch.setenv("AGGREGATION_JOB_RETENTION_DAYS", setting)
    doc = await analytics_data_repo.platform_data(db_session, days=30, now=NOW)
    assert doc["coverage"]["jobsKeptDays"] == kept


async def test_the_drill_in_carries_the_workspaces_own_growth(db_session):
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(db_session, "ws_a", days=7, now=NOW)

    assert detail["series"]["entities"] == [610, 610, 630, 130, 130, 130, 130, 150]
    assert detail["growth"]["entities"]["end"] == 150
    assert detail["operations"]["total"] == 0


async def test_a_source_moved_away_counts_only_while_it_was_here(db_session):
    await _seed(db_session)
    db_session.add_all([
        # Lived in Alpha until 06-12, then moved to Beta.
        WorkspaceDataSourceORM(
            id="ds_move", workspace_id="ws_b", provider_id="prov_f", graph_name="g4",
            label="Mover", created_at="2026-04-01T00:00:00+00:00",
        ),
        _roll("ds_move", "2026-06-10", 7, 0, "ws_a", "prov_f"),
        _roll("ds_move", "2026-06-12", 7, 0, "ws_a", "prov_f"),
        _roll("ds_move", "2026-06-13", 7, 0, "ws_b", "prov_f"),
    ])
    await db_session.commit()

    alpha = await analytics_repo.workspace_detail(db_session, "ws_a", days=7, now=NOW)
    at = DAYS.index
    assert alpha["series"]["entities"][at("2026-06-12")] == 130 + 7
    assert alpha["series"]["entities"][at("2026-06-13")] == 130


async def test_the_endpoint_serves_an_admin_and_gates_everyone_else(test_client, db_session):
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.main import app
    from backend.app.services.feature_flags import feature_flags
    from backend.app.services.permission_service import PermissionClaims

    await _seed(db_session)

    async def _get(perms):
        app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
            sid="sess_test", global_perms=perms, ws_perms={},
        )
        try:
            return await test_client.get("/api/v1/admin/analytics/data?days=7")
        finally:
            app.dependency_overrides.pop(get_permission_claims, None)

    feature_flags.invalidate()
    try:
        admin = await _get(("system:admin",))
        assert admin.status_code == 200
        assert "growth" in admin.json() and "redaction" not in admin.json()
        # Analytics is closed to everyone else until the public flag is on.
        import time as _time
        feature_flags._cache = {"analyticsPublicEnabled": False}
        feature_flags._cache_ts = _time.monotonic()
        assert (await _get(())).status_code == 403
    finally:
        feature_flags.invalidate()
