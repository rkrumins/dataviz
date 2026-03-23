"""
Repository for workspaces table.
Workspaces are operational contexts that contain one or more data sources
(each binding a Provider + Graph Name + Blueprint).
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ..models import WorkspaceORM, WorkspaceDataSourceORM
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
    DataSourceResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _ds_to_response(row: WorkspaceDataSourceORM) -> DataSourceResponse:
    # Resolve display label: explicit label → graph_name (physical asset) → catalog item name
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
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


def _to_response(row: WorkspaceORM) -> WorkspaceResponse:
    ds_list = [_ds_to_response(ds) for ds in (row.data_sources or [])]
    return WorkspaceResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        dataSources=ds_list,
        isDefault=bool(row.is_default),
        isActive=bool(row.is_active),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# Queries (with eager loading of data_sources)                         #
# ------------------------------------------------------------------ #

def _ws_query():
    return select(WorkspaceORM).options(selectinload(WorkspaceORM.data_sources))


async def list_workspaces(session: AsyncSession) -> List[WorkspaceResponse]:
    result = await session.execute(
        _ws_query().order_by(WorkspaceORM.created_at)
    )
    return [_to_response(r) for r in result.scalars().unique().all()]


async def get_workspace(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceResponse]:
    result = await session.execute(
        _ws_query().where(WorkspaceORM.id == workspace_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_workspace_orm(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceORM]:
    """Return the raw ORM row with data_sources eagerly loaded."""
    result = await session.execute(
        _ws_query().where(WorkspaceORM.id == workspace_id)
    )
    return result.scalar_one_or_none()


async def get_default_workspace(
    session: AsyncSession,
) -> Optional[WorkspaceORM]:
    """Return the default workspace (is_default=True, is_active=True)."""
    result = await session.execute(
        _ws_query()
        .where(
            WorkspaceORM.is_default == True,  # noqa: E712
            WorkspaceORM.is_active == True,
        )
    )
    return result.scalar_one_or_none()


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def create_workspace(
    session: AsyncSession,
    req: WorkspaceCreateRequest,
    make_default: bool = False,
) -> WorkspaceResponse:
    ws = WorkspaceORM(
        name=req.name,
        description=req.description,
        is_default=make_default,
        is_active=True,
    )
    session.add(ws)
    await session.flush()  # assigns ws.id

    # Create data source rows
    from .catalog_repo import get_catalog_item_orm
    for i, ds_req in enumerate(req.data_sources):
        if ds_req.catalog_item_id:
            # Catalog-based: resolve provider and graph name from catalog item
            cat = await get_catalog_item_orm(session, ds_req.catalog_item_id)
            if not cat:
                raise ValueError(f"Catalog Item '{ds_req.catalog_item_id}' not found")
            provider_id = cat.provider_id
            graph_name = cat.source_identifier
            label = ds_req.label or cat.name or cat.source_identifier
        elif ds_req.provider_id:
            # Direct provider+graph: used by bootstrap and direct API calls
            provider_id = ds_req.provider_id
            graph_name = ds_req.graph_name
            label = ds_req.label or ds_req.graph_name or "default"
        else:
            raise ValueError("DataSource requires either catalogItemId or providerId")

        ds = WorkspaceDataSourceORM(
            workspace_id=ws.id,
            catalog_item_id=ds_req.catalog_item_id,
            provider_id=provider_id,
            graph_name=graph_name,
            ontology_id=ds_req.ontology_id,
            label=label,
            is_primary=(i == 0),  # first data source is primary by default
            is_active=True,
        )
        session.add(ds)

    await session.flush()

    # Reload with data_sources
    result = await session.execute(
        _ws_query().where(WorkspaceORM.id == ws.id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row)


async def update_workspace(
    session: AsyncSession,
    workspace_id: str,
    req: WorkspaceUpdateRequest,
) -> Optional[WorkspaceResponse]:
    row = await get_workspace_orm(session, workspace_id)
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.is_active is not None:
        row.is_active = req.is_active

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_workspace(
    session: AsyncSession, workspace_id: str
) -> bool:
    result = await session.execute(
        delete(WorkspaceORM).where(WorkspaceORM.id == workspace_id)
    )
    return result.rowcount > 0


async def set_default(
    session: AsyncSession, workspace_id: str
) -> bool:
    """Demote all others, then promote target."""
    await session.execute(
        update(WorkspaceORM).values(is_default=False)
    )
    result = await session.execute(
        update(WorkspaceORM)
        .where(WorkspaceORM.id == workspace_id)
        .values(is_default=True, updated_at=datetime.now(timezone.utc).isoformat())
    )
    return result.rowcount > 0
