"""Workspace membership endpoints (RBAC Phase 2).

Mounted at ``/api/v1/admin/workspaces/{ws_id}/members`` for the admin
flow. Workspace admins use the same path; the ``workspace:admin``
permission gates write operations, so a user bound as Admin in the
workspace can manage members without holding global ``system:admin``.

  GET    /admin/workspaces/{ws_id}/members              list bindings + roles
  POST   /admin/workspaces/{ws_id}/members              create binding
  DELETE /admin/workspaces/{ws_id}/members/{binding}    revoke binding
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import requires
from backend.app.db.engine import get_db_session
from backend.app.db.models import GroupORM, UserORM, WorkspaceORM
from backend.app.db.repositories import binding_repo, group_repo, role_repo, user_repo
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    WorkspaceMemberCreateRequest,
    WorkspaceMemberResponse,
    WorkspaceMemberSubject,
)


logger = logging.getLogger(__name__)
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────

async def _hydrate_subject(
    session: AsyncSession, subject_type: str, subject_id: str
) -> WorkspaceMemberSubject:
    """Resolve display fields for the bound subject.

    Best-effort: returns a row with ``display_name=None`` when the
    subject was deleted (the binding is then orphaned and the admin
    needs to revoke it manually).
    """
    if subject_type == "user":
        row = await session.execute(select(UserORM).where(UserORM.id == subject_id))
        user_orm = row.scalar_one_or_none()
        if user_orm is None:
            return WorkspaceMemberSubject(type=subject_type, id=subject_id)
        full_name = f"{user_orm.first_name} {user_orm.last_name}".strip()
        return WorkspaceMemberSubject(
            type="user",
            id=subject_id,
            display_name=full_name or None,
            secondary=user_orm.email,
        )

    row = await session.execute(select(GroupORM).where(GroupORM.id == subject_id))
    group_orm = row.scalar_one_or_none()
    if group_orm is None:
        return WorkspaceMemberSubject(type=subject_type, id=subject_id)
    member_count = await group_repo.count_members(session, group_orm.id)
    return WorkspaceMemberSubject(
        type="group",
        id=subject_id,
        display_name=group_orm.name,
        secondary=f"{member_count} member{'s' if member_count != 1 else ''}",
    )


async def _ensure_workspace_exists(session: AsyncSession, ws_id: str) -> None:
    row = await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.id == ws_id,
            WorkspaceORM.deleted_at.is_(None),
        )
    )
    if row.scalar_one_or_none() is None:
        raise HTTPException(status_code=404, detail="Workspace not found")


# ── Routes ───────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=list[WorkspaceMemberResponse],
    response_model_by_alias=True,
)
async def list_members(
    ws_id: str,
    _admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    await _ensure_workspace_exists(session, ws_id)
    bindings = await binding_repo.list_for_scope(
        session, scope_type="workspace", scope_id=ws_id,
    )
    out: list[WorkspaceMemberResponse] = []
    for b in bindings:
        subject = await _hydrate_subject(session, b.subject_type, b.subject_id)
        out.append(
            WorkspaceMemberResponse(
                binding_id=b.id,
                role=b.role_name,
                granted_at=b.granted_at,
                granted_by=b.granted_by,
                subject=subject,
            )
        )
    return out


@router.post(
    "",
    response_model=WorkspaceMemberResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_member_binding(
    ws_id: str,
    body: WorkspaceMemberCreateRequest,
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    await _ensure_workspace_exists(session, ws_id)

    # Subject must exist before we bind it.
    if body.subject_type == "user":
        if await user_repo.get_user_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="User not found")
    elif body.subject_type == "group":
        if await group_repo.get_group_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="Group not found")
    else:
        raise HTTPException(
            status_code=400,
            detail="subjectType must be 'user' or 'group'",
        )

    # Phase 3: validate the role exists AND is bindable in this scope.
    # A workspace-scoped role (scope_type='workspace', scope_id='ws_y')
    # cannot be bound in a different workspace.
    role_def = await role_repo.get_role(session, body.role)
    if role_def is None:
        raise HTTPException(
            status_code=400,
            detail=f"Role '{body.role}' does not exist",
        )
    if not await role_repo.role_is_bindable_in_scope(
        session,
        role_name=body.role,
        binding_scope_type="workspace",
        binding_scope_id=ws_id,
    ):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Role '{body.role}' is scoped to workspace "
                f"'{role_def.scope_id}' and cannot be bound here."
            ),
        )

    existing = await binding_repo.find_binding(
        session,
        subject_type=body.subject_type,
        subject_id=body.subject_id,
        role_name=body.role,
        scope_type="workspace",
        scope_id=ws_id,
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Member already has this role in the workspace",
        )

    try:
        binding = await binding_repo.create_binding(
            session,
            subject_type=body.subject_type,
            subject_id=body.subject_id,
            role_name=body.role,
            scope_type="workspace",
            scope_id=ws_id,
            granted_by=admin.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_bound",
        payload={
            "workspace_id": ws_id,
            "binding_id": binding.id,
            "subject_type": body.subject_type,
            "subject_id": body.subject_id,
            "role": body.role,
            "actor_id": admin.id,
        },
    )
    subject = await _hydrate_subject(session, body.subject_type, body.subject_id)
    return WorkspaceMemberResponse(
        binding_id=binding.id,
        role=binding.role_name,
        granted_at=binding.granted_at,
        granted_by=binding.granted_by,
        subject=subject,
    )


@router.delete(
    "/{binding_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def revoke_member_binding(
    ws_id: str,
    binding_id: str,
    admin: User = Depends(requires("workspace:admin", workspace="ws_id")),
    session: AsyncSession = Depends(get_db_session),
):
    binding = await binding_repo.get_binding(session, binding_id)
    if binding is None or binding.scope_type != "workspace" or binding.scope_id != ws_id:
        raise HTTPException(
            status_code=404,
            detail="Binding not found in this workspace",
        )
    await binding_repo.delete_binding(session, binding_id)
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.workspace.member_revoked",
        payload={
            "workspace_id": ws_id,
            "binding_id": binding_id,
            "subject_type": binding.subject_type,
            "subject_id": binding.subject_id,
            "role": binding.role_name,
            "actor_id": admin.id,
        },
    )
    logger.info(
        "Binding %s revoked from workspace %s by %s",
        binding_id, ws_id, admin.id,
    )
