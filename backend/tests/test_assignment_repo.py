"""
Tests for backend.app.db.repositories.assignment_repo.
"""
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.repositories import assignment_repo
from backend.app.db.models import GraphConnectionORM, WorkspaceORM
from backend.common.models.management import RuleSetCreateRequest, RuleSetResponse


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_connection(session: AsyncSession, name: str = "test-conn") -> GraphConnectionORM:
    conn = GraphConnectionORM(
        name=name,
        provider_type="falkordb",
    )
    session.add(conn)
    await session.flush()
    return conn


async def _create_workspace(session: AsyncSession, name: str = "test-ws") -> WorkspaceORM:
    ws = WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


def _make_rule_set_req(**overrides) -> RuleSetCreateRequest:
    defaults = dict(
        name="Default Rules",
        description="Test rule set",
        layers_config=[{"layer": "infra", "rules": []}],
        is_default=False,
    )
    defaults.update(overrides)
    return RuleSetCreateRequest(**defaults)


# ---------------------------------------------------------------------------
# Tests — connection-scoped
# ---------------------------------------------------------------------------

async def test_create_rule_set_with_connection(db_session: AsyncSession):
    conn = await _create_connection(db_session)
    req = _make_rule_set_req()
    resp = await assignment_repo.create_rule_set(db_session, conn.id, req)

    assert isinstance(resp, RuleSetResponse)
    assert resp.name == "Default Rules"
    assert resp.connection_id == conn.id
    assert resp.layers_config == [{"layer": "infra", "rules": []}]


async def test_get_rule_set(db_session: AsyncSession):
    conn = await _create_connection(db_session)
    created = await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req()
    )
    fetched = await assignment_repo.get_rule_set(db_session, created.id)
    assert fetched is not None
    assert fetched.id == created.id


async def test_get_rule_set_missing(db_session: AsyncSession):
    result = await assignment_repo.get_rule_set(db_session, "nonexistent")
    assert result is None


async def test_list_rule_sets(db_session: AsyncSession):
    conn = await _create_connection(db_session)
    await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req(name="A")
    )
    await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req(name="B")
    )
    results = await assignment_repo.list_rule_sets(db_session, conn.id)
    assert len(results) == 2
    names = {r.name for r in results}
    assert names == {"A", "B"}


async def test_update_rule_set(db_session: AsyncSession):
    conn = await _create_connection(db_session)
    created = await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req()
    )
    update_req = _make_rule_set_req(name="Updated Name", is_default=True)
    updated = await assignment_repo.update_rule_set(db_session, created.id, update_req)

    assert updated is not None
    assert updated.name == "Updated Name"
    assert updated.is_default is True


async def test_update_rule_set_missing(db_session: AsyncSession):
    update_req = _make_rule_set_req(name="Ghost")
    result = await assignment_repo.update_rule_set(db_session, "nonexistent", update_req)
    assert result is None


async def test_delete_rule_set(db_session: AsyncSession):
    conn = await _create_connection(db_session)
    created = await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req()
    )
    result = await assignment_repo.delete_rule_set(db_session, created.id)
    assert result is True

    # Verify gone
    fetched = await assignment_repo.get_rule_set(db_session, created.id)
    assert fetched is None


async def test_delete_rule_set_missing(db_session: AsyncSession):
    result = await assignment_repo.delete_rule_set(db_session, "nonexistent")
    assert result is False


async def test_set_default_demotes_others(db_session: AsyncSession):
    """Creating a new default rule set should demote the existing default."""
    conn = await _create_connection(db_session)

    first = await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req(name="First", is_default=True)
    )
    assert first.is_default is True

    second = await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req(name="Second", is_default=True)
    )
    assert second.is_default is True

    # Refresh the first rule set — it should no longer be default
    first_refreshed = await assignment_repo.get_rule_set(db_session, first.id)
    assert first_refreshed is not None
    assert first_refreshed.is_default is False


async def test_get_default_rule_set(db_session: AsyncSession):
    conn = await _create_connection(db_session)
    await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req(name="Non-default", is_default=False)
    )
    await assignment_repo.create_rule_set(
        db_session, conn.id, _make_rule_set_req(name="The Default", is_default=True)
    )

    default = await assignment_repo.get_default_rule_set(db_session, conn.id)
    assert default is not None
    assert default.name == "The Default"
    assert default.is_default is True


# ---------------------------------------------------------------------------
# Tests — workspace-scoped
# ---------------------------------------------------------------------------

async def test_create_rule_set_for_workspace(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    req = _make_rule_set_req(name="WS Rules")
    resp = await assignment_repo.create_rule_set_for_workspace(db_session, ws.id, req)

    assert isinstance(resp, RuleSetResponse)
    assert resp.name == "WS Rules"
    # connectionId in response is workspace_id for workspace-scoped rule sets
    assert resp.connection_id == ws.id


async def test_list_rule_sets_by_workspace(db_session: AsyncSession):
    ws = await _create_workspace(db_session)
    await assignment_repo.create_rule_set_for_workspace(
        db_session, ws.id, _make_rule_set_req(name="WS Rule A")
    )
    await assignment_repo.create_rule_set_for_workspace(
        db_session, ws.id, _make_rule_set_req(name="WS Rule B")
    )

    results = await assignment_repo.list_rule_sets_by_workspace(db_session, ws.id)
    assert len(results) == 2
    names = {r.name for r in results}
    assert names == {"WS Rule A", "WS Rule B"}


async def test_workspace_default_demotes_others(db_session: AsyncSession):
    """Creating a workspace default should demote existing workspace defaults."""
    ws = await _create_workspace(db_session)

    first = await assignment_repo.create_rule_set_for_workspace(
        db_session, ws.id, _make_rule_set_req(name="First", is_default=True)
    )
    second = await assignment_repo.create_rule_set_for_workspace(
        db_session, ws.id, _make_rule_set_req(name="Second", is_default=True)
    )
    assert second.is_default is True

    first_refreshed = await assignment_repo.get_rule_set(db_session, first.id)
    assert first_refreshed is not None
    assert first_refreshed.is_default is False
