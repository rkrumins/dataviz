"""
Repository for context_models table.
Context models define how to organize graph nodes into logical business flows.
Templates (is_template=True) are reusable starting points; instances are workspace-scoped.
Also serves as the single view persistence layer (sharing, favourites, discovery).
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ContextModelORM, ViewFavouriteORM, WorkspaceORM
from backend.common.models.management import (
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    ContextModelResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(
    row: ContextModelORM,
    *,
    workspace_name: Optional[str] = None,
    favourite_count: int = 0,
    is_favourited: bool = False,
) -> ContextModelResponse:
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
        # View metadata
        viewType=row.view_type,
        config=json.loads(row.config) if row.config else None,
        visibility=row.visibility or "private",
        createdBy=row.created_by,
        tags=json.loads(row.tags) if row.tags else None,
        isPinned=bool(row.is_pinned) if row.is_pinned else False,
        favouriteCount=favourite_count,
        isFavourited=is_favourited,
        workspaceName=workspace_name,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# View enrichment helpers                                              #
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


async def _to_enriched_response(
    session: AsyncSession,
    row: ContextModelORM,
    user_id: Optional[str] = None,
) -> ContextModelResponse:
    """Build a ContextModelResponse enriched with workspace name and favourite info."""
    ws_name = await _get_workspace_name(session, row.workspace_id)
    fav_count = await _get_favourite_count(session, row.id)
    fav = await _is_favourited(session, row.id, user_id)
    return _to_response(
        row,
        workspace_name=ws_name,
        favourite_count=fav_count,
        is_favourited=fav,
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
        workspace_id=workspace_id or req.workspace_id,
        data_source_id=data_source_id,
        is_template=req.is_template,
        category=req.category,
        layers_config=json.dumps(req.layers_config),
        scope_filter=json.dumps(req.scope_filter) if req.scope_filter else None,
        instance_assignments=json.dumps(req.instance_assignments),
        scope_edge_config=json.dumps(req.scope_edge_config) if req.scope_edge_config else None,
        # View metadata
        view_type=req.view_type,
        config=json.dumps(req.config) if req.config else None,
        visibility=req.visibility or "private",
        tags=json.dumps(req.tags) if req.tags else None,
        is_pinned=req.is_pinned,
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
    # View metadata
    if req.view_type is not None:
        row.view_type = req.view_type
    if req.config is not None:
        row.config = json.dumps(req.config)
    if req.visibility is not None:
        row.visibility = req.visibility
    if req.tags is not None:
        row.tags = json.dumps(req.tags)
    if req.is_pinned is not None:
        row.is_pinned = req.is_pinned

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


# ------------------------------------------------------------------ #
# View queries (top-level, cross-workspace)                            #
# ------------------------------------------------------------------ #

async def get_view_enriched(
    session: AsyncSession, view_id: str, user_id: Optional[str] = None
) -> Optional[ContextModelResponse]:
    """Get a single view with workspace name and favourite data."""
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return await _to_enriched_response(session, row, user_id)


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
) -> List[ContextModelResponse]:
    """List views with filtering, search, and enrichment."""
    query = select(ContextModelORM).where(ContextModelORM.is_template == False)

    if workspace_id:
        query = query.where(ContextModelORM.workspace_id == workspace_id)
    if visibility:
        query = query.where(ContextModelORM.visibility == visibility)
    if search:
        pattern = f"%{search}%"
        query = query.where(
            ContextModelORM.name.ilike(pattern)
            | ContextModelORM.description.ilike(pattern)
        )

    query = query.order_by(ContextModelORM.updated_at.desc()).limit(limit).offset(offset)
    result = await session.execute(query)
    rows = result.scalars().all()

    responses = []
    for row in rows:
        resp = await _to_enriched_response(session, row, user_id)
        # Filter by tags in-memory (JSON stored as TEXT)
        if tags and resp.tags:
            if not any(t in resp.tags for t in tags):
                continue
        elif tags and not resp.tags:
            continue
        responses.append(resp)
    return responses


async def list_popular_views(
    session: AsyncSession,
    *,
    limit: int = 20,
    user_id: Optional[str] = None,
) -> List[ContextModelResponse]:
    """List views sorted by favourite count (enterprise-visible only)."""
    fav_count_sq = (
        select(
            ViewFavouriteORM.view_id,
            func.count().label("fav_count"),
        )
        .group_by(ViewFavouriteORM.view_id)
        .subquery()
    )

    query = (
        select(ContextModelORM, fav_count_sq.c.fav_count)
        .outerjoin(fav_count_sq, ContextModelORM.id == fav_count_sq.c.view_id)
        .where(
            ContextModelORM.visibility == "enterprise",
            ContextModelORM.is_template == False,
        )
        .order_by(func.coalesce(fav_count_sq.c.fav_count, 0).desc())
        .limit(limit)
    )

    result = await session.execute(query)
    responses = []
    for row_tuple in result.all():
        row = row_tuple[0]
        fav_count = row_tuple[1] or 0
        ws_name = await _get_workspace_name(session, row.workspace_id)
        is_fav = await _is_favourited(session, row.id, user_id)
        responses.append(_to_response(
            row,
            workspace_name=ws_name,
            favourite_count=fav_count,
            is_favourited=is_fav,
        ))
    return responses


async def update_visibility(
    session: AsyncSession, view_id: str, visibility: str,
    user_id: Optional[str] = None,
) -> Optional[ContextModelResponse]:
    """Change only the visibility of a view."""
    result = await session.execute(
        select(ContextModelORM).where(ContextModelORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    row.visibility = visibility
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return await _to_enriched_response(session, row, user_id)


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
