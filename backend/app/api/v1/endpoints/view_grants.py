"""Per-View explicit grants — Layer 3 of the View access model (Phase 2).

Mounted at ``/api/v1/views/{view_id}/grants``. The grant role enum is
intentionally narrower than the global RBAC enum: ``editor`` and
``viewer`` only — see the design plan and ``grant_repo``.

  GET    /views/{view_id}/grants                list explicit grants
  POST   /views/{view_id}/grants                add a grant
  DELETE /views/{view_id}/grants/{grant_id}     remove a grant

Authorization: only the view's creator OR a workspace admin of the
view's workspace can manage grants. Today this maps to the
``workspace:admin`` permission scoped to the view's workspace; the
creator-self path is checked inline on the endpoint.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
)
from backend.app.db.engine import get_db_session
from backend.app.db.models import GroupORM, UserORM, ViewORM
from backend.app.db.repositories import grant_repo, group_repo, user_repo
from backend.app.services.permission_service import (
    PermissionClaims,
    has_permission,
)
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    ViewGrantCreateRequest,
    ViewGrantResponse,
    ViewGrantSubject,
)


logger = logging.getLogger(__name__)
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────

async def _load_view(session: AsyncSession, view_id: str) -> ViewORM:
    row = await session.execute(
        select(ViewORM).where(
            ViewORM.id == view_id,
            ViewORM.deleted_at.is_(None),
        )
    )
    view = row.scalar_one_or_none()
    if view is None:
        raise HTTPException(status_code=404, detail="View not found")
    return view


def _ensure_can_manage_grants(
    *,
    view: ViewORM,
    user: User,
    claims: PermissionClaims,
) -> None:
    """Permit only the creator OR a workspace admin of the view's
    workspace. Raises 403 otherwise.

    Called inline rather than via ``Depends(requires(...))`` because
    the workspace id we need to scope the permission against is on the
    View row, not in the URL path.
    """
    if view.created_by == user.id:
        return
    if has_permission(claims, "workspace:admin", workspace_id=view.workspace_id):
        return
    if has_permission(claims, "system:admin"):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="Only the creator or a workspace admin can manage grants on this view",
    )


async def _hydrate_subject(
    session: AsyncSession, subject_type: str, subject_id: str
) -> ViewGrantSubject:
    if subject_type == "user":
        row = await session.execute(select(UserORM).where(UserORM.id == subject_id))
        user_orm = row.scalar_one_or_none()
        if user_orm is None:
            return ViewGrantSubject(type=subject_type, id=subject_id)
        full_name = f"{user_orm.first_name} {user_orm.last_name}".strip()
        return ViewGrantSubject(
            type="user",
            id=subject_id,
            display_name=full_name or None,
            secondary=user_orm.email,
        )

    row = await session.execute(select(GroupORM).where(GroupORM.id == subject_id))
    group_orm = row.scalar_one_or_none()
    if group_orm is None:
        return ViewGrantSubject(type=subject_type, id=subject_id)
    member_count = await group_repo.count_members(session, group_orm.id)
    return ViewGrantSubject(
        type="group",
        id=subject_id,
        display_name=group_orm.name,
        secondary=f"{member_count} member{'s' if member_count != 1 else ''}",
    )


# ── Routes ───────────────────────────────────────────────────────────

@router.get(
    "",
    response_model=list[ViewGrantResponse],
    response_model_by_alias=True,
)
async def list_grants(
    view_id: str,
    request: Request,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    view = await _load_view(session, view_id)
    _ensure_can_manage_grants(view=view, user=user, claims=claims)

    grants = await grant_repo.list_grants_for_resource(
        session, resource_type="view", resource_id=view_id,
    )
    out: list[ViewGrantResponse] = []
    for g in grants:
        subject = await _hydrate_subject(session, g.subject_type, g.subject_id)
        out.append(
            ViewGrantResponse(
                grant_id=g.id,
                role=g.role_name,
                granted_at=g.granted_at,
                granted_by=g.granted_by,
                subject=subject,
            )
        )
    return out


@router.post(
    "",
    response_model=ViewGrantResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_grant(
    view_id: str,
    body: ViewGrantCreateRequest,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    view = await _load_view(session, view_id)
    _ensure_can_manage_grants(view=view, user=user, claims=claims)

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

    existing = await grant_repo.find_grant(
        session,
        resource_type="view",
        resource_id=view_id,
        subject_type=body.subject_type,
        subject_id=body.subject_id,
    )
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Subject already has a grant on this view",
        )

    try:
        grant = await grant_repo.create_grant(
            session,
            resource_type="view",
            resource_id=view_id,
            subject_type=body.subject_type,
            subject_id=body.subject_id,
            role_name=body.role,
            granted_by=user.id,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.view.grant_added",
        payload={
            "view_id": view_id,
            "workspace_id": view.workspace_id,
            "grant_id": grant.id,
            "subject_type": body.subject_type,
            "subject_id": body.subject_id,
            "role": body.role,
            "actor_id": user.id,
        },
    )
    subject = await _hydrate_subject(session, body.subject_type, body.subject_id)
    return ViewGrantResponse(
        grant_id=grant.id,
        role=grant.role_name,
        granted_at=grant.granted_at,
        granted_by=grant.granted_by,
        subject=subject,
    )


@router.delete(
    "/{grant_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_grant(
    view_id: str,
    grant_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    view = await _load_view(session, view_id)
    _ensure_can_manage_grants(view=view, user=user, claims=claims)

    # Verify the grant belongs to this view before deleting — defends
    # against an attacker constructing a malicious grant_id from another
    # view they happen to own.
    grants = await grant_repo.list_grants_for_resource(
        session, resource_type="view", resource_id=view_id,
    )
    target = next((g for g in grants if g.id == grant_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Grant not found on this view")

    await grant_repo.delete_grant(session, grant_id)
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.view.grant_removed",
        payload={
            "view_id": view_id,
            "workspace_id": view.workspace_id,
            "grant_id": grant_id,
            "subject_type": target.subject_type,
            "subject_id": target.subject_id,
            "role": target.role_name,
            "actor_id": user.id,
        },
    )
    logger.info(
        "Grant %s removed from view %s by %s", grant_id, view_id, user.id,
    )
