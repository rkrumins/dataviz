"""Admin permission + role-lifecycle endpoints (RBAC Phase 2 + 3).

Mounted under ``/api/v1/admin``. Read-only catalogue endpoints back
the Permissions admin page; the role-lifecycle endpoints (create /
update / delete) back the role-editor and create-role flows.

  GET    /admin/permissions             permission catalogue
  GET    /admin/roles                   roles (system + custom)
  POST   /admin/roles                   create custom role
  PUT    /admin/roles/{name}            update description / permissions
  DELETE /admin/roles/{name}            delete (only if no bindings)
  GET    /admin/users/{user_id}/access  full access picture for one user

The user-access endpoint unions direct + group bindings and runs them
through ``PermissionResolver`` so the FE can answer "what can Alice
do, and how did she get that?" without re-implementing the logic.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import GroupORM, RoleBindingORM, WorkspaceORM
from backend.app.db.repositories import (
    group_repo,
    permission_repo,
    role_repo,
    user_repo,
)
from backend.app.db.repositories.role_repo import (
    RoleImmutableError,
    RoleInUseError,
    RoleNameConflictError,
    RoleNotFoundError,
    RoleScopeError,
    UnknownPermissionError,
)
from backend.app.services.permission_service import resolve as resolve_claims
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    PermissionResponse,
    RoleCreateRequest,
    RoleDefinitionResponse,
    RoleUpdateRequest,
    UserAccessBinding,
    UserAccessGroup,
    UserAccessResponse,
    UserAccessSubject,
    _BindingScope,
    _ViaGroup,
)


router = APIRouter()


@router.get(
    "/permissions",
    response_model=list[PermissionResponse],
    response_model_by_alias=True,
)
async def list_permissions(
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Return the full permission catalogue."""
    perms = await permission_repo.list_permissions(session)
    return [
        PermissionResponse(id=p.id, description=p.description, category=p.category)
        for p in perms
    ]


# ── Role lifecycle ───────────────────────────────────────────────────


async def _binding_counts(
    session: AsyncSession, role_names: list[str],
) -> dict[str, int]:
    """How many bindings reference each role. Hydrated into the list
    response so the FE can warn before deletion."""
    if not role_names:
        return {}
    rows = await session.execute(
        select(RoleBindingORM.role_name, func.count())
        .where(RoleBindingORM.role_name.in_(role_names))
        .group_by(RoleBindingORM.role_name)
    )
    return {name: count for name, count in rows.all()}


def _role_to_response(role, *, permissions: list[str], binding_count: int) -> RoleDefinitionResponse:
    return RoleDefinitionResponse(
        name=role.name,
        description=role.description,
        scope_type=role.scope_type,
        scope_id=role.scope_id,
        is_system=role.is_system,
        permissions=sorted(permissions),
        created_at=role.created_at,
        updated_at=role.updated_at,
        created_by=role.created_by,
        binding_count=binding_count,
    )


@router.get(
    "/roles",
    response_model=list[RoleDefinitionResponse],
    response_model_by_alias=True,
)
async def list_roles(
    scope_type: Optional[str] = Query(default=None, alias="scopeType"),
    scope_id: Optional[str] = Query(default=None, alias="scopeId"),
    include_system: bool = Query(default=True, alias="includeSystem"),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Return each role and the permissions it bundles.

    Scope filter semantics: when ``scopeType=workspace&scopeId=ws_x``
    is provided, returns global roles **plus** roles scoped to that
    workspace. The picker in WorkspaceMembers calls it that way.
    """
    if scope_type is not None and scope_type not in ("global", "workspace"):
        raise HTTPException(status_code=400, detail="scopeType must be 'global' or 'workspace'")

    roles = await role_repo.list_roles(
        session,
        scope_type=scope_type,
        scope_id=scope_id,
        include_system=include_system,
    )
    names = [r.name for r in roles]
    bundles = await role_repo.role_names_with_permissions(session, names)
    counts = await _binding_counts(session, names)
    return [
        _role_to_response(
            r, permissions=bundles.get(r.name, []), binding_count=counts.get(r.name, 0),
        )
        for r in roles
    ]


@router.post(
    "/roles",
    response_model=RoleDefinitionResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_role(
    body: RoleCreateRequest,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a custom role and bundle its permissions atomically."""
    try:
        role = await role_repo.create_role(
            session,
            name=body.name,
            description=body.description,
            scope_type=body.scope_type,
            scope_id=body.scope_id,
            permissions=body.permissions,
            created_by=admin.id,
        )
    except RoleNameConflictError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except (RoleScopeError, UnknownPermissionError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    # Outbox event so external auditors / SIEM can pick this up later.
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.role.created",
        payload={
            "name": role.name,
            "scope_type": role.scope_type,
            "scope_id": role.scope_id,
            "actor_id": admin.id,
        },
    )
    bundles = await role_repo.role_names_with_permissions(session, [role.name])
    return _role_to_response(role, permissions=bundles.get(role.name, []), binding_count=0)


@router.put(
    "/roles/{name}",
    response_model=RoleDefinitionResponse,
    response_model_by_alias=True,
)
async def update_role(
    name: str = Path(...),
    body: RoleUpdateRequest = ...,
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a custom role's description and/or permission bundle.

    System roles cannot be edited (returns 409 — a conflict between
    the request and the role's immutable nature)."""
    try:
        role = await role_repo.update_role(
            session,
            name,
            description=body.description,
            permissions=body.permissions,
        )
    except RoleNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Role '{name}' not found") from exc
    except RoleImmutableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except UnknownPermissionError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.role.updated",
        payload={"name": name, "actor_id": admin.id},
    )
    bundles = await role_repo.role_names_with_permissions(session, [name])
    counts = await _binding_counts(session, [name])
    return _role_to_response(
        role,
        permissions=bundles.get(name, []),
        binding_count=counts.get(name, 0),
    )


@router.delete(
    "/roles/{name}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_role(
    name: str = Path(...),
    admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a custom role.

    Refuses on system roles (409) and on roles that still have active
    bindings (409 with a count in the body)."""
    try:
        await role_repo.delete_role(session, name)
    except RoleNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Role '{name}' not found") from exc
    except (RoleImmutableError, RoleInUseError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.role.deleted",
        payload={"name": name, "actor_id": admin.id},
    )


# ── Per-user access ──────────────────────────────────────────────────

async def _resolve_workspace_labels(
    session: AsyncSession, ws_ids: set[str],
) -> dict[str, str]:
    """Best-effort lookup of workspace display names. Missing rows
    surface as empty (the FE falls back to the id)."""
    if not ws_ids:
        return {}
    rows = await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).where(
            WorkspaceORM.id.in_(ws_ids),
            WorkspaceORM.deleted_at.is_(None),
        )
    )
    return {row.id: row.name for row in rows}


async def _resolve_group_meta(
    session: AsyncSession, group_ids: set[str],
) -> dict[str, GroupORM]:
    if not group_ids:
        return {}
    rows = await session.execute(
        select(GroupORM).where(
            GroupORM.id.in_(group_ids),
            GroupORM.deleted_at.is_(None),
        )
    )
    return {g.id: g for g in rows.scalars().all()}


def _binding_to_response(
    b: RoleBindingORM,
    *,
    scope_label: Optional[str],
    via_group: Optional[GroupORM],
) -> UserAccessBinding:
    return UserAccessBinding(
        binding_id=b.id,
        role=b.role_name,
        scope=_BindingScope(
            type=b.scope_type,
            id=b.scope_id,
            label=scope_label,
        ),
        granted_at=b.granted_at,
        granted_by=b.granted_by,
        via_group=_ViaGroup(id=via_group.id, name=via_group.name) if via_group else None,
    )


@router.get(
    "/users/{user_id}/access",
    response_model=UserAccessResponse,
    response_model_by_alias=True,
)
async def get_user_access(
    user_id: str = Path(...),
    _admin: User = Depends(requires("system:admin")),
    session: AsyncSession = Depends(get_db_session),
):
    """Compute every binding the user holds (direct or via group) and
    the resulting effective permissions.

    This is the source of truth for the FE's "By user" tab — admins
    can answer "why does Alice see Workspace-Finance?" by reading the
    response's ``directBindings`` + ``inheritedBindings`` arrays.
    """
    user_orm = await user_repo.get_user_by_id(session, user_id)
    if user_orm is None:
        raise HTTPException(status_code=404, detail="User not found")

    user_roles = await user_repo.get_user_roles(session, user_orm.id)
    primary_role = "admin" if "admin" in user_roles else (user_roles[0] if user_roles else "user")

    # Direct bindings (subject_type='user', subject_id=user_id)
    direct_rows = (
        await session.execute(
            select(RoleBindingORM).where(
                RoleBindingORM.subject_type == "user",
                RoleBindingORM.subject_id == user_orm.id,
            )
        )
    ).scalars().all()

    # Group memberships
    group_ids = await group_repo.get_user_groups(session, user_orm.id)
    group_meta = await _resolve_group_meta(session, set(group_ids))

    # Bindings inherited via groups
    inherited_rows: list[RoleBindingORM] = []
    if group_ids:
        rows = (
            await session.execute(
                select(RoleBindingORM).where(
                    RoleBindingORM.subject_type == "group",
                    RoleBindingORM.subject_id.in_(group_ids),
                )
            )
        ).scalars().all()
        inherited_rows = list(rows)

    # Resolve workspace labels for both binding lists in one shot.
    ws_ids = {
        b.scope_id for b in (*direct_rows, *inherited_rows)
        if b.scope_type == "workspace" and b.scope_id
    }
    ws_labels = await _resolve_workspace_labels(session, ws_ids)

    direct_bindings = [
        _binding_to_response(
            b,
            scope_label=ws_labels.get(b.scope_id) if b.scope_id else None,
            via_group=None,
        )
        for b in direct_rows
    ]
    inherited_bindings = [
        _binding_to_response(
            b,
            scope_label=ws_labels.get(b.scope_id) if b.scope_id else None,
            via_group=group_meta.get(b.subject_id),
        )
        for b in inherited_rows
        # Only surface bindings whose group still exists; orphans
        # (group soft-deleted) shouldn't show up as "inherited via X".
        if b.subject_id in group_meta
    ]

    # Run the same resolver the JWT path uses so the FE can show the
    # canonical effective permission map.
    claims = await resolve_claims(session, user_orm.id)

    # Group member counts (for the FE chip "X members").
    group_payload: list[UserAccessGroup] = []
    for gid in group_ids:
        g = group_meta.get(gid)
        if g is None:
            continue
        count = await group_repo.count_members(session, gid)
        group_payload.append(
            UserAccessGroup(id=g.id, name=g.name, member_count=count)
        )

    return UserAccessResponse(
        user=UserAccessSubject(
            id=user_orm.id,
            email=user_orm.email,
            display_name=f"{user_orm.first_name} {user_orm.last_name}".strip()
                         or user_orm.email,
            status=user_orm.status,
            role=primary_role,
        ),
        direct_bindings=direct_bindings,
        inherited_bindings=inherited_bindings,
        groups=group_payload,
        effective_global=list(claims.global_perms),
        effective_ws={ws: list(perms) for ws, perms in claims.ws_perms.items()},
    )
