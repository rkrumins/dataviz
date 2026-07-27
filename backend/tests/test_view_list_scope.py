"""Endpoint-level consequences of moving view authorization into SQL.

Covers the things that only show up at the API boundary:

  * ``total``/``hasMore`` now describe the authorized population, so
    ``total - len(items)`` no longer counts what the caller can't see.
  * The tier can only be changed by someone allowed to change it, on
    *both* routes that write the field.
  * Promoting a view leaves a security-trail entry, not just a product
    timeline entry.
  * Hard-deleting a view takes its grants with it.
"""
from __future__ import annotations

import contextlib

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from backend.app.auth.dependencies import (
    get_current_user,
    get_optional_user,
    get_permission_claims,
)
from backend.app.db.models import (
    OutboxEventORM,
    ResourceGrantORM,
    ViewORM,
    WorkspaceORM,
)
from backend.app.services.permission_service import PermissionClaims

WS = "ws_finance"


@contextlib.contextmanager
def _as(user_id: str, claims: PermissionClaims):
    """Run requests as a specific principal (the fixture is a sysadmin)."""
    from backend.app.main import app

    user = type("U", (), {"id": user_id, "email": f"{user_id}@example.com"})()

    async def _user():
        return user

    def _claims():
        return claims

    prev = {
        dep: app.dependency_overrides.get(dep)
        for dep in (get_current_user, get_optional_user, get_permission_claims)
    }
    app.dependency_overrides[get_current_user] = _user
    app.dependency_overrides[get_optional_user] = _user
    app.dependency_overrides[get_permission_claims] = _claims
    try:
        yield
    finally:
        for dep, original in prev.items():
            if original is None:
                app.dependency_overrides.pop(dep, None)
            else:
                app.dependency_overrides[dep] = original


async def _seed_mixed(session):
    """One workspace, four views — one per tier, all owned by someone else."""
    session.add(WorkspaceORM(id=WS, name="Finance"))
    for tier in ("private", "workspace", "enterprise", "public"):
        session.add(ViewORM(
            id=f"view_{tier}", name=tier.title(), workspace_id=WS,
            visibility=tier, created_by="usr_owner",
        ))
    await session.commit()


# ── the count no longer leaks ────────────────────────────────────────

@pytest.mark.asyncio
async def test_total_matches_what_the_caller_can_see(
    test_client: AsyncClient, db_session,
):
    """``total`` counted the unfiltered set while rows were filtered in
    Python afterwards, so ``total - len(items)`` was an exact count of the
    views the caller was denied — and with ``search``, a probing oracle
    over their metadata."""
    await _seed_mixed(db_session)

    # A member of the workspace: sees workspace + enterprise + public,
    # but not the private view owned by someone else.
    member = PermissionClaims(sid="s", ws_perms={WS: ("workspace:view:read",)})
    with _as("usr_member", member):
        resp = await test_client.get("/api/v1/views/")
    assert resp.status_code == 200
    body = resp.json()

    names = {v["id"] for v in body["items"]}
    assert names == {"view_workspace", "view_enterprise", "view_public"}
    assert body["total"] == len(body["items"]) == 3
    assert body["hasMore"] is False


@pytest.mark.asyncio
async def test_search_does_not_leak_counts_for_hidden_views(
    test_client: AsyncClient, db_session,
):
    """Searching for a private view's name returns nothing AND counts nothing."""
    session = db_session
    session.add(WorkspaceORM(id=WS, name="Finance"))
    session.add(ViewORM(
        id="view_secret", name="Acquisition Targets Q4", workspace_id=WS,
        visibility="private", created_by="usr_owner",
    ))
    await session.commit()

    member = PermissionClaims(sid="s", ws_perms={WS: ("workspace:view:read",)})
    with _as("usr_member", member):
        resp = await test_client.get(
            "/api/v1/views/", params={"search": "Acquisition"},
        )
    body = resp.json()
    assert body["items"] == []
    assert body["total"] == 0


@pytest.mark.asyncio
async def test_stranger_with_no_binding_sees_only_public(
    test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    stranger = PermissionClaims(sid="s", ws_perms={})
    with _as("usr_stranger", stranger):
        resp = await test_client.get("/api/v1/views/")
    body = resp.json()
    assert {v["id"] for v in body["items"]} == {"view_public"}
    assert body["total"] == 1


@pytest.mark.asyncio
async def test_granted_by_is_stamped_on_list_items(
    test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    member = PermissionClaims(sid="s", ws_perms={WS: ("workspace:view:read",)})
    with _as("usr_member", member):
        resp = await test_client.get("/api/v1/views/")
    by_id = {v["id"]: v["grantedBy"] for v in resp.json()["items"]}
    assert by_id == {
        "view_workspace": "tier:workspace",
        "view_enterprise": "tier:enterprise",
        "view_public": "tier:public",
    }


# ── the tier can only be changed by someone allowed to ───────────────

@pytest.mark.asyncio
async def test_general_update_route_cannot_bypass_the_visibility_gate(
    test_client: AsyncClient, db_session,
):
    """``PUT /views/{id}`` writes ``visibility`` too.

    It gated on ``can_edit_view`` (``workspace:view:edit`` — a standard
    member) while ``PUT /views/{id}/visibility`` gated on the stricter
    creator-or-workspace-admin rule. Sending the field through the general
    route was therefore a way around the stricter gate.
    """
    await _seed_mixed(db_session)
    editor = PermissionClaims(
        sid="s",
        ws_perms={WS: ("workspace:view:read", "workspace:view:edit")},
    )

    with _as("usr_editor", editor):
        resp = await test_client.put(
            "/api/v1/views/view_workspace", json={"visibility": "public"},
        )
    assert resp.status_code == 403

    # And the dedicated route refuses them too — the two now agree.
    with _as("usr_editor", editor):
        resp = await test_client.put(
            "/api/v1/views/view_workspace/visibility",
            json={"visibility": "public"},
        )
    assert resp.status_code == 403

    row = (await db_session.execute(
        select(ViewORM).where(ViewORM.id == "view_workspace")
    )).scalar_one()
    assert row.visibility == "workspace"


@pytest.mark.asyncio
async def test_editor_can_still_edit_everything_else(
    test_client: AsyncClient, db_session,
):
    """The bypass fix must not turn into "editors can't edit"."""
    await _seed_mixed(db_session)
    editor = PermissionClaims(
        sid="s",
        ws_perms={WS: ("workspace:view:read", "workspace:view:edit")},
    )
    with _as("usr_editor", editor):
        resp = await test_client.put(
            "/api/v1/views/view_workspace", json={"name": "Renamed"},
        )
    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed"


# ── the security trail ───────────────────────────────────────────────

async def _outbox_types(session) -> list[str]:
    return list((await session.execute(
        select(OutboxEventORM.event_type)
    )).scalars().all())


@pytest.mark.asyncio
async def test_widening_a_view_emits_a_warning_audit_event(
    test_client: AsyncClient, db_session,
):
    """Promotion is an access-widening mutation and belongs in the security
    trail next to role changes — the org_auditor role exists to review
    exactly these. It was previously recorded only in the per-view product
    timeline, which never reaches ``auth_audit_log``."""
    await _seed_mixed(db_session)

    resp = await test_client.put(
        "/api/v1/views/view_workspace/visibility",
        json={"visibility": "enterprise"},
    )
    assert resp.status_code == 200
    assert "rbac.view.visibility_widened" in await _outbox_types(db_session)


@pytest.mark.asyncio
async def test_narrowing_a_view_emits_the_counterpart(
    test_client: AsyncClient, db_session,
):
    await _seed_mixed(db_session)
    resp = await test_client.put(
        "/api/v1/views/view_enterprise/visibility",
        json={"visibility": "private"},
    )
    assert resp.status_code == 200
    assert "rbac.view.visibility_narrowed" in await _outbox_types(db_session)


@pytest.mark.asyncio
async def test_a_no_op_visibility_write_emits_nothing(
    test_client: AsyncClient, db_session,
):
    """Setting the tier it already has is not a change to audit."""
    await _seed_mixed(db_session)
    await test_client.put(
        "/api/v1/views/view_public/visibility", json={"visibility": "public"},
    )
    types = await _outbox_types(db_session)
    assert "rbac.view.visibility_widened" not in types
    assert "rbac.view.visibility_narrowed" not in types


@pytest.mark.asyncio
async def test_the_general_update_route_audits_too(
    test_client: AsyncClient, db_session,
):
    """Both routes write the field, so both must leave the same trail."""
    await _seed_mixed(db_session)
    resp = await test_client.put(
        "/api/v1/views/view_private", json={"visibility": "enterprise"},
    )
    assert resp.status_code == 200
    assert "rbac.view.visibility_widened" in await _outbox_types(db_session)


# ── grants do not outlive their view ─────────────────────────────────

@pytest.mark.asyncio
async def test_hard_delete_removes_the_views_grants(
    test_client: AsyncClient, db_session,
):
    """``resource_grants.resource_id`` has no FK (the table is polymorphic),
    so nothing cascades on its own. Orphaned rows would silently re-confer
    access if the id were reused or the view restored from a backup."""
    await _seed_mixed(db_session)
    db_session.add(ResourceGrantORM(
        id="grt_x", resource_type="view", resource_id="view_private",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
    ))
    await db_session.commit()

    resp = await test_client.delete(
        "/api/v1/views/view_private", params={"permanent": "true"},
    )
    assert resp.status_code == 204

    remaining = (await db_session.execute(
        select(func.count()).select_from(ResourceGrantORM)
        .where(ResourceGrantORM.resource_id == "view_private")
    )).scalar_one()
    assert remaining == 0


@pytest.mark.asyncio
async def test_soft_delete_keeps_the_grants(
    test_client: AsyncClient, db_session,
):
    """A soft-deleted view can be restored, so its grants must survive."""
    await _seed_mixed(db_session)
    db_session.add(ResourceGrantORM(
        id="grt_y", resource_type="view", resource_id="view_private",
        subject_type="user", subject_id="usr_friend", role_name="viewer",
    ))
    await db_session.commit()

    resp = await test_client.delete("/api/v1/views/view_private")
    assert resp.status_code == 204

    remaining = (await db_session.execute(
        select(func.count()).select_from(ResourceGrantORM)
        .where(ResourceGrantORM.resource_id == "view_private")
    )).scalar_one()
    assert remaining == 1
