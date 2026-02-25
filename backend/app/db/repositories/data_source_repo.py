"""
Repository for workspace_data_sources table.
Each data source binds a Provider + Graph Name + Blueprint within a Workspace.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession

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
    return DataSourceResponse(
        id=row.id,
        workspaceId=row.workspace_id,
        providerId=row.provider_id,
        graphName=row.graph_name,
        blueprintId=row.blueprint_id,
        label=row.label,
        isPrimary=bool(row.is_primary),
        isActive=bool(row.is_active),
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
        .where(WorkspaceDataSourceORM.id == ds_id)
    )
    return result.scalar_one_or_none()


async def get_primary_data_source(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceDataSourceORM]:
    """Return the primary data source for a workspace."""
    result = await session.execute(
        select(WorkspaceDataSourceORM).where(
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
        select(WorkspaceDataSourceORM).where(
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
    row = WorkspaceDataSourceORM(
        workspace_id=workspace_id,
        provider_id=req.provider_id,
        graph_name=req.graph_name,
        blueprint_id=req.blueprint_id,
        label=req.label,
        is_primary=make_primary,
        is_active=True,
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

    if req.provider_id is not None:
        row.provider_id = req.provider_id
    if req.graph_name is not None:
        row.graph_name = req.graph_name
    if req.blueprint_id is not None:
        row.blueprint_id = req.blueprint_id
    if req.label is not None:
        row.label = req.label
    if req.is_active is not None:
        row.is_active = req.is_active

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
        )
    )
    return result.scalar() or 0


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
