"""
Tests for backend.app.db.repositories.view_repo.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import view_repo
from backend.app.db.models import WorkspaceORM
from backend.common.models.management import (
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewResponse,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_workspace(session: AsyncSession, name: str = "Test WS") -> WorkspaceORM:
    """Insert a workspace prereq and return the ORM row."""
    ws = WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


def _make_create_req(workspace_id: str, **overrides) -> ViewCreateRequest:
    defaults = dict(
        name="Test View",
        workspace_id=workspace_id,
        view_type="graph",
        visibility="private",
    )
    defaults.update(overrides)
    return ViewCreateRequest(**defaults)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

async def test_create_view_returns_response(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    req = _make_create_req(ws.id)
    resp = await view_repo.create_view(db_session, req)

    assert isinstance(resp, ViewResponse)
    assert resp.name == "Test View"
    assert resp.visibility == "private"
    assert resp.view_type == "graph"


async def test_get_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    fetched = await view_repo.get_view(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id
    assert fetched.name == created.name


async def test_get_view_missing(db_session: AsyncSession):
    result = await view_repo.get_view(db_session, "nonexistent")
    assert result is None


async def test_update_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    update_req = ViewUpdateRequest(name="Renamed View", visibility="enterprise")
    updated = await view_repo.update_view(db_session, created.id, update_req)

    assert updated is not None
    assert updated.name == "Renamed View"
    assert updated.visibility == "enterprise"


async def test_update_view_missing(db_session: AsyncSession):
    update_req = ViewUpdateRequest(name="Does Not Exist")
    result = await view_repo.update_view(db_session, "nonexistent", update_req)
    assert result is None


async def test_delete_view_soft_deletes(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    result = await view_repo.delete_view(db_session, created.id)
    assert result is True

    # Soft-deleted: still retrievable via get (no deleted_at filter in get_view)
    fetched = await view_repo.get_view(db_session, created.id)
    assert fetched is not None
    assert fetched.deleted_at is not None

    # Not included in default filtered listing
    listed = await view_repo.list_views_filtered(db_session)
    assert listed.total == 0
    assert listed.items == []


async def test_restore_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    await view_repo.delete_view(db_session, created.id)
    result = await view_repo.restore_view(db_session, created.id)
    assert result is True

    # Now shows up in listing
    listed = await view_repo.list_views_filtered(db_session)
    assert listed.total == 1
    assert len(listed.items) == 1


async def test_restore_non_deleted_returns_false(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    # View is not deleted, restore should return False
    result = await view_repo.restore_view(db_session, created.id)
    assert result is False


async def test_list_views_filtered_by_visibility(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    await view_repo.create_view(
        db_session, _make_create_req(ws.id, name="Private", visibility="private")
    )
    await view_repo.create_view(
        db_session, _make_create_req(ws.id, name="Enterprise", visibility="enterprise")
    )

    private_views = await view_repo.list_views_filtered(
        db_session, visibility="private"
    )
    assert private_views.total == 1
    assert private_views.items[0].name == "Private"

    enterprise_views = await view_repo.list_views_filtered(
        db_session, visibility="enterprise"
    )
    assert enterprise_views.total == 1
    assert enterprise_views.items[0].name == "Enterprise"


async def test_favourite_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    result = await view_repo.favourite_view(db_session, created.id, "user_1")
    assert result is True


async def test_unfavourite_view(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    await view_repo.favourite_view(db_session, created.id, "user_1")
    result = await view_repo.unfavourite_view(db_session, created.id, "user_1")
    assert result is True

    # Unfavouriting again returns False
    result2 = await view_repo.unfavourite_view(db_session, created.id, "user_1")
    assert result2 is False


async def test_favourite_view_is_idempotent(db_session: AsyncSession):
    """Second favourite call for the same user returns False (already favourited)."""
    ws = await _create_workspace(db_session)
    created = await view_repo.create_view(db_session, _make_create_req(ws.id))

    first = await view_repo.favourite_view(db_session, created.id, "user_1")
    assert first is True

    second = await view_repo.favourite_view(db_session, created.id, "user_1")
    assert second is False
