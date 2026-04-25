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
from backend.app.providers.manager import provider_manager as provider_registry  # alias during migration
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

    # Validate all referenced catalog items / providers and ontologies exist
    from backend.app.db.repositories import catalog_repo
    for ds in req.data_sources:
        if ds.catalog_item_id:
            if not await catalog_repo.get_catalog_item(session, ds.catalog_item_id):
                raise HTTPException(status_code=404, detail=f"Catalog Item '{ds.catalog_item_id}' not found")
        elif not ds.provider_id:
            raise HTTPException(status_code=422, detail="Each data source requires either catalogItemId or providerId")
        if ds.ontology_id and not await ontology_definition_repo.get_ontology(session, ds.ontology_id):
            raise HTTPException(status_code=404, detail=f"Ontology '{ds.ontology_id}' not found")

    try:
        return await workspace_repo.create_workspace(session, req)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))


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
    # Validate references based on which path is used
    if req.catalog_item_id:
        from backend.app.db.repositories import catalog_repo
        if not await catalog_repo.get_catalog_item(session, req.catalog_item_id):
            raise HTTPException(status_code=404, detail=f"Catalog Item '{req.catalog_item_id}' not found")
    elif not req.provider_id:
        raise HTTPException(status_code=422, detail="Either catalogItemId or providerId is required")
    if req.ontology_id and not await ontology_definition_repo.get_ontology(session, req.ontology_id):
        raise HTTPException(status_code=404, detail=f"Ontology '{req.ontology_id}' not found")
    try:
        created = await data_source_repo.create_data_source(session, workspace_id, req)
    except ValueError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        if "uq_ds_ws_prov_graph" in str(e) or "already allocated" in str(e):
            raise HTTPException(status_code=409, detail="This data source already exists on this workspace")
        raise

    # Proactive seeding: enqueue an immediate stats poll so the cache is
    # populated by the time the user opens Explorer — otherwise the first
    # visit would hit the synthetic/202 path and force a 2-minute wait.
    # Best-effort: Redis being down silently falls through.
    from backend.stats_service.enqueue import enqueue_stats_job_safe
    await enqueue_stats_job_safe(created.id, workspace_id)

    return created


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

    # Track whether schema-invalidating fields changed so we know whether
    # to re-seed the stats cache below.
    schema_invalidating_change = (
        req.projection_mode is not None
        or req.dedicated_graph_name is not None
        or req.ontology_id is not None
    )

    # Evict old cache entry if provider/graph config changed
    if req.projection_mode is not None or req.dedicated_graph_name is not None:
        await provider_registry.evict_workspace(workspace_id, session)

    ds = await data_source_repo.update_data_source(session, ds_id, req)
    if not ds:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found")

    # Re-seed cache on schema-invalidating changes so the next read
    # doesn't serve stale schema/ontology.
    if schema_invalidating_change:
        from backend.stats_service.enqueue import enqueue_stats_job_safe
        await enqueue_stats_job_safe(ds_id, workspace_id)

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

    # Guard: cannot change mode while an aggregation job is active
    from sqlalchemy import select
    from backend.app.services.aggregation.models import AggregationJobORM
    active_job = (
        await session.execute(
            select(AggregationJobORM)
            .where(AggregationJobORM.data_source_id == ds_id)
            .where(AggregationJobORM.status.in_(["pending", "running"]))
        )
    ).scalars().first()
    if active_job:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot change projection mode while aggregation job '{active_job.id}' is active. Cancel or wait for it to complete.",
        )

    ds.projection_mode = mode if mode else None
    from datetime import datetime, timezone
    ds.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    await provider_registry.evict_workspace(workspace_id, session)
    return await data_source_repo.get_data_source(session, ds_id)


# ================================================================== #
# Cached Stats (DB-only — zero provider dependency)                    #
# ================================================================== #

@router.get("/{workspace_id}/datasources/{ds_id}/cached-stats")
async def get_cached_stats(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Return cached graph statistics for a data source.

    Reads from the ``data_source_stats`` table (populated by the stats poller).
    Zero dependency on graph provider connectivity — safe to call even when the
    provider is unreachable.
    """
    import json
    from backend.app.db.repositories.stats_repo import get_data_source_stats

    # Verify the data source belongs to this workspace
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace '{workspace_id}'")

    stats = await get_data_source_stats(session, ds_id)
    if not stats:
        raise HTTPException(status_code=404, detail="No cached stats available yet — the stats poller may not have run.")

    return {
        "nodeCount": stats.node_count,
        "edgeCount": stats.edge_count,
        "entityTypeCounts": json.loads(stats.entity_type_counts) if stats.entity_type_counts else {},
        "edgeTypeCounts": json.loads(stats.edge_type_counts) if stats.edge_type_counts else {},
        "schemaStats": json.loads(stats.schema_stats) if stats.schema_stats and stats.schema_stats != "{}" else None,
        "ontologyMetadata": json.loads(stats.ontology_metadata) if stats.ontology_metadata and stats.ontology_metadata != "{}" else None,
        "graphSchema": json.loads(stats.graph_schema) if stats.graph_schema and stats.graph_schema != "{}" else None,
        "updatedAt": stats.updated_at,
    }


# ================================================================== #
# Cached Schema (DB-only — zero provider dependency)                   #
# ================================================================== #

@router.get("/{workspace_id}/datasources/{ds_id}/cached-schema")
async def get_cached_schema(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Return cached graph schema for a data source.

    Cache-only read. On miss, returns a synthetic schema built from the
    assigned ontology (canvas renders with correct types, zero counts)
    and enqueues a background refresh. If no ontology is assigned
    either, returns 202 Accepted with a pollable jobId. Never 404 when
    the data source exists — "cache not populated yet" is a state, not
    an error.
    """
    from backend.app.services.stats_cache import (
        CacheMiss, build_computing_response_body, build_synthetic_schema,
        read_stats_cache, synthetic_schema_headers,
    )
    from backend.stats_service.enqueue import enqueue_stats_job_safe
    from fastapi.responses import JSONResponse

    # Verify the data source belongs to this workspace (404 here is a
    # genuine "doesn't exist", not a cache-state error).
    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace '{workspace_id}'")

    try:
        payload, headers = await read_stats_cache(session, ds_id, workspace_id, "graph_schema")
        return JSONResponse(content=payload, headers=headers)
    except CacheMiss:
        pass

    # Enqueue the real refresh regardless of synthetic outcome — frontend
    # auto-upgrades when cache populates.
    msg_id = await enqueue_stats_job_safe(ds_id, workspace_id)

    synthetic = await build_synthetic_schema(session, ds_id)
    if synthetic:
        return JSONResponse(content=synthetic, headers=synthetic_schema_headers())

    body = build_computing_response_body(ds_id, workspace_id, msg_id)
    return JSONResponse(status_code=202, content=body)


# ================================================================== #
# Cached Ontology Metadata (DB-only — zero provider dependency)        #
# ================================================================== #

@router.get("/{workspace_id}/datasources/{ds_id}/cached-ontology")
async def get_cached_ontology(
    workspace_id: str = Path(...),
    ds_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Return cached ontology metadata for a data source.

    Cache-only read. On miss, enqueues a background refresh and returns
    202 Accepted with a pollable jobId. Never 404 when the data source
    exists.
    """
    from backend.app.services.stats_cache import (
        CacheMiss, build_computing_response_body, read_stats_cache,
    )
    from backend.stats_service.enqueue import enqueue_stats_job_safe
    from fastapi.responses import JSONResponse

    ds = await data_source_repo.get_data_source_orm(session, ds_id)
    if not ds or ds.workspace_id != workspace_id:
        raise HTTPException(status_code=404, detail=f"Data source '{ds_id}' not found in workspace '{workspace_id}'")

    try:
        payload, headers = await read_stats_cache(session, ds_id, workspace_id, "ontology_metadata")
        return JSONResponse(content=payload, headers=headers)
    except CacheMiss:
        pass

    msg_id = await enqueue_stats_job_safe(ds_id, workspace_id)
    body = build_computing_response_body(ds_id, workspace_id, msg_id)
    return JSONResponse(status_code=202, content=body)
