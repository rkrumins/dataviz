"""
Context Model endpoints — TEMPLATES ONLY.

Context-model *instances* are retired: layers + entity assignments now live on the
view config (``view.config.layout.referenceLayout``), so the workspace-scoped
instance CRUD is gone. What remains are the reusable Quick Start Templates:

- Workspace-scoped (read-only): GET ``/{ws_id}/context-models/templates`` list + get,
  so any workspace member (``workspace:datasource:read``) can browse templates in the
  View wizard's layout gallery — no ``system:admin`` required.
- Admin: full template CRUD under ``/admin/context-model-templates``.
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
)

# ------------------------------------------------------------------ #
# Workspace-scoped router — READ-ONLY template access                 #
# ------------------------------------------------------------------ #
# The router-level dependency in api.py enforces ``workspace:datasource:read``
# for every route here, so a non-admin workspace member can list/read templates
# (the wizard's layout gallery) without holding ``system:admin``.

router = APIRouter()


@router.get("/templates", response_model=List[ContextModelResponse])
async def list_workspace_templates(
    ws_id: str = Path(...),
    category: Optional[str] = Query(None),
    session: AsyncSession = Depends(get_db_session),
):
    """List Quick Start Templates available to this workspace (read-only)."""
    models = await context_model_repo.list_context_models(session, templates_only=True)
    if category:
        models = [m for m in models if m.category == category]
    return models


@router.get("/templates/{template_id}", response_model=ContextModelResponse)
async def get_workspace_template(
    ws_id: str = Path(...),
    template_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single Quick Start Template (read-only)."""
    cm = await context_model_repo.get_context_model(session, template_id)
    if not cm or not cm.is_template:
        raise HTTPException(status_code=404, detail=f"Template '{template_id}' not found")
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
