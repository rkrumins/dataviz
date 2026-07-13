"""Tests for the per-view activity log (view_activity_repo).

Covers: recording writes a durable row + a shared-outbox event in the same
transaction; the reader returns entries actor-resolved; legacy views without
rows get a synthesized 'created' anchor; unknown actions are a safe no-op.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo, view_activity_repo
from backend.app.db.models import WorkspaceORM, OutboxEventORM, ViewActivityLogORM
from backend.common.models.management import ViewCreateRequest


async def _workspace(session: AsyncSession) -> WorkspaceORM:
    ws = WorkspaceORM(name="Activity WS")
    session.add(ws)
    await session.flush()
    return ws


async def _view(session: AsyncSession, ws_id: str, name: str = "V"):
    return await view_repo.create_view(
        session,
        ViewCreateRequest(name=name, workspace_id=ws_id, view_type="graph", visibility="private"),
        user_id="u1",
    )


async def test_record_and_read_activity(db_session: AsyncSession):
    ws = await _workspace(db_session)
    view = await _view(db_session, ws.id)

    await view_activity_repo.record_view_activity(
        db_session, view_id=view.id, workspace_id=ws.id,
        action="updated", actor="u1", summary="Edited settings",
        changes={"name": {"from": "A", "to": "B"}},
    )

    entries = await view_activity_repo.get_view_activity(db_session, view.id)
    assert len(entries) == 1
    e = entries[0]
    assert e.action == "updated"
    assert e.actor == "u1"
    assert e.summary == "Edited settings"
    assert e.changes == {"name": {"from": "A", "to": "B"}}
    assert e.synthetic is False


async def test_records_shared_outbox_event(db_session: AsyncSession):
    ws = await _workspace(db_session)
    view = await _view(db_session, ws.id)

    await view_activity_repo.record_view_activity(
        db_session, view_id=view.id, workspace_id=ws.id,
        action="visibility_changed", actor="u1",
    )

    rows = (await db_session.execute(
        select(OutboxEventORM).where(OutboxEventORM.aggregate_id == view.id)
    )).scalars().all()
    assert "visualization.view.visibility_changed" in {r.event_type for r in rows}


async def test_reader_returns_all_actions(db_session: AsyncSession):
    ws = await _workspace(db_session)
    view = await _view(db_session, ws.id)

    for action in ("created", "updated", "deleted"):
        await view_activity_repo.record_view_activity(
            db_session, view_id=view.id, workspace_id=ws.id, action=action, actor="u1",
        )

    entries = await view_activity_repo.get_view_activity(db_session, view.id)
    assert len(entries) == 3
    assert {e.action for e in entries} == {"created", "updated", "deleted"}


async def test_legacy_view_gets_synthetic_created_anchor(db_session: AsyncSession):
    ws = await _workspace(db_session)
    view = await _view(db_session, ws.id)  # no activity rows recorded

    entries = await view_activity_repo.get_view_activity(db_session, view.id)
    assert len(entries) >= 1
    anchor = entries[-1]
    assert anchor.action == "created"
    assert anchor.synthetic is True
    assert anchor.actor == "u1"


async def test_unknown_action_is_noop(db_session: AsyncSession):
    ws = await _workspace(db_session)
    view = await _view(db_session, ws.id)

    await view_activity_repo.record_view_activity(
        db_session, view_id=view.id, workspace_id=ws.id, action="bogus", actor="u1",
    )

    rows = (await db_session.execute(
        select(ViewActivityLogORM).where(ViewActivityLogORM.view_id == view.id)
    )).scalars().all()
    assert rows == []


async def test_recent_activity_feed_pairs_entries_with_views(db_session: AsyncSession):
    """The dashboard feed returns each entry with its ViewORM so the endpoint can
    apply the same read check the views list uses (no cross-workspace leak)."""
    ws = await _workspace(db_session)
    a = await _view(db_session, ws.id, "A")
    b = await _view(db_session, ws.id, "B")

    await view_activity_repo.record_view_activity(
        db_session, view_id=a.id, workspace_id=ws.id, action="updated", actor="u1",
    )
    await view_activity_repo.record_view_activity(
        db_session, view_id=b.id, workspace_id=ws.id, action="data_changed", actor="u2",
    )

    pairs = await view_activity_repo.get_recent_activity(db_session, limit=10)
    assert len(pairs) == 2
    # Newest first, view name resolved, ViewORM paired for the access check.
    entry, view_orm = pairs[0]
    assert entry.action == "data_changed"
    assert entry.viewName == view_orm.name
    assert view_orm.id == entry.viewId


async def test_recent_activity_excludes_deleted_views(db_session: AsyncSession):
    ws = await _workspace(db_session)
    a = await _view(db_session, ws.id, "A")
    await view_activity_repo.record_view_activity(
        db_session, view_id=a.id, workspace_id=ws.id, action="updated", actor="u1",
    )
    await view_repo.delete_view(db_session, a.id)
    assert await view_activity_repo.get_recent_activity(db_session, limit=10) == []
