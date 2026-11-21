"""Data-request endpoints: asking for data to be connected to a workspace, and connecting it.

What a request is and who answers it: ``backend.app.services.data_requests``.

Routes (mounted from ``api.py``):

  POST   /api/v1/admin/workspaces/{ws_id}/data-requests     ask (workspace:datasource:read; switch on)
  GET    /api/v1/admin/workspaces/{ws_id}/data-requests     the workspace's requests (?status=)
  GET    /api/v1/me/data-requests                           your requests, in every workspace
  POST   /api/v1/me/data-requests/{id}/withdraw             while nobody has taken it
  GET    /api/v1/admin/data-requests?status=open            the platform team's queue (system:workspaces:create)
  POST   /api/v1/admin/data-requests/{id}/start             take it on
  POST   /api/v1/admin/data-requests/{id}/connect           {dataSourceId?, note?}
  POST   /api/v1/admin/data-requests/{id}/decline           {reason?} (the platform team)

Start and connect are the platform team's, and the workspace's own data people's
(``workspace:datasource:manage`` there); each is checked per request.

``dataRequestsEnabled`` gates asking. Turned off, everything already asked stays
readable, withdrawable and answerable.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import data_request_repo
from backend.app.services import data_requests as service
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.rbac import (
    DataRequestConnect,
    DataRequestCreate,
    DataRequestDecline,
    DataRequestResponse,
)

_FLAG = "dataRequestsEnabled"
#: It ships off, so a definition not seeded yet means off too — not the capability
#: posture's fail-open.
_asking = [Depends(require_feature(_FLAG, default=False))]
_reader = requires(service.ASK_PERMISSION, workspace="ws_id")

ws_router = APIRouter()      # /admin/workspaces/{ws_id}/data-requests   (the workspace's readers)
me_router = APIRouter()      # /me/data-requests                         (the requester)
admin_router = APIRouter()   # /admin/data-requests                      (the platform team; checked per request)


async def _one(session: AsyncSession, row) -> DataRequestResponse:
    return (await service.to_responses(session, [row]))[0]


# ── A workspace's readers ────────────────────────────────────────────


@ws_router.post("", response_model=DataRequestResponse, response_model_by_alias=True,
                status_code=status.HTTP_201_CREATED, dependencies=_asking)
async def ask_for_data(
    body: DataRequestCreate,
    ws_id: str = Path(...),
    user: User = Depends(_reader),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask for data to be connected to this workspace."""
    return await _one(session, await service.submit(session, user, ws_id, body))


@ws_router.get("", response_model=list[DataRequestResponse], response_model_by_alias=True)
async def list_workspace_data_requests(
    ws_id: str = Path(...),
    status_filter: Optional[str] = Query(default="all", alias="status"),
    _user: User = Depends(_reader),
    session: AsyncSession = Depends(get_db_session),
):
    """Everything asked for in this workspace, newest first: ``?status=all`` (the
    default), ``open`` (pending or in progress) or one status."""
    try:
        rows = await data_request_repo.list_for_workspace(session, ws_id, status=status_filter)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await service.to_responses(session, rows)


# ── The requester ────────────────────────────────────────────────────


@me_router.get("/data-requests", response_model=list[DataRequestResponse], response_model_by_alias=True)
async def list_my_data_requests(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.to_responses(session, await data_request_repo.list_for_requester(session, user.id))


@me_router.post("/data-requests/{request_id}/withdraw", response_model=DataRequestResponse,
                response_model_by_alias=True)
async def withdraw_my_data_request(
    request_id: str = Path(...),
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_db_session),
):
    return await _one(session, await service.withdraw(session, user, request_id))


# ── The platform team, and a workspace's data people ─────────────────


@admin_router.get("", response_model=list[DataRequestResponse], response_model_by_alias=True)
async def list_data_requests(
    status_filter: Optional[str] = Query(default="open", alias="status"),
    _user: User = Depends(requires(service.PLATFORM_PERMISSION)),
    session: AsyncSession = Depends(get_db_session),
):
    """Every workspace's requests: ``?status=open`` (pending or in progress; the
    default), ``all``, or one status."""
    try:
        rows = await data_request_repo.list_by_status(session, status=status_filter)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await service.to_responses(session, rows)


@admin_router.post("/{request_id}/start", response_model=DataRequestResponse, response_model_by_alias=True)
async def start_data_request(
    request_id: str = Path(...),
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Take it on: you become its assignee, and the requester hears it's under way."""
    return await _one(session, await service.start(session, user, claims, request_id))


@admin_router.post("/{request_id}/connect", response_model=DataRequestResponse, response_model_by_alias=True)
async def connect_data_request(
    request_id: str = Path(...),
    body: Optional[DataRequestConnect] = None,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Mark it connected — naming the data source it became (422 ``data_source_elsewhere``
    unless it is in the request's workspace) — with a note for the requester."""
    body = body or DataRequestConnect()
    return await _one(session, await service.connect(
        session, user, claims, request_id, data_source_id=body.data_source_id, note=body.note,
    ))


@admin_router.post("/{request_id}/decline", response_model=DataRequestResponse, response_model_by_alias=True)
async def decline_data_request(
    request_id: str = Path(...),
    body: Optional[DataRequestDecline] = None,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    reason = body.reason if body is not None else None
    return await _one(session, await service.decline(session, user, claims, request_id, reason))
