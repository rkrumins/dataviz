"""Per-View explicit grants — Layer 3 of the View access model (Phase 2).

Mounted at ``/api/v1/views/{view_id}/grants``. The grant role enum is
intentionally narrower than the global RBAC enum: ``editor`` and
``viewer`` only — see the design plan and ``grant_repo``.

  GET    /views/{view_id}/grants                list explicit grants
  POST   /views/{view_id}/grants                add a grant
  PUT    /views/{view_id}/grants/{grant_id}     change its role, or its source query
  DELETE /views/{view_id}/grants/{grant_id}     remove a grant

A share may also let its holder run their own read-only queries on the
view's data source (``canQuerySource``). Only someone who may query that
source themselves can turn it on; anyone who manages the shares can turn it
off.

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
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import (
    get_current_user,
    get_permission_claims,
)
from backend.app.db.engine import get_db_session
from backend.common.display_name import resolve_display_name
from backend.app.db.models import GroupORM, UserORM, ViewORM
from backend.app.db.repositories import grant_repo, group_repo, user_repo
from backend.app.db.repositories import notification_repo, view_activity_repo
from backend.app.services import view_access
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    ViewGrantCreateRequest,
    ViewGrantResponse,
    ViewGrantSubject,
)
from backend.common.service_accounts import is_service_account


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

    The rule itself lives in ``view_access.can_manage_grants`` (one
    rule, one place); this wrapper adapts it to the HTTP layer. Group
    ids aren't needed — the rule never consults grants.
    """
    ctx = view_access.ViewerContext(
        user_id=user.id, claims=claims, group_ids=(),
    )
    if view_access.can_manage_grants(ctx, view):
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


async def hydrate_subject(
    session: AsyncSession, subject_type: str, subject_id: str
) -> ViewGrantSubject:
    if subject_type == "user":
        row = await session.execute(select(UserORM).where(UserORM.id == subject_id))
        user_orm = row.scalar_one_or_none()
        if user_orm is None:
            return ViewGrantSubject(type=subject_type, id=subject_id)
        # Same rule as the workspace-member rows: the chosen display
        # name wins, and an all-blank profile falls to the email rather
        # than to a raw id.
        shown = resolve_display_name(
            user_orm.display_name, user_orm.first_name,
            user_orm.last_name,
        )
        return ViewGrantSubject(
            type="user",
            id=subject_id,
            display_name=shown or user_orm.email or None,
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


def _ensure_can_grant_source_query(
    *, view: ViewORM, user: User, claims: PermissionClaims,
) -> None:
    """Letting a share query the data source takes being able to query it."""
    ctx = view_access.ViewerContext(user_id=user.id, claims=claims, group_ids=())
    if view_access.can_grant_source_query(ctx, view):
        return
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail={
            "error": "missing_permission",
            "permission": view_access.NATIVE_QUERY_PERMISSION,
            "scope": {"type": "workspace", "id": view.workspace_id},
            "message": (
                "Only someone who can query this view's data source can let a "
                "share query it"
            ),
        },
    )


def _access_words(role: str, can_query_source: bool) -> str:
    return f"{role}, can query its data source" if can_query_source else role


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
        subject = await hydrate_subject(session, g.subject_type, g.subject_id)
        out.append(
            ViewGrantResponse(
                grant_id=g.id,
                role=g.role_name,
                granted_at=g.granted_at,
                granted_by=g.granted_by,
                subject=subject,
                can_query_source=bool(g.can_query_source),
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
    view: ViewORM = Depends(can_manage_view_grants),
    session: AsyncSession = Depends(get_db_session),
):
    if body.can_query_source:
        _ensure_can_grant_source_query(view=view, user=user, claims=claims)
    if body.subject_type == "user":
        if await user_repo.get_user_by_id(session, body.subject_id) is None:
            raise HTTPException(status_code=404, detail="User not found")
        if is_service_account(body.subject_id):
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A view can't be shared with a service account: its access is the "
                "workspace roles given on its own page, under Service accounts",
            )
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
            can_query_source=body.can_query_source,
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
            "can_query_source": body.can_query_source,
            "actor_id": user.id,
        },
    )
    subject = await hydrate_subject(session, body.subject_type, body.subject_id)
    subject_label = (
        getattr(subject, "name", None) or getattr(subject, "display_name", None)
        or body.subject_id
    )
    # The whole point of sharing: the recipient finds out.
    recipients = (
        [body.subject_id] if body.subject_type == "user"
        else [m.user_id for m in await group_repo.list_group_members(session, body.subject_id)]
    )
    await notification_repo.notify(
        session,
        user_ids=recipients,
        kind="view.shared",
        title=f'"{view.name}" was shared with you',
        body=(
            f"You can open it as a {body.role}, and run read-only queries on its data source."
            if body.can_query_source else f"You can open it as a {body.role}."
        ),
        link=f"/views/{view_id}",
        actor_id=user.id,
        resource_type="view",
        resource_id=view_id,
    )
    await view_activity_repo.record_view_activity(
        session, view_id=view_id, workspace_id=view.workspace_id,
        action="shared", actor=user.id,
        summary=f"Shared with {subject_label} ({_access_words(body.role, body.can_query_source)})",
        changes={"subjectType": body.subject_type, "subjectId": body.subject_id, "role": body.role,
                 "canQuerySource": body.can_query_source},
    )
    return ViewGrantResponse(
        grant_id=grant.id,
        role=grant.role_name,
        granted_at=grant.granted_at,
        granted_by=grant.granted_by,
        subject=subject,
        can_query_source=bool(grant.can_query_source),
    )


@router.put(
    "/{grant_id}",
    response_model=ViewGrantResponse,
    response_model_by_alias=True,
)
async def update_grant_role(
    view_id: str,
    grant_id: str,
    role: Optional[str] = Body(None, embed=True),
    can_query_source: Optional[bool] = Body(None, embed=True, alias="canQuerySource"),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    view: ViewORM = Depends(can_manage_view_grants),
    session: AsyncSession = Depends(get_db_session),
):
    """Change an existing grant's role (viewer ↔ editor), or whether it may
    query the view's data source, in place — no revoke + re-share dance, and
    the grant's audit trail (granted_at / granted_by) stays intact."""
    if role is None and can_query_source is None:
        raise HTTPException(status_code=422, detail="Send role, canQuerySource, or both")
    if role is not None and role not in grant_repo.VALID_GRANT_ROLES:
        raise HTTPException(
            status_code=422,
            detail=f"role must be one of: {', '.join(sorted(grant_repo.VALID_GRANT_ROLES))}",
        )
    grants = await grant_repo.list_grants_for_resource(
        session, resource_type="view", resource_id=view_id,
    )
    target = next((g for g in grants if g.id == grant_id), None)
    if target is None:
        # Same defence as delete: a grant id from another view the
        # caller happens to manage must not be reachable here.
        raise HTTPException(status_code=404, detail="Grant not found on this view")

    previous_role, previous_query = target.role_name, bool(target.can_query_source)
    new_role = role if role is not None else previous_role
    new_query = can_query_source if can_query_source is not None else previous_query
    if new_query and not previous_query:
        _ensure_can_grant_source_query(view=view, user=user, claims=claims)
    if (new_role, new_query) != (previous_role, previous_query):
        target.role_name, target.can_query_source = new_role, new_query
        await session.flush()
        await user_repo.create_outbox_event(
            session,
            event_type="rbac.view.grant_updated",
            payload={
                "view_id": view_id,
                "workspace_id": view.workspace_id,
                "grant_id": grant_id,
                "subject_type": target.subject_type,
                "subject_id": target.subject_id,
                "role": new_role,
                "previous_role": previous_role,
                "can_query_source": new_query,
                "previous_can_query_source": previous_query,
                "actor_id": user.id,
            },
        )
        subject_for_log = await hydrate_subject(
            session, target.subject_type, target.subject_id,
        )
        subject_label = subject_for_log.display_name or target.subject_id
        changes: dict = {"subjectType": target.subject_type, "subjectId": target.subject_id}
        if new_role != previous_role:
            changes["role"] = {"from": previous_role, "to": new_role}
        if new_query != previous_query:
            changes["canQuerySource"] = {"from": previous_query, "to": new_query}
        await view_activity_repo.record_view_activity(
            session, view_id=view_id, workspace_id=view.workspace_id,
            action="shared", actor=user.id,
            summary=f"Changed {subject_label} to {_access_words(new_role, new_query)}",
            changes=changes,
        )
    subject = await hydrate_subject(session, target.subject_type, target.subject_id)
    return ViewGrantResponse(
        grant_id=target.id,
        role=target.role_name,
        granted_at=target.granted_at,
        granted_by=target.granted_by,
        subject=subject,
        can_query_source=bool(target.can_query_source),
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
