"""End-to-end tests for the RBAC Phase 2 endpoints.

Covers:
  * /admin/groups CRUD + members
  * /admin/workspaces/{ws}/members CRUD
  * /views/{view}/grants CRUD
  * /admin/role-bindings audit query
  * Workspace + data-source enforcement edges
  * View three-layer evaluator (read/edit/delete/restore/visibility)

Tests run against the conftest's in-memory SQLite + dependency
overrides. The fake user is a system admin via the conftest claim
override; we don't need to mint real JWTs.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import (
    UserORM,
    WorkspaceORM,
    ViewORM,
)


# ── helpers ──────────────────────────────────────────────────────────

async def _seed_user(session, *, user_id="usr_bob", email="bob@example.com"):
    session.add(UserORM(
        id=user_id,
        email=email,
        password_hash="x",
        first_name="Bob",
        last_name="Bobson",
        status="active",
        auth_provider="local",
    ))
    await session.commit()
    return user_id


async def _seed_workspace(session, *, ws_id="ws_finance", name="Finance"):
    session.add(WorkspaceORM(id=ws_id, name=name))
    await session.commit()
    return ws_id


async def _seed_view(
    session,
    *,
    view_id="view_test",
    workspace_id="ws_finance",
    visibility="private",
    created_by="usr_test000000",
):
    session.add(ViewORM(
        id=view_id,
        name=view_id,
        workspace_id=workspace_id,
        visibility=visibility,
        created_by=created_by,
    ))
    await session.commit()
    return view_id


# ── /admin/groups ────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_groups_crud_round_trip(test_client: AsyncClient, db_session):
    # Create.
    r = await test_client.post(
        "/api/v1/admin/groups",
        json={"name": "marketing", "description": "MKT"},
    )
    assert r.status_code == 201, r.text
    group_id = r.json()["id"]
    assert group_id.startswith("grp_")

    # Conflict on same name.
    r = await test_client.post("/api/v1/admin/groups", json={"name": "marketing"})
    assert r.status_code == 409

    # List shows it.
    r = await test_client.get("/api/v1/admin/groups")
    assert r.status_code == 200
    assert any(g["id"] == group_id for g in r.json())

    # Update.
    r = await test_client.patch(
        f"/api/v1/admin/groups/{group_id}",
        json={"description": "updated"},
    )
    assert r.status_code == 200
    assert r.json()["description"] == "updated"

    # Delete.
    r = await test_client.delete(f"/api/v1/admin/groups/{group_id}")
    assert r.status_code == 204

    # 404 after delete.
    r = await test_client.patch(
        f"/api/v1/admin/groups/{group_id}",
        json={"name": "x"},
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_group_membership_round_trip(test_client: AsyncClient, db_session):
    user_id = await _seed_user(db_session)

    r = await test_client.post("/api/v1/admin/groups", json={"name": "qa"})
    assert r.status_code == 201, r.text
    group_id = r.json()["id"]

    # Add member.
    r = await test_client.post(
        f"/api/v1/admin/groups/{group_id}/members",
        json={"userId": user_id},
    )
    assert r.status_code == 201

    # Member count reflected.
    r = await test_client.get("/api/v1/admin/groups")
    g = next(g for g in r.json() if g["id"] == group_id)
    assert g["memberCount"] == 1

    # List members.
    r = await test_client.get(f"/api/v1/admin/groups/{group_id}/members")
    assert r.status_code == 200
    assert {m["userId"] for m in r.json()} == {user_id}

    # Remove.
    r = await test_client.delete(
        f"/api/v1/admin/groups/{group_id}/members/{user_id}"
    )
    assert r.status_code == 204

    # 404 on second remove.
    r = await test_client.delete(
        f"/api/v1/admin/groups/{group_id}/members/{user_id}"
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_group_member_add_404_for_unknown_user(
    test_client: AsyncClient, db_session,
):
    r = await test_client.post("/api/v1/admin/groups", json={"name": "ops"})
    group_id = r.json()["id"]

    r = await test_client.post(
        f"/api/v1/admin/groups/{group_id}/members",
        json={"userId": "usr_does_not_exist"},
    )
    assert r.status_code == 404


# ── /admin/workspaces/{ws}/members ──────────────────────────────────

@pytest.mark.asyncio
async def test_workspace_member_crud(test_client: AsyncClient, db_session):
    ws_id = await _seed_workspace(db_session)
    user_id = await _seed_user(db_session)

    # Create binding.
    r = await test_client.post(
        f"/api/v1/admin/workspaces/{ws_id}/members",
        json={"subjectType": "user", "subjectId": user_id, "role": "user"},
    )
    assert r.status_code == 201, r.text
    body = r.json()
    binding_id = body["bindingId"]
    assert body["role"] == "user"
    assert body["subject"]["type"] == "user"
    assert body["subject"]["displayName"] == "Bob Bobson"

    # List.
    r = await test_client.get(f"/api/v1/admin/workspaces/{ws_id}/members")
    assert r.status_code == 200
    assert any(b["bindingId"] == binding_id for b in r.json())

    # Idempotent: adding the same user × same role again is a 409.
    r = await test_client.post(
        f"/api/v1/admin/workspaces/{ws_id}/members",
        json={"subjectType": "user", "subjectId": user_id, "role": "user"},
    )
    assert r.status_code == 409

    # Revoke.
    r = await test_client.delete(
        f"/api/v1/admin/workspaces/{ws_id}/members/{binding_id}"
    )
    assert r.status_code == 204

    # 404 after revoke.
    r = await test_client.delete(
        f"/api/v1/admin/workspaces/{ws_id}/members/{binding_id}"
    )
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_workspace_member_404_for_unknown_workspace(
    test_client: AsyncClient,
):
    r = await test_client.get(
        "/api/v1/admin/workspaces/ws_ghost/members"
    )
    assert r.status_code == 404


# ── /views/{view}/grants ────────────────────────────────────────────

@pytest.mark.asyncio
async def test_view_grant_crud(test_client: AsyncClient, db_session):
    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(
        db_session, workspace_id=ws_id, created_by="usr_test000000",
    )
    user_id = await _seed_user(db_session)

    # Create.
    r = await test_client.post(
        f"/api/v1/views/{view_id}/grants",
        json={"subjectType": "user", "subjectId": user_id, "role": "editor"},
    )
    assert r.status_code == 201, r.text
    grant_id = r.json()["grantId"]
    assert r.json()["role"] == "editor"

    # List.
    r = await test_client.get(f"/api/v1/views/{view_id}/grants")
    assert r.status_code == 200
    assert any(g["grantId"] == grant_id for g in r.json())

    # 409 duplicate subject.
    r = await test_client.post(
        f"/api/v1/views/{view_id}/grants",
        json={"subjectType": "user", "subjectId": user_id, "role": "viewer"},
    )
    assert r.status_code == 409

    # Delete.
    r = await test_client.delete(f"/api/v1/views/{view_id}/grants/{grant_id}")
    assert r.status_code == 204

    # 404 on second delete.
    r = await test_client.delete(f"/api/v1/views/{view_id}/grants/{grant_id}")
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_view_grant_rejects_admin_role(test_client: AsyncClient, db_session):
    """The grant role enum is narrow — 'admin' must be rejected at the
    DTO/repo boundary, not silently coerced."""
    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(db_session, workspace_id=ws_id)
    user_id = await _seed_user(db_session)

    r = await test_client.post(
        f"/api/v1/views/{view_id}/grants",
        json={"subjectType": "user", "subjectId": user_id, "role": "admin"},
    )
    # The DTO has no role enum constraint, so the repo's validation
    # surfaces as a 400 from the endpoint (caught ValueError handler).
    assert r.status_code == 400


# ── /admin/role-bindings audit ──────────────────────────────────────

@pytest.mark.asyncio
async def test_role_bindings_audit_filters(test_client: AsyncClient, db_session):
    ws_id = await _seed_workspace(db_session)
    user_id = await _seed_user(db_session)

    # Seed via the workspace-members endpoint so the binding is real.
    await test_client.post(
        f"/api/v1/admin/workspaces/{ws_id}/members",
        json={"subjectType": "user", "subjectId": user_id, "role": "user"},
    )

    # Filter by subject_id.
    r = await test_client.get(
        "/api/v1/admin/role-bindings",
        params={"subjectId": user_id},
    )
    assert r.status_code == 200, r.text
    rows = r.json()
    assert all(row["subjectId"] == user_id for row in rows)
    assert any(row["scopeId"] == ws_id and row["role"] == "user" for row in rows)

    # Filter by scope.
    r = await test_client.get(
        "/api/v1/admin/role-bindings",
        params={"scopeType": "workspace", "scopeId": ws_id},
    )
    assert r.status_code == 200
    assert all(row["scopeId"] == ws_id for row in r.json())


@pytest.mark.asyncio
async def test_role_bindings_audit_rejects_bad_scope_type(
    test_client: AsyncClient,
):
    r = await test_client.get(
        "/api/v1/admin/role-bindings",
        params={"scopeType": "wrong"},
    )
    assert r.status_code == 400


# ── view three-layer evaluator (unit-level) ─────────────────────────

@pytest.mark.asyncio
async def test_view_access_evaluator_layer1_workspace_member(db_session):
    """Layer 1: workspace binding is sufficient for read."""
    from backend.app.services import view_access
    from backend.app.services.permission_service import PermissionClaims

    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(
        db_session, workspace_id=ws_id, visibility="private",
        created_by="usr_someone_else",
    )

    # Caller has workspace:view:read but is NOT the creator.
    claims = PermissionClaims(
        sid="sess_a",
        ws_perms={ws_id: ("workspace:view:read",)},
    )
    user = type("U", (), {"id": "usr_caller"})()
    ctx = await view_access.ViewerContext.build(db_session, user=user, claims=claims)

    # Look up the ORM row directly for the predicate test.
    from sqlalchemy import select
    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()

    # Private + not creator + not workspace admin → Layer 2 fails.
    # But Layer 1 grants read because the user is a workspace member.
    assert await view_access.can_read_view(db_session, ctx, view)


@pytest.mark.asyncio
async def test_view_access_evaluator_private_blocks_strangers(db_session):
    """A private view is invisible to non-members non-creators."""
    from backend.app.services import view_access
    from backend.app.services.permission_service import PermissionClaims

    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(
        db_session, workspace_id=ws_id, visibility="private",
        created_by="usr_alice",
    )

    # Caller has NO permissions in ws_id.
    claims = PermissionClaims(sid="sess_x", ws_perms={})
    user = type("U", (), {"id": "usr_stranger"})()
    ctx = await view_access.ViewerContext.build(db_session, user=user, claims=claims)

    from sqlalchemy import select
    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()

    assert not await view_access.can_read_view(db_session, ctx, view)
    assert not await view_access.can_edit_view(db_session, ctx, view)
    assert not view_access.can_delete_view(ctx, view)


@pytest.mark.asyncio
async def test_view_access_evaluator_explicit_grant_extends_access(db_session):
    """Layer 3: an explicit grant to a stranger lets them open the view
    even with no workspace binding."""
    from backend.app.services import view_access
    from backend.app.services.permission_service import PermissionClaims
    from backend.app.db.repositories import grant_repo

    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(
        db_session, workspace_id=ws_id, visibility="private",
        created_by="usr_alice",
    )
    # Bob is a stranger (no workspace bindings) but has an explicit
    # editor grant on the view.
    bob_id = await _seed_user(db_session, user_id="usr_bob_grant", email="bob_grant@example.com")
    await grant_repo.create_grant(
        db_session,
        resource_type="view",
        resource_id=view_id,
        subject_type="user",
        subject_id=bob_id,
        role_name="editor",
    )
    await db_session.commit()

    claims = PermissionClaims(sid="sess_b", ws_perms={})
    user = type("U", (), {"id": bob_id})()
    ctx = await view_access.ViewerContext.build(db_session, user=user, claims=claims)

    from sqlalchemy import select
    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()

    assert await view_access.can_read_view(db_session, ctx, view)
    assert await view_access.can_edit_view(db_session, ctx, view)
    # But explicit editor grant does NOT confer delete.
    assert not view_access.can_delete_view(ctx, view)


@pytest.mark.asyncio
async def test_view_access_evaluator_creator_can_edit_and_soft_delete(db_session):
    from backend.app.services import view_access
    from backend.app.services.permission_service import PermissionClaims

    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(
        db_session, workspace_id=ws_id, visibility="private",
        created_by="usr_creator",
    )

    claims = PermissionClaims(sid="sess_c", ws_perms={})
    user = type("U", (), {"id": "usr_creator"})()
    ctx = await view_access.ViewerContext.build(db_session, user=user, claims=claims)

    from sqlalchemy import select
    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()

    assert await view_access.can_read_view(db_session, ctx, view)
    assert await view_access.can_edit_view(db_session, ctx, view)
    assert view_access.can_delete_view(ctx, view)
    # Creator does NOT get hard-delete (workspace:admin only).
    assert not view_access.can_hard_delete_view(ctx, view)


@pytest.mark.asyncio
async def test_view_access_evaluator_workspace_admin_can_hard_delete(db_session):
    from backend.app.services import view_access
    from backend.app.services.permission_service import PermissionClaims

    ws_id = await _seed_workspace(db_session)
    view_id = await _seed_view(
        db_session, workspace_id=ws_id, visibility="private",
        created_by="usr_someone_else",
    )

    claims = PermissionClaims(
        sid="sess_d",
        ws_perms={ws_id: ("workspace:admin",)},
    )
    user = type("U", (), {"id": "usr_ws_admin"})()
    ctx = await view_access.ViewerContext.build(db_session, user=user, claims=claims)

    from sqlalchemy import select
    view = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )).scalar_one()

    assert view_access.can_hard_delete_view(ctx, view)
    assert view_access.can_change_visibility(ctx, view)
    assert view_access.can_restore_view(ctx, view)
