"""Platform Analytics API — aggregation correctness and the access gate.

The dashboard's whole value is that its numbers are right, so these tests seed
known rows at known timestamps and assert the arithmetic rather than just the
status code.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
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

from backend.app.services import analytics_cache


@pytest.fixture(autouse=True)
def _no_analytics_cache():
    """The summary endpoint memoises per window for 60s, process-wide.

    Without this, a test that seeds data and asserts on it can be served the
    document a previous test built for the same window — the tests would pass
    or fail depending on their order.
    """
    analytics_cache.clear()
    yield
    analytics_cache.clear()


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
        if name in ("buckets", "previous"):
            continue
        assert len(series) == len(buckets), f"{name} is off-axis"

    # The ghost lines sit on the SAME axis. They are the previous period's
    # shape aligned by bucket index, so a 28-vs-31-day month boundary must not
    # let one run off the end.
    for name, series in data["series"]["previous"].items():
        assert len(series) == len(buckets), f"previous.{name} is off-axis"

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


# ── Custom date ranges ──────────────────────────────────────────────

def test_custom_range_treats_both_bounds_as_inclusive():
    """A person picking "1–31 March" means all of the 31st.

    The window's exclusive upper bound must therefore land on 1 April, not on
    midnight opening the 31st — otherwise a whole day silently vanishes.
    """
    w = analytics_repo.build_window(start="2026-03-01", end="2026-03-31")
    assert w.start.startswith("2026-03-01T00:00:00")
    assert w.end.startswith("2026-04-01T00:00:00")
    assert w.days == 31
    # The comparison period is the equal-length run immediately before.
    assert w.previous_start.startswith("2026-01-29T00:00:00")


def test_custom_range_buckets_by_day_and_week_on_the_same_rule():
    assert analytics_repo.build_window(start="2026-03-01", end="2026-03-20").granularity == "day"
    assert analytics_repo.build_window(start="2026-01-01", end="2026-06-30").granularity == "week"


@pytest.mark.parametrize("kwargs", [
    {"start": "2026-03-01"},                        # half a range
    {"end": "2026-03-01"},                          # the other half
    {"start": "not-a-date", "end": "2026-03-01"},   # unparseable
    {"start": "2026-03-31", "end": "2026-03-01"},   # backwards
    {"start": "2020-01-01", "end": "2026-01-01"},   # past the cap
])
def test_invalid_custom_ranges_are_refused(kwargs):
    with pytest.raises(analytics_repo.InvalidWindow):
        analytics_repo.build_window(**kwargs)


async def test_custom_range_and_equivalent_days_agree(db_session):
    """The two ways of asking are the same question, so they must answer alike."""
    await _seed(db_session)
    today = NOW.date()
    by_days = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    by_dates = await analytics_repo.platform_summary(
        db_session,
        start=(today - timedelta(days=6)).isoformat(),
        end=today.isoformat(),
        now=NOW,
    )
    assert by_dates["totals"]["users"]["current"] == by_days["totals"]["users"]["current"]
    assert by_dates["totals"]["views"]["current"] == by_days["totals"]["views"]["current"]


async def test_custom_range_reaches_the_endpoint(test_client, db_session):
    await _seed(db_session)
    today = NOW.date().isoformat()
    ok = await test_client.get(
        f"/api/v1/admin/analytics/summary?from=2026-01-01&to={today}")
    assert ok.status_code == 200
    bad = await test_client.get(
        "/api/v1/admin/analytics/summary?from=2026-03-31&to=2026-03-01")
    assert bad.status_code == 422


# ── Feature adoption & value moments ────────────────────────────────

async def _seed_product_signals(session):
    """Traces, searches and publishes — the events that say someone got value."""
    session.add_all([
        ProductEventORM(id="pev_t1", event_type="lineage.trace", actor_id="usr_old",
                        payload="{}", created_at=_iso(2)),
        ProductEventORM(id="pev_t2", event_type="lineage.trace", actor_id="usr_new1",
                        payload="{}", created_at=_iso(1)),
        ProductEventORM(id="pev_t3", event_type="lineage.trace_empty",
                        actor_id="usr_new1", payload="{}", created_at=_iso(1)),
        ProductEventORM(id="pev_s1", event_type="graph.search", actor_id="usr_old",
                        payload="{}", created_at=_iso(2)),
        ProductEventORM(id="pev_s2", event_type="graph.search_miss",
                        actor_id="usr_old", payload="{}", created_at=_iso(1)),
        ProductEventORM(id="pev_v1", event_type="version.published",
                        actor_id="usr_old", payload="{}", created_at=_iso(1)),
        # Previous window — counts toward the delta, never the current total.
        ProductEventORM(id="pev_t_old", event_type="lineage.trace",
                        actor_id="usr_prev", payload="{}", created_at=_iso(9)),
    ])
    await session.commit()


async def test_adoption_matrix_reports_every_feature(db_session):
    await _seed(db_session)
    await _seed_product_signals(db_session)
    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    rows = {row["key"]: row for row in doc["adoption"]}

    assert set(rows) == {k for k, _l, _t in analytics_repo.FEATURE_EVENTS}
    # Lineage folds both the successful and the empty trace types.
    assert rows["lineage"]["events"] == 3
    assert rows["lineage"]["users"] == 2
    assert rows["lineage"]["previousEvents"] == 1
    # A feature nobody has touched reports zero AND says it has no data yet,
    # so the UI can distinguish "unused" from "unmeasured".
    assert rows["export"]["events"] == 0
    assert rows["export"]["since"] is None
    assert rows["lineage"]["since"] is not None


async def test_value_moments_separate_answered_from_unanswered(db_session):
    """The whole reason ``_empty``/``_miss`` are their own event types."""
    await _seed(db_session)
    await _seed_product_signals(db_session)
    value = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["valueMoments"]

    assert value["traces"] == 3                    # 2 answered + 1 empty
    assert value["tracesEmpty"] == 1
    assert value["traceSuccessRate"] == round(2 / 3, 3)
    assert value["searches"] == 2
    assert value["searchMisses"] == 1
    assert value["searchHitRate"] == 0.5


async def test_value_moment_rates_are_none_without_a_basis(db_session):
    """No traces at all is not a 0% success rate — it is no answer."""
    await _seed(db_session)
    value = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["valueMoments"]
    assert value["traces"] == 0
    assert value["traceSuccessRate"] is None


async def test_funnel_scores_activation_on_tracing(db_session):
    """Activation is reaching the value moment, not authoring content."""
    await _seed(db_session)
    await _seed_product_signals(db_session)
    engagement = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["engagement"]

    stages = [s["stage"] for s in engagement["funnel"]]
    assert stages == [
        "Signed up", "Became active", "Opened a view",
        "Traced lineage", "Created a view",
    ]
    # usr_new1 signed up in-window AND traced; usr_new2 did neither.
    traced = next(s for s in engagement["funnel"] if s["stage"] == "Traced lineage")
    assert traced["count"] == 1
    assert engagement["activationRate"] == round(1 / 2, 3)
    # Authoring survives as its own number rather than being overwritten.
    assert engagement["creationRate"] == round(1 / 2, 3)


# ── Platform health ─────────────────────────────────────────────────

async def test_reliability_counts_failures_and_untouched_sources(db_session):
    from backend.app.db.models import ProviderORM, RefreshEventORM, WorkspaceDataSourceORM

    await _seed(db_session)
    db_session.add(ProviderORM(id="prov_1", name="P", provider_type="falkordb"))
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_live", provider_id="prov_1",
                               created_at=_iso(20)),
        WorkspaceDataSourceORM(id="ds_2", workspace_id="ws_live", provider_id="prov_1",
                               created_at=_iso(20)),
    ])
    db_session.add_all([
        RefreshEventORM(id="rf_1", ts=_iso(2), data_source_id="ds_1",
                        origin="api", scope="full", gate="changed", outcome="completed"),
        RefreshEventORM(id="rf_2", ts=_iso(1), data_source_id="ds_1",
                        origin="api", scope="full", gate="changed", outcome="failed"),
        # Outside the window — must not colour the current success rate.
        RefreshEventORM(id="rf_old", ts=_iso(30), data_source_id="ds_2",
                        origin="api", scope="full", gate="changed", outcome="failed"),
    ])
    await db_session.commit()

    health = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["health"]["reliability"]
    assert health["refreshes"] == 2
    assert health["failures"] == 1
    assert health["successRate"] == 0.5
    assert health["sourcesRefreshed"] == 1
    assert health["sourcesUntouched"] == 1        # ds_2 saw nothing this window


async def test_access_friction_measures_the_wait(db_session):
    from backend.app.db.models import AccessRequestORM, InviteORM, InviteRedemptionORM

    await _seed(db_session)
    db_session.add_all([
        AccessRequestORM(id="req_1", requester_id="usr_new1", target_type="workspace",
                         target_id="ws_live", requested_role="workspace_viewer",
                         status="approved", created_at=_iso(3), resolved_at=_iso(1)),
        AccessRequestORM(id="req_2", requester_id="usr_new2", target_type="workspace",
                         target_id="ws_live", requested_role="workspace_viewer",
                         status="pending", created_at=_iso(5)),
    ])
    db_session.add_all([
        InviteORM(id="inv_1", email="a@x.io", role="user",
                  created_by="usr_old", created_at=_iso(3), expires_at=_iso(-7)),
        InviteORM(id="inv_2", email="b@x.io", role="user",
                  created_by="usr_old", created_at=_iso(2), expires_at=_iso(-7)),
    ])
    db_session.add(InviteRedemptionORM(
        id="ivr_1", invite_id="inv_1", user_id="usr_new1", email="a@x.io",
        redeemed_at=_iso(1)))
    await db_session.commit()

    access = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["health"]["access"]
    assert access["requests"] == 2
    assert access["pending"] == 1
    assert access["medianHoursToApprove"] == 48.0     # 3 days ago → 1 day ago
    assert access["oldestPendingDays"] == 5.0
    assert access["invitesSent"] == 2
    assert access["invitesRedeemed"] == 1
    assert access["acceptanceRate"] == 0.5


async def test_semantic_coverage_counts_assigned_sources(db_session):
    from backend.app.db.models import OntologyORM, ProviderORM, WorkspaceDataSourceORM

    await _seed(db_session)
    db_session.add(ProviderORM(id="prov_1", name="P", provider_type="falkordb"))
    db_session.add(OntologyORM(id="ont_1", name="O", version=1))
    db_session.add_all([
        WorkspaceDataSourceORM(id="ds_1", workspace_id="ws_live", provider_id="prov_1",
                               ontology_id="ont_1", created_at=_iso(20)),
        WorkspaceDataSourceORM(id="ds_2", workspace_id="ws_live", provider_id="prov_1",
                               created_at=_iso(20)),
    ])
    await db_session.commit()

    semantic = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["health"]["semanticLayer"]
    assert semantic["sourcesWithOntology"] == 1
    assert semantic["sourcesTotal"] == 2
    assert semantic["coverage"] == 0.5


async def test_announcements_become_timeline_annotations(db_session):
    from backend.app.db.models import AnnouncementORM

    await _seed(db_session)
    db_session.add_all([
        AnnouncementORM(id="ann_1", title="v2.1 shipped", message="m",
                        created_at=_iso(2)),
        # Before the window — no bucket to attach to, so it is dropped.
        AnnouncementORM(id="ann_old", title="ancient", message="m",
                        created_at=_iso(60)),
    ])
    await db_session.commit()

    annotations = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["annotations"]
    assert [a["title"] for a in annotations] == ["v2.1 shipped"]
    # Anchored to a real bucket on the shared x-axis, so it can be drawn.
    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    assert annotations[0]["bucket"] in doc["series"]["buckets"]


# ── Narrative insights ──────────────────────────────────────────────

async def test_insights_stay_silent_without_a_basis(db_session):
    """A young install gets no observations, not five invented ones.

    A strip that manufactures findings from three users teaches people to
    ignore it, which costs more than showing nothing.
    """
    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    assert doc["insights"] == []


async def test_insights_name_the_biggest_problem_first(db_session):
    """Ranked by significance: empty traces outrank a signup wobble."""
    await _seed(db_session)
    db_session.add_all([
        ProductEventORM(id=f"pev_te{i}", event_type="lineage.trace_empty",
                        actor_id="usr_old", payload="{}", created_at=_iso(1))
        for i in range(8)
    ] + [
        ProductEventORM(id="pev_tok", event_type="lineage.trace",
                        actor_id="usr_old", payload="{}", created_at=_iso(1)),
    ])
    await db_session.commit()

    insights = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["insights"]
    keys = [i["key"] for i in insights]
    assert "trace-empty" in keys
    assert keys[0] == "trace-empty", f"expected the worst finding first, got {keys}"

    finding = insights[0]
    assert finding["tone"] == "bad"
    assert "89%" in finding["headline"]            # 8 of 9 came back empty
    assert finding["tab"] == "engagement"          # clicking it goes somewhere


async def test_insights_are_capped_and_carry_no_internal_score(db_session):
    await _seed(db_session)
    await _seed_product_signals(db_session)
    insights = (await analytics_repo.platform_summary(
        db_session, days=7, now=NOW))["insights"]
    assert len(insights) <= analytics_repo._MAX_INSIGHTS
    assert all("_score" not in i for i in insights)
    assert all(set(i) == {"key", "tone", "headline", "detail", "tab"} for i in insights)


async def test_insights_agree_with_the_charts_beneath_them(db_session):
    """The rules read the finished document, so they cannot contradict it."""
    await _seed(db_session)
    db_session.add_all([
        ProductEventORM(id=f"pev_sm{i}", event_type="graph.search_miss",
                        actor_id="usr_old", payload="{}", created_at=_iso(1))
        for i in range(6)
    ])
    await db_session.commit()

    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    miss = next(i for i in doc["insights"] if i["key"] == "search-miss")
    assert str(doc["valueMoments"]["searchMisses"]) in miss["detail"]
    assert str(doc["valueMoments"]["searches"]) in miss["detail"]


# ── Caching & retention ─────────────────────────────────────────────

async def test_summary_is_computed_once_per_window(db_session, monkeypatch):
    """The document is ~25 aggregate queries; a tab switch must not repay them."""
    from backend.app.services import analytics_cache

    calls = {"n": 0}

    async def _build():
        calls["n"] += 1
        return {"marker": calls["n"]}

    first = await analytics_cache.cached("summary:d30", _build)
    second = await analytics_cache.cached("summary:d30", _build)
    assert first == second == {"marker": 1}
    assert calls["n"] == 1

    # A different window is a different key, and does get computed.
    await analytics_cache.cached("summary:d7", _build)
    assert calls["n"] == 2


async def test_cache_does_not_store_a_missing_workspace(db_session):
    """A ``None`` document can never be served, so storing it would only grow
    memory for anyone walking random workspace ids."""
    from backend.app.services import analytics_cache

    calls = {"n": 0}

    async def _missing():
        calls["n"] += 1
        return None

    assert await analytics_cache.cached("ws:nope:d30", _missing) is None
    assert await analytics_cache.cached("ws:nope:d30", _missing) is None
    assert calls["n"] == 2
    assert "ws:nope:d30" not in analytics_cache._memory


async def test_retention_sweep_keeps_the_analytics_window(db_session):
    from backend.app.db.repositories import product_event_repo
    from backend.app.services import product_event_gc

    db_session.add_all([
        ProductEventORM(id="pev_recent", event_type="view.opened",
                        actor_id="usr_old", payload="{}", created_at=_iso(30)),
        ProductEventORM(id="pev_edge", event_type="view.opened",
                        actor_id="usr_old", payload="{}", created_at=_iso(364)),
        ProductEventORM(id="pev_ancient", event_type="view.opened",
                        actor_id="usr_old", payload="{}", created_at=_iso(500)),
    ])
    await db_session.commit()

    # Pinned to the suite's NOW: the sweep is wall-clock by default, and a
    # fixture dated relative to NOW would drift out of retention as the real
    # date moves past it.
    deleted = await product_event_repo.purge_older_than(
        db_session, days=400, now=NOW)
    await db_session.commit()
    assert deleted == 1

    surviving = {
        row for (row,) in (await db_session.execute(
            select(ProductEventORM.id))).all()
    }
    # Everything a 365-day chart could ask for is still there.
    assert {"pev_recent", "pev_edge"} <= surviving
    assert "pev_ancient" not in surviving


def test_retention_never_drops_below_the_analytics_ceiling(monkeypatch):
    """A misconfigured horizon must not make a year-long chart lie."""
    from backend.app.services import product_event_gc

    monkeypatch.setenv("PRODUCT_EVENT_RETENTION_DAYS", "30")
    assert product_event_gc.retention_days() == 365

    monkeypatch.setenv("PRODUCT_EVENT_RETENTION_DAYS", "900")
    assert product_event_gc.retention_days() == 900

    monkeypatch.setenv("PRODUCT_EVENT_RETENTION_DAYS", "banana")
    assert product_event_gc.retention_days() == 400


async def test_ghost_series_measure_the_previous_period(db_session):
    """The delta says a number moved; the ghost says what shape the move was."""
    await _seed(db_session)
    data = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    ghost = data["series"]["previous"]
    assert set(ghost) == {"signups", "viewsCreated", "viewOpens", "activeUsers"}
    # usr_prev signed up 10 days ago — inside the previous 7-day window, and
    # deliberately outside the current one.
    assert sum(ghost["signups"]) == 1
    assert sum(data["series"]["signups"]) == 2
    # pev_old is the single open recorded in the previous window.
    assert sum(ghost["viewOpens"]) == 1


async def test_previous_window_is_equal_length_and_adjacent():
    w = analytics_repo.build_window(days=30)
    prev = analytics_repo.previous_window(w)
    # Ends the day before the current window opens — no gap, no overlap.
    assert prev.end[:10] == w.start[:10]
    assert prev.days == 30
