"""Unit tests for the RBAC Phase 1 repositories.

Covers permission_repo, group_repo, binding_repo, grant_repo. All tests
run against the in-memory SQLite ``db_session`` fixture from conftest;
the new ORM models register automatically via ``Base.metadata``.
"""
from __future__ import annotations

import pytest

from backend.app.db.repositories import (
    binding_repo,
    grant_repo,
    group_repo,
    permission_repo,
    user_repo,
)
from backend.app.db.models import (
    PermissionORM,
    RolePermissionORM,
    UserORM,
)


# ── helpers ──────────────────────────────────────────────────────────

async def _seed_user(db_session, *, user_id="usr_alice", email="alice@example.com") -> str:
    db_session.add(UserORM(
        id=user_id,
        email=email,
        password_hash="x",
        first_name="Alice",
        last_name="Anderson",
        status="active",
    ))
    await db_session.flush()
    return user_id


async def _seed_permissions(db_session) -> None:
    """No-op: ``conftest.db_session`` already seeds the Phase-5
    catalogue (roles, permissions, role_permissions). Kept as a hook
    so individual tests can extend the catalogue if they need to.
    """
    return None


# ── permission_repo ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_permission_repo_lists_seeded_permissions(db_session):
    await _seed_permissions(db_session)
    perms = await permission_repo.list_permissions(db_session)
    # The Phase-5 catalogue is seeded by conftest; spot-check a few
    # well-known ids rather than asserting the whole set (the catalogue
    # is documented in ``docs/RBAC.md``).
    ids = {p.id for p in perms}
    assert {"system:admin", "system:org-admin", "workspace:admin",
            "workspace:view:read"} <= ids


@pytest.mark.asyncio
async def test_permission_repo_role_permissions_for_role(db_session):
    await _seed_permissions(db_session)
    member_perms = await permission_repo.get_role_permissions(
        db_session, "workspace_member"
    )
    assert "workspace:view:read" in member_perms
    assert "workspace:view:edit" in member_perms
    # No system:* perms in a workspace role bundle.
    assert not any(p.startswith("system:") for p in member_perms)


@pytest.mark.asyncio
async def test_permission_repo_bulk_role_permissions(db_session):
    await _seed_permissions(db_session)
    bulk = await permission_repo.get_role_permissions_for_roles(
        db_session, ["super_admin", "workspace_viewer"]
    )
    assert "super_admin" in bulk and "workspace_viewer" in bulk
    assert "system:admin" in bulk["super_admin"]
    assert set(bulk["workspace_viewer"]) == {
        "workspace:datasource:read", "workspace:view:read",
    }


@pytest.mark.asyncio
async def test_permission_repo_bulk_handles_empty_input(db_session):
    out = await permission_repo.get_role_permissions_for_roles(db_session, [])
    assert out == {}


# ── group_repo ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_group_repo_create_and_get(db_session):
    g = await group_repo.create_group(db_session, name="marketing", description="MKT team")
    assert g.id.startswith("grp_")
    assert g.name == "marketing"

    fetched = await group_repo.get_group_by_id(db_session, g.id)
    assert fetched is not None and fetched.name == "marketing"

    by_name = await group_repo.get_group_by_name(db_session, "marketing")
    assert by_name is not None and by_name.id == g.id


@pytest.mark.asyncio
async def test_group_repo_soft_delete_hides_group(db_session):
    g = await group_repo.create_group(db_session, name="finance")
    deleted = await group_repo.soft_delete_group(db_session, g.id)
    assert deleted is True
    assert await group_repo.get_group_by_id(db_session, g.id) is None


@pytest.mark.asyncio
async def test_group_repo_membership_round_trip(db_session):
    user_id = await _seed_user(db_session)
    g = await group_repo.create_group(db_session, name="data-eng")

    await group_repo.add_member(db_session, g.id, user_id, added_by="usr_admin")
    members = await group_repo.list_group_members(db_session, g.id)
    assert {m.user_id for m in members} == {user_id}

    user_groups = await group_repo.get_user_groups(db_session, user_id)
    assert user_groups == [g.id]

    assert await group_repo.count_members(db_session, g.id) == 1

    removed = await group_repo.remove_member(db_session, g.id, user_id)
    assert removed is True
    assert await group_repo.get_user_groups(db_session, user_id) == []


@pytest.mark.asyncio
async def test_user_repo_group_helpers_proxy_to_group_repo(db_session):
    user_id = await _seed_user(db_session)
    g = await group_repo.create_group(db_session, name="qa")

    await user_repo.add_to_group(db_session, user_id, g.id, added_by="usr_admin")
    assert await user_repo.get_groups_for_user(db_session, user_id) == [g.id]

    assert await user_repo.remove_from_group(db_session, user_id, g.id)
    assert await user_repo.get_groups_for_user(db_session, user_id) == []


# ── binding_repo ─────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_binding_repo_create_global(db_session):
    user_id = await _seed_user(db_session)
    b = await binding_repo.create_binding(
        db_session,
        subject_type="user",
        subject_id=user_id,
        role_name="super_admin",
        scope_type="global",
        scope_id=None,
        granted_by="usr_admin",
    )
    assert b.id.startswith("bnd_")
    assert b.scope_id is None


@pytest.mark.asyncio
async def test_binding_repo_create_workspace(db_session):
    user_id = await _seed_user(db_session)
    b = await binding_repo.create_binding(
        db_session,
        subject_type="user",
        subject_id=user_id,
        role_name="workspace_member",
        scope_type="workspace",
        scope_id="ws_finance",
    )
    assert b.scope_id == "ws_finance"


@pytest.mark.asyncio
async def test_binding_repo_validates_scope_consistency(db_session):
    user_id = await _seed_user(db_session)
    # global with non-null scope_id
    with pytest.raises(ValueError):
        await binding_repo.create_binding(
            db_session,
            subject_type="user", subject_id=user_id,
            role_name="workspace_member", scope_type="global", scope_id="ws_x",
        )
    # workspace without scope_id
    with pytest.raises(ValueError):
        await binding_repo.create_binding(
            db_session,
            subject_type="user", subject_id=user_id,
            role_name="workspace_member", scope_type="workspace", scope_id=None,
        )


@pytest.mark.asyncio
async def test_binding_repo_validates_role_name_shape(db_session):
    """Phase 3 moved role-existence validation to the endpoint layer
    (the canonical ``roles`` table is now the source of truth). The
    repo still rejects shape errors — empty / non-string role names —
    because those would slip past the DB unique constraint with a
    confusing IntegrityError."""
    user_id = await _seed_user(db_session)
    with pytest.raises(ValueError):
        await binding_repo.create_binding(
            db_session,
            subject_type="user", subject_id=user_id,
            role_name="",  # empty role name
            scope_type="global",
        )


@pytest.mark.asyncio
async def test_binding_repo_for_user_with_groups_unions(db_session):
    user_id = await _seed_user(db_session)
    g = await group_repo.create_group(db_session, name="auditors")
    await group_repo.add_member(db_session, g.id, user_id)

    # Direct user binding.
    await binding_repo.create_binding(
        db_session,
        subject_type="user", subject_id=user_id,
        role_name="workspace_member", scope_type="workspace", scope_id="ws_a",
    )
    # Group binding the user inherits.
    await binding_repo.create_binding(
        db_session,
        subject_type="group", subject_id=g.id,
        role_name="workspace_viewer", scope_type="workspace", scope_id="ws_b",
    )

    bindings = await binding_repo.list_for_user_with_groups(
        db_session, user_id=user_id, group_ids=[g.id]
    )
    scopes = {(b.scope_id, b.role_name) for b in bindings}
    assert scopes == {("ws_a", "workspace_member"), ("ws_b", "workspace_viewer")}


@pytest.mark.asyncio
async def test_binding_repo_delete_subject_bindings(db_session):
    user_id = await _seed_user(db_session)
    await binding_repo.create_binding(
        db_session,
        subject_type="user", subject_id=user_id,
        role_name="workspace_member", scope_type="workspace", scope_id="ws_x",
    )
    await binding_repo.create_binding(
        db_session,
        subject_type="user", subject_id=user_id,
        role_name="super_admin", scope_type="global",
    )
    deleted = await binding_repo.delete_subject_bindings(
        db_session, subject_type="user", subject_id=user_id
    )
    assert deleted == 2
    assert await binding_repo.list_for_subject(
        db_session, subject_type="user", subject_id=user_id
    ) == []


# ── grant_repo ───────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_grant_repo_create_and_lookup(db_session):
    g = await grant_repo.create_grant(
        db_session,
        resource_type="view",
        resource_id="view_x",
        subject_type="user",
        subject_id="usr_bob",
        role_name="editor",
        granted_by="usr_alice",
    )
    assert g.id.startswith("grt_")

    grants = await grant_repo.list_grants_for_resource(
        db_session, resource_type="view", resource_id="view_x"
    )
    assert len(grants) == 1 and grants[0].role_name == "editor"


@pytest.mark.asyncio
async def test_grant_repo_validates_role(db_session):
    with pytest.raises(ValueError):
        await grant_repo.create_grant(
            db_session,
            resource_type="view", resource_id="view_x",
            subject_type="user", subject_id="usr_bob",
            role_name="admin",  # not allowed at resource scope
        )


@pytest.mark.asyncio
async def test_grant_repo_unions_user_and_groups(db_session):
    await grant_repo.create_grant(
        db_session,
        resource_type="view", resource_id="view_a",
        subject_type="user", subject_id="usr_bob",
        role_name="viewer",
    )
    await grant_repo.create_grant(
        db_session,
        resource_type="view", resource_id="view_b",
        subject_type="group", subject_id="grp_marketing",
        role_name="editor",
    )

    inherited = await grant_repo.list_grants_for_user_with_groups(
        db_session, user_id="usr_bob", group_ids=["grp_marketing"], resource_type="view"
    )
    assert {g.resource_id for g in inherited} == {"view_a", "view_b"}


@pytest.mark.asyncio
async def test_grant_repo_delete_resource_grants(db_session):
    await grant_repo.create_grant(
        db_session,
        resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_a", role_name="viewer",
    )
    await grant_repo.create_grant(
        db_session,
        resource_type="view", resource_id="view_x",
        subject_type="user", subject_id="usr_b", role_name="editor",
    )
    deleted = await grant_repo.delete_resource_grants(
        db_session, resource_type="view", resource_id="view_x"
    )
    assert deleted == 2
