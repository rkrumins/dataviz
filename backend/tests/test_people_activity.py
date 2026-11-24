"""People analytics — per person, per workspace, per day — and the index that backfills it.

Seeds known rows at known instants across all three activity stores and asserts the
arithmetic, the lenses, the backfill and the access rule, rather than only status codes.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event, select

from backend.app.auth.dependencies import get_current_user, get_permission_claims
from backend.app.db.models import (
    AuthAuditLogORM,
    GroupMemberORM,
    GroupORM,
    OutboxEventORM,
    PeopleIndexCursorORM,
    PeopleIndexDayORM,
    PersonActivityDailyORM,
    PersonWorkspaceActivityORM,
    ProductEventORM,
    RoleBindingORM,
    UserORM,
    ViewActivityLogORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.db.repositories import people_activity_repo as repo
from backend.app.db.repositories import people_index_repo as index
from backend.app.main import app
from backend.app.services import analytics_cache
from backend.app.services import people_activity_indexer as indexer
from backend.app.services.permission_service import PermissionClaims

PEOPLE = "/api/v1/admin/analytics/people"
FIXED = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _fresh():
    analytics_cache.clear()
    from backend.app.api.v1.endpoints import people_activity
    people_activity._audited.clear()
    yield
    analytics_cache.clear()


def _at(now: datetime, days: float, hour: int = 10, minute: int = 0) -> str:
    """``days`` before ``now``, at hh:mm UTC that day."""
    day = (now - timedelta(days=days)).date()
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=timezone.utc).isoformat()


def _ledger(eid: str, event_type: str, at: str, *, actor=None, subject=None, ws=None,
            category="platform", audience="platform", actor_kind="user", payload=None):
    return AuthAuditLogORM(
        id=eid, source_event_id=f"src_{eid}", event_type=event_type,
        payload=json.dumps(payload or {}), occurred_at=at, recorded_at=at,
        category=category, audience=audience, actor_id=actor, actor_kind=actor_kind,
        subject_id=subject, workspace_id=ws,
    )


async def _seed(session, now: datetime = FIXED, *, index_now: bool = True) -> None:
    """Two workspaces, six people, one service account.

    * ann — ws_a by direct grant; opens, traces, searches, edits; signs in.
    * bob — ws_a through a group, joined the group after it was granted.
    * cat — ws_b; creates a view and runs an aggregation.
    * dan — ws_a; signs in and does nothing.
    * eve — no workspace; traces once.
    * svc_bot — a service account; never counted.
    """
    session.add_all([
        WorkspaceORM(id="ws_a", name="Atlas", created_at=_at(now, 200)),
        WorkspaceORM(id="ws_b", name="Borealis", created_at=_at(now, 200)),
    ])
    for uid, first in (("usr_ann", "Ann"), ("usr_bob", "Bob"), ("usr_cat", "Cat"),
                       ("usr_dan", "Dan"), ("usr_eve", "Eve")):
        session.add(UserORM(id=uid, email=f"{first.lower()}@corp.io", password_hash="x",
                            first_name=first, last_name="Tester", status="active",
                            created_at=_at(now, 120)))
    session.add(UserORM(id="svc_bot", email="bot@corp.io", password_hash="x",
                        first_name="Bot", last_name="", status="active",
                        created_at=_at(now, 120)))
    session.add_all([
        ViewORM(id="view_a1", name="Atlas lineage", workspace_id="ws_a", created_by="usr_ann",
                created_at=_at(now, 100), visibility="workspace"),
        ViewORM(id="view_b1", name="Borealis secret", workspace_id="ws_b", created_by="usr_cat",
                created_at=_at(now, 100), visibility="private"),
    ])
    session.add(GroupORM(id="grp_1", name="Analysts", created_at=_at(now, 100),
                         updated_at=_at(now, 100)))
    session.add_all([
        RoleBindingORM(id="bnd_ann", subject_type="user", subject_id="usr_ann",
                       role_name="workspace_member", scope_type="workspace", scope_id="ws_a",
                       granted_at=_at(now, 60)),
        RoleBindingORM(id="bnd_dan", subject_type="user", subject_id="usr_dan",
                       role_name="workspace_member", scope_type="workspace", scope_id="ws_a",
                       granted_at=_at(now, 40)),
        RoleBindingORM(id="bnd_cat", subject_type="user", subject_id="usr_cat",
                       role_name="workspace_member", scope_type="workspace", scope_id="ws_b",
                       granted_at=_at(now, 30)),
        RoleBindingORM(id="bnd_grp", subject_type="group", subject_id="grp_1",
                       role_name="workspace_member", scope_type="workspace", scope_id="ws_a",
                       granted_at=_at(now, 50)),
    ])
    session.add(GroupMemberORM(group_id="grp_1", user_id="usr_bob", added_at=_at(now, 20)))

    pe = ProductEventORM
    session.add_all([
        pe(id="pev_open", event_type="view.opened", actor_id="usr_ann", subject_id="view_a1",
           created_at=_at(now, 2, 10, 0)),
        # Ten minutes after opening Atlas: inferred into ws_a by the indexer.
        pe(id="pev_trace", event_type="lineage.trace", actor_id="usr_ann",
           created_at=_at(now, 2, 10, 10)),
        # Two hours later: too long after any open to be placed anywhere.
        pe(id="pev_search", event_type="graph.search", actor_id="usr_ann",
           created_at=_at(now, 2, 12, 0)),
        pe(id="pev_section", event_type="app.section", actor_id="usr_ann", subject_id="explore",
           workspace_id="ws_a", created_at=_at(now, 2, 9, 55)),
        pe(id="pev_bob", event_type="view.opened", actor_id="usr_bob", subject_id="view_a1",
           created_at=_at(now, 1, 14, 0)),
        pe(id="pev_cat", event_type="view.opened", actor_id="usr_cat", subject_id="view_b1",
           created_at=_at(now, 1, 9, 0)),
        pe(id="pev_bot", event_type="view.opened", actor_id="svc_bot", subject_id="view_a1",
           created_at=_at(now, 1, 9, 0)),
        pe(id="pev_eve", event_type="lineage.trace", actor_id="usr_eve",
           created_at=_at(now, 3, 16, 0)),
        # The previous 7-day window.
        pe(id="pev_prev", event_type="view.opened", actor_id="usr_ann", subject_id="view_a1",
           created_at=_at(now, 10, 11, 0)),
    ])
    session.add_all([
        ViewActivityLogORM(id="val_ann", view_id="view_a1", workspace_id="ws_a",
                           action="updated", actor="usr_ann", created_at=_at(now, 2, 10, 20)),
        ViewActivityLogORM(id="val_cat", view_id="view_b1", workspace_id="ws_b",
                           action="created", actor="usr_cat", created_at=_at(now, 1, 9, 5)),
        # An admin opening a private view: auditor-only.
        ViewActivityLogORM(id="val_peek", view_id="view_b1", workspace_id="ws_b",
                           action="admin_viewed", actor="usr_ann",
                           created_at=_at(now, 1, 11, 0)),
    ])
    session.add_all([
        _ledger("aud_in_ann", "user.logged_in", _at(now, 2, 9, 50), actor="usr_ann",
                subject="usr_ann", category="identity", payload={"provider": "local"}),
        _ledger("aud_in_dan", "user.logged_in", _at(now, 1, 8, 0), actor="usr_dan",
                subject="usr_dan", category="identity", payload={"provider_slug": "okta"}),
        _ledger("aud_fail_dan", "user.login_failed", _at(now, 1, 7, 59), subject="usr_dan",
                category="identity", actor_kind="anonymous"),
        _ledger("aud_job", "aggregation.job.started", _at(now, 1, 9, 30), actor="usr_cat",
                ws="ws_b", category="operations", audience="workspace"),
        # The ledger's copy of val_ann — must not be counted a second time.
        _ledger("aud_mirror", "visualization.view.updated", _at(now, 2, 10, 20),
                actor="usr_ann", ws="ws_a", category="content"),
        # The ledger remembers ann joining ws_a before her current grant.
        _ledger("aud_bound", "rbac.workspace.member_bound", _at(now, 90), actor="usr_cat",
                subject="usr_ann", ws="ws_a", category="access", audience="workspace"),
    ])
    await session.commit()
    if index_now:
        # Everything a roster reads comes from the rollup the indexer keeps.
        await indexer.catch_up(session, now=now)
        await session.commit()


def _person(doc: dict, uid: str) -> dict:
    return next(p for p in doc["people"] if p["userId"] == uid)


# ── The roster ────────────────────────────────────────────────────────


async def test_roster_unions_three_stores_without_double_counting(db_session):
    await _seed(db_session)
    doc = await repo.people_doc(db_session, days=7, now=FIXED)

    ann = _person(doc, "usr_ann")
    # open + trace + search + edit + admin_viewed (full lens). Not the mirrored ledger row,
    # not the section move, not the sign-in.
    assert ann["actions"] == 5
    assert ann["signIns"] == 1
    assert ann["topKind"] == "browse"
    assert ann["previous"] == 1 and ann["changePct"] == 400.0
    # The cached summary carries no series, dates or addresses: those come per page.
    assert not {"line", "values", "email", "joinedAt"} & set(ann)
    assert ann["activeDays"] == 2

    dan = _person(doc, "usr_dan")
    assert dan["actions"] == 0 and dan["signIns"] == 1 and dan["idleSignInDays"] == 1

    ids = {p["userId"] for p in doc["people"]}
    assert "svc_bot" not in ids
    assert doc["totals"]["activePeople"]["current"] == 4      # ann, bob, cat, eve
    assert doc["totals"]["signedIn"]["current"] == 2           # ann, dan
    assert doc["totals"]["idleSignIns"]["days"] == 1
    assert doc["sections"] == [{"section": "explore", "count": 1, "people": 1}]
    assert sum(doc["series"]["activePeople"]) >= 4
    kinds = {k["kind"]: k["count"] for k in doc["kinds"]}
    assert kinds["operate"] == 1 and kinds["signin"] == 2


async def test_workspace_lens_drops_sign_ins_and_auditor_only_rows(db_session):
    await _seed(db_session)
    doc = await repo.people_doc(db_session, days=7, now=FIXED, workspace_id="ws_b",
                                lens=repo.WORKSPACE)
    cat = _person(doc, "usr_cat")
    assert cat["actions"] == 3                      # open + created + aggregation job
    assert cat["signIns"] is None and cat["lastSignInAt"] is None
    # ann's admin_viewed of a private view is auditor-only: she is not in ws_b's roster.
    assert {p["userId"] for p in doc["people"]} == {"usr_cat"}
    assert doc["totals"]["signedIn"] is None
    assert doc["series"]["signedIn"] is None
    assert "signin" not in {k["kind"] for k in doc["kinds"]}


async def test_full_lens_workspace_scope_carries_members_sign_ins(db_session):
    await _seed(db_session)
    doc = await repo.people_doc(db_session, days=7, now=FIXED, workspace_id="ws_a")
    assert _person(doc, "usr_dan")["signIns"] == 1
    # In ws_a: the open, the inferred trace and the edit — not the search two hours later,
    # which nothing places in a workspace.
    assert _person(doc, "usr_ann")["actions"] == 3


async def test_quiet_members_and_joins(db_session):
    await _seed(db_session)
    doc = await repo.people_doc(db_session, days=7, now=FIXED, workspace_id="ws_a",
                                lens=repo.WORKSPACE)
    assert doc["totals"]["members"] == 3            # ann, dan, and bob through the group
    quiet = doc["quiet"]
    assert [q["userId"] for q in quiet["people"]] == ["usr_dan"]
    # Never a platform presence for a workspace admin.
    assert quiet["people"][0]["lastLoginAt"] is None
    assert quiet["people"][0]["joinedAt"] == _at(FIXED, 40)
    page = await repo.enrich_page(db_session, doc["people"], days=7, now=FIXED,
                                  workspace_id="ws_a", lens=repo.WORKSPACE)
    joined = {p["userId"]: p["joinedAt"] for p in page}
    # Joined: the later of the group's grant and joining the group.
    assert joined["usr_bob"] == _at(FIXED, 20)
    # The ledger's member event predates today's grant.
    assert joined["usr_ann"] == _at(FIXED, 90)
    assert all("email" not in p for p in page)


# ── The index: backfill, inference, idempotence ───────────────────────


async def test_indexer_backfills_attribution_and_infers_traces(db_session):
    await _seed(db_session)
    await indexer.catch_up(db_session, now=FIXED)
    ws = dict((await db_session.execute(
        select(ProductEventORM.id, ProductEventORM.workspace_id))).all())
    assert ws["pev_open"] == "ws_a"          # a fact: its view's workspace
    assert ws["pev_trace"] == "ws_a"         # inferred: 10 minutes after opening Atlas
    assert ws["pev_search"] is None          # 2 hours after: not guessed
    assert ws["pev_eve"] is None             # never opened anything
    assert ws["pev_cat"] == "ws_b"

    doc = await repo.people_doc(db_session, days=7, now=FIXED, workspace_id="ws_a")
    assert {k["kind"]: k["count"] for k in doc["kinds"]}["trace"] == 1


async def test_indexer_rolls_up_joins_and_first_last_activity(db_session):
    await _seed(db_session)
    await indexer.catch_up(db_session, now=FIXED)
    rows = {
        (r.user_id, r.workspace_id): r
        for r in (await db_session.execute(select(PersonWorkspaceActivityORM))).scalars()
    }
    ann_a = rows[("usr_ann", "ws_a")]
    # The ledger remembers her joining 90 days ago, before today's 60-day-old grant.
    assert ann_a.joined_at == _at(FIXED, 90)
    assert ann_a.first_active_at == _at(FIXED, 10, 11, 0)
    assert ann_a.last_active_at == _at(FIXED, 2, 10, 20)
    assert rows[("usr_bob", "ws_a")].joined_at == _at(FIXED, 20)
    assert rows[("usr_dan", "ws_a")].first_active_at is None
    # Platform rows: every person who did anything, nothing for a service account.
    assert rows[("usr_eve", index.PLATFORM)].first_active_at == _at(FIXED, 3, 16, 0)
    assert not any(uid == "svc_bot" for uid, _ in rows)
    # ann's admin_viewed in ws_b moves no ws_b timeline.
    assert ("usr_ann", "ws_b") not in rows

    cov = await index.coverage(db_session, now=FIXED)
    assert cov["running"] and not cov["backfilling"] and cov["progress"] == 1.0
    assert cov["completeFrom"] == cov["historyFrom"] == _at(FIXED, 90)[:10]


async def test_indexer_is_idempotent_and_resumes(db_session):
    await _seed(db_session)
    await indexer.catch_up(db_session, now=FIXED)
    before = sorted(
        (r.user_id, r.workspace_id, r.joined_at, r.first_active_at, r.last_active_at)
        for r in (await db_session.execute(select(PersonWorkspaceActivityORM))).scalars())
    assert await indexer.catch_up(db_session, now=FIXED) == 0

    rollup = sorted(
        (r.day, r.user_id, r.workspace_id, r.kind, r.n, r.n_ws, r.first_at, r.last_ws_at)
        for r in (await db_session.execute(select(PersonActivityDailyORM))).scalars())
    assert rollup, "the seed should have been indexed"

    # Forget everything the indexer knows: a full re-run over the same history changes nothing.
    for model in (PeopleIndexCursorORM, PeopleIndexDayORM):
        for c in (await db_session.execute(select(model))).scalars():
            await db_session.delete(c)
    await db_session.flush()
    await indexer.catch_up(db_session, now=FIXED)
    after = sorted(
        (r.user_id, r.workspace_id, r.joined_at, r.first_active_at, r.last_active_at)
        for r in (await db_session.execute(select(PersonWorkspaceActivityORM))).scalars())
    assert before == after
    assert rollup == sorted(
        (r.day, r.user_id, r.workspace_id, r.kind, r.n, r.n_ws, r.first_at, r.last_ws_at)
        for r in (await db_session.execute(select(PersonActivityDailyORM))).scalars())


async def test_indexer_picks_up_new_activity_incrementally(db_session):
    await _seed(db_session)
    await indexer.catch_up(db_session, now=FIXED)
    later = FIXED + timedelta(hours=1)
    db_session.add(ProductEventORM(id="pev_new", event_type="view.opened", actor_id="usr_dan",
                                   subject_id="view_a1", created_at=_at(later, 0, 12, 30)))
    await db_session.flush()
    await indexer.catch_up(db_session, now=later + timedelta(minutes=5))
    row = await db_session.get(PersonWorkspaceActivityORM, ("usr_dan", "ws_a"))
    assert row.first_active_at == _at(later, 0, 12, 30)


# ── One person ────────────────────────────────────────────────────────


async def test_person_doc(db_session):
    await _seed(db_session)
    await indexer.catch_up(db_session, now=FIXED)
    doc = await repo.person_doc(db_session, "usr_ann", days=7, now=FIXED)
    t = doc["totals"]
    assert t["actions"]["current"] == 5 and t["actions"]["previous"] == 1
    assert t["traces"]["current"] == 1 and t["traceEmptyRate"] == 0.0
    assert t["signIns"]["current"] == 1
    assert t["longestStreak"] == 2         # two days ago and yesterday
    assert doc["typicalDay"]["days"] == 2
    ws = {w["workspaceId"]: w for w in doc["workspaces"]}
    assert ws["ws_a"]["joinedAt"] == _at(FIXED, 90) and ws["ws_a"]["member"]
    assert doc["views"][0]["viewId"] == "view_a1"
    assert doc["signIns"]["methods"] == [{"key": "local", "count": 1}]
    assert doc["profile"]["firstActiveAt"] == _at(FIXED, 10, 11, 0)

    dan = await repo.person_doc(db_session, "usr_dan", days=7, now=FIXED)
    assert dan["signIns"]["failed"] == 1

    assert await repo.person_doc(db_session, "usr_nobody", days=7, now=FIXED) is None


async def test_person_doc_in_the_workspace_lens(db_session):
    await _seed(db_session)
    doc = await repo.person_doc(db_session, "usr_ann", days=7, now=FIXED,
                                workspace_id="ws_a", lens=repo.WORKSPACE)
    assert doc["signIns"] is None and doc["totals"]["signIns"] is None
    assert [w["workspaceId"] for w in doc["workspaces"]] == ["ws_a"]


async def test_calendar_is_a_year_of_days(db_session):
    await _seed(db_session)
    cal = await repo.person_calendar(db_session, "usr_ann", now=FIXED)
    assert len(cal["days"]) == repo.CALENDAR_DAYS == len(cal["actions"])
    assert cal["days"][-1] == FIXED.date().isoformat()
    day = (FIXED - timedelta(days=2)).date().isoformat()
    assert cal["actions"][cal["days"].index(day)] == 4
    assert cal["signIns"][cal["days"].index(day)] == 1


async def test_day_is_split_into_sessions(db_session):
    await _seed(db_session)
    day = (FIXED - timedelta(days=2)).date().isoformat()
    doc = await repo.person_day(db_session, "usr_ann", day)
    assert [e["type"] for e in doc["events"]] == [
        "user.logged_in", "app.section", "view.opened", "lineage.trace", "edit.updated",
        "graph.search",
    ]
    # 09:50 → 10:20 is one session; 12:00 is another.
    assert [s["actions"] for s in doc["sessions"]] == [3, 1]
    assert doc["truncated"] is False


async def test_feed_pages_through_every_store_without_gaps(db_session):
    await _seed(db_session)
    seen: list[str] = []
    cursor = None
    for _ in range(20):
        events, cursor = await repo.person_events(db_session, "usr_ann", limit=2,
                                                  before=cursor)
        seen += [e["id"] for e in events]
        if cursor is None:
            break
    # Every one of ann's rows, once, newest first.
    assert seen == ["val_peek", "pev_search", "val_ann", "pev_trace", "pev_open",
                    "pev_section", "aud_in_ann", "pev_prev"]


async def test_feed_filters_by_kind(db_session):
    await _seed(db_session)
    events, _ = await repo.person_events(db_session, "usr_ann", kinds={"signin", "trace"})
    assert [e["type"] for e in events] == ["lineage.trace", "user.logged_in"]


_RAW_TABLES = ("product_events", "view_activity_log", "auth_audit_log")


def _reads_raw_events(sql: str) -> bool:
    """A statement that scans or groups an event table. The coverage notes' single-row
    ``min``/``max`` index seeks (newest ledger row, first recorded day) are allowed: they cost
    the same at a hundred events as at a hundred million."""
    if not any(f" {t}" in sql or f"{t}." in sql for t in _RAW_TABLES):
        return False
    seek = ("max(" in sql or "min(" in sql) and "GROUP BY" not in sql.upper()
    return not seek


async def _statements_during(db_session, build) -> list[str]:
    statements: list[str] = []

    def _record(conn, cursor, statement, *args, **kwargs):
        statements.append(statement)

    engine = db_session.get_bind()
    event.listen(engine, "before_cursor_execute", _record)
    try:
        await build()
    finally:
        event.remove(engine, "before_cursor_execute", _record)
    return statements


async def test_roster_cost_grows_with_neither_people_nor_events(db_session):
    """The roster is a fixed set of grouped reads of the rollup: ten times the events, or
    forty more people, change neither how many statements run nor which tables they read."""
    await _seed(db_session)
    small = await _statements_during(db_session, lambda: repo.people_doc(db_session, days=7, now=FIXED))
    for i in range(40):
        db_session.add(UserORM(id=f"usr_x{i}", email=f"x{i}@corp.io", password_hash="x",
                               first_name="X", last_name=str(i), status="active",
                               created_at=_at(FIXED, 50)))
        for j in range(10):
            db_session.add(ProductEventORM(id=f"pev_x{i}_{j}", event_type="view.opened",
                                           actor_id=f"usr_x{i}", subject_id="view_a1",
                                           created_at=_at(FIXED, 1, 15, j)))
    await db_session.flush()
    await index.index_day(db_session, _at(FIXED, 1)[:10], now=FIXED)
    analytics_cache.clear()
    big = await _statements_during(db_session, lambda: repo.people_doc(db_session, days=7, now=FIXED))
    doc = await repo.people_doc(db_session, days=7, now=FIXED)
    assert len(doc["people"]) == 45
    assert len(big) == len(small)
    for sql in big:
        assert not _reads_raw_events(sql), sql


async def test_lines_and_the_day_panel_read_only_the_rollup(db_session):
    await _seed(db_session)
    day = _at(FIXED, 1)[:10]
    for build in (
        lambda: repo.lines(db_session, ["usr_ann", "usr_bob"], days=7, now=FIXED),
        lambda: repo.scope_day(db_session, day),
    ):
        for sql in await _statements_during(db_session, build):
            assert not _reads_raw_events(sql), sql


async def test_rollup_agrees_with_the_raw_events(db_session):
    """The correctness anchor: every person's actions over the window, counted straight from
    the three stores by the same rules, equal what the roster reports from the rollup."""
    await _seed(db_session)
    doc = await repo.people_doc(db_session, days=7, now=FIXED)
    first, last = doc["window"]["buckets"][0], doc["window"]["end"][:10]
    since, until = index.day_bounds(first)[0], index.day_bounds(last)[1]
    raw: dict[str, int] = {}
    for actor, t in (await db_session.execute(select(ProductEventORM.actor_id, ProductEventORM.event_type)
                     .where(ProductEventORM.created_at >= since, ProductEventORM.created_at < until))).all():
        if t in repo.USAGE_KINDS and not actor.startswith("svc_"):
            raw[actor] = raw.get(actor, 0) + 1
    for (actor,) in (await db_session.execute(select(ViewActivityLogORM.actor)
                     .where(ViewActivityLogORM.created_at >= since, ViewActivityLogORM.created_at < until))).all():
        raw[actor] = raw.get(actor, 0) + 1
    for actor, t, kind in (await db_session.execute(
            select(AuthAuditLogORM.actor_id, AuthAuditLogORM.event_type, AuthAuditLogORM.actor_kind)
            .where(AuthAuditLogORM.occurred_at >= since, AuthAuditLogORM.occurred_at < until))).all():
        if kind == "user" and actor and t != repo.SIGN_IN and not t.startswith("visualization.view."):
            raw[actor] = raw.get(actor, 0) + 1
    assert {p["userId"]: p["actions"] for p in doc["people"] if p["actions"]} == raw


async def test_a_late_ledger_row_recomputes_its_day(db_session):
    await _seed(db_session)
    day = _at(FIXED, 5)[:10]
    before = await repo.people_doc(db_session, days=7, now=FIXED)
    assert "usr_eve" in {p["userId"] for p in before["people"]}
    # The relay records, a minute from now, something eve did five days ago.
    late = AuthAuditLogORM(
        id="aud_late", source_event_id="src_late", event_type="aggregation.job.started",
        payload="{}", occurred_at=_at(FIXED, 5, 9, 0),
        recorded_at=(FIXED + timedelta(minutes=1)).isoformat(),
        category="operations", audience="workspace", actor_id="usr_eve", actor_kind="user",
        workspace_id="ws_b")
    db_session.add(late)
    await db_session.flush()
    later = FIXED + timedelta(minutes=10)
    await indexer.catch_up(db_session, now=later)
    rows = (await db_session.execute(select(PersonActivityDailyORM).where(
        PersonActivityDailyORM.day == day, PersonActivityDailyORM.user_id == "usr_eve"))).scalars().all()
    assert [(r.workspace_id, r.kind, r.n, r.n_ws) for r in rows] == [("ws_b", "operate", 1, 1)]
    assert (await db_session.get(PeopleIndexDayORM, day)).dirty is False


async def test_days_past_raw_retention_are_never_recomputed(db_session, monkeypatch):
    from backend.app.services import product_event_gc
    monkeypatch.setattr(product_event_gc, "retention_days", lambda: 365)
    db_session.add(ProductEventORM(id="pev_ancient", event_type="view.opened", actor_id="usr_ann",
                                   subject_id="view_a1", created_at=_at(FIXED, 380, 10, 0)))
    await _seed(db_session)
    assert await db_session.get(PeopleIndexDayORM, _at(FIXED, 380)[:10]) is None
    assert await db_session.get(PeopleIndexDayORM, _at(FIXED, 364)[:10]) is not None


async def test_recomputing_a_day_changes_nothing(db_session):
    await _seed(db_session)
    day = _at(FIXED, 2)[:10]

    async def snapshot():
        return sorted(
            (r.user_id, r.workspace_id, r.kind, r.n, r.n_ws, r.first_at, r.last_at)
            for r in (await db_session.execute(select(PersonActivityDailyORM)
                      .where(PersonActivityDailyORM.day == day))).scalars())
    once = await snapshot()
    await index.index_day(db_session, day, now=FIXED)
    await index.index_day(db_session, day, now=FIXED)
    assert await snapshot() == once


# ── The API: who may see whom ─────────────────────────────────────────


def _as(claims: PermissionClaims, user_id: str = "usr_test000000"):
    app.dependency_overrides[get_permission_claims] = lambda: claims

    async def _user():
        from tests.conftest import _FAKE_USER
        return _FAKE_USER.model_copy(update={"id": user_id, "email": f"{user_id}@corp.io"})
    app.dependency_overrides[get_current_user] = _user


@pytest.fixture
def restore_identity():
    saved = {k: app.dependency_overrides.get(k) for k in (get_permission_claims, get_current_user)}
    yield
    for k, v in saved.items():
        if v is None:
            app.dependency_overrides.pop(k, None)
        else:
            app.dependency_overrides[k] = v


WS_ADMIN = PermissionClaims(sid="s", global_perms=(), ws_perms={"ws_a": ("workspace:admin",)})
MEMBER = PermissionClaims(sid="s", global_perms=(), ws_perms={"ws_a": ("workspace:view:read",)})


async def test_privileged_reader_sees_everyone(test_client, db_session):
    await _seed(db_session, datetime.now(timezone.utc))
    r = await test_client.get(PEOPLE, params={"days": 7})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["scope"] == {"workspaceId": None, "lens": "full"}
    assert any(p.get("email") == "ann@corp.io" for p in body["people"])
    # ann, bob, cat, dan (signed in) and eve; never the service account.
    assert body["page"] == {"offset": 0, "limit": 25, "total": 5}
    assert [p["userId"] for p in body["people"]][0] == "usr_ann"
    named = await test_client.get(PEOPLE, params={"days": 7, "q": "bob"})
    assert [p["userId"] for p in named.json()["people"]] == ["usr_bob"]
    # Every person on the page has their activity line, one value per period.
    ann = body["people"][0]
    assert len(ann["line"]) == len(body["window"]["buckets"]) and sum(ann["line"]) == ann["actions"]
    assert ann["joinedAt"] and ann["firstActiveAt"]


async def test_lines_endpoint(test_client, db_session, restore_identity):
    await _seed(db_session, datetime.now(timezone.utc))
    r = await test_client.get(f"{PEOPLE}/lines", params={"ids": "usr_ann,usr_bob", "days": 7})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["lines"]) == {"usr_ann", "usr_bob"}
    assert body["names"]["usr_ann"] == "Ann Tester"
    assert sum(body["lines"]["usr_ann"]) == 5
    too_many = ",".join(f"usr_{i}" for i in range(25))
    assert (await test_client.get(f"{PEOPLE}/lines", params={"ids": too_many})).status_code == 422
    # A workspace admin is told about their workspace's people only: eve is in no workspace.
    _as(WS_ADMIN, "usr_ann")
    scoped = await test_client.get(f"{PEOPLE}/lines", params={
        "ids": "usr_ann,usr_eve,usr_dan", "days": 7, "workspace": "ws_a"})
    assert scoped.status_code == 200, scoped.text
    assert set(scoped.json()["lines"]) == {"usr_ann", "usr_dan"}
    assert (await test_client.get(f"{PEOPLE}/lines", params={"ids": "usr_ann"})).status_code == 403


async def test_day_panel_endpoint(test_client, db_session):
    now = datetime.now(timezone.utc)
    await _seed(db_session, now)
    day = (now - timedelta(days=1)).date().isoformat()
    r = await test_client.get(f"{PEOPLE}/days/{day}")
    assert r.status_code == 200, r.text
    body = r.json()
    # bob opened Atlas, cat built and ran a job, ann opened a private view as an admin.
    assert body["active"] == 3 and body["signedIn"] == 1
    assert [p["userId"] for p in body["people"]] == ["usr_cat", "usr_ann", "usr_bob"]
    assert (await test_client.get(f"{PEOPLE}/days/nope")).status_code == 422


@pytest.mark.parametrize("params,expected", [
    ({}, 403),                         # a workspace admin has no platform-wide view
    ({"workspace": "ws_b"}, 403),      # nor of a workspace they do not run
    ({"workspace": "ws_a"}, 200),
])
async def test_workspace_admin_is_confined_to_their_workspace(
    test_client, db_session, restore_identity, params, expected,
):
    await _seed(db_session, datetime.now(timezone.utc))
    _as(WS_ADMIN, "usr_ann")
    r = await test_client.get(PEOPLE, params={"days": 7, **params})
    assert r.status_code == expected, r.text
    if expected == 200:
        body = r.json()
        assert body["scope"]["lens"] == "workspace"
        text = json.dumps(body)
        # The sweep: no addresses, no sign-ins, to a workspace admin.
        assert "@corp.io" not in text
        assert "user.logged_in" not in text
        assert body["totals"]["signedIn"] is None


async def test_person_reach(test_client, db_session, restore_identity):
    await _seed(db_session, datetime.now(timezone.utc))
    _as(WS_ADMIN, "usr_ann")
    ok = await test_client.get(f"{PEOPLE}/usr_dan", params={"days": 7, "workspace": "ws_a"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["profile"]["lastLoginAt"] is None
    assert ok.json()["signIns"] is None
    # cat is not a member of ws_a and did nothing there: indistinguishable from nobody.
    gone = await test_client.get(f"{PEOPLE}/usr_cat", params={"days": 7, "workspace": "ws_a"})
    assert gone.status_code == 404
    assert (await test_client.get(f"{PEOPLE}/usr_dan", params={"days": 7})).status_code == 403


async def test_everyone_sees_themselves_and_nobody_else(test_client, db_session, restore_identity):
    await _seed(db_session, datetime.now(timezone.utc))
    _as(MEMBER, "usr_dan")
    me = await test_client.get(f"{PEOPLE}/me", params={"days": 7})
    assert me.status_code == 200, me.text
    body = me.json()
    assert body["profile"]["userId"] == "usr_dan" and body["viewer"]["isSelf"]
    assert body["profile"]["email"] == "dan@corp.io"
    assert body["signIns"]["failed"] == 1
    assert (await test_client.get(f"{PEOPLE}/usr_ann", params={"days": 7})).status_code == 403
    assert (await test_client.get(PEOPLE, params={"days": 7})).status_code == 403
    cal = await test_client.get(f"{PEOPLE}/me/calendar")
    assert cal.status_code == 200 and len(cal.json()["days"]) == repo.CALENDAR_DAYS


async def test_day_and_feed_endpoints(test_client, db_session):
    now = datetime.now(timezone.utc)
    await _seed(db_session, now)
    day = (now - timedelta(days=2)).date().isoformat()
    r = await test_client.get(f"{PEOPLE}/usr_ann/days/{day}")
    assert r.status_code == 200, r.text
    assert len(r.json()["sessions"]) == 2
    assert (await test_client.get(f"{PEOPLE}/usr_ann/days/not-a-day")).status_code == 422

    first = await test_client.get(f"{PEOPLE}/usr_ann/events", params={"limit": 3})
    assert first.status_code == 200, first.text
    page = first.json()
    assert len(page["events"]) == 3 and page["next"]
    second = await test_client.get(f"{PEOPLE}/usr_ann/events",
                                   params={"limit": 3, "before": page["next"]})
    assert {e["id"] for e in second.json()["events"]}.isdisjoint(
        {e["id"] for e in page["events"]})
    bad = await test_client.get(f"{PEOPLE}/usr_ann/events", params={"kinds": "nonsense"})
    assert bad.status_code == 422


async def test_private_view_names_are_withheld_from_those_who_cannot_open_them(
    test_client, db_session, restore_identity,
):
    now = datetime.now(timezone.utc)
    await _seed(db_session, now)
    _as(MEMBER, "usr_ann")
    day = (now - timedelta(days=1)).date().isoformat()
    body = (await test_client.get(f"{PEOPLE}/me/days/{day}")).json()
    peek = next(e for e in body["events"] if e["id"] == "val_peek")
    assert peek["view"]["locked"] and peek["view"]["name"] is None
    assert "Borealis secret" not in json.dumps(body)


async def test_looking_at_someone_else_is_recorded_once(test_client, db_session, restore_identity):
    await _seed(db_session, datetime.now(timezone.utc))

    async def _views():
        return (await db_session.execute(
            select(OutboxEventORM).where(
                OutboxEventORM.event_type == "platform.people_activity.viewed"))).scalars().all()

    assert (await test_client.get(f"{PEOPLE}/usr_ann", params={"days": 7})).status_code == 200
    assert (await test_client.get(f"{PEOPLE}/usr_ann", params={"days": 30})).status_code == 200
    recorded = await _views()
    assert len(recorded) == 1
    assert json.loads(recorded[0].payload)["target_id"] == "usr_ann"

    _as(MEMBER, "usr_dan")
    assert (await test_client.get(f"{PEOPLE}/me", params={"days": 7})).status_code == 200
    assert len(await _views()) == 1


# ── Telemetry: where it happened, and where in the app ────────────────


async def test_telemetry_keeps_a_workspace_only_when_the_caller_can_read_it(
    test_client, db_session, restore_identity,
):
    _as(MEMBER, "usr_dan")
    for ws in ("ws_a", "ws_elsewhere"):
        r = await test_client.post("/api/v1/telemetry/events", json={
            "type": "lineage.trace", "payload": {"nodes": 3}, "workspaceId": ws})
        assert r.status_code == 204
    got = [w for (w,) in (await db_session.execute(
        select(ProductEventORM.workspace_id).where(
            ProductEventORM.event_type == "lineage.trace",
            ProductEventORM.actor_id == "usr_dan"))).all()]
    assert sorted(got, key=str) == sorted(["ws_a", None], key=str)


async def test_app_section_names_a_known_section_only(test_client, db_session):
    for section in ("analytics", "../etc"):
        r = await test_client.post("/api/v1/telemetry/events", json={
            "type": "app.section", "payload": {"section": section}})
        assert r.status_code == 204
    subjects = [s for (s,) in (await db_session.execute(
        select(ProductEventORM.subject_id).where(
            ProductEventORM.event_type == "app.section"))).all()]
    assert sorted(subjects, key=str) == sorted(["analytics", None], key=str)


def test_the_kinds_are_the_clients_kinds():
    """``activityKinds.ts`` mirrors this list; the order is the charts' colour order."""
    assert repo.KINDS == ("signin", "browse", "trace", "search", "build", "operate", "other")


async def test_the_warmer_fills_the_roster_key_the_endpoint_reads(db_session, monkeypatch):
    """The People tab's platform roster is warmed into exactly the key a privileged reader
    looks up — the warmer and the endpoint must never disagree about it."""
    from backend.app.api.v1.endpoints.people_activity import roster_key
    from backend.app.services import analytics_warmer
    from backend.app.services.people_scope import PeopleAccess

    slot = analytics_cache.epoch_start()
    monkeypatch.setattr(analytics_cache, "epoch_start", lambda at=None: slot)
    await analytics_warmer.warm_once(db_session, ttl=900)
    for days in analytics_warmer.WARM_WINDOWS:
        key = roster_key({"days": days}, PeopleAccess(lens=repo.FULL, workspace_id=None), slot)
        assert analytics_cache._memory_get(key) is not None, f"people/{days}d not warmed"
