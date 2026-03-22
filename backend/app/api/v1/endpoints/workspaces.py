"""
Admin Workspace endpoints — CRUD for workspaces and their data sources.
A workspace is an operational context containing one or more data sources,
each binding a Provider + Graph Name + Ontology.
"""
from typing import List
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import workspace_repo, provider_repo, ontology_definition_repo, data_source_repo
from backend.app.registry.provider_registry import provider_registry
from backend.common.models.management import (
    WorkspaceCreateRequest,
    WorkspaceUpdateRequest,
    WorkspaceResponse,
    DataSourceCreateRequest,
    DataSourceUpdateRequest,
    DataSourceResponse,
    WorkspaceDataSourceImpactResponse,
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
    # Allow empty workspaces for "Skip for Now" onboarding
    if not req.data_sources:
        req.data_sources = []

    # Validate all referenced catalog items and ontologies exist
    from backend.app.db.repositories import catalog_repo
    for ds in req.data_sources:
        if not await catalog_repo.get_catalog_item(session, ds.catalog_item_id):
            raise HTTPException(status_code=404, detail=f"Catalog Item '{ds.catalog_item_id}' not found")
        if ds.ontology_id and not await ontology_definition_repo.get_ontology(session, ds.ontology_id):
            raise HTTPException(status_code=404, detail=f"Ontology '{ds.ontology_id}' not found")

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
    from backend.app.db.repositories import catalog_repo
    if not await catalog_repo.get_catalog_item(session, req.catalog_item_id):
        raise HTTPException(status_code=404, detail=f"Catalog Item '{req.catalog_item_id}' not found")
    if req.ontology_id and not await ontology_definition_repo.get_ontology(session, req.ontology_id):
        raise HTTPException(status_code=404, detail=f"Ontology '{req.ontology_id}' not found")
    try:
        return await data_source_repo.create_data_source(session, workspace_id, req)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


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

    # Validate new ontology if changing
    if req.ontology_id and not await ontology_definition_repo.get_ontology(session, req.ontology_id):
        raise HTTPException(status_code=404, detail=f"Ontology '{req.ontology_id}' not found")

    # Evict old cache entry if provider/graph config changed
    if req.projection_mode is not None or req.dedicated_graph_name is not None:
        await provider_registry.evict_workspace(workspace_id, session)

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

    await provider_registry.evict_workspace(workspace_id, session)
    await data_source_repo.delete_data_source(session, ds_id)

@router.get("/{workspace_id}/data-sources/{ds_id}/impact", response_model=WorkspaceDataSourceImpactResponse)
async def get_data_source_impact(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Return the blast radius of deleting a data source (e.g. affected semantic views)."""
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    
    return await data_source_repo.get_data_source_impact(session, ds_id)

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


@router.patch("/{workspace_id}/data-sources/{ds_id}/projection-mode", response_model=DataSourceResponse)
async def set_projection_mode(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    mode: str = Body(..., embed=True),
    session: AsyncSession = Depends(get_db_session),
):
    """Set the aggregation edge projection mode for a data source.

    mode values:
    - "in_source"  — store AGGREGATED edges in the same graph as source data
    - "dedicated"  — store in a separate projection graph
    - ""           — clear override, inherit from provider default
    """
    if mode and mode not in ("in_source", "dedicated"):
        raise HTTPException(status_code=422, detail=f"Invalid projection mode: '{mode}'. Must be 'in_source', 'dedicated', or empty.")
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace")
    ds.projection_mode = mode if mode else None
    from datetime import datetime, timezone
    ds.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    await provider_registry.evict_workspace(workspace_id, session)
    return await data_source_repo.get_data_source(session, ds_id)
