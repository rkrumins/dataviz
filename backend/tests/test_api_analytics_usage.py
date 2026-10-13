"""Analytics · Usage — what is used, when, and how ingestion is driven.

Seeded with known opens, people, runs and ledger events at known times, and
asserted on the arithmetic: unique viewers per bucket, how far views reach, a
view's first open by someone other than its author, presence, runs started by
people against automation, and each workspace's pulse.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest

from backend.app.db.models import (
    AuthAuditLogORM,
    ProductEventORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import analytics_repo, analytics_usage_repo
from backend.app.services import analytics_cache
from backend.app.services.aggregation.models import AggregationJobORM
from backend.app.services.analytics_scope import PrivacyMode, ViewerScope

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


def _at(days_ago: float, hour: int | None = None) -> str:
    at = NOW - timedelta(days=days_ago)
    if hour is not None:
        at = at.replace(hour=hour, minute=0)
    return at.isoformat()


@pytest.fixture(autouse=True)
def _no_cache():
    analytics_cache.clear()
    yield
    analytics_cache.clear()


def _open(n, view, actor, at):
    return ProductEventORM(
        id=f"pev_{n}", event_type="view.opened", actor_id=actor, subject_id=view,
        payload=json.dumps({"viewId": view}), created_at=at,
    )


def _job(n, trigger, status, at, by=None):
    return AggregationJobORM(
        id=f"agg_{n}", data_source_id="ds_1", workspace_id="ws_a", status=status,
        trigger_source=trigger, triggered_by=by, progress=0, total_edges=0,
        processed_edges=0, created_edges=0, batch_size=1000, created_at=at,
    )


def _ledger(n, category, at, *, ws="ws_a", ds=None, actor="usr_ana", kind="user",
            audience="workspace"):
    return AuthAuditLogORM(
        source_event_id=f"evt_{n}", event_type=f"{category}.x", payload="{}",
        occurred_at=at, category=category, audience=audience,
        actor_id=actor, actor_kind=kind, workspace_id=ws, data_source_id=ds,
        projection_version=1,
    )


async def _seed(session):
    session.add_all([
        WorkspaceORM(id="ws_a", name="Alpha"),
        WorkspaceORM(id="ws_b", name="Beta"),
        WorkspaceDataSourceORM(
            id="ds_1", workspace_id="ws_a", provider_id="prov_1", graph_name="g1", label="Ledger",
        ),
        UserORM(id="usr_ana", email="ana@x.io", password_hash="x", first_name="Ana", last_name="O",
                status="active", last_active_at=_at(1), last_seen_at=_at(1), last_login_at=_at(1)),
        UserORM(id="usr_ben", email="ben@x.io", password_hash="x", first_name="Ben", last_name="L",
                status="active", last_seen_at=_at(2), last_login_at=_at(2)),
        UserORM(id="usr_cy", email="cy@x.io", password_hash="x", first_name="Cy", last_name="W",
                status="active", last_seen_at=_at(20), last_login_at=_at(20)),
        UserORM(id="usr_dee", email="dee@x.io", password_hash="x", first_name="Dee", last_name="R",
                status="active", last_login_at=_at(90)),
        UserORM(id="usr_new", email="new@x.io", password_hash="x", first_name="New", last_name="N",
                status="pending"),
        ViewORM(id="v_a", name="A", workspace_id="ws_a", created_by="usr_ana",
                created_at=_at(3), view_type="graph", visibility="workspace"),
        ViewORM(id="v_b", name="B", workspace_id="ws_b", created_by="usr_ben",
                created_at=_at(20), view_type="table", visibility="private"),
        # Opens: v_a by its author first (not "someone else"), then by Ben
        # twelve hours after it was made; v_b by three people.
        _open(1, "v_a", "usr_ana", _at(3)),
        _open(2, "v_a", "usr_ben", _at(2.5)),
        _open(3, "v_b", "usr_ana", _at(1, hour=14)),
        _open(4, "v_b", "usr_ben", _at(1, hour=14)),
        _open(5, "v_b", "usr_cy", _at(1, hour=9)),
        # Previous window: one viewer.
        _open(6, "v_b", "usr_dee", _at(10)),
        # Runs: two by hand (one recorded the person, one only its trigger),
        # one automatic that failed, one onboarding.
        _job(1, "api", "completed", _at(2), by="usr_ana"),
        _job(2, "manual", "completed", _at(1)),
        _job(3, "reconcile", "failed", _at(1)),
        _job(4, "onboarding", "completed", _at(4)),
        _job(5, "manual", "completed", _at(10), by="usr_ben"),
        # Ledger: three operations by people on the Ledger, an access change,
        # and identity noise that is not workspace activity.
        _ledger(1, "operations", _at(5), ds="ds_1"),
        _ledger(2, "operations", _at(3), ds="ds_1"),
        _ledger(3, "operations", _at(1), ds="ds_1"),
        _ledger(4, "access", _at(2)),
        _ledger(5, "identity", _at(2), audience="platform"),
        _ledger(6, "operations", _at(1), ws="ws_b", actor=None, kind="system"),
        ViewActivityLogORM(id="val_1", view_id="v_b", workspace_id="ws_b", action="updated",
                           actor="usr_ben", created_at=_at(1)),
    ])
    await session.commit()


async def _usage(session, **kw):
    return await analytics_usage_repo.platform_usage(session, days=7, now=NOW, **kw)


async def test_counts_unique_viewers_reach_and_first_opens_by_someone_else(db_session):
    await _seed(db_session)
    doc = await _usage(db_session)
    content = doc["content"]

    assert sum(1 for n in content["uniqueViewers"] if n) >= 2
    assert content["viewers"]["current"] == 3          # ana, ben, cy
    assert content["viewers"]["previous"] == 1         # dee
    assert content["viewsOpened"] == 2
    assert {r["key"]: r["count"] for r in content["reach"]} == {"1": 0, "2–5": 2, "6–20": 0, "21+": 0}
    by_type = {r["key"]: r for r in content["byType"]}
    assert by_type["graph"] == {"key": "graph", "built": 1, "opens": 2}
    assert by_type["table"]["opens"] == 3
    # v_a was built three days ago; its author's own open does not count, and
    # Ben opened it twelve hours later.
    assert content["firstOpen"] == {"medianHours": 12.0, "withinWeek": 1, "opened": 1, "built": 1}


async def test_counts_presence_and_when_people_are_around(db_session):
    await _seed(db_session)
    doc = await _usage(db_session)

    presence = {p["key"]: p["count"] for p in doc["engagement"]["presence"]}
    assert presence == {"active": 1, "seen": 1, "recent": 1, "dormant": 1, "never": 1}
    grid = doc["engagement"]["punchcard"]
    assert len(grid) == 7 and all(len(row) == 24 for row in grid)
    # 2026-06-14 is a Sunday: two opens at 14:00 UTC, one at 09:00.
    assert grid[6][14] == 2 and grid[6][9] == 1


async def test_separates_runs_people_started_from_automation(db_session):
    await _seed(db_session)
    health = (await _usage(db_session))["health"]

    assert health["totals"] == {"byHand": 2, "automatic": 1, "onboarding": 1, "other": 0}
    assert health["byHand"]["current"] == 2 and health["byHand"]["previous"] == 1
    assert health["manualShare"] == 0.5
    assert health["failureRate"] == 0.25
    ledger = health["handsOnSources"][0]
    assert (ledger["dataSourceId"], ledger["name"], ledger["count"]) == ("ds_1", "Ledger", 3)
    assert ledger["medianGapHours"] == 48.0


async def test_measures_each_workspaces_pulse(db_session):
    await _seed(db_session)
    workspaces = (await _usage(db_session))["workspaces"]

    pulse = {p["workspaceId"]: p["total"] for p in workspaces["pulse"]}
    # Alpha: three operations + an access change + two opens of v_a. The
    # identity event is not workspace activity.
    assert pulse["ws_a"] == 4 + 2
    # Beta: a system operation, a view edit and three opens of v_b.
    assert pulse["ws_b"] == 1 + 1 + 3
    rows = {r["workspaceId"]: r for r in workspaces["rows"]}
    assert rows["ws_a"]["manualOperations"] == 3 and rows["ws_a"]["accessChanges"] == 1
    assert rows["ws_b"]["manualOperations"] == 0


async def test_withholds_operations_and_hidden_workspace_names_below_full(db_session):
    await _seed(db_session)
    doc = await _usage(db_session)
    reader = ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}), privacy=PrivacyMode.INTERNAL,
    )
    seen = analytics_usage_repo.redact_usage(doc, reader)

    assert "health" not in seen and seen["redaction"]["hidden"] == ["operations"]
    beta = next(p for p in seen["workspaces"]["pulse"] if p["workspaceId"] == "ws_b")
    assert beta["name"] == analytics_repo.REDACTED_WORKSPACE and beta["total"] == 5
    rows = {r["workspaceId"]: r for r in seen["workspaces"]["rows"]}
    assert rows["ws_a"]["manualOperations"] is None, "operations are withheld at this posture"
    # The content figures are the same for every reader.
    assert seen["content"] == doc["content"]
    assert "health" in doc, "the cached original is untouched"

    full = ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}), privacy=PrivacyMode.FULL,
    )
    seen_full = analytics_usage_repo.redact_usage(doc, full)
    assert seen_full["health"]["handsOnSources"][0]["name"] == "Ledger"
    assert {r["workspaceId"]: r for r in seen_full["workspaces"]["rows"]}["ws_a"]["manualOperations"] == 3


async def test_the_document_is_a_bounded_number_of_reads(db_session):
    await _seed(db_session)
    issued = []
    original = db_session.execute

    async def _recording(stmt, *a, **kw):
        issued.append(stmt)
        return await original(stmt, *a, **kw)

    db_session.execute = _recording
    try:
        await analytics_usage_repo.platform_usage(db_session, days=365, now=NOW)
    finally:
        db_session.execute = original
    assert len(issued) <= 30, f"{len(issued)} reads"


async def test_the_drill_in_mixes_its_runs_by_origin_and_hides_it_below_full(db_session):
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(db_session, "ws_a", days=7, now=NOW)

    runs = {r["key"]: r["count"] for r in detail["operations"]["runs"]}
    assert runs == {"byHand": 2, "automatic": 1, "onboarding": 1, "other": 0}
    assert detail["operations"]["failed"] == 1

    reader = ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}), privacy=PrivacyMode.INTERNAL,
    )
    assert "operations" not in analytics_repo.redact_workspace_detail(detail, reader)


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
            return await test_client.get("/api/v1/admin/analytics/usage?days=7")
        finally:
            app.dependency_overrides.pop(get_permission_claims, None)

    feature_flags.invalidate()
    try:
        admin = await _get(("system:admin",))
        assert admin.status_code == 200
        assert "content" in admin.json() and "redaction" not in admin.json()
        # Analytics is closed to everyone else until the public flag is on.
        import time as _time
        feature_flags._cache = {"analyticsPublicEnabled": False}
        feature_flags._cache_ts = _time.monotonic()
        assert (await _get(())).status_code == 403
    finally:
        feature_flags.invalidate()
