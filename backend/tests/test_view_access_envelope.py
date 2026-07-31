"""GET /views/{id} access envelope + primary-source resolution.

The enriched single-view response carries everything the frontend
needs to open a view WITHOUT workspace membership: the caller's
capabilities (``access``), the resolved data source (primary when the
view stores NULL), and the provider id. List payloads stay
envelope-free — no per-row grant math.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import (
    ProviderORM,
    ViewORM,
    WorkspaceDataSourceORM,
    WorkspaceORM,
)
from backend.app.db.repositories import grant_repo
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


WS = "ws_env"
DS = "ds_env_primary"
PROVIDER = "prov_env"

OWNER = _user("usr_owner")
OUTSIDER = _user("usr_outsider")
GRANTEE = _user("usr_grantee")
WS_ADMIN = _user("usr_admin")

OWNER_CLAIMS = PermissionClaims(sid="s_owner", ws_perms={WS: (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
    "workspace:datasource:*",
)})
EMPTY_CLAIMS = PermissionClaims(sid="s_empty")
ADMIN_CLAIMS = PermissionClaims(sid="s_admin", ws_perms={WS: (
    "workspace:admin", "workspace:view:*", "workspace:datasource:*",
)})


async def _seed(db_session, *, view_ds=None, visibility="enterprise",
                created_by=OWNER.id, view_id="view_env"):
    if (await db_session.get(WorkspaceORM, WS)) is None:
        db_session.add(WorkspaceORM(id=WS, name="Envelope WS"))
        db_session.add(ProviderORM(
            id=PROVIDER, name="Env Provider", provider_type="falkordb",
        ))
        db_session.add(WorkspaceDataSourceORM(
            id=DS, workspace_id=WS, provider_id=PROVIDER,
            label="Primary Source", graph_name="env_graph", is_primary=True,
        ))
    db_session.add(ViewORM(
        id=view_id, name=view_id, workspace_id=WS,
        data_source_id=view_ds, visibility=visibility, created_by=created_by,
    ))
    await db_session.commit()
    return view_id


@pytest.mark.asyncio
async def test_envelope_owner(test_client: AsyncClient, db_session):
    vid = await _seed(db_session, view_ds=DS)
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 200
    access = r.json().get("access")
    assert access is not None, "single-view response must carry the envelope"
    assert access["accessVia"] == "owner"
    assert access["canEdit"] is True
    assert access["canManageGrants"] is True
    assert access["canChangeVisibility"] is True
    assert access["canPublish"] is False  # member leaves, no publish
    assert access["dataAccess"] == "full"  # datasource:* implies manage


@pytest.mark.asyncio
async def test_envelope_enterprise_outsider_readonly(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session, view_ds=DS)
    with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 200
    access = r.json()["access"]
    assert access["accessVia"] == "enterprise"
    assert access["canEdit"] is False
    assert access["canManageGrants"] is False
    assert access["canChangeVisibility"] is False
    assert access["canPublish"] is False
    assert access["dataAccess"] == "readonly"


@pytest.mark.asyncio
async def test_envelope_editor_grantee_edits_config_not_data(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session, view_ds=DS, visibility="private")
    await grant_repo.create_grant(
        db_session, resource_type="view", resource_id=vid,
        subject_type="user", subject_id=GRANTEE.id, role_name="editor",
    )
    await db_session.commit()
    with _auth(user=GRANTEE, claims=EMPTY_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    assert r.status_code == 200
    access = r.json()["access"]
    assert access["accessVia"] == "grant"
    assert access["canEdit"] is True          # editor grant
    assert access["dataAccess"] == "readonly"  # graph data stays immutable
    assert access["canManageGrants"] is False


@pytest.mark.asyncio
async def test_envelope_ws_admin(test_client: AsyncClient, db_session):
    vid = await _seed(db_session, view_ds=DS, visibility="workspace")
    with _auth(user=WS_ADMIN, claims=ADMIN_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    access = r.json()["access"]
    assert access["accessVia"] == "admin"
    assert access["canPublish"] is True
    assert access["dataAccess"] == "full"


@pytest.mark.asyncio
async def test_primary_source_resolution(test_client: AsyncClient, db_session):
    """A view with NULL data_source_id resolves to the workspace primary
    — id, name, and provider — so a non-member can boot the canvas
    without the (membership-gated) workspace list."""
    vid = await _seed(db_session, view_ds=None)
    with _auth(user=OUTSIDER, claims=EMPTY_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    body = r.json()
    assert body["dataSourceId"] == DS
    assert body["dataSourceName"] == "Primary Source"
    assert body["providerId"] == PROVIDER
    assert body["workspaceName"] == "Envelope WS"


@pytest.mark.asyncio
async def test_explicit_source_carries_provider(
    test_client: AsyncClient, db_session,
):
    vid = await _seed(db_session, view_ds=DS)
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        r = await test_client.get(f"/api/v1/views/{vid}")
    assert r.json()["providerId"] == PROVIDER


@pytest.mark.asyncio
async def test_list_payload_has_no_envelope(test_client: AsyncClient, db_session):
    await _seed(db_session, view_ds=DS)
    with _auth(user=OWNER, claims=OWNER_CLAIMS):
        r = await test_client.get("/api/v1/views/")
    items = r.json()["items"]
    assert items, "seeded view must list"
    assert all(item.get("access") in (None,) for item in items)
