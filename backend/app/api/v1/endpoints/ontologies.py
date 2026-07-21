"""
Admin Ontology endpoints — CRUD for ontology definitions.
Ontologies are standalone, versioned, reusable semantic configurations.
Published ontologies are immutable; updates create new versions.
System ontologies (is_system=True) cannot be deleted.
"""
from typing import List, Optional
from fastapi import APIRouter, BackgroundTasks, Body, Depends, HTTPException, Path, Query
from sqlalchemy.ext.asyncio import AsyncSession

from backend.app.api.v1.feature_gate import require_admin_unless, require_feature
from backend.app.auth.dependencies import requires, get_permission_claims
from backend.app.db.engine import get_db_session
from backend.app.db.repositories import ontology_definition_repo
from backend.app.ontology.adapters.sqlalchemy_repo import SQLAlchemyOntologyRepository
from backend.app.services.permission_service import PermissionClaims
from backend.app.services.workspace_visibility import (
    compute_visible_ontology_ids,
    ensure_ontology_visible,
)
from backend.app.ontology.resolver import (
    case_insensitive_type_id_collisions,
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
    OntologyMatchResult,
    OntologyResolutionResponse,
    OntologyResolutionRelGap,
    OntologyResolutionHierarchyGap,
    OntologySuggestResponse,
    OntologyValidationIssue,
    OntologyValidationResponse,
    OntologyAuditEntry,
    OntologyImportRequest,
    OntologyImportResponse,
)
from backend.common.models.graph import GraphSchemaStats
from backend.app.ontology import gate as ontology_gate

router = APIRouter()


# Phase 18 — per-endpoint gates. Reads are open to any workspace-bound
# user holding ``workspace:ontology:read`` (per-id lookups also enforce
# visibility — a viewer only sees ontologies referenced by a data
# source in one of their workspaces). Writes need ``workspace:ontology:manage``
# AND the same visibility check (a workspace_admin can only edit
# ontologies tied to a workspace they administer).
_REQUIRES_ONTOLOGY_READ = requires("workspace:ontology:read", workspace_any=True)
_REQUIRES_ONTOLOGY_MANAGE = requires("workspace:ontology:manage", workspace_any=True)


# ── Admin feature flags (Admin → Features) ────────────────────────────────────
#
# The six semantic-layer toggles were offered to admins and enforced NOWHERE: turning "Import"
# off left everyone importing. These are the gates that make them mean something. Declared in
# `config/feature_wiring.py`, held to the code by `tests/test_feature_wiring.py`.
#
# They are PER-ROUTE, not a router-wide `write_gate`, because on this router the HTTP method is
# not a reliable proxy for "this changes something": `/suggest`, `/validate`, `/coverage` and
# `/resolution-check` are POSTs that only ANALYSE. A method-based gate would take the analysis
# away with the editing, and analysis is exactly what you still want when the model is frozen.
#
# Two gates stack on a write:
#   * WHAT   — is editing available in this deployment at all?      (_GATE_EDIT)
#   * WHO    — may a non-admin perform it?                          (_GATE_WRITER)
# They answer different questions, so a write needs both. Reads carry neither.
_GATE_EDIT = require_feature("semanticLayerEditMode")
_GATE_WRITER = require_admin_unless("semanticLayerNonAdminEditing")
_GATE_IMPORT = require_feature("semanticLayerImportEnabled")
_GATE_EXPORT = require_feature("semanticLayerExportEnabled")
_GATE_SUGGEST = require_feature("semanticLayerAutoSuggest")
_GATE_HISTORY = require_feature("semanticLayerVersionHistory")

#: Content writes: create/update/delete/restore/new-version, and import (importing IS editing —
#: it just arrives as a file). Blocked when editing is off, and when a non-admin is refused.
_EDIT_GATES = [Depends(_GATE_EDIT), Depends(_GATE_WRITER)]

#: Lifecycle writes: publish and clone. Deliberately NOT gated by `_GATE_EDIT` — the product has
#: always promised that turning editing off still lets an admin publish, clone and export what
#: already exists. They still answer to `_GATE_WRITER`: they are writes, so "who may write?"
#: applies.
_LIFECYCLE_GATES = [Depends(_GATE_WRITER)]


async def _invalidate_ontology_caches(
    session: AsyncSession, ontology_id: Optional[str] = None,
    background: Optional[BackgroundTasks] = None,
) -> None:
    """Eagerly invalidate every cache layer keyed off ``ontology_id``.

    Bounded-latency by design: this used to loop over every assigned data
    source with an awaited Redis/DB round-trip each (3× over), which made
    publish/update O(assignments) inside the request — widely-assigned
    ontologies blew the frontend's 30s budget. Now:

    * assigned sources are enumerated ONCE,
    * generation bumps (the correctness-critical part — they make the next
      read re-resolve the new ontology) are pipelined into single Redis
      round-trips and stay synchronous,
    * the persisted schema facets reset in one set-based UPDATE,
    * the expensive LKG purge SCAN sweeps — cache hygiene, not correctness —
      run AFTER the response via ``background`` (inline when None, e.g.
      direct test calls), together with a post-commit re-bump that closes
      the bump-before-commit race (a read racing the write could otherwise
      cache pre-write rows under the new generation).

    No-op when ``ontology_id`` is None (e.g. seeding) or when the
    aggregation schema isn't loaded (test contexts).
    """
    if not ontology_id:
        return None
    try:
        from backend.app.services.aggregation.models import AggregationJobORM
    except ImportError:
        return None
    from sqlalchemy import update

    await session.execute(
        update(AggregationJobORM)
        .where(AggregationJobORM.ontology_id == ontology_id)
        .where(AggregationJobORM.ontology_fingerprint.isnot(None))
        .values(ontology_fingerprint=None)
    )

    # Enumerate the assigned data sources ONCE; every step below reuses it.
    try:
        from sqlalchemy import select
        from backend.app.db.models import WorkspaceDataSourceORM
        scopes = [
            (ws_id, ds_id)
            for (ws_id, ds_id) in (
                await session.execute(
                    select(
                        WorkspaceDataSourceORM.workspace_id,
                        WorkspaceDataSourceORM.id,
                    ).where(WorkspaceDataSourceORM.ontology_id == ontology_id)
                )
            ).all()
        ]
    except Exception as exc:  # never block the mutation on cache plumbing
        import logging
        logging.getLogger(__name__).warning(
            "could not enumerate data sources for ontology %s (caches fall "
            "back to TTL expiry): %s", ontology_id, exc)
        scopes = []
    if not scopes:
        return None

    # Invalidate the process-wide resolved-ontology cache for every data
    # source that resolves through this ontology — read paths on all pods
    # re-resolve on their next request instead of serving the old
    # containment/lineage/alias config for up to the TTL backstop.
    try:
        from backend.app.services.resolved_ontology_cache import bump_scopes
        await bump_scopes(scopes)
    except Exception as exc:  # never block the mutation on cache plumbing
        import logging
        logging.getLogger(__name__).warning(
            "resolved-ontology generation bump failed for %s: %s", ontology_id, exc)

    # Invalidate the PERSISTED schema cache (data_source_stats.graph_schema)
    # for the same sources — the frontend reads containment/lineage edge
    # types from that column; resetting it makes the next /cached-schema read
    # self-heal via build_synthetic_schema and the next deep poll rebuild it.
    try:
        from backend.app.db.repositories.stats_repo import invalidate_schema_facets
        await invalidate_schema_facets(session, [ds_id for (_ws, ds_id) in scopes])
    except Exception as exc:  # never block the mutation on cache plumbing
        import logging
        logging.getLogger(__name__).warning(
            "schema-facet invalidation failed for ontology %s: %s", ontology_id, exc)

    # Bump the hot-read GraphCache generation for the same data sources (the
    # /children-with-edges and /edges/aggregated responses embed the server-
    # side containment/lineage split). Known limitation: draft-branch entries
    # (branch_id != "") are not enumerated here and fall back to TTL expiry.
    try:
        from backend.app.services.graph_cache import bump_aggregated_generations
        await bump_aggregated_generations(scopes)
    except Exception as exc:  # never block the mutation on cache plumbing
        import logging
        logging.getLogger(__name__).warning(
            "graph-cache generation bump failed for ontology %s: %s", ontology_id, exc)

    # Deferred hygiene: purge LKG fallback entries (one Redis SCAN sweep per
    # source) and re-bump the generations once more AFTER the transaction has
    # committed (closes the bump-before-commit race). Runs post-response via
    # BackgroundTasks; inline when no task queue was provided (tests).
    async def _post_commit_sweep() -> None:
        try:
            from backend.app.services.graph_cache import purge_aggregated_lkg
            from backend.app.services.resolved_ontology_cache import bump_scopes as _rebump
            from backend.app.services.graph_cache import bump_aggregated_generations as _rebump_agg
            await _rebump(scopes)
            await _rebump_agg(scopes)
            await purge_aggregated_lkg(scopes)
        except Exception as exc:  # best-effort hygiene
            import logging
            logging.getLogger(__name__).warning(
                "post-commit cache sweep failed for ontology %s: %s", ontology_id, exc)

    if background is not None:
        background.add_task(_post_commit_sweep)
    else:
        await _post_commit_sweep()


def _reject_case_insensitive_type_dupes(req) -> None:
    """422 if the request DECLARES two entity or relationship type ids that differ only
    by case. This is the authoring-side half of the case-insensitive normalization mandate:
    a payload's ``Has``/``HAS``/``has`` is normalized to the declared casing at the commit
    boundary, which is only well-defined when each case-folded id maps to one declared id.

    Uniqueness is checked ONLY over the authoritative type-id sets — the
    ``entity_type_definitions`` and ``relationship_type_definitions`` keys. The
    ``containment_edge_types``/``lineage_edge_types`` lists are NOT type declarations; they
    are references to those relationship types (a type is flagged containment/lineage by
    appearing there). Folding them into this check conflated a reference with a declaration,
    so a client that spelled a reference in a different case than the declared id (e.g. a
    ``HAS`` reference against a declared ``Has``) was falsely rejected as a duplicate type.
    ``_normalize_edge_type_references`` reconciles that casing instead. Only fields present
    on the request are checked."""
    entity_ids = list((getattr(req, "entity_type_definitions", None) or {}).keys())
    edge_ids = list((getattr(req, "relationship_type_definitions", None) or {}).keys())
    collisions = case_insensitive_type_id_collisions(entity_ids, edge_ids)
    if collisions:
        raise HTTPException(status_code=422, detail="; ".join(collisions))


def _strip_system_types(req) -> None:
    """Drop platform-built-in types (e.g. the AGGREGATED edge — and any future built-in
    node) from an incoming payload — in place — so they are never persisted. They are
    injected on read (marked ``is_system``, shown read-only in the UI), so a save round-trip
    echoes them back; stripping here keeps the stored ontology to the user's own types and
    stops a built-in id from being stored, duplicated, or reconciled against."""
    from backend.app.ontology.defaults import is_system_edge_type, is_system_entity_type
    rel_defs = getattr(req, "relationship_type_definitions", None)
    if isinstance(rel_defs, dict):
        req.relationship_type_definitions = {
            k: v for k, v in rel_defs.items() if not is_system_edge_type(k)}
    entity_defs = getattr(req, "entity_type_definitions", None)
    if isinstance(entity_defs, dict):
        req.entity_type_definitions = {
            k: v for k, v in entity_defs.items() if not is_system_entity_type(k)}
    for field in ("containment_edge_types", "lineage_edge_types"):
        lst = getattr(req, field, None)
        if isinstance(lst, list):
            setattr(req, field, [t for t in lst if not is_system_edge_type(t)])
    lst = getattr(req, "root_entity_types", None)
    if isinstance(lst, list):
        setattr(req, "root_entity_types", [t for t in lst if not is_system_entity_type(t)])


def _normalize_edge_type_references(req) -> None:
    """Reconcile ``containment_edge_types``/``lineage_edge_types`` entries to the declared
    casing of the relationship type they reference, and de-duplicate case-insensitively —
    in place. These lists reference relationship types by id, so an entry must match a
    declared id exactly (FalkorDB is case-sensitive); a case variant is a spelling of the
    same reference, not a distinct type. Mirrors ``_reconcile_relationship_endpoints``:
    only runs when the request carries the relationship definitions to reconcile against;
    a lists-only partial update is left untouched. Never drops an entry — an entry that
    matches no declared type (case-insensitively) is preserved verbatim."""
    rel_defs = getattr(req, "relationship_type_definitions", None)
    if not rel_defs:
        return
    canonical = {str(k).lower(): str(k) for k in rel_defs}
    for field in ("containment_edge_types", "lineage_edge_types"):
        lst = getattr(req, field, None)
        if not isinstance(lst, list):
            continue
        seen: set = set()
        out: list = []
        for t in lst:
            resolved = canonical.get(str(t).lower(), t)
            key = str(resolved).lower()
            if key not in seen:
                seen.add(key)
                out.append(resolved)
        setattr(req, field, out)


def _reconcile_relationship_endpoints(req) -> None:
    """Authoring invariant: a relationship's source/target endpoint types may reference ONLY
    entity types declared in THIS ontology. Reconcile in place — drop references to types not
    declared (case-insensitive) — so the STORED ontology is self-consistent by construction:
    the read-time resolver filter becomes a harmless no-op and the displayed constraint is honest.
    A now-empty constraint means unrestricted (any → any).

    This closes the class of bug where an ontology's relationship types (e.g. a system-default
    ``FLOWS_TO`` with ``dataset``/``dataJob``/``column`` endpoints) are combined with a different
    entity-type set (e.g. a manual ontology's ``layer``/``object``/``group``/``attribute``) — a
    phantom, unsatisfiable constraint that silently blocks EVERY edge of that type. Only runs when
    the request carries BOTH the entity types and the relationships; a relationships-only partial
    update is left untouched (the read-time filter still covers it). Only ever removes references
    to undeclared types — never adds a constraint."""
    rel_defs = getattr(req, "relationship_type_definitions", None)
    ent_defs = getattr(req, "entity_type_definitions", None)
    if not rel_defs or not ent_defs:
        return
    declared = {str(k).lower() for k in ent_defs}
    for rel in rel_defs.values():
        if not isinstance(rel, dict):
            continue
        for key in ("source_types", "sourceTypes", "target_types", "targetTypes"):
            types = rel.get(key)
            if isinstance(types, list) and types:
                rel[key] = [t for t in types if str(t).lower() in declared]


@router.get("", response_model=List[OntologyDefinitionResponse])
async def list_ontologies(
    all_versions: bool = False,
    include_deleted: bool = Query(False, description="Include soft-deleted ontologies"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """List ontologies visible to the caller. By default returns only the latest version of each."""
    if all_versions:
        items = await ontology_definition_repo.list_ontologies(session, include_deleted=include_deleted)
    else:
        items = await ontology_definition_repo.list_latest_ontologies(session, include_deleted=include_deleted)
    visible_ids = await compute_visible_ontology_ids(session, claims)
    if visible_ids is None:
        return items
    # ``visible_ids`` is keyed on the latest-version id stored on
    # workspace_data_sources. For ``all_versions=True`` we also surface
    # historical rows of the same schema lineage; expand the visible
    # set to include every version whose ``schema_id`` matches.
    if all_versions:
        latest = [it for it in items if it.id in visible_ids]
        schema_ids = {getattr(it, "schema_id", None) or it.id for it in latest}
        return [it for it in items if (getattr(it, "schema_id", None) or it.id) in schema_ids]
    return [it for it in items if it.id in visible_ids]


@router.post("", response_model=OntologyDefinitionResponse, status_code=201,
             dependencies=_EDIT_GATES)
async def create_ontology(
    background: BackgroundTasks,
    req: OntologyCreateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """Create a new ontology (starts at version 1, unpublished)."""
    _strip_system_types(req)
    _reject_case_insensitive_type_dupes(req)
    _normalize_edge_type_references(req)
    _reconcile_relationship_endpoints(req)
    result = await ontology_definition_repo.create_ontology(session, req)
    await _invalidate_ontology_caches(session, getattr(result, "id", None), background)
    return result


@router.get("/{ontology_id}/versions", response_model=List[OntologyDefinitionResponse],
            dependencies=[Depends(_GATE_HISTORY)])
async def list_ontology_versions(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """List all versions of an ontology (grouped by schema_id)."""
    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)
    schema_id = getattr(orm, 'schema_id', None) or orm.id
    return await ontology_definition_repo.list_versions_by_schema(session, schema_id)


@router.get("/{ontology_id}", response_model=OntologyDefinitionResponse)
async def get_ontology(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """Get a specific ontology by ID."""
    ontology = await ontology_definition_repo.get_ontology(session, ontology_id)
    if not ontology:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)
    return ontology


@router.get("/{ontology_id}/export", dependencies=[Depends(_GATE_EXPORT)])
async def export_ontology(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """
    Export a full ontology definition as a downloadable JSON file.
    Returns the complete definition including entity types, relationship types,
    hierarchy, containment, lineage, and all metadata.
    """
    import json as _json
    from fastapi.responses import Response

    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

    export_data = {
        "id": orm.id,
        "name": orm.name,
        "description": orm.description,
        "version": orm.version,
        "scope": orm.scope or "universal",
        "evolutionPolicy": getattr(orm, "evolution_policy", "reject") or "reject",
        "isPublished": orm.is_published,
        "isSystem": orm.is_system,
        "createdAt": str(orm.created_at) if orm.created_at else None,
        "updatedAt": str(orm.updated_at) if orm.updated_at else None,
        "entityTypeDefinitions": _json.loads(orm.entity_type_definitions or "{}"),
        "relationshipTypeDefinitions": _json.loads(orm.relationship_type_definitions or "{}"),
        "containmentEdgeTypes": _json.loads(orm.containment_edge_types or "[]"),
        "lineageEdgeTypes": _json.loads(orm.lineage_edge_types or "[]"),
        "edgeTypeMetadata": _json.loads(orm.edge_type_metadata or "{}"),
        "entityTypeHierarchy": _json.loads(orm.entity_type_hierarchy or "{}"),
        "rootEntityTypes": _json.loads(orm.root_entity_types or "[]"),
    }

    filename = f"{orm.name.replace(' ', '_')}_v{orm.version}.json"
    return Response(
        content=_json.dumps(export_data, indent=2, default=str),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.put("/{ontology_id}", response_model=OntologyDefinitionResponse,
            dependencies=_EDIT_GATES)
async def update_ontology(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    req: OntologyUpdateRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Update an ontology. If published, creates a new version instead.
    Returns the updated or newly created ontology.
    """
    _strip_system_types(req)
    _reject_case_insensitive_type_dupes(req)
    _normalize_edge_type_references(req)
    _reconcile_relationship_endpoints(req)
    await ensure_ontology_visible(session, claims, ontology_id)
    ontology = await ontology_definition_repo.update_ontology(session, ontology_id, req)
    if not ontology:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    # Invalidate idempotency replays pinned to either the source ID
    # (in-place update) or the freshly minted version ID (published →
    # new-version path inside ``update_ontology``).
    await _invalidate_ontology_caches(session, ontology_id, background)
    new_id = getattr(ontology, "id", None)
    if new_id and new_id != ontology_id:
        await _invalidate_ontology_caches(session, new_id, background)
    return ontology


@router.delete("/{ontology_id}", status_code=204, dependencies=_EDIT_GATES)
async def delete_ontology(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """Delete an ontology. Rejects if data sources still reference it or if it's a system ontology."""
    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)
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
    await _invalidate_ontology_caches(session, ontology_id, background)


@router.post("/{ontology_id}/restore", response_model=OntologyDefinitionResponse,
             dependencies=_EDIT_GATES)
async def restore_ontology(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """Restore a soft-deleted ontology."""
    restored = await ontology_definition_repo.restore_ontology(session, ontology_id)
    if not restored:
        raise HTTPException(status_code=404, detail=f"No deleted ontology '{ontology_id}' found to restore")
    await _invalidate_ontology_caches(session, ontology_id, background)
    return restored


@router.post("/{ontology_id}/publish", response_model=OntologyDefinitionResponse,
             dependencies=_LIFECYCLE_GATES)
async def publish_ontology(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    force: bool = Query(False, description="Bypass evolution_policy check (admin only)."),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Mark an ontology as published (immutable after this).

    Runs an impact check first. If the evolution_policy is 'reject' and the
    publish would remove existing types, the request is blocked with HTTP 409.
    Pass ?force=true to skip this guard (use with caution).
    """
    await ensure_ontology_visible(session, claims, ontology_id)
    if not force:
        impact = await get_ontology_impact(ontology_id, session, claims=claims)
        if not impact["allowed"]:
            raise HTTPException(
                status_code=409,
                detail=impact["reason"],
            )

    ontology = await ontology_definition_repo.publish_ontology(session, ontology_id)
    if not ontology:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await _invalidate_ontology_caches(session, ontology_id, background)
    return ontology


@router.post("/{ontology_id}/clone", response_model=OntologyDefinitionResponse, status_code=201,
             dependencies=_LIFECYCLE_GATES)
async def clone_ontology(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Clone an existing ontology into a new editable draft.
    Useful for creating workspace-scoped customisations of the system default.
    """
    source = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

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
    result = await ontology_definition_repo.create_ontology(session, req)
    await _invalidate_ontology_caches(session, getattr(result, "id", None), background)
    return result


@router.post("/{ontology_id}/new-version", response_model=OntologyDefinitionResponse,
             status_code=201, dependencies=_EDIT_GATES)
async def create_new_version(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Create a new draft version of an existing ontology within the same schema lineage.

    The source ontology must be published or system. Copies all definitions into a new
    draft with version = max + 1 and the same schema_id. Returns 409 if a draft already
    exists for this schema (edit that draft instead).
    """
    source = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not source:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)
    if not source.is_published and not source.is_system:
        raise HTTPException(
            status_code=409,
            detail="Only published or system ontologies can spawn new versions. Edit the existing draft instead.",
        )
    schema_id = source.schema_id or source.id
    existing_draft = await ontology_definition_repo.get_draft_for_schema(session, schema_id)
    if existing_draft:
        raise HTTPException(
            status_code=409,
            detail=f"A draft version (v{existing_draft.version}) already exists for this schema. Edit it instead.",
        )
    result = await ontology_definition_repo.create_new_version_from_source(session, source)
    await _invalidate_ontology_caches(session, getattr(result, "id", None), background)
    return result


@router.post("/{ontology_id}/validate", response_model=OntologyValidationResponse)
async def validate_ontology_endpoint(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """
    Validate an ontology's entity and relationship definitions.
    Checks for containment cycles, unknown type references, missing names.
    Returns a list of validation issues (errors and warnings).
    """
    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

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
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """
    Analyse coverage of this ontology against a graph's schema stats.
    The caller provides GraphSchemaStats (from the /schema/stats endpoint).
    Returns which entity and relationship types are covered vs. uncovered.
    """
    await ensure_ontology_visible(session, claims, ontology_id)
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


@router.get("/{ontology_id}/adoption")
async def get_ontology_adoption(
    ontology_id: str = Path(...),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    search: str = Query("", max_length=200),
    filter: str = Query("all", pattern="^(all|drift|unmapped|unprofiled|exact)$"),
    sort: str = Query("match", pattern="^(match|issues|label|freshness)$"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """Per-data-source declared-vs-physical type match for the data sources using this
    ontology, computed from the CACHED profiling stats (the insights service).

    Strategic + performant + browsable at scale (100s of sources): one assignments query
    + one bulk stats read, then pure in-process classification — NO live graph queries.
    The AGGREGATE (hero) and FACETS (filter counts) are computed over ALL sources so they
    stay accurate; ``search``/``filter``/``sort`` then narrow the set and only one page
    (``limit``/``offset``) of sources is returned. ``filter=drift|unmapped`` and the
    worst-first default sort surface mismatches immediately. Each physical type is
    classified exact / case-drift / unmapped (``adoption.py``); the platform built-in
    edges (AGGREGATED) are injected into the declared set so they never read as unmapped.
    """
    import json as _json

    from backend.app.db.repositories import stats_repo
    from backend.app.ontology.adoption import build_source_adoption, dimension_to_wire
    from backend.app.ontology.defaults import with_system_edge_types, with_system_entity_types

    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

    entity_ids = set(with_system_entity_types(_json.loads(orm.entity_type_definitions or "{}")).keys())
    edge_ids = set(with_system_edge_types(_json.loads(orm.relationship_type_definitions or "{}")).keys())

    assignments = await ontology_definition_repo.get_assignments(session, ontology_id)
    stats_rows = await stats_repo.list_data_source_stats(
        session, [a["dataSourceId"] for a in assignments])
    stats_by_ds = {s.data_source_id: s for s in stats_rows}

    records: list = []
    agg_exact = agg_total = agg_exact_types = agg_total_types = 0
    agg_drift_inst = agg_unmap_inst = 0
    drift_count = unmapped_count = profiled_count = 0

    for a in assignments:
        base = {
            "dataSourceId": a["dataSourceId"], "dataSourceLabel": a["dataSourceLabel"],
            "workspaceId": a["workspaceId"], "workspaceName": a["workspaceName"],
        }
        searchable = f"{a['dataSourceLabel']} {a['workspaceName']}".lower()
        st = stats_by_ds.get(a["dataSourceId"])
        raw = getattr(st, "schema_stats", None) if st else None
        if not raw:
            wire = {**base, "profiled": False, "schemaUpdatedAt": None,
                    "matchWeighted": None, "matchByType": None, "nodes": None, "edges": None}
            records.append({"wire": wire, "profiled": False, "match": None, "drift": 0,
                            "unmapped": 0, "search": searchable, "label": a["dataSourceLabel"], "updated": ""})
            continue
        try:
            schema_stats = _json.loads(raw)
        except (ValueError, TypeError):
            schema_stats = {}
        adopt = build_source_adoption(entity_ids=entity_ids, edge_ids=edge_ids, schema_stats=schema_stats)
        profiled_count += 1
        agg_exact += adopt.nodes.exact_instances + adopt.edges.exact_instances
        agg_total += adopt.nodes.total_instances + adopt.edges.total_instances
        agg_exact_types += len(adopt.nodes.exact) + len(adopt.edges.exact)
        agg_total_types += adopt.nodes.total_types + adopt.edges.total_types
        d = len(adopt.nodes.case_drift) + len(adopt.edges.case_drift)
        u = len(adopt.nodes.unmapped) + len(adopt.edges.unmapped)
        drift_count += d
        unmapped_count += u
        agg_drift_inst += adopt.nodes.drift_instances + adopt.edges.drift_instances
        agg_unmap_inst += adopt.nodes.unmapped_instances + adopt.edges.unmapped_instances
        wire = {
            **base, "profiled": True, "schemaUpdatedAt": getattr(st, "schema_updated_at", None),
            "matchWeighted": adopt.match_weighted, "matchByType": adopt.match_by_type,
            "nodes": dimension_to_wire(adopt.nodes), "edges": dimension_to_wire(adopt.edges),
        }
        records.append({"wire": wire, "profiled": True, "match": adopt.match_weighted, "drift": d,
                        "unmapped": u, "search": searchable, "label": a["dataSourceLabel"],
                        "updated": getattr(st, "schema_updated_at", None) or ""})

    def _pct(part: float, whole: float) -> float:
        return round(part / whole * 100, 1) if whole else 100.0

    # Facet counts over ALL sources (drive the filter chips, always accurate).
    facets = {
        "all": len(records),
        "drift": sum(1 for r in records if r["drift"] > 0),
        "unmapped": sum(1 for r in records if r["unmapped"] > 0),
        "unprofiled": sum(1 for r in records if not r["profiled"]),
        "exact": sum(1 for r in records if r["profiled"] and r["drift"] == 0 and r["unmapped"] == 0),
    }

    q = search.strip().lower()

    def _keep(r: dict) -> bool:
        if q and q not in r["search"]:
            return False
        if filter == "drift":
            return r["drift"] > 0
        if filter == "unmapped":
            return r["unmapped"] > 0
        if filter == "unprofiled":
            return not r["profiled"]
        if filter == "exact":
            return r["profiled"] and r["drift"] == 0 and r["unmapped"] == 0
        return True

    filtered = [r for r in records if _keep(r)]

    if sort == "issues":                                   # most mismatches first
        filtered.sort(key=lambda r: (-(r["drift"] + r["unmapped"]), r["match"] if r["match"] is not None else 101))
    elif sort == "label":
        filtered.sort(key=lambda r: r["label"].lower())
    elif sort == "freshness":                              # most recently profiled first
        filtered.sort(key=lambda r: r["updated"], reverse=True)
    else:                                                  # match — worst first, unprofiled last
        filtered.sort(key=lambda r: (0 if r["profiled"] else 1, r["match"] if r["match"] is not None else 101))

    total = len(filtered)
    page = filtered[offset:offset + limit]

    return {
        "ontologyId": ontology_id,
        "sourceCount": len(assignments),
        "profiledCount": profiled_count,
        "matchWeighted": _pct(agg_exact, agg_total),
        "matchByType": _pct(agg_exact_types, agg_total_types),
        "driftTypeCount": drift_count,
        "unmappedTypeCount": unmapped_count,
        "segments": {
            "weighted": {"exact": agg_exact, "drift": agg_drift_inst, "unmapped": agg_unmap_inst},
            "byType": {
                "exact": agg_exact_types,
                "drift": drift_count,
                "unmapped": unmapped_count,
            },
        },
        "facets": facets,
        "total": total,
        "limit": limit,
        "offset": offset,
        "sources": [r["wire"] for r in page],
    }


@router.get("/{ontology_id}/coverage-ranking")
async def get_ontology_coverage_ranking(
    ontology_id: str = Path(...),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    search: str = Query("", max_length=200),
    filter: str = Query("all", pattern="^(all|unassigned|assigned-other|assigned-this)$"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """Rank ALL data sources (across all workspaces) by how well this ontology
    covers their CACHED profiled schema — the server-side "Best Matches" that
    replaces the frontend's 2-requests-per-source fan-out.

    Same skeleton as ``/adoption``: one candidate query + one bulk stats read +
    pure in-process compute (``resolver.check_coverage`` with system types
    injected — the exact contract of ``POST /{id}/coverage``, so both surfaces
    report identical percentages). Facets are computed over ALL candidates;
    ``search``/``filter`` narrow the set; one page is returned, sorted best
    coverage first with unprofiled sources last. Sources without cached stats
    return ``profiled=false`` rather than erroring.

    Scale note: reads cached stats for every source platform-wide per request —
    fine for 100s of sources; add a candidate cap before fleets reach 1000s.
    """
    import json as _json

    from backend.app.db.repositories import stats_repo
    from backend.app.ontology.defaults import with_system_edge_types, with_system_entity_types
    from backend.app.ontology.resolver import check_coverage

    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

    entity_defs = parse_entity_definitions(
        with_system_entity_types(_json.loads(orm.entity_type_definitions or "{}")))
    rel_defs = parse_relationship_definitions(
        with_system_edge_types(_json.loads(orm.relationship_type_definitions or "{}")))

    candidates = await ontology_definition_repo.list_all_data_sources(session)
    stats_rows = await stats_repo.list_data_source_stats(
        session, [c["dataSourceId"] for c in candidates])
    stats_by_ds = {s.data_source_id: s for s in stats_rows}

    records = []
    profiled_count = 0
    for c in candidates:
        st = stats_by_ds.get(c["dataSourceId"])
        raw = getattr(st, "schema_stats", None) if st else None
        coverage_percent = None
        uncovered_entities = uncovered_rels = 0
        profiled = False
        if raw:
            try:
                schema_stats = _json.loads(raw)
            except (ValueError, TypeError):
                schema_stats = {}
            ent_ids = [s["id"] for s in schema_stats.get("entityTypeStats") or []
                       if isinstance(s, dict) and s.get("id")]
            rel_ids = [s["id"] for s in schema_stats.get("edgeTypeStats") or []
                       if isinstance(s, dict) and s.get("id")]
            report = check_coverage(entity_defs, rel_defs, ent_ids, rel_ids)
            profiled = True
            profiled_count += 1
            coverage_percent = report.coverage_percent
            uncovered_entities = len(report.uncovered_entity_types)
            uncovered_rels = len(report.uncovered_relationship_types)
        if c["ontologyId"] == ontology_id:
            category = "assigned-this"
        elif c["ontologyId"]:
            category = "assigned-other"
        else:
            category = "unassigned"
        records.append({
            "wire": {
                "workspaceId": c["workspaceId"],
                "workspaceName": c["workspaceName"],
                "dataSourceId": c["dataSourceId"],
                "dataSourceLabel": c["dataSourceLabel"],
                "currentOntologyId": c["ontologyId"],
                "profiled": profiled,
                "coveragePercent": coverage_percent,
                "uncoveredEntityCount": uncovered_entities,
                "uncoveredRelationshipCount": uncovered_rels,
            },
            "category": category,
            "profiled": profiled,
            "coverage": coverage_percent,
            "search": f"{c['dataSourceLabel']} {c['workspaceName']}".lower(),
        })

    facets = {
        "all": len(records),
        "unassigned": sum(1 for r in records if r["category"] == "unassigned"),
        "assignedOther": sum(1 for r in records if r["category"] == "assigned-other"),
        "assignedThis": sum(1 for r in records if r["category"] == "assigned-this"),
    }

    q = search.strip().lower()
    filtered = [
        r for r in records
        if (not q or q in r["search"]) and (filter == "all" or r["category"] == filter)
    ]
    # Best coverage first; unprofiled sources sink to the bottom.
    filtered.sort(key=lambda r: (0 if r["profiled"] else 1,
                                 -(r["coverage"] if r["coverage"] is not None else 0)))

    total = len(filtered)
    page = filtered[offset:offset + limit]

    return {
        "ontologyId": ontology_id,
        "total": total,
        "limit": limit,
        "offset": offset,
        "profiledCount": profiled_count,
        "facets": facets,
        "sources": [r["wire"] for r in page],
    }


@router.post("/{ontology_id}/resolution-check", response_model=OntologyResolutionResponse)
async def check_ontology_resolution(
    ontology_id: str = Path(...),
    stats: GraphSchemaStats = Body(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """Run the ontology-resolution gate against an arbitrary set of
    introspected graph stats.

    Used by the AssetOnboardingWizard SchemaReviewStep before any data
    source has been created. The data-source-keyed counterpart
    (``GET /admin/data-sources/{ds_id}/ontology-resolution``) reuses the
    same gate against the cached stats already attached to the data
    source.
    """
    import json as _json

    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

    introspected_entity_ids = [s.id for s in stats.entity_type_stats if getattr(s, "id", None)]
    introspected_edge_ids = [s.id for s in stats.edge_type_stats if getattr(s, "id", None)]

    report = ontology_gate.check_resolution(
        ontology_id=orm.id,
        ontology_version=orm.version,
        ontology_is_published=bool(orm.is_published),
        ontology_revision=getattr(orm, "revision", 0) or 0,
        entity_type_definitions_raw=_json.loads(orm.entity_type_definitions or "{}"),
        relationship_type_definitions_raw=_json.loads(orm.relationship_type_definitions or "{}"),
        introspected_entity_ids=introspected_entity_ids,
        introspected_edge_ids=introspected_edge_ids,
        containment_edge_types=_json.loads(orm.containment_edge_types or "[]"),
        lineage_edge_types=_json.loads(orm.lineage_edge_types or "[]"),
    )

    return OntologyResolutionResponse(
        resolved=report.resolved,
        ontologyId=report.ontology_id,
        ontologyVersion=report.ontology_version,
        ontologyIsPublished=report.ontology_is_published,
        missingEntityTypes=report.missing_entity_types,
        missingEdgeTypes=report.missing_edge_types,
        unclassifiedRelationships=[
            OntologyResolutionRelGap(
                id=g.id,
                name=g.name,
                isContainment=g.is_containment,
                isLineage=g.is_lineage,
            )
            for g in report.unclassified_relationships
        ],
        hasLineage=report.has_lineage,
        hasContainment=report.has_containment,
        hierarchyWarnings=[
            OntologyResolutionHierarchyGap(
                entityType=g.entity_type,
                missingField=g.missing_field,
            )
            for g in report.hierarchy_warnings
        ],
        advisoryWarnings=report.advisory_warnings,
        blockingReasons=report.blocking_reasons,
        coveragePercent=report.coverage_percent,
        fingerprint=report.fingerprint,
    )


@router.get("/{ontology_id}/impact", response_model=dict)
async def get_ontology_impact(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: Optional[PermissionClaims] = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
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
    # ``claims`` is None when called internally (e.g. from publish_ontology
    # which authorised the caller already). When it's populated (the HTTP
    # path), enforce visibility too.
    if claims is not None:
        await ensure_ontology_visible(session, claims, ontology_id)
    if draft_row.is_published:
        raise HTTPException(status_code=409, detail="Ontology is already published.")

    # Find the latest published version of the same ontology (by schema_id)
    from sqlalchemy import select
    from backend.app.db.models import OntologyORM
    schema_id = getattr(draft_row, 'schema_id', None) or draft_row.id
    result = await session.execute(
        select(OntologyORM)
        .where(OntologyORM.schema_id == schema_id)
        .where(OntologyORM.is_published == True)  # noqa: E712
        .order_by(OntologyORM.version.desc())
        .limit(1)
    )
    prev_row = result.scalar_one_or_none()

    draft_entities = set(json.loads(draft_row.entity_type_definitions or "{}").keys())
    draft_rels = set(json.loads(draft_row.relationship_type_definitions or "{}").keys())
    policy = getattr(draft_row, "evolution_policy", "reject") or "reject"

    if prev_row is None:
        # First publish — no breaking changes possible
        return {
            "allowed": True,
            "reason": None,
            "evolutionPolicy": policy,
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
    allowed = True
    reason = None

    if has_breaking and policy == "reject":
        allowed = False
        reason = (
            f"Publishing would remove {len(removed_entities)} entity type(s) and "
            f"{len(removed_rels)} relationship type(s) still present in the previous "
            "published version. Restore the removed types, or (administrators) "
            "force-publish to override breaking-change protection."
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


@router.get("/{ontology_id}/source-mappings")
async def get_ontology_source_mappings(
    ontology_id: str = Path(...),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    search: str = Query("", max_length=200),
    filter: str = Query("all", pattern="^(all|drift|pending|unprofiled)$"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """Per-assigned-source vocabulary alignment profiles for this ontology.

    Aggregates the ``ontology_source_mappings`` rows (declared → observed
    spelling maps, drift flags) across every data source currently assigned
    to the ontology, so the Schema page's Health tab can render one alias
    table instead of per-source warnings. Read-only; Keep/Split decisions go
    through ``POST /{ws}/graph/vocab-alignment/confirm``.

    Browsable at 100s of sources: one assignments query + one bulk mappings
    query; facet counts are computed over ALL assignments, then ``search`` /
    ``filter`` narrow the set and only one page of rows (with their mapping
    JSON) is returned. Sorted decisions-pending first, then drift, then label.
    """
    import json

    row = await ontology_definition_repo.get_ontology(session, ontology_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)

    from backend.app.db.repositories import ontology_source_mapping_repo as osm_repo

    assignments = await ontology_definition_repo.get_assignments(session, ontology_id)
    mappings = await osm_repo.list_mappings_for_ontology(
        session, ontology_id, [a["dataSourceId"] for a in assignments])

    records = []
    for a in assignments:
        mapping = mappings.get(a["dataSourceId"])
        entity_mappings: dict = {}
        rel_mappings: dict = {}
        drift_details: list = []
        has_drift = False
        last_seen_at = None
        if mapping is not None:
            try:
                entity_mappings = json.loads(mapping.entity_type_mappings or "{}")
                rel_mappings = json.loads(mapping.relationship_type_mappings or "{}")
                drift_details = json.loads(mapping.drift_details) if mapping.drift_details else []
            except (ValueError, TypeError):
                pass
            has_drift = bool(mapping.has_drift)
            last_seen_at = mapping.last_seen_at
        pending = sum(1 for d in drift_details if isinstance(d, dict) and d.get("needsConfirmation"))
        records.append({
            "wire": {
                "workspaceId": a["workspaceId"],
                "workspaceName": a["workspaceName"],
                "dataSourceId": a["dataSourceId"],
                "dataSourceLabel": a["dataSourceLabel"],
                "hasProfile": mapping is not None,
                "hasDrift": has_drift,
                "lastSeenAt": last_seen_at,
                "entityMappings": entity_mappings,
                "relationshipMappings": rel_mappings,
                "driftDetails": drift_details,
            },
            "profiled": mapping is not None,
            "drift": has_drift,
            "pending": pending,
            "search": f"{a['dataSourceLabel']} {a['workspaceName']}".lower(),
            "label": a["dataSourceLabel"],
        })

    # Facet counts over ALL assignments (drive the filter chips, always accurate).
    facets = {
        "all": len(records),
        "drift": sum(1 for r in records if r["drift"]),
        "pending": sum(1 for r in records if r["pending"] > 0),
        "unprofiled": sum(1 for r in records if not r["profiled"]),
    }

    q = search.strip().lower()

    def _keep(r: dict) -> bool:
        if q and q not in r["search"]:
            return False
        if filter == "drift":
            return bool(r["drift"])
        if filter == "pending":
            return r["pending"] > 0
        if filter == "unprofiled":
            return not r["profiled"]
        return True

    filtered = [r for r in records if _keep(r)]
    # Decision-bearing rows first, then drifted, then alphabetical.
    filtered.sort(key=lambda r: (-r["pending"], not r["drift"], r["label"].lower()))

    total = len(filtered)
    page = filtered[offset:offset + limit]

    return {
        "ontologyId": ontology_id,
        "total": total,
        "limit": limit,
        "offset": offset,
        "facets": facets,
        "sources": [r["wire"] for r in page],
    }


@router.get("/{ontology_id}/assignments")
async def get_ontology_assignments(
    ontology_id: str = Path(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """
    List all data sources (across all workspaces) currently assigned to this ontology.
    Returns [{workspaceId, workspaceName, dataSourceId, dataSourceLabel}].
    """
    row = await ontology_definition_repo.get_ontology(session, ontology_id)
    if not row:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)
    return await ontology_definition_repo.get_assignments(session, ontology_id)


@router.get("/{ontology_id}/audit", response_model=List[OntologyAuditEntry],
            dependencies=[Depends(_GATE_HISTORY)])
async def get_ontology_audit_log(
    ontology_id: str = Path(...),
    action: Optional[str] = Query(None, description="Filter by action type (created, updated, published, deleted, restored, cloned)"),
    limit: int = Query(100, ge=1, le=500, description="Max results per page"),
    offset: int = Query(0, ge=0, description="Pagination offset"),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_READ),
):
    """
    Return the audit trail for an ontology (all versions sharing the same schema_id).
    Includes create, update, publish, delete, restore, and clone events with
    change diffs and actor information. Paginated, newest first.
    """
    orm = await ontology_definition_repo.get_ontology_orm(session, ontology_id)
    if not orm:
        raise HTTPException(status_code=404, detail=f"Ontology '{ontology_id}' not found")
    await ensure_ontology_visible(session, claims, ontology_id)
    schema_id = getattr(orm, "schema_id", None) or orm.id
    return await ontology_definition_repo.get_audit_log(
        session, schema_id, action=action, limit=limit, offset=offset,
    )


@router.post("/import", response_model=OntologyImportResponse, status_code=200,
             dependencies=[Depends(_GATE_IMPORT), *_EDIT_GATES])
async def import_ontology_new(
    background: BackgroundTasks,
    req: OntologyImportRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Import a semantic layer from exported JSON, creating a new draft.
    Validates the JSON structure against the export format.
    """
    _strip_system_types(req)
    _reject_case_insensitive_type_dupes(req)
    _normalize_edge_type_references(req)
    _reconcile_relationship_endpoints(req)
    try:
        result = await ontology_definition_repo.import_ontology(session, req, target_id=None)
        await _invalidate_ontology_caches(session, getattr(result, "ontology_id", None), background)
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/{ontology_id}/import", response_model=OntologyImportResponse, status_code=200,
             dependencies=[Depends(_GATE_IMPORT), *_EDIT_GATES])
async def import_ontology_into(
    background: BackgroundTasks,
    ontology_id: str = Path(...),
    req: OntologyImportRequest = Body(...),
    session: AsyncSession = Depends(get_db_session),
    claims: PermissionClaims = Depends(get_permission_claims),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Import a semantic layer from exported JSON into an existing ontology.

    Behavior:
    - Draft target → updates in-place (same version), records audit trail.
    - Published target → creates a new draft version with the imported changes.
    - Deleted target → rejected (restore first).
    - System target → rejected (clone first).
    - No changes detected → returns status="no_changes" without modification.
    """
    _reject_case_insensitive_type_dupes(req)
    _reconcile_relationship_endpoints(req)
    await ensure_ontology_visible(session, claims, ontology_id)
    try:
        result = await ontology_definition_repo.import_ontology(session, req, target_id=ontology_id)
        await _invalidate_ontology_caches(session, ontology_id, background)
        target_after = getattr(result, "ontology_id", None)
        if target_after and target_after != ontology_id:
            await _invalidate_ontology_caches(session, target_after, background)
        return result
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))


@router.post("/suggest", response_model=OntologySuggestResponse, status_code=200,
             dependencies=[Depends(_GATE_SUGGEST)])
async def suggest_ontology(
    stats: GraphSchemaStats = Body(...),
    base_ontology_id: Optional[str] = None,
    min_score: float = Query(
        0.1,
        ge=0.0,
        le=1.0,
        description=(
            "Drop ontologies scoring below this Jaccard overlap. The default (0.1) "
            "keeps the suggestion list to plausible candidates. Pass 0 to score EVERY "
            "ontology — the Add/Move Data Source wizard does this so that a layer the "
            "user expands to see carries the same numbers and warnings as the top "
            "matches, instead of appearing with no score at all."
        ),
    ),
    session: AsyncSession = Depends(get_db_session),
    _auth=Depends(_REQUIRES_ONTOLOGY_MANAGE),
):
    """
    Suggest an ontology definition from graph schema stats.
    If base_ontology_id is provided, extends that ontology with new types found in the graph.
    The result includes a draft OntologyCreateRequest and matching existing ontologies.
    Call POST /admin/ontologies to save the suggestion.
    """
    from backend.app.registry.provider_registry import provider_registry

    repo = SQLAlchemyOntologyRepository(session)
    svc = LocalOntologyService(repo)

    suggestion = await svc.suggest_from_introspection(
        introspected_stats=stats,
        base_ontology_id=base_ontology_id,
    )

    # Find matching existing ontologies
    graph_entity_ids = {s.id for s in stats.entity_type_stats}
    graph_rel_ids = {s.id.upper() for s in stats.edge_type_stats}
    graph_types = graph_entity_ids | graph_rel_ids

    from backend.app.ontology.defaults import with_system_edge_types, with_system_entity_types

    matches = []
    if graph_types:
        all_ontologies = await ontology_definition_repo.list_latest_ontologies(session)
        for ont in all_ontologies:
            # Include the platform's built-in types so :AGGREGATED (present in every graph
            # that's been aggregated) never reads as a "missing" type against any ontology.
            ont_entity_ids = set(with_system_entity_types(ont.entity_type_definitions or {}).keys())
            ont_rel_ids = set(with_system_edge_types(ont.relationship_type_definitions or {}).keys())
            ont_types = ont_entity_ids | ont_rel_ids

            intersection = graph_types & ont_types
            union = graph_types | ont_types
            jaccard = len(intersection) / len(union) if union else 0.0

            if jaccard >= min_score:
                matches.append(OntologyMatchResult(
                    ontologyId=ont.id,
                    ontologyName=ont.name,
                    version=ont.version,
                    jaccardScore=round(jaccard, 3),
                    coveredEntityTypes=sorted(graph_entity_ids & ont_entity_ids),
                    uncoveredEntityTypes=sorted(graph_entity_ids - ont_entity_ids),
                    coveredRelationshipTypes=sorted(graph_rel_ids & ont_rel_ids),
                    uncoveredRelationshipTypes=sorted(graph_rel_ids - ont_rel_ids),
                    totalEntityTypes=len(ont_entity_ids),
                    totalRelationshipTypes=len(ont_rel_ids),
                ))

        matches.sort(key=lambda m: m.jaccard_score, reverse=True)

    # Surface the suggester's case-variant merges structurally (Task E §1c) so the review
    # UI can show "this graph spells HAS 3 ways — merged into one" with a split affordance.
    from backend.app.ontology.defaults import SYSTEM_ENTITY_TYPES, SYSTEM_RELATIONSHIP_TYPES
    from backend.app.ontology.resolver import collect_merged_variants
    merged_variants: dict = {}
    merged_variants.update(collect_merged_variants(stats.entity_type_stats, SYSTEM_ENTITY_TYPES))
    merged_variants.update(collect_merged_variants(stats.edge_type_stats, SYSTEM_RELATIONSHIP_TYPES))

    return OntologySuggestResponse(
        suggested=suggestion,
        matchingOntologies=matches[:5],
        mergedVariants=merged_variants,
    )
