"""A view's saved narrowings over HTTP: ``/views/{id}/narrowings``.

Anyone who can read the view lists them, opens one and reads the URNs it held;
any signed-in reader saves one; only whoever saved it, or an editor of the view,
changes or removes it. A view the caller can't read answers 404. A share-link
reader (the view, but not its workspace's data) can't save a query seed they
couldn't run. What it held is kept sorted, each URN once, gzipped the same way
every time, and is refused when it would unzip to too much.
"""
import base64
import contextlib
import gzip
import os
import re
import time

import pytest
from httpx import AsyncClient
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from backend.app.auth.dependencies import get_current_user, get_optional_user, get_permission_claims
from backend.app.db.engine import Base
from backend.app.db.models import ViewORM, ViewSavedNarrowingORM, WorkspaceORM
from backend.app.db.repositories import view_repo
from backend.app.services import view_narrowings
from backend.app.services.feature_flags import feature_flags
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.view_narrowing import SavedNarrowingInput

WS = "ws_narrow"
VIEW = "view_team"
BASE = f"/api/v1/views/{VIEW}/narrowings"

URNS = {"seeds": {"urns": ["urn:b", "urn:a", "urn:a"]}, "expand": {"downstream": 2}}
QUERY = {"kind": "hasProperty", "key": "owner"}


@pytest.fixture(autouse=True)
def narrow_on():
    feature_flags._cache = {**(feature_flags._cache or {}), "viewMembershipEnabled": True}
    feature_flags._cache_ts = time.monotonic()


def _user(user_id: str) -> User:
    return User(id=user_id, email=f"{user_id}@example.com", first_name="T", last_name="U",
                role="user", status="active",
                created_at="2024-01-01T00:00:00Z", updated_at="2024-01-01T00:00:00Z")


@contextlib.contextmanager
def _as(user_id: str, *perms: str):
    """Every auth dependency answers as ``user_id``, holding ``perms`` in the workspace."""
    from backend.app.main import app

    user = _user(user_id)
    claims = PermissionClaims(sid=f"s_{user_id}", ws_perms={WS: perms} if perms else {})

    async def _current():
        return user

    async def _optional():
        return user

    deps = (get_current_user, get_optional_user, get_permission_claims)
    prev = {dep: app.dependency_overrides.get(dep) for dep in deps}
    app.dependency_overrides[get_current_user] = _current
    app.dependency_overrides[get_optional_user] = _optional
    app.dependency_overrides[get_permission_claims] = lambda: claims
    try:
        yield
    finally:
        for dep, fn in prev.items():
            if fn is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = fn


READER = ("workspace:view:read", "workspace:datasource:read")
LINK_READER = ("workspace:view:read",)          # the view, not its workspace's data
EDITOR = ("workspace:view:read", "workspace:view:edit", "workspace:datasource:read")


@pytest.fixture()
async def view(db_session):
    db_session.add(WorkspaceORM(id=WS, name="Narrow"))
    db_session.add(ViewORM(id=VIEW, name="team", workspace_id=WS, visibility="workspace",
                           created_by="usr_owner"))
    db_session.add(ViewORM(id="view_other", name="other", workspace_id=WS, visibility="workspace",
                           created_by="usr_owner"))
    await db_session.commit()
    return VIEW


def _gz(text: str) -> str:
    return base64.b64encode(gzip.compress(text.encode())).decode()


def _body(name: str = "Downstream of orders", spec: dict = URNS, **over) -> dict:
    return {"name": name, "spec": spec, **over}


async def _put(client: AsyncClient, nid: str, body: dict, base: str = BASE):
    return await client.put(f"{base}/{nid}", json=body)


# ── saving, reading, listing ─────────────────────────────────────────

async def test_a_narrowing_is_saved_read_and_listed_newest_first(test_client: AsyncClient, view):
    body = _body(seedsLabel="2 tables", seedNames={"urn:a": "orders", "urn:b": "customers"},
                 counts={"seeds": 2, "inside": None, "upstream": 0, "downstream": 3, "total": 5},
                 truncated=[{"reason": "member_cap", "seen": 5, "limit": 5}], dataVersion="dv1",
                 held={"count": 5, "complete": False, "urnsGzip": _gz("urn:a\nurn:b")})
    created = await _put(test_client, "nar_0001", body)
    assert created.status_code == 201, created.text
    saved = created.json()
    # The spec as stored is the canonical one: URNs sorted, each once.
    assert saved["spec"] == {"v": 1, "seeds": {"urns": ["urn:a", "urn:b"]}, "within": "view",
                             "expand": {"children": 0, "upstream": 0, "downstream": 2, "partnerChildren": 0}}
    assert saved["held"] == {"count": 2, "complete": False, "kept": True}
    assert (saved["viewId"], saved["name"], saved["seedsLabel"], saved["dataVersion"]) == (
        VIEW, "Downstream of orders", "2 tables", "dv1")
    assert saved["seedNames"] == {"urn:a": "orders", "urn:b": "customers"}
    assert saved["counts"]["inside"] is None and saved["counts"]["total"] == 5
    assert saved["truncated"] == [{"reason": "member_cap", "seen": 5, "limit": 5}]
    assert saved["createdBy"] == "usr_test000000" and saved["canChange"] is True

    await _put(test_client, "nar_0002", _body("Second"))
    listed = (await test_client.get(BASE)).json()
    assert [n["id"] for n in listed["items"]] == ["nar_0002", "nar_0001"]
    assert listed["canEdit"] is True
    assert listed["limits"] == {"perView": 200, "perUser": 50}
    assert listed["items"][1] == saved

    one = await test_client.get(f"{BASE}/nar_0001")
    assert one.status_code == 200 and one.json() == saved
    assert (await test_client.get(f"{BASE}/nar_none01")).status_code == 404


async def test_saving_again_replaces_it(test_client: AsyncClient, view):
    await _put(test_client, "nar_0001", _body(seedsLabel="old", dataVersion="dv1"))
    again = await _put(test_client, "nar_0001", _body("Renamed"))
    assert again.status_code == 200, again.text
    assert (again.json()["name"], again.json()["seedsLabel"], again.json()["dataVersion"]) == (
        "Renamed", None, None)
    assert len((await test_client.get(BASE)).json()["items"]) == 1


async def test_an_id_another_view_has_is_refused(test_client: AsyncClient, view):
    assert (await _put(test_client, "nar_0001", _body())).status_code == 201
    other = await _put(test_client, "nar_0001", _body(), base="/api/v1/views/view_other/narrowings")
    assert other.status_code == 409
    assert other.json()["detail"]["reason"] == "id_taken"
    assert (await test_client.get("/api/v1/views/view_other/narrowings/nar_0001")).status_code == 404


async def test_an_id_the_client_could_not_have_made_is_refused(test_client: AsyncClient, view):
    for bad in ("short", "x" * 33, "has.dot01"):
        assert (await _put(test_client, bad, _body())).status_code == 422, bad


async def test_a_spec_that_is_not_one_is_refused(test_client: AsyncClient, view):
    for spec in (
        {"seeds": {"urns": ["urn:a"], "query": QUERY}},
        {"seeds": {}},
        {"seeds": {"urns": ["urn:a"]}, "expand": {"children": 5}},
        {"seeds": {"urns": ["urn:a"]}, "surprise": True},
        {"seeds": {"urns": [f"urn:li:dataset:{i:060d}" for i in range(2000)]}},   # over 64 KB
        {"seeds": {"query": {"kind": "group", "op": "and", "children": []}}},      # an empty search
    ):
        resp = await _put(test_client, "nar_0001", _body(spec=spec))
        assert resp.status_code == 422, spec
        assert resp.json()["detail"]["reason"] == "invalid_spec", resp.text
    assert (await test_client.get(BASE)).json()["items"] == []


async def test_a_view_keeps_so_many_and_a_person_so_many_on_it(test_client: AsyncClient, view, monkeypatch):
    monkeypatch.setattr(view_narrowings, "NARROWINGS_PER_VIEW", 3)
    monkeypatch.setattr(view_narrowings, "NARROWINGS_PER_USER", 2)
    with _as("usr_a", *READER):
        assert (await _put(test_client, "nar_a0001", _body())).status_code == 201
        assert (await _put(test_client, "nar_a0002", _body())).status_code == 201
        mine = await _put(test_client, "nar_a0003", _body())
        assert (mine.status_code, mine.json()["detail"]["reason"]) == (422, "too_many")
        # Changing one already saved is not one more.
        assert (await _put(test_client, "nar_a0002", _body("Changed"))).status_code == 200
    with _as("usr_b", *READER):
        assert (await _put(test_client, "nar_b0001", _body())).status_code == 201
        full = await _put(test_client, "nar_b0002", _body())
        assert (full.status_code, full.json()["detail"]["reason"]) == (422, "too_many")


# ── who may do what ──────────────────────────────────────────────────

async def test_a_reader_saves_one_others_read_it_and_only_its_saver_or_an_editor_changes_it(
        test_client: AsyncClient, view):
    with _as("usr_a", *READER):
        assert (await _put(test_client, "nar_a0001", _body(held={
            "count": 1, "complete": True, "urnsGzip": _gz("urn:a")}))).status_code == 201
        listed = (await test_client.get(BASE)).json()
        assert listed["canEdit"] is False and listed["items"][0]["canChange"] is True

    with _as("usr_b", *READER):
        listed = (await test_client.get(BASE)).json()
        assert [(n["id"], n["canChange"]) for n in listed["items"]] == [("nar_a0001", False)]
        assert (await test_client.get(f"{BASE}/nar_a0001")).json()["canChange"] is False
        assert (await test_client.get(f"{BASE}/nar_a0001/held")).status_code == 200
        changed = await _put(test_client, "nar_a0001", _body("Mine now"))
        assert (changed.status_code, changed.json()["detail"]["reason"]) == (403, "not_yours")
        removed = await test_client.delete(f"{BASE}/nar_a0001")
        assert (removed.status_code, removed.json()["detail"]["reason"]) == (403, "not_yours")
        # A reader may save one of their own.
        assert (await _put(test_client, "nar_b0001", _body())).status_code == 201

    with _as("usr_editor", *EDITOR):
        listed = (await test_client.get(BASE)).json()
        assert listed["canEdit"] is True and all(n["canChange"] for n in listed["items"])
        assert (await _put(test_client, "nar_a0001", _body("Tidied"))).status_code == 200
        assert (await test_client.delete(f"{BASE}/nar_b0001")).status_code == 204

    with _as("usr_a", *READER):
        mine = (await test_client.get(f"{BASE}/nar_a0001")).json()
        assert mine["name"] == "Tidied" and mine["createdBy"] == "usr_a" and mine["canChange"] is True
        assert (await test_client.delete(f"{BASE}/nar_a0001")).status_code == 204
        assert (await test_client.delete(f"{BASE}/nar_a0001")).status_code == 204, "already gone"
        assert (await test_client.get(BASE)).json()["items"] == []


async def test_a_view_the_caller_cannot_read_is_not_found(test_client: AsyncClient, view):
    assert (await _put(test_client, "nar_0001", _body(held={
        "count": 1, "complete": True, "urnsGzip": _gz("urn:a")}))).status_code == 201
    with _as("usr_stranger"):
        for resp in (
            await test_client.get(BASE),
            await test_client.get(f"{BASE}/nar_0001"),
            await test_client.get(f"{BASE}/nar_0001/held"),
            await _put(test_client, "nar_0002", _body()),
            await test_client.delete(f"{BASE}/nar_0001"),
        ):
            assert resp.status_code == 404, resp.request.url
            assert resp.json()["detail"]["reason"] == "view_not_found"
    assert len((await test_client.get(BASE)).json()["items"]) == 1


async def test_a_deleted_view_is_not_found(test_client: AsyncClient, view, db_session):
    await _put(test_client, "nar_0001", _body())
    assert (await test_client.delete(f"/api/v1/views/{VIEW}")).status_code == 204
    assert (await test_client.get(BASE)).status_code == 404


async def test_a_link_reader_saves_only_a_search_they_could_run_in_the_view(test_client: AsyncClient, view):
    with _as("usr_link", *LINK_READER):
        assert (await _put(test_client, "nar_l0001", _body())).status_code == 201, "URN seeds"
        inside = await _put(test_client, "nar_l0002", _body(spec={"seeds": {"query": QUERY}}))
        assert inside.status_code == 201, inside.text
        for spec in (
            {"seeds": {"query": QUERY}, "within": "dataSource"},
            {"seeds": {"query": {"kind": "withinHops", "urns": ["urn:a"], "hops": 2}}},
        ):
            resp = await _put(test_client, "nar_l0003", _body(spec=spec))
            assert resp.status_code == 403, spec
        assert {n["id"] for n in (await test_client.get(BASE)).json()["items"]} == {"nar_l0001", "nar_l0002"}
    with _as("usr_a", *READER):
        whole = await _put(test_client, "nar_a0001", _body(spec={"seeds": {"query": QUERY},
                                                                 "within": "dataSource"}))
        assert whole.status_code == 201, whole.text


async def test_everything_answers_403_while_narrow_is_off(test_client: AsyncClient, view):
    assert (await _put(test_client, "nar_0001", _body())).status_code == 201
    feature_flags._cache = {**feature_flags._cache, "viewMembershipEnabled": False}
    for resp in (
        await test_client.get(BASE),
        await test_client.get(f"{BASE}/nar_0001"),
        await test_client.get(f"{BASE}/nar_0001/held"),
        await _put(test_client, "nar_0002", _body()),
        await test_client.delete(f"{BASE}/nar_0001"),
    ):
        assert resp.status_code == 403, resp.request.url
        assert resp.json()["detail"]["feature"] == "viewMembershipEnabled"


# ── what it held ─────────────────────────────────────────────────────

async def test_what_it_held_is_kept_sorted_once_each_and_gzipped_the_same_way(test_client: AsyncClient, view):
    resp = await _put(test_client, "nar_0001", _body(held={
        "count": 99, "complete": True, "urnsGzip": _gz("urn:c\nurn:a\n\n  \nurn:c\r\nurn:b\n")}))
    assert resp.json()["held"] == {"count": 3, "complete": True, "kept": True}

    held = await test_client.get(f"{BASE}/nar_0001/held")
    assert held.status_code == 200
    assert held.headers["content-type"] == "application/gzip"
    assert held.content == gzip.compress(b"urn:a\nurn:b\nurn:c", compresslevel=9, mtime=0)
    etag = held.headers["etag"]

    same = await test_client.get(f"{BASE}/nar_0001/held", headers={"If-None-Match": etag})
    assert same.status_code == 304
    # The same URNs, sent another way, are stored as the same bytes.
    await _put(test_client, "nar_0001", _body(held={
        "count": 3, "complete": True, "urnsGzip": _gz("urn:b\nurn:c\nurn:a")}))
    assert (await test_client.get(f"{BASE}/nar_0001/held")).headers["etag"] == etag


async def test_none_kept_answers_204(test_client: AsyncClient, view):
    resp = await _put(test_client, "nar_0001", _body())
    assert resp.json()["held"] == {"count": 0, "complete": True, "kept": False}
    assert (await test_client.get(f"{BASE}/nar_0001/held")).status_code == 204
    assert (await test_client.get(f"{BASE}/nar_none01/held")).status_code == 404


async def test_left_out_it_keeps_what_it_held_until_the_spec_changes(test_client: AsyncClient, view):
    await _put(test_client, "nar_0001", _body(held={"count": 1, "complete": False, "urnsGzip": _gz("urn:a")}))
    renamed = await _put(test_client, "nar_0001", _body("Renamed"))
    assert renamed.json()["held"] == {"count": 1, "complete": False, "kept": True}
    assert (await test_client.get(f"{BASE}/nar_0001/held")).status_code == 200

    other = await _put(test_client, "nar_0001", _body(spec={"seeds": {"urns": ["urn:z"]}}))
    assert other.json()["held"] == {"count": 0, "complete": True, "kept": False}
    assert (await test_client.get(f"{BASE}/nar_0001/held")).status_code == 204


async def test_what_it_held_is_refused_when_too_large_or_not_gzip(test_client: AsyncClient, view, monkeypatch):
    bomb = base64.b64encode(gzip.compress(b"\n" * (9 * 1024 * 1024))).decode()
    assert len(bomb) < 20_000, "small sent, large unzipped"
    cases = {
        "held_too_large": [
            bomb,
            _gz("\n".join(f"urn:{i}" for i in range(60_001))),
            _gz("urn:" + "x" * 1024),
        ],
        "invalid_held": [
            "not base64!",
            base64.b64encode(b"plain text, not gzip").decode(),
            base64.b64encode(gzip.compress(b"urn:a\nurn:b")[:-6]).decode(),     # cut short
            base64.b64encode(gzip.compress(b"\xff\xfe")).decode(),              # not UTF-8
        ],
    }
    for reason, blobs in cases.items():
        for blob in blobs:
            resp = await _put(test_client, "nar_0001", _body(held={"count": 1, "complete": True, "urnsGzip": blob}))
            assert resp.status_code == 422, blob[:40]
            assert resp.json()["detail"]["reason"] == reason, resp.text

    monkeypatch.setattr(view_narrowings, "HELD_GZIP_MAX_BYTES", 64)
    sent = _gz("\n".join(base64.b64encode(os.urandom(12)).decode() for _ in range(20)))
    over = await _put(test_client, "nar_0001", _body(held={"count": 20, "complete": True, "urnsGzip": sent}))
    assert (over.status_code, over.json()["detail"]["reason"]) == (422, "held_too_large")
    assert (await test_client.get(BASE)).json()["items"] == []


async def test_the_list_never_reads_what_was_held(test_client: AsyncClient, view, db_session):
    """The URNs stay in the database while the list and a narrowing are read."""
    await _put(test_client, "nar_0001", _body(held={"count": 1, "complete": True, "urnsGzip": _gz("urn:a")}))
    selected = []

    def _seen(conn, cursor, statement, params, context, executemany):  # noqa: ANN001
        if "FROM view_saved_narrowings" in statement:
            selected.append(statement.split("FROM view_saved_narrowings")[0])

    engine = db_session.bind.sync_engine
    event.listen(engine, "before_cursor_execute", _seen)
    try:
        assert (await test_client.get(BASE)).json()["items"][0]["held"]["kept"] is True
        assert (await test_client.get(f"{BASE}/nar_0001")).json()["held"]["kept"] is True
    finally:
        event.remove(engine, "before_cursor_execute", _seen)
    assert selected
    assert not [cols for cols in selected if re.search(r"view_saved_narrowings\.held(?!_| IS)", cols)]


# ── the view going ───────────────────────────────────────────────────

async def test_a_views_narrowings_go_with_it():
    """ON DELETE CASCADE, behaviourally: the shared SQLite engine leaves foreign keys off, so
    this one turns them on (Postgres enforces it natively)."""
    engine = create_async_engine("sqlite+aiosqlite://", connect_args={"check_same_thread": False})

    @event.listens_for(engine.sync_engine, "connect")
    def _on_connect(dbapi_conn, _rec):  # noqa: ANN001
        dbapi_conn.execute("ATTACH DATABASE ':memory:' AS aggregation")
        dbapi_conn.execute("PRAGMA foreign_keys=ON")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(bind=engine, class_=AsyncSession, expire_on_commit=False)
    try:
        async with Session() as session:
            session.add(WorkspaceORM(id=WS, name="Narrow"))
            session.add(ViewORM(id=VIEW, name="team", workspace_id=WS, visibility="workspace"))
            await session.flush()
            spec = view_narrowings.check_spec(URNS, read_in=VIEW)
            body = SavedNarrowingInput.model_validate(_body(held={
                "count": 1, "complete": True, "urnsGzip": _gz("urn:a")}))
            await view_narrowings.put_narrowing(session, VIEW, "nar_0001", body, spec,
                                                actor="usr_a", can_edit=False)
            await session.commit()

            await view_repo.permanently_delete_view(session, VIEW)
            await session.commit()
            left = (await session.execute(select(ViewSavedNarrowingORM.id))).scalars().all()
            assert left == []
    finally:
        await engine.dispose()
