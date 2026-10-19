"""Moving a data source, with its views, to another workspace: where it can go, what a move
would do, asking the destination to take it, answering, and undoing a move.

The logic lives in ``services/data_source_transfer.py``; these routes say who may ask.
Someone who administers both workspaces moves a source directly (the existing
``POST /admin/workspaces/{ws}/data-sources/{ds}/move``, in ``workspaces.py``); someone who
administers only the source sends a request, which the destination's admins accept or
decline. API keys reach none of it.

Routes (mounted from ``api.py``):

  GET  /api/v1/admin/workspaces/{workspace_id}/data-sources/{ds_id}/move-destinations
  GET  /api/v1/admin/workspaces/{workspace_id}/data-sources/{ds_id}/move-preview?to=
  POST /api/v1/admin/workspaces/{workspace_id}/data-sources/{ds_id}/transfer-requests
  GET  /api/v1/admin/workspaces/{workspace_id}/data-sources/{ds_id}/transfers
  GET  /api/v1/admin/workspaces/{workspace_id}/data-source-transfers?status=open|all
  GET  /api/v1/admin/data-source-transfers?status=open|all
  GET  /api/v1/admin/data-source-transfers/{transfer_id}
  POST /api/v1/admin/data-source-transfers/{transfer_id}/accept
  POST /api/v1/admin/data-source-transfers/{transfer_id}/decline
  POST /api/v1/admin/data-source-transfers/{transfer_id}/cancel
  POST /api/v1/admin/data-source-transfers/{transfer_id}/undo
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.auth.dependencies import get_current_user, get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.services import data_source_transfer as transfers
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.management import (
    DataSourceMoveRequest,
    DataSourceTransferDetail,
    DataSourceTransferResponse,
    TransferAccept,
    TransferDestination,
    TransferPreview,
    TransferResolve,
)

source_router = APIRouter()     # /admin/workspaces/{workspace_id}/data-sources/{ds_id}
workspace_router = APIRouter()  # /admin/workspaces/{workspace_id}/data-source-transfers
admin_router = APIRouter()      # /admin/data-source-transfers (parties; checked per request)

_STATUS = Query("open", pattern="^(open|all)$")
#: Everyone party to a transfer administers a workspace — the one it leaves or the one it goes
#: to. Checked per transfer by the service; this refuses everyone else up front, and confirms the
#: session is still alive (an unconfirmable one is a 503, as for every admin route).
_PARTY = requires("workspace:admin", workspace_any=True)


async def _one(session: AsyncSession, row, claims: PermissionClaims, user: User):
    return (await transfers.to_responses(session, [row], claims, user_id=user.id))[0]


# ── one source ───────────────────────────────────────────────────────


@source_router.get("/move-destinations", response_model=list[TransferDestination])
async def list_move_destinations(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Where this source could go, and whether the caller may move it there or ask to."""
    ds = await transfers.source_in(session, ds_id, workspace_id)
    return await transfers.destinations(session, ds=ds, claims=claims)


@source_router.get("/move-preview", response_model=TransferPreview)
async def preview_move(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    to: str = Query(..., description="The workspace it would move to."),
    _user: User = Depends(requires("workspace:datasource:manage", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Everything a move would take, who keeps, gains and loses access, and what's in its way."""
    ds = await transfers.source_in(session, ds_id, workspace_id)
    return await transfers.preview(session, ds=ds, to_ws_id=to, claims=claims)


@source_router.post("/transfer-requests", response_model=DataSourceTransferResponse,
                    status_code=201)
async def propose_transfer(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    req: DataSourceMoveRequest = Body(...),
    user: User = Depends(requires("workspace:admin", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Ask the destination's admins to take this source. The stated reason travels with it."""
    row = await transfers.propose(session, ds_id=ds_id, from_ws_id=workspace_id, claims=claims,
                                  user_id=user.id, req=req)
    return await _one(session, row, claims, user)


@source_router.get("/transfers", response_model=list[DataSourceTransferResponse])
async def transfer_history(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    user: User = Depends(requires("workspace:datasource:read", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Where this source has lived, and the requests to move it, newest first."""
    ds = await transfers.source_in(session, ds_id, workspace_id)
    return await transfers.history(session, ds=ds, claims=claims, user_id=user.id)


# ── one workspace ────────────────────────────────────────────────────


@workspace_router.get("", response_model=list[DataSourceTransferResponse])
async def workspace_transfers(
    workspace_id: str = Path(...),
    status: str = _STATUS,
    user: User = Depends(requires("workspace:admin", workspace="workspace_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Requests to move sources into or out of this workspace."""
    return await transfers.for_workspace(session, ws_id=workspace_id, status_filter=status,
                                         claims=claims, user_id=user.id)


# ── answering, cancelling, undoing ───────────────────────────────────


@admin_router.get("", response_model=list[DataSourceTransferResponse])
async def incoming_transfers(
    status: str = _STATUS,
    user: User = Depends(get_current_user),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Requests into the workspaces the caller administers (every workspace for an org admin)."""
    return await transfers.incoming(session, status_filter=status, claims=claims, user_id=user.id)


@admin_router.get("/{transfer_id}", response_model=DataSourceTransferDetail)
async def get_transfer(
    transfer_id: str = Path(...),
    user: User = Depends(_PARTY),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """A transfer — and, while it waits, a fresh preview with what changed since the ask."""
    return await transfers.detail(session, transfer_id=transfer_id, claims=claims, user_id=user.id)


@admin_router.post("/{transfer_id}/accept", response_model=DataSourceTransferResponse)
async def accept_transfer(
    transfer_id: str = Path(...),
    req: TransferAccept = Body(...),
    user: User = Depends(_PARTY),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    row = await transfers.accept(session, transfer_id=transfer_id, claims=claims, user_id=user.id,
                                 preview_token=req.preview_token)
    return await _one(session, row, claims, user)


@admin_router.post("/{transfer_id}/decline", response_model=DataSourceTransferResponse)
async def decline_transfer(
    transfer_id: str = Path(...),
    req: TransferResolve = Body(default_factory=TransferResolve),
    user: User = Depends(_PARTY),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    row = await transfers.decline(session, transfer_id=transfer_id, claims=claims,
                                  user_id=user.id, note=req.note)
    return await _one(session, row, claims, user)


@admin_router.post("/{transfer_id}/cancel", response_model=DataSourceTransferResponse)
async def cancel_transfer(
    transfer_id: str = Path(...),
    req: TransferResolve = Body(default_factory=TransferResolve),
    user: User = Depends(_PARTY),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    row = await transfers.cancel(session, transfer_id=transfer_id, claims=claims,
                                 user_id=user.id, note=req.note)
    return await _one(session, row, claims, user)


@admin_router.post("/{transfer_id}/undo", response_model=DataSourceTransferResponse)
async def undo_transfer(
    transfer_id: str = Path(...),
    user: User = Depends(_PARTY),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    """Put a move back, for a week, while nothing new has been built on the source."""
    row = await transfers.undo(session, transfer_id=transfer_id, claims=claims, user_id=user.id)
    return await _one(session, row, claims, user)
