"""
Repository for assignment_rule_sets and saved_views tables.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import AssignmentRuleSetORM, SavedViewORM
from backend.common.models.management import (
    RuleSetCreateRequest,
    RuleSetResponse,
    SavedViewCreateRequest,
    SavedViewResponse,
    ViewType,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# Assignment Rule Sets                                                  #
# ------------------------------------------------------------------ #

def _rule_set_to_response(row: AssignmentRuleSetORM) -> RuleSetResponse:
    return RuleSetResponse(
        id=row.id,
        connectionId=row.connection_id or row.workspace_id or "",
        name=row.name,
        description=row.description,
        isDefault=bool(row.is_default),
        layersConfig=json.loads(row.layers_config or "[]"),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


async def list_rule_sets(
    session: AsyncSession, connection_id: str
) -> List[RuleSetResponse]:
    result = await session.execute(
        select(AssignmentRuleSetORM)
        .where(AssignmentRuleSetORM.connection_id == connection_id)
        .order_by(AssignmentRuleSetORM.created_at)
    )
    return [_rule_set_to_response(r) for r in result.scalars().all()]


async def get_rule_set(
    session: AsyncSession, rule_set_id: str
) -> Optional[RuleSetResponse]:
    result = await session.execute(
        select(AssignmentRuleSetORM).where(AssignmentRuleSetORM.id == rule_set_id)
    )
    row = result.scalar_one_or_none()
    return _rule_set_to_response(row) if row else None


async def get_default_rule_set(
    session: AsyncSession, connection_id: str
) -> Optional[AssignmentRuleSetORM]:
    result = await session.execute(
        select(AssignmentRuleSetORM).where(
            AssignmentRuleSetORM.connection_id == connection_id,
            AssignmentRuleSetORM.is_default == True,  # noqa: E712
        )
    )
    return result.scalar_one_or_none()


async def create_rule_set(
    session: AsyncSession, connection_id: str, req: RuleSetCreateRequest
) -> RuleSetResponse:
    if req.is_default:
        # Demote existing default
        await session.execute(
            update(AssignmentRuleSetORM)
            .where(AssignmentRuleSetORM.connection_id == connection_id)
            .values(is_default=False)
        )
    row = AssignmentRuleSetORM(
        connection_id=connection_id,
        name=req.name,
        description=req.description,
        is_default=req.is_default,
        layers_config=json.dumps(req.layers_config),
    )
    session.add(row)
    await session.flush()
    return _rule_set_to_response(row)


async def update_rule_set(
    session: AsyncSession, rule_set_id: str, req: RuleSetCreateRequest
) -> Optional[RuleSetResponse]:
    result = await session.execute(
        select(AssignmentRuleSetORM).where(AssignmentRuleSetORM.id == rule_set_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    if req.is_default and not row.is_default:
        await session.execute(
            update(AssignmentRuleSetORM)
            .where(AssignmentRuleSetORM.connection_id == row.connection_id)
            .values(is_default=False)
        )

    row.name = req.name
    row.description = req.description
    row.is_default = req.is_default
    row.layers_config = json.dumps(req.layers_config)
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _rule_set_to_response(row)


async def delete_rule_set(
    session: AsyncSession, rule_set_id: str
) -> bool:
    result = await session.execute(
        select(AssignmentRuleSetORM).where(AssignmentRuleSetORM.id == rule_set_id)
    )
    row = result.scalar_one_or_none()
    if row:
        await session.delete(row)
        return True
    return False


# ------------------------------------------------------------------ #
# Saved Views                                                          #
# ------------------------------------------------------------------ #

def _view_to_response(row: SavedViewORM) -> SavedViewResponse:
    return SavedViewResponse(
        id=row.id,
        connectionId=row.connection_id or row.workspace_id or "",
        name=row.name,
        description=row.description,
        viewType=ViewType(row.view_type),
        config=json.loads(row.config or "{}"),
        scopeFilter=json.loads(row.scope_filter) if row.scope_filter else None,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


async def list_views(
    session: AsyncSession, connection_id: str
) -> List[SavedViewResponse]:
    result = await session.execute(
        select(SavedViewORM)
        .where(SavedViewORM.connection_id == connection_id)
        .order_by(SavedViewORM.updated_at.desc())
    )
    return [_view_to_response(r) for r in result.scalars().all()]


async def get_view(
    session: AsyncSession, view_id: str
) -> Optional[SavedViewResponse]:
    result = await session.execute(
        select(SavedViewORM).where(SavedViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    return _view_to_response(row) if row else None


async def create_view(
    session: AsyncSession, connection_id: str, req: SavedViewCreateRequest
) -> SavedViewResponse:
    row = SavedViewORM(
        connection_id=connection_id,
        name=req.name,
        description=req.description,
        view_type=req.view_type.value,
        config=json.dumps(req.config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
    )
    session.add(row)
    await session.flush()
    return _view_to_response(row)


async def update_view(
    session: AsyncSession, view_id: str, req: SavedViewCreateRequest
) -> Optional[SavedViewResponse]:
    result = await session.execute(
        select(SavedViewORM).where(SavedViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    row.name = req.name
    row.description = req.description
    row.view_type = req.view_type.value
    row.config = json.dumps(req.config)
    row.scope_filter = json.dumps(req.scope_filter) if req.scope_filter else None
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _view_to_response(row)


async def delete_view(session: AsyncSession, view_id: str) -> bool:
    result = await session.execute(
        select(SavedViewORM).where(SavedViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if row:
        await session.delete(row)
        return True
    return False


# ------------------------------------------------------------------ #
# Workspace-scoped queries (new)                                       #
# ------------------------------------------------------------------ #

async def list_views_by_workspace(
    session: AsyncSession, workspace_id: str
) -> List[SavedViewResponse]:
    result = await session.execute(
        select(SavedViewORM)
        .where(SavedViewORM.workspace_id == workspace_id)
        .order_by(SavedViewORM.updated_at.desc())
    )
    return [_view_to_response(r) for r in result.scalars().all()]


async def create_view_for_workspace(
    session: AsyncSession, workspace_id: str, req: SavedViewCreateRequest
) -> SavedViewResponse:
    row = SavedViewORM(
        workspace_id=workspace_id,
        name=req.name,
        description=req.description,
        view_type=req.view_type.value,
        config=json.dumps(req.config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
    )
    session.add(row)
    await session.flush()
    return _view_to_response(row)


async def list_rule_sets_by_workspace(
    session: AsyncSession, workspace_id: str
) -> List[RuleSetResponse]:
    result = await session.execute(
        select(AssignmentRuleSetORM)
        .where(AssignmentRuleSetORM.workspace_id == workspace_id)
        .order_by(AssignmentRuleSetORM.created_at)
    )
    return [_rule_set_to_response(r) for r in result.scalars().all()]


async def create_rule_set_for_workspace(
    session: AsyncSession, workspace_id: str, req: RuleSetCreateRequest
) -> RuleSetResponse:
    if req.is_default:
        await session.execute(
            update(AssignmentRuleSetORM)
            .where(AssignmentRuleSetORM.workspace_id == workspace_id)
            .values(is_default=False)
        )
    row = AssignmentRuleSetORM(
        workspace_id=workspace_id,
        name=req.name,
        description=req.description,
        is_default=req.is_default,
        layers_config=json.dumps(req.layers_config),
    )
    session.add(row)
    await session.flush()
    return _rule_set_to_response(row)
