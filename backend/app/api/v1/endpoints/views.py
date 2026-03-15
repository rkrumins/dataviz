"""
View endpoints (top-level, cross-workspace).

Views are visual renderings of context models (or ad-hoc graphs).
Mounted at /api/v1/views
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import view_repo
from backend.common.models.management import (
    ViewCreateRequest,
    ViewUpdateRequest,
    ViewResponse,
)

router = APIRouter()

# Placeholder user_id until RBAC is integrated.
_PLACEHOLDER_USER = "anonymous"


@router.get("/popular", response_model=List[ViewResponse])
async def list_popular_views(
    limit: int = Query(20, le=100),
    session: AsyncSession = Depends(get_db_session),
):
    """List the most-favourited enterprise-visible views."""
    return await view_repo.list_popular_views(
        session, limit=limit, user_id=_PLACEHOLDER_USER,
    )


@router.get("/", response_model=List[ViewResponse])
async def list_views(
    visibility: Optional[str] = Query(None),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    context_model_id: Optional[str] = Query(None, alias="contextModelId"),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    favourited_only: bool = Query(False, alias="favouritedOnly"),
    session: AsyncSession = Depends(get_db_session),
):
    """List accessible views with optional filtering."""
    return await view_repo.list_views_filtered(
        session,
        visibility=visibility,
        workspace_id=workspace_id,
        context_model_id=context_model_id,
        data_source_id=data_source_id,
        search=search,
        tags=tags,
        limit=limit,
        offset=offset,
        user_id=_PLACEHOLDER_USER,
        favourited_only=favourited_only,
    )


@router.post("/", response_model=ViewResponse, status_code=201)
async def create_view(
    req: ViewCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new view. workspaceId is required."""
    return await view_repo.create_view(session, req)


@router.get("/{view_id}", response_model=ViewResponse)
async def get_view(
    view_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single view by ID, enriched with workspace context and favourite data."""
    view = await view_repo.get_view_enriched(
        session, view_id, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.put("/{view_id}", response_model=ViewResponse)
async def update_view(
    view_id: str = Path(...),
    req: ViewUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an existing view."""
    view = await view_repo.update_view(session, view_id, req)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.delete("/{view_id}", status_code=204)
async def delete_view(
    view_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a view."""
    deleted = await view_repo.delete_view(session, view_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")


@router.put("/{view_id}/visibility", response_model=ViewResponse)
async def update_view_visibility(
    view_id: str = Path(...),
    visibility: str = Body(..., embed=True),
    session: AsyncSession = Depends(get_db_session),
):
    """Change the visibility of a view (private | workspace | enterprise)."""
    if visibility not in ("private", "workspace", "enterprise"):
        raise HTTPException(status_code=422, detail="visibility must be one of: private, workspace, enterprise")
    view = await view_repo.update_visibility(
        session, view_id, visibility, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.post("/{view_id}/favourite", status_code=201)
async def favourite_view(
    view_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Favourite a view for the current user."""
    view = await view_repo.get_view(session, view_id)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    created = await view_repo.favourite_view(session, view_id, _PLACEHOLDER_USER)
    return {"favourited": True, "created": created}


@router.delete("/{view_id}/favourite", status_code=204)
async def unfavourite_view(
    view_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove favourite for the current user."""
    removed = await view_repo.unfavourite_view(session, view_id, _PLACEHOLDER_USER)
    if not removed:
        raise HTTPException(status_code=404, detail="Favourite not found")
