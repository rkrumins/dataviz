"""
Per-connection ontology configuration endpoints.

Allows operators to persist ontology overrides (containment/lineage edge type
lists, entity hierarchy mappings) per connection in the management DB.  The
ContextEngine merges these with live introspection from the graph database.
"""
import json
from fastapi import APIRouter, Body, Depends, HTTPException, Path
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import connection_repo, ontology_repo
from backend.app.registry.provider_registry import provider_registry
from backend.app.services.context_engine import ContextEngine
from backend.common.models.management import (
    OntologyConfigUpdate,
    OntologyConfigResponse,
)

router = APIRouter()


async def _require_connection(session: AsyncSession, connection_id: str) -> None:
    if not await connection_repo.get_connection(session, connection_id):
        raise HTTPException(status_code=404, detail=f"Connection '{connection_id}' not found")


def _ontology_to_response(connection_id: str, ontology, override_mode: str) -> OntologyConfigResponse:
    """Build OntologyConfigResponse from a merged OntologyMetadata object."""
    return OntologyConfigResponse(
        connectionId=connection_id,
        overrideMode=override_mode,
        containmentEdgeTypes=ontology.containment_edge_types,
        lineageEdgeTypes=ontology.lineage_edge_types,
        edgeTypeMetadata={
            k: (v.model_dump(by_alias=True) if hasattr(v, "model_dump") else v)
            for k, v in (ontology.edge_type_metadata or {}).items()
        },
        entityTypeHierarchy={
            k: (v.model_dump(by_alias=True) if hasattr(v, "model_dump") else v)
            for k, v in (ontology.entity_type_hierarchy or {}).items()
        },
        rootEntityTypes=ontology.root_entity_types or [],
        source="merged",
    )


# ------------------------------------------------------------------ #
# Ontology endpoints                                                  #
# ------------------------------------------------------------------ #

@router.get("", response_model=OntologyConfigResponse, response_model_by_alias=True)
async def get_ontology(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Return the merged ontology for this connection.

    The result is the DB override (if any) merged with live graph
    introspection, so callers always receive the full effective ontology.
    """
    await _require_connection(session, connection_id)
    engine = await ContextEngine.for_connection(connection_id, provider_registry, session)
    ontology = await engine.get_ontology_metadata()
    db_config = await ontology_repo.get_ontology_config(session, connection_id)
    override_mode = db_config.override_mode if db_config else "merge"
    return _ontology_to_response(connection_id, ontology, override_mode)


@router.put("", response_model=OntologyConfigResponse, response_model_by_alias=True)
async def replace_ontology(
    connection_id: str = Path(...),
    req: OntologyConfigUpdate = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Replace the ontology override for this connection.

    All fields in the request body replace the existing DB override.
    ``override_mode='replace'`` means the DB config is used *instead of*
    live introspection; ``'merge'`` (default) unions both sources.
    """
    await _require_connection(session, connection_id)
    return await ontology_repo.upsert_ontology_config(session, connection_id, req)


@router.patch("", response_model=OntologyConfigResponse, response_model_by_alias=True)
async def patch_ontology(
    connection_id: str = Path(...),
    req: OntologyConfigUpdate = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Partially update the ontology override.

    Only the fields present in the request body are modified; existing values
    for omitted fields are preserved.
    """
    await _require_connection(session, connection_id)
    existing = await ontology_repo.get_ontology_config(session, connection_id)

    def _parse(field: str, default):
        if existing is None:
            return default
        raw = getattr(existing, field, None)
        return json.loads(raw) if raw else default

    merged = OntologyConfigUpdate(
        containmentEdgeTypes=(
            req.containment_edge_types
            if req.containment_edge_types is not None
            else _parse("containment_edge_types", [])
        ),
        lineageEdgeTypes=(
            req.lineage_edge_types
            if req.lineage_edge_types is not None
            else _parse("lineage_edge_types", [])
        ),
        edgeTypeMetadata=(
            req.edge_type_metadata
            if req.edge_type_metadata is not None
            else _parse("edge_type_metadata", {})
        ),
        entityTypeHierarchy=(
            req.entity_type_hierarchy
            if req.entity_type_hierarchy is not None
            else _parse("entity_type_hierarchy", {})
        ),
        rootEntityTypes=(
            req.root_entity_types
            if req.root_entity_types is not None
            else _parse("root_entity_types", [])
        ),
        overrideMode=(
            req.override_mode
            if req.override_mode is not None
            else (existing.override_mode if existing else "merge")
        ),
    )
    return await ontology_repo.upsert_ontology_config(session, connection_id, merged)


@router.delete("", status_code=204)
async def delete_ontology(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Remove the DB ontology override for this connection.

    After deletion, ontology is determined entirely by live graph
    introspection (identical to a fresh installation).
    """
    await _require_connection(session, connection_id)
    await ontology_repo.delete_ontology_config(session, connection_id)


@router.post("/refresh", response_model=OntologyConfigResponse, response_model_by_alias=True)
async def refresh_ontology(
    connection_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Re-introspect the graph and write the result as the new DB baseline.

    Useful after schema changes: captures the current live state as the
    stored override so subsequent edits have a fresh starting point.
    """
    await _require_connection(session, connection_id)
    engine = await ContextEngine.for_connection(connection_id, provider_registry, session)
    # Bypass DB override — get raw introspection only
    introspected = await engine.provider.get_ontology_metadata()

    snapshot = OntologyConfigUpdate(
        containmentEdgeTypes=introspected.containment_edge_types,
        lineageEdgeTypes=introspected.lineage_edge_types,
        edgeTypeMetadata={
            k: (v.model_dump(by_alias=True) if hasattr(v, "model_dump") else v)
            for k, v in (introspected.edge_type_metadata or {}).items()
        },
        entityTypeHierarchy={
            k: (v.model_dump(by_alias=True) if hasattr(v, "model_dump") else v)
            for k, v in (introspected.entity_type_hierarchy or {}).items()
        },
        rootEntityTypes=introspected.root_entity_types or [],
        overrideMode="merge",
    )
    return await ontology_repo.upsert_ontology_config(session, connection_id, snapshot)
