"""
Repository for views table.
Views define how to visually render context models (or ad-hoc graphs).
Supports CRUD, filtering, favourites, and enterprise discovery.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ViewORM, ViewFavouriteORM, WorkspaceORM, ContextModelORM, WorkspaceDataSourceORM
from backend.common.models.management import (
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# Helpers                                                              #
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


async def _get_context_model_name(
    session: AsyncSession, context_model_id: Optional[str]
) -> Optional[str]:
    if not context_model_id:
        return None
    result = await session.execute(
        select(ContextModelORM.name).where(ContextModelORM.id == context_model_id)
    )
    return result.scalar_one_or_none()


async def _get_data_source_name(
    session: AsyncSession, data_source_id: Optional[str]
) -> Optional[str]:
    if not data_source_id:
        return None
    result = await session.execute(
        select(WorkspaceDataSourceORM.label).where(WorkspaceDataSourceORM.id == data_source_id)
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


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(
    row: ViewORM,
    *,
    workspace_name: Optional[str] = None,
    data_source_name: Optional[str] = None,
    context_model_name: Optional[str] = None,
    favourite_count: int = 0,
    is_favourited: bool = False,
) -> ViewResponse:
    return ViewResponse(
        id=row.id,
        name=row.name,
        description=row.description,
        contextModelId=row.context_model_id,
        contextModelName=context_model_name,
        workspaceId=row.workspace_id,
        workspaceName=workspace_name,
        dataSourceId=row.data_source_id,
        dataSourceName=data_source_name,
        viewType=row.view_type or "graph",
        config=json.loads(row.config or "{}"),
        visibility=row.visibility or "private",
        createdBy=row.created_by,
        tags=json.loads(row.tags) if row.tags else None,
        isPinned=bool(row.is_pinned) if row.is_pinned else False,
        favouriteCount=favourite_count,
        isFavourited=is_favourited,
        createdAt=row.created_at,
        updatedAt=row.updated_at,
        deletedAt=getattr(row, 'deleted_at', None),
    )


async def _to_enriched_response(
    session: AsyncSession,
    row: ViewORM,
    user_id: Optional[str] = None,
) -> ViewResponse:
    """Build a ViewResponse enriched with workspace name, data source name, CM name, and favourite info."""
    ws_name = await _get_workspace_name(session, row.workspace_id)
    ds_name = await _get_data_source_name(session, row.data_source_id)
    cm_name = await _get_context_model_name(session, row.context_model_id)
    fav_count = await _get_favourite_count(session, row.id)
    fav = await _is_favourited(session, row.id, user_id)
    return _to_response(
        row,
        workspace_name=ws_name,
        data_source_name=ds_name,
        context_model_name=cm_name,
        favourite_count=fav_count,
        is_favourited=fav,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def create_view(
    session: AsyncSession,
    req: ViewCreateRequest,
) -> ViewResponse:
    logger.info(
        "create_view: name=%s workspace_id=%s data_source_id=%s",
        req.name, req.workspace_id, req.data_source_id,
    )
    row = ViewORM(
        name=req.name,
        description=req.description,
        context_model_id=req.context_model_id,
        workspace_id=req.workspace_id,
        data_source_id=req.data_source_id,
        view_type=req.view_type or "graph",
        config=json.dumps(req.config) if req.config else "{}",
        visibility=req.visibility or "private",
        tags=json.dumps(req.tags) if req.tags else None,
        is_pinned=req.is_pinned,
    )
    session.add(row)
    await session.flush()
    return await _to_enriched_response(session, row)


async def get_view(
    session: AsyncSession, view_id: str
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return await _to_enriched_response(session, row)


async def get_view_enriched(
    session: AsyncSession, view_id: str, user_id: Optional[str] = None
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    return await _to_enriched_response(session, row, user_id)


async def update_view(
    session: AsyncSession,
    view_id: str,
    req: ViewUpdateRequest,
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
    )
    row = result.scalar_one_or_none()
    if not row:
        return None

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
    if req.context_model_id is not None:
        row.context_model_id = req.context_model_id
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
    return await _to_enriched_response(session, row)


async def delete_view(
    session: AsyncSession, view_id: str
) -> bool:
    """Soft-delete a view by setting deleted_at timestamp."""
    now = datetime.now(timezone.utc).isoformat()
    result = await session.execute(
        update(ViewORM)
        .where(ViewORM.id == view_id, ViewORM.deleted_at.is_(None))
        .values(deleted_at=now)
    )
    return result.rowcount > 0


async def restore_view(
    session: AsyncSession, view_id: str
) -> bool:
    """Restore a soft-deleted view by clearing deleted_at."""
    result = await session.execute(
        update(ViewORM)
        .where(ViewORM.id == view_id, ViewORM.deleted_at.isnot(None))
        .values(deleted_at=None)
    )
    return result.rowcount > 0


async def permanently_delete_view(
    session: AsyncSession, view_id: str
) -> bool:
    """Hard-delete a view from the database (irreversible)."""
    result = await session.execute(
        delete(ViewORM).where(ViewORM.id == view_id)
    )
    return result.rowcount > 0


# ------------------------------------------------------------------ #
# Filtered listing & discovery                                         #
# ------------------------------------------------------------------ #

async def list_views_filtered(
    session: AsyncSession,
    *,
    visibility: Optional[str] = None,
    workspace_id: Optional[str] = None,
    context_model_id: Optional[str] = None,
    data_source_id: Optional[str] = None,
    search: Optional[str] = None,
    tags: Optional[List[str]] = None,
    limit: int = 50,
    offset: int = 0,
    user_id: Optional[str] = None,
    favourited_only: bool = False,
    include_deleted: bool = False,
    deleted_only: bool = False,
) -> List[ViewResponse]:
    query = select(ViewORM)

    # Soft-delete filtering
    if deleted_only:
        query = query.where(ViewORM.deleted_at.isnot(None))
    elif not include_deleted:
        query = query.where(ViewORM.deleted_at.is_(None))

    # When favourited_only is True, inner-join on the favourites table so only
    # views the requesting user has bookmarked are returned.
    if favourited_only and user_id:
        query = query.join(
            ViewFavouriteORM,
            (ViewFavouriteORM.view_id == ViewORM.id) &
            (ViewFavouriteORM.user_id == user_id),
        )

    if workspace_id:
        query = query.where(ViewORM.workspace_id == workspace_id)
    if context_model_id:
        query = query.where(ViewORM.context_model_id == context_model_id)
    if data_source_id:
        query = query.where(ViewORM.data_source_id == data_source_id)
    if visibility:
        query = query.where(ViewORM.visibility == visibility)
    if search:
        pattern = f"%{search}%"
        query = query.where(
            ViewORM.name.ilike(pattern) | ViewORM.description.ilike(pattern)
        )

    query = query.order_by(ViewORM.updated_at.desc()).limit(limit).offset(offset)
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
) -> List[ViewResponse]:
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
        select(ViewORM, fav_count_sq.c.fav_count)
        .outerjoin(fav_count_sq, ViewORM.id == fav_count_sq.c.view_id)
        .where(ViewORM.visibility == "enterprise")
        .where(ViewORM.deleted_at.is_(None))
        .order_by(func.coalesce(fav_count_sq.c.fav_count, 0).desc())
        .limit(limit)
    )

    result = await session.execute(query)
    responses = []
    for row_tuple in result.all():
        row = row_tuple[0]
        fav_count = row_tuple[1] or 0
        ws_name = await _get_workspace_name(session, row.workspace_id)
        ds_name = await _get_data_source_name(session, row.data_source_id)
        cm_name = await _get_context_model_name(session, row.context_model_id)
        is_fav = await _is_favourited(session, row.id, user_id)
        responses.append(_to_response(
            row,
            workspace_name=ws_name,
            data_source_name=ds_name,
            context_model_name=cm_name,
            favourite_count=fav_count,
            is_favourited=is_fav,
        ))
    return responses


async def list_views_for_context_model(
    session: AsyncSession,
    context_model_id: str,
    user_id: Optional[str] = None,
) -> List[ViewResponse]:
    """Find all views referencing a given context model."""
    query = (
        select(ViewORM)
        .where(ViewORM.context_model_id == context_model_id)
        .where(ViewORM.deleted_at.is_(None))
        .order_by(ViewORM.updated_at.desc())
    )
    result = await session.execute(query)
    rows = result.scalars().all()
    return [await _to_enriched_response(session, row, user_id) for row in rows]


async def update_visibility(
    session: AsyncSession, view_id: str, visibility: str,
    user_id: Optional[str] = None,
) -> Optional[ViewResponse]:
    result = await session.execute(
        select(ViewORM).where(ViewORM.id == view_id)
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
