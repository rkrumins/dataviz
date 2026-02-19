"""
Repository for ontology_blueprints table.
Supports versioning: published blueprints are immutable; updates create new versions.
"""
import json
import logging
from datetime import datetime, timezone
from typing import List, Optional

from sqlalchemy import select, delete, func
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import OntologyBlueprintORM
from backend.common.models.management import (
    BlueprintCreateRequest,
    BlueprintUpdateRequest,
    BlueprintResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# ORM → Pydantic conversion                                           #
# ------------------------------------------------------------------ #

def _to_response(row: OntologyBlueprintORM) -> BlueprintResponse:
    return BlueprintResponse(
        id=row.id,
        name=row.name,
        version=row.version,
        containmentEdgeTypes=json.loads(row.containment_edge_types or "[]"),
        lineageEdgeTypes=json.loads(row.lineage_edge_types or "[]"),
        edgeTypeMetadata=json.loads(row.edge_type_metadata or "{}"),
        entityTypeHierarchy=json.loads(row.entity_type_hierarchy or "{}"),
        rootEntityTypes=json.loads(row.root_entity_types or "[]"),
        visualOverrides=json.loads(row.visual_overrides or "{}"),
        isPublished=bool(row.is_published),
        createdAt=row.created_at,
        updatedAt=row.updated_at,
    )


# ------------------------------------------------------------------ #
# CRUD                                                                 #
# ------------------------------------------------------------------ #

async def list_blueprints(session: AsyncSession) -> List[BlueprintResponse]:
    """List all blueprints (all versions)."""
    result = await session.execute(
        select(OntologyBlueprintORM).order_by(
            OntologyBlueprintORM.name,
            OntologyBlueprintORM.version.desc(),
        )
    )
    return [_to_response(r) for r in result.scalars().all()]


async def list_latest_blueprints(session: AsyncSession) -> List[BlueprintResponse]:
    """List only the latest version of each blueprint name."""
    # Subquery: max version per name
    sub = (
        select(
            OntologyBlueprintORM.name,
            func.max(OntologyBlueprintORM.version).label("max_ver"),
        )
        .group_by(OntologyBlueprintORM.name)
        .subquery()
    )
    result = await session.execute(
        select(OntologyBlueprintORM)
        .join(
            sub,
            (OntologyBlueprintORM.name == sub.c.name)
            & (OntologyBlueprintORM.version == sub.c.max_ver),
        )
        .order_by(OntologyBlueprintORM.name)
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_blueprint(
    session: AsyncSession, blueprint_id: str
) -> Optional[BlueprintResponse]:
    result = await session.execute(
        select(OntologyBlueprintORM).where(OntologyBlueprintORM.id == blueprint_id)
    )
    row = result.scalar_one_or_none()
    return _to_response(row) if row else None


async def get_blueprint_orm(
    session: AsyncSession, blueprint_id: str
) -> Optional[OntologyBlueprintORM]:
    result = await session.execute(
        select(OntologyBlueprintORM).where(OntologyBlueprintORM.id == blueprint_id)
    )
    return result.scalar_one_or_none()


async def create_blueprint(
    session: AsyncSession,
    req: BlueprintCreateRequest,
) -> BlueprintResponse:
    row = OntologyBlueprintORM(
        name=req.name,
        version=1,
        containment_edge_types=json.dumps(req.containment_edge_types),
        lineage_edge_types=json.dumps(req.lineage_edge_types),
        edge_type_metadata=json.dumps(req.edge_type_metadata),
        entity_type_hierarchy=json.dumps(req.entity_type_hierarchy),
        root_entity_types=json.dumps(req.root_entity_types),
        visual_overrides=json.dumps(req.visual_overrides),
        is_published=False,
    )
    session.add(row)
    await session.flush()
    return _to_response(row)


async def update_blueprint(
    session: AsyncSession,
    blueprint_id: str,
    req: BlueprintUpdateRequest,
) -> Optional[BlueprintResponse]:
    """
    Update a blueprint. If published, creates a new version row instead.
    Returns the updated (or newly created) blueprint.
    """
    row = await get_blueprint_orm(session, blueprint_id)
    if not row:
        return None

    if row.is_published:
        # Published → create new version (immutable originals)
        return await _create_new_version(session, row, req)

    # Draft → update in place
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
    if req.visual_overrides is not None:
        row.visual_overrides = json.dumps(req.visual_overrides)

    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def _create_new_version(
    session: AsyncSession,
    original: OntologyBlueprintORM,
    req: BlueprintUpdateRequest,
) -> BlueprintResponse:
    """Create a new version of a published blueprint with the requested changes."""
    # Find max version for this blueprint name
    result = await session.execute(
        select(func.max(OntologyBlueprintORM.version)).where(
            OntologyBlueprintORM.name == original.name
        )
    )
    max_version = result.scalar() or 0

    new_row = OntologyBlueprintORM(
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
        visual_overrides=(
            json.dumps(req.visual_overrides)
            if req.visual_overrides is not None
            else original.visual_overrides
        ),
        is_published=False,  # New version starts as draft
    )
    session.add(new_row)
    await session.flush()
    return _to_response(new_row)


async def publish_blueprint(
    session: AsyncSession, blueprint_id: str
) -> Optional[BlueprintResponse]:
    row = await get_blueprint_orm(session, blueprint_id)
    if not row:
        return None
    row.is_published = True
    row.updated_at = datetime.now(timezone.utc).isoformat()
    await session.flush()
    return _to_response(row)


async def delete_blueprint(
    session: AsyncSession, blueprint_id: str
) -> bool:
    result = await session.execute(
        delete(OntologyBlueprintORM).where(OntologyBlueprintORM.id == blueprint_id)
    )
    return result.rowcount > 0


async def has_workspaces(session: AsyncSession, blueprint_id: str) -> bool:
    """Check if any workspaces reference this blueprint."""
    from ..models import WorkspaceORM
    result = await session.execute(
        select(WorkspaceORM.id).where(WorkspaceORM.blueprint_id == blueprint_id).limit(1)
    )
    return result.scalar_one_or_none() is not None
