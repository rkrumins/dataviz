"""Admin endpoints for managing groups (RBAC Phase 2).

Mounted at ``/api/v1/admin/groups`` and gated by the new
``requires("groups:manage")`` dependency. The classic ``require_admin``
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

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import binding_repo, group_repo, grant_repo, user_repo
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    GroupCreateRequest,
    GroupMemberAddRequest,
    GroupMemberResponse,
    GroupResponse,
    GroupUpdateRequest,
)


logger = logging.getLogger(__name__)
router = APIRouter()


# ── helpers ──────────────────────────────────────────────────────────

async def _to_response(session: AsyncSession, group_orm) -> GroupResponse:
    member_count = await group_repo.count_members(session, group_orm.id)
    return GroupResponse(
        id=group_orm.id,
        name=group_orm.name,
        description=group_orm.description,
        source=group_orm.source,
        external_id=group_orm.external_id,
        created_at=group_orm.created_at,
        updated_at=group_orm.updated_at,
        member_count=member_count,
    )


# ── Group CRUD ───────────────────────────────────────────────────────

@router.get("", response_model=list[GroupResponse], response_model_by_alias=True)
async def list_groups(
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
    _admin: User = Depends(requires("groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    groups = await group_repo.list_groups(session, limit=limit, offset=offset)
    return [await _to_response(session, g) for g in groups]


@router.post(
    "",
    response_model=GroupResponse,
    response_model_by_alias=True,
    status_code=status.HTTP_201_CREATED,
)
async def create_group(
    body: GroupCreateRequest,
    admin: User = Depends(requires("groups:manage")),
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
    return await _to_response(session, group)


@router.patch(
    "/{group_id}",
    response_model=GroupResponse,
    response_model_by_alias=True,
)
async def update_group(
    group_id: str,
    body: GroupUpdateRequest,
    admin: User = Depends(requires("groups:manage")),
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
    return await _to_response(session, group)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: str,
    admin: User = Depends(requires("groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
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
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.deleted",
        payload={
            "group_id": group_id,
            "actor_id": admin.id,
            "bindings_revoked": n_bindings,
            "grants_revoked": n_grants,
        },
    )
    logger.info(
        "Group %s soft-deleted by %s (revoked %d bindings, %d grants)",
        group_id, admin.id, n_bindings, n_grants,
    )


# ── Membership ───────────────────────────────────────────────────────

@router.get(
    "/{group_id}/members",
    response_model=list[GroupMemberResponse],
    response_model_by_alias=True,
)
async def list_members(
    group_id: str,
    _admin: User = Depends(requires("groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    if await group_repo.get_group_by_id(session, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    members = await group_repo.list_group_members(session, group_id)
    return [
        GroupMemberResponse(
            user_id=m.user_id,
            group_id=m.group_id,
            added_at=m.added_at,
            added_by=m.added_by,
        )
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
    admin: User = Depends(requires("groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    if await group_repo.get_group_by_id(session, group_id) is None:
        raise HTTPException(status_code=404, detail="Group not found")
    if await user_repo.get_user_by_id(session, body.user_id) is None:
        raise HTTPException(status_code=404, detail="User not found")

    member = await group_repo.add_member(
        session, group_id, body.user_id, added_by=admin.id,
    )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.member_added",
        payload={
            "group_id": group_id,
            "user_id": body.user_id,
            "actor_id": admin.id,
        },
    )
    logger.info(
        "User %s added to group %s by %s", body.user_id, group_id, admin.id,
    )
    return GroupMemberResponse(
        user_id=member.user_id,
        group_id=member.group_id,
        added_at=member.added_at,
        added_by=member.added_by,
    )


@router.delete(
    "/{group_id}/members/{user_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_member(
    group_id: str,
    user_id: str,
    admin: User = Depends(requires("groups:manage")),
    session: AsyncSession = Depends(get_db_session),
):
    removed = await group_repo.remove_member(session, group_id, user_id)
    if not removed:
        raise HTTPException(
            status_code=404,
            detail="Membership not found",
        )
    await user_repo.create_outbox_event(
        session,
        event_type="rbac.group.member_removed",
        payload={
            "group_id": group_id,
            "user_id": user_id,
            "actor_id": admin.id,
        },
    )
    logger.info(
        "User %s removed from group %s by %s", user_id, group_id, admin.id,
    )
