"""The Activity API: the ledger, read through two lenses.

Pinned here:

* every filter is applied in SQL, so a filtered page comes back FULL — the
  audit lens filtered people in Python after its LIMIT, and a page of fifty
  could come back with three rows, or none, while more existed;
* keyset pages walk the whole ledger without a gap or a repeat;
* a workspace admin's lens is forced to their workspace's workspace-audience
  events on the server: no parameter widens it, identity and platform events
  never appear in it, the raw payload is never sent, and the platform lens
  answers them 403;
* the people in it are named in one batched lookup per page — deleted
  accounts named and marked, unresolvable ids left bare, never invented;
* the live count counts what arrived since the page loaded, but not history
  the relay is still importing;
* the summary is a fixed handful of grouped reads, however much there is;
* an export is capped, safe to open in a spreadsheet, and itself recorded.
"""
from __future__ import annotations

import csv
import io
import json
import time
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select

from backend.app.auth.dependencies import get_permission_claims
from backend.app.db.models import AuthAuditLogORM, OutboxEventORM, UserORM, WorkspaceORM
from backend.app.services import analytics_cache
from backend.app.services.outbox_relay import drain_once
from backend.app.services.permission_service import PermissionClaims

API = "/api/v1/admin/activity"
NOW = datetime.now(timezone.utc)


@pytest.fixture(autouse=True)
def _fresh_cache():
    analytics_cache.clear()
    yield
    analytics_cache.clear()


def _at(minutes_ago: float) -> str:
    return (NOW - timedelta(minutes=minutes_ago)).isoformat()


async def _emit(db_session, event_type: str, payload: dict, *, minutes_ago: float = 1,
                version: int = 1, event_id: str | None = None) -> str:
    event_id = event_id or f"evt_{uuid.uuid4().hex[:12]}"
    db_session.add(OutboxEventORM(
        id=event_id, event_type=event_type, event_version=version,
        aggregate_type=event_type.split(".")[1], aggregate_id="agg",
        payload=json.dumps(payload), processed=False, created_at=_at(minutes_ago),
    ))
    return event_id


async def _relay(db_session) -> None:
    await db_session.flush()
    while await drain_once(db_session):
        pass
    await db_session.commit()


async def _person(db_session, uid: str, first: str, last: str, *, deleted: bool = False) -> None:
    db_session.add(UserORM(
        id=uid, email=f"{first.lower()}@example.com", password_hash="x",
        first_name=first, last_name=last, status="active",
        deleted_at=NOW.isoformat() if deleted else None,
    ))


async def _workspace(db_session, wid: str, name: str) -> None:
    db_session.add(WorkspaceORM(id=wid, name=name))


def _as(app, **claims):
    app.dependency_overrides[get_permission_claims] = lambda: PermissionClaims(
        sid="sess_test", **claims,
    )


@pytest.fixture
def app():
    from backend.app.main import app as _app
    return _app


async def _seed_mixed(db_session) -> None:
    """A little of everything, in two workspaces."""
    await _person(db_session, "usr_ada", "Ada", "Lovelace")
    await _person(db_session, "usr_bob", "Bob", "Builder")
    await _workspace(db_session, "ws_1", "Finance")
    await _workspace(db_session, "ws_2", "Marketing")
    await _emit(db_session, "aggregation.job.triggered", {
        "actor_id": "usr_ada", "workspace_id": "ws_1", "data_source_id": "ds_1",
        "target_type": "data_source", "target_id": "ds_1", "target_label": "Ledger",
        "stated_reason": "upstream fixed", "details": {"triggerSource": "manual"},
    }, version=2, minutes_ago=5)
    await _emit(db_session, "rbac.workspace.member_bound", {
        "actor_id": "usr_ada", "user_id": "usr_bob", "workspace_id": "ws_1", "role": "viewer",
    }, minutes_ago=6)
    await _emit(db_session, "aggregation.job.triggered", {
        "actor_id": "usr_bob", "workspace_id": "ws_2", "data_source_id": "ds_2",
        "target_type": "data_source", "target_id": "ds_2", "target_label": "Campaigns",
    }, version=2, minutes_ago=7)
    await _emit(db_session, "user.logged_in", {"user_id": "usr_ada"}, minutes_ago=8)
    await _emit(db_session, "rbac.group.member_added", {
        "actor_id": "usr_ada", "user_id": "usr_bob", "group_id": "grp_1", "workspace_id": "ws_1",
    }, minutes_ago=9)
    await _emit(db_session, "user.access_denied", {"user_id": "usr_bob"}, minutes_ago=10)
    await _relay(db_session)


async def _types(client, url: str) -> list[str]:
    res = await client.get(url)
    assert res.status_code == 200, res.text
    return [e["eventType"] for e in res.json()["events"]]


# ── The platform lens ───────────────────────────────────────────────


async def test_events_come_newest_first_with_people_and_places_named(
    test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    res = await test_client.get(f"{API}/events")
    assert res.status_code == 200, res.text
    body = res.json()
    events = body["events"]
    assert [e["occurredAt"] for e in events] == sorted(
        (e["occurredAt"] for e in events), reverse=True,
    )
    first = events[0]
    assert first["eventType"] == "aggregation.job.triggered"
    assert first["label"] == "Triggered aggregation"
    assert first["category"] == "operations"
    assert first["actor"] == {"id": "usr_ada", "name": "Ada Lovelace",
                              "email": "ada@example.com", "deleted": False}
    assert first["workspaceName"] == "Finance"
    assert first["target"] == {"type": "data_source", "id": "ds_1", "label": "Ledger"}
    assert first["statedReason"] == "upstream fixed"
    assert first["details"] == {"triggerSource": "manual"}
    assert first["payload"]["target_label"] == "Ledger"  # the full lens sees it
    bound = next(e for e in events if e["eventType"] == "rbac.workspace.member_bound")
    assert bound["subject"]["name"] == "Bob Builder"
    # The first page says how far the ledger trails the outbox.
    assert body["ledger"]["pending"] == 0
    assert body["ledger"]["watermark"]


async def test_per_request_refusals_are_left_out_unless_asked_for(
    test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    assert "user.access_denied" not in await _types(test_client, f"{API}/events")
    assert "user.access_denied" in await _types(test_client, f"{API}/events?includeNoise=true")


@pytest.mark.parametrize("query, expected", [
    ("category=operations", {"aggregation.job.triggered"}),
    ("category=access,identity", {"rbac.workspace.member_bound", "user.logged_in", "rbac.group.member_added"}),
    ("eventType=user.logged_in", {"user.logged_in"}),
    ("eventType=rbac.*", {"rbac.workspace.member_bound", "rbac.group.member_added"}),
    ("workspaceId=ws_2", {"aggregation.job.triggered"}),
    ("dataSourceId=ds_1", {"aggregation.job.triggered"}),
    ("targetType=group&targetId=grp_1", {"rbac.group.member_added"}),
    ("hasReason=true", {"aggregation.job.triggered"}),
    ("outcome=denied&includeNoise=true", {"user.access_denied"}),
    ("q=campaigns", {"aggregation.job.triggered"}),
])
async def test_each_filter_narrows_in_sql(test_client: AsyncClient, db_session, query, expected):
    await _seed_mixed(db_session)
    assert set(await _types(test_client, f"{API}/events?{query}")) == expected


async def test_a_person_filter_reads_a_name_and_a_role(test_client: AsyncClient, db_session):
    await _seed_mixed(db_session)
    # Bob did one thing and had two done to him.
    assert await _types(test_client, f"{API}/events?person=bob&personRole=actor") == [
        "aggregation.job.triggered",
    ]
    assert set(await _types(test_client, f"{API}/events?person=Bob%20Builder&personRole=subject")) == {
        "rbac.workspace.member_bound", "rbac.group.member_added",
    }
    assert len(await _types(test_client, f"{API}/events?person=usr_bob")) == 3
    # Text that matches nobody filters to nothing — never to everybody.
    assert await _types(test_client, f"{API}/events?person=nobody-at-all") == []


async def test_an_event_a_person_did_to_themselves_is_listed_once(
    test_client: AsyncClient, db_session,
):
    # A sign-in names its person as actor AND subject, so the "anyone
    # involved" filter reaches it by two scans.
    for i in range(3):
        await _emit(db_session, "user.logged_in", {"user_id": "usr_self"}, minutes_ago=i + 1)
    await _relay(db_session)
    ids = [e["id"] for e in (await test_client.get(f"{API}/events?person=usr_self")).json()["events"]]
    assert len(ids) == len(set(ids)) == 3


async def test_a_filtered_page_comes_back_full(test_client: AsyncClient, db_session):
    """The regression this API exists for: the old lens applied the person
    filter after its LIMIT, so a page could hold three rows while more
    existed."""
    await _person(db_session, "usr_needle", "Nee", "Dle")
    for i in range(90):
        actor = "usr_needle" if i % 3 == 0 else f"usr_hay{i}"
        await _emit(db_session, "rbac.group.updated", {"actor_id": actor, "group_id": "grp_x"},
                    minutes_ago=i + 1)
    await _relay(db_session)

    seen: list[str] = []
    cursor = None
    while True:
        url = f"{API}/events?person=usr_needle&personRole=actor&limit=10"
        res = await test_client.get(url + (f"&cursor={cursor}" if cursor else ""))
        body = res.json()
        page = body["events"]
        assert all(e["actor"]["id"] == "usr_needle" for e in page)
        if body["nextCursor"]:
            assert len(page) == 10, "a filtered page came back short while more existed"
        seen += [e["id"] for e in page]
        cursor = body["nextCursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 30


async def test_pages_walk_the_ledger_without_gaps_or_repeats(test_client: AsyncClient, db_session):
    for i in range(23):
        # Several share a timestamp: the id breaks the tie.
        await _emit(db_session, "user.logged_in", {"user_id": f"usr_{i}"}, minutes_ago=i // 3)
    await _relay(db_session)
    seen, cursor = [], None
    while True:
        res = await test_client.get(f"{API}/events?limit=5" + (f"&cursor={cursor}" if cursor else ""))
        seen += [e["id"] for e in res.json()["events"]]
        cursor = res.json()["nextCursor"]
        if not cursor:
            break
    assert len(seen) == len(set(seen)) == 23
    assert (await test_client.get(f"{API}/events?cursor=garbage")).status_code == 400


async def test_free_text_search_is_held_to_a_bounded_window(test_client: AsyncClient, db_session):
    assert (await test_client.get(f"{API}/events?q=x&days=365")).status_code == 422
    assert (await test_client.get(f"{API}/events?q=x&days=92")).status_code == 200
    assert (await test_client.get(f"{API}/events?category=nonsense")).status_code == 422


async def test_names_are_resolved_once_per_page_and_never_invented(
    test_client: AsyncClient, db_session, db_engine,
):
    await _person(db_session, "usr_gone", "Grace", "Hopper", deleted=True)
    for i in range(12):
        await _emit(db_session, "rbac.group.member_added", {
            "actor_id": "usr_gone", "user_id": f"usr_ghost{i}", "group_id": "grp_1",
        }, minutes_ago=i + 1)
    await _relay(db_session)

    statements: list[str] = []

    def _count(conn, cursor, statement, *a):
        statements.append(statement)

    event.listen(db_engine.sync_engine, "before_cursor_execute", _count)
    try:
        res = await test_client.get(f"{API}/events?limit=50")
    finally:
        event.remove(db_engine.sync_engine, "before_cursor_execute", _count)
    events = res.json()["events"]
    assert events[0]["actor"] == {"id": "usr_gone", "name": "Grace Hopper",
                                  "email": "grace@example.com", "deleted": True}
    # A subject nobody can name stays a bare id.
    assert events[0]["subject"] == {"id": events[0]["subject"]["id"], "name": None,
                                    "email": None, "deleted": False}
    people_reads = [s for s in statements if "FROM users" in s and "users.deleted_at" in s
                    and "users.avatar_id" in s]
    assert len(people_reads) == 1, "people must be named in one batched read per page"


# ── The workspace lens ──────────────────────────────────────────────


async def test_a_workspace_admin_sees_only_their_workspace_operations(
    app, test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    _as(app, global_perms=(), ws_perms={"ws_1": ("workspace:admin",)})

    url = "/api/v1/admin/workspaces/ws_1/activity/events"
    res = await test_client.get(url)
    assert res.status_code == 200, res.text
    events = res.json()["events"]
    assert {e["eventType"] for e in events} == {
        "aggregation.job.triggered", "rbac.workspace.member_bound",
    }
    assert all(e["workspaceId"] == "ws_1" for e in events)
    assert all(e["payload"] is None for e in events)
    # No parameter widens it: not another workspace, not a category it
    # excludes, not the noise switch.
    assert await _types(test_client, f"{url}?workspaceId=ws_2") == await _types(test_client, url)
    assert await _types(test_client, f"{url}?category=identity&includeNoise=true") == []
    # Another workspace's lens, and the platform's, are closed to them.
    assert (await test_client.get("/api/v1/admin/workspaces/ws_2/activity/events")).status_code == 403
    assert (await test_client.get(f"{API}/events")).status_code == 403


async def test_an_event_outside_the_workspace_is_not_found_there(
    app, test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    login = (await db_session.execute(
        select(AuthAuditLogORM.id).where(AuthAuditLogORM.event_type == "user.logged_in")
    )).scalar_one()
    _as(app, global_perms=(), ws_perms={"ws_1": ("workspace:admin",)})
    res = await test_client.get(f"/api/v1/admin/workspaces/ws_1/activity/events/{login}")
    assert res.status_code == 404


async def test_the_workspace_catalogue_lists_only_what_it_can_show(app, test_client: AsyncClient):
    _as(app, global_perms=(), ws_perms={"ws_1": ("workspace:admin",)})
    res = await test_client.get("/api/v1/admin/workspaces/ws_1/activity/catalogue")
    types = {e["type"] for e in res.json()["eventTypes"]}
    assert "aggregation.job.triggered" in types
    assert not any(t.startswith(("user.", "rbac.group.", "idp.")) for t in types)


async def test_an_auditor_reads_the_platform_lens(app, test_client: AsyncClient, db_session):
    await _seed_mixed(db_session)
    _as(app, global_perms=("system:audit:read",), ws_perms={})
    assert (await test_client.get(f"{API}/events")).status_code == 200
    _as(app, global_perms=("workspace:viewer",), ws_perms={})
    assert (await test_client.get(f"{API}/events")).status_code == 403


# ── One event, and what happened with it ────────────────────────────


async def test_an_event_brings_its_request_and_its_target(test_client: AsyncClient, db_session):
    for i, event_type in enumerate(("rbac.group.member_added", "rbac.group.member_added")):
        await _emit(db_session, event_type, {
            "actor_id": "usr_a", "user_id": f"usr_{i}", "group_id": "grp_1",
            "correlation_id": "req_bulk",
        }, minutes_ago=2 + i)
    await _emit(db_session, "rbac.group.updated", {"actor_id": "usr_a", "group_id": "grp_1"},
                minutes_ago=30)
    await _relay(db_session)
    newest = (await test_client.get(f"{API}/events")).json()["events"][0]

    res = await test_client.get(f"{API}/events/{newest['id']}")
    assert res.status_code == 200
    body = res.json()
    assert body["event"]["id"] == newest["id"]
    assert [e["correlationId"] for e in body["sameRequest"]] == ["req_bulk"]
    assert {e["eventType"] for e in body["sameTarget"]} == {
        "rbac.group.member_added", "rbac.group.updated",
    }
    assert (await test_client.get(f"{API}/events/aud_nope")).status_code == 404


# ── Live ────────────────────────────────────────────────────────────


async def test_the_live_count_is_news_not_history(test_client: AsyncClient, db_session):
    await _emit(db_session, "user.logged_in", {"user_id": "usr_1"}, minutes_ago=3)
    await _relay(db_session)
    watermark = (await test_client.get(f"{API}/events")).json()["ledger"]["watermark"]

    await _emit(db_session, "user.logged_in", {"user_id": "usr_2"}, minutes_ago=0)
    # History the relay imports now: recorded after the watermark, but it
    # happened long before it.
    await _emit(db_session, "user.logged_in", {"user_id": "usr_3"}, minutes_ago=60 * 24 * 30)
    await _relay(db_session)

    res = await test_client.get(f"{API}/events/newer", params={"since": watermark})
    assert res.json() == {"count": 1, "capped": False}
    assert (await test_client.get(f"{API}/events/newer", params={"since": "nope"})).status_code == 400


# ── Summary ─────────────────────────────────────────────────────────


def _redis_in_memory(monkeypatch) -> dict:
    """Folds live in Redis only; give the test one."""
    store: dict = {}

    async def _get(key):
        expires, value = store.get(key, (0.0, None))
        return value if time.monotonic() < expires else None

    async def _set(key, value, ttl=None):
        store[key] = (time.monotonic() + (ttl or 300.0), json.loads(json.dumps(value)))
        return True

    monkeypatch.setattr(analytics_cache, "_redis_get", _get)
    monkeypatch.setattr(analytics_cache, "_redis_set", _set)
    return store


async def test_the_summary_describes_the_window_in_a_fixed_number_of_reads(
    test_client: AsyncClient, db_session, db_engine, monkeypatch,
):
    from backend.app.api.v1.endpoints import activity
    from backend.app.db.repositories import activity_repo

    # Every request builds its document; only the folds of closed days carry
    # over, which is the reuse under test. (And a span is reusable the moment
    # it closes, so the test does not depend on the time of day.)
    monkeypatch.setattr(activity, "_SUMMARY_TTL_SECONDS", 0.000001)
    monkeypatch.setattr(activity_repo, "_SETTLE", timedelta(0))
    _redis_in_memory(monkeypatch)
    await _seed_mixed(db_session)
    for i in range(4):
        await _emit(db_session, "aggregation.job.triggered", {
            "actor_id": "usr_ada", "workspace_id": "ws_1", "data_source_id": "ds_1",
            "target_type": "data_source", "target_id": "ds_1", "target_label": "Ledger",
        }, version=2, minutes_ago=60 * 24 * (i + 1))
    await _relay(db_session)

    async def _summary_reads() -> tuple[dict, int]:
        statements: list[str] = []

        def _count(conn, cursor, statement, *a):
            if statement.lstrip().upper().startswith("SELECT"):
                statements.append(statement)

        event.listen(db_engine.sync_engine, "before_cursor_execute", _count)
        try:
            res = await test_client.get(f"{API}/summary?days=30")
        finally:
            event.remove(db_engine.sync_engine, "before_cursor_execute", _count)
        assert res.status_code == 200, res.text
        return res.json(), len(statements)

    doc, cold = await _summary_reads()
    again, warm = await _summary_reads()
    # A fixed number of grouped reads, however many rows the window holds…
    assert cold <= 18, f"the summary fanned out into {cold} reads"
    # …and once the closed days are folded, a request reads today, and names.
    assert warm <= 10, f"a warm summary still made {warm} reads"
    assert again["totals"] == doc["totals"]

    assert doc["totals"]["events"]["current"] == 9  # noise excluded
    assert doc["totals"]["operations"]["current"] == 6
    assert doc["totals"]["reasons"] == {"given": 1, "of": 8, "share": 0.125}
    assert sum(map(sum, doc["punchcard"])) == 9
    assert {s["category"] for s in doc["volume"]} == {"operations", "access", "identity"}
    assert doc["topPeople"][0]["id"] == "usr_ada"
    assert doc["topPeople"][0]["name"] == "Ada Lovelace"
    ledger = next(s for s in doc["handsOnSources"] if s["dataSourceId"] == "ds_1")
    assert ledger["count"] == 5
    assert ledger["workspaceName"] == "Finance"
    assert ledger["medianGapHours"] is not None
    assert doc["topActions"][0] == {
        "type": "aggregation.job.triggered", "count": 6,
        "label": "Triggered aggregation", "category": "operations",
    }
    assert doc["topReasons"] == [{"reason": "upstream fixed", "count": 1}]


async def test_closed_days_are_not_reused_while_history_is_still_arriving(
    test_client: AsyncClient, db_session, monkeypatch,
):
    """Right after an upgrade the relay imports history newest-first, into
    days that are already over. A fold of them reused now would stay short
    until midnight."""
    from backend.app.api.v1.endpoints import activity
    from backend.app.db.repositories import activity_repo

    monkeypatch.setattr(activity, "_SUMMARY_TTL_SECONDS", 0.000001)
    monkeypatch.setattr(activity_repo, "_SETTLE", timedelta(0))
    monkeypatch.setattr(activity_repo, "_BACKFILL_PENDING", 1)
    _redis_in_memory(monkeypatch)
    await _emit(db_session, "user.logged_in", {"user_id": "usr_1"}, minutes_ago=60 * 24 * 2)
    await _relay(db_session)
    # One event still waiting in the outbox: the relay is "importing".
    await _emit(db_session, "user.logged_in", {"user_id": "usr_2"}, minutes_ago=60 * 24 * 3)
    await db_session.commit()
    first = (await test_client.get(f"{API}/summary?days=30")).json()
    assert first["totals"]["events"]["current"] == 1

    await _relay(db_session)
    second = (await test_client.get(f"{API}/summary?days=30")).json()
    assert second["totals"]["events"]["current"] == 2


async def test_a_workspace_summary_counts_only_that_workspace(
    app, test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    _as(app, global_perms=(), ws_perms={"ws_1": ("workspace:admin",)})
    res = await test_client.get("/api/v1/admin/workspaces/ws_1/activity/summary")
    assert res.json()["totals"]["events"]["current"] == 2


# ── Export ──────────────────────────────────────────────────────────


async def test_an_export_is_capped_safe_to_open_and_recorded(
    test_client: AsyncClient, db_session, monkeypatch,
):
    from backend.app.api.v1.endpoints import activity

    for i in range(5):
        await _emit(db_session, "rbac.group.created", {
            "actor_id": "usr_a", "group_id": f"grp_{i}", "group_name": "=HYPERLINK(\"x\")",
        }, minutes_ago=i + 1)
    await _relay(db_session)
    monkeypatch.setattr(activity, "_EXPORT_CAP", 3)

    res = await test_client.get(f"{API}/export.csv")
    assert res.status_code == 200, res.text
    assert res.headers["content-type"].startswith("text/csv")
    rows = list(csv.reader(io.StringIO(res.text)))
    assert rows[0][:3] == ["occurredAt", "eventType", "label"]
    assert len(rows) == 1 + 3
    label = rows[1][rows[0].index("targetLabel")]
    assert label.startswith("'="), "a formula in a cell must not run in a spreadsheet"

    recorded = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.event_type == "platform.activity.exported")
    )).scalars().one()
    payload = json.loads(recorded.payload)
    assert payload["actor_id"] == "usr_test000000"
    assert payload["details"]["format"] == "csv"


# ── Directory: names for ids, for everyone ──────────────────────────


async def test_the_directory_names_people_by_id(test_client: AsyncClient, db_session):
    await _person(db_session, "usr_ada", "Ada", "Lovelace")
    await _person(db_session, "usr_gone", "Grace", "Hopper", deleted=True)
    await db_session.commit()
    res = await test_client.get("/api/v1/directory/people?ids=usr_gone,usr_nobody,usr_ada")
    assert res.status_code == 200
    assert res.json() == [
        {"id": "usr_gone", "displayName": "Grace Hopper", "email": None,
         "deleted": True, "avatarId": None},
        {"id": "usr_ada", "displayName": "Ada Lovelace", "email": "ada@example.com",
         "deleted": False, "avatarId": None},
    ]
    many = ",".join(f"usr_{i}" for i in range(101))
    assert (await test_client.get(f"/api/v1/directory/people?ids={many}")).status_code == 422
