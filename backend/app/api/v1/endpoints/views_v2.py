"""
Top-level views endpoints: first-class view CRUD, sharing, and favourites.
Mounted at /api/v1/views
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import assignment_repo
from backend.common.models.management import (
    SavedViewCreateRequest,
    SavedViewResponse,
)

router = APIRouter()

# Placeholder user_id until RBAC is integrated.
# In production this comes from auth middleware / JWT.
_PLACEHOLDER_USER = "anonymous"


# ------------------------------------------------------------------ #
# List / Search                                                        #
# ------------------------------------------------------------------ #

@router.get("/popular", response_model=List[SavedViewResponse])
async def list_popular_views(
    limit: int = Query(20, le=100),
    session: AsyncSession = Depends(get_db_session),
):
    """List the most-favourited enterprise-visible views."""
    return await assignment_repo.list_popular_views(
        session, limit=limit, user_id=_PLACEHOLDER_USER,
    )


@router.get("/", response_model=List[SavedViewResponse])
async def list_views(
    visibility: Optional[str] = Query(None),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    search: Optional[str] = Query(None),
    tags: Optional[List[str]] = Query(None),
    limit: int = Query(50, le=200),
    offset: int = Query(0),
    session: AsyncSession = Depends(get_db_session),
):
    """List accessible views with optional filtering."""
    return await assignment_repo.list_views_filtered(
        session,
        visibility=visibility,
        workspace_id=workspace_id,
        search=search,
        tags=tags,
        limit=limit,
        offset=offset,
        user_id=_PLACEHOLDER_USER,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

@router.post("/", response_model=SavedViewResponse, status_code=201)
async def create_view(
    req: SavedViewCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new view. workspace_id must be provided in the request body."""
    if not req.workspace_id:
        raise HTTPException(
            status_code=422,
            detail="workspaceId is required when creating a view via /views",
        )
    return await assignment_repo.create_view_top_level(session, req)


@router.get("/{view_id}", response_model=SavedViewResponse)
async def get_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single view by ID, enriched with workspace context and favourite data."""
    view = await assignment_repo.get_view_enriched(
        session, view_id, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.put("/{view_id}", response_model=SavedViewResponse)
async def update_view(
    view_id: str,
    req: SavedViewCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an existing view."""
    view = await assignment_repo.update_view_full(
        session, view_id, req, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@router.delete("/{view_id}", status_code=204)
async def delete_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a view."""
    deleted = await assignment_repo.delete_view(session, view_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")


# ------------------------------------------------------------------ #
# Visibility                                                           #
# ------------------------------------------------------------------ #

@router.put("/{view_id}/visibility", response_model=SavedViewResponse)
async def update_visibility(
    view_id: str,
    visibility: str = Body(..., embed=True),
    session: AsyncSession = Depends(get_db_session),
):
    """Change the visibility of a view (private | workspace | enterprise)."""
    if visibility not in ("private", "workspace", "enterprise"):
        raise HTTPException(status_code=422, detail="visibility must be one of: private, workspace, enterprise")
    view = await assignment_repo.update_view_visibility(
        session, view_id, visibility, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


# ------------------------------------------------------------------ #
# Favourites                                                           #
# ------------------------------------------------------------------ #

@router.post("/{view_id}/favourite", status_code=201)
async def favourite_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Favourite a view for the current user."""
    # Verify view exists
    view = await assignment_repo.get_view(session, view_id)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    created = await assignment_repo.favourite_view(session, view_id, _PLACEHOLDER_USER)
    return {"favourited": True, "created": created}


@router.delete("/{view_id}/favourite", status_code=204)
async def unfavourite_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Remove favourite for the current user."""
    removed = await assignment_repo.unfavourite_view(session, view_id, _PLACEHOLDER_USER)
    if not removed:
        raise HTTPException(status_code=404, detail="Favourite not found")
