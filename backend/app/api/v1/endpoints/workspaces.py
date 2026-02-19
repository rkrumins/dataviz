"""
Admin Workspace endpoints — CRUD for workspaces.
A workspace binds a Provider + Graph Name + Blueprint into a queryable context.
"""
from typing import List
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import workspace_repo, provider_repo, blueprint_repo
from backend.app.registry.provider_registry import provider_registry
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
)

router = APIRouter()


@router.get("", response_model=List[WorkspaceResponse])
async def list_workspaces(
    session: AsyncSession = Depends(get_db_session),
):
    """List all workspaces."""
    return await workspace_repo.list_workspaces(session)


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(
    req: WorkspaceCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new workspace (binds provider + graph + blueprint)."""
    # Validate provider exists
    if not await provider_repo.get_provider(session, req.provider_id):
        raise HTTPException(status_code=404, detail=f"Provider '{req.provider_id}' not found")
    # Validate blueprint exists (if specified)
    if req.blueprint_id and not await blueprint_repo.get_blueprint(session, req.blueprint_id):
        raise HTTPException(status_code=404, detail=f"Blueprint '{req.blueprint_id}' not found")
    return await workspace_repo.create_workspace(session, req)


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
async def get_workspace(
    workspace_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single workspace."""
    ws = await workspace_repo.get_workspace(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    return ws


@router.put("/{workspace_id}", response_model=WorkspaceResponse)
async def update_workspace(
    workspace_id: str = Path(...),
    req: WorkspaceUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a workspace. Evicts cached providers if provider/graph changed."""
    old_ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not old_ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")

    # Validate new provider/blueprint if changing
    if req.provider_id and not await provider_repo.get_provider(session, req.provider_id):
        raise HTTPException(status_code=404, detail=f"Provider '{req.provider_id}' not found")
    if req.blueprint_id and not await blueprint_repo.get_blueprint(session, req.blueprint_id):
        raise HTTPException(status_code=404, detail=f"Blueprint '{req.blueprint_id}' not found")

    ws = await workspace_repo.update_workspace(session, workspace_id, req)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")

    # Evict if provider or graph changed
    if req.provider_id or req.graph_name:
        await provider_registry.evict_workspace(
            old_ws.provider_id, old_ws.graph_name or ""
        )
    return ws


@router.delete("/{workspace_id}", status_code=204)
async def delete_workspace(
    workspace_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a workspace (cascades views + rule-sets)."""
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    await provider_registry.evict_workspace(ws.provider_id, ws.graph_name or "")
    deleted = await workspace_repo.delete_workspace(session, workspace_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")


@router.post("/{workspace_id}/set-default", response_model=WorkspaceResponse)
async def set_default_workspace(
    workspace_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a workspace to the default (used when no ws_id specified)."""
    success = await workspace_repo.set_default(session, workspace_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    # Clear cached default
    provider_registry._default_ws_id = None
    ws = await workspace_repo.get_workspace(session, workspace_id)
    return ws
