"""Server-side sort ordering for the Explorer view list (view_repo).

Verifies ordering runs across the whole result set (not a client page) and that
views whose DATA was never published (data_updated_at NULL) sort last for the
data-* keys.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from backend.app.db.models import WorkspaceORM, ViewORM
from backend.common.models.management import ViewCreateRequest


async def _ws(session: AsyncSession) -> WorkspaceORM:
    ws = WorkspaceORM(name="Sort WS")
    session.add(ws)
    await session.flush()
    return ws


async def _view(session: AsyncSession, ws_id: str, name: str):
    return await view_repo.create_view(
        session,
        ViewCreateRequest(name=name, workspace_id=ws_id, view_type="graph", visibility="private"),
        user_id="u1",
    )


async def _set_times(session, view_id, *, data_updated_at, updated_at=None):
    row = (await session.execute(select(ViewORM).where(ViewORM.id == view_id))).scalar_one()
    row.data_updated_at = data_updated_at
    if updated_at is not None:
        row.updated_at = updated_at
    await session.flush()


async def test_sort_data_newest_nulls_last(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")
    c = await _view(db_session, ws.id, "C")
    await _set_times(db_session, a.id, data_updated_at="2026-03-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-01T00:00:00+00:00")
    await _set_times(db_session, c.id, data_updated_at=None)

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="data-newest", limit=50)
    order = [v.name for v in resp.items]
    assert order.index("B") < order.index("A")   # Jul before Mar
    assert order[-1] == "C"                       # never-published last


async def test_sort_data_oldest_nulls_last(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")
    c = await _view(db_session, ws.id, "C")
    await _set_times(db_session, a.id, data_updated_at="2026-03-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-01T00:00:00+00:00")
    await _set_times(db_session, c.id, data_updated_at=None)

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="data-oldest", limit=50)
    order = [v.name for v in resp.items]
    assert order.index("A") < order.index("B")   # Mar before Jul
    assert order[-1] == "C"                       # never-published last


async def test_sort_recently_modified_uses_freshest_of_data_or_settings(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")  # recent settings edit, no data publish
    b = await _view(db_session, ws.id, "B")  # old settings, recent data publish
    await _set_times(db_session, a.id, data_updated_at=None, updated_at="2026-07-10T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-20T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="recently-modified", limit=50)
    order = [v.name for v in resp.items]
    assert order[0] == "B"   # B's data (Jul 20) is fresher than A's settings (Jul 10)


async def test_sort_recently_modified_prefers_a_settings_edit_newer_than_an_old_publish(db_session: AsyncSession):
    """The later of the two, not "the publish if there was one": a view whose data
    was published long ago and whose settings were edited today is recent."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")  # old publish, settings edited recently
    b = await _view(db_session, ws.id, "B")  # publish in between, settings old
    await _set_times(db_session, a.id, data_updated_at="2026-01-05T00:00:00+00:00", updated_at="2026-08-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-05-01T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="recently-modified", limit=50)
    assert [v.name for v in resp.items] == ["A", "B"]


SORTS = ["recently-modified", "modified-asc", "newest", "oldest", "updated", "updated-asc", "data-newest",
         "data-oldest", "az", "za", "popular", "likes-asc", "type-az", "type-za",
         "owner-az", "owner-za", "most-opened"]


import pytest  # noqa: E402


@pytest.mark.parametrize("sort", SORTS)
async def test_paging_is_stable_when_every_sort_key_ties(db_session: AsyncSession, sort):
    """Offset paging over rows whose sort key is identical (one publish stamps the
    same time on every view of a source; names repeat) must neither skip nor repeat
    a row: every sort breaks ties on the id."""
    ws = await _ws(db_session)
    ids = set()
    for _ in range(7):
        v = await _view(db_session, ws.id, "Same name")
        await _set_times(db_session, v.id, data_updated_at="2026-03-01T00:00:00+00:00",
                         updated_at="2026-03-01T00:00:00+00:00")
        row = (await db_session.execute(select(ViewORM).where(ViewORM.id == v.id))).scalar_one()
        row.created_at = "2026-03-01T00:00:00+00:00"
        ids.add(v.id)
    await db_session.flush()

    seen = []
    for offset in range(0, 7, 2):
        page = await view_repo.list_views_filtered(
            db_session, workspace_id=ws.id, sort=sort, limit=2, offset=offset)
        seen += [v.id for v in page.items]
    assert sorted(seen) == sorted(ids)


async def test_sort_by_type_follows_the_label_people_read(db_session: AsyncSession):
    """Type sorts by the label in the column — ``reference`` reads "Context View" —
    across the whole result, not the loaded page."""
    ws = await _ws(db_session)
    for name, kind in [("H", "hierarchy"), ("G", "graph"), ("R", "reference")]:
        await view_repo.create_view(db_session, ViewCreateRequest(
            name=name, workspace_id=ws.id, view_type=kind, visibility="private"), user_id="u1")

    az = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="type-az", limit=50)
    assert [v.name for v in az.items] == ["R", "G", "H"]   # Context View, Graph, Hierarchy
    za = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="type-za", limit=50)
    assert [v.name for v in za.items] == ["H", "G", "R"]


async def test_sort_by_owner_uses_their_name(db_session: AsyncSession):
    from backend.app.db.models import UserORM
    ws = await _ws(db_session)
    db_session.add_all([
        UserORM(id="usr_z", email="z@x.io", password_hash="x", first_name="Zoe", last_name="Ng"),
        UserORM(id="usr_a", email="a@x.io", password_hash="x", first_name="Ada", last_name="Lo"),
    ])
    await db_session.flush()
    for name, owner in [("by_zoe", "usr_z"), ("by_ada", "usr_a")]:
        await view_repo.create_view(db_session, ViewCreateRequest(
            name=name, workspace_id=ws.id, view_type="graph", visibility="private"), user_id=owner)

    az = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="owner-az", limit=50)
    assert [v.name for v in az.items] == ["by_ada", "by_zoe"]
    za = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="owner-za", limit=50)
    assert [v.name for v in za.items] == ["by_zoe", "by_ada"]


async def test_sort_likes_ascending(db_session: AsyncSession):
    from backend.app.db.models import ViewFavouriteORM
    ws = await _ws(db_session)
    # Plain is the OLDER edit, so the old fallback (last edit first) put it last.
    plain = await _view(db_session, ws.id, "Plain")
    loved = await _view(db_session, ws.id, "Loved")
    await _set_times(db_session, plain.id, data_updated_at=None, updated_at="2026-01-01T00:00:00+00:00")
    await _set_times(db_session, loved.id, data_updated_at=None, updated_at="2026-06-01T00:00:00+00:00")
    db_session.add_all([ViewFavouriteORM(view_id=loved.id, user_id=f"u{i}") for i in range(3)])
    await db_session.flush()

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="likes-asc", limit=50)
    assert [v.name for v in resp.items] == ["Plain", "Loved"]


async def test_sort_most_opened_ranks_the_whole_result_by_recent_opens(db_session: AsyncSession):
    """Ranked on the server over the last 30 days, so a heavily-opened view on what
    would be page 3 still comes first; opens older than the window don't count."""
    from datetime import datetime, timedelta, timezone
    from backend.app.db.models import ProductEventORM
    ws = await _ws(db_session)
    quiet = await _view(db_session, ws.id, "Quiet")
    busy = await _view(db_session, ws.id, "Busy")
    stale = await _view(db_session, ws.id, "Stale")
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(days=2)).isoformat()
    old = (now - timedelta(days=90)).isoformat()
    events = [ProductEventORM(event_type="view.opened", subject_id=busy.id, actor_id=f"u{i}", created_at=recent)
              for i in range(4)]
    events += [ProductEventORM(event_type="view.opened", subject_id=quiet.id, actor_id="u1", created_at=recent)]
    events += [ProductEventORM(event_type="view.opened", subject_id=stale.id, actor_id=f"u{i}", created_at=old)
               for i in range(9)]
    db_session.add_all(events)
    await db_session.flush()

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="most-opened", limit=50)
    assert [v.name for v in resp.items] == ["Busy", "Quiet", "Stale"]


async def test_sort_modified_ascending_is_the_updated_column_reversed(db_session: AsyncSession):
    """The list's Updated column shows the later of the two changes; sorting it
    ascending orders by that same time."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")
    await _set_times(db_session, a.id, data_updated_at="2026-09-01T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at=None, updated_at="2026-05-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, workspace_id=ws.id, sort="modified-asc", limit=50)
    assert [v.name for v in resp.items] == ["B", "A"]   # May before A's September publish
