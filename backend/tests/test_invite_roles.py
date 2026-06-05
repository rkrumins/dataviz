"""Phase 11 — Invite By Link supports all roles (tiered).

Two link classes:
  * Shareable (no email pin) — non-privileged roles only
    (workspace_member, workspace_viewer, custom non-admin roles).
  * Email-bound (token pins ``email``) — required for privileged
    roles (super_admin, org_admin, workspace_admin, custom roles
    carrying workspace:admin / system:*).

These tests drive the admin invite-create endpoint + the public
signup endpoint end-to-end through the conftest test client.
"""
from __future__ import annotations

import pytest
from httpx import AsyncClient

from backend.app.db.models import RoleORM, RolePermissionORM, WorkspaceORM
from backend.app.db.repositories import binding_repo, user_repo
from backend.app.auth.jwt import decode_invite_token


@pytest.fixture(autouse=True)
def _disable_signup_rate_limit():
    """This module fires many signups; the ``5/minute`` slowapi limit
    on /auth/signup would 429 the later cases. Disable the limiter
    for the module (the limit itself is covered elsewhere)."""
    from backend.app.api.v1.endpoints import auth as _auth_mod
    prev = _auth_mod.limiter.enabled
    _auth_mod.limiter.enabled = False
    yield
    _auth_mod.limiter.enabled = prev


# ── helpers ──────────────────────────────────────────────────────────


async def _seed_workspace(db_session, ws_id="ws_invite", name="Finance"):
    db_session.add(WorkspaceORM(id=ws_id, name=name))
    await db_session.commit()
    return ws_id


async def _seed_custom_role(
    db_session, name, *, scope_type="workspace", scope_id="ws_invite",
    perms=("workspace:view:read",),
):
    from datetime import datetime, timezone
    now = datetime.now(timezone.utc).isoformat()
    db_session.add(RoleORM(
        name=name, description=f"custom {name}",
        scope_type=scope_type, scope_id=scope_id,
        is_system=False, created_at=now, updated_at=now, created_by=None,
    ))
    for p in perms:
        db_session.add(RolePermissionORM(role_name=name, permission_id=p))
    await db_session.commit()
    return name


async def _signup(test_client, *, email, token=None, password="Sup3r-Str0ng-Pw!9"):
    body = {
        "email": email,
        "password": password,
        "firstName": "New",
        "lastName": "User",
    }
    if token:
        body["inviteToken"] = token
    return await test_client.post("/api/v1/auth/signup", json=body)


async def _mint_invite(test_client, **body):
    return await test_client.post("/api/v1/admin/users/invite", json=body)


# ── Shareable (non-privileged) invites ───────────────────────────────


@pytest.mark.asyncio
async def test_invite_workspace_member_shareable(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session)
    r = await _mint_invite(
        test_client, role="workspace_member", workspaceId=ws,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["workspaceId"] == ws
    assert body["email"] is None  # shareable — no pin

    # Any email can accept.
    su = await _signup(test_client, email="member1@example.com", token=body["inviteToken"])
    assert su.status_code == 201, su.text

    user = await user_repo.get_user_by_email(db_session, "member1@example.com")
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    ws_bindings = [b for b in bindings if b.scope_type == "workspace" and b.scope_id == ws]
    assert len(ws_bindings) == 1
    assert ws_bindings[0].role_name == "workspace_member"


@pytest.mark.asyncio
async def test_invite_workspace_viewer_shareable(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session, ws_id="ws_v", name="Marketing")
    r = await _mint_invite(test_client, role="workspace_viewer", workspaceId=ws)
    assert r.status_code == 201, r.text

    su = await _signup(test_client, email="viewer@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201

    user = await user_repo.get_user_by_email(db_session, "viewer@example.com")
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(b.role_name == "workspace_viewer" and b.scope_id == ws for b in bindings)


@pytest.mark.asyncio
async def test_invite_custom_workspace_role_shareable(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session)
    await _seed_custom_role(
        db_session, "contributor", scope_type="workspace", scope_id=ws,
        perms=("workspace:view:read", "workspace:view:edit"),
    )
    # workspace fixed to the role's scope — no workspaceId needed.
    r = await _mint_invite(test_client, role="contributor")
    assert r.status_code == 201, r.text
    assert r.json()["workspaceId"] == ws

    su = await _signup(test_client, email="contrib@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201
    user = await user_repo.get_user_by_email(db_session, "contrib@example.com")
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(b.role_name == "contributor" and b.scope_id == ws for b in bindings)


@pytest.mark.asyncio
async def test_invite_custom_global_role_shareable(test_client: AsyncClient, db_session):
    await _seed_custom_role(
        db_session, "auditor", scope_type="global", scope_id=None,
        perms=("workspace:view:read",),
    )
    r = await _mint_invite(test_client, role="auditor")
    assert r.status_code == 201, r.text
    assert r.json()["workspaceId"] is None

    su = await _signup(test_client, email="auditor@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201
    user = await user_repo.get_user_by_email(db_session, "auditor@example.com")
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(b.role_name == "auditor" and b.scope_type == "global" for b in bindings)


# ── Privileged invites require email-bind ────────────────────────────


@pytest.mark.asyncio
async def test_invite_workspace_admin_requires_email(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session)
    r = await _mint_invite(test_client, role="workspace_admin", workspaceId=ws)
    assert r.status_code == 400, r.text
    assert "email" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_workspace_admin_email_bound_flow(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session)
    r = await _mint_invite(
        test_client, role="workspace_admin", workspaceId=ws,
        email="boss@example.com",
    )
    assert r.status_code == 201, r.text
    token = r.json()["inviteToken"]
    assert r.json()["email"] == "boss@example.com"
    # Token actually pins the email.
    payload = decode_invite_token(token)
    assert payload["email"] == "boss@example.com"

    # Wrong email rejected.
    wrong = await _signup(test_client, email="intruder@example.com", token=token)
    assert wrong.status_code == 400
    assert "different email" in wrong.json()["detail"].lower()

    # Right email accepted (case-insensitive).
    ok = await _signup(test_client, email="BOSS@example.com", token=token)
    assert ok.status_code == 201, ok.text
    user = await user_repo.get_user_by_email(db_session, "boss@example.com")
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(b.role_name == "workspace_admin" and b.scope_id == ws for b in bindings)


@pytest.mark.asyncio
async def test_invite_super_admin_requires_email(test_client: AsyncClient, db_session):
    r = await _mint_invite(test_client, role="super_admin")
    assert r.status_code == 400, r.text
    assert "email" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_super_admin_email_bound_grants_global(test_client: AsyncClient, db_session):
    r = await _mint_invite(test_client, role="super_admin", email="owner@example.com")
    assert r.status_code == 201, r.text

    su = await _signup(test_client, email="owner@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201
    user = await user_repo.get_user_by_email(db_session, "owner@example.com")
    # set_global_role writes both stores.
    roles = await user_repo.get_user_roles(db_session, user.id)
    assert "super_admin" in roles
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(b.role_name == "super_admin" and b.scope_type == "global" for b in bindings)


@pytest.mark.asyncio
async def test_invite_custom_privileged_role_requires_email(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session)
    await _seed_custom_role(
        db_session, "ws_manager", scope_type="workspace", scope_id=ws,
        perms=("workspace:admin",),  # privileged
    )
    r = await _mint_invite(test_client, role="ws_manager")
    assert r.status_code == 400, r.text
    assert "email" in r.json()["detail"].lower()


# ── Validation rejections ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_invite_workspace_template_without_workspace(test_client: AsyncClient, db_session):
    r = await _mint_invite(test_client, role="workspace_member")
    assert r.status_code == 400, r.text
    assert "workspace" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_global_role_with_workspace_rejected(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session)
    r = await _mint_invite(
        test_client, role="org_admin", workspaceId=ws, email="o@example.com",
    )
    assert r.status_code == 400, r.text
    assert "global" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_unknown_role_rejected(test_client: AsyncClient, db_session):
    r = await _mint_invite(test_client, role="nonexistent_role")
    assert r.status_code == 400, r.text
    assert "unknown role" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_no_role_plain_activation(test_client: AsyncClient, db_session):
    """An invite with no role still activates the account (no binding)."""
    r = await _mint_invite(test_client)
    assert r.status_code == 201, r.text
    assert r.json()["role"] is None

    su = await _signup(test_client, email="plain@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201
    user = await user_repo.get_user_by_email(db_session, "plain@example.com")
    assert user.status == "active"
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert bindings == []


@pytest.mark.asyncio
async def test_signup_with_deleted_role_activates_without_binding(
    test_client: AsyncClient, db_session,
):
    """If the invited role is deleted after minting, signup still
    activates the user — no 500, just no binding."""
    ws = await _seed_workspace(db_session)
    await _seed_custom_role(
        db_session, "temp_role", scope_type="workspace", scope_id=ws,
        perms=("workspace:view:read",),
    )
    r = await _mint_invite(test_client, role="temp_role")
    assert r.status_code == 201, r.text
    token = r.json()["inviteToken"]

    # Delete the role out from under the invite.
    from sqlalchemy import delete
    await db_session.execute(delete(RolePermissionORM).where(RolePermissionORM.role_name == "temp_role"))
    await db_session.execute(delete(RoleORM).where(RoleORM.name == "temp_role"))
    await db_session.commit()

    su = await _signup(test_client, email="late@example.com", token=token)
    assert su.status_code == 201, su.text
    user = await user_repo.get_user_by_email(db_session, "late@example.com")
    assert user.status == "active"
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert bindings == []


# ── Security model: no workspace access without an explicit grant ────


@pytest.mark.asyncio
async def test_plain_invite_user_has_no_workspace_access(
    test_client: AsyncClient, db_session,
):
    """A user invited with NO role (a basic shareable invite) is
    activated but holds zero workspace bindings — so the resolver
    grants them no workspace access at all. They can only reach a
    workspace once explicitly bound."""
    from backend.app.services.permission_service import resolve, has_permission

    await _seed_workspace(db_session, ws_id="ws_locked", name="Locked")
    r = await _mint_invite(test_client)  # no role
    su = await _signup(test_client, email="nobody@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201

    user = await user_repo.get_user_by_email(db_session, "nobody@example.com")
    claims = await resolve(db_session, user.id)
    # No global perms, no workspace buckets.
    assert claims.global_perms == ()
    assert claims.ws_perms == {}
    # Explicitly: cannot read views / data sources in any workspace.
    assert not has_permission(claims, "workspace:view:read", workspace_id="ws_locked")
    assert not has_permission(claims, "workspace:datasource:read", workspace_id="ws_locked")


@pytest.mark.asyncio
async def test_custom_global_role_grants_no_workspace_access(
    test_client: AsyncClient, db_session,
):
    """A non-privileged GLOBAL custom role is shareable, but even if
    its bundle lists workspace perms, the resolver's category × scope
    filter drops them at global scope — so the invited user still has
    NO workspace access until explicitly bound to a workspace."""
    from backend.app.services.permission_service import resolve, has_permission

    await _seed_workspace(db_session, ws_id="ws_x", name="X")
    # A custom global role that (mistakenly) bundles a workspace perm.
    await _seed_custom_role(
        db_session, "global_viewer", scope_type="global", scope_id=None,
        perms=("workspace:view:read",),
    )
    r = await _mint_invite(test_client, role="global_viewer")
    assert r.status_code == 201, r.text
    su = await _signup(test_client, email="gv@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201

    user = await user_repo.get_user_by_email(db_session, "gv@example.com")
    claims = await resolve(db_session, user.id)
    # The workspace perm bundled in the global role is filtered out.
    assert claims.ws_perms == {}
    assert not has_permission(claims, "workspace:view:read", workspace_id="ws_x")


# ── Phase 13 — group attachments on invite ───────────────────────────


async def _seed_group(db_session, *, name="engineering", is_protected=False):
    from backend.app.db.repositories import group_repo
    grp = await group_repo.create_group(db_session, name=name)
    if is_protected:
        # ``is_protected`` may not be a create-arg; set directly.
        grp.is_protected = True  # type: ignore[attr-defined]
        await db_session.flush()
    await db_session.commit()
    return grp


@pytest.mark.asyncio
async def test_invite_no_role_with_groups_attaches_membership(
    test_client: AsyncClient, db_session,
):
    """A pure-groups invite (no role) is email-bound, and on signup
    the new user lands as a member of every attached group."""
    from backend.app.db.repositories import group_repo
    eng = await _seed_group(db_session, name="engineering")
    data = await _seed_group(db_session, name="data-platform")

    r = await _mint_invite(
        test_client, groupIds=[eng.id, data.id], email="ada@example.com",
    )
    assert r.status_code == 201, r.text
    assert sorted(r.json()["groupIds"]) == sorted([eng.id, data.id])

    su = await _signup(test_client, email="ada@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201, su.text

    user = await user_repo.get_user_by_email(db_session, "ada@example.com")
    member_groups = await group_repo.get_user_groups(db_session, user.id)
    assert sorted(member_groups) == sorted([eng.id, data.id])
    # No role binding because no role was attached.
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert bindings == []


@pytest.mark.asyncio
async def test_invite_role_plus_groups_applies_both(
    test_client: AsyncClient, db_session,
):
    """An invite with role + groups applies both on signup."""
    from backend.app.db.repositories import group_repo
    ws = await _seed_workspace(db_session, ws_id="ws_combo", name="Combo")
    grp = await _seed_group(db_session, name="qa-team")

    r = await _mint_invite(
        test_client, role="workspace_viewer", workspaceId=ws,
        groupIds=[grp.id], email="bob@example.com",
    )
    assert r.status_code == 201, r.text

    su = await _signup(test_client, email="bob@example.com", token=r.json()["inviteToken"])
    assert su.status_code == 201, su.text

    user = await user_repo.get_user_by_email(db_session, "bob@example.com")
    # Role binding created.
    bindings = await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user.id,
    )
    assert any(b.role_name == "workspace_viewer" and b.scope_id == ws for b in bindings)
    # Group membership created.
    member_groups = await group_repo.get_user_groups(db_session, user.id)
    assert grp.id in member_groups


@pytest.mark.asyncio
async def test_invite_with_groups_requires_email(
    test_client: AsyncClient, db_session,
):
    """Group attachments make the invite privileged-by-policy —
    a shareable forwardable link mustn't grant group memberships."""
    grp = await _seed_group(db_session, name="ops")
    r = await _mint_invite(test_client, groupIds=[grp.id])
    assert r.status_code == 400, r.text
    assert "email" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_unknown_group_rejected(
    test_client: AsyncClient, db_session,
):
    r = await _mint_invite(
        test_client, groupIds=["grp_ghost"], email="x@example.com",
    )
    assert r.status_code == 400, r.text
    assert "unknown group" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_invite_protected_group_rejected(
    test_client: AsyncClient, db_session,
):
    """Protected groups (IdP-managed) can't be invite-targeted —
    same defense as the SSO reconciler applies."""
    grp = await _seed_group(db_session, name="elevated", is_protected=True)
    r = await _mint_invite(
        test_client, groupIds=[grp.id], email="x@example.com",
    )
    assert r.status_code == 400, r.text
    assert "protected" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_signup_with_deleted_group_activates_without_membership(
    test_client: AsyncClient, db_session,
):
    """A group deleted after invite minting must not 500 the signup;
    the user is activated, the dead group is skipped."""
    from backend.app.db.repositories import group_repo
    grp = await _seed_group(db_session, name="temp")
    r = await _mint_invite(
        test_client, groupIds=[grp.id], email="ghost@example.com",
    )
    token = r.json()["inviteToken"]

    # Delete the group between mint + signup.
    await group_repo.soft_delete_group(db_session, grp.id)
    await db_session.commit()

    su = await _signup(test_client, email="ghost@example.com", token=token)
    assert su.status_code == 201, su.text
    user = await user_repo.get_user_by_email(db_session, "ghost@example.com")
    assert user.status == "active"
    memberships = await group_repo.get_user_groups(db_session, user.id)
    assert grp.id not in memberships


@pytest.mark.asyncio
async def test_verify_invite_returns_group_names(
    test_client: AsyncClient, db_session,
):
    eng = await _seed_group(db_session, name="engineering")
    r = await _mint_invite(
        test_client, groupIds=[eng.id], email="z@example.com",
    )
    token = r.json()["inviteToken"]

    v = await test_client.get("/api/v1/auth/verify-invite", params={"token": token})
    assert v.status_code == 200, v.text
    body = v.json()
    assert body["valid"] is True
    assert body["groupIds"] == [eng.id]
    assert body["groupNames"] == ["engineering"]


# ── Phase 14 — shareable-groups override ─────────────────────────────


@pytest.mark.asyncio
async def test_shareable_groups_override_permits_no_email(
    test_client: AsyncClient, db_session,
):
    """With ``allowShareableWithGroups=true``, an invite that
    attaches groups + has no email is accepted. The link is
    reusable / shareable and any signup gets the memberships."""
    from backend.app.db.repositories import group_repo
    grp = await _seed_group(db_session, name="designers")

    r = await _mint_invite(
        test_client, groupIds=[grp.id], allowShareableWithGroups=True,
    )
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["email"] is None  # truly shareable

    # ANY email can sign up + lands in the group.
    su = await _signup(test_client, email="anyone@example.com", token=body["inviteToken"])
    assert su.status_code == 201, su.text
    user = await user_repo.get_user_by_email(db_session, "anyone@example.com")
    memberships = await group_repo.get_user_groups(db_session, user.id)
    assert grp.id in memberships


@pytest.mark.asyncio
async def test_shareable_groups_without_override_still_rejected(
    test_client: AsyncClient, db_session,
):
    """Regression: dropping the override flag still requires email."""
    grp = await _seed_group(db_session, name="ops")
    r = await _mint_invite(test_client, groupIds=[grp.id])
    assert r.status_code == 400
    assert "email" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_shareable_groups_override_does_not_bypass_privileged_role(
    test_client: AsyncClient, db_session,
):
    """The override only relaxes the GROUPS-email rule. A privileged
    role still requires an email pin regardless — that's a per-
    identity escalation vector with a different threat model."""
    ws = await _seed_workspace(db_session)
    grp = await _seed_group(db_session, name="elev")
    r = await _mint_invite(
        test_client, role="workspace_admin", workspaceId=ws,
        groupIds=[grp.id], allowShareableWithGroups=True,
    )
    assert r.status_code == 400, r.text
    assert "privileged" in r.json()["detail"].lower()


@pytest.mark.asyncio
async def test_shareable_groups_override_emits_distinct_audit_event(
    test_client: AsyncClient, db_session,
):
    """The override path emits ``user.invite_created_shareable_with_groups``
    so an auditor can review who bypassed the email-pin rule."""
    grp = await _seed_group(db_session, name="auditable")
    r = await _mint_invite(
        test_client, groupIds=[grp.id], allowShareableWithGroups=True,
    )
    assert r.status_code == 201

    audit = await test_client.get(
        "/api/v1/admin/audit",
        params={"eventType": "user.invite_created_shareable_with_groups"},
    )
    assert audit.status_code == 200
    events = audit.json()["events"]
    assert any(
        e["payload"].get("group_ids") == [grp.id]
        and e["payload"].get("shareable_groups_override") is True
        for e in events
    ), [e["payload"] for e in events]


# ── verify-invite surfaces scope + email ─────────────────────────────


@pytest.mark.asyncio
async def test_verify_invite_returns_workspace_context(test_client: AsyncClient, db_session):
    ws = await _seed_workspace(db_session, ws_id="ws_fin", name="Finance")
    r = await _mint_invite(test_client, role="workspace_viewer", workspaceId=ws)
    token = r.json()["inviteToken"]

    v = await test_client.get("/api/v1/auth/verify-invite", params={"token": token})
    assert v.status_code == 200, v.text
    body = v.json()
    assert body["valid"] is True
    assert body["role"] == "workspace_viewer"
    assert body["workspaceId"] == ws
    assert body["workspaceName"] == "Finance"
    assert body["email"] is None
