"""
Repository for assignment_rule_sets and saved_views tables.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from sqlalchemy import func, delete as sa_delete
from sqlalchemy.orm import selectinload

from ..models import AssignmentRuleSetORM, SavedViewORM, ViewFavouriteORM, WorkspaceORM
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

def _view_to_response(
    row: SavedViewORM,
    *,
    workspace_name: Optional[str] = None,
    favourite_count: int = 0,
    is_favourited: bool = False,
) -> SavedViewResponse:
    return SavedViewResponse(
        id=row.id,
        workspaceId=row.workspace_id,
        workspaceName=workspace_name,
        dataSourceId=row.data_source_id,
        connectionId=row.connection_id or row.workspace_id or "",
        name=row.name,
        description=row.description,
        viewType=ViewType(row.view_type),
        config=json.loads(row.config or "{}"),
        scopeFilter=json.loads(row.scope_filter) if row.scope_filter else None,
        visibility=row.visibility or "private",
        createdBy=row.created_by,
        tags=json.loads(row.tags) if row.tags else None,
        isPinned=bool(row.is_pinned),
        favouriteCount=favourite_count,
        isFavourited=is_favourited,
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
        data_source_id=req.data_source_id if hasattr(req, "data_source_id") and req.data_source_id else None,
        name=req.name,
        description=req.description,
        view_type=req.view_type.value,
        config=json.dumps(req.config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
        visibility=req.visibility if hasattr(req, "visibility") else "private",
        tags=json.dumps(req.tags) if hasattr(req, "tags") and req.tags else None,
        is_pinned=req.is_pinned if hasattr(req, "is_pinned") else False,
    )
    session.add(row)
    await session.flush()
    # Fetch workspace name for response
    ws_name = await _get_workspace_name(session, workspace_id)
    return _view_to_response(row, workspace_name=ws_name)


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


# ------------------------------------------------------------------ #
# Views — helpers                                                      #
# ------------------------------------------------------------------ #

async def _get_workspace_name(
    session: AsyncSession, workspace_id: Optional[str]
) -> Optional[str]:
    if not workspace_id:
        return None
    result = await session.execute(
        select(WorkspaceORM.name).where(WorkspaceORM.id == workspace_id)
    )
    return result.scalar_one_or_none()


async def _get_favourite_count(
    session: AsyncSession, view_id: str
) -> int:
    result = await session.execute(
        select(func.count()).where(ViewFavouriteORM.view_id == view_id)
    )
    return result.scalar() or 0


async def _is_favourited(
    session: AsyncSession, view_id: str, user_id: Optional[str]
) -> bool:
    if not user_id:
        return False
    result = await session.execute(
        select(ViewFavouriteORM.id).where(
            ViewFavouriteORM.view_id == view_id,
            ViewFavouriteORM.user_id == user_id,
        )
    )
    return result.scalar_one_or_none() is not None


async def _enrich_view_response(
    session: AsyncSession,
    row: SavedViewORM,
    user_id: Optional[str] = None,
) -> SavedViewResponse:
    """Build a full SavedViewResponse with workspace name and favourite info."""
    ws_name = await _get_workspace_name(session, row.workspace_id)
    fav_count = await _get_favourite_count(session, row.id)
    fav = await _is_favourited(session, row.id, user_id)
    return _view_to_response(
        row,
        workspace_name=ws_name,
        favourite_count=fav_count,
        is_favourited=fav,
    )


# ------------------------------------------------------------------ #
# Views — top-level queries (first-class views service)                #
# ------------------------------------------------------------------ #

async def get_view_enriched(
    session: AsyncSession, view_id: str, user_id: Optional[str] = None
) -> Optional[SavedViewResponse]:
    """Get a single view with workspace name and favourite data."""
    result = await session.execute(
        select(SavedViewORM).where(SavedViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return await _enrich_view_response(session, row, user_id)


async def list_views_filtered(
    session: AsyncSession,
    *,
    visibility: Optional[str] = None,
    workspace_id: Optional[str] = None,
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    limit: int = 50,
    offset: int = 0,
    user_id: Optional[str] = None,
) -> List[SavedViewResponse]:
    """List views with filtering, search, and enrichment."""
    query = select(SavedViewORM)

    if workspace_id:
        query = query.where(SavedViewORM.workspace_id == workspace_id)
    if visibility:
        query = query.where(SavedViewORM.visibility == visibility)
    if search:
        pattern = f"%{search}%"
        query = query.where(
            SavedViewORM.name.ilike(pattern)
            | SavedViewORM.description.ilike(pattern)
        )

    query = query.order_by(SavedViewORM.updated_at.desc()).limit(limit).offset(offset)
    result = await session.execute(query)
    rows = result.scalars().all()

    responses = []
    for row in rows:
        resp = await _enrich_view_response(session, row, user_id)
        # Filter by tags in-memory (JSON stored as TEXT)
        if tags and resp.tags:
            if not any(t in resp.tags for t in tags):
                continue
        elif tags and not resp.tags:
            continue
        responses.append(resp)
    return responses


async def create_view_top_level(
    session: AsyncSession, req: SavedViewCreateRequest
) -> SavedViewResponse:
    """Create a view via top-level /views endpoint (workspace_id in body)."""
    row = SavedViewORM(
        workspace_id=req.workspace_id,
        data_source_id=req.data_source_id,
        name=req.name,
        description=req.description,
        view_type=req.view_type.value,
        config=json.dumps(req.config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
        visibility=req.visibility,
        tags=json.dumps(req.tags) if req.tags else None,
        is_pinned=req.is_pinned,
    )
    session.add(row)
    await session.flush()
    ws_name = await _get_workspace_name(session, req.workspace_id)
    return _view_to_response(row, workspace_name=ws_name)


async def update_view_full(
    session: AsyncSession, view_id: str, req: SavedViewCreateRequest,
    user_id: Optional[str] = None,
) -> Optional[SavedViewResponse]:
    """Update a view with all fields including new sharing fields."""
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
    row.visibility = req.visibility if hasattr(req, "visibility") else row.visibility
    row.tags = json.dumps(req.tags) if hasattr(req, "tags") and req.tags else row.tags
    row.is_pinned = req.is_pinned if hasattr(req, "is_pinned") else row.is_pinned
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return await _enrich_view_response(session, row, user_id)


async def update_view_visibility(
    session: AsyncSession, view_id: str, visibility: str,
    user_id: Optional[str] = None,
) -> Optional[SavedViewResponse]:
    """Change only the visibility of a view."""
    result = await session.execute(
        select(SavedViewORM).where(SavedViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    row.visibility = visibility
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return await _enrich_view_response(session, row, user_id)


# ------------------------------------------------------------------ #
# Favourites                                                           #
# ------------------------------------------------------------------ #

async def favourite_view(
    session: AsyncSession, view_id: str, user_id: str
) -> bool:
    """Add a favourite. Returns True if created, False if already exists."""
    existing = await session.execute(
        select(ViewFavouriteORM.id).where(
            ViewFavouriteORM.view_id == view_id,
            ViewFavouriteORM.user_id == user_id,
        )
    )
    if existing.scalar_one_or_none():
        return False
    fav = ViewFavouriteORM(view_id=view_id, user_id=user_id)
    session.add(fav)
    await session.flush()
    return True


async def unfavourite_view(
    session: AsyncSession, view_id: str, user_id: str
) -> bool:
    """Remove a favourite. Returns True if deleted."""
    result = await session.execute(
        select(ViewFavouriteORM).where(
            ViewFavouriteORM.view_id == view_id,
            ViewFavouriteORM.user_id == user_id,
        )
    )
    row = result.scalar_one_or_none()
    if row:
        await session.delete(row)
        return True
    return False


async def list_popular_views(
    session: AsyncSession,
    *,
    limit: int = 20,
    user_id: Optional[str] = None,
) -> List[SavedViewResponse]:
    """List views sorted by favourite count (enterprise-visible only)."""
    # Subquery for favourite counts
    fav_count_sq = (
        select(
            ViewFavouriteORM.view_id,
            func.count().label("fav_count"),
        )
        .group_by(ViewFavouriteORM.view_id)
        .subquery()
    )

    query = (
        select(SavedViewORM, fav_count_sq.c.fav_count)
        .outerjoin(fav_count_sq, SavedViewORM.id == fav_count_sq.c.view_id)
        .where(SavedViewORM.visibility == "enterprise")
        .order_by(func.coalesce(fav_count_sq.c.fav_count, 0).desc())
        .limit(limit)
    )

    result = await session.execute(query)
    responses = []
    for row_tuple in result.all():
        view_row = row_tuple[0]
        fav_count = row_tuple[1] or 0
        ws_name = await _get_workspace_name(session, view_row.workspace_id)
        fav = await _is_favourited(session, view_row.id, user_id)
        responses.append(
            _view_to_response(
                view_row,
                workspace_name=ws_name,
                favourite_count=fav_count,
                is_favourited=fav,
            )
        )
    return responses
