"""System-role editing + reset-to-default (Administration → Permissions).

Covers the repo guards, the canonical-defaults module, and the admin
endpoints that let a System Admin tailor a built-in role's permission
bundle and reset it back to the seeded baseline.
"""
from __future__ import annotations

import json
import os

import pytest
from sqlalchemy import delete, select

from backend.app.db import models as m
from backend.app.db.repositories import binding_repo, role_repo
from backend.app.db.repositories.role_repo import (
    RoleImmutableError,
    RoleProtectedPermissionError,
)
from backend.common.role_defaults import (
    PROTECTED_PERMISSIONS,
    SYSTEM_ROLE_DEFAULTS,
    default_permissions,
)


# ── Helpers ──────────────────────────────────────────────────────────

async def _seed_full_catalogue(session) -> None:
    """Bring the in-memory DB up to the production system-role baseline.

    The conftest fixture seeds only a 5-role subset; this upserts every
    permission referenced by ``SYSTEM_ROLE_DEFAULTS`` and (re)sets each
    system role to its canonical default so tests start *unmodified*.
    """
    all_perms = sorted(
        {p for spec in SYSTEM_ROLE_DEFAULTS.values() for p in spec.permissions}
    )
    existing = set(
        (await session.execute(select(m.PermissionORM.id))).scalars().all()
    )
    for pid in all_perms:
        if pid not in existing:
            category = "system" if pid.startswith("system:") else "workspace"
            session.add(m.PermissionORM(id=pid, description=pid, category=category))
    await session.flush()

    now = "2026-01-01T00:00:00+00:00"
    for name, spec in SYSTEM_ROLE_DEFAULTS.items():
        role = await session.get(m.RoleORM, name)
        if role is None:
            session.add(m.RoleORM(
                name=name, description=spec.description,
                scope_type=spec.scope_type, scope_id=None, is_system=True,
                created_at=now, updated_at=now, created_by=None,
            ))
        else:
            role.description = spec.description
            role.is_system = True
        await session.execute(
            delete(m.RolePermissionORM).where(m.RolePermissionORM.role_name == name)
        )
        for pid in sorted(spec.permissions):
            session.add(m.RolePermissionORM(role_name=name, permission_id=pid))
    await session.commit()


async def _perms_of(session, name: str) -> set[str]:
    bundle = await role_repo.role_names_with_permissions(session, [name])
    return set(bundle.get(name, []))


# ── Canonical-defaults consistency (no DB) ───────────────────────────

def test_protected_floor_is_subset_of_defaults():
    """Every protected permission must actually be in the role's default
    bundle — otherwise reset-to-default would itself violate the floor."""
    for role_name, floor in PROTECTED_PERMISSIONS.items():
        assert role_name in SYSTEM_ROLE_DEFAULTS, role_name
        assert floor <= SYSTEM_ROLE_DEFAULTS[role_name].permissions, role_name


def test_defaults_are_well_formed():
    assert "user" not in SYSTEM_ROLE_DEFAULTS  # implicit tier, not a row
    for name, spec in SYSTEM_ROLE_DEFAULTS.items():
        assert spec.scope_type in ("global", "workspace")
        assert spec.permissions, f"{name} has an empty default bundle"
        assert spec.description.strip()


# ── Repo behaviour ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_update_system_role_permissions_now_allowed(db_session):
    await _seed_full_catalogue(db_session)
    target = default_permissions("workspace_viewer") | {"workspace:view:create"}
    await role_repo.update_role(
        db_session, "workspace_viewer", permissions=sorted(target),
    )
    assert await _perms_of(db_session, "workspace_viewer") == target


@pytest.mark.asyncio
async def test_protected_floor_blocks_lockout(db_session):
    await _seed_full_catalogue(db_session)
    # Drop system:admin from super_admin → refused.
    without_admin = default_permissions("super_admin") - {"system:admin"}
    with pytest.raises(RoleProtectedPermissionError):
        await role_repo.update_role(
            db_session, "super_admin", permissions=sorted(without_admin),
        )
    # Editing super_admin while keeping the floor is fine.
    keep_floor = (default_permissions("super_admin") - {"system:users:manage"})
    await role_repo.update_role(
        db_session, "super_admin", permissions=sorted(keep_floor),
    )
    assert "system:users:manage" not in await _perms_of(db_session, "super_admin")
    assert "system:admin" in await _perms_of(db_session, "super_admin")


@pytest.mark.asyncio
async def test_reset_restores_default_and_clears_modified(db_session):
    await _seed_full_catalogue(db_session)
    role = await role_repo.get_role(db_session, "workspace_member")
    assert await role_repo.is_role_modified(db_session, role) is False

    await role_repo.update_role(
        db_session, "workspace_member",
        description="custom", permissions=["workspace:view:read"],
    )
    role = await role_repo.get_role(db_session, "workspace_member")
    assert await role_repo.is_role_modified(db_session, role) is True

    await role_repo.reset_role_to_default(db_session, "workspace_member")
    role = await role_repo.get_role(db_session, "workspace_member")
    assert await _perms_of(db_session, "workspace_member") == default_permissions("workspace_member")
    assert role.description == SYSTEM_ROLE_DEFAULTS["workspace_member"].description
    assert await role_repo.is_role_modified(db_session, role) is False


@pytest.mark.asyncio
async def test_system_roles_still_undeletable(db_session):
    await _seed_full_catalogue(db_session)
    with pytest.raises(RoleImmutableError):
        await role_repo.delete_role(db_session, "workspace_viewer")


@pytest.mark.asyncio
async def test_reset_rejects_custom_role(db_session):
    await _seed_full_catalogue(db_session)
    await role_repo.create_role(
        db_session, name="analyst", description=None,
        scope_type="global", scope_id=None,
        permissions=["workspace:view:read"],
    )
    role = await role_repo.get_role(db_session, "analyst")
    assert await role_repo.is_role_modified(db_session, role) is False
    with pytest.raises(RoleImmutableError):
        await role_repo.reset_role_to_default(db_session, "analyst")


# ── Endpoints ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_put_system_role_persists_and_flags_modified(db_session, test_client):
    await _seed_full_catalogue(db_session)
    target = sorted(default_permissions("workspace_viewer") | {"workspace:view:create"})
    resp = await test_client.put(
        "/api/v1/admin/roles/workspace_viewer",
        json={"permissions": target},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["isModified"] is True
    assert "workspace:view:create" in body["permissions"]


@pytest.mark.asyncio
async def test_put_super_admin_dropping_floor_returns_422(db_session, test_client):
    await _seed_full_catalogue(db_session)
    without_admin = sorted(default_permissions("super_admin") - {"system:admin"})
    resp = await test_client.put(
        "/api/v1/admin/roles/super_admin",
        json={"permissions": without_admin},
    )
    assert resp.status_code == 422, resp.text


@pytest.mark.asyncio
async def test_list_roles_exposes_locked_permissions(db_session, test_client):
    await _seed_full_catalogue(db_session)
    resp = await test_client.get("/api/v1/admin/roles")
    assert resp.status_code == 200, resp.text
    by_name = {r["name"]: r for r in resp.json()}
    assert set(by_name["super_admin"]["lockedPermissions"]) == {
        "system:admin", "system:bindings:read",
    }
    assert by_name["workspace_viewer"]["lockedPermissions"] == []


@pytest.mark.asyncio
async def test_reset_endpoint_restores_default_and_audits(db_session, test_client):
    await _seed_full_catalogue(db_session)
    # First customise it.
    await test_client.put(
        "/api/v1/admin/roles/workspace_viewer",
        json={"permissions": ["workspace:view:read"]},
    )
    resp = await test_client.post("/api/v1/admin/roles/workspace_viewer/reset")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["isModified"] is False
    assert set(body["permissions"]) == default_permissions("workspace_viewer")

    events = set(
        (await db_session.execute(select(m.OutboxEventORM.event_type))).scalars().all()
    )
    assert "rbac.role.reset" in events


@pytest.mark.asyncio
async def test_preview_reset_reports_the_diff(db_session, test_client):
    await _seed_full_catalogue(db_session)
    # Bind the (existing) test user to workspace_viewer so the impact
    # simulation has an affected subject — preview aggregates per-user.
    await binding_repo.create_binding(
        db_session, subject_type="user", subject_id="usr_test000000",
        role_name="workspace_viewer", scope_type="workspace", scope_id="ws_test",
    )
    await db_session.commit()
    await test_client.put(
        "/api/v1/admin/roles/workspace_viewer",
        json={"permissions": ["workspace:view:read"]},
    )
    resp = await test_client.post("/api/v1/admin/roles/workspace_viewer/preview-reset")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    # Resetting re-grants the reads that were stripped, for the bound user.
    assert body["affectedUsers"] == 1
    assert "workspace:datasource:read" in body["gainedPerms"]


@pytest.mark.asyncio
async def test_reset_rejected_for_custom_role_endpoint(db_session, test_client):
    await _seed_full_catalogue(db_session)
    await test_client.post(
        "/api/v1/admin/roles",
        json={"name": "analyst", "scopeType": "global",
              "permissions": ["workspace:view:read"]},
    )
    resp = await test_client.post("/api/v1/admin/roles/analyst/reset")
    assert resp.status_code == 409, resp.text


# ── Parity with the migrated DB (CI-gated) ───────────────────────────

@pytest.mark.asyncio
async def test_defaults_match_migrated_db():
    """Guard against drift between ``SYSTEM_ROLE_DEFAULTS`` and what the
    migration chain actually seeds. Skipped unless a fully-migrated
    Postgres URL is provided so the SQLite suite stays infra-free.

    Set ``RBAC_PARITY_DB_URL`` (asyncpg DSN) in CI to enforce this.
    """
    url = os.getenv("RBAC_PARITY_DB_URL") or os.getenv("MANAGEMENT_DB_URL")
    if not url:
        pytest.skip("RBAC_PARITY_DB_URL not set — parity check skipped")
    try:
        import asyncpg  # noqa: F401
    except ImportError:  # pragma: no cover
        pytest.skip("asyncpg not installed")

    dsn = url.replace("postgresql+asyncpg://", "postgresql://")
    conn = await asyncpg.connect(dsn)
    try:
        rows = await conn.fetch(
            "SELECT rp.role_name, rp.permission_id FROM role_permissions rp "
            "JOIN roles r ON r.name = rp.role_name WHERE r.is_system = true"
        )
    finally:
        await conn.close()

    seeded: dict[str, set[str]] = {}
    for r in rows:
        seeded.setdefault(r["role_name"], set()).add(r["permission_id"])

    expected = {n: set(s.permissions) for n, s in SYSTEM_ROLE_DEFAULTS.items()}
    assert seeded == expected
