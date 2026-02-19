"""
Admin Workspace endpoints — CRUD for workspaces and their data sources.
A workspace is an operational context containing one or more data sources,
each binding a Provider + Graph Name + Blueprint.
"""
from typing import List
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import workspace_repo, provider_repo, blueprint_repo, data_source_repo
from backend.app.registry.provider_registry import provider_registry
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    DataSourceResponse,
)

router = APIRouter()


# ================================================================== #
# Workspace CRUD                                                       #
# ================================================================== #

@router.get("", response_model=List[WorkspaceResponse])
async def list_workspaces(
    session: AsyncSession = Depends(get_db_session),
):
    """List all workspaces (with nested data sources)."""
    return await workspace_repo.list_workspaces(session)


@router.post("", response_model=WorkspaceResponse, status_code=201)
async def create_workspace(
    req: WorkspaceCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new workspace with one or more data sources."""
    if not req.data_sources:
        raise HTTPException(status_code=422, detail="At least one data source is required")

    # Validate all referenced providers and blueprints exist
    for ds in req.data_sources:
        if not await provider_repo.get_provider(session, ds.provider_id):
            raise HTTPException(status_code=404, detail=f"Provider '{ds.provider_id}' not found")
        if ds.blueprint_id and not await blueprint_repo.get_blueprint(session, ds.blueprint_id):
            raise HTTPException(status_code=404, detail=f"Blueprint '{ds.blueprint_id}' not found")

    return await workspace_repo.create_workspace(session, req)


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
async def get_workspace(
    workspace_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single workspace with its data sources."""
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
    """Update workspace metadata (name, description, is_active)."""
    ws = await workspace_repo.update_workspace(session, workspace_id, req)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    return ws


@router.delete("/{workspace_id}", status_code=204)
async def delete_workspace(
    workspace_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a workspace (cascades data sources, views, and rule-sets)."""
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    await provider_registry.evict_workspace(workspace_id, session)
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


# ================================================================== #
# Data Source Sub-Resource CRUD                                        #
# ================================================================== #

@router.get("/{workspace_id}/data-sources", response_model=List[DataSourceResponse])
async def list_data_sources(
    workspace_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """List all data sources for a workspace."""
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    return await data_source_repo.list_data_sources(session, workspace_id)


@router.post("/{workspace_id}/data-sources", response_model=DataSourceResponse, status_code=201)
async def add_data_source(
    workspace_id: str = Path(...),
    req: DataSourceCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Add a data source to a workspace."""
    ws = await workspace_repo.get_workspace_orm(session, workspace_id)
    if not ws:
        raise HTTPException(status_code=404, detail=f"Workspace '{workspace_id}' not found")
    if not await provider_repo.get_provider(session, req.provider_id):
        raise HTTPException(status_code=404, detail=f"Provider '{req.provider_id}' not found")
    if req.blueprint_id and not await blueprint_repo.get_blueprint(session, req.blueprint_id):
        raise HTTPException(status_code=404, detail=f"Blueprint '{req.blueprint_id}' not found")
    return await data_source_repo.create_data_source(session, workspace_id, req)


@router.put("/{workspace_id}/data-sources/{ds_id}", response_model=DataSourceResponse)
async def update_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    req: DataSourceUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a data source. Evicts cached provider if provider/graph changed."""
    old_ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not old_ds or old_ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")

    # Validate new provider/blueprint if changing
    if req.provider_id and not await provider_repo.get_provider(session, req.provider_id):
        raise HTTPException(status_code=404, detail=f"Provider '{req.provider_id}' not found")
    if req.blueprint_id and not await blueprint_repo.get_blueprint(session, req.blueprint_id):
        raise HTTPException(status_code=404, detail=f"Blueprint '{req.blueprint_id}' not found")

    # Evict old cache entry if provider or graph changes
    if req.provider_id or req.graph_name:
        await provider_registry.evict_data_source(
            old_ds.provider_id, old_ds.graph_name or ""
        )

    ds = await data_source_repo.update_data_source(session, ds_id, req)
    if not ds:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found")
    return ds


@router.delete("/{workspace_id}/data-sources/{ds_id}", status_code=204)
async def remove_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Remove a data source. Rejects if it's the last one in the workspace."""
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")

    count = await data_source_repo.count_data_sources(session, workspace_id)
    if count <= 1:
        raise HTTPException(status_code=409, detail="Cannot delete the last data source in a workspace")

    await provider_registry.evict_data_source(ds.provider_id, ds.graph_name or "")
    await data_source_repo.delete_data_source(session, ds_id)


@router.post("/{workspace_id}/data-sources/{ds_id}/set-primary", response_model=DataSourceResponse)
async def set_primary_data_source(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a data source to primary within its workspace."""
    success = await data_source_repo.set_primary(session, workspace_id, ds_id)
    if not success:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    ds = await data_source_repo.get_data_source(session, ds_id)
    return ds
