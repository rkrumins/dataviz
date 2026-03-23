"""
Repository for providers table.
Credential handling (encryption/decryption) reuses helpers from connection_repo.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ProviderORM
from backend.common.models.management import (
    ProviderCreateRequest,
    ProviderUpdateRequest,
    ProviderResponse,
    ProviderImpactResponse,
    ImpactedEntity,
)

# Re-use credential encryption from connection_repo
from .connection_repo import _encrypt, _decrypt

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: ProviderORM) -> ProviderResponse:
    return ProviderResponse(
        id=row.id,
        name=row.name,
        providerType=row.provider_type,
        host=row.host,
        port=row.port,
        tlsEnabled=bool(row.tls_enabled),
        isActive=bool(row.is_active),
        extraConfig=json.loads(row.extra_config) if row.extra_config else None,
        permittedWorkspaces=json.loads(row.permitted_workspaces) if row.permitted_workspaces else ["*"],
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_providers(session: AsyncSession) -> List[ProviderResponse]:
    result = await session.execute(
        select(ProviderORM).order_by(ProviderORM.created_at)
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_provider(
    session: AsyncSession, provider_id: str
) -> Optional[ProviderResponse]:
    result = await session.execute(
        select(ProviderORM).where(ProviderORM.id == provider_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_provider_orm(
    session: AsyncSession, provider_id: str
) -> Optional[ProviderORM]:
    """Return the raw ORM row (used by ProviderRegistry for connection params)."""
    result = await session.execute(
        select(ProviderORM).where(ProviderORM.id == provider_id)
    )
    return result.scalar_one_or_none()


async def create_provider(
    session: AsyncSession,
    req: ProviderCreateRequest,
) -> ProviderResponse:
    creds_blob = _encrypt(req.credentials.model_dump() if req.credentials else {})
    row = ProviderORM(
        name=req.name,
        provider_type=req.provider_type.value,
        host=req.host,
        port=req.port,
        credentials=creds_blob,
        tls_enabled=req.tls_enabled,
        is_active=True,
        extra_config=json.dumps(req.extra_config) if req.extra_config else None,
        permitted_workspaces=json.dumps(req.permitted_workspaces) if getattr(req, "permitted_workspaces", None) else '["*"]',
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_provider(
    session: AsyncSession,
    provider_id: str,
    req: ProviderUpdateRequest,
) -> Optional[ProviderResponse]:
    row = await get_provider_orm(session, provider_id)
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.host is not None:
        row.host = req.host
    if req.port is not None:
        row.port = req.port
    if req.credentials is not None:
        row.credentials = _encrypt(req.credentials.model_dump())
    if req.tls_enabled is not None:
        row.tls_enabled = req.tls_enabled
    if req.is_active is not None:
        row.is_active = req.is_active
    if req.extra_config is not None:
        row.extra_config = json.dumps(req.extra_config)
    if getattr(req, "permitted_workspaces", None) is not None:
        row.permitted_workspaces = json.dumps(req.permitted_workspaces)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_provider(
    session: AsyncSession, provider_id: str
) -> bool:
    result = await session.execute(
        delete(ProviderORM).where(ProviderORM.id == provider_id)
    )
    return result.rowcount > 0


async def get_credentials(
    session: AsyncSession, provider_id: str
) -> dict:
    """Return decrypted credentials for a provider (internal use only)."""
    row = await get_provider_orm(session, provider_id)
    if not row:
        return {}
    return _decrypt(row.credentials)


async def has_workspaces(session: AsyncSession, provider_id: str) -> bool:
    """Check if any workspaces subscribe to catalog items from this provider."""
    from ..models import WorkspaceDataSourceORM, CatalogItemORM
    result = await session.execute(
        select(WorkspaceDataSourceORM.id)
        .join(CatalogItemORM, WorkspaceDataSourceORM.catalog_item_id == CatalogItemORM.id)
        .where(CatalogItemORM.provider_id == provider_id)
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def get_provider_impact(session: AsyncSession, provider_id: str) -> ProviderImpactResponse:
    from ..models import WorkspaceDataSourceORM, CatalogItemORM, WorkspaceORM, ContextModelORM
    
    # 1. Affected Catalog Items
    cat_result = await session.execute(
        select(CatalogItemORM.id, CatalogItemORM.name)
        .where(CatalogItemORM.provider_id == provider_id)
    )
    catalog_items = [{"id": r[0], "name": r[1], "type": "catalog_item"} for r in cat_result.all()]
    
    # 2. Affected Workspaces
    ws_result = await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).distinct()
        .join(WorkspaceDataSourceORM, WorkspaceDataSourceORM.workspace_id == WorkspaceORM.id)
        .join(CatalogItemORM, WorkspaceDataSourceORM.catalog_item_id == CatalogItemORM.id)
        .where(CatalogItemORM.provider_id == provider_id)
    )
    workspaces = [{"id": r[0], "name": r[1], "type": "workspace"} for r in ws_result.all()]
    
    # 3. Affected Views
    view_result = await session.execute(
        select(ContextModelORM.id, ContextModelORM.name).distinct()
        .join(WorkspaceDataSourceORM, ContextModelORM.data_source_id == WorkspaceDataSourceORM.id)
        .join(CatalogItemORM, WorkspaceDataSourceORM.catalog_item_id == CatalogItemORM.id)
        .where(CatalogItemORM.provider_id == provider_id)
    )
    views = [{"id": r[0], "name": r[1], "type": "view"} for r in view_result.all()]
    
    return ProviderImpactResponse(
        catalogItems=[ImpactedEntity(**c) for c in catalog_items],
        workspaces=[ImpactedEntity(**w) for w in workspaces],
        views=[ImpactedEntity(**v) for v in views]
    )
