"""Workspace-request endpoints: asking for a workspace of your own, and answering.

What a request is and what approving one does: ``backend.app.services.workspace_requests``.

Routes (mounted from ``api.py``):

  POST   /api/v1/workspace-requests                       ask (switch on)
  GET    /api/v1/me/workspace-requests                    your requests, newest first
  GET    /api/v1/me/workspace-requests/{id}               one of yours (404 for anyone else's)
  PUT    /api/v1/me/workspace-requests/{id}               resubmit one sent back (switch on)
  POST   /api/v1/me/workspace-requests/{id}/withdraw
  GET    /api/v1/admin/workspace-requests?status=open     system:workspaces:create
  GET    /api/v1/admin/workspace-requests/{id}            … with the requester's Playground activity
  POST   /api/v1/admin/workspace-requests/{id}/approve
  POST   /api/v1/admin/workspace-requests/{id}/idp-links   (system:admin)
  POST   /api/v1/admin/workspace-requests/{id}/send-back
  POST   /api/v1/admin/workspace-requests/{id}/decline

``workspaceRequestsEnabled`` gates asking — a new request and a resubmitted one.
Turned off, everything already asked stays readable, withdrawable and answerable.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import workspace_request_repo
from backend.app.services import workspace_requests as service
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    WorkspaceRequestIdpLink,
    WorkspaceRequestApprove,
    WorkspaceRequestCreate,
    WorkspaceRequestDecline,
    WorkspaceRequestDetail,
    WorkspaceRequestResponse,
    WorkspaceRequestSendBack,
)

_FLAG = "workspaceRequestsEnabled"
#: It ships off, so a definition not seeded yet means off too — not the capability
#: posture's fail-open.
_asking = [Depends(require_feature(_FLAG, default=False))]
_approver = requires(service.APPROVER_PERMISSION)

public_router = APIRouter()   # /workspace-requests         (any signed-in user)
me_router = APIRouter()       # /me/workspace-requests      (the requester)
admin_router = APIRouter()    # /admin/workspace-requests   (system:workspaces:create)


async def _one(session: AsyncSession, row) -> WorkspaceRequestResponse:
    return (await service.to_responses(session, [row]))[0]


# ── The requester ────────────────────────────────────────────────────


@public_router.post("", response_model=WorkspaceRequestResponse, response_model_by_alias=True,
                    status_code=status.HTTP_201_CREATED, dependencies=_asking)
async def submit_workspace_request(
    body: WorkspaceRequestCreate,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask for a workspace. 409 ``name_taken`` (with a ``suggestion``) when a workspace
    already has the name; 409 ``request_open`` (with its ``requestId``) when you have
    a request open already."""
    return await _one(session, await service.submit(session, user, body))


@me_router.get("/workspace-requests", response_model=list[WorkspaceRequestResponse],
               response_model_by_alias=True)
async def list_my_workspace_requests(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.to_responses(
        session, await workspace_request_repo.list_for_requester(session, user.id),
    )


@me_router.get("/workspace-requests/{request_id}", response_model=WorkspaceRequestResponse,
               response_model_by_alias=True)
async def get_my_workspace_request(
    request_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await _one(session, await service.own(session, user, request_id))


@me_router.put("/workspace-requests/{request_id}", response_model=WorkspaceRequestResponse,
               response_model_by_alias=True, dependencies=_asking)
async def resubmit_my_workspace_request(
    body: WorkspaceRequestCreate,
    request_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    """Edit a request sent back with a question, and send it again."""
    return await _one(session, await service.resubmit(session, user, request_id, body))


@me_router.post("/workspace-requests/{request_id}/withdraw", response_model=WorkspaceRequestResponse,
                response_model_by_alias=True)
async def withdraw_my_workspace_request(
    request_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await _one(session, await service.withdraw(session, user, request_id))


# ── The approvers ────────────────────────────────────────────────────


@admin_router.get("", response_model=list[WorkspaceRequestResponse], response_model_by_alias=True)
async def list_workspace_requests(
    status_filter: Optional[str] = Query(default="open", alias="status"),
    _user: User = Depends(_approver),
    session: AsyncSession = Depends(get_db_session),
):
    """``?status=open`` (pending or sent back; the default), ``all``, or one status."""
    try:
        rows = await workspace_request_repo.list_by_status(session, status=status_filter)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await service.to_responses(session, rows)


@admin_router.get("/{request_id}", response_model=WorkspaceRequestDetail, response_model_by_alias=True)
async def get_workspace_request(
    request_id: str = Path(...),
    _user: User = Depends(_approver),
    session: AsyncSession = Depends(get_db_session),
):
    row = await workspace_request_repo.get(session, request_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Workspace request not found")
    return await service.detail(session, row)


@admin_router.post("/{request_id}/approve", response_model=WorkspaceRequestResponse,
                   response_model_by_alias=True)
async def approve_workspace_request(
    request_id: str = Path(...),
    body: Optional[WorkspaceRequestApprove] = None,
    approver: User = Depends(_approver),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Create the workspace — under another name or description if given — make the
    requester its Workspace Admin and the teammates its Members, and move the chosen
    Playground graphs in. ``outcome`` says which graphs moved and which couldn't."""
    body = body or WorkspaceRequestApprove()
    row = await service.approve(session, approver, claims, request_id,
                                name=body.name, description=body.description,
                                group_names=body.group_names, idp_provider_id=body.idp_provider_id,
                                admit_to_sandbox=body.admit_to_sandbox)
    return await _one(session, row)


@admin_router.post("/{request_id}/idp-links", response_model=WorkspaceRequestResponse,
                   response_model_by_alias=True)
async def link_workspace_request_group(
    body: WorkspaceRequestIdpLink,
    request_id: str = Path(...),
    admin: User = Depends(requires(service.IDP_LINK_PERMISSION)),
    session: AsyncSession = Depends(get_db_session),
):
    """Link a group the approved request made to the identity-provider group it named
    (platform administrators — the SSO rules' own bar). For the links an Org Admin's
    approval left waiting."""
    return await _one(session, await service.link_idp_group(
        session, admin, request_id, body.group_id, body.idp_provider_id))


@admin_router.post("/{request_id}/send-back", response_model=WorkspaceRequestResponse,
                   response_model_by_alias=True)
async def send_back_workspace_request(
    body: WorkspaceRequestSendBack,
    request_id: str = Path(...),
    approver: User = Depends(_approver),
    session: AsyncSession = Depends(get_db_session),
):
    return await _one(session, await service.send_back(session, approver, request_id, body.question))


@admin_router.post("/{request_id}/decline", response_model=WorkspaceRequestResponse,
                   response_model_by_alias=True)
async def decline_workspace_request(
    request_id: str = Path(...),
    body: Optional[WorkspaceRequestDecline] = None,
    approver: User = Depends(_approver),
    session: AsyncSession = Depends(get_db_session),
):
    reason = body.reason if body is not None else None
    return await _one(session, await service.decline(session, approver, request_id, reason))
