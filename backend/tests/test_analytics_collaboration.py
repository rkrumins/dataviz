"""Analytics · Collaboration — questions and conversations on views and sources.

Seeds threads in the window, in the window before it and long before both,
plus the ones that must never count: deleted, archived, and on a subject that
was soft-deleted. Then asserts the KPIs and medians, the deltas, the rankings,
and what a non-privileged reader is (and is not) told.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from backend.app.db.models import (
    DiscussionMessageORM,
    DiscussionORM,
    UserORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
    ProviderORM,
)
from backend.app.db.repositories import analytics_collaboration_repo as collab
from backend.app.db.repositories import analytics_repo
from backend.app.services import analytics_cache
from backend.app.services.analytics_scope import PrivacyMode, ViewerScope

NOW = datetime(2026, 6, 15, 12, 0, tzinfo=timezone.utc)

SECRET = "Secret question text"
PRIVATE_BACKLOG = "Private backlog text"


@pytest.fixture(autouse=True)
def _isolated():
    analytics_cache.clear()
    yield
    analytics_cache.clear()


def _t(day: str, hour: int = 10) -> str:
    return f"2026-{day}T{hour:02d}:00:00+00:00"


def _thread(tid, subject_type, subject_id, created, *, asked_by="usr_ask1", visibility="open",
            status="open", first_response=None, resolved=None, answer=None, messages=1,
            excerpt=None, deleted=None, archived=None):
    return DiscussionORM(
        id=tid, subject_type=subject_type, subject_id=subject_id, visibility=visibility,
        status=status, asked_by=asked_by, excerpt=excerpt or f"Question {tid}",
        answer_message_id=answer, resolved_at=resolved, resolved_by="usr_ans1" if resolved else None,
        message_count=messages, participant_count=1, last_activity_at=created,
        last_message_by=asked_by, first_response_at=first_response, created_at=created,
        updated_at=created, deleted_at=deleted, archived_at=archived,
    )


def _reply(mid, thread, author, at, *, deleted=None, kind="reply"):
    return DiscussionMessageORM(
        id=mid, discussion_id=thread, kind=kind, author_id=author, body=f"Body {mid}",
        created_at=at, deleted_at=deleted,
    )


async def _seed(session):
    session.add_all([
        WorkspaceORM(id="ws_a", name="Alpha"),
        WorkspaceORM(id="ws_b", name="Beta"),
        ProviderORM(id="prov", name="Prod", provider_type="falkordb"),
        UserORM(id="usr_ask1", email="asha@x.io", password_hash="x", first_name="Asha",
                last_name="Asker", status="active"),
        UserORM(id="usr_ask2", email="bo@x.io", password_hash="x", first_name="Bo",
                last_name="Asker", status="active"),
        UserORM(id="usr_ans1", email="ana@x.io", password_hash="x", first_name="Ana",
                last_name="Answer", status="active"),
        UserORM(id="usr_ans2", email="ian@x.io", password_hash="x", first_name="Ian",
                last_name="Answer", status="active"),
        ViewORM(id="view_a", name="Revenue lineage", workspace_id="ws_a",
                created_by="usr_ans1", visibility="workspace"),
        ViewORM(id="view_b", name="Beta board", workspace_id="ws_b",
                created_by="usr_ans2", visibility="private"),
        ViewORM(id="view_gone", name="Trashed", workspace_id="ws_a",
                created_by="usr_ans1", deleted_at=_t("06-09")),
        WorkspaceDataSourceORM(id="ds_a", workspace_id="ws_a", provider_id="prov",
                               graph_name="g1", label="Ledger"),
        WorkspaceDataSourceORM(id="ds_b", workspace_id="ws_b", provider_id="prov",
                               graph_name="g2", label="Catalog"),
        WorkspaceDataSourceORM(id="ds_gone", workspace_id="ws_a", provider_id="prov",
                               graph_name="g3", label="Archive", deleted_at=_t("06-09")),
    ])
    session.add_all([
        # ── This window: 06-08 12:00 → 06-15 12:00 ──
        _thread("t1", "view", "view_a", _t("06-10"), first_response=_t("06-10", 12),
                status="answered", resolved=_t("06-10", 20), answer="m1", messages=3),
        _thread("t2", "view", "view_a", _t("06-12", 9), asked_by="usr_ask2",
                first_response=_t("06-12", 13), messages=2),
        _thread("t3", "data_source", "ds_a", _t("06-13", 8), visibility="private",
                first_response=_t("06-13", 14), status="answered", resolved=_t("06-14", 8),
                answer="m3", messages=2, excerpt=SECRET),
        _thread("t4", "view", "view_b", _t("06-14"), asked_by="usr_ask2"),
        # Never counted: deleted, archived, on a soft-deleted view, on a soft-deleted source.
        _thread("t_del", "view", "view_a", _t("06-11"), deleted=_t("06-11", 12), messages=2),
        _thread("t_arch", "view", "view_a", _t("06-11"), archived=_t("06-12")),
        _thread("t_gone", "view", "view_gone", _t("06-11")),
        _thread("t_dsgone", "data_source", "ds_gone", _t("06-11")),
        # ── The window before: 06-01 12:00 → 06-08 12:00 ──
        _thread("p1", "view", "view_a", _t("06-03"), first_response=_t("06-03", 18),
                status="answered", resolved=_t("06-04"), answer="mp1", messages=2),
        _thread("p2", "data_source", "ds_b", _t("06-05"), asked_by="usr_ask2"),
        # ── Long before ──
        _thread("old1", "data_source", "ds_a", _t("05-01"),
                excerpt="Where does the ledger come from?"),
        _thread("old2", "view", "view_b", _t("05-20"), visibility="private", excerpt=PRIVATE_BACKLOG),
        _thread("old_closed", "view", "view_a", _t("04-01"), status="closed", resolved=_t("04-02")),
    ])
    session.add_all([
        _reply("q1", "t1", "usr_ask1", _t("06-10"), kind="question"),
        _reply("m1", "t1", "usr_ans1", _t("06-10", 12)),
        # The asker following up on their own question: a reply, not an answer.
        _reply("m1b", "t1", "usr_ask1", _t("06-10", 13)),
        _reply("m2", "t2", "usr_ans2", _t("06-12", 13)),
        _reply("m_del", "t2", "usr_ans1", _t("06-12", 15), deleted=_t("06-12", 16)),
        _reply("m3", "t3", "usr_ans2", _t("06-13", 14)),
        _reply("m_in_deleted", "t_del", "usr_ans1", _t("06-11", 11)),
        _reply("mp1", "p1", "usr_ans1", _t("06-03", 18)),
    ])
    await session.commit()


async def _doc(session, days=7):
    return await collab.collaboration_doc(session, days=days, now=NOW)


# ── KPIs ─────────────────────────────────────────────────────────────

async def test_kpis_count_the_window_against_the_one_before(db_session):
    await _seed(db_session)
    k = (await _doc(db_session))["kpis"]

    # t1..t4 against p1, p2. All time: every live thread on a live subject.
    assert k["asked"] == {"total": 9, "current": 4, "previous": 2, "changePct": 100.0}
    # Of those asked: t1 and t3 have an accepted answer; p1 of the two before.
    assert k["answerRate"] == {"current": 0.5, "previous": 0.5, "answered": 2}
    # First replies by someone other than the asker: 2h, 4h, 6h; 8h before.
    assert k["firstResponseHours"] == {
        "current": 4.0, "previous": 8.0, "changePct": -50.0, "measured": 3,
    }
    # Accepted: 10h and 24h; 24h before.
    assert k["answerHours"]["current"] == 17.0 and k["answerHours"]["previous"] == 24.0
    assert k["answerHours"]["measured"] == 2
    # Open and older than a week as of now: p2, old1, old2.
    assert k["waitingOverWeek"] == {"total": 3}
    assert k["open"] == {"total": 5}
    assert k["askers"]["current"] == 2 and k["askers"]["previous"] == 2
    # Ana and Ian replied to someone else's question; Asha's follow-up on her
    # own does not make her an answerer.
    assert k["answerers"]["current"] == 2 and k["answerers"]["previous"] == 1
    # m1, m1b, m2, m3 — not the deleted reply, not the reply in a deleted thread.
    assert k["replies"]["current"] == 4 and k["replies"]["previous"] == 1
    assert k["privateShare"] == {"current": 0.25, "previous": 0.0}


async def test_series_count_questions_by_the_day_they_were_asked(db_session):
    await _seed(db_session)
    series = (await _doc(db_session))["series"]

    days = series["buckets"]
    assert days[0] == "2026-06-08" and days[-1] == "2026-06-15"
    asked = dict(zip(days, series["asked"]))
    answered = dict(zip(days, series["answered"]))
    assert {d: n for d, n in asked.items() if n} == {
        "2026-06-10": 1, "2026-06-12": 1, "2026-06-13": 1, "2026-06-14": 1,
    }
    assert {d: n for d, n in answered.items() if n} == {"2026-06-10": 1, "2026-06-13": 1}
    # The series and the KPIs are the same count.
    assert sum(series["asked"]) == 4 and sum(series["answered"]) == 2


async def test_deleted_archived_and_orphaned_threads_never_count(db_session):
    await _seed(db_session)
    doc = await _doc(db_session)

    ids = {row["subjectId"] for row in doc["leaderboards"]["waiting"]}
    assert "view_gone" not in ids and "ds_gone" not in ids
    views = {v["viewId"]: v for v in doc["leaderboards"]["views"]}
    # t_del and t_arch were on view_a too, and its reply in the deleted thread.
    assert views["view_a"]["questions"] == 2 and views["view_a"]["replies"] == 3
    assert "view_gone" not in views


# ── Leaderboards ─────────────────────────────────────────────────────

async def test_most_discussed_views_and_sources_rank_by_questions_and_replies(db_session):
    await _seed(db_session)
    boards = (await _doc(db_session))["leaderboards"]

    assert [(v["viewId"], v["messages"]) for v in boards["views"]] == [("view_a", 5), ("view_b", 1)]
    view_a = boards["views"][0]
    assert view_a["name"] == "Revenue lineage" and view_a["workspaceName"] == "Alpha"
    assert view_a["answered"] == 1 and view_a["open"] == 1
    # view_b: t4 this window, old2 still open from before.
    assert boards["views"][1]["open"] == 2

    # ds_b's only question was in the window before: nothing to rank it on.
    assert [(s["dataSourceId"], s["questions"], s["replies"]) for s in boards["sources"]] == [
        ("ds_a", 1, 1),
    ]
    assert boards["sources"][0]["workspaceId"] == "ws_a" and boards["sources"][0]["open"] == 1


async def test_workspaces_rank_by_questions_with_their_answer_rate_and_first_reply(db_session):
    await _seed(db_session)
    rows = (await _doc(db_session))["leaderboards"]["workspaces"]

    assert [(r["workspaceId"], r["questions"]) for r in rows] == [("ws_a", 3), ("ws_b", 1)]
    assert rows[0]["name"] == "Alpha"
    assert rows[0]["answerRate"] == pytest.approx(0.667, abs=1e-3)
    assert rows[0]["firstResponseHours"] == 4.0
    assert rows[1]["answerRate"] == 0.0 and rows[1]["firstResponseHours"] is None


async def test_people_who_answer_most_rank_by_accepted_answers_then_replies(db_session):
    await _seed(db_session)
    rows = (await _doc(db_session))["leaderboards"]["answerers"]

    assert [(r["userId"], r["accepted"], r["replies"]) for r in rows] == [
        ("usr_ans2", 1, 2), ("usr_ans1", 1, 1),
    ]
    assert rows[0]["name"] == "Ian Answer"


async def test_longest_waiting_questions_oldest_first_and_private_ones_carry_no_text(db_session):
    await _seed(db_session)
    rows = (await _doc(db_session))["leaderboards"]["waiting"]

    assert [r["discussionId"] for r in rows] == ["old1", "old2", "p2", "t2", "t4"]
    old1, old2 = rows[0], rows[1]
    assert old1["subjectName"] == "Ledger" and old1["workspaceName"] == "Alpha"
    assert old1["ageDays"] == 45 and old1["replies"] == 0
    assert old1["excerpt"] == "Where does the ledger come from?"
    assert old1["askedByName"] == "Asha Asker"
    # A private question's text is never in the document, even for an admin.
    assert old2["excerpt"] is None
    assert rows[3]["replies"] == 1


async def test_private_threads_never_put_their_text_in_the_document(db_session):
    await _seed(db_session)
    raw = json.dumps(await _doc(db_session))
    assert SECRET not in raw and PRIVATE_BACKLOG not in raw


# ── Redaction ────────────────────────────────────────────────────────

def _member_of_alpha(privacy=PrivacyMode.INTERNAL):
    return ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}),
        privacy=privacy, user_id="usr_someone",
    )


async def test_a_reader_sees_platform_totals_and_only_their_workspaces_by_name(db_session):
    await _seed(db_session)
    doc = await _doc(db_session)
    seen = collab.redact_collaboration(doc, _member_of_alpha())

    assert seen["kpis"] == doc["kpis"] and seen["series"] == doc["series"]
    boards = seen["leaderboards"]
    views = boards["views"]
    assert views[0]["name"] == "Revenue lineage" and views[0]["canOpen"] is True
    hidden = views[1]
    assert hidden["redacted"] is True and hidden["name"] == analytics_repo.REDACTED_VIEW
    assert hidden["viewId"] is None and hidden["workspaceName"] == analytics_repo.REDACTED_WORKSPACE
    assert hidden["messages"] == 1, "the counts stay: they are what ranks it"
    assert "createdBy" not in views[0] and "createdBy" not in hidden
    ws = {r["name"]: r for r in boards["workspaces"]}
    assert ws["Alpha"]["canOpen"] is True
    assert ws[analytics_repo.REDACTED_WORKSPACE]["redacted"] is True
    assert seen["redaction"]["applied"] is True


async def test_a_reader_is_never_shown_who_answers_or_what_was_asked(db_session):
    await _seed(db_session)
    doc = await _doc(db_session)
    # Even at the level that names colleagues elsewhere.
    seen = collab.redact_collaboration(doc, _member_of_alpha(PrivacyMode.FULL))

    assert seen["leaderboards"]["answerers"] == []
    waiting = {r["discussionId"] if r.get("discussionId") else f"#{i}": r
               for i, r in enumerate(seen["leaderboards"]["waiting"])}
    for row in seen["leaderboards"]["waiting"]:
        assert "excerpt" not in row and "askedByName" not in row
    assert waiting["old1"]["subjectName"] == "Ledger" and waiting["old1"]["canOpen"] is True
    # A question in Beta, which they cannot see, keeps its age and loses its subject.
    beta = [r for r in seen["leaderboards"]["waiting"] if r.get("redacted")]
    assert len(beta) == 3
    assert all(r["subjectName"] is None and r["discussionId"] is None for r in beta)
    assert sorted(r["ageDays"] for r in beta) == [1, 10, 26]
    raw = json.dumps(seen)
    assert "Where does the ledger come from?" not in raw and "Asha" not in raw
    # The shared, cached original still has what an administrator is shown.
    assert doc["leaderboards"]["waiting"][0]["excerpt"] == "Where does the ledger come from?"
    assert doc["leaderboards"]["answerers"]


async def test_a_private_question_in_a_visible_workspace_is_counted_but_not_described(db_session):
    await _seed(db_session)
    doc = await _doc(db_session)
    reader = ViewerScope(privileged=False, visible_workspaces=frozenset({"ws_a", "ws_b"}),
                         privacy=PrivacyMode.INTERNAL)
    rows = collab.redact_collaboration(doc, reader)["leaderboards"]["waiting"]

    old2 = next(r for r in rows if r["ageDays"] == 26)
    assert old2["redacted"] is True and old2["subjectName"] is None and old2["private"] is True


# ── The endpoint ─────────────────────────────────────────────────────

@pytest.fixture
def _flags():
    from backend.app.services.feature_flags import feature_flags
    feature_flags.invalidate()
    yield
    feature_flags.invalidate()


def _prime(**values):
    import time as _time

    from backend.app.services.feature_flags import feature_flags
    feature_flags._cache = dict(values)
    feature_flags._cache_ts = _time.monotonic()


async def _get(test_client, perms, ws=None, url="/api/v1/admin/analytics/collaboration?days=7"):
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.main import app
    from backend.app.services.permission_service import PermissionClaims

    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", global_perms=perms, ws_perms=ws or {},
    )
    try:
        return await test_client.get(url)
    finally:
        app.dependency_overrides.pop(get_permission_claims, None)


async def test_one_cached_document_serves_every_reader_redacted_for_each(
    test_client, db_session, _flags, monkeypatch,
):
    await _seed(db_session)
    _prime(analyticsPublicEnabled=True, analyticsPrivacyMode="internal")
    monkeypatch.setattr(analytics_cache, "epoch_start", lambda at=None: NOW)
    builds = 0
    real = collab.collaboration_doc

    async def counting(*args, **kwargs):
        nonlocal builds
        builds += 1
        return await real(*args, **kwargs)

    monkeypatch.setattr(collab, "collaboration_doc", counting)

    admin = await _get(test_client, ("system:admin",))
    member = await _get(test_client, (), {"ws_a": ("workspace:view:read",)})
    assert admin.status_code == member.status_code == 200
    assert builds == 1, f"one window, one aggregation — ran {builds}"
    a, m = admin.json(), member.json()
    assert "redaction" not in a and m["redaction"]["applied"] is True
    assert a["kpis"] == m["kpis"]
    assert a["leaderboards"]["answerers"] and m["leaderboards"]["answerers"] == []


async def test_the_endpoint_refuses_everyone_else_while_analytics_is_closed(
    test_client, db_session, _flags,
):
    _prime(analyticsPublicEnabled=False)
    assert (await _get(test_client, ())).status_code == 403
    assert (await _get(test_client, ("system:analytics:read",))).status_code == 200


async def test_a_bad_range_is_a_422(test_client, db_session, _flags):
    res = await _get(test_client, ("system:admin",),
                     url="/api/v1/admin/analytics/collaboration?from=2026-06-10&to=2026-06-01")
    assert res.status_code == 422


async def test_the_document_is_a_bounded_number_of_reads(db_session):
    await _seed(db_session)
    issued = []
    original = db_session.execute

    async def _recording(stmt, *a, **kw):
        issued.append(stmt)
        return await original(stmt, *a, **kw)

    db_session.execute = _recording
    try:
        await collab.collaboration_doc(db_session, days=365, now=NOW)
    finally:
        db_session.execute = original
    assert len(issued) <= 10, f"{len(issued)} reads"


async def test_an_empty_platform_says_none_rather_than_zero(db_session):
    doc = await _doc(db_session)
    k = doc["kpis"]
    assert k["asked"]["total"] == 0
    assert k["answerRate"]["current"] is None and k["firstResponseHours"]["current"] is None
    assert k["privateShare"]["current"] is None
    assert all(not rows for rows in doc["leaderboards"].values())


# ── The workspace drill-in, and the summary's findings ────────────────

async def test_the_drill_in_carries_the_workspaces_questions(db_session):
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(db_session, "ws_a", days=7, now=NOW)
    c = detail["collaboration"]

    assert c["asked"]["current"] == 3 and c["asked"]["previous"] == 1
    assert c["answerRate"]["current"] == pytest.approx(0.667, abs=1e-3)
    assert c["firstResponseHours"]["current"] == 4.0
    assert c["waitingOverWeek"] == {"total": 1}
    assert [v["viewId"] for v in c["views"]] == ["view_a"]
    assert [s["dataSourceId"] for s in c["sources"]] == ["ds_a"]


async def test_the_drill_in_names_views_as_reporting_allows_and_links_only_what_opens(db_session):
    await _seed(db_session)
    detail = await analytics_repo.workspace_detail(db_session, "ws_b", days=7, now=NOW)
    assert [v["name"] for v in detail["collaboration"]["views"]] == ["Beta board"]

    # Reported, not openable: named, never linked.
    reported = ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}),
        reports_all_workspaces=True, privacy=PrivacyMode.INTERNAL,
    )
    seen = analytics_repo.redact_workspace_detail(detail, reported)["collaboration"]
    view, source = seen["views"][0], seen["sources"]
    assert view["name"] == "Beta board" and view["canOpen"] is False
    assert "createdBy" not in view
    assert source == [] and seen["asked"] == detail["collaboration"]["asked"]

    # A reader who may not see it at all gets the counts and no name.
    member = ViewerScope(privileged=False, visible_workspaces=frozenset({"ws_a"}))
    hidden = analytics_repo.redact_workspace_detail(detail, member)["collaboration"]["views"][0]
    assert hidden["redacted"] is True and hidden["name"] == analytics_repo.REDACTED_VIEW
    assert hidden["messages"] == 1


async def test_the_summary_says_how_many_questions_have_waited_a_week(db_session):
    await _seed(db_session)
    doc = await analytics_repo.platform_summary(db_session, days=7, now=NOW)

    found = {i["key"]: i for i in doc["insights"]}
    assert found["questions-waiting"]["headline"] == "3 questions have waited over a week"
    assert found["questions-waiting"]["tab"] == "collaboration"
    assert "Revenue lineage" in found["most-discussed"]["headline"]

    # Counts are public; a finding that names a view is not.
    strict = analytics_repo.redact_summary(doc, ViewerScope(
        privileged=False, visible_workspaces=frozenset({"ws_a"}),
    ))
    keys = {i["key"] for i in strict["insights"]}
    assert "questions-waiting" in keys and "most-discussed" not in keys
