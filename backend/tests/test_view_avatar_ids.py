"""Avatar ids on view responses.

Each person on a view's contributor trail — creator, last editor, last data
publisher — comes with their chosen avatar (``UserORM.avatar_id``), resolved in
the same lookup as their name, on every read that names them. Both enrichment
paths are exercised: the batched one, and the per-row one that
``VIEWS_BATCH_ENRICH=false`` falls back to.
"""
from contextlib import contextmanager

import pytest
from httpx import AsyncClient
from sqlalchemy import event

from backend.app.db.models import UserORM, ViewORM, WorkspaceORM
from backend.app.db.repositories import view_repo

_TRAIL = ("createdBy", "updatedBy", "dataUpdatedBy")


@pytest.fixture(params=["true", "false"], ids=["batched", "per-row"])
def enrichment(request, monkeypatch):
    """Both paths; ``_batch_enrich_enabled()`` reads the switch on every call."""
    monkeypatch.setenv("VIEWS_BATCH_ENRICH", request.param)
    return request.param


def _user(uid: str, first: str, avatar):
    return UserORM(
        id=uid, email=f"{uid}@example.com", password_hash="x",
        first_name=first, last_name="Test", status="active", avatar_id=avatar,
    )


async def _seed(session) -> None:
    for uid, first, avatar in (
        ("usr_ann", "Ann", "fox"), ("usr_bob", "Bob", "owl"),
        ("usr_cy", "Cy", "heron"), ("usr_dee", "Dee", None),
    ):
        session.add(_user(uid, first, avatar))
    session.add(WorkspaceORM(id="ws_av", name="Avatars"))
    session.add(ViewORM(
        id="v_three", name="three", workspace_id="ws_av", visibility="enterprise",
        created_by="usr_ann", updated_by="usr_bob",
        data_updated_by="usr_cy", data_updated_at="2026-05-01T00:00:00+00:00",
    ))
    # No avatar picked; an account that no longer exists; the legacy sentinel.
    session.add(ViewORM(
        id="v_none", name="none", workspace_id="ws_av", visibility="enterprise",
        created_by="usr_dee", updated_by="usr_gone", data_updated_by="anonymous",
    ))
    await session.commit()


EXPECTED = {
    "v_three": {
        "createdByAvatarId": "fox", "updatedByAvatarId": "owl", "dataUpdatedByAvatarId": "heron",
        "createdByName": "Ann Test", "updatedByName": "Bob Test", "dataUpdatedByName": "Cy Test",
    },
    "v_none": {
        "createdByAvatarId": None, "updatedByAvatarId": None, "dataUpdatedByAvatarId": None,
        "createdByName": "Dee Test", "updatedByName": None, "dataUpdatedByName": None,
    },
}


def _trail(view: dict) -> dict:
    return {
        f"{who}{part}": view[f"{who}{part}"] for who in _TRAIL for part in ("AvatarId", "Name")
    }


async def test_every_read_carries_the_trails_avatars(
    test_client: AsyncClient, db_session, enrichment,
):
    await _seed(db_session)
    for view_id in EXPECTED:
        assert (await test_client.post(f"/api/v1/views/{view_id}/favourite")).status_code == 201

    listed = (await test_client.get("/api/v1/views/", params={"include": "popular"})).json()
    popular = (await test_client.get("/api/v1/views/popular")).json()
    for where, views in (("list", listed["items"]), ("include=popular", listed["popular"]),
                         ("/popular", popular)):
        assert {v["id"]: _trail(v) for v in views} == EXPECTED, where
    for view_id, trail in EXPECTED.items():
        single = await test_client.get(f"/api/v1/views/{view_id}")
        assert _trail(single.json()) == trail, view_id


async def test_the_batched_and_per_row_paths_agree(
    test_client: AsyncClient, db_session, monkeypatch,
):
    await _seed(db_session)
    seen = {}
    for switch in ("true", "false"):
        monkeypatch.setenv("VIEWS_BATCH_ENRICH", switch)
        items = (await test_client.get("/api/v1/views/")).json()["items"]
        seen[switch] = {v["id"]: v for v in items}
    assert seen["true"] == seen["false"]


@contextmanager
def _statements(session):
    """SQL statements the session's engine runs — the ``_count_queries`` hook
    (tests/test_view_repo.py), keeping the text so the users lookups can be told apart."""
    seen = []
    engine = session.bind.sync_engine

    def _on_exec(conn, cursor, statement, params, context, executemany):
        if not statement.strip().upper().startswith(
            ("SAVEPOINT", "RELEASE SAVEPOINT", "ROLLBACK", "BEGIN", "COMMIT"),
        ):
            seen.append(statement)

    event.listen(engine, "before_cursor_execute", _on_exec)
    try:
        yield seen
    finally:
        event.remove(engine, "before_cursor_execute", _on_exec)


async def test_avatars_cost_the_list_no_statement(db_session):
    """Twenty views, sixty people with avatars: still one users lookup, and the
    list stays under the ceiling of test_list_views_filtered_query_count_is_bounded."""
    db_session.add(WorkspaceORM(id="ws_many", name="Many"))
    for i in range(20):
        for role in ("c", "e", "p"):
            db_session.add(_user(f"usr_{role}{i}", f"{role}{i}", f"avatar_{role}{i}"))
        db_session.add(ViewORM(
            id=f"v_{i}", name=f"v{i}", workspace_id="ws_many", visibility="enterprise",
            created_by=f"usr_c{i}", updated_by=f"usr_e{i}", data_updated_by=f"usr_p{i}",
        ))
    await db_session.commit()

    with _statements(db_session) as seen:
        listed = await view_repo.list_views_filtered(db_session, limit=20, user_id="usr_c0")

    assert len(listed.items) == 20
    assert all(
        (v.created_by_avatar_id, v.updated_by_avatar_id, v.data_updated_by_avatar_id)
        == (f"avatar_c{v.id[2:]}", f"avatar_e{v.id[2:]}", f"avatar_p{v.id[2:]}")
        for v in listed.items
    )
    assert len([s for s in seen if "FROM users" in s]) == 1, seen
    assert len(seen) <= 10, seen
