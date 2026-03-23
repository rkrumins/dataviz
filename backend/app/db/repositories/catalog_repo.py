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
    rows = result.scalars().all()

    # Deduplicate: keep only the earliest row per (provider_id, source_identifier).
    # This handles legacy duplicates that predate the unique constraint.
    seen: dict[tuple[str, str | None], bool] = {}
    deduped = []
    for r in rows:
        key = (r.provider_id, r.source_identifier)
        if key not in seen:
            seen[key] = True
            deduped.append(r)
    return [_to_response(r) for r in deduped]


async def cleanup_duplicate_catalog_items(session: AsyncSession) -> int:
    """Remove duplicate catalog items, keeping the earliest entry per
    (provider_id, source_identifier). Returns number of rows deleted."""
    result = await session.execute(
        select(CatalogItemORM).order_by(CatalogItemORM.created_at)
    )
    rows = result.scalars().all()
    seen: dict[tuple[str, str | None], str] = {}  # key -> kept id
    to_delete: list[str] = []
    for r in rows:
        key = (r.provider_id, r.source_identifier)
        if key in seen:
            to_delete.append(r.id)
        else:
            seen[key] = r.id
    if to_delete:
        await session.execute(
            delete(CatalogItemORM).where(CatalogItemORM.id.in_(to_delete))
        )
        await session.flush()
    return len(to_delete)


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

    # Idempotent: if a catalog item already exists for (provider_id, source_identifier),
    # return the existing one instead of creating a duplicate.
    if req.source_identifier:
        existing = await session.execute(
            select(CatalogItemORM).where(
                CatalogItemORM.provider_id == req.provider_id,
                CatalogItemORM.source_identifier == req.source_identifier,
            ).limit(1)
        )
        found = existing.scalar_one_or_none()
        if found:
            return _to_response(found)

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
