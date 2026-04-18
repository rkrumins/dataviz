"""
Repository for ontologies table.
Supports versioning: published ontologies are immutable; updates create new versions.
"""
import json
import logging
from datetime import datetime, timezone
from typing import Any, List, Optional

from sqlalchemy import select, delete, func, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import OntologyORM, OntologyAuditLogORM
from backend.common.models.management import (
    OntologyCreateRequest,
    OntologyUpdateRequest,
    OntologyDefinitionResponse,
    OntologyAuditEntry,
    OntologyImportRequest,
    OntologyImportResponse,
)

logger = logging.getLogger(__name__)


# ------------------------------------------------------------------ #
# Audit trail helper                                                   #
# ------------------------------------------------------------------ #

async def _record_audit(
    session: AsyncSession,
    row: OntologyORM,
    action: str,
    *,
    actor: str | None = None,
    summary: str | None = None,
    changes: dict | None = None,
) -> None:
    """Append an immutable audit log entry for an ontology lifecycle event."""
    entry = OntologyAuditLogORM(
        ontology_id=row.id,
        schema_id=getattr(row, "schema_id", None) or row.id,
        action=action,
        actor=actor or getattr(row, "updated_by", None) or getattr(row, "created_by", None),
        version=row.version,
        summary=summary,
        changes=json.dumps(changes) if changes else None,
    )
    session.add(entry)
    await session.flush()


def _compute_type_diff(
    old_entities: set, new_entities: set,
    old_rels: set, new_rels: set,
) -> dict:
    """Compute added/removed entity and relationship types."""
    return {
        "addedEntityTypes": sorted(new_entities - old_entities),
        "removedEntityTypes": sorted(old_entities - new_entities),
        "addedRelationshipTypes": sorted(new_rels - old_rels),
        "removedRelationshipTypes": sorted(old_rels - new_rels),
    }


async def get_audit_log(
    session: AsyncSession,
    schema_id: str,
    *,
    action: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[OntologyAuditEntry]:
    """Return audit entries for an ontology schema, newest first. Supports filtering and pagination."""
    q = (
        select(OntologyAuditLogORM)
        .where(OntologyAuditLogORM.schema_id == schema_id)
    )
    if action:
        q = q.where(OntologyAuditLogORM.action == action)
    q = q.order_by(OntologyAuditLogORM.created_at.desc()).limit(limit).offset(offset)
    result = await session.execute(q)
    rows = result.scalars().all()
    return [
        OntologyAuditEntry(
            id=r.id,
            ontologyId=r.ontology_id,
            schemaId=r.schema_id,
            action=r.action,
            actor=r.actor,
            version=r.version,
            summary=r.summary,
            changes=json.loads(r.changes) if r.changes else None,
            createdAt=r.created_at,
        )
        for r in rows
    ]


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
        publishedBy=getattr(row, "published_by", None),
        publishedAt=getattr(row, "published_at", None),
        deletedBy=getattr(row, "deleted_by", None),
        deletedAt=getattr(row, "deleted_at", None),
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


async def list_latest_ontologies(session: AsyncSession, include_deleted: bool = False) -> List[OntologyDefinitionResponse]:
    """List only the latest version of each ontology schema.

    Primary strategy: group by schema_id (populated by backfill migration).
    Fallback: if no ontologies have schema_id set but ontologies exist,
    fall back to name-based grouping (pre-migration compatibility).
    """
    # Try schema_id-based grouping first
    sub_q = (
        select(
            OntologyORM.schema_id,
            func.max(OntologyORM.version).label("max_ver"),
        )
        .where(OntologyORM.schema_id != "")
    )
    if not include_deleted:
        sub_q = sub_q.where(OntologyORM.deleted_at.is_(None))
    sub = sub_q.group_by(OntologyORM.schema_id).subquery()
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
    entity_count = len(json.loads(row.entity_type_definitions or "{}"))
    rel_count = len(json.loads(row.relationship_type_definitions or "{}"))
    await _record_audit(
        session, row, "created",
        summary=f"Created draft v1 with {entity_count} entity types, {rel_count} relationships",
    )
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

    # Snapshot before-state for audit diff
    old_entities = set(json.loads(row.entity_type_definitions or "{}").keys())
    old_rels = set(json.loads(row.relationship_type_definitions or "{}").keys())

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

    # Compute change diff for audit
    new_entities = set(json.loads(row.entity_type_definitions or "{}").keys())
    new_rels = set(json.loads(row.relationship_type_definitions or "{}").keys())
    changes = _compute_type_diff(old_entities, new_entities, old_rels, new_rels)
    parts = []
    if _is_metadata_only(req):
        parts.append("Updated metadata")
    else:
        if changes.get("addedEntityTypes"):
            parts.append(f"Added {len(changes['addedEntityTypes'])} entity type(s)")
        if changes.get("removedEntityTypes"):
            parts.append(f"Removed {len(changes['removedEntityTypes'])} entity type(s)")
        if changes.get("addedRelationshipTypes"):
            parts.append(f"Added {len(changes['addedRelationshipTypes'])} relationship(s)")
        if changes.get("removedRelationshipTypes"):
            parts.append(f"Removed {len(changes['removedRelationshipTypes'])} relationship(s)")
        if not parts:
            parts.append("Updated type definitions")
    await _record_audit(session, row, "updated", summary="; ".join(parts), changes=changes if not _is_metadata_only(req) else None)

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
    await _record_audit(
        session, new_row, "cloned",
        summary=f"Created v{new_row.version} from published v{original.version}",
    )
    return _to_response(new_row)


async def publish_ontology(
    session: AsyncSession, ontology_id: str
) -> Optional[OntologyDefinitionResponse]:
    row = await get_ontology_orm(session, ontology_id)
    if not row:
        return None
    now = datetime.now(timezone.utc).isoformat()
    row.is_published = True
    row.published_at = now
    row.updated_at = now
    await session.flush()
    # Audit trail
    await _record_audit(session, row, "published", summary=f"Published v{row.version}")
    return _to_response(row)


async def delete_ontology(
    session: AsyncSession, ontology_id: str
) -> bool:
    """Soft-delete an ontology by setting deleted_at timestamp."""
    row = await get_ontology_orm(session, ontology_id)
    if not row or row.deleted_at:
        return False
    now = datetime.now(timezone.utc).isoformat()
    row.deleted_at = now
    await session.flush()
    await _record_audit(session, row, "deleted", summary=f"Deleted \"{row.name}\" v{row.version}")
    return True


async def restore_ontology(
    session: AsyncSession, ontology_id: str
) -> Optional[OntologyDefinitionResponse]:
    """Restore a soft-deleted ontology by clearing deleted_at."""
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.id == ontology_id)
        .where(OntologyORM.deleted_at.isnot(None))
    )
    row = result.scalar_one_or_none()
    if not row:
        return None
    row.deleted_at = None
    row.deleted_by = None
    await session.flush()
    await _record_audit(session, row, "restored", summary=f"Restored \"{row.name}\" v{row.version}")
    return _to_response(row)


async def list_versions_by_schema(session: AsyncSession, schema_id: str) -> List[OntologyDefinitionResponse]:
    """List all versions of an ontology by schema_id."""
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.schema_id == schema_id)
        .order_by(OntologyORM.version.desc())
    )
    return [_to_response(r) for r in result.scalars().all()]


async def get_draft_for_schema(
    session: AsyncSession, schema_id: str
) -> Optional[OntologyORM]:
    """Return an existing unpublished draft for a given schema_id, if one exists."""
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.schema_id == schema_id)
        .where(OntologyORM.is_published == False)  # noqa: E712
        .where(OntologyORM.deleted_at.is_(None))
        .order_by(OntologyORM.version.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def create_new_version_from_source(
    session: AsyncSession, source: OntologyORM
) -> OntologyDefinitionResponse:
    """Create a new draft version from a published/system ontology under the same schema_id."""
    schema_id = source.schema_id or source.id
    result = await session.execute(
        select(func.max(OntologyORM.version)).where(
            OntologyORM.schema_id == schema_id
        )
    )
    max_version = result.scalar() or 0

    new_row = OntologyORM(
        schema_id=schema_id,
        name=source.name,
        description=getattr(source, "description", None),
        version=max_version + 1,
        containment_edge_types=source.containment_edge_types,
        lineage_edge_types=source.lineage_edge_types,
        edge_type_metadata=source.edge_type_metadata,
        entity_type_hierarchy=source.entity_type_hierarchy,
        root_entity_types=source.root_entity_types,
        entity_type_definitions=source.entity_type_definitions,
        relationship_type_definitions=source.relationship_type_definitions,
        evolution_policy=getattr(source, "evolution_policy", "reject") or "reject",
        is_published=False,
        is_system=False,
        scope=source.scope or "universal",
    )
    session.add(new_row)
    await session.flush()
    entity_count = len(json.loads(new_row.entity_type_definitions or "{}"))
    rel_count = len(json.loads(new_row.relationship_type_definitions or "{}"))
    await _record_audit(
        session, new_row, "cloned",
        summary=f"Created draft v{new_row.version} from v{source.version} ({entity_count} entity types, {rel_count} relationships)",
    )
    return _to_response(new_row)


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


# ------------------------------------------------------------------ #
# Import                                                               #
# ------------------------------------------------------------------ #

def _deep_equal(a: Any, b: Any) -> bool:
    """Deep-compare two JSON-serializable values (dicts, lists, scalars)."""
    if type(a) != type(b):
        return False
    if isinstance(a, dict):
        if a.keys() != b.keys():
            return False
        return all(_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        if len(a) != len(b):
            return False
        return all(_deep_equal(x, y) for x, y in zip(a, b))
    return a == b


def _compute_import_diff(
    current_row: OntologyORM,
    req: OntologyImportRequest,
) -> dict:
    """
    Compare the imported payload against the current ontology state.
    Returns a dict with:
      - changed: bool — whether anything is different
      - type_diff: added/removed entity and relationship types
      - field_changes: list of field names that differ
    """
    field_changes: list[str] = []

    # Compare each semantic field
    cur_entities = json.loads(current_row.entity_type_definitions or "{}")
    cur_rels = json.loads(current_row.relationship_type_definitions or "{}")
    cur_containment = json.loads(current_row.containment_edge_types or "[]")
    cur_lineage = json.loads(current_row.lineage_edge_types or "[]")
    cur_edge_meta = json.loads(current_row.edge_type_metadata or "{}")
    cur_hierarchy = json.loads(current_row.entity_type_hierarchy or "{}")
    cur_roots = json.loads(current_row.root_entity_types or "[]")

    if not _deep_equal(cur_entities, req.entity_type_definitions):
        field_changes.append("entityTypeDefinitions")
    if not _deep_equal(cur_rels, req.relationship_type_definitions):
        field_changes.append("relationshipTypeDefinitions")
    if not _deep_equal(cur_containment, req.containment_edge_types):
        field_changes.append("containmentEdgeTypes")
    if not _deep_equal(cur_lineage, req.lineage_edge_types):
        field_changes.append("lineageEdgeTypes")
    if not _deep_equal(cur_edge_meta, req.edge_type_metadata):
        field_changes.append("edgeTypeMetadata")
    if not _deep_equal(cur_hierarchy, req.entity_type_hierarchy):
        field_changes.append("entityTypeHierarchy")
    if not _deep_equal(cur_roots, req.root_entity_types):
        field_changes.append("rootEntityTypes")

    # Metadata changes (name, description, evolution_policy)
    if current_row.name != req.name:
        field_changes.append("name")
    cur_desc = getattr(current_row, "description", None) or ""
    if cur_desc != (req.description or ""):
        field_changes.append("description")
    cur_policy = getattr(current_row, "evolution_policy", "reject") or "reject"
    if cur_policy != req.evolution_policy:
        field_changes.append("evolutionPolicy")

    # Type-level diff for audit
    type_diff = _compute_type_diff(
        set(cur_entities.keys()), set(req.entity_type_definitions.keys()),
        set(cur_rels.keys()), set(req.relationship_type_definitions.keys()),
    )

    return {
        "changed": len(field_changes) > 0,
        "type_diff": type_diff,
        "field_changes": field_changes,
    }


def _apply_import_fields(row: OntologyORM, req: OntologyImportRequest) -> None:
    """Write all semantic fields from an import request onto an ORM row."""
    row.name = req.name
    row.description = req.description
    row.evolution_policy = req.evolution_policy
    row.entity_type_definitions = json.dumps(req.entity_type_definitions)
    row.relationship_type_definitions = json.dumps(req.relationship_type_definitions)
    row.containment_edge_types = json.dumps(req.containment_edge_types)
    row.lineage_edge_types = json.dumps(req.lineage_edge_types)
    row.edge_type_metadata = json.dumps(req.edge_type_metadata)
    row.entity_type_hierarchy = json.dumps(req.entity_type_hierarchy)
    row.root_entity_types = json.dumps(req.root_entity_types)


async def import_ontology(
    session: AsyncSession,
    req: OntologyImportRequest,
    target_id: Optional[str] = None,
) -> OntologyImportResponse:
    """
    Import a semantic layer from exported JSON.

    Behavior depends on target and current state:
    - No target_id → create a new draft from the import data.
    - Target is draft → update in-place, record audit (same version).
    - Target is published/system → create a new draft version with imported data.
    - Target is deleted → reject.
    - No changes detected → return early with status="no_changes".
    """
    # ── Create new ontology (no target) ──────────────────────────────
    if target_id is None:
        create_req = OntologyCreateRequest(
            name=req.name,
            description=req.description,
            evolution_policy=req.evolution_policy,
            containment_edge_types=req.containment_edge_types,
            lineage_edge_types=req.lineage_edge_types,
            edge_type_metadata=req.edge_type_metadata,
            entity_type_hierarchy=req.entity_type_hierarchy,
            root_entity_types=req.root_entity_types,
            entity_type_definitions=req.entity_type_definitions,
            relationship_type_definitions=req.relationship_type_definitions,
        )
        created = await create_ontology(session, create_req)
        # Override the default "created" audit with a more specific "imported" entry
        await _record_audit(
            session,
            (await get_ontology_orm(session, created.id)),  # type: ignore[arg-type]
            "imported",
            summary=(
                f"Imported as new draft with "
                f"{len(req.entity_type_definitions)} entity types, "
                f"{len(req.relationship_type_definitions)} relationships"
            ),
        )
        return OntologyImportResponse(
            ontology=created,
            status="created",
            summary=(
                f"Created new semantic layer \"{req.name}\" with "
                f"{len(req.entity_type_definitions)} entity types, "
                f"{len(req.relationship_type_definitions)} relationships"
            ),
        )

    # ── Import into existing ontology ────────────────────────────────
    row = await get_ontology_orm(session, target_id)
    if not row:
        raise ValueError(f"Ontology '{target_id}' not found")

    if row.deleted_at:
        raise ValueError("Cannot import into a deleted semantic layer. Restore it first.")

    if row.is_system:
        raise ValueError("Cannot import into a system semantic layer. Clone it first.")

    # Diff detection
    diff = _compute_import_diff(row, req)

    if not diff["changed"]:
        return OntologyImportResponse(
            ontology=_to_response(row),
            status="no_changes",
            summary="No changes detected — the imported data matches the current state exactly.",
        )

    # Build human-readable summary
    parts: list[str] = []
    td = diff["type_diff"]
    if td.get("addedEntityTypes"):
        parts.append(f"Added {len(td['addedEntityTypes'])} entity type(s)")
    if td.get("removedEntityTypes"):
        parts.append(f"Removed {len(td['removedEntityTypes'])} entity type(s)")
    if td.get("addedRelationshipTypes"):
        parts.append(f"Added {len(td['addedRelationshipTypes'])} relationship(s)")
    if td.get("removedRelationshipTypes"):
        parts.append(f"Removed {len(td['removedRelationshipTypes'])} relationship(s)")
    # Non-type field changes
    non_type_fields = [f for f in diff["field_changes"] if f not in (
        "entityTypeDefinitions", "relationshipTypeDefinitions",
    )]
    if non_type_fields and not parts:
        parts.append(f"Updated {', '.join(non_type_fields)}")
    elif non_type_fields:
        parts.append(f"also updated {', '.join(non_type_fields)}")
    if not parts:
        parts.append("Updated type definitions (content changes within existing types)")

    summary_text = "; ".join(parts)

    # ── Draft → in-place update (same version) ──────────────────────
    if not row.is_published:
        _apply_import_fields(row, req)
        row.revision = (getattr(row, "revision", 0) or 0) + 1
        row.updated_at = datetime.now(timezone.utc).isoformat()
        await session.flush()

        await _record_audit(
            session, row, "imported",
            summary=f"Imported into draft v{row.version}: {summary_text}",
            changes=diff["type_diff"],
        )
        return OntologyImportResponse(
            ontology=_to_response(row),
            status="updated",
            summary=f"Updated draft v{row.version}: {summary_text}",
            changes=diff["type_diff"],
        )

    # ── Published → create new draft version ─────────────────────────
    schema_id = row.schema_id or row.id
    result = await session.execute(
        select(func.max(OntologyORM.version)).where(
            OntologyORM.schema_id == schema_id
        )
    )
    max_version = result.scalar() or 0

    new_row = OntologyORM(
        schema_id=schema_id,
        name=req.name,
        description=req.description,
        version=max_version + 1,
        evolution_policy=req.evolution_policy,
        entity_type_definitions=json.dumps(req.entity_type_definitions),
        relationship_type_definitions=json.dumps(req.relationship_type_definitions),
        containment_edge_types=json.dumps(req.containment_edge_types),
        lineage_edge_types=json.dumps(req.lineage_edge_types),
        edge_type_metadata=json.dumps(req.edge_type_metadata),
        entity_type_hierarchy=json.dumps(req.entity_type_hierarchy),
        root_entity_types=json.dumps(req.root_entity_types),
        is_published=False,
        is_system=False,
        scope=row.scope or "universal",
    )
    session.add(new_row)
    await session.flush()

    await _record_audit(
        session, new_row, "imported",
        summary=(
            f"Imported as new draft v{new_row.version} "
            f"(from published v{row.version}): {summary_text}"
        ),
        changes=diff["type_diff"],
    )
    return OntologyImportResponse(
        ontology=_to_response(new_row),
        status="new_version",
        summary=(
            f"Created draft v{new_row.version} from import "
            f"(published v{row.version} is immutable): {summary_text}"
        ),
        changes=diff["type_diff"],
    )


