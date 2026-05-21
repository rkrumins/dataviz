"""Repository: idp_group_role_mappings.

The mapping table is read on every SSO login by the reconciler in
``backend.app.services.permission_service.reconcile_sso_role_bindings``,
and written by the admin CRUD endpoints under
``/api/v1/admin/idp-group-mappings``.

Hot-path read query (``list_by_groups``) is keyed by ``idp_group`` so
the existing ``idx_idp_group_role_mapping_group`` index covers it; the
admin list/page query is cold and tolerates a sequential scan.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import IdpGroupRoleMappingORM


# system:admin can never be auto-granted from an IdP group — the
# admin-grant must be a deliberate human action with an audit trail.
# This is enforced at write-time in ``create_mapping`` AND at apply-time
# in the reconciler (in case a mapping was inserted out-of-band).
FORBIDDEN_AUTO_ROLE = "system:admin"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ForbiddenSsoRoleError(ValueError):
    """Refusal to map an IdP group to ``system:admin`` or another
    privileged role we will never auto-grant. The admin layer turns
    this into a 400."""


async def create_mapping(
    session: AsyncSession,
    *,
    idp_group: str,
    scope_type: str,
    scope_id: Optional[str],
    role_name: str,
    created_by: Optional[str] = None,
) -> IdpGroupRoleMappingORM:
    _validate(scope_type, scope_id, role_name)
    if role_name == FORBIDDEN_AUTO_ROLE:
        raise ForbiddenSsoRoleError(
            f"IdP groups may not auto-grant {FORBIDDEN_AUTO_ROLE!r}; "
            "grant it via the standard admin role-binding flow."
        )
    row = IdpGroupRoleMappingORM(
        idp_group=idp_group.strip(),
        scope_type=scope_type,
        scope_id=scope_id,
        role_name=role_name.strip(),
        created_at=_now(),
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    return row


async def delete_mapping(session: AsyncSession, mapping_id: str) -> bool:
    result = await session.execute(
        delete(IdpGroupRoleMappingORM).where(IdpGroupRoleMappingORM.id == mapping_id)
    )
    return (result.rowcount or 0) > 0


async def get_mapping(
    session: AsyncSession, mapping_id: str,
) -> Optional[IdpGroupRoleMappingORM]:
    result = await session.execute(
        select(IdpGroupRoleMappingORM).where(IdpGroupRoleMappingORM.id == mapping_id)
    )
    return result.scalar_one_or_none()


async def list_mappings(
    session: AsyncSession,
    *,
    idp_group: Optional[str] = None,
) -> list[IdpGroupRoleMappingORM]:
    """Admin listing — no pagination yet (mappings are expected to fit
    on one page in practice). Filter by ``idp_group`` for the
    per-group editor view."""
    stmt = select(IdpGroupRoleMappingORM)
    if idp_group:
        stmt = stmt.where(IdpGroupRoleMappingORM.idp_group == idp_group)
    stmt = stmt.order_by(
        IdpGroupRoleMappingORM.idp_group,
        IdpGroupRoleMappingORM.scope_type,
        IdpGroupRoleMappingORM.scope_id,
        IdpGroupRoleMappingORM.role_name,
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def list_by_groups(
    session: AsyncSession, idp_groups: list[str],
) -> list[IdpGroupRoleMappingORM]:
    """Hot-path resolver query: every mapping whose ``idp_group`` is in
    the IdP-asserted membership list for this login."""
    if not idp_groups:
        return []
    result = await session.execute(
        select(IdpGroupRoleMappingORM).where(
            IdpGroupRoleMappingORM.idp_group.in_(idp_groups)
        )
    )
    return list(result.scalars().all())


def _validate(scope_type: str, scope_id: Optional[str], role_name: str) -> None:
    if scope_type not in {"global", "workspace"}:
        raise ValueError(f"scope_type must be 'global' or 'workspace', got {scope_type!r}")
    if scope_type == "global" and scope_id is not None:
        raise ValueError("scope_id must be NULL when scope_type='global'")
    if scope_type == "workspace" and not scope_id:
        raise ValueError("scope_id is required when scope_type='workspace'")
    if not role_name or not isinstance(role_name, str):
        raise ValueError("role_name must be a non-empty string")
