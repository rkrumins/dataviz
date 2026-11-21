"""A data source's details — what it is, where to read more, and whether to trust it.

Routes (mounted from ``api.py`` at ``/admin/workspaces/{ws_id}/data-sources/{ds_id}/metadata``):

  GET   ""        the details, how the source came to be, and what the caller may change
                  (workspace:datasource:read; read with the switch off too)
  PUT   ""        replace the description, links and tags
                  (workspace:datasource:manage; dataSourceMetadataEnabled on)
  PUT   "/trust"  replace the classification, status and note (workspace:datasource:read
                  here; the service asks for workspace:admin or a named Owner or Steward;
                  dataSourceMetadataEnabled on)

Rules: ``backend.app.services.data_source_metadata``.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_feature
from backend.app.auth.dependencies import get_permission_claims, requires
from backend.app.db.engine import get_db_session
from backend.app.services import data_source_metadata as service
from backend.app.services.data_source_contacts import live_source
from backend.app.services.permission_service import PermissionClaims
from backend.auth_service.interface import User
from backend.common.models.data_source_metadata import (
    DataSourceDetailsUpdate,
    DataSourceMetadata,
    DataSourceTrustUpdate,
)

router = APIRouter()
_switch = [Depends(require_feature(service.FLAG, default=False))]


@router.get("", response_model=DataSourceMetadata, response_model_by_alias=True)
async def get_data_source_metadata(
    ws_id: str = Path(...),
    ds_id: str = Path(...),
    user: User = Depends(requires(service.READ, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.read(session, user, claims, await live_source(session, ws_id, ds_id))


@router.put("", response_model=DataSourceMetadata, response_model_by_alias=True, dependencies=_switch)
async def put_data_source_metadata(
    body: DataSourceDetailsUpdate,
    ws_id: str = Path(...),
    ds_id: str = Path(...),
    user: User = Depends(requires(service.MANAGE, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.save_details(session, user, claims, ws_id, ds_id, body)


@router.put("/trust", response_model=DataSourceMetadata, response_model_by_alias=True, dependencies=_switch)
async def put_data_source_trust(
    body: DataSourceTrustUpdate,
    ws_id: str = Path(...),
    ds_id: str = Path(...),
    user: User = Depends(requires(service.READ, workspace="ws_id")),
    claims: PermissionClaims = Depends(get_permission_claims),
    session: AsyncSession = Depends(get_db_session),
):
    return await service.save_trust(session, user, claims, ws_id, ds_id, body)
