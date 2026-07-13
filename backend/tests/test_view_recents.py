"""Server-side "Continue where you left off" (view_visits).

Each test pins one of the three bugs the old localStorage implementation had:
per-user leakage, stale name snapshots, and dead (deleted) entries.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from backend.app.db.models import WorkspaceORM, ViewORM, ViewVisitORM
from backend.common.models.management import ViewCreateRequest


async def _ws(session: AsyncSession) -> WorkspaceORM:
    ws = WorkspaceORM(name="Recents WS")
    session.add(ws)
    await session.flush()
    return ws


async def _view(session: AsyncSession, ws_id: str, name: str):
    return await view_repo.create_view(
        session,
        ViewCreateRequest(name=name, workspace_id=ws_id, view_type="graph", visibility="private"),
        user_id="u1",
    )


async def test_visit_upserts_and_lists_newest_first(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")

    await view_repo.record_view_visit(db_session, a.id, "u1")
    await view_repo.record_view_visit(db_session, b.id, "u1")
    await view_repo.record_view_visit(db_session, a.id, "u1")  # revisit A

    rows = (await db_session.execute(
        select(ViewVisitORM).where(ViewVisitORM.user_id == "u1")
    )).scalars().all()
    assert len(rows) == 2  # upserted, not appended

    recent = await view_repo.list_recent_views(db_session, "u1", limit=5)
    assert [r.viewName for r in recent][0] == "A"  # revisit floats to the top


async def test_recents_are_per_user(db_session: AsyncSession):
    """The localStorage key was NOT user-scoped — a second user on the same
    browser inherited the first user's recents."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    await view_repo.record_view_visit(db_session, a.id, "u1")

    assert await view_repo.list_recent_views(db_session, "u2", limit=5) == []
    assert len(await view_repo.list_recent_views(db_session, "u1", limit=5)) == 1


async def test_recents_use_live_name_and_drop_deleted(db_session: AsyncSession):
    """localStorage cached a name snapshot: renames showed the old name and
    deleted views stayed in the strip and 404'd on click."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "Old Name")
    await view_repo.record_view_visit(db_session, a.id, "u1")

    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == a.id))).scalar_one()
    row.name = "New Name"
    await db_session.flush()

    recent = await view_repo.list_recent_views(db_session, "u1", limit=5)
    assert recent[0].viewName == "New Name"

    await view_repo.delete_view(db_session, a.id)
    assert await view_repo.list_recent_views(db_session, "u1", limit=5) == []


async def test_anonymous_is_a_noop(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    await view_repo.record_view_visit(db_session, a.id, "anonymous")
    assert await view_repo.list_recent_views(db_session, "anonymous", limit=5) == []


async def test_visit_count_increments_on_each_open(db_session: AsyncSession):
    """Recents only needed WHEN you last opened a view. Popularity needs HOW OFTEN,
    and the row is upserted — so without this counter "most viewed" has nothing to
    rank by."""
    ws = await _ws(db_session)
    view = await _view(db_session, ws.id, "Counted View")

    for _ in range(3):
        await view_repo.record_view_visit(db_session, view.id, "usr_1")

    row = (await db_session.execute(
        select(ViewVisitORM).where(
            ViewVisitORM.view_id == view.id, ViewVisitORM.user_id == "usr_1",
        )
    )).scalar_one()
    assert row.visit_count == 3


async def test_most_viewed_ranks_by_people_then_opens(db_session: AsyncSession):
    """Eight people opening a view beats one person opening it eighty times."""
    ws = await _ws(db_session)
    obsessive = await _view(db_session, ws.id, "Obsessive")
    popular = await _view(db_session, ws.id, "Genuinely Popular")

    # One user, many opens.
    for _ in range(10):
        await view_repo.record_view_visit(db_session, obsessive.id, "usr_1")
    # Three users, one open each.
    for uid in ("usr_1", "usr_2", "usr_3"):
        await view_repo.record_view_visit(db_session, popular.id, uid)

    rows = await view_repo.list_most_viewed(db_session, limit=10)
    ranked = [entry.name for entry, _ in rows]

    assert ranked[0] == "Genuinely Popular"
    top = rows[0][0]
    assert top.viewers == 3
    assert top.opens == 3

    obsessive_entry = next(e for e, _ in rows if e.name == "Obsessive")
    assert obsessive_entry.viewers == 1
    assert obsessive_entry.opens == 10


async def test_most_viewed_excludes_deleted_views(db_session: AsyncSession):
    ws = await _ws(db_session)
    view = await _view(db_session, ws.id, "Doomed")
    await view_repo.record_view_visit(db_session, view.id, "usr_1")

    await view_repo.delete_view(db_session, view.id)

    rows = await view_repo.list_most_viewed(db_session, limit=10)
    assert all(entry.name != "Doomed" for entry, _ in rows)
