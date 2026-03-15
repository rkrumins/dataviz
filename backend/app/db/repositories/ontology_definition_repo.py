"""
Repository for ontologies table.
Supports versioning: published ontologies are immutable; updates create new versions.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import OntologyORM
from backend.common.models.management import (
    OntologyCreateRequest,
    OntologyUpdateRequest,
    OntologyDefinitionResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: OntologyORM) -> OntologyDefinitionResponse:
    return OntologyDefinitionResponse(
        id=row.id,
        name=row.name,
        version=row.version,
        containmentEdgeTypes=json.loads(row.containment_edge_types or "[]"),
        lineageEdgeTypes=json.loads(row.lineage_edge_types or "[]"),
        edgeTypeMetadata=json.loads(row.edge_type_metadata or "{}"),
        entityTypeHierarchy=json.loads(row.entity_type_hierarchy or "{}"),
        rootEntityTypes=json.loads(row.root_entity_types or "[]"),
        entityTypeDefinitions=json.loads(row.entity_type_definitions or "{}"),
        relationshipTypeDefinitions=json.loads(row.relationship_type_definitions or "{}"),
        isPublished=bool(row.is_published),
        isSystem=bool(row.is_system) if row.is_system is not None else False,
        scope=row.scope or "universal",
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_ontologies(session: AsyncSession) -> List[OntologyDefinitionResponse]:
    """List all ontologies (all versions)."""
    result = await session.execute(
        select(OntologyORM).order_by(
            OntologyORM.name,
            OntologyORM.version.desc(),
        )
    )
    return [_to_response(r) for r in result.scalars().all()]


async def list_latest_ontologies(session: AsyncSession) -> List[OntologyDefinitionResponse]:
    """List only the latest version of each ontology name."""
    sub = (
        select(
            OntologyORM.name,
            func.max(OntologyORM.version).label("max_ver"),
        )
        .group_by(OntologyORM.name)
        .subquery()
    )
    result = await session.execute(
        select(OntologyORM)
        .join(
            sub,
            (OntologyORM.name == sub.c.name)
            & (OntologyORM.version == sub.c.max_ver),
        )
        .order_by(OntologyORM.name)
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_ontology(
    session: AsyncSession, ontology_id: str
) -> Optional[OntologyDefinitionResponse]:
    result = await session.execute(
        select(OntologyORM).where(OntologyORM.id == ontology_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_ontology_orm(
    session: AsyncSession, ontology_id: str
) -> Optional[OntologyORM]:
    result = await session.execute(
        select(OntologyORM).where(OntologyORM.id == ontology_id)
    )
    return result.scalar_one_or_none()


async def get_system_default_ontology(session: AsyncSession) -> Optional[OntologyORM]:
    """Return the system default ontology ORM (is_system=True), if any."""
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.is_system == True)  # noqa: E712
        .order_by(OntologyORM.version.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_ontology(
    session: AsyncSession,
    req: OntologyCreateRequest,
) -> OntologyDefinitionResponse:
    row = OntologyORM(
        name=req.name,
        version=1,
        containment_edge_types=json.dumps(req.containment_edge_types),
        lineage_edge_types=json.dumps(req.lineage_edge_types),
        edge_type_metadata=json.dumps(req.edge_type_metadata),
        entity_type_hierarchy=json.dumps(req.entity_type_hierarchy),
        root_entity_types=json.dumps(req.root_entity_types),
        entity_type_definitions=json.dumps(req.entity_type_definitions),
        relationship_type_definitions=json.dumps(req.relationship_type_definitions),
        is_published=False,
        is_system=False,
        scope="universal",
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_ontology(
    session: AsyncSession,
    ontology_id: str,
    req: OntologyUpdateRequest,
) -> Optional[OntologyDefinitionResponse]:
    """
    Update an ontology. If published, creates a new version row instead.
    Returns the updated (or newly created) ontology.
    """
    row = await get_ontology_orm(session, ontology_id)
    if not row:
        return None

    if row.is_published:
        return await _create_new_version(session, row, req)

    if req.name is not None:
        row.name = req.name
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
    if req.entity_type_definitions is not None:
        row.entity_type_definitions = json.dumps(req.entity_type_definitions)
    if req.relationship_type_definitions is not None:
        row.relationship_type_definitions = json.dumps(req.relationship_type_definitions)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def _create_new_version(
    session: AsyncSession,
    original: OntologyORM,
    req: OntologyUpdateRequest,
) -> OntologyDefinitionResponse:
    """Create a new version of a published ontology with the requested changes."""
    result = await session.execute(
        select(func.max(OntologyORM.version)).where(
            OntologyORM.name == original.name
        )
    )
    max_version = result.scalar() or 0

    new_row = OntologyORM(
        name=req.name if req.name is not None else original.name,
        version=max_version + 1,
        containment_edge_types=(
            json.dumps(req.containment_edge_types)
            if req.containment_edge_types is not None
            else original.containment_edge_types
        ),
        lineage_edge_types=(
            json.dumps(req.lineage_edge_types)
            if req.lineage_edge_types is not None
            else original.lineage_edge_types
        ),
        edge_type_metadata=(
            json.dumps(req.edge_type_metadata)
            if req.edge_type_metadata is not None
            else original.edge_type_metadata
        ),
        entity_type_hierarchy=(
            json.dumps(req.entity_type_hierarchy)
            if req.entity_type_hierarchy is not None
            else original.entity_type_hierarchy
        ),
        root_entity_types=(
            json.dumps(req.root_entity_types)
            if req.root_entity_types is not None
            else original.root_entity_types
        ),
        entity_type_definitions=(
            json.dumps(req.entity_type_definitions)
            if req.entity_type_definitions is not None
            else original.entity_type_definitions
        ),
        relationship_type_definitions=(
            json.dumps(req.relationship_type_definitions)
            if req.relationship_type_definitions is not None
            else original.relationship_type_definitions
        ),
        is_published=False,
        is_system=False,
        scope=original.scope or "universal",
    )
    session.add(new_row)
    await session.flush()
    return _to_response(new_row)


async def publish_ontology(
    session: AsyncSession, ontology_id: str
) -> Optional[OntologyDefinitionResponse]:
    row = await get_ontology_orm(session, ontology_id)
    if not row:
        return None
    row.is_published = True
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_ontology(
    session: AsyncSession, ontology_id: str
) -> bool:
    result = await session.execute(
        delete(OntologyORM).where(OntologyORM.id == ontology_id)
    )
    return result.rowcount > 0


async def has_data_sources(session: AsyncSession, ontology_id: str) -> bool:
    """Check if any data sources reference this ontology."""
    from ..models import WorkspaceDataSourceORM
    result = await session.execute(
        select(WorkspaceDataSourceORM.id)
        .where(WorkspaceDataSourceORM.ontology_id == ontology_id)
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


