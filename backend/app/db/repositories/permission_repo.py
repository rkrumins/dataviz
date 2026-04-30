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


async def get_permission(session: AsyncSession, permission_id: str) -> PermissionORM | None:
    result = await session.execute(
        select(PermissionORM).where(PermissionORM.id == permission_id)
    )
    return result.scalar_one_or_none()


async def update_permission(
    session: AsyncSession,
    permission_id: str,
    *,
    description: str | None = None,
    long_description: str | None = None,
    examples: list[str] | None = None,
) -> PermissionORM | None:
    """Update a permission's documentation fields.

    Three fields are admin-editable: ``description`` (short form),
    ``long_description`` (paragraph), and ``examples`` (list of
    concrete actions, stored JSON-encoded). The ``id`` and
    ``category`` are NOT editable — they're part of the system
    contract and renaming a permission would orphan every
    ``role_permissions`` row that references it.

    Passing ``None`` for any field leaves it unchanged. Passing
    ``examples=[]`` explicitly clears the examples list. Passing
    ``description=""`` is rejected with ``ValueError`` since the
    short description is required by the schema.
    """
    import json as _json

    perm = await get_permission(session, permission_id)
    if perm is None:
        return None

    if description is not None:
        if not description.strip():
            raise ValueError("description cannot be empty")
        perm.description = description.strip()

    if long_description is not None:
        # Allow empty string → clears the long description (FE falls
        # back to short). Treat as ``NULL`` for cleanliness.
        cleaned = long_description.strip()
        perm.long_description = cleaned or None

    if examples is not None:
        # Filter out empty strings so the FE list never renders blank
        # bullets on a stray newline.
        cleaned_examples = [e.strip() for e in examples if e and e.strip()]
        perm.examples = _json.dumps(cleaned_examples) if cleaned_examples else None

    await session.flush()
    return perm


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
