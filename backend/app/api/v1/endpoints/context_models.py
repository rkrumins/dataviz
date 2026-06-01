"""
Context Model endpoints.

Two routers exported:

  * ``router``           — workspace-scoped CRUD mounted at
                           ``/api/v1/{ws_id}/context-models``.
  * ``template_router``  — template CRUD mounted at
                           ``/api/v1/context-model-templates``. Supports both
                           global templates (``workspaceId`` null) and
                           workspace-scoped templates in the same surface.

The legacy ``/admin/context-model-templates`` mount is kept as an alias for
backward compatibility with the dashboard's existing ``listTemplates`` call.
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import context_model_repo, view_repo
from backend.common.models.management import (
    ContextModelCreateRequest,
    ContextModelUpdateRequest,
    ContextModelResponse,
    InstantiateTemplateRequest,
    TemplateDuplicateRequest,
    TemplateImportRequest,
    TemplateUsageStats,
    ViewResponse,
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
# Template router (workspace + global)                                 #
# ------------------------------------------------------------------ #

template_router = APIRouter()


@template_router.get("", response_model=List[ContextModelResponse])
async def list_templates(
    scope: str = Query("all", pattern="^(all|global|workspace)$"),
    workspace_id: Optional[str] = Query(None, alias="workspaceId"),
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    sort: str = Query("recent", pattern="^(popular|recent|name)$"),
    include_deleted: bool = Query(False, alias="includeDeleted"),
    session: AsyncSession = Depends(get_db_session),
):
    """List templates with rich filtering for the gallery UI."""
    return await context_model_repo.list_templates(
        session,
        scope=scope,  # type: ignore[arg-type]
        workspace_id=workspace_id,
        category=category,
        tag=tag,
        search=search,
        sort=sort,  # type: ignore[arg-type]
        include_deleted=include_deleted,
    )


@template_router.post("", response_model=ContextModelResponse, status_code=201)
async def create_template(
    req: ContextModelCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new template. ``workspaceId`` null = global template."""
    req.is_template = True
    return await context_model_repo.create_context_model(
        session, req, workspace_id=req.workspace_id,
    )


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
    """Update a template's metadata and/or configuration."""
    existing = await context_model_repo.get_context_model(session, template_id)
    if not existing or not existing.is_template:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    cm = await context_model_repo.update_context_model(session, template_id, req)
    if not cm:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return cm


@template_router.delete("/{template_id}", status_code=204)
async def delete_template(
    template_id: str = Path(...),
    permanent: bool = Query(False),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a template (soft by default; ``?permanent=true`` removes the row)."""
    if permanent:
        deleted = await context_model_repo.delete_context_model(session, template_id)
    else:
        deleted = await context_model_repo.soft_delete_context_model(session, template_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")


@template_router.post(
    "/{template_id}/duplicate",
    response_model=ContextModelResponse,
    status_code=201,
)
async def duplicate_template(
    template_id: str = Path(...),
    req: TemplateDuplicateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Clone a template into a new template (workspace-scoped or global)."""
    cm = await context_model_repo.duplicate_template(
        session, template_id, req.name, workspace_id=req.workspace_id,
    )
    if not cm:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return cm


@template_router.post("/import", response_model=ContextModelResponse, status_code=201)
async def import_template(
    req: TemplateImportRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a template from a previously-exported payload."""
    req.payload.is_template = True
    return await context_model_repo.create_context_model(
        session, req.payload, workspace_id=req.payload.workspace_id,
    )


@template_router.get("/{template_id}/usage", response_model=TemplateUsageStats)
async def get_template_usage(
    template_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Aggregated usage stats for a single template."""
    stats = await context_model_repo.get_usage_stats(session, template_id)
    if not stats:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
    return stats


# ------------------------------------------------------------------ #
# Context Model → Views (1:N relationship)                             #
# ------------------------------------------------------------------ #

@router.get("/{context_model_id}/views", response_model=List[ViewResponse])
async def list_views_for_context_model(
    ws_id: str = Path(...),
    context_model_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """List all views referencing a given context model."""
    cm = await context_model_repo.get_context_model(session, context_model_id)
    if not cm:
        raise HTTPException(status_code=404, detail=f"Context model '{context_model_id}' not found")
    return await view_repo.list_views_for_context_model(session, context_model_id)
