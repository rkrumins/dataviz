"""Server-side "Continue where you left off" (view_visits).

Each test pins one of the three bugs the old localStorage implementation had:
per-user leakage, stale name snapshots, and dead (deleted) entries.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from tests.common.view_scopes import admin_scope
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

    recent = await view_repo.list_recent_views(db_session, "u1", scope=admin_scope(), limit=5)
    assert [r.viewName for r in recent][0] == "A"  # revisit floats to the top


async def test_recents_are_per_user(db_session: AsyncSession):
    """The localStorage key was NOT user-scoped — a second user on the same
    browser inherited the first user's recents."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    await view_repo.record_view_visit(db_session, a.id, "u1")

    assert await view_repo.list_recent_views(db_session, "u2", scope=admin_scope(), limit=5) == []
    assert len(await view_repo.list_recent_views(db_session, "u1", scope=admin_scope(), limit=5)) == 1


async def test_recents_use_live_name_and_drop_deleted(db_session: AsyncSession):
    """localStorage cached a name snapshot: renames showed the old name and
    deleted views stayed in the strip and 404'd on click."""
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "Old Name")
    await view_repo.record_view_visit(db_session, a.id, "u1")

    row = (await db_session.execute(select(ViewORM).where(ViewORM.id == a.id))).scalar_one()
    row.name = "New Name"
    await db_session.flush()

    recent = await view_repo.list_recent_views(db_session, "u1", scope=admin_scope(), limit=5)
    assert recent[0].viewName == "New Name"

    await view_repo.delete_view(db_session, a.id)
    assert await view_repo.list_recent_views(db_session, "u1", scope=admin_scope(), limit=5) == []


async def test_anonymous_is_a_noop(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")
    await view_repo.record_view_visit(db_session, a.id, "anonymous")
    assert await view_repo.list_recent_views(db_session, "anonymous", scope=admin_scope(), limit=5) == []
