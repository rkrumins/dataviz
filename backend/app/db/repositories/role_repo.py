"""Repository: roles — the canonical role-definition table (Phase 3).

A role lifecycle:

  * **System roles** are seeded by the migration chain with
    ``is_system=True``. Their permission bundle and description *can*
    be edited by a System Admin (the seeded values live in
    ``backend.common.role_defaults`` so the role can be reset to its
    default). They cannot be renamed, re-scoped, or deleted — those
    guards still raise ``RoleImmutableError``. A small permission floor
    (``PROTECTED_PERMISSIONS``) can never be stripped, so an edit can't
    lock the admin out of RBAC administration — that raises
    ``RoleProtectedPermissionError``.
  * **Custom roles** are admin-created. They have ``is_system=False``,
    a ``scope`` (global or workspace), and their permission bundle
    can be edited or the role deleted (only if no bindings reference
    it — see ``binding_repo``).

The repo gates create/update/delete with explicit error types so the
endpoint layer can map cleanly to HTTP status codes.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    PermissionORM,
    RoleBindingORM,
    RoleORM,
    RolePermissionORM,
)
from backend.common.role_defaults import (
    PROTECTED_PERMISSIONS,
    SYSTEM_ROLE_DEFAULTS,
)


SYSTEM_ROLE_NAMES = (
    "super_admin",
    "org_admin",
    "workspace_admin",
    "workspace_member",
    "workspace_viewer",
)
"""Roles seeded by the migration; never editable or deletable.

Phase 5 taxonomy:
  * ``super_admin``     — platform owner (global)
  * ``org_admin``       — cross-workspace operator (global)
  * ``workspace_admin`` — workspace administrator (workspace)
  * ``workspace_member``— standard member (workspace)
  * ``workspace_viewer``— read-only (workspace)
"""

VALID_SCOPE_TYPES = ("global", "workspace")
"""Mirrors ``RoleORM`` CHECK constraint."""


# ── Errors ────────────────────────────────────────────────────────────

class RoleImmutableError(Exception):
    """The target role is system-defined and cannot be deleted / renamed /
    re-scoped. (System role *permissions* are editable — see
    ``RoleProtectedPermissionError`` for the one exception.)"""


class RoleProtectedPermissionError(Exception):
    """An edit would strip a protected permission a system role must keep
    (e.g. ``super_admin`` losing ``system:admin``), which would lock the
    admin out of RBAC administration."""


class RoleNotFoundError(Exception):
    """No role with the given name exists."""


class RoleNameConflictError(Exception):
    """A role with that name already exists."""


class RoleScopeError(ValueError):
    """The provided scope_type / scope_id pair is invalid."""


class RoleInUseError(Exception):
    """Cannot delete a role with active bindings or grants."""


class UnknownPermissionError(ValueError):
    """One of the requested permission ids does not exist in the catalogue."""


# ── Helpers ───────────────────────────────────────────────────────────

def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _validate_scope(scope_type: str, scope_id: Optional[str]) -> None:
    if scope_type not in VALID_SCOPE_TYPES:
        raise RoleScopeError(
            f"scope_type must be one of {VALID_SCOPE_TYPES}, got {scope_type!r}",
        )
    if scope_type == "global" and scope_id is not None:
        raise RoleScopeError("scope_id must be NULL when scope_type='global'")
    if scope_type == "workspace" and not scope_id:
        raise RoleScopeError("scope_id is required when scope_type='workspace'")


# ── Reads ─────────────────────────────────────────────────────────────

async def list_roles(
    session: AsyncSession,
    *,
    scope_type: Optional[str] = None,
    scope_id: Optional[str] = None,
    include_system: bool = True,
) -> list[RoleORM]:
    """List role definitions, optionally filtered by scope.

    The ``WorkspaceMembers`` role picker calls this with
    ``scope_type='workspace', scope_id=<ws>`` to get the list of roles
    the admin can bind in that workspace (global + ws-specific).
    """
    stmt = select(RoleORM)
    if scope_type:
        # Picker semantics: when filtering by a workspace, return both
        # global roles AND roles scoped to that workspace.
        if scope_type == "workspace" and scope_id is not None:
            stmt = stmt.where(
                ((RoleORM.scope_type == "global") & (RoleORM.scope_id.is_(None)))
                | ((RoleORM.scope_type == "workspace") & (RoleORM.scope_id == scope_id))
            )
        else:
            stmt = stmt.where(RoleORM.scope_type == scope_type)
            if scope_id is not None:
                stmt = stmt.where(RoleORM.scope_id == scope_id)
    if not include_system:
        stmt = stmt.where(RoleORM.is_system.is_(False))
    stmt = stmt.order_by(RoleORM.is_system.desc(), RoleORM.name)
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def get_role(session: AsyncSession, name: str) -> Optional[RoleORM]:
    result = await session.execute(select(RoleORM).where(RoleORM.name == name))
    return result.scalar_one_or_none()


async def role_names_with_permissions(
    session: AsyncSession, role_names: list[str],
) -> dict[str, list[str]]:
    """``{role_name: [permission_id, ...]}`` for the given role names."""
    if not role_names:
        return {}
    result = await session.execute(
        select(RolePermissionORM.role_name, RolePermissionORM.permission_id).where(
            RolePermissionORM.role_name.in_(role_names)
        )
    )
    out: dict[str, list[str]] = {n: [] for n in role_names}
    for r, p in result.all():
        out.setdefault(r, []).append(p)
    return out


# ── Writes ────────────────────────────────────────────────────────────

async def create_role(
    session: AsyncSession,
    *,
    name: str,
    description: Optional[str],
    scope_type: str,
    scope_id: Optional[str],
    permissions: list[str],
    created_by: Optional[str] = None,
) -> RoleORM:
    """Create a new custom role and bundle its permissions atomically.

    Caller-validated inputs:
      * ``name`` must be unique. System role names are reserved.
      * ``scope_type`` / ``scope_id`` must be a valid pair.
      * Every id in ``permissions`` must exist in the catalogue.
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("Role name is required")
    if name in SYSTEM_ROLE_NAMES:
        raise RoleNameConflictError(f"'{name}' is reserved for built-in roles")

    _validate_scope(scope_type, scope_id)
    await _validate_permissions_exist(session, permissions)

    if (await get_role(session, name)) is not None:
        raise RoleNameConflictError(f"Role '{name}' already exists")

    role = RoleORM(
        name=name,
        description=(description or None),
        scope_type=scope_type,
        scope_id=scope_id,
        is_system=False,
        created_by=created_by,
    )
    session.add(role)
    await session.flush()

    for pid in permissions:
        session.add(RolePermissionORM(role_name=name, permission_id=pid))
    await session.flush()
    return role


async def update_role(
    session: AsyncSession,
    name: str,
    *,
    description: Optional[str] = None,
    permissions: Optional[list[str]] = None,
) -> RoleORM:
    """Update a role's description and / or permission bundle.

    Works for both custom and system roles. Scope and name are *not*
    editable (changing scope would invalidate every existing binding
    referencing the role); admins delete + recreate a custom role, or
    reset a system role, if they want different shape.

    For system roles a permission floor (``PROTECTED_PERMISSIONS``) must
    survive the edit — dropping one raises ``RoleProtectedPermissionError``
    so the admin can't lock themselves out of RBAC administration.
    """
    role = await get_role(session, name)
    if role is None:
        raise RoleNotFoundError(name)

    if description is not None:
        role.description = description.strip() or None
    role.updated_at = _now()

    if permissions is not None:
        await _validate_permissions_exist(session, permissions)
        if role.is_system:
            required = PROTECTED_PERMISSIONS.get(name, frozenset())
            missing = required - set(permissions)
            if missing:
                raise RoleProtectedPermissionError(
                    f"'{name}' must keep {sorted(missing)} — these gate "
                    "platform administration and cannot be removed."
                )
        # Replace the permission set in one round-trip-ish pass.
        await session.execute(
            delete(RolePermissionORM).where(RolePermissionORM.role_name == name)
        )
        for pid in permissions:
            session.add(RolePermissionORM(role_name=name, permission_id=pid))

    await session.flush()
    return role


async def reset_role_to_default(session: AsyncSession, name: str) -> RoleORM:
    """Restore a system role's seeded default permission bundle + description.

    Raises ``RoleNotFoundError`` if the role doesn't exist, and
    ``RoleImmutableError`` if it isn't a system role with a known default
    (custom roles have no default to reset to).
    """
    role = await get_role(session, name)
    if role is None:
        raise RoleNotFoundError(name)
    spec = SYSTEM_ROLE_DEFAULTS.get(name)
    if not role.is_system or spec is None:
        raise RoleImmutableError(f"'{name}' has no seeded default to reset to")

    role.description = spec.description
    role.updated_at = _now()
    await session.execute(
        delete(RolePermissionORM).where(RolePermissionORM.role_name == name)
    )
    for pid in sorted(spec.permissions):
        session.add(RolePermissionORM(role_name=name, permission_id=pid))
    await session.flush()
    return role


async def is_role_modified(session: AsyncSession, role: RoleORM) -> bool:
    """Whether a system role diverges from its seeded default (permissions
    or description). Always ``False`` for custom roles, which have no
    default to compare against."""
    spec = SYSTEM_ROLE_DEFAULTS.get(role.name)
    if not role.is_system or spec is None:
        return False
    bundle = await role_names_with_permissions(session, [role.name])
    current = set(bundle.get(role.name, []))
    if current != set(spec.permissions):
        return True
    return (role.description or "") != (spec.description or "")


async def delete_role(session: AsyncSession, name: str) -> None:
    """Delete a custom role.

    Refuses if (a) the role is a system role, or (b) any binding
    references it. The caller can choose to revoke bindings first and
    retry.
    """
    role = await get_role(session, name)
    if role is None:
        raise RoleNotFoundError(name)
    if role.is_system:
        raise RoleImmutableError(f"'{name}' is a system role")

    in_use = (
        await session.execute(
            select(func.count())
            .select_from(RoleBindingORM)
            .where(RoleBindingORM.role_name == name)
        )
    ).scalar() or 0
    if in_use:
        raise RoleInUseError(
            f"Role '{name}' is bound in {in_use} place(s) — revoke those bindings first."
        )

    # role_permissions rows are cleaned up explicitly so the deletion
    # leaves no orphan permission bundles.
    await session.execute(
        delete(RolePermissionORM).where(RolePermissionORM.role_name == name)
    )
    await session.execute(delete(RoleORM).where(RoleORM.name == name))
    await session.flush()


# ── Validation utilities ──────────────────────────────────────────────

async def _validate_permissions_exist(
    session: AsyncSession, permissions: list[str],
) -> None:
    """Raise ``UnknownPermissionError`` if any id is not in the catalogue."""
    if not permissions:
        return
    rows = await session.execute(
        select(PermissionORM.id).where(PermissionORM.id.in_(permissions))
    )
    found = {r for (r,) in rows.all()}
    missing = [p for p in permissions if p not in found]
    if missing:
        raise UnknownPermissionError(
            f"Unknown permission id(s): {sorted(set(missing))}",
        )


async def delete_workspace_scoped_roles(
    session: AsyncSession,
    workspace_id: str,
) -> list[str]:
    """Phase 7: delete every custom role scoped to a workspace.

    Used on workspace deletion to prevent orphaned ``RoleORM`` rows
    that can't be bound anywhere (their workspace is gone). System
    roles are stored at ``scope_type='global'`` (workspace templates)
    so they're never matched here. Returns the deleted role names so
    the caller can audit the cascade.

    Callers must have removed binding rows for those roles first —
    the FK from ``role_permissions`` to a deleted role would orphan
    too, so we clear that bundle as part of the same call.
    """
    rows = (await session.execute(
        select(RoleORM).where(
            RoleORM.scope_type == "workspace",
            RoleORM.scope_id == workspace_id,
        )
    )).scalars().all()
    deleted: list[str] = []
    for role in rows:
        await session.execute(
            delete(RolePermissionORM).where(RolePermissionORM.role_name == role.name)
        )
        await session.execute(
            delete(RoleORM).where(RoleORM.name == role.name)
        )
        deleted.append(role.name)
    if deleted:
        await session.flush()
    return deleted


async def role_is_bindable_in_scope(
    session: AsyncSession,
    *,
    role_name: str,
    binding_scope_type: str,
    binding_scope_id: Optional[str],
) -> bool:
    """Whether a binding at the given scope can reference ``role_name``.

    A role with scope=global is bindable anywhere. A workspace-scoped
    role is bindable only in workspace bindings whose scope_id matches
    the role's scope_id.

    Used by the binding endpoints to reject cross-scope binds (e.g.
    binding a workspace role globally).
    """
    role = await get_role(session, role_name)
    if role is None:
        return False
    if role.scope_type == "global":
        # Phase 5: system workspace-template roles (workspace_admin,
        # workspace_member, workspace_viewer) are stored as
        # scope_type='global' (the ``ck_roles_scope_consistency``
        # CHECK requires workspace-scoped roles to have a concrete
        # scope_id, which we don't have for templates that bind to
        # any workspace). The resolver's category × scope filter still
        # does the right thing semantically: a binding at workspace
        # scope only emits workspace:* perms, even if the role bundles
        # system:* perms too. So "global role binds anywhere" is safe.
        return True
    # Workspace-scoped CUSTOM role: binding must be a workspace binding
    # for the same workspace.
    return (
        binding_scope_type == "workspace"
        and binding_scope_id == role.scope_id
    )
