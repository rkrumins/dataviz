"""
Endpoint contract for the reduced context-models surface (Task 5).

Instances are retired — only templates remain:
  * The workspace-scoped instance CRUD (list/create/get/update/delete/instantiate,
    and /{id}/views) is GONE → those paths 404.
  * The workspace-scoped template read routes stay and are reachable by a NON-admin
    workspace member (``workspace:datasource:read`` only), while the admin template
    router still requires ``system:admin``.
"""
import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import WorkspaceORM
from backend.app.db.repositories import context_model_repo
from backend.common.models.management import ContextModelCreateRequest

WS = "ws_ctxmodels"


async def _seed_template(session: AsyncSession, name="Star Schema") -> str:
    ws = await session.get(WorkspaceORM, WS)
    if ws is None:
        session.add(WorkspaceORM(id=WS, name="CtxModels WS"))
        await session.flush()
    tpl = await context_model_repo.create_context_model(
        session,
        ContextModelCreateRequest(
            name=name,
            is_template=True,
            category="data-engineering",
            layers_config=[{"type": "entity", "entityTypes": ["Table"]}],
            instance_assignments={},
        ),
    )
    return tpl.id


async def test_workspace_template_routes_are_readable(
    test_client: AsyncClient, db_session: AsyncSession
):
    tpl_id = await _seed_template(db_session)

    listed = await test_client.get(f"/api/v1/{WS}/context-models/templates")
    assert listed.status_code == 200
    assert any(t["id"] == tpl_id for t in listed.json())

    got = await test_client.get(f"/api/v1/{WS}/context-models/templates/{tpl_id}")
    assert got.status_code == 200
    assert got.json()["id"] == tpl_id
    assert got.json()["isTemplate"] is True


async def test_get_template_404_for_non_template(
    test_client: AsyncClient, db_session: AsyncSession
):
    # A non-template id must not resolve through the template read route.
    got = await test_client.get(f"/api/v1/{WS}/context-models/templates/cm_missing")
    assert got.status_code == 404


@pytest.mark.parametrize(
    "method,path",
    [
        ("GET", f"/api/v1/{WS}/context-models"),
        ("POST", f"/api/v1/{WS}/context-models"),
        ("GET", f"/api/v1/{WS}/context-models/cm_x"),
        ("PUT", f"/api/v1/{WS}/context-models/cm_x"),
        ("DELETE", f"/api/v1/{WS}/context-models/cm_x"),
        ("POST", f"/api/v1/{WS}/context-models/instantiate"),
        ("GET", f"/api/v1/{WS}/context-models/cm_x/views"),
    ],
)
async def test_instance_crud_routes_are_gone(
    test_client: AsyncClient, method: str, path: str
):
    resp = await test_client.request(method, path, json={})
    # The routes no longer exist — FastAPI returns 404 (unknown path) or 405
    # (path matched a different verb). Either proves the instance surface is gone.
    assert resp.status_code in (404, 405)


async def test_non_admin_member_can_read_templates_but_not_admin_router(
    test_client: AsyncClient, db_session: AsyncSession
):
    """A workspace member with only ``workspace:datasource:read`` reads templates
    via the workspace route, but the admin template router stays ``system:admin``-only."""
    from backend.app.main import app
    from backend.app.auth.dependencies import get_permission_claims
    from backend.app.services.permission_service import PermissionClaims

    await _seed_template(db_session, name="Member Visible")

    def _member_claims():
        return PermissionClaims(
            sid="sess_member",
            global_perms=(),  # NOT system:admin
            ws_perms={WS: ("workspace:datasource:read",)},
        )

    app.dependency_overrides[get_permission_claims] = _member_claims
    try:
        ws_route = await test_client.get(f"/api/v1/{WS}/context-models/templates")
        assert ws_route.status_code == 200
        assert any(t["name"] == "Member Visible" for t in ws_route.json())

        admin_route = await test_client.get("/api/v1/admin/context-model-templates")
        assert admin_route.status_code == 403
    finally:
        app.dependency_overrides.pop(get_permission_claims, None)
