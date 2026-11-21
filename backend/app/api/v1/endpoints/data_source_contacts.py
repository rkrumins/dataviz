"""A data source's data contacts — its Owner and Stewards.

Routes (mounted from ``api.py`` at ``/admin/workspaces/{ws_id}/data-sources/{ds_id}/contacts``):

  GET   ""   the contacts, how they were found, and what the caller may change
             (workspace:datasource:read)
  PUT   ""   replace them (workspace:datasource:manage; changing the Owner also
             workspace:admin or being the current Owner; conversationsEnabled on)

Rules: ``backend.app.services.data_source_contacts``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.services import data_source_contacts as service
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.discussions import DataContactsResponse, DataContactsUpdate

router = APIRouter()


@router.get("", response_model=DataContactsResponse, response_model_by_alias=True)
async def get_data_contacts(
    ws_id: str = Path(...),
    ds_id: str = Path(...),
    user: User = Depends(requires(service.READ, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.read(session, user, claims, await service.live_source(session, ws_id, ds_id))


@router.put("", response_model=DataContactsResponse, response_model_by_alias=True,
            dependencies=[Depends(require_feature(service.FLAG, default=False))])
async def put_data_contacts(
    body: DataContactsUpdate,
    ws_id: str = Path(...),
    ds_id: str = Path(...),
    user: User = Depends(requires(service.MANAGE, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.save(session, user, claims, ws_id, ds_id, body)
