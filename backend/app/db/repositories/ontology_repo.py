"""
Repository for ontology_configs table.
One row per connection; upserts on PUT/PATCH.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import OntologyConfigORM
from backend.common.models.management import OntologyConfigUpdate, OntologyConfigResponse

logger = logging.getLogger(__name__)


def _to_response(row: OntologyConfigORM, source: str = "merged") -> OntologyConfigResponse:
    return OntologyConfigResponse(
        connectionId=row.connection_id,
        containmentEdgeTypes=json.loads(row.containment_edge_types or "[]"),
        lineageEdgeTypes=json.loads(row.lineage_edge_types or "[]"),
        edgeTypeMetadata=json.loads(row.edge_type_metadata or "{}"),
        entityTypeHierarchy=json.loads(row.entity_type_hierarchy or "{}"),
        rootEntityTypes=json.loads(row.root_entity_types or "[]"),
        overrideMode=row.override_mode,
        updatedAt=row.updated_at,
        source=source,
    )


async def get_ontology_config(
    session: AsyncSession, connection_id: str
) -> Optional[OntologyConfigORM]:
    result = await session.execute(
        select(OntologyConfigORM).where(OntologyConfigORM.connection_id == connection_id)
    )
    return result.scalar_one_or_none()


async def get_ontology_response(
    session: AsyncSession, connection_id: str
) -> Optional[OntologyConfigResponse]:
    row = await get_ontology_config(session, connection_id)
    return _to_response(row) if row else None


async def upsert_ontology_config(
    session: AsyncSession,
    connection_id: str,
    req: OntologyConfigUpdate,
    updated_by: Optional[str] = None,
) -> OntologyConfigResponse:
    row = await get_ontology_config(session, connection_id)
    if row is None:
        row = OntologyConfigORM(connection_id=connection_id)
        session.add(row)

    if req.containment_edge_types is not None:
        row.containment_edge_types = json.dumps(req.containment_edge_types)
    if req.lineage_edge_types is not None:
        row.lineage_edge_types = json.dumps(req.lineage_edge_types)
    if req.edge_type_metadata is not None:
        row.edge_type_metadata = json.dumps(req.edge_type_metadata)
    if req.entity_type_hierarchy is not None:
        row.entity_type_hierarchy = json.dumps(req.entity_type_hierarchy)
    if req.root_entity_types is not None:
        row.root_entity_types = json.dumps(req.root_entity_types)

    row.override_mode = req.override_mode
    row.updated_at = datetime.now(timezone.utc).isoformat()
    row.updated_by = updated_by

    await session.flush()
    return _to_response(row)


async def delete_ontology_config(
    session: AsyncSession, connection_id: str
) -> bool:
    row = await get_ontology_config(session, connection_id)
    if row:
        await session.delete(row)
        return True
    return False


async def bootstrap_ontology_from_env(
    session: AsyncSession,
    connection_id: str,
    containment_edge_types: list,
) -> None:
    """
    Called during startup to persist env-var-based ontology config.
    Only writes if no config exists yet for this connection.
    """
    existing = await get_ontology_config(session, connection_id)
    if existing:
        return
    req = OntologyConfigUpdate(
        containmentEdgeTypes=containment_edge_types,
        overrideMode="merge",
    )
    await upsert_ontology_config(session, connection_id, req, updated_by="env_bootstrap")
