"""
Repository for catalog_items table (Enterprise Catalog).
Catalog Items abstract physical data sources into manageable data products.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import CatalogItemORM
from backend.common.models.management import (
    CatalogItemCreateRequest,
    CatalogItemUpdateRequest,
    CatalogItemResponse,
)

logger = logging.getLogger(__name__)

# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: CatalogItemORM) -> CatalogItemResponse:
    import json
    return CatalogItemResponse(
        id=row.id,
        providerId=row.provider_id,
        sourceIdentifier=row.source_identifier,
        name=row.name,
        description=row.description,
        permittedWorkspaces=json.loads(row.permitted_workspaces) if row.permitted_workspaces else ["*"],
        status=row.status,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_catalog_items(
    session: AsyncSession,
    provider_id: Optional[str] = None
) -> List[CatalogItemResponse]:
    stmt = select(CatalogItemORM)
    if provider_id:
        stmt = stmt.where(CatalogItemORM.provider_id == provider_id)
    stmt = stmt.order_by(CatalogItemORM.created_at)
    result = await session.execute(stmt)
    return [_to_response(r) for r in result.scalars().all()]


async def get_catalog_item(
    session: AsyncSession, item_id: str
) -> Optional[CatalogItemResponse]:
    result = await session.execute(
        select(CatalogItemORM).where(CatalogItemORM.id == item_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_catalog_item_orm(
    session: AsyncSession, item_id: str
) -> Optional[CatalogItemORM]:
    result = await session.execute(
        select(CatalogItemORM).where(CatalogItemORM.id == item_id)
    )
    return result.scalar_one_or_none()


async def create_catalog_item(
    session: AsyncSession,
    req: CatalogItemCreateRequest,
) -> CatalogItemResponse:
    import json
    row = CatalogItemORM(
        provider_id=req.provider_id,
        source_identifier=req.source_identifier,
        name=req.name,
        description=req.description,
        permitted_workspaces=json.dumps(req.permitted_workspaces) if getattr(req, "permitted_workspaces", None) else '["*"]',
        status="active",
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_catalog_item(
    session: AsyncSession,
    item_id: str,
    req: CatalogItemUpdateRequest,
) -> Optional[CatalogItemResponse]:
    import json
    row = await get_catalog_item_orm(session, item_id)
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.status is not None:
        row.status = req.status
    if getattr(req, "permitted_workspaces", None) is not None:
        row.permitted_workspaces = json.dumps(req.permitted_workspaces)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_catalog_item(
    session: AsyncSession, item_id: str
) -> bool:
    result = await session.execute(
        delete(CatalogItemORM).where(CatalogItemORM.id == item_id)
    )
    return result.rowcount > 0

async def get_catalog_item_impact(session: AsyncSession, item_id: str):
    from ..models import WorkspaceDataSourceORM, WorkspaceORM, ContextModelORM
    from backend.common.models.management import ProviderImpactResponse, ImpactedEntity
    
    ws_result = await session.execute(
        select(WorkspaceORM.id, WorkspaceORM.name).distinct()
        .join(WorkspaceDataSourceORM, WorkspaceDataSourceORM.workspace_id == WorkspaceORM.id)
        .where(WorkspaceDataSourceORM.catalog_item_id == item_id)
    )
    workspaces = [{"id": r[0], "name": r[1], "type": "workspace"} for r in ws_result.all()]
    
    view_result = await session.execute(
        select(ContextModelORM.id, ContextModelORM.name).distinct()
        .join(WorkspaceDataSourceORM, ContextModelORM.data_source_id == WorkspaceDataSourceORM.id)
        .where(WorkspaceDataSourceORM.catalog_item_id == item_id)
    )
    views = [{"id": r[0], "name": r[1], "type": "view"} for r in view_result.all()]
    
    return ProviderImpactResponse(
        catalogItems=[],
        workspaces=[ImpactedEntity(**w) for w in workspaces],
        views=[ImpactedEntity(**v) for v in views]
    )
