"""Object-level authorization for assignment rule-sets.

``requires(..., workspace='ws_id')`` — and the capability gate mounted on
this router — authorize the caller against the workspace named in the
PATH. They say nothing about the row a handler then loads. When the
lookup was by id alone, a caller entitled to workspace A could read and
DELETE workspace B's rule set simply by naming their own workspace in
the path and B's id in the last segment.

The route-level coverage suite cannot see this: it asserts 401/403 on the
gate and explicitly stops there ("we only care that the auth gate let it
through"). So these tests drive two real workspaces and assert on the
ROW, which is the only way the difference shows up.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_permission_claims
from backend.app.db import models as _models
from backend.app.db.repositories import assignment_repo
from backend.app.services.permission_service import PermissionClaims
from backend.common.models.management import RuleSetCreateRequest


async def _workspace(session: AsyncSession, name: str) -> _models.WorkspaceORM:
    ws = _models.WorkspaceORM(name=name)
    session.add(ws)
    await session.flush()
    return ws


def _scope_client_to(workspace_id: str) -> None:
    """Re-point the claims override at a single workspace.

    The conftest client is ``system:admin``, which short-circuits every
    check in ``has_permission`` — an admin would legitimately reach both
    workspaces, so it cannot demonstrate the boundary. This narrows the
    caller to a member of ONE workspace, which is the shape that makes
    the cross-workspace request a violation.
    """
    from backend.app.main import app

    def _claims() -> PermissionClaims:
        return PermissionClaims(
            sid="sess_test",
            global_perms=(),
            ws_perms={workspace_id: (
                "workspace:datasource:read",
                "workspace:datasource:manage",
            )},
        )

    app.dependency_overrides[get_permission_claims] = _claims


@pytest.fixture()
async def two_workspaces(db_session: AsyncSession):
    ws_a = await _workspace(db_session, "ws-alpha")
    ws_b = await _workspace(db_session, "ws-beta")
    victim = await assignment_repo.create_rule_set_for_workspace(
        db_session, ws_b.id,
        RuleSetCreateRequest(
            name="Beta rules",
            description="belongs to the other workspace",
            layers_config=[],
            is_default=False,
        ),
    )
    await db_session.commit()
    return ws_a, ws_b, victim


async def test_get_rule_set_from_another_workspace_is_404(
    test_client: AsyncClient, two_workspaces,
):
    ws_a, _ws_b, victim = two_workspaces
    _scope_client_to(ws_a.id)

    res = await test_client.get(f"/api/v1/{ws_a.id}/assets/rule-sets/{victim.id}")

    # 404 rather than 403: the row's existence — and which workspace it
    # lives in — stays private from a caller with no path to it.
    assert res.status_code == 404, res.text


async def test_delete_rule_set_from_another_workspace_is_404_and_leaves_the_row(
    test_client: AsyncClient, db_session: AsyncSession, two_workspaces,
):
    ws_a, ws_b, victim = two_workspaces
    _scope_client_to(ws_a.id)

    res = await test_client.delete(f"/api/v1/{ws_a.id}/assets/rule-sets/{victim.id}")
    assert res.status_code == 404, res.text

    # The 404 must mean "not deleted", not "deleted, then reported missing".
    survivor = await assignment_repo.get_rule_set_for_workspace(
        db_session, ws_b.id, victim.id,
    )
    assert survivor is not None
    assert survivor.name == "Beta rules"


async def test_own_workspace_rule_set_is_still_reachable(
    test_client: AsyncClient, db_session: AsyncSession, two_workspaces,
):
    """The scoping must not break the legitimate path."""
    ws_a, _ws_b, _victim = two_workspaces
    mine = await assignment_repo.create_rule_set_for_workspace(
        db_session, ws_a.id,
        RuleSetCreateRequest(
            name="Alpha rules", description=None,
            layers_config=[], is_default=False,
        ),
    )
    await db_session.commit()
    _scope_client_to(ws_a.id)

    res = await test_client.get(f"/api/v1/{ws_a.id}/assets/rule-sets/{mine.id}")
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "Alpha rules"

    res = await test_client.delete(f"/api/v1/{ws_a.id}/assets/rule-sets/{mine.id}")
    assert res.status_code == 204, res.text
