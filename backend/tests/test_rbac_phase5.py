"""RBAC Phase 5 — role-taxonomy uplift regression suite.

Exercises the three explicit role tiers, the resolver's category × scope
filter, ``workspace:admin`` auto-implication, and the ``system:org-admin``
cross-workspace shortcut. The fixtures here drive
``permission_service.resolve`` directly against the conftest seed; no
HTTP layer needed because we're proving the algebra of the new model,
not its routing.
"""
from __future__ import annotations

import pytest

from backend.app.db.models import GroupMemberORM, UserORM
from backend.app.db.repositories import binding_repo, group_repo
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
    resolve,
)


async def _seed_user(db_session, *, user_id="usr_phase5", email=None) -> str:
    email = email or f"{user_id}@example.com"
    db_session.add(UserORM(
        id=user_id, email=email, password_hash="x",
        first_name="X", last_name="Y", status="active",
    ))
    await db_session.flush()
    return user_id


# ── 5.A — Tier matrix ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_super_admin_global_binding_grants_every_system_perm(db_session):
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="super_admin", scope_type="global",
    )
    claims = await resolve(db_session, uid)
    # All system:* perms in global_perms.
    assert "system:admin" in claims.global_perms
    assert "system:org-admin" in claims.global_perms
    assert "system:users:manage" in claims.global_perms
    assert "system:groups:manage" in claims.global_perms
    assert "system:workspaces:create" in claims.global_perms
    # No workspace bucket — global binding does not produce one
    # under the category × scope filter.
    assert claims.ws_perms == {}


@pytest.mark.asyncio
async def test_super_admin_short_circuits_every_workspace_check(db_session):
    """system:admin alone is enough — no workspace binding needed."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="super_admin", scope_type="global",
    )
    claims = await resolve(db_session, uid)
    for ws in ("ws_finance", "ws_marketing", "ws_anywhere"):
        for perm in (
            "workspace:admin",
            "workspace:datasource:read",
            "workspace:view:delete",
        ):
            assert has_permission(claims, perm, workspace_id=ws), (perm, ws)


@pytest.mark.asyncio
async def test_org_admin_grants_workspace_powers_in_every_workspace(db_session):
    """system:org-admin gives every workspace:* power without per-ws bindings."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="org_admin", scope_type="global",
    )
    claims = await resolve(db_session, uid)
    assert "system:org-admin" in claims.global_perms
    # No per-workspace claim — the shortcut handles it.
    assert claims.ws_perms == {}
    for ws in ("ws_alpha", "ws_beta"):
        assert has_permission(claims, "workspace:view:read", workspace_id=ws)
        assert has_permission(claims, "workspace:admin", workspace_id=ws)
        assert has_permission(claims, "workspace:datasource:manage", workspace_id=ws)


@pytest.mark.asyncio
async def test_org_admin_does_not_imply_users_manage(db_session):
    """org_admin can manage workspaces but NOT users / IdP — that's super_admin."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="org_admin", scope_type="global",
    )
    claims = await resolve(db_session, uid)
    assert not has_permission(claims, "system:users:manage")
    assert not has_permission(claims, "system:admin")
    # Does have workspaces:create + groups:manage.
    assert has_permission(claims, "system:workspaces:create")
    assert has_permission(claims, "system:groups:manage")


@pytest.mark.asyncio
async def test_workspace_admin_binding_auto_implies_every_workspace_perm(db_session):
    """workspace:admin binding in ws_A auto-implies every workspace:* leaf."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_admin", scope_type="workspace", scope_id="ws_A",
    )
    claims = await resolve(db_session, uid)
    perms = set(claims.ws_perms.get("ws_A", ()))
    # workspace:admin itself is present + the auto-implied leaves
    # (the wildcard collapser then folds them into the prefix).
    assert "workspace:admin" in perms
    # Auto-implication satisfies every workspace:* check in ws_A.
    for perm in (
        "workspace:datasource:manage", "workspace:datasource:read",
        "workspace:view:create", "workspace:view:edit",
        "workspace:view:delete", "workspace:view:read",
    ):
        assert has_permission(claims, perm, workspace_id="ws_A"), perm


@pytest.mark.asyncio
async def test_workspace_admin_does_not_leak_to_other_workspaces(db_session):
    """workspace:admin in ws_A grants nothing in ws_B."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_admin", scope_type="workspace", scope_id="ws_A",
    )
    claims = await resolve(db_session, uid)
    for perm in (
        "workspace:admin",
        "workspace:datasource:read",
        "workspace:view:read",
    ):
        assert not has_permission(claims, perm, workspace_id="ws_B"), perm


@pytest.mark.asyncio
async def test_workspace_member_grants_view_and_datasource_edit(db_session):
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_member", scope_type="workspace", scope_id="ws_M",
    )
    claims = await resolve(db_session, uid)
    for perm in (
        "workspace:view:create", "workspace:view:edit",
        "workspace:view:delete", "workspace:view:read",
        "workspace:datasource:manage", "workspace:datasource:read",
    ):
        assert has_permission(claims, perm, workspace_id="ws_M"), perm
    # NOT workspace:admin — that's the workspace_admin tier.
    assert not has_permission(claims, "workspace:admin", workspace_id="ws_M")


@pytest.mark.asyncio
async def test_workspace_viewer_is_strictly_read_only(db_session):
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_viewer", scope_type="workspace", scope_id="ws_V",
    )
    claims = await resolve(db_session, uid)
    assert has_permission(claims, "workspace:view:read", workspace_id="ws_V")
    assert has_permission(claims, "workspace:datasource:read", workspace_id="ws_V")
    # No writes / admin.
    for perm in (
        "workspace:view:edit", "workspace:view:create",
        "workspace:view:delete", "workspace:datasource:manage",
        "workspace:admin",
    ):
        assert not has_permission(claims, perm, workspace_id="ws_V"), perm


# ── 5.B — Category × scope filter ────────────────────────────────────


@pytest.mark.asyncio
async def test_super_admin_at_workspace_scope_drops_system_perms(db_session):
    """Binding super_admin at workspace scope must NOT leak system:*
    perms into the workspace bucket (those would be inert today but
    semantically wrong + JWT bloat).

    The category × scope filter only emits workspace-category perms
    for workspace-scope bindings. system:* leaves silently drop.
    """
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="super_admin", scope_type="workspace", scope_id="ws_X",
    )
    claims = await resolve(db_session, uid)
    # No system:* in global_perms (binding is at workspace scope).
    assert "system:admin" not in claims.global_perms
    assert "system:users:manage" not in claims.global_perms
    # Workspace bucket has only workspace:* perms.
    ws_perms = set(claims.ws_perms.get("ws_X", ()))
    assert "system:admin" not in ws_perms
    assert "system:users:manage" not in ws_perms
    # But via auto-implication, every workspace:* perm IS present.
    for perm in (
        "workspace:admin", "workspace:view:read", "workspace:view:edit",
    ):
        assert has_permission(claims, perm, workspace_id="ws_X"), perm


@pytest.mark.asyncio
async def test_workspace_member_at_global_scope_drops_workspace_perms(db_session):
    """A binding of workspace_member at global scope (a malformed
    binding, but defensively handled) emits NO perms — the role's
    workspace:* perms are dropped because the binding is global."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_member", scope_type="global",
    )
    claims = await resolve(db_session, uid)
    # Filter drops the workspace:* perms from the global bucket.
    assert claims.global_perms == ()
    assert claims.ws_perms == {}


# ── 5.C — Cross-workspace tier matrix ────────────────────────────────


@pytest.mark.asyncio
async def test_admin_in_ws_a_viewer_in_ws_b(db_session):
    """The canonical cross-workspace edge: same user, different powers
    per workspace — admin in finance, read-only in marketing."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_admin", scope_type="workspace", scope_id="ws_A",
    )
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_viewer", scope_type="workspace", scope_id="ws_B",
    )
    claims = await resolve(db_session, uid)
    # ws_A: full workspace powers.
    assert has_permission(claims, "workspace:admin", workspace_id="ws_A")
    assert has_permission(claims, "workspace:view:delete", workspace_id="ws_A")
    # ws_B: read-only.
    assert has_permission(claims, "workspace:view:read", workspace_id="ws_B")
    assert not has_permission(claims, "workspace:view:edit", workspace_id="ws_B")
    assert not has_permission(claims, "workspace:admin", workspace_id="ws_B")


@pytest.mark.asyncio
async def test_org_admin_plus_direct_member_role_unions_correctly(db_session):
    """An org_admin (global shortcut) ALSO bound as workspace_member in
    a specific ws should still pass admin-only checks in that ws."""
    uid = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="org_admin", scope_type="global",
    )
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id=uid,
        role_name="workspace_member", scope_type="workspace", scope_id="ws_F",
    )
    claims = await resolve(db_session, uid)
    # org-admin shortcut gives workspace:admin in any workspace.
    assert has_permission(claims, "workspace:admin", workspace_id="ws_F")
    assert has_permission(claims, "workspace:admin", workspace_id="ws_OTHER")


# ── 5.D — Group bindings honour the same filter ──────────────────────


@pytest.mark.asyncio
async def test_group_binding_grants_workspace_admin_via_auto_implication(db_session):
    """A workspace_admin binding attached to a group propagates to its
    members and triggers the same auto-implication rule."""
    uid = await _seed_user(db_session)
    g = await group_repo.create_group(db_session, name="finance-admins")
    db_session.add(GroupMemberORM(group_id=g.id, user_id=uid))
    await db_session.flush()
    await binding_repo.create_binding(
        db_session, subject_type="group", subject_id=g.id,
        role_name="workspace_admin", scope_type="workspace", scope_id="ws_F",
    )
    claims = await resolve(db_session, uid)
    assert has_permission(claims, "workspace:admin", workspace_id="ws_F")
    assert has_permission(claims, "workspace:view:delete", workspace_id="ws_F")


# ── 5.E — has_permission shortcuts ───────────────────────────────────


def test_has_permission_super_admin_short_circuits_global():
    claims = PermissionClaims(sid="s", global_perms=("system:admin",))
    assert has_permission(claims, "system:users:manage")
    assert has_permission(claims, "system:workspaces:create")
    assert has_permission(claims, "workspace:view:read", workspace_id="ws_X")


def test_has_permission_org_admin_shortcuts_workspace_only():
    claims = PermissionClaims(sid="s", global_perms=("system:org-admin",))
    # Every workspace:* check passes in any workspace.
    assert has_permission(claims, "workspace:admin", workspace_id="ws_A")
    assert has_permission(claims, "workspace:view:edit", workspace_id="ws_B")
    # But system:* checks still need the explicit perm.
    assert not has_permission(claims, "system:admin")
    assert not has_permission(claims, "system:users:manage")


def test_has_permission_workspace_admin_in_claim_does_NOT_short_circuit_other_ws():
    """workspace:admin is workspace-scoped — it only shortcuts within
    its own bucket, not across workspaces (that's org_admin's job)."""
    claims = PermissionClaims(
        sid="s",
        ws_perms={"ws_A": ("workspace:admin",)},
    )
    # workspace:admin in ws_A by itself does NOT trigger the
    # auto-imply (that happens at resolve-time, not check-time). The
    # explicit perm match still works.
    assert has_permission(claims, "workspace:admin", workspace_id="ws_A")
    # And nothing in ws_B.
    assert not has_permission(claims, "workspace:admin", workspace_id="ws_B")
    assert not has_permission(claims, "workspace:view:read", workspace_id="ws_B")


# ── Phase 6 — access-denial audit ────────────────────────────────────


@pytest.mark.asyncio
async def test_audit_access_denied_emits_outbox_row(db_session):
    """The audit helper emits one ``user.access_denied`` outbox event
    per (user, perm, scope, hour). First call writes; second call in
    the same hour is suppressed by the sampler."""
    from backend.app.auth.dependencies import _audit_access_denied
    from backend.app.db.models import OutboxEventORM
    from backend.app.services.revocation_service import (
        InMemoryBackend, RevocationService, configure_revocation_service,
    )
    from sqlalchemy import select

    # Fresh in-memory sampler so the dedupe key is guaranteed unset.
    configure_revocation_service(RevocationService(InMemoryBackend()))

    scope_obj = {"type": "workspace", "id": "ws_F"}
    await _audit_access_denied(
        db_session,
        user_id="usr_phase6",
        permission="workspace:datasource:read",
        scope_obj=scope_obj,
    )

    rows = (await db_session.execute(
        select(OutboxEventORM).where(
            OutboxEventORM.event_type == "user.access_denied",
        )
    )).scalars().all()
    assert len(rows) == 1, rows
    import json as _json
    payload = _json.loads(rows[0].payload)
    assert payload["user_id"] == "usr_phase6"
    assert payload["permission"] == "workspace:datasource:read"
    assert payload["scope"] == scope_obj

    # Second call in the same hour: sampler suppresses.
    await _audit_access_denied(
        db_session,
        user_id="usr_phase6",
        permission="workspace:datasource:read",
        scope_obj=scope_obj,
    )
    rows_after = (await db_session.execute(
        select(OutboxEventORM).where(
            OutboxEventORM.event_type == "user.access_denied",
        )
    )).scalars().all()
    assert len(rows_after) == 1, "sampler should suppress duplicates within the hour"


@pytest.mark.asyncio
async def test_audit_access_denied_swallows_errors(db_session):
    """Audit emission must never block the 403. If the outbox write
    fails, the helper logs and returns normally."""
    from backend.app.auth.dependencies import _audit_access_denied

    class _BrokenSession:
        async def commit(self):
            raise RuntimeError("boom")

    # Should not raise.
    await _audit_access_denied(
        _BrokenSession(),  # type: ignore[arg-type]
        user_id="usr_x",
        permission="workspace:view:read",
        scope_obj={"type": "workspace", "id": "ws_X"},
    )
