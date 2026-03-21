"""
Repository for ontologies table.
Supports versioning: published ontologies are immutable; updates create new versions.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, func, update
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
        description=getattr(row, "description", None),
        version=row.version,
        evolutionPolicy=getattr(row, "evolution_policy", "reject") or "reject",
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
        schemaId=getattr(row, "schema_id", None) or row.id,
        revision=getattr(row, "revision", 0) or 0,
        createdBy=getattr(row, "created_by", None),
        updatedBy=getattr(row, "updated_by", None),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_ontologies(session: AsyncSession, include_deleted: bool = False) -> List[OntologyDefinitionResponse]:
    """List all ontologies (all versions)."""
    q = select(OntologyORM).order_by(
        OntologyORM.name,
        OntologyORM.version.desc(),
    )
    if not include_deleted:
        q = q.where(OntologyORM.deleted_at.is_(None))
    result = await session.execute(q)
    return [_to_response(r) for r in result.scalars().all()]


async def list_latest_ontologies(session: AsyncSession) -> List[OntologyDefinitionResponse]:
    """List only the latest version of each ontology schema.

    Primary strategy: group by schema_id (populated by backfill migration).
    Fallback: if no ontologies have schema_id set but ontologies exist,
    fall back to name-based grouping (pre-migration compatibility).
    """
    # Try schema_id-based grouping first
    sub = (
        select(
            OntologyORM.schema_id,
            func.max(OntologyORM.version).label("max_ver"),
        )
        .where(OntologyORM.schema_id != "")
        .where(OntologyORM.deleted_at.is_(None))
        .group_by(OntologyORM.schema_id)
        .subquery()
    )
    result = await session.execute(
        select(OntologyORM)
        .join(
            sub,
            (OntologyORM.schema_id == sub.c.schema_id)
            & (OntologyORM.version == sub.c.max_ver),
        )
        .order_by(OntologyORM.name)
    )
    rows = result.scalars().all()
    if rows:
        return [_to_response(r) for r in rows]

    # Fallback: check if ontologies exist but lack schema_id (backfill hasn't run)
    total = await session.execute(
        select(func.count()).select_from(OntologyORM)
    )
    if total.scalar() == 0:
        return []

    # Name-based grouping fallback
    logger.warning(
        "list_latest_ontologies: no ontologies with schema_id set; "
        "falling back to name-based grouping"
    )
    name_sub = (
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
            name_sub,
            (OntologyORM.name == name_sub.c.name)
            & (OntologyORM.version == name_sub.c.max_ver),
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
        description=req.description,
        version=1,
        evolution_policy=req.evolution_policy or "reject",
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
    # First version seeds its own schema_id
    row.schema_id = row.id
    await session.flush()
    return _to_response(row)


def _is_metadata_only(req: OntologyUpdateRequest) -> bool:
    """Return True if the request only touches metadata fields (name, description, evolution_policy)."""
    return (
        req.containment_edge_types is None
        and req.lineage_edge_types is None
        and req.edge_type_metadata is None
        and req.entity_type_hierarchy is None
        and req.root_entity_types is None
        and req.entity_type_definitions is None
        and req.relationship_type_definitions is None
    )


async def update_ontology(
    session: AsyncSession,
    ontology_id: str,
    req: OntologyUpdateRequest,
) -> Optional[OntologyDefinitionResponse]:
    """
    Update an ontology.
    - Metadata-only updates (name, description, evolution_policy) are always applied in-place,
      even for published ontologies — they don't change semantic content.
    - Type definition changes on published ontologies create a new version row instead.
    Returns the updated (or newly created) ontology.
    """
    row = await get_ontology_orm(session, ontology_id)
    if not row:
        return None

    if row.is_published and not _is_metadata_only(req):
        return await _create_new_version(session, row, req)

    if req.name is not None:
        row.name = req.name
    if req.description is not None:
        row.description = req.description
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
    if req.evolution_policy is not None:
        row.evolution_policy = req.evolution_policy

    row.revision = (getattr(row, 'revision', 0) or 0) + 1
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def _create_new_version(
    session: AsyncSession,
    original: OntologyORM,
    req: OntologyUpdateRequest,
) -> OntologyDefinitionResponse:
    """Create a new version of a published ontology with the requested changes."""
    schema_id = original.schema_id or original.id
    result = await session.execute(
        select(func.max(OntologyORM.version)).where(
            OntologyORM.schema_id == schema_id
        )
    )
    max_version = result.scalar() or 0

    new_row = OntologyORM(
        schema_id=schema_id,
        name=req.name if req.name is not None else original.name,
        description=req.description if req.description is not None else getattr(original, "description", None),
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
        evolution_policy=(
            req.evolution_policy
            if req.evolution_policy is not None
            else getattr(original, "evolution_policy", "reject") or "reject"
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
    """Soft-delete an ontology by setting deleted_at timestamp."""
    now = datetime.now(timezone.utc).isoformat()
    result = await session.execute(
        update(OntologyORM)
        .where(OntologyORM.id == ontology_id)
        .where(OntologyORM.deleted_at.is_(None))
        .values(deleted_at=now)
    )
    return result.rowcount > 0


async def restore_ontology(
    session: AsyncSession, ontology_id: str
) -> Optional[OntologyDefinitionResponse]:
    """Restore a soft-deleted ontology by clearing deleted_at."""
    result = await session.execute(
        update(OntologyORM)
        .where(OntologyORM.id == ontology_id)
        .where(OntologyORM.deleted_at.isnot(None))
        .values(deleted_at=None)
    )
    if result.rowcount == 0:
        return None
    row = await session.execute(
        select(OntologyORM).where(OntologyORM.id == ontology_id)
    )
    orm = row.scalar_one_or_none()
    return _to_response(orm) if orm else None


async def list_versions_by_schema(session: AsyncSession, schema_id: str) -> List[OntologyDefinitionResponse]:
    """List all versions of an ontology by schema_id."""
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.schema_id == schema_id)
        .order_by(OntologyORM.version.desc())
    )
    return [_to_response(r) for r in result.scalars().all()]


async def has_data_sources(session: AsyncSession, ontology_id: str) -> bool:
    """Check if any data sources reference this ontology."""
    from ..models import WorkspaceDataSourceORM
    result = await session.execute(
        select(WorkspaceDataSourceORM.id)
        .where(WorkspaceDataSourceORM.ontology_id == ontology_id)
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def get_assignments(session: AsyncSession, ontology_id: str) -> list:
    """
    Return all data sources (across all workspaces) that are currently assigned to this ontology.
    Result: list of dicts with workspaceId, workspaceName, dataSourceId, dataSourceLabel.
    """
    from ..models import WorkspaceDataSourceORM, WorkspaceORM
    rows = await session.execute(
        select(
            WorkspaceDataSourceORM.id.label("data_source_id"),
            WorkspaceDataSourceORM.label.label("data_source_label"),
            WorkspaceORM.id.label("workspace_id"),
            WorkspaceORM.name.label("workspace_name"),
        )
        .join(WorkspaceORM, WorkspaceORM.id == WorkspaceDataSourceORM.workspace_id)
        .where(WorkspaceDataSourceORM.ontology_id == ontology_id)
        .order_by(WorkspaceORM.name, WorkspaceDataSourceORM.label)
    )
    return [
        {
            "workspaceId": r.workspace_id,
            "workspaceName": r.workspace_name,
            "dataSourceId": r.data_source_id,
            "dataSourceLabel": r.data_source_label or r.data_source_id,
        }
        for r in rows.all()
    ]


