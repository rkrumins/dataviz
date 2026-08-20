"""Platform Analytics API — aggregation correctness and the access gate.

The dashboard's whole value is that its numbers are right, so these tests seed
known rows at known timestamps and assert the arithmetic rather than just the
status code.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from fastapi import HTTPException

from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import (
    ProductEventORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    ViewVisitORM,
    WorkspaceORM,
)
from backend.app.db.repositories import analytics_repo
from backend.app.main import app
from backend.app.services.permission_service import PermissionClaims

SUMMARY = "/api/v1/admin/analytics/summary"
WORKSPACES = "/api/v1/admin/analytics/workspaces"

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


def _iso(days_ago: float) -> str:
    return (NOW - timedelta(days=days_ago)).isoformat()


async def _seed(session):
    """Two workspaces, four users, five views, and a spread of activity.

    Timestamps straddle the 7-day boundary on purpose so window filtering and
    previous-window deltas both have something to get wrong.
    """
    session.add_all([
        WorkspaceORM(id="ws_live", name="Live", created_at=_iso(40)),
        WorkspaceORM(id="ws_quiet", name="Quiet", created_at=_iso(3)),
        WorkspaceORM(id="ws_gone", name="Deleted", created_at=_iso(5),
                     deleted_at=_iso(1)),
    ])
    session.add_all([
        UserORM(id="usr_old", email="old@x.io", password_hash="x", first_name="Old",
                last_name="Hand", status="active", created_at=_iso(100)),
        UserORM(id="usr_new1", email="n1@x.io", password_hash="x", first_name="New",
                last_name="One", status="active", created_at=_iso(2)),
        UserORM(id="usr_new2", email="n2@x.io", password_hash="x", first_name="New",
                last_name="Two", status="pending", created_at=_iso(4),
                signup_source="invite"),
        # Signed up inside the PREVIOUS 7-day window, not the current one.
        UserORM(id="usr_prev", email="p@x.io", password_hash="x", first_name="Prev",
                last_name="Window", status="active", created_at=_iso(10)),
        UserORM(id="usr_gone", email="g@x.io", password_hash="x", first_name="Soft",
                last_name="Deleted", status="active", created_at=_iso(3),
                deleted_at=_iso(1)),
    ])
    session.add_all([
        ViewORM(id="view_a", name="Alpha", workspace_id="ws_live",
                created_by="usr_old", created_at=_iso(30), visibility="enterprise"),
        ViewORM(id="view_b", name="Beta", workspace_id="ws_live",
                created_by="usr_new1", created_at=_iso(2), visibility="private"),
        ViewORM(id="view_c", name="Gamma", workspace_id="ws_quiet",
                created_by="usr_old", created_at=_iso(1), visibility="workspace"),
        ViewORM(id="view_old", name="Delta", workspace_id="ws_live",
                created_by="usr_old", created_at=_iso(9), visibility="private"),
        ViewORM(id="view_dead", name="Trashed", workspace_id="ws_live",
                created_by="usr_old", created_at=_iso(2), deleted_at=_iso(1)),
    ])
    session.add_all([
        ViewActivityLogORM(id="val_1", view_id="view_a", workspace_id="ws_live",
                           action="updated", actor="usr_old", created_at=_iso(2)),
        ViewActivityLogORM(id="val_2", view_id="view_b", workspace_id="ws_live",
                           action="created", actor="usr_new1", created_at=_iso(2)),
        ViewActivityLogORM(id="val_3", view_id="view_a", workspace_id="ws_live",
                           action="shared", actor="usr_old", created_at=_iso(1)),
        # Previous window — must not count toward the current one.
        ViewActivityLogORM(id="val_old", view_id="view_old", workspace_id="ws_live",
                           action="updated", actor="usr_prev", created_at=_iso(9)),
    ])
    session.add_all([
        ProductEventORM(id="pev_1", event_type="view.opened", actor_id="usr_old",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(2)),
        ProductEventORM(id="pev_2", event_type="view.opened", actor_id="usr_new1",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(1)),
        ProductEventORM(id="pev_3", event_type="view.opened", actor_id="usr_new1",
                        payload=json.dumps({"viewId": "view_c"}), created_at=_iso(1)),
        ProductEventORM(id="pev_old", event_type="view.opened", actor_id="usr_prev",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(9)),
        # A different signal entirely — must never be counted as an open.
        ProductEventORM(id="pev_docs", event_type="docs.feedback", actor_id="usr_old",
                        payload=json.dumps({"vote": "yes"}), created_at=_iso(1)),
    ])
    session.add_all([
        ViewVisitORM(id="vis_1", view_id="view_a", user_id="usr_old", visited_at=_iso(2)),
        ViewVisitORM(id="vis_2", view_id="view_a", user_id="usr_new1", visited_at=_iso(1)),
    ])
    await session.commit()


# ── Aggregation ─────────────────────────────────────────────────────

async def test_summary_counts_only_the_window(db_session):
    await _seed(db_session)
    data = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    totals = data["totals"]
    # 2 signups inside 7 days (usr_new1, usr_new2). usr_prev is 10 days old and
    # usr_gone is soft-deleted; neither counts.
    assert totals["users"]["current"] == 2
    assert totals["users"]["total"] == 4
    # The previous 7-day window holds exactly usr_prev.
    assert totals["users"]["previous"] == 1
    assert totals["users"]["changePct"] == 100.0

    # 3 opens in-window; the 9-day-old one and the docs.feedback row are excluded.
    assert totals["viewOpens"]["current"] == 3
    assert totals["viewOpens"]["previous"] == 1

    # view_b + view_c created in-window; view_dead is soft-deleted.
    assert totals["views"]["current"] == 2
    assert totals["views"]["total"] == 4

    assert totals["workspaces"]["total"] == 2  # ws_gone is soft-deleted


async def test_series_align_to_one_bucket_axis(db_session):
    await _seed(db_session)
    data = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    buckets = data["series"]["buckets"]
    assert data["bucket"] == "day"
    # Every series shares the x-axis — charts on one page must not disagree.
    for name, series in data["series"].items():
        if name == "buckets":
            continue
        assert len(series) == len(buckets), f"{name} is off-axis"

    assert sum(data["series"]["signups"]) == 2
    assert sum(data["series"]["viewOpens"]) == 3
    # Cumulative starts from everything that existed before the window opened.
    assert data["series"]["cumulativeUsers"][-1] == 4


async def test_long_windows_bucket_by_week(db_session):
    await _seed(db_session)
    data = await analytics_repo.platform_summary(db_session, days=90, now=NOW)
    assert data["bucket"] == "week"
    assert len(data["series"]["buckets"]) == 13
    assert len(data["series"]["signups"]) == 13


async def test_leaderboards_rank_and_resolve_names(db_session):
    await _seed(db_session)
    data = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    top_views = {v["viewId"]: v for v in data["leaderboards"]["topViews"]}
    assert top_views["view_a"]["opens"] == 2
    assert top_views["view_a"]["uniqueViewers"] == 2
    assert top_views["view_c"]["opens"] == 1

    top_users = {u["userId"]: u for u in data["leaderboards"]["topUsers"]}
    # Names come from a by-ID resolve, never a cross-domain JOIN.
    assert top_users["usr_old"]["name"] == "Old Hand"
    assert top_users["usr_old"]["email"] == "old@x.io"

    top_ws = {w["workspaceId"]: w for w in data["leaderboards"]["topWorkspaces"]}
    assert top_ws["ws_live"]["activity"] == 3
    assert top_ws["ws_live"]["opens"] == 2
    assert top_ws["ws_quiet"]["opens"] == 1


async def test_engagement_funnel_uses_the_window_cohort(db_session):
    await _seed(db_session)
    engagement = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["engagement"]

    stages = {s["stage"]: s for s in engagement["funnel"]}
    # Cohort = accounts created in-window: usr_new1 and usr_new2.
    assert stages["Signed up"]["count"] == 2
    # Only usr_new1 did anything.
    assert stages["Became active"]["count"] == 1
    assert stages["Created a view"]["count"] == 1
    assert stages["Created a view"]["rate"] == 0.5
    assert engagement["mau"] >= 2


async def test_empty_database_returns_zeros_not_an_error(db_session):
    data = await analytics_repo.platform_summary(db_session, days=30, now=NOW)
    assert data["totals"]["users"]["total"] == 0
    assert data["totals"]["users"]["changePct"] is None  # no base — not "+100%"
    assert data["engagement"]["stickiness"] is None
    assert data["leaderboards"]["topViews"] == []
    assert sum(data["series"]["signups"]) == 0


async def test_workspace_rows_flag_dormancy(db_session):
    await _seed(db_session)
    rows = {r["workspaceId"]: r for r in
            await analytics_repo.workspace_rows(db_session, days=7, now=NOW)}

    assert "ws_gone" not in rows  # soft-deleted
    assert rows["ws_live"]["views"] == 3  # view_dead excluded
    assert rows["ws_live"]["newViews"] == 1
    assert rows["ws_live"]["activity"] == 3
    assert rows["ws_live"]["dormant"] is False
    # ws_quiet has an open but no activity rows — still not dormant.
    assert rows["ws_quiet"]["dormant"] is False


async def test_workspace_detail_scopes_to_one_workspace(db_session):
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(
        db_session, "ws_live", days=7, now=NOW)

    assert detail["name"] == "Live"
    assert detail["totals"]["views"]["total"] == 3
    assert detail["totals"]["viewOpens"]["total"] == 2  # view_c's open is elsewhere
    assert detail["totals"]["activity"]["current"] == 3
    assert {v["viewId"] for v in detail["topViews"]} == {"view_a"}
    assert detail["topContributors"][0]["userId"] == "usr_old"

    assert await analytics_repo.workspace_detail(
        db_session, "ws_nope", days=7, now=NOW) is None


async def test_view_open_events_are_recorded_on_visit(db_session):
    """The write path analytics depends on — a visit appends an immutable open."""
    from backend.app.db.repositories import view_repo
    from sqlalchemy import select

    await _seed(db_session)
    await view_repo.record_view_visit(db_session, "view_b", "usr_new1")
    await db_session.commit()

    rows = (await db_session.execute(
        select(ProductEventORM).where(ProductEventORM.event_type == "view.opened")
    )).scalars().all()
    fresh = [r for r in rows if r.id not in {"pev_1", "pev_2", "pev_3", "pev_old"}]
    assert len(fresh) == 1
    assert json.loads(fresh[0].payload)["viewId"] == "view_b"
    assert fresh[0].actor_id == "usr_new1"

    # Anonymous opens stay unattributed and unrecorded.
    await view_repo.record_view_visit(db_session, "view_b", "anonymous")
    await db_session.commit()
    after = (await db_session.execute(
        select(ProductEventORM).where(ProductEventORM.event_type == "view.opened")
    )).scalars().all()
    assert len(after) == len(rows)


# ── HTTP contract & access gate ─────────────────────────────────────

async def test_endpoints_serve_the_admin_client(test_client, db_session):
    await _seed(db_session)

    r = await test_client.get(f"{SUMMARY}?days=7")
    assert r.status_code == 200
    assert r.json()["windowDays"] == 7

    r = await test_client.get(f"{WORKSPACES}?days=30")
    assert r.status_code == 200
    assert {row["name"] for row in r.json()} == {"Live", "Quiet"}

    r = await test_client.get(f"{WORKSPACES}/ws_live?days=30")
    assert r.status_code == 200 and r.json()["name"] == "Live"

    assert (await test_client.get(f"{WORKSPACES}/ws_missing")).status_code == 404
    # Window is bounded — no unbounded scans on request.
    assert (await test_client.get(f"{SUMMARY}?days=9999")).status_code == 422


@pytest.mark.parametrize(
    "perms,expected",
    [
        (("system:audit:read",), 200),   # org_auditor
        (("system:org-admin",), 200),    # org_admin — cross-workspace operator
        (("system:admin",), 200),        # implies everything
        (("workspace:view:read",), 403), # an ordinary member
    ],
)
async def test_either_permission_opens_the_section(test_client, perms, expected):
    def _claims():
        return PermissionClaims(sid="sess_test", global_perms=perms, ws_perms={})

    app.dependency_overrides[get_permission_claims] = _claims
    try:
        assert (await test_client.get(SUMMARY)).status_code == expected
    finally:
        app.dependency_overrides.pop(get_permission_claims, None)


async def test_telemetry_summary_ignores_view_opens(db_session):
    """The docs/tour rollup must not be moved by the new high-volume event.

    ``product_event_repo.summary`` used to scan the whole window because every
    row was a deliberate product signal. ``view.opened`` breaks that premise, so
    the query now filters by type — this pins the behaviour that filter protects.
    """
    from backend.app.db.repositories import product_event_repo

    session = db_session
    session.add_all([
        ProductEventORM(id="pe_yes", event_type="docs.feedback", actor_id="usr_old",
                        payload=json.dumps({"vote": "yes", "pageKey": "docs:intro"}),
                        created_at=_iso(1)),
        ProductEventORM(id="pe_no", event_type="docs.feedback", actor_id="usr_new1",
                        payload=json.dumps({"vote": "no", "pageKey": "docs:intro"}),
                        created_at=_iso(1)),
        ProductEventORM(id="pe_tour", event_type="tour.completed", actor_id="usr_old",
                        payload=json.dumps({"tourId": "ingestion"}), created_at=_iso(1)),
    ])
    # Ten times as many opens as real signals — the shape the filter exists for.
    session.add_all([
        ProductEventORM(id=f"pe_open_{i}", event_type="view.opened", actor_id="usr_old",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(1))
        for i in range(10)
    ])
    await session.commit()

    data = await product_event_repo.summary(session, since_iso=_iso(7))
    assert data["helpful"] == {
        "yes": 1, "no": 1, "total": 2, "score": 0.5,
        "byPage": [{"page": "docs:intro", "yes": 1, "no": 1}],
    }
    assert data["tours"]["completed"] == 1
    # Was 13 before the filter — the opens would have swamped the panel's
    # "events total" and been scanned only to be discarded.
    assert data["totalEvents"] == 3
