"""
Admin Provider endpoints — CRUD for physical database server registrations.
Providers are pure infrastructure: host/port/credentials, no graph or ontology.
"""
from typing import List
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import provider_repo
from backend.app.registry.provider_registry import provider_registry
from backend.common.models.management import (
    ProviderCreateRequest,
    ProviderUpdateRequest,
    ProviderResponse,
    ConnectionTestResult,
    AssetListResponse,
    ProviderImpactResponse,
    PhysicalGraphStatsResponse,
)

router = APIRouter()


@router.get("", response_model=List[ProviderResponse])
async def list_providers(
    session: AsyncSession = Depends(get_db_session),
):
    """List all registered providers."""
    return await provider_repo.list_providers(session)


@router.post("", response_model=ProviderResponse, status_code=201)
async def create_provider(
    req: ProviderCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Register a new provider (database server)."""
    return await provider_repo.create_provider(session, req)


@router.get("/{provider_id}", response_model=ProviderResponse)
async def get_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single provider."""
    prov = await provider_repo.get_provider(session, provider_id)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    return prov


@router.put("/{provider_id}", response_model=ProviderResponse)
async def update_provider(
    provider_id: str = Path(...),
    req: ProviderUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a provider. Evicts any cached provider instances."""
    prov = await provider_repo.update_provider(session, provider_id, req)
    if not prov:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    await provider_registry.evict_provider(provider_id)
    return prov


@router.delete("/{provider_id}", status_code=204)
async def delete_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a provider. Rejects if workspaces still reference it."""
    if await provider_repo.has_workspaces(session, provider_id):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete provider: one or more workspaces still reference it.",
        )
    deleted = await provider_repo.delete_provider(session, provider_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    await provider_registry.evict_provider(provider_id)


@router.get("/{provider_id}/impact", response_model=ProviderImpactResponse)
async def get_provider_impact(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Calculate the blast radius of deleting a provider."""
    # Ensure provider exists first
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")
    
    return await provider_repo.get_provider_impact(session, provider_id)


@router.post("/{provider_id}/test", response_model=ConnectionTestResult)
async def test_provider(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Test connectivity to a registered provider."""
    import time
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    try:
        # Instantiate a temporary provider for testing
        creds = await provider_repo.get_credentials(session, provider_id)
        instance = provider_registry._create_provider_instance(
            prov_row.provider_type, prov_row.host, prov_row.port,
            None, prov_row.tls_enabled, creds,
        )
        t0 = time.monotonic()
        await instance.get_stats()
        latency = (time.monotonic() - t0) * 1000
        return ConnectionTestResult(success=True, latencyMs=round(latency, 1))
    except Exception as exc:
        return ConnectionTestResult(success=False, error=str(exc))


@router.get("/{provider_id}/assets", response_model=AssetListResponse)
async def list_assets(
    provider_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """List available assets (e.g. graphs, databases, topics) on this provider."""
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    try:
        creds = await provider_repo.get_credentials(session, provider_id)
        instance = provider_registry._create_provider_instance(
            prov_row.provider_type, prov_row.host, prov_row.port,
            None, prov_row.tls_enabled, creds,
        )
        graphs = await instance.list_graphs()
        return AssetListResponse(assets=graphs)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.get("/{provider_id}/assets/{asset_name}/stats", response_model=PhysicalGraphStatsResponse)
async def get_asset_stats(
    provider_id: str = Path(...),
    asset_name: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get raw physical metadata (node/edge counts) for a specific asset."""
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    try:
        creds = await provider_repo.get_credentials(session, provider_id)
        # Instantiate with asset_name as the target graph/database key
        instance = provider_registry._create_provider_instance(
            prov_row.provider_type, prov_row.host, prov_row.port,
            asset_name, prov_row.tls_enabled, creds,
        )
        raw = await instance.get_stats()
        return PhysicalGraphStatsResponse(
            nodeCount=raw.get("node_count", raw.get("nodeCount", 0)),
            edgeCount=raw.get("edge_count", raw.get("edgeCount", 0)),
            entityTypeCounts=raw.get("entity_type_counts", raw.get("entityTypeCounts", {})),
            edgeTypeCounts=raw.get("edge_type_counts", raw.get("edgeTypeCounts", {})),
        )
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/{provider_id}/discover-schema")
async def discover_schema(
    provider_id: str = Path(...),
    asset_name: str = Body(None, embed=True),
    session: AsyncSession = Depends(get_db_session),
):
    """Introspect an asset's schema to discover labels, property keys, and suggest a mapping."""
    prov_row = await provider_repo.get_provider_orm(session, provider_id)
    if not prov_row:
        raise HTTPException(status_code=404, detail=f"Provider '{provider_id}' not found")

    try:
        creds = await provider_repo.get_credentials(session, provider_id)
        instance = provider_registry._create_provider_instance(
            prov_row.provider_type, prov_row.host, prov_row.port,
            asset_name, prov_row.tls_enabled, creds,
        )
        schema = await instance.discover_schema()
        return schema
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))

