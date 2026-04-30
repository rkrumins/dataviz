"""Repository: roles — the canonical role-definition table (Phase 3).

A role lifecycle:

  * **System roles** (admin / user / viewer) are seeded by the
    ``20260430_1500_roles_lifecycle`` migration with ``is_system=True``.
    They cannot be edited or deleted via this repo — guards raise
    ``RoleImmutableError``.
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


SYSTEM_ROLE_NAMES = ("admin", "user", "viewer")
"""Roles seeded by the migration; never editable or deletable."""

VALID_SCOPE_TYPES = ("global", "workspace")
"""Mirrors ``RoleORM`` CHECK constraint."""


# ── Errors ────────────────────────────────────────────────────────────

class RoleImmutableError(Exception):
    """The target role is system-defined and cannot be changed."""


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
    """Update a custom role's description and / or permission bundle.

    System roles cannot be modified — raises ``RoleImmutableError``.
    Scope is *not* editable (changing scope would invalidate every
    existing binding referencing the role); admins delete + recreate
    if they want a different scope.
    """
    role = await get_role(session, name)
    if role is None:
        raise RoleNotFoundError(name)
    if role.is_system:
        raise RoleImmutableError(f"'{name}' is a system role")

    if description is not None:
        role.description = description.strip() or None
    role.updated_at = _now()

    if permissions is not None:
        await _validate_permissions_exist(session, permissions)
        # Replace the permission set in one round-trip-ish pass.
        await session.execute(
            delete(RolePermissionORM).where(RolePermissionORM.role_name == name)
        )
        for pid in permissions:
            session.add(RolePermissionORM(role_name=name, permission_id=pid))

    await session.flush()
    return role


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
        return True
    # Workspace-scoped role: binding must be a workspace binding for
    # the same workspace.
    return (
        binding_scope_type == "workspace"
        and binding_scope_id == role.scope_id
    )
