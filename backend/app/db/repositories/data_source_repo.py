"""
Repository for workspace_data_sources table.
Each data source binds a Provider + Graph Name + Blueprint within a Workspace.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import WorkspaceDataSourceORM
from backend.common.models.management import (
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    DataSourceResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: WorkspaceDataSourceORM) -> DataSourceResponse:
    # Resolve display label: explicit label → catalog item name → graph_name → None
    resolved_label = row.label
    if not resolved_label and row.graph_name:
        resolved_label = row.graph_name
    if not resolved_label and hasattr(row, 'catalog_item') and row.catalog_item:
        resolved_label = row.catalog_item.name or row.catalog_item.source_identifier
    return DataSourceResponse(
        id=row.id,
        workspaceId=row.workspace_id,
        catalogItemId=row.catalog_item_id,
        ontologyId=row.ontology_id,
        label=resolved_label,
        isPrimary=bool(row.is_primary),
        isActive=bool(row.is_active),
        projectionMode=row.projection_mode,
        dedicatedGraphName=row.dedicated_graph_name,
        providerId=row.provider_id,
        graphName=row.graph_name,
        accessLevel=row.access_level,
        extraConfig=json.loads(row.extra_config) if row.extra_config else None,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_data_sources(
    session: AsyncSession, workspace_id: str
) -> List[DataSourceResponse]:
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id)
        .order_by(WorkspaceDataSourceORM.created_at)
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_data_source(
    session: AsyncSession, ds_id: str
) -> Optional[DataSourceResponse]:
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.id == ds_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_data_source_orm(
    session: AsyncSession, ds_id: str
) -> Optional[WorkspaceDataSourceORM]:
    """Return the raw ORM row (used by ProviderRegistry)."""
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .options(selectinload(WorkspaceDataSourceORM.catalog_item))
        .where(WorkspaceDataSourceORM.id == ds_id)
    )
    return result.scalar_one_or_none()


async def get_primary_data_source(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceDataSourceORM]:
    """Return the primary data source for a workspace."""
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .options(selectinload(WorkspaceDataSourceORM.catalog_item))
        .where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.is_primary == True,  # noqa: E712
            WorkspaceDataSourceORM.is_active == True,
        )
    )
    row = result.scalar_one_or_none()
    if row:
        return row
    # Fallback: first active data source
    result = await session.execute(
        select(WorkspaceDataSourceORM)
        .options(selectinload(WorkspaceDataSourceORM.catalog_item))
        .where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.is_active == True,  # noqa: E712
        ).order_by(WorkspaceDataSourceORM.created_at)
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_data_source(
    session: AsyncSession,
    workspace_id: str,
    req: DataSourceCreateRequest,
    make_primary: bool = False,
) -> DataSourceResponse:
    if req.catalog_item_id:
        # Catalog-based: resolve provider and graph from the catalog entry
        from .catalog_repo import get_catalog_item_orm
        cat = await get_catalog_item_orm(session, req.catalog_item_id)
        if not cat:
            raise ValueError(f"Catalog Item '{req.catalog_item_id}' not found")

        # 1:1 constraint: a catalog item can only belong to one workspace
        existing = await session.execute(
            select(WorkspaceDataSourceORM.workspace_id)
            .where(WorkspaceDataSourceORM.catalog_item_id == req.catalog_item_id)
            .limit(1)
        )
        bound = existing.scalar_one_or_none()
        if bound:
            raise ValueError(
                f"Catalog item '{req.catalog_item_id}' is already allocated to workspace '{bound}'"
            )
        provider_id = cat.provider_id
        graph_name = cat.source_identifier
        label = req.label or cat.name or cat.source_identifier
    elif req.provider_id:
        # Direct provider+graph: used by bootstrap and direct API calls
        provider_id = req.provider_id
        graph_name = req.graph_name
        label = req.label or req.graph_name or "default"
    else:
        raise ValueError("DataSource requires either catalogItemId or providerId")

    row = WorkspaceDataSourceORM(
        workspace_id=workspace_id,
        catalog_item_id=req.catalog_item_id,
        provider_id=provider_id,
        graph_name=graph_name,
        ontology_id=req.ontology_id,
        label=label,
        is_primary=make_primary,
        is_active=True,
        extra_config=json.dumps(req.extra_config) if req.extra_config else None,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_data_source(
    session: AsyncSession,
    ds_id: str,
    req: DataSourceUpdateRequest,
) -> Optional[DataSourceResponse]:
    row = await get_data_source_orm(session, ds_id)
    if not row:
        return None

    if req.ontology_id is not None:
        # Allow clearing with empty string → None
        row.ontology_id = req.ontology_id if req.ontology_id else None
    if req.label is not None:
        row.label = req.label
    if req.is_active is not None:
        row.is_active = req.is_active
    if req.projection_mode is not None:
        # Allow clearing with empty string → None
        row.projection_mode = req.projection_mode if req.projection_mode else None
    if req.dedicated_graph_name is not None:
        row.dedicated_graph_name = req.dedicated_graph_name if req.dedicated_graph_name else None
    if getattr(req, "access_level", None) is not None:
        row.access_level = req.access_level
    if req.extra_config is not None:
        row.extra_config = json.dumps(req.extra_config) if req.extra_config else None

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_data_source(
    session: AsyncSession, ds_id: str
) -> bool:
    result = await session.execute(
        delete(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.id == ds_id)
    )
    return result.rowcount > 0


async def count_data_sources(
    session: AsyncSession, workspace_id: str
) -> int:
    """Count active data sources for a workspace (used to prevent deleting the last one)."""
    from sqlalchemy import func
    result = await session.execute(
        select(func.count()).where(
            WorkspaceDataSourceORM.workspace_id == workspace_id,
            WorkspaceDataSourceORM.is_active == True,  # noqa: E712
        )
    )
    return result.scalar() or 0

async def get_data_source_impact(session: AsyncSession, ds_id: str):
    """Return the set of views that would be affected by changing/deleting this data source."""
    from ..models import ContextModelORM, ViewORM
    from backend.common.models.management import WorkspaceDataSourceImpactResponse, ImpactedEntity

    # Query the views table (primary source of truth for new views)
    view_result = await session.execute(
        select(ViewORM.id, ViewORM.name, ViewORM.view_type)
        .where(ViewORM.data_source_id == ds_id)
    )
    views = [{"id": r[0], "name": r[1], "type": r[2] or "view"} for r in view_result.all()]

    # Also check legacy context_models for backward compatibility
    seen_ids = {v["id"] for v in views}
    cm_result = await session.execute(
        select(ContextModelORM.id, ContextModelORM.name)
        .where(ContextModelORM.data_source_id == ds_id)
    )
    for r in cm_result.all():
        if r[0] not in seen_ids:
            views.append({"id": r[0], "name": r[1], "type": "context_model"})

    return WorkspaceDataSourceImpactResponse(
        views=[ImpactedEntity(**v) for v in views]
    )



async def set_primary(
    session: AsyncSession, workspace_id: str, ds_id: str
) -> bool:
    """Demote all data sources in workspace, then promote target."""
    await session.execute(
        update(WorkspaceDataSourceORM)
        .where(WorkspaceDataSourceORM.workspace_id == workspace_id)
        .values(is_primary=False)
    )
    result = await session.execute(
        update(WorkspaceDataSourceORM)
        .where(
            WorkspaceDataSourceORM.id == ds_id,
            WorkspaceDataSourceORM.workspace_id == workspace_id,
        )
        .values(
            is_primary=True,
            updated_at=datetime.now(timezone.utc).isoformat(),
        )
    )
    return result.rowcount > 0
