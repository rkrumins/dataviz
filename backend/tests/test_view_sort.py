"""Server-side sort ordering for the Explorer view list (view_repo).

Verifies ordering runs across the whole result set (not a client page) and that
views whose DATA was never published (data_updated_at NULL) sort last for the
data-* keys.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from tests.common.view_scopes import admin_scope
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

    resp = await view_repo.list_views_filtered(db_session, scope=admin_scope(), workspace_id=ws.id, sort="data-newest", limit=50)
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

    resp = await view_repo.list_views_filtered(db_session, scope=admin_scope(), workspace_id=ws.id, sort="data-oldest", limit=50)
    order = [v.name for v in resp.items]
    assert order.index("A") < order.index("B")   # Mar before Jul
    assert order[-1] == "C"                       # never-published last


async def test_sort_recently_modified_uses_freshest_of_data_or_settings(db_session: AsyncSession):
    ws = await _ws(db_session)
    a = await _view(db_session, ws.id, "A")  # recent settings edit, no data publish
    b = await _view(db_session, ws.id, "B")  # old settings, recent data publish
    await _set_times(db_session, a.id, data_updated_at=None, updated_at="2026-07-10T00:00:00+00:00")
    await _set_times(db_session, b.id, data_updated_at="2026-07-20T00:00:00+00:00", updated_at="2026-01-01T00:00:00+00:00")

    resp = await view_repo.list_views_filtered(db_session, scope=admin_scope(), workspace_id=ws.id, sort="recently-modified", limit=50)
    order = [v.name for v in resp.items]
    assert order[0] == "B"   # B's data (Jul 20) is fresher than A's settings (Jul 10)
