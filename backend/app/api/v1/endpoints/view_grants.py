"""Per-View explicit grants — Layer 3 of the View access model (Phase 2).

Mounted at ``/api/v1/views/{view_id}/grants``. The grant role enum is
intentionally narrower than the global RBAC enum: ``editor`` and
``viewer`` only — see the design plan and ``grant_repo``.

  GET    /views/{view_id}/grants                list explicit grants
  POST   /views/{view_id}/grants                add a grant
  DELETE /views/{view_id}/grants/{grant_id}     remove a grant

Authorization: only the view's creator OR a workspace admin of the
view's workspace can manage grants. Phase 6 promotes the check from
an inline call to a router-level FastAPI dependency
(``can_manage_view_grants``) so that:

  1. Removing the gate is impossible without touching the router
     signature — the grep-coverage tests in
     ``test_rbac_endpoint_coverage.py`` would catch a regression.
  2. The creator carve-out is preserved (a standard
     ``Depends(requires("workspace:admin"))`` would 403 the creator
     who doesn't also hold workspace:admin).
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
from backend.app.db.repositories import view_activity_repo
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
# Router-level dependency: every route here passes through
# ``can_manage_view_grants``. The dep returns the loaded view so the
# handlers don't re-query. Wiring it at the router rather than the
# operation level means a regression that removes the gate would have
# to delete a visible line — and the per-endpoint coverage tests
# notice missing gates by inspecting the router.
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

    Pure-function variant of ``can_manage_view_grants`` kept for
    callers that already have the view in hand (e.g. the handler
    body, which loaded the view to attach workspace metadata to the
    outbox event). Both paths agree by construction — there's one
    rule, two callsites.
    """
    if view.created_by == user.id:
        return
    if has_permission(claims, "workspace:admin", workspace_id=view.workspace_id):
        return
    if has_permission(claims, "system:admin"):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "missing_permission",
            "permission": "workspace:admin",
            "scope": {"type": "workspace", "id": view.workspace_id},
            "message": (
                "Only the creator or a workspace admin can manage "
                "grants on this view"
            ),
        },
    )


async def can_manage_view_grants(
    view_id: str,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
) -> ViewORM:
    """Router-level gate for ``/views/{view_id}/grants``.

    Returns the loaded ``ViewORM`` so handlers can reuse it without
    a second lookup. Raises 404 if the view doesn't exist (consistent
    with ``_load_view``), 403 if the caller isn't the creator AND
    lacks ``workspace:admin`` in the view's workspace AND lacks
    ``system:admin``.

    Why a custom dep instead of ``requires("workspace:admin",
    workspace="view_id")``: the path param is the view id, not the
    workspace id. We need to load the view to find the workspace.
    The standard ``requires(...)`` factory has no hook for that
    indirection. A bespoke dep is the simplest way to wire a
    router-level gate that's grep-discoverable AND honours the
    creator carve-out.
    """
    view = await _load_view(session, view_id)
    _ensure_can_manage_grants(view=view, user=user, claims=claims)
    return view


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
    view: ViewORM = Depends(can_manage_view_grants),
    session: AsyncSession = Depends(get_db_session),
):
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
    view: ViewORM = Depends(can_manage_view_grants),
    session: AsyncSession = Depends(get_db_session),
):
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
    subject_label = (
        getattr(subject, "name", None) or getattr(subject, "display_name", None)
        or body.subject_id
    )
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view.workspace_id,
        action="shared", actor=user.id,
        summary=f"Shared with {subject_label} ({body.role})",
        changes={"subjectType": body.subject_type, "subjectId": body.subject_id, "role": body.role},
    )
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
    view: ViewORM = Depends(can_manage_view_grants),
    session: AsyncSession = Depends(get_db_session),
):
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
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view.workspace_id,
        action="unshared", actor=user.id,
        summary=f"Revoked {target.subject_type} access",
        changes={"subjectType": target.subject_type, "subjectId": target.subject_id},
    )
    logger.info(
        "Grant %s removed from view %s by %s", grant_id, view_id, user.id,
    )
