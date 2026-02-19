"""
Repository for workspaces table.
Workspaces bind a Provider + Graph Name + Blueprint into a queryable context.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import WorkspaceORM
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: WorkspaceORM) -> WorkspaceResponse:
    return WorkspaceResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        providerId=row.provider_id,
        graphName=row.graph_name,
        blueprintId=row.blueprint_id,
        isDefault=bool(row.is_default),
        isActive=bool(row.is_active),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_workspaces(session: AsyncSession) -> List[WorkspaceResponse]:
    result = await session.execute(
        select(WorkspaceORM).order_by(WorkspaceORM.created_at)
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_workspace(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceResponse]:
    result = await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == workspace_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_workspace_orm(
    session: AsyncSession, workspace_id: str
) -> Optional[WorkspaceORM]:
    """Return the raw ORM row (used by ProviderRegistry)."""
    result = await session.execute(
        select(WorkspaceORM).where(WorkspaceORM.id == workspace_id)
    )
    return result.scalar_one_or_none()


async def get_default_workspace(
    session: AsyncSession,
) -> Optional[WorkspaceORM]:
    """Return the default workspace (is_default=True, is_active=True)."""
    result = await session.execute(
        select(WorkspaceORM).where(
            WorkspaceORM.is_default == True,  # noqa: E712
            WorkspaceORM.is_active == True,
        )
    )
    return result.scalar_one_or_none()


async def create_workspace(
    session: AsyncSession,
    req: WorkspaceCreateRequest,
    make_default: bool = False,
) -> WorkspaceResponse:
    row = WorkspaceORM(
        name=req.name,
        description=req.description,
        provider_id=req.provider_id,
        graph_name=req.graph_name,
        blueprint_id=req.blueprint_id,
        is_default=make_default,
        is_active=True,
    )
    session.add(row)
    await session.flush()
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
    if req.provider_id is not None:
        row.provider_id = req.provider_id
    if req.graph_name is not None:
        row.graph_name = req.graph_name
    if req.blueprint_id is not None:
        row.blueprint_id = req.blueprint_id
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
