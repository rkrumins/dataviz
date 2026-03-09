"""
Repository for context_models table.
Context models define how to organize graph nodes into logical business flows.
Templates (is_template=True) are reusable starting points; instances are workspace-scoped.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ContextModelORM
from backend.common.models.management import (
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    ContextModelResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: ContextModelORM) -> ContextModelResponse:
    return ContextModelResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        workspaceId=row.workspace_id,
        dataSourceId=row.data_source_id,
        isTemplate=bool(row.is_template),
        category=row.category,
        layersConfig=json.loads(row.layers_config or "[]"),
        scopeFilter=json.loads(row.scope_filter) if row.scope_filter else None,
        instanceAssignments=json.loads(row.instance_assignments or "{}"),
        scopeEdgeConfig=json.loads(row.scope_edge_config) if row.scope_edge_config else None,
        isActive=bool(row.is_active),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_context_models(
    session: AsyncSession,
    workspace_id: Optional[str] = None,
    templates_only: bool = False,
) -> List[ContextModelResponse]:
    """List context models, optionally filtered by workspace or templates."""
    stmt = select(ContextModelORM)

    if templates_only:
        stmt = stmt.where(ContextModelORM.is_template == True)
    elif workspace_id:
        stmt = stmt.where(ContextModelORM.workspace_id == workspace_id)

    stmt = stmt.order_by(ContextModelORM.updated_at.desc())
    result = await session.execute(stmt)
    return [_to_response(r) for r in result.scalars().all()]


async def get_context_model(
    session: AsyncSession, context_model_id: str
) -> Optional[ContextModelResponse]:
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def create_context_model(
    session: AsyncSession,
    req: ContextModelCreateRequest,
    workspace_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
) -> ContextModelResponse:
    row = ContextModelORM(
        name=req.name,
        description=req.description,
        workspace_id=workspace_id,
        data_source_id=data_source_id,
        is_template=req.is_template,
        category=req.category,
        layers_config=json.dumps(req.layers_config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
        instance_assignments=json.dumps(req.instance_assignments),
        scope_edge_config=json.dumps(req.scope_edge_config) if req.scope_edge_config else None,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_context_model(
    session: AsyncSession,
    context_model_id: str,
    req: ContextModelUpdateRequest,
) -> Optional[ContextModelResponse]:
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.layers_config is not None:
        row.layers_config = json.dumps(req.layers_config)
    if req.scope_filter is not None:
        row.scope_filter = json.dumps(req.scope_filter)
    if req.instance_assignments is not None:
        row.instance_assignments = json.dumps(req.instance_assignments)
    if req.scope_edge_config is not None:
        row.scope_edge_config = json.dumps(req.scope_edge_config)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_context_model(
    session: AsyncSession, context_model_id: str
) -> bool:
    result = await session.execute(
        delete(ContextModelORM).where(ContextModelORM.id == context_model_id)
    )
    return result.rowcount > 0


async def instantiate_template(
    session: AsyncSession,
    template_id: str,
    workspace_id: str,
    name: str,
    data_source_id: Optional[str] = None,
) -> Optional[ContextModelResponse]:
    """Create a workspace-scoped context model from a template."""
    result = await session.execute(
        select(ContextModelORM).where(
            ContextModelORM.id == template_id,
            ContextModelORM.is_template == True,
        )
    )
    template = result.scalar_one_or_none()
    if not template:
        return None

    row = ContextModelORM(
        name=name,
        description=f"Created from template: {template.name}",
        workspace_id=workspace_id,
        data_source_id=data_source_id,
        is_template=False,
        category=template.category,
        layers_config=template.layers_config,
        scope_filter=template.scope_filter,
        instance_assignments="{}",  # Fresh — no entity assignments from template
        scope_edge_config=template.scope_edge_config,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)
