"""Repository: ``idp_group_role_mappings`` (Phase 3 — multi-target).

A mapping links an IdP group name to ONE of two target types:

  * ``role_binding`` — Phase 2 behaviour: SSO login derives a
    ``RoleBindingORM`` with ``source='sso'`` in the configured
    (scope_type, scope_id, role_name).
  * ``group_membership`` — new in Phase 3: SSO login derives a
    ``GroupMemberORM`` with ``source='sso'`` for the configured
    internal Group. Permission flow then runs through the existing
    Group→RoleBinding pipeline, so internal admins manage group
    composition once and the IdP-side group only carries
    correspondence.

Validation happens here, not at the DB layer: the role must exist and be
bindable in the requested scope, and the target group must exist, not be
soft-deleted and not be ``is_protected``. The DB CHECK only enforces
shape (which columns are NULL per target_type).

Note the checks are inlined rather than delegated to ``role_repo`` /
``group_repo`` — see the comment in ``_validate_role_binding_target``.
(This docstring used to claim it consulted those repos, which was never
true, and that mismatch is part of why the forbidden-role guard went so
long without anyone noticing it compared against a permission id.)

The hot-path read is :func:`list_active_for_groups`, called by the
reconciler on every SSO login and every refresh. Index
``idx_idp_group_role_mapping_provider_group`` covers the
``(provider_id, idp_group)`` predicate.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Iterable, Optional

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.models import (
    GroupORM,
    IdpGroupRoleMappingORM,
    RoleORM,
)
from backend.common.roles import FORBIDDEN_AUTO_GRANT_ROLES


# Roles that are forever excluded from auto-grant via SSO. Admin grants
# must remain a deliberate human action with an audit trail.
#
# This used to be the bare string ``"system:admin"``, which is a
# PERMISSION id, not a role name — the role that carries it is
# ``super_admin``. So a mapping naming ``super_admin`` passed every check
# here (the role exists, it is global, it is bindable) and auto-granted
# full platform admin to whoever the IdP put in that group. The only
# thing refusing it was a filter in the admin UI, and the endpoint is
# reachable without the UI.
#
# ``common.roles.FORBIDDEN_AUTO_GRANT_ROLES`` already held the correct
# set and its docstring already named this module as the guard; it was
# simply never imported. The literal is kept in the set as well so a
# caller that learned to send ``system:admin`` still gets refused rather
# than falling through to "role does not exist".
FORBIDDEN_AUTO_ROLES: frozenset[str] = FORBIDDEN_AUTO_GRANT_ROLES | {"system:admin"}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class ForbiddenSsoRoleError(ValueError):
    """Refusal to map an IdP group to a privileged role we never
    auto-grant. The admin layer turns this into a 400."""


class MappingValidationError(ValueError):
    """Surfaced for any failed validation step (unknown role, role
    not bindable in scope, unknown group, protected group, etc.).
    The admin layer turns this into a 400 with the message verbatim
    so operators can correct the input."""


# ── Validation helpers (queried before insert) ──────────────────────


async def _validate_role_binding_target(
    session: AsyncSession,
    *,
    role_name: str,
    scope_type: str,
    scope_id: Optional[str],
) -> None:
    if not role_name:
        raise MappingValidationError("role_name is required for role_binding targets")
    if role_name in FORBIDDEN_AUTO_ROLES:
        raise ForbiddenSsoRoleError(
            f"IdP groups may not auto-grant {role_name!r}; "
            "grant it via the standard admin role-binding flow."
        )
    if scope_type not in {"global", "workspace"}:
        raise MappingValidationError(
            f"scope_type must be 'global' or 'workspace', got {scope_type!r}"
        )
    if scope_type == "global" and scope_id is not None:
        raise MappingValidationError("scope_id must be NULL when scope_type='global'")
    if scope_type == "workspace" and not scope_id:
        raise MappingValidationError("scope_id is required when scope_type='workspace'")

    # Role existence + bindability check via the canonical roles table.
    # We query directly (no role_repo import) to keep this module
    # importable from the auth-service test harness without the wider
    # service-layer pull.
    result = await session.execute(
        select(RoleORM).where(RoleORM.name == role_name)
    )
    role = result.scalar_one_or_none()
    if role is None:
        raise MappingValidationError(
            f"role '{role_name}' does not exist in the roles table"
        )
    # Workspace-scoped roles can only bind in their own workspace.
    # Global roles can bind anywhere. (System role lifecycle lives in
    # role_repo; we copy the minimal check here.)
    if getattr(role, "scope_type", None) == "workspace":
        role_ws = getattr(role, "scope_id", None)
        if scope_type != "workspace" or scope_id != role_ws:
            raise MappingValidationError(
                f"role '{role_name}' is workspace-scoped to {role_ws!r} and "
                f"cannot bind in {scope_type}={scope_id!r}"
            )


async def _validate_group_membership_target(
    session: AsyncSession, *, target_group_id: str,
) -> None:
    if not target_group_id:
        raise MappingValidationError("target_group_id is required for group_membership targets")
    result = await session.execute(
        select(GroupORM).where(GroupORM.id == target_group_id)
    )
    group = result.scalar_one_or_none()
    if group is None or group.deleted_at is not None:
        raise MappingValidationError(
            f"group {target_group_id!r} does not exist or is deleted"
        )
    if getattr(group, "is_protected", False):
        raise MappingValidationError(
            f"group {target_group_id!r} is marked protected; SSO group "
            f"mappings may not auto-add members to it."
        )


# ── CRUD ─────────────────────────────────────────────────────────────


async def create_role_binding_mapping(
    session: AsyncSession,
    *,
    idp_group: str,
    role_name: str,
    scope_type: str,
    scope_id: Optional[str],
    provider_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> IdpGroupRoleMappingORM:
    """Create a mapping IdP group -> RoleBinding(scope, role)."""
    await _validate_role_binding_target(
        session, role_name=role_name, scope_type=scope_type, scope_id=scope_id,
    )
    row = IdpGroupRoleMappingORM(
        provider_id=provider_id,
        idp_group=idp_group.strip(),
        target_type="role_binding",
        role_name=role_name.strip(),
        scope_type=scope_type,
        scope_id=scope_id,
        target_group_id=None,
        created_at=_now(),
        created_by=created_by,
    )
    session.add(row)
    await session.flush()
    return row


async def create_group_membership_mapping(
    session: AsyncSession,
    *,
    idp_group: str,
    target_group_id: str,
    provider_id: Optional[str] = None,
    created_by: Optional[str] = None,
) -> IdpGroupRoleMappingORM:
    """Create a mapping IdP group -> internal Group membership."""
    await _validate_group_membership_target(
        session, target_group_id=target_group_id,
    )
    row = IdpGroupRoleMappingORM(
        provider_id=provider_id,
        idp_group=idp_group.strip(),
        target_type="group_membership",
        target_group_id=target_group_id,
        role_name=None,
        scope_type=None,
        scope_id=None,
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
    provider_id: Optional[str] = None,
    idp_group: Optional[str] = None,
    target_type: Optional[str] = None,
) -> list[IdpGroupRoleMappingORM]:
    stmt = select(IdpGroupRoleMappingORM)
    if provider_id:
        stmt = stmt.where(IdpGroupRoleMappingORM.provider_id == provider_id)
    if idp_group:
        stmt = stmt.where(IdpGroupRoleMappingORM.idp_group == idp_group)
    if target_type:
        stmt = stmt.where(IdpGroupRoleMappingORM.target_type == target_type)
    stmt = stmt.order_by(
        IdpGroupRoleMappingORM.provider_id,
        IdpGroupRoleMappingORM.idp_group,
        IdpGroupRoleMappingORM.target_type,
        IdpGroupRoleMappingORM.scope_type,
        IdpGroupRoleMappingORM.scope_id,
        IdpGroupRoleMappingORM.role_name,
        IdpGroupRoleMappingORM.target_group_id,
    )
    result = await session.execute(stmt)
    return list(result.scalars().all())


async def list_active_for_groups(
    session: AsyncSession,
    *,
    provider_id: Optional[str],
    idp_groups: Iterable[str],
) -> list[IdpGroupRoleMappingORM]:
    """Hot-path resolver query.

    Returns every mapping whose ``idp_group`` is in ``idp_groups`` AND
    whose ``provider_id`` is either NULL (matches any provider) OR
    equal to the user's logging-in provider. NULL-provider mappings
    are the Phase 2 semantics — kept for back-compat and for
    operators who want a one-size-fits-all rule across IdPs.
    """
    groups = [g for g in idp_groups if g]
    if not groups:
        return []
    where = [IdpGroupRoleMappingORM.idp_group.in_(groups)]
    if provider_id is not None:
        where.append(
            or_(
                IdpGroupRoleMappingORM.provider_id == provider_id,
                IdpGroupRoleMappingORM.provider_id.is_(None),
            )
        )
    else:
        where.append(IdpGroupRoleMappingORM.provider_id.is_(None))
    result = await session.execute(
        select(IdpGroupRoleMappingORM).where(and_(*where))
    )
    return list(result.scalars().all())
