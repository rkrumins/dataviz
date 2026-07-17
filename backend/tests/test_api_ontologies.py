"""
Phase 4 — API endpoint tests for /api/v1/admin/ontologies/*.

Tests the ontology definition CRUD and publish endpoints using the
test_client fixture with auth and DB overrides.
"""
import pytest
from httpx import AsyncClient


# ── Helper ────────────────────────────────────────────────────────────

def _ontology_payload(name: str = "Test Ontology", **overrides) -> dict:
    base = {
        "name": name,
        "description": "An ontology for testing",
        "version": 1,
        "scope": "universal",
        "containmentEdgeTypes": ["CONTAINS"],
        "lineageEdgeTypes": ["LINEAGE"],
        "edgeTypeMetadata": {},
        "entityTypeHierarchy": {},
        "rootEntityTypes": ["Database"],
        "entityTypeDefinitions": {
            "Database": {"label": "Database", "icon": "database"},
            "Table": {"label": "Table", "icon": "table"},
        },
        "relationshipTypeDefinitions": {
            "CONTAINS": {"label": "Contains"},
            "LINEAGE": {"label": "Lineage"},
        },
    }
    base.update(overrides)
    return base


async def _create_ontology(client: AsyncClient, name: str = "Test Ontology") -> dict:
    """Create an ontology and return its JSON body."""
    resp = await client.post(
        "/api/v1/admin/ontologies",
        json=_ontology_payload(name),
    )
    assert resp.status_code == 201
    return resp.json()


# ── GET /admin/ontologies ─────────────────────────────────────────────

async def test_list_ontologies_empty(test_client: AsyncClient):
    """Initially the ontology list is empty."""
    resp = await test_client.get("/api/v1/admin/ontologies")
    assert resp.status_code == 200
    assert resp.json() == []


# ── POST /admin/ontologies ────────────────────────────────────────────

async def test_create_ontology(test_client: AsyncClient):
    """Create an ontology returns 201 with the created resource."""
    body = await _create_ontology(test_client, "Create Test")
    assert body["name"] == "Create Test"
    assert "id" in body
    assert body.get("isPublished") is False


async def test_create_ontology_minimal(test_client: AsyncClient):
    """Create with only the required name field."""
    resp = await test_client.post(
        "/api/v1/admin/ontologies",
        json={"name": "Minimal Ontology"},
    )
    assert resp.status_code == 201


# ── GET /admin/ontologies/{id} ────────────────────────────────────────

async def test_get_ontology(test_client: AsyncClient):
    """Fetch a created ontology by ID."""
    created = await _create_ontology(test_client, "Fetch Test")
    ont_id = created["id"]

    resp = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}")
    assert resp.status_code == 200
    assert resp.json()["id"] == ont_id


async def test_get_ontology_not_found(test_client: AsyncClient):
    """Fetching a non-existent ontology returns 404."""
    resp = await test_client.get("/api/v1/admin/ontologies/ont_ghost")
    assert resp.status_code == 404


# ── PUT /admin/ontologies/{id} ────────────────────────────────────────

async def test_update_ontology_name(test_client: AsyncClient):
    """Update the name of an ontology."""
    created = await _create_ontology(test_client, "Old Name")
    ont_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/admin/ontologies/{ont_id}",
        json={"name": "New Name"},
    )
    assert resp.status_code == 200
    assert resp.json()["name"] == "New Name"


async def test_update_ontology_not_found(test_client: AsyncClient):
    """Updating a non-existent ontology returns 404."""
    resp = await test_client.put(
        "/api/v1/admin/ontologies/ont_nope",
        json={"name": "Nope"},
    )
    assert resp.status_code == 404


async def test_update_ontology_definitions(test_client: AsyncClient):
    """Update entity and relationship type definitions."""
    created = await _create_ontology(test_client, "Defs Update")
    ont_id = created["id"]

    resp = await test_client.put(
        f"/api/v1/admin/ontologies/{ont_id}",
        json={
            "entityTypeDefinitions": {
                "Database": {"label": "Database", "icon": "db"},
                "Schema": {"label": "Schema", "icon": "schema"},
            },
        },
    )
    assert resp.status_code == 200


# ── POST /admin/ontologies/{id}/publish ───────────────────────────────

async def test_publish_ontology(test_client: AsyncClient):
    """Publishing an unpublished ontology returns 200 with isPublished=True."""
    created = await _create_ontology(test_client, "Publish Test")
    ont_id = created["id"]

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/publish?force=true")
    assert resp.status_code == 200
    assert resp.json()["isPublished"] is True


async def test_publish_ontology_not_found(test_client: AsyncClient):
    """Publishing a non-existent ontology returns 404."""
    resp = await test_client.post("/api/v1/admin/ontologies/ont_ghost/publish?force=true")
    assert resp.status_code == 404


# ── DELETE /admin/ontologies/{id} ─────────────────────────────────────

async def test_delete_ontology(test_client: AsyncClient):
    """Delete an ontology returns 204 (soft-delete)."""
    created = await _create_ontology(test_client, "Delete Me")
    ont_id = created["id"]

    del_resp = await test_client.delete(f"/api/v1/admin/ontologies/{ont_id}")
    assert del_resp.status_code == 204

    # Soft-deleted ontologies are still accessible via GET (they have deleted_at set)
    get_resp = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}")
    assert get_resp.status_code == 200


async def test_delete_ontology_not_found(test_client: AsyncClient):
    """Deleting a non-existent ontology returns 404."""
    resp = await test_client.delete("/api/v1/admin/ontologies/ont_nope")
    assert resp.status_code == 404


# ── Lifecycle round-trip ──────────────────────────────────────────────

async def test_ontology_crud_roundtrip(test_client: AsyncClient):
    """Full create -> read -> update -> publish -> list -> delete cycle."""
    # Create
    created = await _create_ontology(test_client, "Roundtrip")
    ont_id = created["id"]

    # Read
    r = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}")
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip"

    # Update
    r = await test_client.put(
        f"/api/v1/admin/ontologies/{ont_id}",
        json={"name": "Roundtrip Updated", "description": "Updated desc"},
    )
    assert r.status_code == 200
    assert r.json()["name"] == "Roundtrip Updated"

    # List should include it
    r = await test_client.get("/api/v1/admin/ontologies")
    assert r.status_code == 200
    ids = [o["id"] for o in r.json()]
    assert ont_id in ids

    # Publish (force=true to bypass impact check)
    r = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/publish?force=true")
    assert r.status_code == 200
    assert r.json()["isPublished"] is True

    # Delete (published ontologies may still be deletable if no data sources reference them)
    r = await test_client.delete(f"/api/v1/admin/ontologies/{ont_id}")
    assert r.status_code == 204


# ── Clone ─────────────────────────────────────────────────────────────

async def test_clone_ontology(test_client: AsyncClient):
    """Cloning an ontology creates a new draft copy."""
    created = await _create_ontology(test_client, "Original")
    ont_id = created["id"]

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/clone")
    assert resp.status_code == 201
    clone = resp.json()
    assert clone["id"] != ont_id
    assert "copy" in clone["name"].lower()
    assert clone.get("isPublished") is False


# ── Validate ──────────────────────────────────────────────────────────

async def test_validate_ontology(test_client: AsyncClient):
    """Validate returns a validation response with isValid and issues."""
    created = await _create_ontology(test_client, "Validate Test")
    ont_id = created["id"]

    resp = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/validate")
    assert resp.status_code == 200
    body = resp.json()
    assert "isValid" in body
    assert "issues" in body


# ── Authoring guard: case-insensitive-unique type ids (create / update / import) ──

async def test_create_ontology_rejects_case_insensitive_dup_type_ids(test_client: AsyncClient):
    payload = _ontology_payload("Dup Rel", relationshipTypeDefinitions={
        "HAS": {"label": "Has"}, "has": {"label": "has"}})
    resp = await test_client.post("/api/v1/admin/ontologies", json=payload)
    assert resp.status_code == 422
    assert "case" in resp.json()["detail"].lower()


async def test_update_ontology_rejects_case_insensitive_dup_type_ids(test_client: AsyncClient):
    ont = await _create_ontology(test_client, "Guarded Update")
    resp = await test_client.put(
        f"/api/v1/admin/ontologies/{ont['id']}",
        json={"entityTypeDefinitions": {"Table": {"label": "Table"}, "table": {"label": "t"}}})
    assert resp.status_code == 422
    assert "case" in resp.json()["detail"].lower()


async def test_import_ontology_rejects_case_insensitive_dup_type_ids(test_client: AsyncClient):
    # The authoring guard must also cover the import routes (exported JSON is untrusted).
    payload = _ontology_payload("Imp Dup", entityTypeDefinitions={
        "Table": {"label": "Table"}, "table": {"label": "table"}})
    resp = await test_client.post("/api/v1/admin/ontologies/import", json=payload)
    assert resp.status_code == 422
    assert "case" in resp.json()["detail"].lower()


def test_reconcile_relationship_endpoints_strips_undeclared_types():
    """Authoring invariant: a relationship's endpoint types are reconciled to the ontology's
    declared entity types — undeclared refs dropped, partial overlap kept as a subset, an
    all-undeclared constraint cleared to unrestricted."""
    from types import SimpleNamespace
    from backend.app.api.v1.endpoints.ontologies import _reconcile_relationship_endpoints
    req = SimpleNamespace(
        entity_type_definitions={"attribute": {}, "object": {}, "layer": {}},
        relationship_type_definitions={
            "FLOWS_TO": {"source_types": ["dataset", "dataJob"], "target_types": ["column"]},
            "LINKS": {"source_types": ["attribute", "dataset"], "target_types": ["object"]},
            "OPEN": {"source_types": [], "target_types": []},
        },
    )
    _reconcile_relationship_endpoints(req)
    r = req.relationship_type_definitions
    assert r["FLOWS_TO"]["source_types"] == [] and r["FLOWS_TO"]["target_types"] == []
    assert r["LINKS"]["source_types"] == ["attribute"] and r["LINKS"]["target_types"] == ["object"]
    assert r["OPEN"]["source_types"] == []


def test_reconcile_relationship_endpoints_skips_partial_update_without_entity_types():
    """A relationships-only partial update (no entity types in the request) is left untouched —
    the read-time resolver filter still covers it."""
    from types import SimpleNamespace
    from backend.app.api.v1.endpoints.ontologies import _reconcile_relationship_endpoints
    req = SimpleNamespace(entity_type_definitions=None,
                          relationship_type_definitions={"FLOWS_TO": {"source_types": ["dataset"]}})
    _reconcile_relationship_endpoints(req)
    assert req.relationship_type_definitions["FLOWS_TO"]["source_types"] == ["dataset"]


# ── Publish impact gate (unforced path) ───────────────────────────────

async def test_unforced_publish_blocked_on_breaking_change(test_client: AsyncClient):
    """Without ?force=true, publishing a draft that removes types still present
    in the previous published version is blocked with 409 (policy=reject).
    Regression guard: every other publish test forces, leaving this path untested."""
    created = await _create_ontology(test_client, "Impact Gate Test")
    ont_id = created["id"]

    r = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/publish?force=true")
    assert r.status_code == 200

    # New version that drops an entity type present in v1
    r = await test_client.post(f"/api/v1/admin/ontologies/{ont_id}/new-version")
    assert r.status_code in (200, 201)
    draft = r.json()
    entity_defs = dict(draft["entityTypeDefinitions"])
    removed = next(iter(entity_defs))
    del entity_defs[removed]
    r = await test_client.put(
        f"/api/v1/admin/ontologies/{draft['id']}",
        json={"entityTypeDefinitions": entity_defs},
    )
    assert r.status_code == 200

    # Impact preview says blocked, with the removed type listed
    r = await test_client.get(f"/api/v1/admin/ontologies/{draft['id']}/impact")
    assert r.status_code == 200
    impact = r.json()
    assert impact["allowed"] is False
    assert removed in impact["removedEntityTypes"]
    assert impact["evolutionPolicy"] == "reject"

    # Unforced publish → 409; forced publish → 200
    r = await test_client.post(f"/api/v1/admin/ontologies/{draft['id']}/publish")
    assert r.status_code == 409

    r = await test_client.post(f"/api/v1/admin/ontologies/{draft['id']}/publish?force=true")
    assert r.status_code == 200
    assert r.json()["isPublished"] is True


async def test_first_publish_impact_includes_policy(test_client: AsyncClient):
    """First publish has no previous version — impact must still carry the
    evolution policy (the publish dialog renders it)."""
    created = await _create_ontology(test_client, "First Publish Impact")
    r = await test_client.get(f"/api/v1/admin/ontologies/{created['id']}/impact")
    assert r.status_code == 200
    impact = r.json()
    assert impact["allowed"] is True
    assert impact["evolutionPolicy"] == "reject"


# ── GET /admin/ontologies/{id}/source-mappings ────────────────────────

async def test_source_mappings_aggregate(test_client: AsyncClient, db_session):
    """Returns each assigned source's vocabulary-alignment profile (declared →
    observed spellings + drift), and an empty profile marker for sources
    without one."""
    import json as _json
    from backend.app.db import models as _m

    created = await _create_ontology(test_client, "Mapping Test")
    ont_id = created["id"]

    db_session.add(_m.WorkspaceORM(id="ws_map", name="Map WS"))
    db_session.add(_m.ProviderORM(id="prov_map", name="P", provider_type="falkordb"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id="ds_map", workspace_id="ws_map", provider_id="prov_map",
        graph_name="g", ontology_id=ont_id, label="Mapped Source",
    ))
    db_session.add(_m.OntologySourceMappingORM(
        id="osm_1", data_source_id="ds_map", ontology_id=ont_id,
        entity_type_mappings=_json.dumps({"Server": {"observed": "server", "auto": True}}),
        relationship_type_mappings=_json.dumps({"HAS": {"observed": "has", "auto": False}}),
        has_drift=True,
        drift_details=_json.dumps([{"declared": "HAS", "observed": ["has"], "dimension": "relationship", "kind": "case_variant"}]),
        last_seen_at="2026-07-16T00:00:00Z",
    ))
    await db_session.commit()

    resp = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}/source-mappings")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["facets"] == {"all": 1, "drift": 1, "pending": 0, "unprofiled": 0}
    row = body["sources"][0]
    assert row["dataSourceId"] == "ds_map"
    assert row["hasProfile"] is True
    assert row["hasDrift"] is True
    assert row["relationshipMappings"]["HAS"]["observed"] == "has"
    assert row["entityMappings"]["Server"]["auto"] is True
    assert row["driftDetails"][0]["declared"] == "HAS"


async def test_source_mappings_pagination_and_filters(test_client: AsyncClient, db_session):
    """One bulk query serves paged, searchable, facet-filtered rows: drifted
    and decision-pending sources sort first, unprofiled ones are filterable."""
    import json as _json
    from backend.app.db import models as _m

    created = await _create_ontology(test_client, "Mapping Scale Test")
    ont_id = created["id"]

    db_session.add(_m.WorkspaceORM(id="ws_scale", name="Scale WS"))
    db_session.add(_m.ProviderORM(id="prov_scale", name="P", provider_type="falkordb"))
    # Three sources: pending decision / clean profile / no profile at all.
    for i, label in enumerate(["Pending Source", "Clean Source", "Unprofiled Source"]):
        db_session.add(_m.WorkspaceDataSourceORM(
            id=f"ds_scale_{i}", workspace_id="ws_scale", provider_id="prov_scale",
            graph_name=f"g{i}", ontology_id=ont_id, label=label,
        ))
    db_session.add(_m.OntologySourceMappingORM(
        id="osm_s0", data_source_id="ds_scale_0", ontology_id=ont_id,
        entity_type_mappings="{}",
        relationship_type_mappings=_json.dumps({"HAS": {"observed": ["has", "Has"], "auto": True, "needsConfirmation": True}}),
        has_drift=True,
        drift_details=_json.dumps([{"declared": "HAS", "observed": ["has", "Has"], "dimension": "relationship",
                                    "kind": "multi_variant", "needsConfirmation": True}]),
        last_seen_at="2026-07-16T00:00:00Z",
    ))
    db_session.add(_m.OntologySourceMappingORM(
        id="osm_s1", data_source_id="ds_scale_1", ontology_id=ont_id,
        entity_type_mappings=_json.dumps({"Server": {"observed": "Server", "auto": True}}),
        relationship_type_mappings="{}", has_drift=False, drift_details="[]",
        last_seen_at="2026-07-16T00:00:00Z",
    ))
    await db_session.commit()

    base = f"/api/v1/admin/ontologies/{ont_id}/source-mappings"

    # Facets over ALL rows; page of 1 sorts the decision-pending source first.
    body = (await test_client.get(f"{base}?limit=1&offset=0")).json()
    assert body["total"] == 3
    assert body["facets"] == {"all": 3, "drift": 1, "pending": 1, "unprofiled": 1}
    assert len(body["sources"]) == 1
    assert body["sources"][0]["dataSourceId"] == "ds_scale_0"

    # Offset walks the ranking; facets stay global.
    body = (await test_client.get(f"{base}?limit=1&offset=2")).json()
    assert body["sources"][0]["dataSourceLabel"] == "Unprofiled Source"

    # filter=unprofiled narrows total but not facets.
    body = (await test_client.get(f"{base}?filter=unprofiled")).json()
    assert body["total"] == 1
    assert body["sources"][0]["hasProfile"] is False
    assert body["facets"]["all"] == 3

    # search matches labels case-insensitively.
    body = (await test_client.get(f"{base}?search=clean")).json()
    assert body["total"] == 1
    assert body["sources"][0]["dataSourceId"] == "ds_scale_1"


async def test_source_mappings_unknown_ontology_404(test_client: AsyncClient):
    resp = await test_client.get("/api/v1/admin/ontologies/bp_ghost/source-mappings")
    assert resp.status_code == 404


# ── GET /admin/ontologies/{id}/coverage-ranking ───────────────────────

async def test_coverage_ranking_matches_live_coverage_and_sorts(test_client: AsyncClient, db_session):
    """The ranked endpoint must report the SAME percentage as POST /coverage for
    the same cached stats (system-type parity), sort best-first with unprofiled
    last, and facet by assignment category."""
    import json as _json
    from backend.app.db import models as _m

    created = await _create_ontology(test_client, "Ranking Test")
    ont_id = created["id"]

    def _stats(entity_ids, edge_ids):  # full GraphSchemaStats wire shape
        return {
            "totalNodes": 10, "totalEdges": 5,
            "entityTypeStats": [{"id": i, "name": i, "count": 1} for i in entity_ids],
            "edgeTypeStats": [{"id": i, "name": i, "count": 1} for i in edge_ids],
        }

    # Database+Table+CONTAINS covered, EXTRA uncovered → 3/4
    good_stats = _stats(["Database", "Table", "EXTRA"], ["CONTAINS"])
    # only Table covered → 1/3
    poor_stats = _stats(["Table", "Mystery"], ["UNKNOWN_EDGE"])

    db_session.add(_m.WorkspaceORM(id="ws_rank", name="Rank WS"))
    db_session.add(_m.ProviderORM(id="prov_rank", name="P", provider_type="falkordb"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id="ds_good", workspace_id="ws_rank", provider_id="prov_rank",
        graph_name="good", ontology_id=None, label="Good Fit"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id="ds_poor", workspace_id="ws_rank", provider_id="prov_rank",
        graph_name="poor", ontology_id="bp_other", label="Poor Fit"))
    db_session.add(_m.WorkspaceDataSourceORM(
        id="ds_cold", workspace_id="ws_rank", provider_id="prov_rank",
        graph_name="cold", ontology_id=ont_id, label="Never Profiled"))
    db_session.add(_m.DataSourceStatsORM(
        data_source_id="ds_good", schema_stats=_json.dumps(good_stats)))
    db_session.add(_m.DataSourceStatsORM(
        data_source_id="ds_poor", schema_stats=_json.dumps(poor_stats)))
    await db_session.commit()

    resp = await test_client.get(f"/api/v1/admin/ontologies/{ont_id}/coverage-ranking")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["profiledCount"] == 2
    assert body["facets"] == {"all": 3, "unassigned": 1, "assignedOther": 1, "assignedThis": 1}

    # Best coverage first, unprofiled last.
    ids = [s["dataSourceId"] for s in body["sources"]]
    assert ids == ["ds_good", "ds_poor", "ds_cold"]
    good = body["sources"][0]
    assert good["profiled"] is True
    assert good["uncoveredEntityCount"] == 1
    assert good["currentOntologyId"] is None
    cold = body["sources"][2]
    assert cold["profiled"] is False
    assert cold["coveragePercent"] is None
    assert cold["currentOntologyId"] == ont_id

    # Parity: same numbers as the live coverage endpoint fed the same stats.
    live = await test_client.post(
        f"/api/v1/admin/ontologies/{ont_id}/coverage", json=good_stats)
    assert live.status_code == 200
    assert good["coveragePercent"] == live.json()["coveragePercent"]
    assert good["uncoveredEntityCount"] == len(live.json()["uncoveredEntityTypes"])
    assert good["uncoveredRelationshipCount"] == len(live.json()["uncoveredRelationshipTypes"])

    # Category filter narrows, facets stay global.
    body = (await test_client.get(
        f"/api/v1/admin/ontologies/{ont_id}/coverage-ranking?filter=unassigned")).json()
    assert body["total"] == 1
    assert body["sources"][0]["dataSourceId"] == "ds_good"
    assert body["facets"]["all"] == 3


async def test_coverage_ranking_unknown_ontology_404(test_client: AsyncClient):
    resp = await test_client.get("/api/v1/admin/ontologies/bp_ghost/coverage-ranking")
    assert resp.status_code == 404
