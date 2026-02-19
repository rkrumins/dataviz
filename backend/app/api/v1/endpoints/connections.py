"""
Connection management endpoints.

CRUD for registered graph database connections.  All mutating operations
(create, update, delete) evict the cached provider from ProviderRegistry so
the next request picks up fresh credentials / config.
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import connection_repo
from backend.app.registry.provider_registry import provider_registry
from backend.common.models.management import (
    ConnectionCreateRequest,
    ConnectionResponse,
    ConnectionUpdateRequest,
)

router = APIRouter()


# ------------------------------------------------------------------ #
# Helpers                                                             #
# ------------------------------------------------------------------ #

async def _get_or_404(session: AsyncSession, connection_id: str) -> ConnectionResponse:
    conn = await connection_repo.get_connection(session, connection_id)
    if not conn:
        raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")
    return conn


# ------------------------------------------------------------------ #
# CRUD                                                                #
# ------------------------------------------------------------------ #

@router.post("", response_model=ConnectionResponse, status_code=201)
async def create_connection(
    req: ConnectionCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Register a new graph database connection."""
    return await connection_repo.create_connection(session, req)


@router.get("", response_model=List[ConnectionResponse])
async def list_connections(
    session: AsyncSession = Depends(get_db_session),
):
    """List all registered connections (credentials redacted)."""
    return await connection_repo.list_connections(session)


@router.get("/{connection_id}", response_model=ConnectionResponse)
async def get_connection(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a single registered connection by ID."""
    return await _get_or_404(session, connection_id)


@router.put("/{connection_id}", response_model=ConnectionResponse)
async def update_connection(
    connection_id: str = Path(...),
    req: ConnectionUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Update a registered connection and evict its cached provider."""
    await _get_or_404(session, connection_id)
    updated = await connection_repo.update_connection(session, connection_id, req)
    await provider_registry.evict(connection_id)
    return updated


@router.delete("/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete a registered connection and release its provider pool."""
    await _get_or_404(session, connection_id)
    await connection_repo.delete_connection(session, connection_id)
    await provider_registry.evict(connection_id)


# ------------------------------------------------------------------ #
# Connection actions                                                  #
# ------------------------------------------------------------------ #

@router.post("/{connection_id}/test")
async def test_connection(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Ping the graph database for a registered connection.
    Returns latency in milliseconds on success.
    """
    await _get_or_404(session, connection_id)
    import time
    try:
        provider = await provider_registry.get_provider(connection_id, session)
        t0 = time.perf_counter()
        await provider.get_stats()
        latency_ms = round((time.perf_counter() - t0) * 1000, 2)
        return {"status": "healthy", "latencyMs": latency_ms}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Connection test failed: {exc}")


@router.post("/{connection_id}/set-primary", response_model=ConnectionResponse)
async def set_primary_connection(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Promote a connection to primary. Demotes the existing primary."""
    await _get_or_404(session, connection_id)
    await connection_repo.set_primary(session, connection_id)
    # Invalidate cached primary ID so registry re-resolves on next request
    provider_registry._primary_id = None
    return await connection_repo.get_connection(session, connection_id)


@router.get("/{connection_id}/graphs")
async def list_graphs(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    List named graph keys available on this connection's DB instance.

    - FalkorDB: returns output of ``GRAPH.LIST``
    - Neo4j: returns available databases from ``SHOW DATABASES``
    - Others: returns ``[]``
    """
    await _get_or_404(session, connection_id)
    try:
        provider = await provider_registry.get_provider(connection_id, session)
        graphs = await provider.list_graphs()
        return {"graphs": graphs}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to list graphs: {exc}")
