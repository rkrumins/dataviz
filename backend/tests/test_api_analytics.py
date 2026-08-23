"""Platform Analytics API — aggregation correctness and the access gate.

The dashboard's whole value is that its numbers are right, so these tests seed
known rows at known timestamps and assert the arithmetic rather than just the
status code.
"""
from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone

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
        # `subject_id` mirrors what `view_repo.record_view_visit` writes — it
        # is the column analytics groups on, so a fixture that omitted it would
        # be testing an empty table.
        ProductEventORM(id="pev_1", event_type="view.opened", actor_id="usr_old",
                        subject_id="view_a",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(2)),
        ProductEventORM(id="pev_2", event_type="view.opened", actor_id="usr_new1",
                        subject_id="view_a",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(1)),
        ProductEventORM(id="pev_3", event_type="view.opened", actor_id="usr_new1",
                        subject_id="view_c",
                        payload=json.dumps({"viewId": "view_c"}), created_at=_iso(1)),
        ProductEventORM(id="pev_old", event_type="view.opened", actor_id="usr_prev",
                        subject_id="view_a",
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
                        subject_id="view_a",
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
    assert set(ghost) == {
        "buckets", "signups", "viewsCreated", "viewOpens", "activeUsers"}
    # usr_prev signed up 10 days ago — inside the previous 7-day window, and
    # deliberately outside the current one.
    assert sum(ghost["signups"]) == 1
    assert sum(data["series"]["signups"]) == 2
    # pev_old is the single open recorded in the previous window.
    assert sum(ghost["viewOpens"]) == 1


async def test_the_ghost_carries_the_dates_it_actually_happened_on(db_session):
    """Without them a client can only lay the ghost out by INDEX, against an
    axis labelled with the CURRENT window's dates — so a bar for the 4th of
    July gets drawn sitting on the 3rd of August and the axis lies about it."""
    await _seed(db_session)
    data = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    buckets = data["series"]["buckets"]
    ghost = data["series"]["previous"]["buckets"]

    # One date per value, so every mark has somewhere to sit.
    assert len(ghost) == len(buckets)
    for key in ("signups", "viewsCreated", "viewOpens", "activeUsers"):
        assert len(data["series"]["previous"][key]) == len(ghost)

    # Ascending, and ending immediately before the current window opens: the
    # two lists laid end to end are one unbroken run of days.
    assert ghost == sorted(ghost)
    assert ghost[-1] < buckets[0]
    combined = ghost + buckets
    for earlier, later in zip(combined, combined[1:]):
        gap = date.fromisoformat(later) - date.fromisoformat(earlier)
        assert gap == timedelta(days=1)


async def test_previous_window_is_equal_length_and_adjacent():
    w = analytics_repo.build_window(days=30)
    prev = analytics_repo.previous_window(w)
    # Ends the day before the current window opens — no gap, no overlap.
    assert prev.end[:10] == w.start[:10]
    assert prev.days == 30


# ── Public tier & redaction ─────────────────────────────────────────
#
# Everything here is a disclosure test. A failure means somebody can see
# something they should not, which is the one class of bug in this file that
# cannot be fixed after the fact.

from backend.app.services.analytics_scope import ViewerScope


def _public(*workspace_ids: str, known: bool = True) -> ViewerScope:
    return ViewerScope(
        privileged=False,
        visible_workspaces=frozenset(workspace_ids),
        workspaces_known=known,
    )


_PRIVILEGED = ViewerScope(privileged=True, visible_workspaces=frozenset())


async def test_public_tier_shows_no_individual_activity(db_session):
    """No leaderboards, no names, no emails — not even for colleagues."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public("ws_live"))

    assert doc["leaderboards"]["topUsers"] == []
    assert doc["leaderboards"]["topCreators"] == []
    # And nothing anywhere in the document carries an address.
    assert "@x.io" not in json.dumps(doc)


async def test_privileged_tier_is_unredacted(db_session):
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_PRIVILEGED)

    assert doc["leaderboards"]["topUsers"], "admins keep the people leaderboard"
    assert "redaction" not in doc
    assert "access" in doc["health"]


async def test_restricted_workspaces_are_locked_not_removed(db_session):
    """The row survives so the table agrees with the totals above it."""
    await _seed(db_session)
    rows = await analytics_repo.workspace_rows(
        db_session, days=7, now=NOW, scope=_public("ws_live"))

    by_id = {r["workspaceId"]: r for r in rows}
    assert set(by_id) == {"ws_live", "ws_quiet"}, "no workspace disappears"

    mine = by_id["ws_live"]
    assert mine["redacted"] is False
    assert mine["name"] == "Live"
    assert mine["views"] is not None

    theirs = by_id["ws_quiet"]
    assert theirs["redacted"] is True
    assert theirs["name"] == analytics_repo.REDACTED_WORKSPACE
    # Every specific is gone, not zeroed — zero is a claim, null is a refusal.
    for field in ("members", "views", "dataSources", "activity", "opens",
                  "activeUsers", "nodes", "edges", "lastActivityAt"):
        assert theirs[field] is None, f"{field} leaked"


async def test_totals_still_count_workspaces_you_cannot_open(db_session):
    """Aggregates cover the platform, or two people read different totals off
    the same page and both believe it."""
    await _seed(db_session)
    everything = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_PRIVILEGED)
    restricted = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public())   # member of nothing

    for key in ("users", "workspaces", "views", "viewOpens"):
        assert restricted["totals"][key] == everything["totals"][key], key
    assert restricted["series"] == everything["series"]


async def test_operational_health_is_privileged_only(db_session):
    """Who is waiting for access, and where the data is unreliable."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public("ws_live"))

    assert "access" not in doc["health"]
    assert "reliability" not in doc["health"]
    # Semantic-layer coverage is a platform fact, not an operational one.
    assert "semanticLayer" in doc["health"]


async def test_insights_quoting_hidden_data_are_withheld(db_session):
    """A rule is public only if its TEXT comes from public aggregates."""
    await _seed(db_session)
    db_session.add_all([
        ProductEventORM(id=f"pev_pe{i}", event_type="lineage.trace_empty",
                        actor_id="usr_old", payload="{}", created_at=_iso(1))
        for i in range(8)
    ])
    await db_session.commit()

    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public("ws_live"))
    keys = {i["key"] for i in doc["insights"]}
    # Derived from platform-wide event counts — safe.
    assert "trace-empty" in keys
    # Nothing outside the allow-list survives, so a rule added later is hidden
    # until somebody has looked at what it says.
    assert keys <= analytics_repo._PUBLIC_INSIGHTS


async def test_redaction_notice_says_what_was_withheld(db_session):
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public("ws_live"))

    notice = doc["redaction"]
    assert notice["applied"] is True
    assert notice["visibleWorkspaces"] == 1
    assert notice["accessResolved"] is True
    assert notice["hidden"], "the UI needs something to show"


async def test_unresolved_access_is_flagged_not_guessed(db_session):
    """An empty workspace map we could not populate is not 'no access'."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public(known=False))
    assert doc["redaction"]["accessResolved"] is False


async def test_drilling_into_a_workspace_you_are_not_in_is_refused(db_session):
    await _seed(db_session)
    with pytest.raises(analytics_repo.WorkspaceForbidden):
        await analytics_repo.workspace_detail(
            db_session, "ws_quiet", days=7, now=NOW, scope=_public("ws_live"))

    # The one they belong to still opens.
    mine = await analytics_repo.workspace_detail(
        db_session, "ws_live", days=7, now=NOW, scope=_public("ws_live"))
    assert mine is not None and mine["name"] == "Live"


def test_every_insight_rule_is_classified_for_an_audience():
    """A new rule must be given an audience, or it reaches almost nobody.

    `redact_summary` filters the strip through three allow-lists and drops
    anything unlisted. Failing closed is right — an unreviewed rule should not
    reach a public tier by default — but it is SILENT: the rule fires, the key
    is dropped, and every non-privileged reader simply never sees it while
    nothing errors and no test goes red. That is what happened to
    `views-not-opened`, which shipped invisible to everyone except an admin.

    Scans the source rather than running the rules, so a rule that needs a rare
    document to fire is still checked. Both call shapes are covered: the
    literal `_insight("key", ...)` and the key passed through `_swing`. A third
    kind of indirection would slip past this — if you add one, extend the scan.
    """
    import re
    from pathlib import Path

    src = Path(analytics_repo.__file__).read_text()
    literal = set(re.findall(r'_insight\(\s*\n?\s*"([a-z0-9-]+)"', src))
    via_swing = set(re.findall(r'_swing\([^,]+,\s*"([a-z0-9-]+)"', src))
    emitted = literal | via_swing
    assert len(emitted) >= 13, f"the scan stopped finding rules: {sorted(emitted)}"

    classified = (
        analytics_repo._PUBLIC_INSIGHTS
        | analytics_repo._PEOPLE_INSIGHTS
        | analytics_repo._OPERATIONS_INSIGHTS
    )
    assert not (emitted - classified), (
        "these rules reach only privileged readers because nothing classified "
        f"them: {sorted(emitted - classified)}"
    )
    assert not (classified - emitted), (
        f"allow-listed keys no rule emits: {sorted(classified - emitted)}"
    )


async def test_the_catalogue_insight_reaches_a_public_reader(db_session):
    """It names no person and no workspace, so it belongs to everyone."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_public("ws_live"))
    keys = {i["key"] for i in doc["insights"]}
    # The rule only fires past half the catalogue; what is under test is that
    # the redactor would not strip it if it did.
    assert "views-not-opened" in analytics_repo._PUBLIC_INSIGHTS
    assert keys <= analytics_repo._PUBLIC_INSIGHTS, (
        f"a strict reader was shown a non-public insight: "
        f"{sorted(keys - analytics_repo._PUBLIC_INSIGHTS)}"
    )




# ── Contact details ─────────────────────────────────────────────────
# `analyticsShowEmailAddresses`. The capability is real — a view's creator has
# always been a mailto: link in the Explorer drawer, ungated — but it is
# scoped: a person attached to a thing the reader can open, never the
# platform-wide activity ranking.

def _contact(**kw) -> ViewerScope:
    """A non-privileged reader with contact turned on."""
    kw.setdefault("privacy", PrivacyMode.INTERNAL)
    kw.setdefault("contact_enabled", True)
    return _scope(**kw)


async def test_contact_is_off_until_an_operator_turns_it_on(db_session):
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_scope(privacy=PrivacyMode.INTERNAL, visible_workspaces=frozenset({"ws_live"})),
    )
    assert "@x.io" not in json.dumps(doc)


async def test_a_view_creator_becomes_reachable(db_session):
    """The anchored case: the person is attached to a view in front of the
    reader, which is the shape Explorer has always shown for the same view."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_contact(visible_workspaces=frozenset({"ws_live"})),
    )
    alpha = next(v for v in doc["leaderboards"]["topViews"] if v["viewId"] == "view_a")
    assert alpha["createdByEmail"] == "old@x.io"
    assert alpha["createdByName"]
    # The id is still never returned — that is individual activity.
    assert "createdBy" not in alpha


async def test_a_view_you_cannot_see_names_nobody(db_session):
    """Contact rides on seeing the view, not on the flag. A redacted row must
    not become a way to learn who built something you may not look at."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_contact(visible_workspaces=frozenset()),   # member of nothing
    )
    for row in doc["leaderboards"]["topViews"]:
        if row.get("redacted"):
            assert "createdByEmail" not in row and "createdByName" not in row


async def test_the_platform_ranking_never_carries_addresses(db_session):
    """The line the setting deliberately does not cross.

    "Most active people" is a ranked list of accounts across the whole tenancy
    with no anchoring object. Addresses there would make it a harvestable,
    activity-ordered directory — which is not the contact use case, because
    anyone wanting to reach a colleague found them through something they
    built.
    """
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_contact(visible_workspaces=frozenset({"ws_live"})),
    )
    boards = doc["leaderboards"]
    assert boards["topUsers"], "the ranking should still be populated"
    assert all(u["email"] is None for u in boards["topUsers"])
    assert all("email" not in c for c in boards["topCreators"])


async def test_contact_cannot_read_past_the_privacy_level(db_session):
    """An address beside a name that is itself withheld would be incoherent —
    and a way to use this flag to defeat `strict`."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_contact(privacy=PrivacyMode.STRICT,
                       visible_workspaces=frozenset({"ws_live"})),
    )
    assert "@x.io" not in json.dumps(doc)


async def test_a_workspace_roster_is_reachable_to_its_own_members(db_session):
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(
        db_session, "ws_live", days=7, now=NOW,
        scope=_contact(visible_workspaces=frozenset({"ws_live"})),
    )
    assert detail is not None
    assert any(c.get("email") for c in detail["topContributors"])


async def test_reporting_on_a_workspace_still_hands_over_no_roster(db_session):
    """`analyticsWorkspaceVisibility` opens the figures; it never opens the
    people. Turning contact on as well must not change that."""
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(
        db_session, "ws_live", days=7, now=NOW,
        scope=_contact(visible_workspaces=frozenset(),
                       reports_all_workspaces=True, user_id="usr_new2"),
    )
    assert detail is not None, "reporting is on, so the page opens"
    assert detail["topContributors"] == []
    assert "@x.io" not in json.dumps(detail)


def test_the_cache_key_is_the_window_alone():
    """One entry per window, shared by every reader.

    Keyed per-reader, a few hundred concurrent users with a few hundred
    distinct workspace sets meant a few hundred full recomputations per TTL.
    What makes one entry safe is that the cached document is UNREDACTED and
    nothing can leave the cache without a redactor — the guarantee that used to
    live in the key now lives in `_serve`, and the two tests below hold it.
    """
    from backend.app.api.v1.endpoints.analytics import _cache_key

    assert _cache_key("summary", {"days": 30}) == _cache_key("summary", {"days": 30})
    # A different window is still a different document.
    assert _cache_key("summary", {"days": 30}) != _cache_key("summary", {"days": 7})
    # And two surfaces over the same window do not collide.
    assert _cache_key("summary", {"days": 30}) != _cache_key("workspaces", {"days": 30})


# ── The flag, at the endpoint ───────────────────────────────────────

def _prime_flag(**values):
    """Prime the singleton flag cache so the gate resolves without a DB hop.
    Mirrors `test_feature_gates.py`'s helper."""
    import time as _time

    from backend.app.services.feature_flags import feature_flags
    feature_flags._cache = dict(values)
    feature_flags._cache_ts = _time.monotonic()


@pytest.fixture
def _flag_cache():
    from backend.app.services.feature_flags import feature_flags
    feature_flags.invalidate()
    yield
    feature_flags.invalidate()


async def _as(test_client, perms, url=SUMMARY):
    def _claims():
        return PermissionClaims(sid="sess_test", global_perms=perms, ws_perms={})

    app.dependency_overrides[get_permission_claims] = _claims
    try:
        return await test_client.get(url)
    finally:
        app.dependency_overrides.pop(get_permission_claims, None)


def _redacted(res) -> bool:
    """Whether this response was filtered for its reader.

    The notice is only attached by the redactors, so its presence IS the answer
    — and unlike looking for an address in the body, it does not depend on the
    seeded window overlapping the endpoint's real-clock default.
    """
    return bool((res.json().get("redaction") or {}).get("applied"))


async def test_an_admin_warming_the_cache_does_not_unredact_the_next_reader(
    test_client, db_session, _flag_cache,
):
    """The leak the per-reader key used to prevent, now held by `_serve`.

    Both orders, because the failure is symmetric: a shared entry redacted in
    place would serve the admin's document to the member on one ordering and
    the member's to the admin on the other.
    """
    await _seed(db_session)
    _prime_flag(analyticsPublicEnabled=True, analyticsPrivacyMode="strict")

    admin_first = await _as(test_client, ("system:admin",))
    member_after = await _as(test_client, ())
    assert admin_first.status_code == 200 and member_after.status_code == 200
    assert _redacted(admin_first) is False, "the admin's document was filtered"
    assert _redacted(member_after) is True, "the member was served the admin's document"

    analytics_cache.clear()
    member_first = await _as(test_client, ())
    admin_after = await _as(test_client, ("system:admin",))
    assert _redacted(member_first) is True
    assert _redacted(admin_after) is False, "the admin was served the member's redaction"


async def test_readers_share_one_computation(test_client, db_session, _flag_cache, monkeypatch):
    """The scale property, stated as a test.

    Keyed per-reader, this cost one full aggregation per distinct workspace
    set. Three readers with three different levels of access must now cost one
    — and must still receive three correctly different documents.
    """
    await _seed(db_session)
    _prime_flag(analyticsPublicEnabled=True, analyticsPrivacyMode="strict")

    builds = 0
    real = analytics_repo.platform_summary

    async def counting(*args, **kwargs):
        nonlocal builds
        builds += 1
        return await real(*args, **kwargs)

    monkeypatch.setattr(analytics_repo, "platform_summary", counting)

    admin = await _as(test_client, ("system:admin",))
    auditor = await _as(test_client, ("system:audit:read",))
    member = await _as(test_client, ())

    assert builds == 1, f"one window, one aggregation — ran {builds}"
    assert admin.status_code == auditor.status_code == member.status_code == 200
    assert _redacted(admin) is False and _redacted(auditor) is False
    assert _redacted(member) is True


async def test_flag_off_refuses_a_non_privileged_caller(test_client, db_session, _flag_cache):
    await _seed(db_session)
    _prime_flag(analyticsPublicEnabled=False)

    res = await _as(test_client, ())
    assert res.status_code == 403
    # The typed refusal every feature gate raises, so the client needs no
    # special case for this one.
    assert res.json()["detail"]["type"] == "feature_disabled"
    assert res.json()["detail"]["feature"] == "analyticsPublicEnabled"


async def test_flag_on_serves_a_redacted_document(test_client, db_session, _flag_cache):
    await _seed(db_session)
    _prime_flag(analyticsPublicEnabled=True)

    res = await _as(test_client, ())
    assert res.status_code == 200
    body = res.json()
    assert body["redaction"]["applied"] is True
    assert body["leaderboards"]["topUsers"] == []
    assert body["totals"]["users"]["total"] > 0, "aggregates still answer"


@pytest.mark.parametrize(
    "perms",
    [("system:admin",), ("system:org-admin",), ("system:audit:read",)],
)
async def test_privileged_callers_are_never_gated_by_the_flag(
    test_client, db_session, _flag_cache, perms,
):
    """Turning the switch off must not take an administrator's own dashboard
    away — it decides whether EVERYONE ELSE gets in."""
    await _seed(db_session)
    _prime_flag(analyticsPublicEnabled=False)

    res = await _as(test_client, perms)
    assert res.status_code == 200
    assert "redaction" not in res.json()


async def test_an_unreadable_flag_fails_closed(test_client, db_session, _flag_cache):
    """Security posture: if we cannot tell what the operator wanted, assume the
    narrower world. Failing open would publish headcount on a DB hiccup."""
    await _seed(db_session)
    _prime_flag()   # cache primed, key absent — the flag has no resolvable value

    assert (await _as(test_client, ())).status_code == 403


# ── Alignment with the app's own permission model ───────────────────
#
# Three ways Analytics used to be STRICTER than the product it reports on.
# Being over-cautious looks harmless and is not: a dashboard that hides what
# the rest of the app shows teaches people its numbers are unreliable.

from backend.app.services.analytics_scope import PrivacyMode


def _scope(**kw) -> ViewerScope:
    base = dict(privileged=False, visible_workspaces=frozenset(),
                privacy=PrivacyMode.INTERNAL)
    base.update(kw)
    return ViewerScope(**base)


async def test_org_viewer_sees_every_workspace(db_session):
    """`system:org-viewer` already short-circuits every workspace:*:read in
    `permission_service`. Analytics ignoring it was a bug."""
    await _seed(db_session)
    rows = await analytics_repo.workspace_rows(
        db_session, days=7, now=NOW,
        scope=_scope(sees_all_workspaces=True),
    )
    assert all(r["redacted"] is False for r in rows)
    assert {r["name"] for r in rows} == {"Live", "Quiet"}
    # And they may genuinely open them — this is real access, not reporting.
    assert all(r["canOpen"] for r in rows)


async def test_enterprise_published_views_are_named_for_everyone(db_session):
    """`view_access.can_read_view` returns True for enterprise visibility on
    ANY authenticated user, so hiding the name was pure inconsistency."""
    await _seed(db_session)
    db_session.add_all([
        ProductEventORM(id=f"pev_ent{i}", event_type="view.opened",
                        actor_id="usr_old", subject_id="view_a",
                        payload=json.dumps({"viewId": "view_a"}), created_at=_iso(1))
        for i in range(3)
    ])
    await db_session.commit()

    # view_a is enterprise-visibility and lives in ws_live.
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_scope())   # member of nothing
    named = {v["name"] for v in doc["leaderboards"]["topViews"]}
    assert "Alpha" in named, "an enterprise-published view must keep its name"
    alpha = next(v for v in doc["leaderboards"]["topViews"] if v["name"] == "Alpha")
    assert alpha["canOpen"] is True, "anyone can open an enterprise view"


async def test_a_creator_keeps_reach_to_their_own_view(db_session):
    await _seed(db_session)
    db_session.add(ProductEventORM(
        id="pev_own", event_type="view.opened", actor_id="usr_new1",
        subject_id="view_b",
        payload=json.dumps({"viewId": "view_b"}), created_at=_iso(1)))
    await db_session.commit()

    # view_b is PRIVATE, in ws_live, created by usr_new1.
    mine = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_scope(user_id="usr_new1"))
    assert "Beta" in {v["name"] for v in mine["leaderboards"]["topViews"]}

    theirs = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_scope(user_id="usr_old"))
    beta = [v for v in theirs["leaderboards"]["topViews"] if v["name"] == "Beta"]
    assert not beta, "someone else's private view stays hidden"


# ── Privacy modes ───────────────────────────────────────────────────

async def test_strict_names_nobody_but_still_answers(db_session):
    """The DataHub-shaped floor: aggregates and popular published items are
    useful to everyone even when no individual is named."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_scope(privacy=PrivacyMode.STRICT, visible_workspaces=frozenset({"ws_live"})))

    assert doc["leaderboards"]["topUsers"] == []
    assert doc["totals"]["users"]["total"] > 0
    assert doc["redaction"]["mode"] == "strict"
    assert doc["redaction"]["showsPeople"] is False


async def test_internal_names_colleagues_but_never_emails(db_session):
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_scope(privacy=PrivacyMode.INTERNAL))

    assert doc["leaderboards"]["topUsers"], "colleagues are named at this level"
    # An address is a credential-shaped identifier, stripped at EVERY level.
    assert all(u["email"] is None for u in doc["leaderboards"]["topUsers"])
    assert "@x.io" not in json.dumps(doc)
    # Operations stay privileged until `full`.
    assert "access" not in doc["health"]


async def test_full_adds_operations(db_session):
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_scope(privacy=PrivacyMode.FULL))
    assert "access" in doc["health"]
    assert "reliability" in doc["health"]


async def test_your_own_row_survives_the_strictest_level(db_session):
    """It is their data. Hiding it from them protects nobody."""
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_scope(privacy=PrivacyMode.STRICT, user_id="usr_old"))
    assert [u["userId"] for u in doc["leaderboards"]["topUsers"]] == ["usr_old"]


# ── Workspace reporting vs. workspace access ────────────────────────

async def test_reporting_on_a_workspace_is_not_a_door_into_it(db_session):
    """The whole reason `can_see` and `can_open` are separate predicates."""
    await _seed(db_session)
    rows = await analytics_repo.workspace_rows(
        db_session, days=7, now=NOW,
        scope=_scope(visible_workspaces=frozenset({"ws_live"}),
                     reports_all_workspaces=True),
    )
    by_id = {r["workspaceId"]: r for r in rows}

    # Named and measured, because an operator opened reporting…
    assert by_id["ws_quiet"]["redacted"] is False
    assert by_id["ws_quiet"]["name"] == "Quiet"
    assert by_id["ws_quiet"]["views"] is not None
    # …but no link, because they still cannot open it.
    assert by_id["ws_quiet"]["canOpen"] is False
    assert by_id["ws_live"]["canOpen"] is True


async def test_workspace_reporting_off_locks_rows_as_before(db_session):
    await _seed(db_session)
    rows = await analytics_repo.workspace_rows(
        db_session, days=7, now=NOW,
        scope=_scope(visible_workspaces=frozenset({"ws_live"})),
    )
    by_id = {r["workspaceId"]: r for r in rows}
    assert by_id["ws_quiet"]["redacted"] is True
    assert by_id["ws_quiet"]["views"] is None


# ── The leak sweep ──────────────────────────────────────────────────
#
# Every other redaction test asserts on a FIELD, which only ever proves the
# fields somebody remembered to check. This one serialises the whole document
# and searches it for identifiers the viewer has no business receiving, so a
# leak through a field nobody thought about still fails the build.
#
# It exists because of a real one: `createdBy` was added to the popular-views
# rows so the redactor could honour a creator's own reach, and both branches
# spread `**row`, so every redacted view shipped its author's user id to a
# reader who could not see the view's name.

async def test_a_redacted_document_contains_no_foreign_identifier(db_session):
    await _seed(db_session)
    db_session.add(ProductEventORM(
        id="pev_probe", event_type="view.opened", actor_id="usr_old",
        payload=json.dumps({"viewId": "view_c"}), created_at=_iso(1)))
    await db_session.commit()

    # usr_new2 is a member of nothing and sees the strictest level.
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW,
        scope=_scope(privacy=PrivacyMode.STRICT, user_id="usr_new2"),
    )
    blob = json.dumps(doc)

    forbidden = {
        "usr_old": "another person's user id",
        "usr_new1": "another person's user id",
        "old@x.io": "another person's email",
        "n1@x.io": "another person's email",
        "Gamma": "the name of a view in a workspace they cannot open",
        "Quiet": "the name of a workspace they are not in",
    }
    leaked = {k: why for k, why in forbidden.items() if k in blob}
    assert not leaked, f"redacted document leaked: {leaked}"


async def test_the_sweep_would_catch_a_leak(db_session):
    """The guard above is only worth having if it can fail.

    A privileged document contains exactly the identifiers the redacted one
    must not, so running the same search over it proves the search works
    rather than that the string happened to be absent.
    """
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(
        db_session, days=7, now=NOW, scope=_PRIVILEGED)
    blob = json.dumps(doc)
    assert "usr_old" in blob and "old@x.io" in blob, (
        "the sweep's search terms no longer appear even when unredacted, so "
        "the sweep proves nothing — update the fixtures with it"
    )


async def test_the_http_response_is_clean_not_just_the_repo(
    test_client, db_session, _flag_cache,
):
    """The repo's return value is not what reaches a browser.

    Everything above tests the document `platform_summary` builds. This tests
    the bytes the endpoint actually sends, which is the only surface an
    attacker sees — and the only one a serialisation change could reopen.
    """
    await _seed(db_session)
    _prime_flag(analyticsPublicEnabled=True, analyticsPrivacyMode="strict")

    res = await _as(test_client, ())
    assert res.status_code == 200
    body = res.text

    for secret, why in {
        "usr_old": "another person's user id",
        "old@x.io": "another person's email",
        "Gamma": "a view in a workspace they cannot open",
        "Quiet": "a workspace they are not in",
        "createdBy": "an internal field that should never serialise",
    }.items():
        assert secret not in body, f"response leaked {why}: {secret!r}"


async def test_workspace_rows_carry_no_hidden_fields(db_session):
    """The table endpoint gets the same sweep as the summary."""
    await _seed(db_session)
    rows = await analytics_repo.workspace_rows(
        db_session, days=7, now=NOW, scope=_scope(visible_workspaces=frozenset()))
    blob = json.dumps(rows)
    assert "Quiet" not in blob and "Live" not in blob
    assert "usr_" not in blob, "a workspace row carried a user id"


async def test_a_real_view_open_is_counted(db_session):
    """The writer and the reader must agree on ``subject_id``.

    Every other open in this file is a hand-built row that MIRRORS
    ``record_view_visit``. This one goes through it. Analytics now groups on
    the column rather than decoding the payload, so a writer that stopped
    setting it would not fail anything — opens would simply stop being counted,
    the dashboard would read zero, and it would look like nobody was using the
    product.
    """
    from backend.app.db.repositories import view_repo

    await _seed(db_session)
    before = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    await view_repo.record_view_visit(db_session, "view_a", "usr_brand_new")
    await db_session.commit()

    after = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    assert after["totals"]["viewOpens"]["total"] == \
        before["totals"]["viewOpens"]["total"] + 1, (
            "an open written by the real writer was not counted"
        )
    alpha = next(v for v in after["leaderboards"]["topViews"] if v["viewId"] == "view_a")
    assert alpha["uniqueViewers"] >= 1


async def test_an_unattributable_open_still_counts_but_ranks_nothing(db_session):
    """The two halves of an open whose subject is missing.

    The migration stamps a row it could not attribute with the empty string so
    the `IS NULL` backfill predicate terminates. Such a row should still count
    as usage — somebody opened something, and dropping it would understate the
    platform — but it must never become a view in a ranking, because there is
    no view to name. Platform totals and per-view breakdowns are separate
    queries precisely so these two answers can differ.
    """
    await _seed(db_session)
    before = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    db_session.add_all([
        ProductEventORM(id="pev_blank", event_type="view.opened",
                        actor_id="usr_old", subject_id="",
                        payload="{}", created_at=_iso(1)),
        ProductEventORM(id="pev_null", event_type="view.opened",
                        actor_id="usr_old", subject_id=None,
                        payload="{}", created_at=_iso(1)),
    ])
    await db_session.commit()

    after = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    assert after["totals"]["viewOpens"]["total"] == \
        before["totals"]["viewOpens"]["total"] + 2, "usage was dropped"
    # And no phantom row reached a leaderboard.
    assert all(v["viewId"] for v in after["leaderboards"]["topViews"])
    assert len(after["leaderboards"]["topViews"]) == \
        len(before["leaderboards"]["topViews"])


async def test_the_catalogue_s_dark_matter_is_counted(db_session):
    """How much of the catalogue nobody reached.

    "The top ten views take most of the opens" reads as good news — people know
    what they want — right up until you see how much is getting nothing. The
    count is by subtraction, so it must survive a view being soft-deleted (it
    leaves the catalogue) and an open landing outside the window (it stops
    counting).
    """
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    b = doc["breakdowns"]

    live = doc["totals"]["views"]["total"]
    opened = {v["viewId"] for v in doc["leaderboards"]["topViews"]}
    assert b["viewsNotOpened"] == live - len(opened), (
        "not-opened must be the catalogue minus what was actually opened"
    )
    assert b["viewsNotOpenedShare"] == round(b["viewsNotOpened"] / live, 3)


async def test_an_open_outside_the_window_does_not_count_as_reached(db_session):
    await _seed(db_session)
    # `view_old` has no opens at all inside 7 days; give it one long past.
    db_session.add(ProductEventORM(
        id="pev_stale", event_type="view.opened", actor_id="usr_old",
        subject_id="view_old", payload=json.dumps({"viewId": "view_old"}),
        created_at=_iso(200)))
    await db_session.commit()

    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)
    opened = {v["viewId"] for v in doc["leaderboards"]["topViews"]}
    assert "view_old" not in opened
    assert doc["breakdowns"]["viewsNotOpened"] >= 1


async def test_the_drill_in_obeys_the_privacy_level(db_session):
    """The per-workspace page is a document like any other.

    It was not treated as one: `workspace_detail` returned `topContributors`
    with names AND email addresses, guarded only by "can you see this
    workspace" and passing through no redaction at all. So a reader at the
    strictest level — where no individual is ever named — got a roster of
    everyone who had touched their own workspace, addresses included.
    """
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(
        db_session, "ws_live", days=7, now=NOW,
        scope=_scope(privacy=PrivacyMode.STRICT,
                     visible_workspaces=frozenset({"ws_live"}),
                     user_id="usr_new2"),
    )
    assert detail is not None
    blob = json.dumps(detail)
    assert "@x.io" not in blob, "the drill-in leaked email addresses"
    assert detail["topContributors"] == [], (
        "no individual may be named at the strict level"
    )


async def test_workspace_reporting_does_not_expose_a_roster(db_session):
    """The combination that makes the above dangerous rather than untidy.

    With workspace reporting on, `can_see` is satisfied for EVERY workspace,
    so the drill-in opens for someone who is not a member — and it was handing
    them that workspace's people.
    """
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(
        db_session, "ws_live", days=7, now=NOW,
        scope=_scope(privacy=PrivacyMode.INTERNAL,
                     visible_workspaces=frozenset(),
                     reports_all_workspaces=True, user_id="usr_new2"),
    )
    assert detail is not None, "reporting is on, so the page opens"
    assert "@x.io" not in json.dumps(detail), "no addresses, at any level"


async def test_every_analytics_endpoint_is_swept(test_client, db_session, _flag_cache):
    """The guard that survives the next person.

    Two leaks reached main in this feature — a user id spread into view rows,
    and an unredacted contributor roster on the drill-in. Both were single
    endpoints failing to do what the others did, and both were invisible to
    field-level tests because nobody knew the field was there.

    So this walks the router rather than a hand-written list. An endpoint
    added later is swept the moment it is mounted, without anyone remembering
    to come back here — which is the only kind of guard that holds.
    """
    from backend.app.main import app

    await _seed(db_session)
    _prime_flag(
        analyticsPublicEnabled=True,
        # The most permissive posture that still redacts, so the sweep runs
        # against the largest document a non-privileged reader can obtain.
        analyticsPrivacyMode="internal",
        analyticsWorkspaceVisibility=True,
    )

    paths = sorted({
        r.path for r in app.routes
        if getattr(r, "path", "").startswith("/api/v1/admin/analytics")
    } | {
        # Route objects may be wrapped by an included-router, so the concrete
        # URLs are listed too; the assertion below proves the set is not empty
        # and covers what the frontend actually calls.
        "/api/v1/admin/analytics/summary",
        "/api/v1/admin/analytics/workspaces",
        "/api/v1/admin/analytics/workspaces/ws_live",
    })
    urls = [p.replace("{workspace_id}", "ws_live") for p in paths]
    assert len(urls) >= 3, f"router introspection found too little: {urls}"

    forbidden = {
        "old@x.io": "an email address",
        "n1@x.io": "an email address",
        "createdBy": "an internal-only field",
    }
    for url in urls:
        res = await _as(test_client, (), url=url)
        assert res.status_code in (200, 403, 404), f"{url} -> {res.status_code}"
        if res.status_code != 200:
            continue
        for secret, why in forbidden.items():
            assert secret not in res.text, f"{url} leaked {why}: {secret!r}"
