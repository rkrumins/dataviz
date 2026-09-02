"""Admin endpoints for managing groups (RBAC Phase 2).

Mounted at ``/api/v1/admin/groups`` and gated by the new
``requires("system:groups:manage")`` dependency. The classic ``require_admin``
gate would also work (admin role bundles ``groups:manage``), but we
use the granular permission so a future custom-roles release can
delegate group management without granting full system admin.

  GET    /admin/groups                       list groups
  POST   /admin/groups                       create
  PATCH  /admin/groups/{id}                  rename / re-describe
  DELETE /admin/groups/{id}                  soft-delete
  GET    /admin/groups/{id}/members          list members
  POST   /admin/groups/{id}/members          add member
  DELETE /admin/groups/{id}/members/{user}   remove member
"""
from __future__ import annotations

import logging
from collections.abc import Sequence

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import binding_repo, group_repo, grant_repo, user_repo
from backend.app.services.revocation_service import revoke_subject_sessions
from backend.auth_service.interface import User
from backend.common.display_name import resolve_display_name
from backend.common.models.rbac import (
    GroupCreateRequest,
    GroupMemberAddRequest,
    GroupMemberPreview,
    GroupMemberResponse,
    GroupResponse,
    GroupUpdateRequest,
)


logger = logging.getLogger(__name__)
router = APIRouter()

#: Faces the admin groups table draws per row before it collapses the
#: rest into a "+N" chip.
_MEMBER_PREVIEW = 4


# ── helpers ──────────────────────────────────────────────────────────

def _to_response(
    group_orm,
    *,
    member_count: int,
    member_preview: Sequence[dict[str, str]] = (),
) -> GroupResponse:
    """Build the DTO from a group row plus counts the CALLER resolved.

    Deliberately takes ``member_count`` rather than fetching it: this used
    to run its own COUNT, which made ``list_groups`` an N+1 over the whole
    page. The list route resolves counts and previews once, in two batched
    queries, and hands them in.
    """
    return GroupResponse(
        id=group_orm.id,
        name=group_orm.name,
        description=group_orm.description,
        source=group_orm.source,
        external_id=group_orm.external_id,
        created_at=group_orm.created_at,
        updated_at=group_orm.updated_at,
        member_count=member_count,
        member_preview=[
            GroupMemberPreview(id=p["id"], display_name=p["name"])
            for p in member_preview
        ],
    )


def _member_response(member_orm, identity: dict | None) -> GroupMemberResponse:
    """One membership row, with the member's identity folded in.

    ``identity`` is a row from ``user_repo.get_identities_by_ids`` — or
    ``None`` when the id resolves to nothing at all. That case keeps
    ``display_name=None`` on purpose: an orphaned membership is a real
    state, the admin needs to see it to remove it, and the FE must show
    the raw id rather than invent a name over it.
    """
    identity = identity or {}
    return GroupMemberResponse(
        user_id=member_orm.user_id,
        group_id=member_orm.group_id,
        added_at=member_orm.added_at,
        added_by=member_orm.added_by,
        source=getattr(member_orm, "source", None) or "local",
        # ``resolve_display_name`` yields "" for an account with no name
        # parts at all; the email is a better label than a blank line.
        display_name=identity.get("name") or identity.get("email") or None,
        email=identity.get("email"),
        status=identity.get("status"),
        deleted=bool(identity.get("deleted")),
    )


# ── Group CRUD ───────────────────────────────────────────────────────

@router.get("", response_model=list[GroupResponse], response_model_by_alias=True)
async def list_groups(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    groups = await group_repo.list_groups(session, limit=limit, offset=offset)
    ids = [g.id for g in groups]
    counts = await group_repo.count_members_batch(session, ids)
    previews = await group_repo.member_preview_batch(
        session, ids, per_group=_MEMBER_PREVIEW,
    )
    return [
        _to_response(
            g,
            member_count=counts.get(g.id, 0),
            member_preview=previews.get(g.id, []),
        )
        for g in groups
    ]


@router.post(
    "",
    response_model=GroupResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_group(
    body: GroupCreateRequest,
    admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    existing = await group_repo.get_group_by_name(session, body.name)
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Group '{body.name}' already exists",
        )
    group = await group_repo.create_group(
        session, name=body.name, description=body.description
    )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.created",
        payload={"group_id": group.id, "name": group.name, "actor_id": admin.id},
    )
    logger.info("Group %s created by %s", group.id, admin.id)
    # Nothing has had time to join it.
    return _to_response(group, member_count=0)


@router.patch(
    "/{group_id}",
    response_model=GroupResponse,
    response_model_by_alias=True,
)
async def update_group(
    group_id: str,
    body: GroupUpdateRequest,
    admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    group = await group_repo.update_group(
        session, group_id, name=body.name, description=body.description
    )
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.updated",
        payload={"group_id": group_id, "actor_id": admin.id},
    )
    return _to_response(
        group,
        member_count=await group_repo.count_members(session, group_id),
    )


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: str,
    admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    # Snapshot the membership BEFORE the soft-delete so we can fan
    # out session revocation to every user who was inheriting bindings
    # through this group.
    members_before = await group_repo.list_group_members(session, group_id)

    deleted = await group_repo.soft_delete_group(session, group_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Group not found")

    # Tear down every binding the group held — orphaned bindings would
    # otherwise leak access to ex-members through the resolver.
    n_bindings = await binding_repo.delete_subject_bindings(
        session, subject_type="group", subject_id=group_id,
    )
    n_grants = await grant_repo.delete_subject_grants(
        session, subject_type="group", subject_id=group_id,
    )

    # Revoke each ex-member's sessions so they lose inherited access
    # immediately rather than after JWT expiry.
    revoked = 0
    for m in members_before:
        revoked += await revoke_subject_sessions(
            "user", m.user_id, session=session,
            reason="group_deleted",
        )

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.deleted",
        payload={
            "group_id": group_id,
            "actor_id": admin.id,
            "bindings_revoked": n_bindings,
            "grants_revoked": n_grants,
            "sessions_revoked": revoked,
        },
    )
    logger.info(
        "Group %s soft-deleted by %s (revoked %d bindings, %d grants, %d sessions)",
        group_id, admin.id, n_bindings, n_grants, revoked,
    )


# ── Membership ───────────────────────────────────────────────────────

@router.get(
    "/{group_id}/members",
    response_model=list[GroupMemberResponse],
    response_model_by_alias=True,
)
async def list_members(
    group_id: str,
    _admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    if await group_repo.get_group_by_id(session, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    members = await group_repo.list_group_members(session, group_id)
    # Who these people ARE, resolved here in one batched query.
    #
    # The FE used to answer this by fetching the whole admin user list and
    # joining client-side, which was wrong two ways: that list caps at its
    # 50 newest accounts (so any older member rendered as a bare
    # ``usr_...`` id), and it is gated on ``system:admin`` — which a
    # delegated groups admin does not hold, so the member list 403'd and
    # sat on its spinner forever. Neither is a UI problem; both are this
    # endpoint declining to say who it is talking about.
    identities = await user_repo.get_identities_by_ids(
        session, [m.user_id for m in members],
    )
    return [
        _member_response(m, identities.get(m.user_id))
        for m in members
    ]


@router.post(
    "/{group_id}/members",
    response_model=GroupMemberResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def add_member(
    group_id: str,
    body: GroupMemberAddRequest,
    admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    if await group_repo.get_group_by_id(session, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    user = await user_repo.get_user_by_id(session, body.user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    member = await group_repo.add_member(
        session, group_id, body.user_id, added_by=admin.id,
    )

    # The user just inherited every binding this group holds. Their
    # current JWT was issued BEFORE the membership existed, so its
    # ``ws_perms`` doesn't include the group-bound workspaces yet —
    # ``GET /workspaces`` would silently exclude those from their
    # sidebar until the access token expires. Revoke their sessions
    # so the next request forces a fresh login + claim re-resolve.
    revoked = await revoke_subject_sessions(
        "user", body.user_id, session=session,
        reason="group_membership_added",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.member_added",
        payload={
            "group_id": group_id,
            "user_id": body.user_id,
            "actor_id": admin.id,
            "sessions_revoked": revoked,
        },
    )
    logger.info(
        "User %s added to group %s by %s (sessions killed: %d)",
        body.user_id, group_id, admin.id, revoked,
    )
    # Identity off the row the 404 check already fetched — no extra query,
    # and the route stops advertising fields that only IT leaves null.
    return _member_response(member, {
        "name": resolve_display_name(
            user.display_name, user.first_name, user.last_name,
        ),
        "email": user.email,
        "status": user.status,
        "deleted": user.deleted_at is not None,
    })


@router.delete(
    "/{group_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_member(
    group_id: str,
    user_id: str,
    admin: User = Depends(requires("system:groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    removed = await group_repo.remove_member(session, group_id, user_id)
    if not removed:
        raise HTTPException(
            status_code=404,
            detail="Membership not found",
        )

    # The user just lost every binding inherited from this group.
    # Revoke their sessions so the next request re-resolves from DB
    # and the stale ``ws_perms`` doesn't grant access until the JWT
    # expires.
    revoked = await revoke_subject_sessions(
        "user", user_id, session=session,
        reason="group_membership_removed",
    )

    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.member_removed",
        payload={
            "group_id": group_id,
            "user_id": user_id,
            "actor_id": admin.id,
            "sessions_revoked": revoked,
        },
    )
    logger.info(
        "User %s removed from group %s by %s (sessions killed: %d)",
        user_id, group_id, admin.id, revoked,
    )
