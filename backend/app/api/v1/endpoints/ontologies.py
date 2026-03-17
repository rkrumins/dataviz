"""
Admin Ontology endpoints — CRUD for ontology definitions.
Ontologies are standalone, versioned, reusable semantic configurations.
Published ontologies are immutable; updates create new versions.
System ontologies (is_system=True) cannot be deleted.
"""
from typing import List, Optional
from fastapi import APIRouter, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.db.engine import get_db_session
from backend.app.db.repositories import ontology_definition_repo
from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
from backend.app.ontology.resolver import (
    parse_entity_definitions,
    parse_relationship_definitions,
    validate_ontology,
)
from backend.app.ontology.service import LocalOntologyService
from backend.common.models.management import (
    OntologyCreateRequest,
    OntologyUpdateRequest,
    OntologyDefinitionResponse,
    OntologyCoverageResponse,
    OntologyValidationIssue,
    OntologyValidationResponse,
)
from backend.common.models.graph import GraphSchemaStats

router = APIRouter()


@router.get("", response_model=List[OntologyDefinitionResponse])
async def list_ontologies(
    all_versions: bool = False,
    session: AsyncSession = Depends(get_db_session),
):
    """List ontologies. By default returns only the latest version of each."""
    if all_versions:
        return await ontology_definition_repo.list_ontologies(session)
    return await ontology_definition_repo.list_latest_ontologies(session)


@router.post("", response_model=OntologyDefinitionResponse, status_code=201)
async def create_ontology(
    req: OntologyCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Create a new ontology (starts at version 1, unpublished)."""
    return await ontology_definition_repo.create_ontology(session, req)


@router.get("/{ontology_id}", response_model=OntologyDefinitionResponse)
async def get_ontology(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Get a specific ontology by ID."""
    ontology = await ontology_definition_repo.get_ontology(session, ontology_id)
    if not ontology:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    return ontology


@router.put("/{ontology_id}", response_model=OntologyDefinitionResponse)
async def update_ontology(
    ontology_id: str = Path(...),
    req: OntologyUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Update an ontology. If published, creates a new version instead.
    Returns the updated or newly created ontology.
    """
    ontology = await ontology_definition_repo.update_ontology(session, ontology_id, req)
    if not ontology:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    return ontology


@router.delete("/{ontology_id}", status_code=204)
async def delete_ontology(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """Delete an ontology. Rejects if data sources still reference it or if it's a system ontology."""
    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    if orm.is_system:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete a system ontology. Use the factory reset endpoint to restore defaults.",
        )
    if await ontology_definition_repo.has_data_sources(session, ontology_id):
        raise HTTPException(
            status_code=409,
            detail="Cannot delete ontology: one or more data sources still reference it.",
        )
    await ontology_definition_repo.delete_ontology(session, ontology_id)


@router.post("/{ontology_id}/publish", response_model=OntologyDefinitionResponse)
async def publish_ontology(
    ontology_id: str = Path(...),
    force: bool = Query(False, description="Bypass evolution_policy check (admin only)."),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Mark an ontology as published (immutable after this).

    Runs an impact check first. If the evolution_policy is 'reject' and the
    publish would remove existing types, the request is blocked with HTTP 409.
    Pass ?force=true to skip this guard (use with caution).
    """
    if not force:
        impact = await get_ontology_impact(ontology_id, session)
        if not impact["allowed"]:
            raise HTTPException(
                status_code=409,
                detail=impact["reason"],
            )

    ontology = await ontology_definition_repo.publish_ontology(session, ontology_id)
    if not ontology:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    return ontology


@router.post("/{ontology_id}/clone", response_model=OntologyDefinitionResponse, status_code=201)
async def clone_ontology(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Clone an existing ontology into a new editable draft.
    Useful for creating workspace-scoped customisations of the system default.
    """
    source = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")

    import json
    req = OntologyCreateRequest(
        name=f"{source.name} (copy)",
        version=1,
        scope="universal",
        containmentEdgeTypes=json.loads(source.containment_edge_types or "[]"),
        lineageEdgeTypes=json.loads(source.lineage_edge_types or "[]"),
        edgeTypeMetadata=json.loads(source.edge_type_metadata or "{}"),
        entityTypeHierarchy=json.loads(source.entity_type_hierarchy or "{}"),
        rootEntityTypes=json.loads(source.root_entity_types or "[]"),
        entityTypeDefinitions=json.loads(source.entity_type_definitions or "{}"),
        relationshipTypeDefinitions=json.loads(source.relationship_type_definitions or "{}"),
    )
    return await ontology_definition_repo.create_ontology(session, req)


@router.post("/{ontology_id}/validate", response_model=OntologyValidationResponse)
async def validate_ontology_endpoint(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Validate an ontology's entity and relationship definitions.
    Checks for containment cycles, unknown type references, missing names.
    Returns a list of validation issues (errors and warnings).
    """
    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")

    import json
    entity_defs = parse_entity_definitions(json.loads(orm.entity_type_definitions or "{}"))
    rel_defs = parse_relationship_definitions(json.loads(orm.relationship_type_definitions or "{}"))
    issues = validate_ontology(entity_defs, rel_defs)

    return OntologyValidationResponse(
        isValid=not any(i.severity == "error" for i in issues),
        issues=[
            OntologyValidationIssue(
                severity=i.severity, code=i.code, message=i.message, affected=i.affected
            )
            for i in issues
        ],
    )


@router.post("/{ontology_id}/coverage", response_model=OntologyCoverageResponse)
async def get_ontology_coverage(
    ontology_id: str = Path(...),
    stats: GraphSchemaStats = Body(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Analyse coverage of this ontology against a graph's schema stats.
    The caller provides GraphSchemaStats (from the /schema/stats endpoint).
    Returns which entity and relationship types are covered vs. uncovered.
    """
    repo = SQLAlchemyOntologyRepository(session)
    svc = LocalOntologyService(repo)
    report = await svc.check_coverage(ontology_id, stats)
    if report.coverage_percent == 0.0 and not report.covered_entity_types:
        orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
        if not orm:
            raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")

    return OntologyCoverageResponse(
        coveragePercent=report.coverage_percent,
        coveredEntityTypes=report.covered_entity_types,
        uncoveredEntityTypes=report.uncovered_entity_types,
        extraEntityTypes=report.extra_entity_types,
        coveredRelationshipTypes=report.covered_relationship_types,
        uncoveredRelationshipTypes=report.uncovered_relationship_types,
    )


@router.get("/{ontology_id}/impact", response_model=dict)
async def get_ontology_impact(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    Simulate the impact of publishing this ontology version.

    Compares the draft to the previously published version of the same ontology
    name and returns:
    - added entity / relationship types
    - removed entity / relationship types
    - changed definitions
    - whether publishing is allowed given the evolution_policy
    - the reason if it is blocked

    A 200 response does NOT publish — call /{id}/publish to commit.
    """
    import json

    draft_row = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not draft_row:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    if draft_row.is_published:
        raise HTTPException(status_code=409, detail="Ontology is already published.")

    # Find the latest published version of the same ontology name
    from sqlalchemy import select
    from backend.app.db.models import OntologyORM
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.name == draft_row.name)
        .where(OntologyORM.is_published == True)  # noqa: E712
        .order_by(OntologyORM.version.desc())
        .limit(1)
    )
    prev_row = result.scalar_one_or_none()

    draft_entities = set(json.loads(draft_row.entity_type_definitions or "{}").keys())
    draft_rels = set(json.loads(draft_row.relationship_type_definitions or "{}").keys())

    if prev_row is None:
        # First publish — no breaking changes possible
        return {
            "allowed": True,
            "reason": None,
            "addedEntityTypes": sorted(draft_entities),
            "removedEntityTypes": [],
            "addedRelationshipTypes": sorted(draft_rels),
            "removedRelationshipTypes": [],
        }

    prev_entities = set(json.loads(prev_row.entity_type_definitions or "{}").keys())
    prev_rels = set(json.loads(prev_row.relationship_type_definitions or "{}").keys())

    removed_entities = sorted(prev_entities - draft_entities)
    removed_rels = sorted(prev_rels - draft_rels)
    has_breaking = bool(removed_entities or removed_rels)

    policy = getattr(draft_row, "evolution_policy", "reject") or "reject"
    allowed = True
    reason = None

    if has_breaking and policy == "reject":
        allowed = False
        reason = (
            f"Evolution policy is 'reject' and publishing would remove "
            f"{len(removed_entities)} entity type(s) and "
            f"{len(removed_rels)} relationship type(s). "
            "Change the evolution_policy to 'deprecate' or 'migrate', "
            "or restore the removed types."
        )

    return {
        "allowed": allowed,
        "reason": reason,
        "evolutionPolicy": policy,
        "addedEntityTypes": sorted(draft_entities - prev_entities),
        "removedEntityTypes": removed_entities,
        "addedRelationshipTypes": sorted(draft_rels - prev_rels),
        "removedRelationshipTypes": removed_rels,
        # EXTENSION POINT: include per-field TypeDiff and affected data sources/views
        # when publish-confirmation UX needs richer blast-radius detail.
    }


@router.get("/{ontology_id}/assignments")
async def get_ontology_assignments(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
):
    """
    List all data sources (across all workspaces) currently assigned to this ontology.
    Returns [{workspaceId, workspaceName, dataSourceId, dataSourceLabel}].
    """
    row = await ontology_definition_repo.get_ontology(session, ontology_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    return await ontology_definition_repo.get_assignments(session, ontology_id)


@router.post("/suggest", response_model=OntologyCreateRequest, status_code=200)
async def suggest_ontology(
    stats: GraphSchemaStats = Body(...),
    base_ontology_id: Optional[str] = None,
    session: AsyncSession = Depends(get_db_session),
):
    """
    Suggest an ontology definition from graph schema stats.
    If base_ontology_id is provided, extends that ontology with new types found in the graph.
    The result is a draft OntologyCreateRequest — call POST /admin/ontologies to save it.
    """
    from backend.app.registry.provider_registry import provider_registry

    repo = SQLAlchemyOntologyRepository(session)
    svc = LocalOntologyService(repo)

    # We need OntologyMetadata for the suggest call — build a minimal one from stats
    from backend.common.models.graph import OntologyMetadata
    introspected = OntologyMetadata(
        containmentEdgeTypes=[],
        lineageEdgeTypes=[],
        edgeTypeMetadata={},
        entityTypeHierarchy={},
        rootEntityTypes=[],
    )

    return await svc.suggest_from_introspection(
        introspected_stats=stats,
        introspected_ontology=introspected,
        base_ontology_id=base_ontology_id,
    )
