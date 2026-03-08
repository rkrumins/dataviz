"""
Context Model endpoints.

Workspace-scoped: CRUD for context models (how to organize graph into logical flows).
Admin: CRUD for reusable Quick Start Templates.
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import context_model_repo
from backend.common.models.management import (
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    ContextModelResponse,
    InstantiateTemplateRequest,
)

# ------------------------------------------------------------------ #
# Workspace-scoped router                                              #
# ------------------------------------------------------------------ #

router = APIRouter()


@router.get("", response_model=List[ContextModelResponse])
async def list_context_models(
    ws_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """List all context models for this workspace."""
    return await context_model_repo.list_context_models(session, workspace_id=ws_id)


@router.post("", response_model=ContextModelResponse, status_code=201)
async def create_context_model(
    ws_id: str = Path(...),
    req: ContextModelCreateRequest = Body(...),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    session: AsyncSession = Depends(get_db_session),
):
    """Create (Save Blueprint) a context model for this workspace."""
    return await context_model_repo.create_context_model(
        session, req, workspace_id=ws_id, data_source_id=data_source_id
    )


@router.get("/{context_model_id}", response_model=ContextModelResponse)
async def get_context_model(
    ws_id: str = Path(...),
    context_model_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single context model."""
    cm = await context_model_repo.get_context_model(session, context_model_id)
    if not cm:
        raise HTTPException(status_code=404, detail=f"Context model '{context_model_id}' not found")
    return cm


@router.put("/{context_model_id}", response_model=ContextModelResponse)
async def update_context_model(
    ws_id: str = Path(...),
    context_model_id: str = Path(...),
    req: ContextModelUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update (Save Blueprint) an existing context model."""
    cm = await context_model_repo.update_context_model(session, context_model_id, req)
    if not cm:
        raise HTTPException(status_code=404, detail=f"Context model '{context_model_id}' not found")
    return cm


@router.delete("/{context_model_id}", status_code=204)
async def delete_context_model(
    ws_id: str = Path(...),
    context_model_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a context model."""
    deleted = await context_model_repo.delete_context_model(session, context_model_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Context model '{context_model_id}' not found")


@router.post("/instantiate", response_model=ContextModelResponse, status_code=201)
async def instantiate_template(
    ws_id: str = Path(...),
    req: InstantiateTemplateRequest = Body(...),
    data_source_id: Optional[str] = Query(None, alias="dataSourceId"),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a workspace context model from a Quick Start Template."""
    cm = await context_model_repo.instantiate_template(
        session, req.template_id, ws_id, req.name, data_source_id=data_source_id
    )
    if not cm:
        raise HTTPException(status_code=404, detail=f"Template '{req.template_id}' not found")
    return cm


# ------------------------------------------------------------------ #
# Admin template router                                                #
# ------------------------------------------------------------------ #

template_router = APIRouter()


@template_router.get("", response_model=List[ContextModelResponse])
async def list_templates(
    category: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db_session),
):
    """List all Quick Start Templates."""
    models = await context_model_repo.list_context_models(session, templates_only=True)
    if category:
        models = [m for m in models if m.category == category]
    return models


@template_router.post("", response_model=ContextModelResponse, status_code=201)
async def create_template(
    req: ContextModelCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new Quick Start Template (global, no workspace)."""
    req.is_template = True
    return await context_model_repo.create_context_model(session, req)


@template_router.get("/{template_id}", response_model=ContextModelResponse)
async def get_template(
    template_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single template."""
    cm = await context_model_repo.get_context_model(session, template_id)
    if not cm or not cm.is_template:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return cm


@template_router.put("/{template_id}", response_model=ContextModelResponse)
async def update_template(
    template_id: str = Path(...),
    req: ContextModelUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a template."""
    cm = await context_model_repo.update_context_model(session, template_id, req)
    if not cm:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return cm


@template_router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a template."""
    deleted = await context_model_repo.delete_context_model(session, template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")


# ------------------------------------------------------------------ #
# Top-level view router (cross-workspace, first-class views)           #
# Mounted at /api/v1/views                                             #
# ------------------------------------------------------------------ #

view_router = APIRouter()

# Placeholder user_id until RBAC is integrated.
_PLACEHOLDER_USER = "anonymous"


@view_router.get("/popular", response_model=List[ContextModelResponse])
async def list_popular_views(
    limit: int = Query(20, le=100),
    session: AsyncSession = Depends(get_db_session),
):
    """List the most-favourited enterprise-visible views."""
    return await context_model_repo.list_popular_views(
        session, limit=limit, user_id=_PLACEHOLDER_USER,
    )


@view_router.get("/", response_model=List[ContextModelResponse])
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
    return await context_model_repo.list_views_filtered(
        session,
        visibility=visibility,
        workspace_id=workspace_id,
        search=search,
        tags=tags,
        limit=limit,
        offset=offset,
        user_id=_PLACEHOLDER_USER,
    )


@view_router.post("/", response_model=ContextModelResponse, status_code=201)
async def create_view(
    req: ContextModelCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new view. workspace_id must be provided in the request body."""
    if not req.workspace_id:
        raise HTTPException(
            status_code=422,
            detail="workspaceId is required when creating a view via /views",
        )
    return await context_model_repo.create_context_model(session, req)


@view_router.get("/{view_id}", response_model=ContextModelResponse)
async def get_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single view by ID, enriched with workspace context and favourite data."""
    view = await context_model_repo.get_view_enriched(
        session, view_id, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@view_router.put("/{view_id}", response_model=ContextModelResponse)
async def update_view(
    view_id: str,
    req: ContextModelUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update an existing view."""
    view = await context_model_repo.update_context_model(session, view_id, req)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@view_router.delete("/{view_id}", status_code=204)
async def delete_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a view."""
    deleted = await context_model_repo.delete_context_model(session, view_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")


@view_router.put("/{view_id}/visibility", response_model=ContextModelResponse)
async def update_view_visibility(
    view_id: str,
    visibility: str = Body(..., embed=True),
    session: AsyncSession = Depends(get_db_session),
):
    """Change the visibility of a view (private | workspace | enterprise)."""
    if visibility not in ("private", "workspace", "enterprise"):
        raise HTTPException(status_code=422, detail="visibility must be one of: private, workspace, enterprise")
    view = await context_model_repo.update_visibility(
        session, view_id, visibility, user_id=_PLACEHOLDER_USER,
    )
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    return view


@view_router.post("/{view_id}/favourite", status_code=201)
async def favourite_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Favourite a view for the current user."""
    view = await context_model_repo.get_context_model(session, view_id)
    if not view:
        raise HTTPException(status_code=404, detail=f"View '{view_id}' not found")
    created = await context_model_repo.favourite_view(session, view_id, _PLACEHOLDER_USER)
    return {"favourited": True, "created": created}


@view_router.delete("/{view_id}/favourite", status_code=204)
async def unfavourite_view(
    view_id: str,
    session: AsyncSession = Depends(get_db_session),
):
    """Remove favourite for the current user."""
    removed = await context_model_repo.unfavourite_view(session, view_id, _PLACEHOLDER_USER)
    if not removed:
        raise HTTPException(status_code=404, detail="Favourite not found")
