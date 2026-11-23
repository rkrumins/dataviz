"""A workspace's groups: every group bound in it, and the ones it owns, managed here.

What owning a group means, and the rules for changing one:
``backend.app.services.workspace_groups``.

Routes (mounted at ``/api/v1/admin/workspaces/{ws_id}/groups``):

  GET    ""                                  every group bound here (workspace:members:add)
  POST   ""                                  make one the workspace owns (workspace:admin)
  PATCH  /{group_id}                         rename, describe, change its role (owned only)
  DELETE /{group_id}                         delete it (owned only)
  GET    /{group_id}/members                 who is in it (workspace:members:add)
  POST   /{group_id}/members                 add someone (owned only)
  DELETE /{group_id}/members/{user_id}       remove someone the app added (owned only)
  POST   /{group_id}/idp-link                link it to an identity-provider group, or ask to
  DELETE /{group_id}/idp-links/{mapping_id}  remove a link (system:admin)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.services import idp_links, workspace_access, workspace_groups as service
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    WorkspaceGroupCreate,
    WorkspaceGroupIdpLinkCreate,
    WorkspaceGroupMember,
    WorkspaceGroupMemberAdd,
    WorkspaceGroupResponse,
    WorkspaceGroupUpdate,
)

router = APIRouter()

_reader = requires(workspace_access.MEMBERS_ADD, workspace="ws_id")
_admin = requires("workspace:admin", workspace="ws_id")


@router.get("", response_model=list[WorkspaceGroupResponse], response_model_by_alias=True)
async def list_workspace_groups(
    ws_id: str = Path(...),
    _user: User = Depends(_reader),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.list_groups(session, ws_id)


@router.post("", response_model=WorkspaceGroupResponse, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED)
async def create_workspace_group(
    body: WorkspaceGroupCreate,
    ws_id: str = Path(...),
    user: User = Depends(_admin),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Make a group the workspace owns, as ``"<workspace> · <name>"``. 409
    ``group_name_taken`` (with a free short name as ``suggestion``) when a group —
    a deleted one too — has that name. ``idpGroup`` links it at once for a platform
    administrator, and asks one otherwise."""
    return await service.create(session, user, claims, ws_id, body)


@router.patch("/{group_id}", response_model=WorkspaceGroupResponse, response_model_by_alias=True)
async def update_workspace_group(
    body: WorkspaceGroupUpdate,
    ws_id: str = Path(...),
    group_id: str = Path(...),
    user: User = Depends(_admin),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.update(session, user, claims, ws_id, group_id, body)


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace_group(
    ws_id: str = Path(...),
    group_id: str = Path(...),
    user: User = Depends(_admin),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    await service.delete(session, user, claims, ws_id, group_id)


@router.get("/{group_id}/members", response_model=list[WorkspaceGroupMember], response_model_by_alias=True)
async def list_workspace_group_members(
    ws_id: str = Path(...),
    group_id: str = Path(...),
    _user: User = Depends(_reader),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.members(session, ws_id, group_id)


@router.post("/{group_id}/members", response_model=WorkspaceGroupMember, response_model_by_alias=True,
             status_code=status.HTTP_201_CREATED)
async def add_workspace_group_member(
    body: WorkspaceGroupMemberAdd,
    ws_id: str = Path(...),
    group_id: str = Path(...),
    user: User = Depends(_admin),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.add_member(session, user, claims, ws_id, group_id, body.user_id)


@router.delete("/{group_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_workspace_group_member(
    ws_id: str = Path(...),
    group_id: str = Path(...),
    user_id: str = Path(...),
    user: User = Depends(_admin),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Only people added in the app: 409 ``managed_by_idp`` for someone the identity
    provider put in it."""
    await service.remove_member(session, user, claims, ws_id, group_id, user_id)


@router.post("/{group_id}/idp-link", response_model=WorkspaceGroupResponse, response_model_by_alias=True)
async def link_workspace_group(
    body: WorkspaceGroupIdpLinkCreate,
    ws_id: str = Path(...),
    group_id: str = Path(...),
    user: User = Depends(_admin),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """A platform administrator links it at once (``idpLinks``); anyone else asks one
    (``pendingIdpLink``) — 409 ``link_pending`` while the group already waits."""
    return await service.link(session, user, claims, ws_id, group_id, body.idp_group, body.provider_id)


@router.delete("/{group_id}/idp-links/{mapping_id}", status_code=status.HTTP_204_NO_CONTENT)
async def unlink_workspace_group(
    ws_id: str = Path(...),
    group_id: str = Path(...),
    mapping_id: str = Path(...),
    user: User = Depends(requires(idp_links.LINK_PERMISSION)),
    session: AsyncSession = Depends(get_db_session),
):
    await service.unlink(session, user, ws_id, group_id, mapping_id)
