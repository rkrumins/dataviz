"""Publish-permission enforcement on the visibility endpoints.

Moving a view to or from ``enterprise`` exposes it (and read-only
access to its data source) platform-wide, so it requires
``workspace:view:publish`` on top of the base creator/ws-admin rule.
Private ↔ workspace stays with the creator. Creation directly as
``enterprise`` passes the same gate.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import ViewORM, WorkspaceORM
from backend.app.services.permission_service import PermissionClaims
from backend.tests.test_views_scoping_regressions import _auth, _user


WS = "ws_pub"

CREATOR = _user("usr_creator")
ADMIN = _user("usr_wsadmin")

# Post-resolver shapes: creator holds the four member leaves (no
# publish); the admin bundle collapses to workspace:view:* which
# includes publish; the third shape grants the single publish leaf to
# a non-admin (the "delegated publisher" case).
CREATOR_CLAIMS = PermissionClaims(sid="s_creator", ws_perms={WS: (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
)})
ADMIN_CLAIMS = PermissionClaims(sid="s_admin", ws_perms={WS: (
    "workspace:admin", "workspace:view:*",
)})
DELEGATED_CLAIMS = PermissionClaims(sid="s_delegate", ws_perms={WS: (
    "workspace:view:create", "workspace:view:edit",
    "workspace:view:delete", "workspace:view:read",
    "workspace:view:publish",
)})


async def _seed_view(db_session, *, visibility, view_id="view_pub",
                     created_by=CREATOR.id):
    if (await db_session.get(WorkspaceORM, WS)) is None:
        db_session.add(WorkspaceORM(id=WS, name="Pub"))
    db_session.add(ViewORM(
        id=view_id, name=view_id, workspace_id=WS,
        visibility=visibility, created_by=created_by,
    ))
    await db_session.commit()
    return view_id


async def _set_visibility(client, view_id, visibility):
    return await client.put(
        f"/api/v1/views/{view_id}/visibility",
        json={"visibility": visibility},
    )


@pytest.mark.asyncio
async def test_creator_moves_private_to_workspace(test_client: AsyncClient, db_session):
    vid = await _seed_view(db_session, visibility="private")
    with _auth(user=CREATOR, claims=CREATOR_CLAIMS):
        r = await _set_visibility(test_client, vid, "workspace")
    assert r.status_code == 200, r.text
    assert r.json()["visibility"] == "workspace"


@pytest.mark.asyncio
async def test_creator_without_publish_cannot_go_enterprise(
    test_client: AsyncClient, db_session,
):
    vid = await _seed_view(db_session, visibility="workspace")
    with _auth(user=CREATOR, claims=CREATOR_CLAIMS):
        r = await _set_visibility(test_client, vid, "enterprise")
    assert r.status_code == 403
    assert "workspace:view:publish" in r.text
    row = await db_session.get(ViewORM, vid)
    await db_session.refresh(row)
    assert row.visibility == "workspace"


@pytest.mark.asyncio
async def test_creator_without_publish_cannot_unpublish(
    test_client: AsyncClient, db_session,
):
    vid = await _seed_view(db_session, visibility="enterprise")
    with _auth(user=CREATOR, claims=CREATOR_CLAIMS):
        r = await _set_visibility(test_client, vid, "workspace")
    assert r.status_code == 403
    assert "workspace:view:publish" in r.text


@pytest.mark.asyncio
async def test_ws_admin_publishes_and_unpublishes(
    test_client: AsyncClient, db_session,
):
    vid = await _seed_view(db_session, visibility="workspace")
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        up = await _set_visibility(test_client, vid, "enterprise")
        down = await _set_visibility(test_client, vid, "private")
    assert up.status_code == 200, up.text
    assert down.status_code == 200, down.text


@pytest.mark.asyncio
async def test_delegated_publisher_needs_base_rule_too(
    test_client: AsyncClient, db_session,
):
    """Holding publish alone isn't enough — the base
    creator-or-ws-admin rule still gates who touches visibility at all."""
    vid = await _seed_view(db_session, visibility="workspace",
                           created_by="usr_someone_else")
    delegate = _user("usr_delegate")
    with _auth(user=delegate, claims=DELEGATED_CLAIMS):
        r = await _set_visibility(test_client, vid, "enterprise")
    assert r.status_code == 403


@pytest.mark.asyncio
async def test_delegated_creator_publishes(test_client: AsyncClient, db_session):
    """A creator who has been granted the publish leaf can publish
    their own view — the permission is delegable beyond admins."""
    delegate = _user("usr_delegate")
    vid = await _seed_view(db_session, visibility="workspace",
                           created_by=delegate.id)
    with _auth(user=delegate, claims=DELEGATED_CLAIMS):
        r = await _set_visibility(test_client, vid, "enterprise")
    assert r.status_code == 200, r.text


@pytest.mark.asyncio
async def test_enterprise_to_private_via_admin_records_activity(
    test_client: AsyncClient, db_session,
):
    """The transition logs the existing ``visibility_changed`` action —
    no new activity verbs were introduced."""
    vid = await _seed_view(db_session, visibility="workspace")
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        await _set_visibility(test_client, vid, "enterprise")
        acts = await test_client.get(f"/api/v1/views/{vid}/activity")
    assert acts.status_code == 200
    actions = [a["action"] for a in acts.json()]
    assert "visibility_changed" in actions
    assert not any(a in ("published", "unpublished") for a in actions)


# ── creation straight to enterprise ──────────────────────────────────

def _create_body(visibility):
    return {
        "name": "born-public", "workspaceId": WS,
        "viewType": "graph", "visibility": visibility,
    }


@pytest.mark.asyncio
async def test_member_cannot_create_enterprise_view(
    test_client: AsyncClient, db_session,
):
    await _seed_view(db_session, visibility="private", view_id="view_seed_ws")
    with _auth(user=CREATOR, claims=CREATOR_CLAIMS):
        r = await test_client.post("/api/v1/views/", json=_create_body("enterprise"))
    assert r.status_code == 403
    assert "workspace:view:publish" in r.text


@pytest.mark.asyncio
async def test_member_creates_workspace_view(test_client: AsyncClient, db_session):
    await _seed_view(db_session, visibility="private", view_id="view_seed_ws")
    with _auth(user=CREATOR, claims=CREATOR_CLAIMS):
        r = await test_client.post("/api/v1/views/", json=_create_body("workspace"))
    assert r.status_code == 201, r.text


@pytest.mark.asyncio
async def test_admin_creates_enterprise_view(test_client: AsyncClient, db_session):
    await _seed_view(db_session, visibility="private", view_id="view_seed_ws")
    with _auth(user=ADMIN, claims=ADMIN_CLAIMS):
        r = await test_client.post("/api/v1/views/", json=_create_body("enterprise"))
    assert r.status_code == 201, r.text
    assert r.json()["visibility"] == "enterprise"
