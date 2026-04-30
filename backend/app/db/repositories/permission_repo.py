"""Repository: permissions and role_permissions.

These two tables are seeded by the RBAC migration and treated as
read-mostly catalogue data. The repo exposes only the access patterns
the PermissionResolver and admin debugging endpoints need.

In Phase 2, when custom roles ship, this module will gain
``define_role(name, permission_ids)`` and friends — Phase 1 keeps it
read-only on purpose.
"""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import PermissionORM, RolePermissionORM


async def list_permissions(session: AsyncSession) -> list[PermissionORM]:
    result = await session.execute(select(PermissionORM).order_by(PermissionORM.id))
    return list(result.scalars().all())


async def get_role_permissions(session: AsyncSession, role_name: str) -> list[str]:
    """Return the permission ids bundled into ``role_name``."""
    result = await session.execute(
        select(RolePermissionORM.permission_id).where(
            RolePermissionORM.role_name == role_name
        )
    )
    return list(result.scalars().all())


async def get_role_permissions_for_roles(
    session: AsyncSession, role_names: list[str]
) -> dict[str, list[str]]:
    """Bulk variant: returns ``{role_name: [permission_id, ...]}``.

    Used by PermissionResolver to avoid N+1 lookups when a user has
    several distinct roles bound across scopes.
    """
    if not role_names:
        return {}
    result = await session.execute(
        select(RolePermissionORM.role_name, RolePermissionORM.permission_id).where(
            RolePermissionORM.role_name.in_(role_names)
        )
    )
    out: dict[str, list[str]] = {name: [] for name in role_names}
    for role_name, permission_id in result.all():
        out.setdefault(role_name, []).append(permission_id)
    return out
